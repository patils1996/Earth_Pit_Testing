/**
 * BPCL Earthing Testing App - By CLR FACILITY SERVICES
 * PWA with Real-time Google Sheets & Google Drive Photo Push
 * Standards: IS 3043:2018 & OISD-STD-147
 */

// ==========================================
// 1. PWA REGISTRATION & INSTALL POPUP
// ==========================================
let deferredPrompt = null;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isInStandaloneMode = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      console.log('[PWA] Service Worker registered:', reg.scope);
      reg.update();
    }).catch((err) => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!sessionStorage.getItem('pwa_prompt_dismissed') && !isInStandaloneMode()) {
    setTimeout(() => {
      showPwaInstallModal();
    }, 2500);
  }
});

function showPwaInstallModal() {
  const modal = document.getElementById('pwa-install-modal');
  if (!modal) return;
  const iosGuide = document.getElementById('ios-install-guide');
  const confirmBtn = document.getElementById('btn-pwa-confirm-install');

  if (isIos() && !isInStandaloneMode()) {
    if (iosGuide) iosGuide.classList.remove('hidden');
    if (confirmBtn) confirmBtn.classList.add('hidden');
  } else {
    if (iosGuide) iosGuide.classList.add('hidden');
    if (confirmBtn) confirmBtn.classList.remove('hidden');
  }
  modal.classList.remove('hidden');
}

function hidePwaInstallModal() {
  const modal = document.getElementById('pwa-install-modal');
  if (modal) modal.classList.add('hidden');
  sessionStorage.setItem('pwa_prompt_dismissed', 'true');
}

// ==========================================
// 2. STORE & DATA REPOSITORY
// ==========================================
class Store {
  constructor() {
    this.reports = [];
    this.apiUrl = './api';
    this.serverAvailable = false;
    this.listeners = [];
  }

  async init() {
    // 1. Load from localStorage
    const local = localStorage.getItem('earth-pit-reports');
    if (local) {
      try { this.reports = JSON.parse(local); } catch (e) {}
    }

    // 2. Sync from backend SQLite
    try {
      const res = await fetch(`${this.apiUrl}/reports`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          this.reports = data;
          this.serverAvailable = true;
          try { localStorage.setItem('earth-pit-reports', JSON.stringify(this.reports)); } catch(e) {}
        }
      }
    } catch (err) {
      this.serverAvailable = false;
    }

    // 3. Fallback to bundled data/outlets.json for static GitHub Pages hosting
    if (!this.reports || this.reports.length === 0) {
      try {
        const res = await fetch('./data/outlets.json');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            this.reports = data;
            try { localStorage.setItem('earth-pit-reports', JSON.stringify(this.reports)); } catch(e) {}
          }
        }
      } catch (e) {
        console.warn('Fallback static outlets.json load failed', e);
      }
    }
    this.notify();
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  notify() {
    this.listeners.forEach(fn => fn(this.reports));
  }

  getReports() {
    return this.reports;
  }

  getReport(id) {
    return this.reports.find(r => r.id === id || String(r.retailCode) === String(id));
  }

  async saveReport(reportData) {
    let savedReport = null;
    const isEdit = Boolean(reportData.id && this.getReport(reportData.id));

    if (!reportData.id) {
      reportData.id = 'ro-' + (reportData.retailCode || Math.random().toString(36).substr(2, 6));
    }

    if (!reportData.nextTestDate && reportData.testDate) {
      const dt = new Date(reportData.testDate);
      dt.setMonth(dt.getMonth() + 6);
      reportData.nextTestDate = dt.toISOString().split('T')[0];
    }

    if (this.serverAvailable) {
      try {
        const url = isEdit ? `${this.apiUrl}/reports/${reportData.id}` : `${this.apiUrl}/reports`;
        const method = isEdit ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reportData)
        });
        if (res.ok) savedReport = await res.json();
      } catch (e) {
        console.warn('Server unavailable, saved to local cache', e);
      }
    }

    if (!savedReport) savedReport = reportData;

    if (isEdit) {
      this.reports = this.reports.map(r => r.id === savedReport.id ? savedReport : r);
    } else {
      this.reports = [savedReport, ...this.reports];
    }

    try { localStorage.setItem('earth-pit-reports', JSON.stringify(this.reports)); } catch(e) {}
    this.notify();
    return savedReport;
  }

  async deleteReport(id) {
    if (this.serverAvailable) {
      try { await fetch(`${this.apiUrl}/reports/${id}`, { method: 'DELETE' }); } catch (e) {}
    }
    this.reports = this.reports.filter(r => r.id !== id);
    try { localStorage.setItem('earth-pit-reports', JSON.stringify(this.reports)); } catch(e) {}
    this.notify();
    return true;
  }

  async onboardReports(reportsList) {
    if (this.serverAvailable) {
      try {
        await fetch(`${this.apiUrl}/onboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reportsList)
        });
      } catch (e) {}
    }
    const map = new Map(this.reports.map(r => [r.id, r]));
    reportsList.forEach(r => map.set(r.id, r));
    this.reports = Array.from(map.values());
    try { localStorage.setItem('earth-pit-reports', JSON.stringify(this.reports)); } catch(e) {}
    this.notify();
  }
}

const store = new Store();

// ==========================================
// 3. GOOGLE SHEETS & GOOGLE DRIVE SYNC ENGINE
// ==========================================
// Permanent Master Google Apps Script Webhook (Protected from modification)
const MASTER_GAS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwso4z8vCscz18bRUIeXSjfHiSY3oOjsFwdF0-A_7Fi8gmyKEpCEWiW7afN4zdn446AOQ/exec";
const DEFAULT_GAS_URL = MASTER_GAS_WEBHOOK_URL;

function getGoogleWebhookUrl() {
  return MASTER_GAS_WEBHOOK_URL;
}

function setGoogleWebhookUrl(url) {
  // Permanently locked - cannot be modified by any user
  localStorage.setItem('bpcl_google_webhook_url', MASTER_GAS_WEBHOOK_URL);
}

function getSyncLogs() {
  try {
    return JSON.parse(localStorage.getItem('bpcl_google_sync_logs')) || [];
  } catch(e) {
    return [];
  }
}

function addSyncLog(entry) {
  const logs = getSyncLogs();
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
  try { localStorage.setItem('bpcl_google_sync_logs', JSON.stringify(logs)); } catch(e) {}
  updatePendingBadge();
}

function getPendingQueue() {
  try {
    return JSON.parse(localStorage.getItem('bpcl_google_pending_queue')) || [];
  } catch(e) {
    return [];
  }
}

function addToPendingQueue(item) {
  const q = getPendingQueue();
  q.push(item);
  try { localStorage.setItem('bpcl_google_pending_queue', JSON.stringify(q)); } catch(e) {}
  updatePendingBadge();
}

function clearPendingQueue() {
  localStorage.removeItem('bpcl_google_pending_queue');
  updatePendingBadge();
}

function updatePendingBadge() {
  const badge = document.getElementById('pending-sync-badge');
  const q = getPendingQueue();
  if (badge) {
    if (q.length > 0) {
      badge.innerText = `${q.length} Pending`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

/**
 * Push Inspection Data & Photos to Google Sheet & Google Drive
 */
async function pushToGoogle(reportData, photosArray = []) {
  const webhookUrl = getGoogleWebhookUrl();

  const payload = {
    action: "update_test",
    timestamp: new Date().toISOString(),
    roid: reportData.retailCode,
    siteName: reportData.siteName,
    salesArea: reportData.salesArea,
    eoName: reportData.eoName,
    mstName: reportData.mstName,
    testDate: reportData.testDate,
    nextTestDate: reportData.nextTestDate,
    contractorName: reportData.contractorName || "CLR FACILITY SERVICES",
    earthTesterMake: reportData.earthTesterMake || "Waco",
    earthTesterSerial: reportData.earthTesterSerial || "WC-354672",
    pits: reportData.pits || [],
    photos: photosArray // [{ pit: 'EP-1', base64: 'data:image...', name: '...' }]
  };

  const logEntry = {
    id: 'sync-' + Date.now(),
    timestamp: new Date().toLocaleTimeString() + ', ' + new Date().toLocaleDateString(),
    roid: reportData.retailCode,
    siteName: reportData.siteName,
    photoCount: photosArray.length,
    status: 'Pending',
    details: 'Initiated push'
  };

  if (!navigator.onLine) {
    addToPendingQueue(payload);
    logEntry.status = 'Queued Offline';
    logEntry.details = 'Saved to offline queue. Will auto-push when online.';
    addSyncLog(logEntry);
    showToast({
      title: "Saved to Offline Queue",
      description: "No internet connection. Inspection and photos will push to Google Sheets & Drive automatically once back online.",
      variant: "default"
    });
    return;
  }

  if (!webhookUrl) {
    // Simulated successful connection for instant demo & readiness
    logEntry.status = 'Ready / Local Cached';
    logEntry.details = `Google Sheet formatted. Photos ready for Drive. (Configure Webhook in 'Google Sync' menu to activate live webhook)`;
    addSyncLog(logEntry);
    showToast({
      title: "Inspection Saved & Google Ready",
      description: `Data recorded for ${reportData.siteName}. Set your Google Apps Script URL in 'Google Sync' to stream live to Drive.`,
      variant: "success"
    });
    return;
  }

  try {
    showToast({ title: "Google Sync", description: "Pushing inspection row to Google Sheet & uploading photos to Google Drive...", variant: "default" });

    await fetch(webhookUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    logEntry.status = 'Synced to Google';
    logEntry.details = `Pushed row to Google Sheet & uploaded ${photosArray.length} photo(s) to Google Drive.`;
    addSyncLog(logEntry);

    showToast({
      title: "Google Sync Complete",
      description: `Google Sheet updated and photos pushed to Google Drive for ${reportData.siteName}.`,
      variant: "success"
    });
  } catch (err) {
    console.error("Google sync error:", err);
    addToPendingQueue(payload);
    logEntry.status = 'Queued (Retry)';
    logEntry.details = 'Network error pushing to Google Webhook. Queued for auto-retry.';
    addSyncLog(logEntry);
  }
}

// Auto-flush pending queue when internet reconnects
window.addEventListener('online', async () => {
  const queue = getPendingQueue();
  if (queue.length === 0) return;

  const webhookUrl = getGoogleWebhookUrl();
  if (!webhookUrl) return;

  showToast({ title: "Network Restored", description: `Pushing ${queue.length} pending inspections to Google Sheets & Drive...`, variant: "default" });

  for (const item of queue) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item)
      });
      addSyncLog({
        id: 'sync-' + Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        roid: item.roid,
        siteName: item.siteName,
        photoCount: (item.photos || []).length,
        status: 'Synced to Google',
        details: 'Auto-flushed from offline queue.'
      });
    } catch(e) {}
  }
  clearPendingQueue();
  showToast({ title: "Offline Queue Flushed", description: "All offline inspections synced with Google Sheets & Drive.", variant: "success" });
});


// Toast helper
function showToast({ title, description, variant = 'default' }) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const isDestructive = variant === 'destructive';
  const isSuccess = variant === 'success';

  toast.className = `toast-enter pointer-events-auto flex items-start gap-3 p-4 rounded-xl shadow-lg border text-sm transition-all ${
    isDestructive ? 'bg-red-50 border-red-200 text-red-900' :
    isSuccess ? 'bg-emerald-50 border-emerald-200 text-emerald-900' :
    'bg-white border-slate-200 text-slate-900'
  }`;

  const iconName = isDestructive ? 'alert-circle' : isSuccess ? 'check-circle-2' : 'info';
  const iconColor = isDestructive ? 'text-red-500' : isSuccess ? 'text-emerald-600' : 'text-blue-600';

  toast.innerHTML = `
    <i data-lucide="${iconName}" class="h-5 w-5 shrink-0 mt-0.5 ${iconColor}"></i>
    <div class="flex-1">
      <h4 class="font-semibold text-xs uppercase tracking-wide mb-0.5">${title || ''}</h4>
      <p class="text-xs opacity-90">${description || ''}</p>
    </div>
    <button class="text-slate-400 hover:text-slate-600 p-0.5" onclick="this.parentElement.remove()">
      <i data-lucide="x" class="h-4 w-4"></i>
    </button>
  `;

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
}

function formatDateFull(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let chartInstances = {};
let dashboardFilters = { salesArea: 'all', eoName: 'all', mstName: 'all' };

// ==========================================
// 5. VIEW 1: UPDATE TEST (MST) (#/update-test)
// ==========================================
let mstSelectedReport = null;
let mstPitsData = [
  { pitNumber: "EP-1", location: "Canopy Column 1", equipmentConnected: "Canopy Structure Grounding", gridEarthValue: 1.2, remarks: "Ok", photoBase64: null, photoName: null },
  { pitNumber: "EP-2", location: "Dispenser Island 1", equipmentConnected: "Dispenser 1 Body", gridEarthValue: 1.4, remarks: "Ok", photoBase64: null, photoName: null },
  { pitNumber: "EP-3", location: "Dispenser Island 2", equipmentConnected: "Dispenser 1 Neutral", gridEarthValue: 1.1, remarks: "Ok", photoBase64: null, photoName: null },
  { pitNumber: "EP-4", location: "Tank Farm Area", equipmentConnected: "Tank Body & Static Ground", gridEarthValue: 1.3, remarks: "Ok", photoBase64: null, photoName: null },
  { pitNumber: "EP-5", location: "Electrical Room", equipmentConnected: "Main LT Panel Body", gridEarthValue: 0.9, remarks: "Ok", photoBase64: null, photoName: null }
];

function renderUpdateTestView() {
  const allReports = store.getReports();

  const html = `
    <div class="space-y-5 fade-in max-w-2xl mx-auto pb-16">
      <!-- Header Banner -->
      <div class="bg-gradient-to-r from-blue-700 via-blue-800 to-indigo-900 rounded-2xl p-4 sm:p-5 text-white shadow-md flex items-center justify-between">
        <div class="flex items-center gap-3">
          <img src="./assets/logo.png" alt="Logo" class="h-12 w-12 rounded-full bg-white p-0.5 shadow shrink-0" />
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-base sm:text-lg font-bold font-display leading-tight">Update Test (MST)</h1>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-400 text-blue-950">CLR FACILITY SERVICES</span>
            </div>
            <p class="text-xs text-blue-200">On-site Earth Pit Inspection & Google Sync</p>
          </div>
        </div>

        <div class="flex flex-col items-end gap-1">
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-300 bg-emerald-950/40 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
            <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span> Google Push
          </span>
          <span class="text-[10px] text-blue-200">Drive Photo Backup</span>
        </div>
      </div>

      <!-- Step 1: Select Retail Outlet -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-2">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <i data-lucide="store" class="h-4 w-4 text-blue-600"></i>
            <span>Step 1: Select Retail Outlet (389 Sites)</span>
          </h2>
          <span class="text-[11px] text-slate-400">Search by ROID or Name</span>
        </div>

        <div class="relative">
          <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"></i>
          <input 
            type="text" 
            id="mst-outlet-search" 
            placeholder="Type ROID (e.g. 116218) or outlet name..." 
            value="${mstSelectedReport ? `${mstSelectedReport.siteName} (${mstSelectedReport.retailCode})` : ''}"
            class="w-full pl-9 pr-4 py-2.5 rounded-lg border border-slate-200 text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
            autocomplete="off"
          />
          <div id="mst-search-results" class="hidden absolute top-full inset-x-0 mt-1 max-h-48 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30 divide-y divide-slate-100"></div>
        </div>

        <!-- Station Details Badge -->
        <div id="mst-station-details" class="${mstSelectedReport ? '' : 'hidden'} bg-blue-50/70 border border-blue-200 rounded-xl p-3.5 space-y-1 text-xs text-slate-700">
          <div class="flex items-center justify-between">
            <span class="font-bold text-sm text-blue-900 font-display" id="mst-station-name">${mstSelectedReport ? escapeHtml(mstSelectedReport.siteName) : ''}</span>
            <span class="px-2 py-0.5 rounded font-mono font-bold bg-blue-100 text-blue-800" id="mst-station-roid">${mstSelectedReport ? `ROID: ${mstSelectedReport.retailCode}` : ''}</span>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-0.5 text-slate-500 pt-1">
            <span>Territory: <strong class="text-slate-800" id="mst-station-sa">${mstSelectedReport ? escapeHtml(mstSelectedReport.salesArea) : ''}</strong></span>
            <span>EO: <strong class="text-slate-800" id="mst-station-eo">${mstSelectedReport ? escapeHtml(mstSelectedReport.eoName) : ''}</strong></span>
            <span>MST: <strong class="text-slate-800" id="mst-station-mst">${mstSelectedReport ? escapeHtml(mstSelectedReport.mstName) : ''}</strong></span>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-blue-200/60 mt-2 text-[11px]">
            <div class="flex items-center gap-1.5 text-slate-600">
              <i data-lucide="wrench" class="h-3.5 w-3.5 text-blue-600"></i>
              <span>Equipment: <strong class="text-slate-800" id="mst-station-tester">${mstSelectedReport ? `${escapeHtml(mstSelectedReport.earthTesterMake || 'Waco')} ${escapeHtml(mstSelectedReport.earthTesterModel || 'Digital Earth Tester')} (${escapeHtml(mstSelectedReport.earthTesterSerial || 'WC-395710')})` : ''}</strong></span>
            </div>
            <span class="font-bold text-blue-800 px-2 py-0.5 rounded bg-white/80 border border-blue-200" id="mst-station-contractor">${mstSelectedReport ? escapeHtml(mstSelectedReport.contractorName || 'CLR FACILITY SERVICES') : ''}</span>
          </div>
        </div>
      </div>

      <!-- Step 2: Record Pit Readings & Attach Camera Photos -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <i data-lucide="gauge" class="h-4 w-4 text-blue-600"></i>
              <span>Step 2: Measure Resistance & Snap Photos (${mstPitsData.length} Earth Pits)</span>
            </h2>
            <p class="text-[11px] text-slate-400">Photos will automatically push to Google Drive</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">&le; 2.0 &Omega; PASS</span>
            <button type="button" onclick="addMstPit()" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-sm transition">
              <i data-lucide="plus" class="h-3.5 w-3.5"></i>
              <span>+ Add Pit</span>
            </button>
          </div>
        </div>

        <div class="space-y-3.5" id="mst-pits-container">
          ${mstPitsData.map((p, idx) => {
            const val = parseFloat(p.gridEarthValue) || 0;
            const isHigh = val > 2.0;

            return `
              <div class="rounded-xl border ${isHigh ? 'border-orange-300 bg-orange-50/30' : 'border-slate-200 bg-slate-50/50'} p-3.5 space-y-2">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-bold text-xs px-2.5 py-0.5 rounded bg-slate-200 text-slate-800">${escapeHtml(p.pitNumber)}</span>
                    <span class="font-bold text-xs text-slate-900">${escapeHtml(p.equipmentConnected || 'Main Ground Grid')}</span>
                    ${p.location ? `<span class="text-[11px] text-slate-500 hidden sm:inline">(${escapeHtml(p.location)})</span>` : ''}
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isHigh ? 'bg-orange-100 text-orange-800 border border-orange-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'}">
                      ${isHigh ? '⚠️ HIGH (> 2.0Ω)' : '✅ OK (PASS)'}
                    </span>
                    <!-- Edit EP Details Button -->
                    <button type="button" onclick="toggleMstPitEdit(${idx})" class="p-1 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 hover:text-blue-600 transition" title="Edit Earth Pit Details">
                      <i data-lucide="edit-2" class="h-3.5 w-3.5"></i>
                    </button>
                    <!-- Remove EP Button -->
                    <button type="button" onclick="removeMstPit(${idx})" class="p-1 rounded-md border border-rose-200 bg-white hover:bg-rose-50 text-rose-500 hover:text-rose-700 transition" title="Remove Earth Pit">
                      <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
                    </button>
                  </div>
                </div>

                <!-- Expandable Inline EP Details Editor -->
                <div id="mst-pit-edit-${idx}" class="${p._isEditing ? '' : 'hidden'} bg-blue-50/60 border border-blue-200/80 rounded-xl p-3 space-y-2 mt-2">
                  <div class="flex items-center justify-between">
                    <span class="text-[11px] font-bold text-blue-900 flex items-center gap-1">
                      <i data-lucide="sliders" class="h-3 w-3"></i>
                      <span>Edit Earth Pit Details (${escapeHtml(p.pitNumber)})</span>
                    </span>
                    <button type="button" onclick="toggleMstPitEdit(${idx})" class="text-[11px] font-bold text-blue-700 hover:underline">Done &check;</button>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div>
                      <label class="text-[10px] font-bold uppercase text-slate-500 block mb-1">Pit Tag / No.</label>
                      <input 
                        type="text" 
                        value="${escapeHtml(p.pitNumber)}" 
                        oninput="updateMstPitField(${idx}, 'pitNumber', this.value)" 
                        placeholder="e.g. EP-1" 
                        class="w-full h-8 px-2.5 rounded-lg border border-slate-300 bg-white font-mono font-bold text-xs" 
                      />
                    </div>
                    <div>
                      <label class="text-[10px] font-bold uppercase text-slate-500 block mb-1">Connected Equipment</label>
                      <input 
                        type="text" 
                        value="${escapeHtml(p.equipmentConnected || '')}" 
                        oninput="updateMstPitField(${idx}, 'equipmentConnected', this.value)" 
                        placeholder="e.g. Canopy Structure" 
                        class="w-full h-8 px-2.5 rounded-lg border border-slate-300 bg-white text-xs" 
                      />
                    </div>
                    <div>
                      <label class="text-[10px] font-bold uppercase text-slate-500 block mb-1">Location</label>
                      <input 
                        type="text" 
                        value="${escapeHtml(p.location || '')}" 
                        oninput="updateMstPitField(${idx}, 'location', this.value)" 
                        placeholder="e.g. Canopy Column 1" 
                        class="w-full h-8 px-2.5 rounded-lg border border-slate-300 bg-white text-xs" 
                      />
                    </div>
                  </div>
                  <!-- Quick Preset Chips -->
                  <div class="flex flex-wrap gap-1 pt-1 items-center">
                    <span class="text-[10px] text-slate-400 font-semibold">Presets:</span>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Canopy Structure', 'Canopy Column 1')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">Canopy</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Dispenser 1 Body', 'Dispenser Island 1')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">Dispenser Body</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Dispenser 1 Neutral', 'Dispenser Island 2')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">Dispenser Neutral</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Tank Body & Static Ground', 'Tank Farm Area')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">Tank Farm</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Main LT Panel Body', 'Electrical Room')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">LT Panel</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'DG Neutral & Body', 'Generator Yard')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">DG Neutral</button>
                    <button type="button" onclick="setMstPitPreset(${idx}, 'Solar Inverter / Yard', 'Roof Top')" class="text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700">Solar Yard</button>
                  </div>
                </div>

                <!-- Value Adjuster -->
                <div class="flex items-center gap-2">
                  <button type="button" onclick="adjustMstValue(${idx}, -0.1)" class="h-11 w-11 rounded-lg bg-white border border-slate-300 text-slate-700 font-bold text-lg hover:bg-slate-100 flex items-center justify-center shrink-0 shadow-sm active:scale-95 transition">
                    -
                  </button>

                  <div class="relative flex-1">
                    <input 
                      type="number" 
                      step="0.1" 
                      value="${val.toFixed(1)}" 
                      onchange="setMstValue(${idx}, this.value)"
                      class="w-full h-11 text-center font-mono font-bold text-lg rounded-lg border ${isHigh ? 'border-orange-400 bg-orange-50 text-orange-900' : 'border-slate-300 bg-white text-slate-900'} focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                    <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-semibold">&Omega;</span>
                  </div>

                  <button type="button" onclick="adjustMstValue(${idx}, 0.1)" class="h-11 w-11 rounded-lg bg-white border border-slate-300 text-slate-700 font-bold text-lg hover:bg-slate-100 flex items-center justify-center shrink-0 shadow-sm active:scale-95 transition">
                    +
                  </button>
                </div>

                <!-- Photo Capture for Google Drive & Remarks -->
                <div class="flex items-center gap-2 pt-1 text-xs">
                  <label class="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${p.photoBase64 ? 'border-emerald-300 bg-emerald-50 text-emerald-800 font-bold' : 'border-slate-200 bg-white text-slate-600'} hover:bg-slate-100 transition shrink-0">
                    <i data-lucide="camera" class="h-3.5 w-3.5 ${p.photoBase64 ? 'text-emerald-600' : 'text-blue-600'}"></i>
                    <span class="text-[11px]">${p.photoBase64 ? 'Photo Ready ☁️' : 'Camera / Photo'}</span>
                    <input type="file" accept="image/*" capture="environment" class="hidden" onchange="attachMstPitPhoto(${idx}, this)" />
                  </label>
                  <input 
                    type="text" 
                    placeholder="Remarks (e.g. Watering required)" 
                    value="${escapeHtml(p.remarks || '')}" 
                    oninput="mstPitsData[${idx}].remarks = this.value"
                    class="flex-1 h-8 px-2.5 text-xs rounded border border-slate-200 bg-white" 
                  />
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Add Earth Pit Button -->
        <button type="button" onclick="addMstPit()" class="w-full py-3.5 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/60 hover:bg-blue-100/70 text-blue-700 font-bold text-xs transition flex items-center justify-center gap-2 shadow-xs active:scale-[0.99]">
          <i data-lucide="plus-circle" class="h-4 w-4 text-blue-600"></i>
          <span>+ Add Earth Pit (EP-${mstPitsData.length + 1})</span>
        </button>
      </div>

      <!-- Step 3: Digital Certification & Push Button -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-3">
        <label class="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input type="checkbox" id="mst-certify-check" class="mt-0.5 rounded text-blue-600 focus:ring-blue-500" checked />
          <span>I certify that these earth pit measurements were tested with calibrated Waco digital earth tester according to <strong>IS 3043:2018 / OISD-147</strong> standards.</span>
        </label>

        <button type="button" id="btn-submit-mst-test" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-sm font-bold text-white shadow-lg shadow-blue-600/30 hover:from-blue-700 hover:to-indigo-700 transition flex items-center justify-center gap-2">
          <i data-lucide="cloud-upload" class="h-5 w-5"></i>
          <span>Submit & Push to Google Sheet & Drive</span>
        </button>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();

  // Outlet search
  const searchInput = document.getElementById('mst-outlet-search');
  const resultsDiv = document.getElementById('mst-search-results');

  if (searchInput && resultsDiv) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) { resultsDiv.classList.add('hidden'); return; }
      const matches = allReports.filter(r => String(r.retailCode || '').includes(q) || (r.siteName || '').toLowerCase().includes(q)).slice(0, 8);

      if (matches.length === 0) {
        resultsDiv.innerHTML = `<div class="p-3 text-xs text-slate-400 text-center">No outlets found</div>`;
      } else {
        resultsDiv.innerHTML = matches.map(m => `
          <div class="p-2.5 hover:bg-blue-50 cursor-pointer transition flex items-center justify-between" onclick="selectMstStation('${m.id}')">
            <div>
              <span class="font-bold text-xs text-slate-900">${escapeHtml(m.siteName)}</span>
              <span class="block text-[11px] text-slate-400">${escapeHtml(m.salesArea)} &bull; MST: ${escapeHtml(m.mstName)}</span>
            </div>
            <span class="font-mono text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">${escapeHtml(m.retailCode)}</span>
          </div>
        `).join('');
      }
      resultsDiv.classList.remove('hidden');
    });
  }

  // Submit test
  const submitBtn = document.getElementById('btn-submit-mst-test');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!mstSelectedReport) {
        showToast({ title: "Outlet Required", description: "Please select a retail outlet in Step 1.", variant: "destructive" });
        return;
      }

      const payload = {
        ...mstSelectedReport,
        testDate: new Date().toISOString().split('T')[0],
        pits: mstPitsData.map((p, idx) => ({
          id: `${mstSelectedReport.id}-p${idx+1}`,
          pitNumber: p.pitNumber,
          location: p.location,
          equipmentConnected: p.equipmentConnected,
          gridEarthValue: parseFloat(p.gridEarthValue) || 0.0,
          remarks: p.remarks || (p.gridEarthValue <= 2.0 ? "Ok" : "Watering Required")
        }))
      };

      // 1. Save to local SQLite & store
      const saved = await store.saveReport(payload);

      // 2. Prepare photos payload for Google Drive
      const photosForGoogle = mstPitsData
        .filter(p => Boolean(p.photoBase64))
        .map(p => ({ pit: p.pitNumber, base64: p.photoBase64, name: p.photoName }));

      // 3. Trigger Google Push
      await pushToGoogle(saved, photosForGoogle);

      window.location.hash = `#/reports/${saved.id}`;
    });
  }
}

window.selectMstStation = (id) => {
  mstSelectedReport = store.getReport(id);
  if (!mstSelectedReport) return;

  const searchInput = document.getElementById('mst-outlet-search');
  const resultsDiv = document.getElementById('mst-search-results');
  if (searchInput) searchInput.value = `${mstSelectedReport.siteName} (${mstSelectedReport.retailCode})`;
  if (resultsDiv) resultsDiv.classList.add('hidden');

  if (mstSelectedReport.pits && mstSelectedReport.pits.length > 0) {
    mstPitsData = mstSelectedReport.pits.map(p => ({
      pitNumber: p.pitNumber,
      location: p.location,
      equipmentConnected: p.equipmentConnected,
      gridEarthValue: Number(p.gridEarthValue || 1.0),
      remarks: p.remarks || "Ok",
      photoBase64: null,
      photoName: null
    }));
  }
  renderUpdateTestView();
};

window.adjustMstValue = (idx, delta) => {
  let val = parseFloat(mstPitsData[idx].gridEarthValue) || 0;
  val = Math.max(0.1, Number((val + delta).toFixed(1)));
  mstPitsData[idx].gridEarthValue = val;
  renderUpdateTestView();
};

window.setMstValue = (idx, val) => {
  mstPitsData[idx].gridEarthValue = Math.max(0.1, parseFloat(val) || 0.1);
  renderUpdateTestView();
};

window.attachMstPitPhoto = (idx, input) => {
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      mstPitsData[idx].photoBase64 = e.target.result;
      mstPitsData[idx].photoName = `${mstSelectedReport ? mstSelectedReport.retailCode : 'RO'}_${mstPitsData[idx].pitNumber}.jpg`;
      showToast({ title: "Photo Ready for Google Drive", description: `Captured photo for ${mstPitsData[idx].pitNumber}`, variant: "success" });
      renderUpdateTestView();
    };
    reader.readAsDataURL(file);
  }
};

window.addMstPit = () => {
  const nextNum = mstPitsData.length + 1;
  mstPitsData.push({
    pitNumber: `EP-${nextNum}`,
    equipmentConnected: `Earth Pit ${nextNum}`,
    location: "Station Yard",
    gridEarthValue: 1.0,
    remarks: "Ok",
    photoBase64: null,
    photoName: null,
    _isEditing: true
  });
  renderUpdateTestView();
  showToast({ title: "Earth Pit Added", description: `Added EP-${nextNum}. You can edit equipment and reading.`, variant: "success" });
};

window.removeMstPit = (idx) => {
  if (mstPitsData.length <= 1) {
    showToast({ title: "Cannot Delete", description: "Station must have at least 1 earth pit.", variant: "destructive" });
    return;
  }
  const pit = mstPitsData[idx];
  if (confirm(`Are you sure you want to remove ${pit.pitNumber} (${pit.equipmentConnected})?`)) {
    mstPitsData.splice(idx, 1);
    renderUpdateTestView();
    showToast({ title: "Earth Pit Removed", description: `Removed ${pit.pitNumber}`, variant: "default" });
  }
};

window.toggleMstPitEdit = (idx) => {
  if (mstPitsData[idx]) {
    mstPitsData[idx]._isEditing = !mstPitsData[idx]._isEditing;
    renderUpdateTestView();
  }
};

window.updateMstPitField = (idx, field, val) => {
  if (mstPitsData[idx]) {
    mstPitsData[idx][field] = val;
  }
};

window.setMstPitPreset = (idx, equip, loc) => {
  if (mstPitsData[idx]) {
    mstPitsData[idx].equipmentConnected = equip;
    mstPitsData[idx].location = loc;
    mstPitsData[idx]._isEditing = false;
    renderUpdateTestView();
  }
};


// ==========================================
// 6. VIEW 2: TERRITORY DASHBOARD (#/)
// ==========================================
function renderDashboard() {
  const allReports = store.getReports();

  const salesAreas = [...new Set(allReports.map(r => r.salesArea).filter(Boolean))].sort();
  const eos = [...new Set(allReports.map(r => r.eoName).filter(Boolean))].sort();
  const msts = [...new Set(allReports.map(r => r.mstName).filter(Boolean))].sort();

  const filteredReports = allReports.filter(r => {
    if (dashboardFilters.salesArea !== 'all' && r.salesArea !== dashboardFilters.salesArea) return false;
    if (dashboardFilters.eoName !== 'all' && r.eoName !== dashboardFilters.eoName) return false;
    if (dashboardFilters.mstName !== 'all' && r.mstName !== dashboardFilters.mstName) return false;
    return true;
  });

  const totalSites = filteredReports.length;
  const allPits = filteredReports.flatMap(r => r.pits || []);
  const totalPits = allPits.length;

  const outOfRangePits = allPits.filter(p => Number(p.gridEarthValue) > 2.0).length;
  const compliantPits = totalPits - outOfRangePits;
  const complianceRate = totalPits > 0 ? ((compliantPits / totalPits) * 100).toFixed(1) : 100;

  const idealPits = allPits.filter(p => Number(p.gridEarthValue) < 1.0).length;
  const safePits = allPits.filter(p => Number(p.gridEarthValue) >= 1.0 && Number(p.gridEarthValue) <= 2.0).length;
  const highPits = outOfRangePits;

  const attentionStations = filteredReports.filter(r => (r.pits || []).some(p => Number(p.gridEarthValue) > 2.0));

  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const upcomingRetests = filteredReports.filter(r => {
    if (!r.nextTestDate) return false;
    const d = new Date(r.nextTestDate);
    return d >= now && d <= thirtyDays;
  });

  const salesAreaStats = salesAreas.map(sa => {
    const saReports = allReports.filter(r => r.salesArea === sa);
    const saPits = saReports.flatMap(r => r.pits || []);
    const saHigh = saPits.filter(p => Number(p.gridEarthValue) > 2.0).length;
    const saCompliant = saPits.length - saHigh;
    const rate = saPits.length > 0 ? Math.round((saCompliant / saPits.length) * 100) : 100;
    return { name: sa.replace('-retail', '').replace(' Retail', ''), compliant: saCompliant, high: saHigh, rate: rate };
  });

  const html = `
    <div class="space-y-6 fade-in">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <img src="./assets/logo.png" alt="BPCL Earthing Logo" class="h-12 w-12 rounded-full shadow-sm bg-white p-0.5 border border-slate-200 shrink-0" />
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-2xl sm:text-3xl font-bold text-slate-900 font-display tracking-tight">Territory Earthing Dashboard</h1>
              <span class="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 ring-1 ring-inset ring-blue-700/20">
                ${allReports.length} Sites Onboarded
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-0.5">Bharat Petroleum Corporation Limited &bull; By CLR FACILITY SERVICES &bull; IS 3043:2018</p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <a href="#/update-test" class="inline-flex h-9 items-center justify-center rounded-lg bg-amber-500 hover:bg-amber-600 px-3 text-xs font-bold text-slate-900 shadow-sm transition gap-1.5">
            <i data-lucide="zap" class="h-4 w-4"></i>
            <span>Update Test (MST)</span>
          </a>
          <a href="#/google-sync" class="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 px-3 text-xs font-bold text-white shadow-sm transition gap-1.5">
            <i data-lucide="cloud" class="h-4 w-4"></i>
            <span>Google Sync</span>
          </a>
        </div>
      </div>

      <!-- Territory Filters -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-xs font-semibold text-slate-600 uppercase tracking-wider">
          <i data-lucide="filter" class="h-4 w-4 text-blue-600"></i>
          <span>Territory Filters:</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 w-full lg:w-auto flex-1 max-w-3xl">
          <select id="filter-sales-area" class="w-full text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <option value="all" ${dashboardFilters.salesArea === 'all' ? 'selected' : ''}>All Sales Areas (${allReports.length})</option>
            ${salesAreas.map(sa => `<option value="${escapeHtml(sa)}" ${dashboardFilters.salesArea === sa ? 'selected' : ''}>${escapeHtml(sa)}</option>`).join('')}
          </select>

          <select id="filter-eo-name" class="w-full text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <option value="all" ${dashboardFilters.eoName === 'all' ? 'selected' : ''}>All Officers (EO)</option>
            ${eos.map(eo => `<option value="${escapeHtml(eo)}" ${dashboardFilters.eoName === eo ? 'selected' : ''}>${escapeHtml(eo)}</option>`).join('')}
          </select>

          <select id="filter-mst-name" class="w-full text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <option value="all" ${dashboardFilters.mstName === 'all' ? 'selected' : ''}>All Technicians (MST)</option>
            ${msts.map(mst => `<option value="${escapeHtml(mst)}" ${dashboardFilters.mstName === mst ? 'selected' : ''}>${escapeHtml(mst)}</option>`).join('')}
          </select>
        </div>

        ${(dashboardFilters.salesArea !== 'all' || dashboardFilters.eoName !== 'all' || dashboardFilters.mstName !== 'all') ? `
          <button id="btn-reset-filters" class="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1">
            <i data-lucide="rotate-ccw" class="h-3.5 w-3.5"></i> Reset
          </button>
        ` : ''}
      </div>

      <!-- 5 Summary Cards -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div class="bg-white rounded-xl p-4 border border-slate-200 border-l-4 border-l-blue-600 shadow-sm">
          <div class="flex items-center justify-between pb-1">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Retail Outlets</span>
            <i data-lucide="store" class="h-4 w-4 text-blue-600"></i>
          </div>
          <div class="text-2xl font-bold font-display text-slate-900">${totalSites}</div>
          <p class="text-[11px] text-slate-400 mt-1">${totalPits} tracked earth pits</p>
        </div>

        <div class="bg-white rounded-xl p-4 border border-slate-200 border-l-4 border-l-emerald-500 shadow-sm">
          <div class="flex items-center justify-between pb-1">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Compliance Rate</span>
            <i data-lucide="shield-check" class="h-4 w-4 text-emerald-600"></i>
          </div>
          <div class="text-2xl font-bold font-display text-emerald-600">${complianceRate}%</div>
          <p class="text-[11px] text-slate-400 mt-1">${compliantPits} pits &le; 2.0 &Omega;</p>
        </div>

        <div class="bg-white rounded-xl p-4 border border-slate-200 border-l-4 border-l-orange-500 shadow-sm">
          <div class="flex items-center justify-between pb-1">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Pits Out of Range</span>
            <i data-lucide="alert-triangle" class="h-4 w-4 text-orange-500"></i>
          </div>
          <div class="text-2xl font-bold font-display text-orange-600">${outOfRangePits}</div>
          <p class="text-[11px] text-slate-400 mt-1">Resistance &gt; 2.0 &Omega; (High)</p>
        </div>

        <div class="bg-white rounded-xl p-4 border border-slate-200 border-l-4 border-l-rose-500 shadow-sm">
          <div class="flex items-center justify-between pb-1">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Action Required</span>
            <i data-lucide="wrench" class="h-4 w-4 text-rose-500"></i>
          </div>
          <div class="text-2xl font-bold font-display text-rose-600">${attentionStations.length}</div>
          <p class="text-[11px] text-slate-400 mt-1">Outlets needing watering</p>
        </div>

        <div class="bg-white rounded-xl p-4 border border-slate-200 border-l-4 border-l-indigo-500 shadow-sm">
          <div class="flex items-center justify-between pb-1">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Upcoming Retests</span>
            <i data-lucide="calendar" class="h-4 w-4 text-indigo-500"></i>
          </div>
          <div class="text-2xl font-bold font-display text-slate-900">${upcomingRetests.length}</div>
          <p class="text-[11px] text-slate-400 mt-1">Due in next 30 days</p>
        </div>
      </div>

      <!-- Charts -->
      <div class="grid gap-6 lg:grid-cols-12">
        <div class="lg:col-span-7 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col p-5">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
            <div>
              <h2 class="text-base font-bold text-slate-900 font-display">Territory Earthing Health</h2>
              <p class="text-xs text-slate-400">Compliant vs High pits by Sales Area</p>
            </div>
            <span class="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-600">5 Sales Areas</span>
          </div>
          <div class="relative h-64 w-full">
            <canvas id="salesAreaChart"></canvas>
          </div>
        </div>

        <div class="lg:col-span-5 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col p-5">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
            <div>
              <h2 class="text-base font-bold text-slate-900 font-display">Resistance Spectrum</h2>
              <p class="text-xs text-slate-400">Network distribution by &Omega; limit</p>
            </div>
            <span class="text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">&le; 2.0 &Omega; Safe</span>
          </div>
          <div class="relative h-64 w-full flex items-center justify-center">
            <canvas id="spectrumChart"></canvas>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-slate-100 text-center text-xs">
            <div><span class="text-emerald-600 font-bold block">${idealPits}</span><span class="text-[10px] text-slate-400">&lt; 1.0 &Omega; (Ideal)</span></div>
            <div><span class="text-blue-600 font-bold block">${safePits}</span><span class="text-[10px] text-slate-400">1.0 - 2.0 &Omega; (Safe)</span></div>
            <div><span class="text-orange-600 font-bold block">${highPits}</span><span class="text-[10px] text-slate-400">&gt; 2.0 &Omega; (High)</span></div>
          </div>
        </div>
      </div>

      <!-- Action Required Outlets Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-bold text-slate-900 font-display flex items-center gap-2">
              <i data-lucide="alert-circle" class="h-4 w-4 text-orange-600"></i>
              <span>High Resistance Outlets Requiring Maintenance (${attentionStations.length})</span>
            </h2>
            <p class="text-xs text-slate-400">Pits with measured resistance exceeding 2.0 &Omega;</p>
          </div>
          <a href="#/reports" class="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1">
            Browse All Outlets <i data-lucide="arrow-right" class="h-3 w-3"></i>
          </a>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100">
              <tr>
                <th class="px-6 py-3 font-semibold">ROID</th>
                <th class="px-6 py-3 font-semibold">Retail Outlet</th>
                <th class="px-6 py-3 font-semibold">Sales Area</th>
                <th class="px-6 py-3 font-semibold">Officer (EO)</th>
                <th class="px-6 py-3 font-semibold">Technician (MST)</th>
                <th class="px-6 py-3 font-semibold">Max Reading</th>
                <th class="px-6 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${attentionStations.slice(0, 8).map(r => {
                const pits = r.pits || [];
                const maxVal = Math.max(...pits.map(p => Number(p.gridEarthValue || 0))).toFixed(1);
                return `
                  <tr class="hover:bg-orange-50/40 transition">
                    <td class="px-6 py-3.5 font-mono font-bold text-xs text-slate-700">${escapeHtml(r.retailCode)}</td>
                    <td class="px-6 py-3.5 font-semibold text-slate-900"><a href="#/reports/${r.id}" class="hover:text-blue-600">${escapeHtml(r.siteName)}</a></td>
                    <td class="px-6 py-3.5 text-xs text-slate-600"><span class="px-2 py-0.5 rounded bg-slate-100 font-medium">${escapeHtml(r.salesArea)}</span></td>
                    <td class="px-6 py-3.5 text-xs text-slate-700">${escapeHtml(r.eoName)}</td>
                    <td class="px-6 py-3.5 text-xs text-slate-700">${escapeHtml(r.mstName)}</td>
                    <td class="px-6 py-3.5 font-mono font-bold text-orange-600 text-xs">${maxVal} &Omega;</td>
                    <td class="px-6 py-3.5"><a href="#/reports/${r.id}" class="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800">Inspect <i data-lucide="chevron-right" class="h-3.5 w-3.5"></i></a></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();

  const saSelect = document.getElementById('filter-sales-area');
  const eoSelect = document.getElementById('filter-eo-name');
  const mstSelect = document.getElementById('filter-mst-name');
  const resetBtn = document.getElementById('btn-reset-filters');

  if (saSelect) saSelect.addEventListener('change', (e) => { dashboardFilters.salesArea = e.target.value; renderDashboard(); });
  if (eoSelect) eoSelect.addEventListener('change', (e) => { dashboardFilters.eoName = e.target.value; renderDashboard(); });
  if (mstSelect) mstSelect.addEventListener('change', (e) => { dashboardFilters.mstName = e.target.value; renderDashboard(); });
  if (resetBtn) resetBtn.addEventListener('click', () => { dashboardFilters = { salesArea: 'all', eoName: 'all', mstName: 'all' }; renderDashboard(); });

  initSalesAreaChart(salesAreaStats);
  initSpectrumChart(idealPits, safePits, highPits);
}

function initSalesAreaChart(stats) {
  const ctx = document.getElementById('salesAreaChart');
  if (!ctx) return;
  if (chartInstances.salesArea) chartInstances.salesArea.destroy();

  chartInstances.salesArea = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stats.map(s => s.name),
      datasets: [
        { label: 'Compliant (≤ 2.0Ω)', data: stats.map(s => s.compliant), backgroundColor: 'rgba(37, 99, 235, 0.85)', borderRadius: 4, stack: 'pits' },
        { label: 'Attention (> 2.0Ω)', data: stats.map(s => s.high), backgroundColor: 'rgba(249, 115, 22, 0.85)', borderRadius: 4, stack: 'pits' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } } },
        y: { grid: { color: '#f1f5f9' }, ticks: { font: { family: 'Inter', size: 11 } } }
      }
    }
  });
}

function initSpectrumChart(ideal, safe, high) {
  const ctx = document.getElementById('spectrumChart');
  if (!ctx) return;
  if (chartInstances.spectrum) chartInstances.spectrum.destroy();

  chartInstances.spectrum = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Ideal (< 1.0 Ω)', 'Safe (1.0 - 2.0 Ω)', 'Attention (> 2.0 Ω)'],
      datasets: [{
        data: [ideal, safe, high],
        backgroundColor: ['#10b981', '#3b82f6', '#f97316'],
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%'
    }
  });
}

// ==========================================
// 7. VIEW 3: OUTLET DIRECTORY (#/reports)
// ==========================================
let reportsState = { search: '', salesArea: 'all', eoName: 'all', status: 'all', page: 1, pageSize: 20 };

function renderReports() {
  const allReports = store.getReports();
  const salesAreas = [...new Set(allReports.map(r => r.salesArea).filter(Boolean))].sort();
  const eos = [...new Set(allReports.map(r => r.eoName).filter(Boolean))].sort();

  const filtered = allReports.filter(r => {
    const s = reportsState.search.toLowerCase().trim();
    if (s) {
      const match = 
        (r.siteName || '').toLowerCase().includes(s) ||
        String(r.retailCode || '').toLowerCase().includes(s) ||
        (r.salesArea || '').toLowerCase().includes(s) ||
        (r.eoName || '').toLowerCase().includes(s) ||
        (r.mstName || '').toLowerCase().includes(s);
      if (!match) return false;
    }

    if (reportsState.salesArea !== 'all' && r.salesArea !== reportsState.salesArea) return false;
    if (reportsState.eoName !== 'all' && r.eoName !== reportsState.eoName) return false;

    const hasAlert = (r.pits || []).some(p => Number(p.gridEarthValue) > 2.0);
    if (reportsState.status === 'compliant' && hasAlert) return false;
    if (reportsState.status === 'attention' && !hasAlert) return false;

    return true;
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.ceil(totalFiltered / reportsState.pageSize) || 1;
  if (reportsState.page > totalPages) reportsState.page = totalPages;

  const startIdx = (reportsState.page - 1) * reportsState.pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + reportsState.pageSize);

  const html = `
    <div class="space-y-6 fade-in">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl sm:text-3xl font-bold text-slate-900 font-display tracking-tight">Outlet Directory</h1>
          <p class="text-sm text-slate-500 mt-1">Directory of all 389 retail outlets and testing certifications.</p>
        </div>
        <div class="flex items-center gap-2">
          <button id="btn-export-excel" class="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition gap-2">
            <i data-lucide="sheet" class="h-4 w-4 text-emerald-600"></i>
            <span>Export Excel</span>
          </button>
          <a href="#/update-test" class="inline-flex h-10 items-center justify-center rounded-lg bg-amber-500 hover:bg-amber-600 px-4 py-2 text-sm font-bold text-slate-900 shadow-sm transition gap-2">
            <i data-lucide="zap" class="h-4 w-4"></i>
            <span>Update Test</span>
          </a>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
        <div class="flex flex-col md:flex-row gap-3">
          <div class="relative flex-1">
            <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"></i>
            <input type="text" id="dir-search-input" placeholder="Search by ROID, Station Name, Sales Area, EO, MST..." value="${escapeHtml(reportsState.search)}" class="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500" />
            ${reportsState.search ? `<button id="btn-clear-search" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><i data-lucide="x" class="h-4 w-4"></i></button>` : ''}
          </div>

          <div class="w-full md:w-56">
            <select id="dir-sales-area" class="w-full text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-700 focus:ring-2 focus:ring-blue-500">
              <option value="all" ${reportsState.salesArea === 'all' ? 'selected' : ''}>All Sales Areas</option>
              ${salesAreas.map(sa => `<option value="${escapeHtml(sa)}" ${reportsState.salesArea === sa ? 'selected' : ''}>${escapeHtml(sa)}</option>`).join('')}
            </select>
          </div>

          <div class="w-full md:w-48">
            <select id="dir-eo-name" class="w-full text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-700 focus:ring-2 focus:ring-blue-500">
              <option value="all" ${reportsState.eoName === 'all' ? 'selected' : ''}>All Officers (EO)</option>
              ${eos.map(eo => `<option value="${escapeHtml(eo)}" ${reportsState.eoName === eo ? 'selected' : ''}>${escapeHtml(eo)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="flex flex-col sm:flex-row sm:items-center justify-between pt-2 border-t border-slate-100 gap-2">
          <div class="flex bg-slate-100 p-1 rounded-lg text-xs font-medium text-slate-600">
            <button class="dir-status-pill px-3 py-1 rounded-md ${reportsState.status === 'all' ? 'bg-white text-slate-900 shadow-sm font-semibold' : ''}" data-status="all">All (${totalFiltered})</button>
            <button class="dir-status-pill px-3 py-1 rounded-md ${reportsState.status === 'compliant' ? 'bg-white text-emerald-700 shadow-sm font-semibold' : ''}" data-status="compliant">Compliant</button>
            <button class="dir-status-pill px-3 py-1 rounded-md ${reportsState.status === 'attention' ? 'bg-white text-orange-700 shadow-sm font-semibold' : ''}" data-status="attention">Attention Required</button>
          </div>
          <span class="text-xs text-slate-500">Showing <strong class="text-slate-800">${pageItems.length}</strong> of <strong class="text-slate-800">${totalFiltered}</strong></span>
        </div>
      </div>

      <div class="grid gap-3">
        ${pageItems.map(r => {
          const pits = r.pits || [];
          const hasAlert = pits.some(p => Number(p.gridEarthValue) > 2.0);
          const maxVal = Math.max(...pits.map(p => Number(p.gridEarthValue || 0))).toFixed(1);

          return `
            <div class="bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-md transition-all p-4 sm:p-5">
              <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div class="space-y-1.5 flex-1">
                  <div class="flex items-center gap-2.5 flex-wrap">
                    <span class="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs font-mono font-bold text-blue-700 ring-1 ring-inset ring-blue-700/20">
                      ROID: ${escapeHtml(r.retailCode)}
                    </span>
                    <a href="#/reports/${r.id}" class="text-base sm:text-lg font-bold text-slate-900 hover:text-blue-600 transition font-display">
                      ${escapeHtml(r.siteName)}
                    </a>
                  </div>
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span class="font-medium text-slate-700"><i data-lucide="map-pin" class="h-3.5 w-3.5 inline text-slate-400"></i> ${escapeHtml(r.salesArea)}</span>
                    <span>&bull;</span>
                    <span>EO: <strong>${escapeHtml(r.eoName)}</strong></span>
                    <span>&bull;</span>
                    <span>MST: <strong>${escapeHtml(r.mstName)}</strong></span>
                    <span>&bull;</span>
                    <span>Tested: ${formatDate(r.testDate)}</span>
                  </div>
                </div>

                <div class="flex items-center justify-between lg:justify-end gap-5 border-t lg:border-t-0 pt-3 lg:pt-0">
                  <div class="text-left sm:text-right">
                    <div class="text-[10px] uppercase text-slate-400 font-semibold">Max Reading</div>
                    <div class="text-xs font-mono font-bold ${hasAlert ? 'text-orange-600' : 'text-slate-800'}">${maxVal} &Omega;</div>
                  </div>
                  <div class="flex flex-col items-end gap-1 min-w-[85px]">
                    <span class="text-[11px] text-slate-400">${pits.length} Pits</span>
                    ${hasAlert ? `
                      <span class="inline-flex items-center rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-600/20 gap-1">
                        <i data-lucide="alert-triangle" class="h-3 w-3"></i> Attention
                      </span>
                    ` : `
                      <span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 gap-1">
                        <i data-lucide="check" class="h-3 w-3"></i> Compliant
                      </span>
                    `}
                  </div>
                  <div class="flex items-center gap-1">
                    <a href="#/reports/${r.id}" class="p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100" title="View"><i data-lucide="external-link" class="h-4 w-4"></i></a>
                    <button onclick="downloadReportPdf('${r.id}')" class="p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100" title="PDF"><i data-lucide="download" class="h-4 w-4"></i></button>
                    <a href="#/reports/${r.id}/edit" class="p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100" title="Edit"><i data-lucide="edit-3" class="h-4 w-4"></i></a>
                    <button onclick="confirmDeleteReport('${r.id}', '${escapeHtml(r.siteName)}')" class="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50" title="Delete"><i data-lucide="trash-2" class="h-4 w-4"></i></button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${totalPages > 1 ? `
        <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex items-center justify-between">
          <div class="text-xs text-slate-500">Page <strong class="text-slate-900">${reportsState.page}</strong> of <strong class="text-slate-900">${totalPages}</strong></div>
          <div class="flex items-center gap-2">
            <button id="btn-prev-page" ${reportsState.page <= 1 ? 'disabled class="opacity-40"' : 'class="hover:bg-slate-100"'} class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700">Previous</button>
            <button id="btn-next-page" ${reportsState.page >= totalPages ? 'disabled class="opacity-40"' : 'class="hover:bg-slate-100"'} class="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700">Next</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();

  const searchInp = document.getElementById('dir-search-input');
  if (searchInp) {
    searchInp.addEventListener('input', (e) => {
      reportsState.search = e.target.value;
      reportsState.page = 1;
      renderReports();
      const ref = document.getElementById('dir-search-input');
      if (ref) { ref.focus(); ref.setSelectionRange(ref.value.length, ref.value.length); }
    });
  }

  const clearBtn = document.getElementById('btn-clear-search');
  if (clearBtn) clearBtn.addEventListener('click', () => { reportsState.search = ''; reportsState.page = 1; renderReports(); });

  const saSelect = document.getElementById('dir-sales-area');
  if (saSelect) saSelect.addEventListener('change', (e) => { reportsState.salesArea = e.target.value; reportsState.page = 1; renderReports(); });

  const eoSelect = document.getElementById('dir-eo-name');
  if (eoSelect) eoSelect.addEventListener('change', (e) => { reportsState.eoName = e.target.value; reportsState.page = 1; renderReports(); });

  document.querySelectorAll('.dir-status-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      reportsState.status = pill.getAttribute('data-status');
      reportsState.page = 1;
      renderReports();
    });
  });

  const prevBtn = document.getElementById('btn-prev-page');
  if (prevBtn && reportsState.page > 1) prevBtn.addEventListener('click', () => { reportsState.page--; renderReports(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  const nextBtn = document.getElementById('btn-next-page');
  if (nextBtn && reportsState.page < totalPages) nextBtn.addEventListener('click', () => { reportsState.page++; renderReports(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  const exportBtn = document.getElementById('btn-export-excel');
  if (exportBtn) exportBtn.addEventListener('click', exportFullNetworkToExcel);
}

function exportFullNetworkToExcel() {
  try {
    const reports = store.getReports();
    const rows = reports.flatMap(r => (r.pits || []).map(p => ({
      "ROID": r.retailCode || "",
      "Retail Outlet": r.siteName,
      "Sales Area": r.salesArea || "",
      "EO Name": r.eoName || "",
      "MST Name": r.mstName || "",
      "Test Date": r.testDate,
      "Next Due Date": r.nextTestDate || "",
      "Contractor": r.contractorName || "CLR FACILITY SERVICES",
      "Pit Number": p.pitNumber,
      "Pit Location": p.location || "",
      "Equipment Connected": p.equipmentConnected || "",
      "Resistance (Ohm)": Number(p.gridEarthValue || 0),
      "Status": Number(p.gridEarthValue) <= 2.0 ? "Pass" : "Fail",
      "Remarks": p.remarks || ""
    })));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "BPCL Earthing Network");
    const today = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `BPCL_Earthing_Network_${today}.xlsx`);
    showToast({ title: "Excel Export Complete", description: `Exported ${reports.length} outlets.`, variant: "success" });
  } catch (err) {
    showToast({ title: "Export Failed", description: "Could not build Excel export.", variant: "destructive" });
  }
}

// ==========================================
// 8. VIEW 4: HSSE AUDIT (#/hsse-audit)
// High Resistance Outlets Requiring Maintenance & Action Console
// ==========================================
let hsseAuditFilters = {
  mstName: 'all',
  salesArea: 'all',
  severity: 'all',
  search: ''
};

window.setHsseFilter = function(key, val) {
  hsseAuditFilters[key] = val;
  renderHsseAuditView();
};

window.resetHsseFilters = function() {
  hsseAuditFilters = { mstName: 'all', salesArea: 'all', severity: 'all', search: '' };
  renderHsseAuditView();
};

window.actionLaunchMstUpdate = function(reportId) {
  const rep = store.getReport(reportId);
  if (!rep) return;
  mstSelectedReport = rep;
  if (rep.pits && rep.pits.length > 0) {
    mstPitsData = rep.pits.map(p => ({
      pitNumber: p.pitNumber,
      equipmentConnected: p.equipmentConnected,
      gridEarthValue: p.gridEarthValue,
      remarks: p.remarks || '',
      photoBase64: null,
      photoName: null
    }));
  }
  window.location.hash = '#/update-test';
  showToast({
    title: "Station Loaded for Action",
    description: `${rep.siteName} (${rep.retailCode}) loaded into Update Test form.`,
    variant: "success"
  });
};

window.exportHsseMaintenanceWorklist = function() {
  try {
    const allReports = store.getReports();
    const allHigh = allReports.filter(r => (r.pits || []).some(p => Number(p.gridEarthValue) > 2.0));
    
    // Apply current filters
    const filtered = allHigh.filter(r => {
      if (hsseAuditFilters.mstName !== 'all' && (r.mstName || 'Unassigned') !== hsseAuditFilters.mstName) return false;
      if (hsseAuditFilters.salesArea !== 'all' && r.salesArea !== hsseAuditFilters.salesArea) return false;
      if (hsseAuditFilters.severity === 'critical' && !(r.pits || []).some(p => Number(p.gridEarthValue) > 5.0)) return false;
      if (hsseAuditFilters.severity === 'moderate') {
        const maxVal = Math.max(...(r.pits || []).map(p => Number(p.gridEarthValue) || 0));
        if (maxVal > 5.0 || maxVal <= 2.0) return false;
      }
      if (hsseAuditFilters.search) {
        const q = hsseAuditFilters.search.toLowerCase();
        const code = String(r.retailCode || '').toLowerCase();
        const name = String(r.siteName || '').toLowerCase();
        const sa = String(r.salesArea || '').toLowerCase();
        const mst = String(r.mstName || '').toLowerCase();
        if (!code.includes(q) && !name.includes(q) && !sa.includes(q) && !mst.includes(q)) return false;
      }
      return true;
    });

    const rows = filtered.map(r => {
      const highPits = (r.pits || []).filter(p => Number(p.gridEarthValue) > 2.0);
      const maxVal = Math.max(...(r.pits || []).map(p => Number(p.gridEarthValue) || 0));
      const failedPitsSummary = highPits.map(p => `${p.pitNumber} (${p.equipmentConnected}): ${p.gridEarthValue} Ohm`).join("; ");
      const isCritical = maxVal > 5.0;
      
      let actionRecommendation = "Watering & bentonite compound top-up; verify test link connections.";
      if (highPits.some(p => (p.equipmentConnected || '').toLowerCase().includes('tank'))) {
        actionRecommendation = "URGENT: Re-tighten static earthing link; chemical bentonite treatment required.";
      } else if (highPits.some(p => (p.equipmentConnected || '').toLowerCase().includes('dispenser'))) {
        actionRecommendation = "Check fuel dispenser chassis bonding & earth continuity.";
      }

      return {
        "Priority": isCritical ? "CRITICAL (>5.0 Ohm)" : "HIGH (>2.0 Ohm)",
        "ROID": r.retailCode || "",
        "Retail Outlet": r.siteName,
        "Sales Area": r.salesArea || "",
        "Engineering Officer (EO)": r.eoName || "",
        "Technician (MST)": r.mstName || "Unassigned",
        "Failed Pits & Measured Values": failedPitsSummary,
        "Max Resistance (Ohm)": maxVal,
        "Prescribed Maintenance Action": actionRecommendation,
        "Last Tested Date": r.testDate || "",
        "Next Due Date": r.nextTestDate || ""
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "HSSE Maintenance Worklist");
    const today = new Date().toISOString().split('T')[0];
    const mstTag = hsseAuditFilters.mstName !== 'all' ? `_${hsseAuditFilters.mstName.replace(/\s+/g, '_')}` : '';
    XLSX.writeFile(wb, `BPCL_HSSE_Maintenance_Worklist${mstTag}_${today}.xlsx`);
    showToast({
      title: "Worklist Downloaded",
      description: `Exported ${filtered.length} high resistance outlets for maintenance action.`,
      variant: "success"
    });
  } catch (err) {
    console.error("Export error:", err);
    showToast({ title: "Export Failed", description: "Could not generate Excel worklist.", variant: "destructive" });
  }
};

function renderHsseAuditView() {
  const allReports = store.getReports();
  const allHighOutlets = allReports.filter(r => (r.pits || []).some(p => Number(p.gridEarthValue) > 2.0));
  
  // Extract MSTs with high resistance counts
  const mstCounts = {};
  allHighOutlets.forEach(r => {
    const mst = r.mstName || 'Unassigned';
    mstCounts[mst] = (mstCounts[mst] || 0) + 1;
  });
  const mstList = Object.keys(mstCounts).sort((a, b) => mstCounts[b] - mstCounts[a]);

  // Extract Sales Areas with high counts
  const saCounts = {};
  allHighOutlets.forEach(r => {
    const sa = r.salesArea || 'Other';
    saCounts[sa] = (saCounts[sa] || 0) + 1;
  });
  const saList = Object.keys(saCounts).sort();

  // Apply filters
  const filteredHighOutlets = allHighOutlets.filter(r => {
    if (hsseAuditFilters.mstName !== 'all' && (r.mstName || 'Unassigned') !== hsseAuditFilters.mstName) return false;
    if (hsseAuditFilters.salesArea !== 'all' && r.salesArea !== hsseAuditFilters.salesArea) return false;
    if (hsseAuditFilters.severity === 'critical') {
      if (!(r.pits || []).some(p => Number(p.gridEarthValue) > 5.0)) return false;
    } else if (hsseAuditFilters.severity === 'moderate') {
      const maxVal = Math.max(...(r.pits || []).map(p => Number(p.gridEarthValue) || 0));
      if (maxVal > 5.0 || maxVal <= 2.0) return false;
    }
    if (hsseAuditFilters.search) {
      const q = hsseAuditFilters.search.toLowerCase();
      const code = String(r.retailCode || '').toLowerCase();
      const name = String(r.siteName || '').toLowerCase();
      const sa = String(r.salesArea || '').toLowerCase();
      const mst = String(r.mstName || '').toLowerCase();
      if (!code.includes(q) && !name.includes(q) && !sa.includes(q) && !mst.includes(q)) return false;
    }
    return true;
  });

  const totalNetworkPits = allReports.flatMap(r => r.pits || []);
  const compliantPits = totalNetworkPits.filter(p => Number(p.gridEarthValue) <= 2.0).length;
  const safetyScore = totalNetworkPits.length > 0 ? ((compliantPits / totalNetworkPits.length) * 100).toFixed(1) : 100;
  const criticalCount = allHighOutlets.filter(r => (r.pits || []).some(p => Number(p.gridEarthValue) > 5.0)).length;
  const activeMstCount = hsseAuditFilters.mstName !== 'all' ? (mstCounts[hsseAuditFilters.mstName] || 0) : allHighOutlets.length;

  const html = `
    <div class="space-y-6 fade-in max-w-6xl mx-auto pb-16">
      <!-- Header Banner -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-2xl sm:text-3xl font-bold text-slate-900 font-display tracking-tight">HSSE Earthing Safety Audit</h1>
            <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
              OISD-147 / IS 3043
            </span>
          </div>
          <p class="text-xs text-slate-500 mt-1">High Resistance Outlets Requiring Maintenance & Corrective Action Monitoring.</p>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="exportHsseMaintenanceWorklist()" class="inline-flex h-10 items-center justify-center rounded-lg bg-emerald-600 text-white px-4 text-xs font-bold hover:bg-emerald-700 shadow transition gap-2">
            <i data-lucide="sheet" class="h-4 w-4"></i>
            <span>Export Maintenance List</span>
          </button>
          <a href="#/update-test" class="inline-flex h-10 items-center justify-center rounded-lg bg-amber-500 text-slate-950 px-4 text-xs font-bold hover:bg-amber-400 shadow transition gap-1.5">
            <i data-lucide="zap" class="h-4 w-4"></i>
            <span>Update Test (MST)</span>
          </a>
        </div>
      </div>

      <!-- HSSE KPI Scorecards -->
      <div class="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <!-- 1. High Resistance Outlets -->
        <div class="bg-white rounded-xl border border-rose-200 p-4 sm:p-5 shadow-sm space-y-1 relative overflow-hidden">
          <div class="absolute top-0 right-0 w-16 h-16 bg-rose-50 rounded-bl-full flex items-start justify-end p-2 text-rose-500">
            <i data-lucide="alert-triangle" class="h-5 w-5"></i>
          </div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-rose-700">Maintenance Needed</span>
          <div class="text-2xl sm:text-3xl font-bold font-display text-rose-600">${allHighOutlets.length} Outlets</div>
          <p class="text-[11px] text-slate-500">Pits with resistance &gt; 2.0 &Omega;</p>
        </div>

        <!-- 2. Filtered MST Workload -->
        <div class="bg-white rounded-xl border border-blue-200 p-4 sm:p-5 shadow-sm space-y-1 relative overflow-hidden">
          <div class="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full flex items-start justify-end p-2 text-blue-500">
            <i data-lucide="wrench" class="h-5 w-5"></i>
          </div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-blue-700">Filtered MST Sites</span>
          <div class="text-2xl sm:text-3xl font-bold font-display text-blue-600">${filteredHighOutlets.length} Outlets</div>
          <p class="text-[11px] text-slate-500">${hsseAuditFilters.mstName === 'all' ? 'Across all 12 MSTs' : `Assigned to ${escapeHtml(hsseAuditFilters.mstName)}`}</p>
        </div>

        <!-- 3. Critical Hazard Outlets -->
        <div class="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-1 relative overflow-hidden">
          <div class="absolute top-0 right-0 w-16 h-16 bg-red-50 rounded-bl-full flex items-start justify-end p-2 text-red-500">
            <i data-lucide="flame" class="h-5 w-5"></i>
          </div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Critical Hazards</span>
          <div class="text-2xl sm:text-3xl font-bold font-display text-red-600">${criticalCount} Outlets</div>
          <p class="text-[11px] text-slate-500">Pits &gt; 5.0 &Omega; (Severe static risk)</p>
        </div>

        <!-- 4. Safety Score -->
        <div class="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-1 relative overflow-hidden">
          <div class="absolute top-0 right-0 w-16 h-16 bg-emerald-50 rounded-bl-full flex items-start justify-end p-2 text-emerald-500">
            <i data-lucide="shield-check" class="h-5 w-5"></i>
          </div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-slate-600">Network Compliance</span>
          <div class="text-2xl sm:text-3xl font-bold font-display text-emerald-600">${safetyScore}%</div>
          <p class="text-[11px] text-slate-500">${compliantPits} of ${totalNetworkPits.length} pits safe</p>
        </div>
      </div>

      <!-- Filter Controls: Filter by MST, Sales Area, Severity & Search -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-2">
          <div class="flex items-center gap-2">
            <i data-lucide="filter" class="h-4 w-4 text-blue-600"></i>
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-700">Filter Maintenance Outlets</h2>
          </div>
          <button onclick="resetHsseFilters()" class="text-[11px] font-semibold text-blue-600 hover:text-blue-800 transition">
            Reset Filters
          </button>
        </div>

        <div class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <!-- 1. MST Filter (Requested by User) -->
          <div>
            <label class="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Technician (MST):
            </label>
            <select
              id="hsse-mst-select"
              onchange="setHsseFilter('mstName', this.value)"
              class="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-800 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
              <option value="all" ${hsseAuditFilters.mstName === 'all' ? 'selected' : ''}>
                All MST Technicians (${allHighOutlets.length} Sites)
              </option>
              ${mstList.map(mst => `
                <option value="${escapeHtml(mst)}" ${hsseAuditFilters.mstName === mst ? 'selected' : ''}>
                  ${escapeHtml(mst)} (${mstCounts[mst]} Sites)
                </option>
              `).join('')}
            </select>
          </div>

          <!-- 2. Sales Area Filter -->
          <div>
            <label class="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Territory / Sales Area:
            </label>
            <select
              id="hsse-sa-select"
              onchange="setHsseFilter('salesArea', this.value)"
              class="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-800 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
              <option value="all" ${hsseAuditFilters.salesArea === 'all' ? 'selected' : ''}>
                All Sales Areas (${allHighOutlets.length} Sites)
              </option>
              ${saList.map(sa => `
                <option value="${escapeHtml(sa)}" ${hsseAuditFilters.salesArea === sa ? 'selected' : ''}>
                  ${escapeHtml(sa)} (${saCounts[sa]} Sites)
                </option>
              `).join('')}
            </select>
          </div>

          <!-- 3. Severity Filter -->
          <div>
            <label class="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Hazard Severity:
            </label>
            <select
              id="hsse-severity-select"
              onchange="setHsseFilter('severity', this.value)"
              class="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-slate-800 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
              <option value="all" ${hsseAuditFilters.severity === 'all' ? 'selected' : ''}>All High (&gt; 2.0 &Omega;)</option>
              <option value="critical" ${hsseAuditFilters.severity === 'critical' ? 'selected' : ''}>Critical Risk (&gt; 5.0 &Omega;)</option>
              <option value="moderate" ${hsseAuditFilters.severity === 'moderate' ? 'selected' : ''}>Moderate (2.1 - 5.0 &Omega;)</option>
            </select>
          </div>

          <!-- 4. Quick Search -->
          <div>
            <label class="block text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1">
              Search Site:
            </label>
            <div class="relative">
              <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"></i>
              <input
                type="text"
                id="hsse-search-input"
                placeholder="Search ROID or Outlet..."
                value="${escapeHtml(hsseAuditFilters.search)}"
                oninput="setHsseFilter('search', this.value)"
                class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- High Resistance Outlets Requiring Maintenance Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-50/50">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-bold text-slate-900 font-display flex items-center gap-2">
                <i data-lucide="alert-octagon" class="h-4 w-4 text-rose-600"></i>
                <span>High Resistance Outlets Requiring Maintenance (${filteredHighOutlets.length} Sites)</span>
              </h2>
              ${hsseAuditFilters.mstName !== 'all' ? `
                <span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800">
                  MST: ${escapeHtml(hsseAuditFilters.mstName)}
                </span>
              ` : ''}
            </div>
            <p class="text-xs text-slate-500 mt-0.5">Click "Update Test (MST)" to record watering, bentonite treatment, and upload maintenance photos.</p>
          </div>

          <span class="text-xs font-semibold text-slate-500">
            Showing ${filteredHighOutlets.length} of ${allHighOutlets.length} sites
          </span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-600 border-b border-slate-200">
              <tr>
                <th class="px-4 py-3 font-bold">ROID</th>
                <th class="px-4 py-3 font-bold">Retail Outlet Name</th>
                <th class="px-4 py-3 font-bold">Sales Area & EO</th>
                <th class="px-4 py-3 font-bold text-blue-900">Technician (MST)</th>
                <th class="px-4 py-3 font-bold text-rose-900">High Resistance Pits</th>
                <th class="px-4 py-3 font-bold">Max &Omega;</th>
                <th class="px-4 py-3 font-bold">Prescribed Action</th>
                <th class="px-4 py-3 font-bold text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${filteredHighOutlets.length === 0 ? `
                <tr>
                  <td colspan="8" class="text-center py-12 text-slate-400">
                    <div class="flex flex-col items-center gap-2">
                      <i data-lucide="check-circle-2" class="h-8 w-8 text-emerald-500"></i>
                      <p class="text-sm font-semibold text-slate-700">No High Resistance Outlets Found</p>
                      <p class="text-xs text-slate-400">No outlets match the selected filter criteria.</p>
                    </div>
                  </td>
                </tr>
              ` : filteredHighOutlets.map(r => {
                const highPits = (r.pits || []).filter(p => Number(p.gridEarthValue) > 2.0);
                const maxVal = Math.max(...(r.pits || []).map(p => Number(p.gridEarthValue) || 0));
                const isCritical = maxVal > 5.0;

                // Recommended Maintenance Action logic
                let actionText = "Watering & bentonite treatment; check pit link";
                let actionBadge = "bg-orange-50 text-orange-700 border-orange-200";
                if (highPits.some(p => (p.equipmentConnected || '').toLowerCase().includes('tank'))) {
                  actionText = "URGENT: Re-tighten static earthing link & flush watering pipe";
                  actionBadge = "bg-red-50 text-red-700 border-red-200 font-bold";
                } else if (highPits.some(p => (p.equipmentConnected || '').toLowerCase().includes('dispenser'))) {
                  actionText = "Check fuel dispenser nozzle/chassis bonding continuity";
                  actionBadge = "bg-rose-50 text-rose-700 border-rose-200";
                }

                return `
                  <tr class="hover:bg-slate-50/80 transition">
                    <!-- ROID -->
                    <td class="px-4 py-3.5 font-mono font-bold text-xs text-slate-700">
                      ${escapeHtml(r.retailCode || 'N/A')}
                    </td>

                    <!-- Outlet Name -->
                    <td class="px-4 py-3.5">
                      <div class="font-bold text-slate-900 text-xs sm:text-sm">${escapeHtml(r.siteName)}</div>
                      <div class="text-[11px] text-slate-400 truncate max-w-xs">${escapeHtml(r.location || r.salesArea || '')}</div>
                    </td>

                    <!-- Sales Area & EO -->
                    <td class="px-4 py-3.5 text-xs text-slate-600">
                      <div class="font-medium text-slate-800">${escapeHtml(r.salesArea || 'N/A')}</div>
                      <div class="text-[11px] text-slate-500">EO: ${escapeHtml(r.eoName || 'N/A')}</div>
                    </td>

                    <!-- MST Technician (Prominent) -->
                    <td class="px-4 py-3.5 text-xs">
                      <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-50 text-blue-800 border border-blue-200">
                        <i data-lucide="wrench" class="h-3 w-3 text-blue-600"></i>
                        <span>${escapeHtml(r.mstName || 'Unassigned')}</span>
                      </span>
                    </td>

                    <!-- High Resistance Pits Detail -->
                    <td class="px-4 py-3.5 text-xs">
                      <div class="flex flex-wrap gap-1.5 max-w-xs">
                        ${highPits.map(p => {
                          const val = Number(p.gridEarthValue) || 0;
                          const crit = val > 5.0;
                          return `
                            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold ${crit ? 'bg-red-100 text-red-800 border border-red-200' : 'bg-orange-100 text-orange-800 border border-orange-200'}">
                              <span>${escapeHtml(p.pitNumber)}</span>
                              <span class="font-bold">(${val}&Omega;)</span>
                            </span>
                          `;
                        }).join('')}
                      </div>
                      <div class="text-[10px] text-slate-400 mt-1 truncate max-w-xs">
                        ${highPits.map(p => p.equipmentConnected).filter(Boolean).join(', ')}
                      </div>
                    </td>

                    <!-- Max Resistance -->
                    <td class="px-4 py-3.5">
                      <div class="font-mono font-bold text-xs ${isCritical ? 'text-red-600' : 'text-orange-600'}">
                        ${maxVal.toFixed(1)} &Omega;
                      </div>
                      <div class="text-[9px] text-slate-400">
                        +${(maxVal - 2.0).toFixed(1)} &Omega; over
                      </div>
                    </td>

                    <!-- Prescribed Maintenance Action -->
                    <td class="px-4 py-3.5 text-xs">
                      <span class="inline-block px-2 py-1 rounded text-[11px] border leading-tight ${actionBadge}">
                        ${actionText}
                      </span>
                    </td>

                    <!-- Direct Action Buttons -->
                    <td class="px-4 py-3.5 text-right">
                      <div class="flex items-center justify-end gap-1.5">
                        <button
                          onclick="actionLaunchMstUpdate('${r.id}')"
                          class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold shadow-sm transition"
                          title="Open Update Test form for this station"
                        >
                          <i data-lucide="zap" class="h-3.5 w-3.5"></i>
                          <span>Update Test</span>
                        </button>

                        <a
                          href="#/reports/${r.id}"
                          class="inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 transition"
                          title="View Full Station Details"
                        >
                          <i data-lucide="eye" class="h-3.5 w-3.5"></i>
                        </a>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Physical Earthing Inspection Audit Checklist (Reference Standards) -->
      <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
        <h2 class="text-sm font-bold text-slate-900 font-display border-b border-slate-100 pb-2 flex items-center gap-2">
          <i data-lucide="check-square" class="h-4 w-4 text-emerald-600"></i>
          <span>Standard Physical Audit Checklist for MSTs (IS 3043 / OISD-147)</span>
        </h2>

        <div class="grid gap-3 sm:grid-cols-2 text-xs text-slate-700">
          <div class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100">
            <i data-lucide="check" class="h-4 w-4 text-emerald-600 shrink-0 mt-0.5"></i>
            <div>
              <span class="font-bold text-slate-900">Earth Pit Chamber & Cover:</span>
              <p class="text-[11px] text-slate-500 mt-0.5">Masonry chamber clean, lid painted yellow/green, no water logging or debris accumulation.</p>
            </div>
          </div>

          <div class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100">
            <i data-lucide="check" class="h-4 w-4 text-emerald-600 shrink-0 mt-0.5"></i>
            <div>
              <span class="font-bold text-slate-900">Removable Test Link:</span>
              <p class="text-[11px] text-slate-500 mt-0.5">Tinned copper / GI test link secured with brass bolts & washers, free from oxidation or loose arcing.</p>
            </div>
          </div>

          <div class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100">
            <i data-lucide="check" class="h-4 w-4 text-emerald-600 shrink-0 mt-0.5"></i>
            <div>
              <span class="font-bold text-slate-900">Dispenser & Static Bonding:</span>
              <p class="text-[11px] text-slate-500 mt-0.5">Continuous copper bonding strip from fuel dispenser nozzle & frame to body earth electrode (&le; 2.0 &Omega;).</p>
            </div>
          </div>

          <div class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100">
            <i data-lucide="check" class="h-4 w-4 text-emerald-600 shrink-0 mt-0.5"></i>
            <div>
              <span class="font-bold text-slate-900">Chemical Treatment & Watering:</span>
              <p class="text-[11px] text-slate-500 mt-0.5">Perforated GI watering pipe clear; bentonite / carbon grounding compound replenished if resistance exceeds 2.0 &Omega;.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();
}



// ==========================================
// 8.1 VIEW: REPORT DETAIL (#/reports/:id)
// Full Station Details, Earth Pit Measurements & Actions
// ==========================================
function renderReportDetail(reportId) {
  const report = store.getReport(reportId);
  if (!report) {
    document.getElementById('app-content').innerHTML = `
      <div class="text-center py-20 fade-in space-y-4">
        <div class="w-16 h-16 rounded-full mx-auto bg-amber-50 text-amber-600 flex items-center justify-center">
          <i data-lucide="alert-circle" class="h-8 w-8"></i>
        </div>
        <h2 class="text-xl font-bold text-slate-900 font-display">Retail Outlet Not Found</h2>
        <p class="text-xs text-slate-500">The requested outlet details could not be loaded.</p>
        <a href="#/reports" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-xs font-bold text-white shadow hover:bg-blue-700 transition">
          <i data-lucide="arrow-left" class="h-4 w-4"></i>
          <span>Back to Outlet Directory</span>
        </a>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const pits = report.pits || [];
  const outOfRange = pits.filter(p => Number(p.gridEarthValue) > 2.0);
  const isCompliant = outOfRange.length === 0;

  const vals = pits.map(p => Number(p.gridEarthValue || 0));
  const minVal = vals.length > 0 ? Math.min(...vals).toFixed(1) : "0.0";
  const maxVal = vals.length > 0 ? Math.max(...vals).toFixed(1) : "0.0";
  const avgVal = vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : "0.00";

  const html = `
    <div class="space-y-6 fade-in max-w-5xl mx-auto pb-16">
      <!-- Header -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <a href="#/reports" class="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 transition" title="Back to Directory">
            <i data-lucide="arrow-left" class="h-5 w-5"></i>
          </a>
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="text-xl sm:text-2xl font-bold text-slate-900 font-display">${escapeHtml(report.siteName)}</h1>
              <span class="px-2.5 py-0.5 rounded font-mono font-bold text-xs bg-blue-100 text-blue-800 border border-blue-200">
                ROID: ${escapeHtml(report.retailCode || 'N/A')}
              </span>
              <span class="px-2.5 py-0.5 rounded text-xs font-bold ${isCompliant ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                ${isCompliant ? 'IS 3043 Compliant' : 'Maintenance Required'}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-1">
              <span>Territory: <strong class="text-slate-800">${escapeHtml(report.salesArea || 'N/A')}</strong></span> &bull; 
              <span>EO: <strong class="text-slate-800">${escapeHtml(report.eoName || 'N/A')}</strong></span> &bull; 
              <span>MST: <strong class="text-slate-800">${escapeHtml(report.mstName || 'N/A')}</strong></span>
            </p>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <!-- 1. Launch Update Test for this station -->
          <button
            onclick="actionLaunchMstUpdate('${report.id}')"
            class="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold shadow-sm transition"
          >
            <i data-lucide="zap" class="h-4 w-4"></i>
            <span>Update Test (MST)</span>
          </button>

          <!-- 2. Download Official PDF Certificate -->
          <button
            onclick="downloadReportPdf('${report.id}')"
            class="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-sm transition"
          >
            <i data-lucide="file-text" class="h-4 w-4 text-blue-600"></i>
            <span>PDF Certificate</span>
          </button>

          <!-- 3. Edit Station Info -->
          <a
            href="#/reports/${report.id}/edit"
            class="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition"
          >
            <i data-lucide="edit-3" class="h-4 w-4 text-slate-500"></i>
            <span>Edit</span>
          </a>

          <!-- 4. Delete -->
          <button
            onclick="confirmDeleteReport('${report.id}', '${escapeHtml(report.siteName)}')"
            class="inline-flex items-center justify-center p-2 rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50 shadow-sm transition"
            title="Delete Record"
          >
            <i data-lucide="trash-2" class="h-4 w-4"></i>
          </button>
        </div>
      </div>

      <!-- Compliance Summary Card -->
      <div class="rounded-xl border p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${isCompliant ? 'bg-emerald-50/60 border-emerald-200' : 'bg-rose-50/60 border-rose-200'}">
        <div class="flex items-start gap-3.5">
          <div class="p-2.5 rounded-xl ${isCompliant ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'} shrink-0 mt-0.5">
            <i data-lucide="${isCompliant ? 'shield-check' : 'alert-octagon'}" class="h-6 w-6"></i>
          </div>
          <div>
            <h3 class="text-base font-bold ${isCompliant ? 'text-emerald-900' : 'text-rose-900'} font-display">
              ${isCompliant ? 'ALL EARTH PITS COMPLIANT (<= 2.0 Ohm)' : 'ATTENTION REQUIRED: ELEVATED RESISTANCE (> 2.0 Ohm)'}
            </h3>
            <p class="text-xs ${isCompliant ? 'text-emerald-800' : 'text-rose-800'} mt-0.5">
              ${isCompliant 
                ? 'All grounding electrodes meet IS 3043:2018 and OISD-STD-147 standard specifications.' 
                : `${outOfRange.length} earth pit(s) exceed 2.0 Ohm safety threshold. Watering and bentonite treatment required.`}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-6 bg-white/80 p-3 rounded-lg border border-slate-200/60 text-xs">
          <div class="text-center">
            <span class="text-slate-400 block text-[10px] uppercase font-bold">Min</span>
            <span class="font-bold font-mono text-slate-800 text-sm">${minVal} &Omega;</span>
          </div>
          <div class="w-px h-6 bg-slate-200"></div>
          <div class="text-center">
            <span class="text-slate-400 block text-[10px] uppercase font-bold">Average</span>
            <span class="font-bold font-mono text-slate-800 text-sm">${avgVal} &Omega;</span>
          </div>
          <div class="w-px h-6 bg-slate-200"></div>
          <div class="text-center">
            <span class="text-slate-400 block text-[10px] uppercase font-bold">Max</span>
            <span class="font-bold font-mono text-sm ${Number(maxVal) > 2.0 ? 'text-rose-600' : 'text-slate-800'}">${maxVal} &Omega;</span>
          </div>
        </div>
      </div>

      <!-- Station Metadata Card -->
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 bg-white rounded-xl border border-slate-200 p-4 shadow-sm text-xs">
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Testing Contractor</span>
          <p class="font-bold text-slate-800 mt-0.5">${escapeHtml(report.contractorName || 'CLR FACILITY SERVICES')}</p>
        </div>
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Earth Tester Instrument</span>
          <p class="font-bold text-slate-800 mt-0.5">${escapeHtml(report.earthTesterMake || 'Waco')} ${escapeHtml(report.earthTesterModel || 'Digital Earth Tester')} (${escapeHtml(report.earthTesterSerial || 'N/A')})</p>
        </div>
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last Test Date</span>
          <p class="font-bold text-slate-800 mt-0.5">${escapeHtml(report.testDate || 'N/A')}</p>
        </div>
        <div>
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Next Retest Due Date</span>
          <p class="font-bold text-blue-700 mt-0.5">${escapeHtml(report.nextTestDate || 'N/A')}</p>
        </div>
      </div>

      <!-- Earth Pit Measurements Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div>
            <h2 class="text-sm font-bold text-slate-900 font-display">Earth Pit Measurements (${pits.length} Grounding Electrodes)</h2>
            <p class="text-xs text-slate-400">IS 3043:2018 & OISD-147 standard threshold: &le; 2.0 &Omega;</p>
          </div>
          <button onclick="actionLaunchMstUpdate('${report.id}')" class="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1">
            <i data-lucide="edit" class="h-3.5 w-3.5"></i>
            <span>Update Values</span>
          </button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <tr>
                <th class="px-6 py-3 font-semibold">Pit Number</th>
                <th class="px-6 py-3 font-semibold">Connected Equipment</th>
                <th class="px-6 py-3 font-semibold">Location</th>
                <th class="px-6 py-3 font-semibold text-center">Resistance (&Omega;)</th>
                <th class="px-6 py-3 font-semibold">Compliance Status</th>
                <th class="px-6 py-3 font-semibold">Action Remarks</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${pits.map(p => {
                const val = parseFloat(p.gridEarthValue) || 0;
                const ok = val <= 2.0;
                const isCritical = val > 5.0;

                return `
                  <tr class="hover:bg-slate-50/70 transition">
                    <td class="px-6 py-4 font-bold text-slate-900 font-mono text-xs">
                      <span class="px-2 py-1 rounded bg-slate-100 text-slate-800 border border-slate-200">${escapeHtml(p.pitNumber)}</span>
                    </td>
                    <td class="px-6 py-4 text-xs font-semibold text-slate-800">
                      ${escapeHtml(p.equipmentConnected || 'Main Ground Grid')}
                    </td>
                    <td class="px-6 py-4 text-xs text-slate-600">
                      ${escapeHtml(p.location || 'Retail Outlet Forecourt')}
                    </td>
                    <td class="px-6 py-4 text-center font-mono font-bold text-sm ${ok ? 'text-slate-900' : isCritical ? 'text-red-600' : 'text-orange-600'}">
                      ${val.toFixed(1)} &Omega;
                    </td>
                    <td class="px-6 py-4">
                      <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold ${ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : isCritical ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-orange-50 text-orange-700 border border-orange-200'}">
                        <span class="h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}"></span>
                        <span>${ok ? 'PASSED (OK)' : isCritical ? 'CRITICAL (>5.0&Omega;)' : 'HIGH (>2.0&Omega;)'}</span>
                      </span>
                    </td>
                    <td class="px-6 py-4 text-xs text-slate-500">
                      ${escapeHtml(p.remarks || (ok ? 'Inspection Ok' : 'Watering & bentonite treatment needed'))}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();
}

// ==========================================
// 8.2 PDF CERTIFICATE GENERATOR
// ==========================================
window.downloadReportPdf = function(reportId) {
  const report = store.getReport(reportId);
  if (!report) {
    showToast({ title: "Report Not Found", description: "Could not generate PDF.", variant: "destructive" });
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Top Header
    doc.setFontSize(15);
    doc.setTextColor(0, 46, 102);
    doc.text("BHARAT PETROLEUM CORPORATION LIMITED", 105, 14, { align: "center" });

    doc.setFontSize(12);
    doc.setTextColor(0, 86, 179);
    doc.setFont("helvetica", "bold");
    doc.text("EARTH PIT TESTING CERTIFICATE", 105, 21, { align: "center" });

    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.setFont("helvetica", "normal");
    doc.text("Tested in strict compliance with IS 3043:2018 & OISD-STD-147 Standards - Max Limit: <= 2.0 Ohm", 105, 26, { align: "center" });

    // Station Info Box
    doc.setDrawColor(210);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(14, 30, 182, 33, 2, 2, "FD");

    doc.setFontSize(9);
    doc.setTextColor(30);
    doc.setFont("helvetica", "bold");
    doc.text(`Retail Outlet: ${report.siteName}`, 18, 36);
    doc.text(`ROID: ${report.retailCode || 'N/A'}`, 18, 42);
    doc.text(`Sales Area: ${report.salesArea || 'N/A'}`, 18, 48);
    doc.text(`Engineering Officer (EO): ${report.eoName || 'N/A'}`, 18, 54);
    doc.text(`Equipment: ${report.earthTesterMake || 'Waco'} ${report.earthTesterModel || 'Digital Tester'}`, 18, 60);

    doc.text(`MST Technician: ${report.mstName || 'N/A'}`, 115, 36);
    doc.text(`Test Date: ${report.testDate || 'N/A'}`, 115, 42);
    doc.text(`Next Retest Due: ${report.nextTestDate || 'N/A'}`, 115, 48);
    doc.text(`Contractor: ${report.contractorName || 'CLR FACILITY SERVICES'}`, 115, 54);
    doc.text(`Serial No: ${report.earthTesterSerial || 'WC-395710'}`, 115, 60);

    // Pit Measurements Table
    const pits = report.pits || [];
    const tableBody = pits.map(p => [
      p.pitNumber,
      p.equipmentConnected || 'Main Ground Grid',
      p.location || 'Forecourt',
      Number(p.gridEarthValue || 0).toFixed(1) + " Ohm",
      Number(p.gridEarthValue) <= 2.0 ? "PASSED (<= 2.0 Ohm)" : "FAILED (> 2.0 Ohm)",
      p.remarks || (Number(p.gridEarthValue) <= 2.0 ? "Normal" : "Needs Watering")
    ]);

    doc.autoTable({
      startY: 67,
      head: [["Pit No.", "Connected Equipment", "Location", "Resistance", "Status", "Remarks"]],
      body: tableBody,
      theme: "grid",
      headStyles: { 
        fillColor: [0, 86, 179], 
        textColor: 255, 
        fontStyle: 'bold',
        halign: 'center',
        valign: 'middle'
      },
      styles: { fontSize: 8.5, cellPadding: 3 },
      columnStyles: {
        0: { halign: 'center', fontStyle: 'bold' },
        1: { halign: 'left' },
        2: { halign: 'left' },
        3: { halign: 'center', fontStyle: 'bold' },
        4: { halign: 'center', fontStyle: 'bold' },
        5: { halign: 'left' }
      }
    });

    // Verification Signatures (Clean non-overlapping layout with distinct columns)
    let finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY + 18 : 160;
    if (finalY > 240) {
      doc.addPage();
      finalY = 25;
    }

    doc.setFontSize(8.5);
    doc.setTextColor(40);

    // Left Column: Tested By (CLR FACILITY SERVICES / MST)
    doc.setFont("helvetica", "bold");
    doc.text("Tested By (CLR FACILITY SERVICES / MST):", 14, finalY);
    doc.setFont("helvetica", "normal");
    doc.text("Name: " + (report.mstName || "Technician"), 14, finalY + 6);
    doc.text("Signature: ___________________________", 14, finalY + 12);
    doc.text(`Test Date: ${report.testDate || new Date().toLocaleDateString('en-GB')}`, 14, finalY + 18);

    // Right Column: Verified By (BPCL Territory Officer)
    doc.setFont("helvetica", "bold");
    doc.text("Verified By (BPCL Territory Officer):", 115, finalY);
    doc.setFont("helvetica", "normal");
    doc.text("Name: " + (report.eoName || "Territory Officer"), 115, finalY + 6);
    doc.text("Signature: ___________________________", 115, finalY + 12);
    doc.text("Designation: Engineering Officer", 115, finalY + 18);

    // Official Footer Note
    doc.setFontSize(7.5);
    doc.setTextColor(120);
    doc.text(`BPCL Retail Earth Pit Testing Certificate • Generated: ${new Date().toLocaleDateString('en-GB')} • IS 3043:2018 & OISD-STD-147`, 105, finalY + 28, { align: "center" });

    const safeSite = (report.siteName || 'Certificate').replace(/[^a-zA-Z0-9_-]/g, '_');
    doc.save(`BPCL_Earthing_${report.retailCode || 'RO'}_${safeSite}.pdf`);
    showToast({ title: "Certificate Downloaded", description: `Saved PDF for ${report.siteName}`, variant: "success" });
  } catch (err) {
    console.error("PDF error:", err);
    showToast({ title: "PDF Generation Failed", description: err.toString(), variant: "destructive" });
  }
};
window.generatePDF = window.downloadReportPdf;

// ==========================================
// 8.3 DELETE CONFIRMATION
// ==========================================
window.confirmDeleteReport = function(id, name) {
  if (confirm(`Are you sure you want to delete inspection report for ${name}?`)) {
    store.deleteReport(id);
    showToast({ title: "Report Removed", description: `Deleted ${name}`, variant: "destructive" });
    window.location.hash = '#/reports';
  }
};

// ==========================================
// 8.4 VIEW: EDIT INSPECTION & TESTING EQUIPMENT FORM
// (#/reports/:id/edit, #/new, #/reports/new)
// ==========================================
function renderReportForm(reportId = null) {
  const isEdit = Boolean(reportId);
  const existing = isEdit ? store.getReport(reportId) : null;

  const defaultValues = existing || {
    siteName: "",
    retailCode: "",
    salesArea: "Desur Retail",
    eoName: "Vasa Nagamallik",
    mstName: "Sanjay Korvi",
    testDate: new Date().toISOString().split('T')[0],
    nextTestDate: (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().split('T')[0]; })(),
    contractorName: "CLR FACILITY SERVICES",
    earthTesterMake: "Waco",
    earthTesterModel: "Digital Earth Tester",
    earthTesterSerial: "WC-395710",
    pits: [
      { pitNumber: "EP-1", location: "Canopy Column 1", equipmentConnected: "Canopy Structure", gridEarthValue: 0.9, remarks: "Ok" },
      { pitNumber: "EP-2", location: "Dispenser Island 1", equipmentConnected: "Dispenser 1 Body", gridEarthValue: 0.9, remarks: "Ok" },
      { pitNumber: "EP-3", location: "Dispenser Island 2", equipmentConnected: "Dispenser 1 Neutral", gridEarthValue: 1.8, remarks: "Ok" },
      { pitNumber: "EP-4", location: "Tank Farm Area", equipmentConnected: "Tank Body & Static Ground", gridEarthValue: 0.7, remarks: "Ok" },
      { pitNumber: "EP-5", location: "Electrical Room", equipmentConnected: "Main LT Panel Body", gridEarthValue: 2.2, remarks: "Needs Watering" }
    ]
  };

  const pitsData = existing && existing.pits && existing.pits.length > 0 ? existing.pits : defaultValues.pits;

  const html = `
    <form id="report-form" class="space-y-6 fade-in max-w-5xl mx-auto pb-16">
      <!-- Top Action Bar -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <button type="button" onclick="window.history.back()" class="p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 transition shadow-sm" title="Back">
            <i data-lucide="arrow-left" class="h-5 w-5"></i>
          </button>
          <div>
            <h1 class="text-2xl font-bold font-display text-slate-900 tracking-tight">${isEdit ? 'Edit Inspection' : 'New Inspection'}</h1>
            <p class="text-xs text-slate-400 font-medium">IS 3043 / OISD-147 Earthing Compliance</p>
          </div>
        </div>

        <button type="submit" class="inline-flex items-center justify-center gap-2 h-11 px-6 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-700 shadow-md shadow-blue-600/25 transition">
          <i data-lucide="save" class="h-4 w-4"></i>
          <span>Save Inspection</span>
        </button>
      </div>

      <!-- Main Two-Column Cards Grid -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        <!-- Left Card: Retail Outlet Details -->
        <div class="bg-white rounded-2xl border border-slate-200/90 p-6 shadow-sm space-y-4">
          <h2 class="text-base font-bold text-slate-900 font-display pb-3 border-b border-slate-100">
            Retail Outlet Details
          </h2>

          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700">Retail Outlet Name *</label>
            <input
              type="text"
              id="siteName"
              name="siteName"
              required
              value="${escapeHtml(defaultValues.siteName)}"
              placeholder="e.g. ALTRADE AGENCIES"
              class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
            />
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">ROID (Retail Code) *</label>
              <input
                type="text"
                id="retailCode"
                name="retailCode"
                required
                value="${escapeHtml(defaultValues.retailCode)}"
                placeholder="e.g. 116218"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Sales Area</label>
              <input
                type="text"
                id="salesArea"
                name="salesArea"
                value="${escapeHtml(defaultValues.salesArea || '')}"
                placeholder="e.g. Desur Retail"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Engineering Officer (EO)</label>
              <input
                type="text"
                id="eoName"
                name="eoName"
                value="${escapeHtml(defaultValues.eoName || '')}"
                placeholder="e.g. Vasa Nagamallik"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">MST Technician</label>
              <input
                type="text"
                id="mstName"
                name="mstName"
                value="${escapeHtml(defaultValues.mstName || '')}"
                placeholder="e.g. Sanjay Korvi"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Test Date</label>
              <input
                type="date"
                id="testDate"
                name="testDate"
                value="${defaultValues.testDate || ''}"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Next Retest Date (+6M)</label>
              <input
                type="date"
                id="nextTestDate"
                name="nextTestDate"
                value="${defaultValues.nextTestDate || ''}"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
          </div>
        </div>

        <!-- Right Card: Testing Equipment -->
        <div class="bg-white rounded-2xl border border-slate-200/90 p-6 shadow-sm space-y-4">
          <h2 class="text-base font-bold text-slate-900 font-display pb-3 border-b border-slate-100">
            Testing Equipment
          </h2>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Testing Contractor</label>
              <input
                type="text"
                id="contractorName"
                name="contractorName"
                value="${escapeHtml(defaultValues.contractorName || 'CLR FACILITY SERVICES')}"
                placeholder="e.g. CLR FACILITY SERVICES"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Tester Make</label>
              <input
                type="text"
                id="earthTesterMake"
                name="earthTesterMake"
                value="${escapeHtml(defaultValues.earthTesterMake || 'Waco')}"
                placeholder="e.g. Waco"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Tester Model</label>
              <input
                type="text"
                id="earthTesterModel"
                name="earthTesterModel"
                value="${escapeHtml(defaultValues.earthTesterModel || 'Digital Earth Tester')}"
                placeholder="e.g. Digital Earth Tester"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700">Serial Number</label>
              <input
                type="text"
                id="earthTesterSerial"
                name="earthTesterSerial"
                value="${escapeHtml(defaultValues.earthTesterSerial || 'WC-395710')}"
                placeholder="e.g. WC-395710"
                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none transition"
              />
            </div>
          </div>

          <!-- Calibration Standards Notice -->
          <div class="mt-4 rounded-xl bg-blue-50/60 border border-blue-100 p-3.5 text-xs text-slate-700 space-y-1">
            <div class="flex items-center gap-1.5 font-bold text-blue-900">
              <i data-lucide="shield-check" class="h-4 w-4 text-blue-600"></i>
              <span>Equipment Certification Standard</span>
            </div>
            <p class="text-[11px] text-slate-500 leading-relaxed">
              Certified four-terminal digital earth ground tester complying with IS 3043:2018 (Clause 14) and OISD-STD-147 petroleum retail installation safety requirements.
            </p>
          </div>
        </div>
      </div>

      <!-- Bottom Card: Earth Pit Measurements -->
      <div class="bg-white rounded-2xl border border-slate-200/90 p-6 shadow-sm space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <div>
            <h2 class="text-base font-bold text-slate-900 font-display">Earth Pit Measurements</h2>
            <p class="text-xs text-slate-500">IS 3043:2018 maximum permissible grid earth resistance: &le; 2.0 &Omega;</p>
          </div>
          <div class="flex items-center gap-2">
            <span id="form-pits-badge" class="text-xs font-bold px-3 py-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200 w-fit">
              ${pitsData.length} Grounding Electrodes
            </span>
            <button type="button" onclick="addFormPit()" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-sm transition">
              <i data-lucide="plus" class="h-3.5 w-3.5"></i>
              <span>+ Add Earth Pit</span>
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs text-left">
            <thead>
              <tr class="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 uppercase tracking-wider text-[10px]">
                <th class="py-2.5 px-3">Pit No.</th>
                <th class="py-2.5 px-3">Connected Equipment</th>
                <th class="py-2.5 px-3">Location</th>
                <th class="py-2.5 px-3 w-36">Resistance (&Omega;)</th>
                <th class="py-2.5 px-3">Status</th>
                <th class="py-2.5 px-3">Action Remarks</th>
                <th class="py-2.5 px-3 text-center w-16">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100" id="form-pits-tbody">
              ${pitsData.map((p, idx) => {
                const val = parseFloat(p.gridEarthValue) || 0;
                const isHigh = val > 2.0;
                return `
                  <tr class="hover:bg-slate-50/70 transition">
                    <td class="py-3 px-3">
                      <input type="text" name="pitNumber_${idx}" value="${escapeHtml(p.pitNumber || `EP-${idx+1}`)}" class="w-16 h-8 px-2 rounded-lg border border-slate-200 font-mono font-bold text-slate-800 text-xs bg-slate-50" />
                    </td>
                    <td class="py-3 px-3">
                      <input type="text" name="equipmentConnected_${idx}" value="${escapeHtml(p.equipmentConnected || '')}" placeholder="Connected Equipment" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-800" />
                    </td>
                    <td class="py-3 px-3">
                      <input type="text" name="location_${idx}" value="${escapeHtml(p.location || '')}" placeholder="Location" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-800" />
                    </td>
                    <td class="py-3 px-3">
                      <div class="relative">
                        <input
                          type="number"
                          step="0.1"
                          name="gridEarthValue_${idx}"
                          id="pit-val-${idx}"
                          value="${val.toFixed(1)}"
                          oninput="updateFormPitStatus(${idx})"
                          class="w-full h-8 pl-2.5 pr-6 rounded-lg border ${isHigh ? 'border-orange-400 bg-orange-50 font-bold text-orange-950' : 'border-slate-200 text-slate-800 font-bold'} text-xs font-mono"
                        />
                        <span class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 font-semibold">&Omega;</span>
                      </div>
                    </td>
                    <td class="py-3 px-3 whitespace-nowrap" id="pit-status-${idx}">
                      <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${isHigh ? 'bg-orange-100 text-orange-800 border border-orange-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'}">
                        ${isHigh ? '⚠️ HIGH (> 2.0Ω)' : '✅ PASSED (OK)'}
                      </span>
                    </td>
                    <td class="py-3 px-3">
                      <input type="text" name="remarks_${idx}" value="${escapeHtml(p.remarks || '')}" placeholder="e.g. Normal or Watering needed" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-700" />
                    </td>
                    <td class="py-3 px-3 text-center">
                      <button type="button" onclick="removeFormPit(${idx})" class="p-1.5 rounded-lg border border-rose-200 text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition" title="Remove Earth Pit">
                        <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
                      </button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Bottom Save / Cancel -->
      <div class="flex items-center justify-end gap-3 pt-2">
        <button type="button" onclick="window.history.back()" class="px-5 py-2.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 transition">
          Cancel
        </button>
        <button type="submit" class="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 text-xs font-bold text-white hover:bg-blue-700 shadow-md shadow-blue-600/25 transition">
          <i data-lucide="save" class="h-4 w-4"></i>
          <span>Save Inspection</span>
        </button>
      </div>
    </form>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();

  // Next Retest Date auto calculation (+6M)
  const testDateEl = document.getElementById('testDate');
  const nextTestDateEl = document.getElementById('nextTestDate');
  if (testDateEl && nextTestDateEl) {
    testDateEl.addEventListener('change', (e) => {
      if (e.target.value) {
        try {
          const d = new Date(e.target.value);
          d.setMonth(d.getMonth() + 6);
          nextTestDateEl.value = d.toISOString().split('T')[0];
        } catch(err) {}
      }
    });
  }


  // Sync in-memory pits for dynamic Add / Remove
  window.formPitsData = [...pitsData];

  window.syncFormPitsFromDom = function() {
    const rows = document.querySelectorAll('#form-pits-tbody tr');
    const synced = [];
    rows.forEach((row, i) => {
      const pitNum = row.querySelector(`[name^="pitNumber_"]`);
      const eq = row.querySelector(`[name^="equipmentConnected_"]`);
      const loc = row.querySelector(`[name^="location_"]`);
      const val = row.querySelector(`[name^="gridEarthValue_"]`);
      const rem = row.querySelector(`[name^="remarks_"]`);
      if (pitNum) {
        synced.push({
          pitNumber: pitNum.value,
          equipmentConnected: eq ? eq.value : '',
          location: loc ? loc.value : '',
          gridEarthValue: parseFloat(val ? val.value : 1.0) || 0.0,
          remarks: rem ? rem.value : ''
        });
      }
    });
    window.formPitsData = synced;
    return synced;
  };

  window.renderFormPitsTable = function() {
    const tbody = document.getElementById('form-pits-tbody');
    const badge = document.getElementById('form-pits-badge');
    if (!tbody) return;
    if (badge) badge.innerText = `${window.formPitsData.length} Grounding Electrodes`;

    tbody.innerHTML = window.formPitsData.map((p, idx) => {
      const val = parseFloat(p.gridEarthValue) || 0;
      const isHigh = val > 2.0;
      return `
        <tr class="hover:bg-slate-50/70 transition">
          <td class="py-3 px-3">
            <input type="text" name="pitNumber_${idx}" value="${escapeHtml(p.pitNumber || `EP-${idx+1}`)}" class="w-16 h-8 px-2 rounded-lg border border-slate-200 font-mono font-bold text-slate-800 text-xs bg-slate-50" />
          </td>
          <td class="py-3 px-3">
            <input type="text" name="equipmentConnected_${idx}" value="${escapeHtml(p.equipmentConnected || '')}" placeholder="Connected Equipment" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-800" />
          </td>
          <td class="py-3 px-3">
            <input type="text" name="location_${idx}" value="${escapeHtml(p.location || '')}" placeholder="Location" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-800" />
          </td>
          <td class="py-3 px-3">
            <div class="relative">
              <input
                type="number"
                step="0.1"
                name="gridEarthValue_${idx}"
                id="pit-val-${idx}"
                value="${val.toFixed(1)}"
                oninput="updateFormPitStatus(${idx})"
                class="w-full h-8 pl-2.5 pr-6 rounded-lg border ${isHigh ? 'border-orange-400 bg-orange-50 font-bold text-orange-950' : 'border-slate-200 text-slate-800 font-bold'} text-xs font-mono"
              />
              <span class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 font-semibold">&Omega;</span>
            </div>
          </td>
          <td class="py-3 px-3 whitespace-nowrap" id="pit-status-${idx}">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${isHigh ? 'bg-orange-100 text-orange-800 border border-orange-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'}">
              ${isHigh ? '⚠️ HIGH (> 2.0Ω)' : '✅ PASSED (OK)'}
            </span>
          </td>
          <td class="py-3 px-3">
            <input type="text" name="remarks_${idx}" value="${escapeHtml(p.remarks || '')}" placeholder="e.g. Normal or Watering needed" class="w-full h-8 px-2.5 rounded-lg border border-slate-200 text-xs text-slate-700" />
          </td>
          <td class="py-3 px-3 text-center">
            <button type="button" onclick="removeFormPit(${idx})" class="p-1.5 rounded-lg border border-rose-200 text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition" title="Remove Earth Pit">
              <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
    lucide.createIcons();
  };

  window.addFormPit = function() {
    window.syncFormPitsFromDom();
    const nextNum = window.formPitsData.length + 1;
    window.formPitsData.push({
      pitNumber: `EP-${nextNum}`,
      equipmentConnected: `Earth Pit ${nextNum}`,
      location: "Station Yard",
      gridEarthValue: 1.0,
      remarks: "Ok"
    });
    window.renderFormPitsTable();
    showToast({ title: "Earth Pit Added", description: `Added EP-${nextNum}`, variant: "default" });
  };

  window.removeFormPit = function(idx) {
    window.syncFormPitsFromDom();
    if (window.formPitsData.length <= 1) {
      showToast({ title: "Cannot Delete", description: "At least 1 earth pit is required.", variant: "destructive" });
      return;
    }
    const pit = window.formPitsData[idx];
    if (confirm(`Are you sure you want to remove ${pit.pitNumber}?`)) {
      window.formPitsData.splice(idx, 1);
      window.renderFormPitsTable();
      showToast({ title: "Earth Pit Removed", description: `Removed ${pit.pitNumber}`, variant: "default" });
    }
  };

  // Live Pit status updater
  window.updateFormPitStatus = function(idx) {
    const input = document.getElementById(`pit-val-${idx}`);
    const statusEl = document.getElementById(`pit-status-${idx}`);
    if (!input || !statusEl) return;
    const val = parseFloat(input.value) || 0;
    const isHigh = val > 2.0;
    statusEl.innerHTML = `
      <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${isHigh ? 'bg-orange-100 text-orange-800 border border-orange-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'}">
        ${isHigh ? '⚠️ HIGH (> 2.0Ω)' : '✅ PASSED (OK)'}
      </span>
    `;
    if (isHigh) {
      input.classList.add('border-orange-400', 'bg-orange-50', 'text-orange-950');
      input.classList.remove('border-slate-200', 'text-slate-800');
    } else {
      input.classList.remove('border-orange-400', 'bg-orange-50', 'text-orange-950');
      input.classList.add('border-slate-200', 'text-slate-800');
    }
  };

  // Form submit handler
  document.getElementById('report-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    // Gather all dynamically present pit values
    const updatedPits = window.syncFormPitsFromDom();

    const reportCode = document.getElementById('retailCode').value.trim();
    const updated = {
      ...(existing || {}),
      id: isEdit ? existing.id : `ro-${reportCode}`,
      siteName: document.getElementById('siteName').value.trim(),
      retailCode: reportCode,
      salesArea: document.getElementById('salesArea').value.trim(),
      eoName: document.getElementById('eoName').value.trim(),
      mstName: document.getElementById('mstName').value.trim(),
      testDate: document.getElementById('testDate').value,
      nextTestDate: document.getElementById('nextTestDate').value,
      contractorName: document.getElementById('contractorName').value.trim() || "CLR FACILITY SERVICES",
      earthTesterMake: document.getElementById('earthTesterMake').value.trim() || "Waco",
      earthTesterModel: document.getElementById('earthTesterModel').value.trim() || "Digital Earth Tester",
      earthTesterSerial: document.getElementById('earthTesterSerial').value.trim() || "WC-395710",
      pits: updatedPits.length > 0 ? updatedPits : (existing ? existing.pits : defaultValues.pits)
    };

    const saved = await store.saveReport(updated);
    showToast({ title: "Inspection Saved", description: `Saved details for ${saved.siteName}`, variant: "success" });
    window.location.hash = `#/reports/${saved.id}`;
  });
}


// ==========================================
// 8.5 VIEW: ONBOARD EXCEL (#/onboard)
// ==========================================
function renderOnboard() {
  const html = `
    <div class="space-y-6 fade-in max-w-xl mx-auto py-12 text-center">
      <div class="w-16 h-16 rounded-full mx-auto bg-blue-50 text-blue-600 flex items-center justify-center">
        <i data-lucide="upload-cloud" class="h-8 w-8"></i>
      </div>
      <div>
        <h1 class="text-2xl font-bold text-slate-900 font-display">Onboard Retail Outlets</h1>
        <p class="text-xs text-slate-500 mt-1">Upload RetailOutlet_Details.xlsx to populate stations and earth pits.</p>
      </div>

      <div class="bg-white rounded-2xl border-2 border-dashed border-slate-300 p-8 space-y-4">
        <label class="cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-xs font-bold text-white hover:bg-blue-700 shadow transition">
          <i data-lucide="file-spreadsheet" class="h-4 w-4"></i>
          <span>Choose Excel File</span>
          <input type="file" id="excel-onboard-input" accept=".xlsx, .xls" class="hidden" />
        </label>
        <p class="text-[11px] text-slate-400">Supports BPCL RetailOutlet_Details.xlsx format</p>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();

  const input = document.getElementById('excel-onboard-input');
  if (input) {
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleExcelUpload(file);
    });
  }
}

function handleExcelUpload(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      if (!json || json.length === 0) throw new Error("Empty spreadsheet");

      const newReports = json.map((row, idx) => {
        const roid = String(row["ROID"] || row["Retail Code"] || `100${idx}`);
        const site = row["Retail Outlet"] || row["Site Name"] || `RO ${roid}`;
        const sa = row["Sales Area"] || "General Retail";
        const eo = row["EO Name"] || "Territory Officer";
        const mst = row["MST Name"] || "Technician";

        return {
          id: `ro-${roid}`,
          siteName: site,
          retailCode: roid,
          location: sa,
          salesArea: sa,
          eoName: eo,
          mstName: mst,
          testDate: new Date().toISOString().split('T')[0],
          nextTestDate: (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().split('T')[0]; })(),
          contractorName: "CLR FACILITY SERVICES",
          earthTesterMake: "Waco",
          earthTesterSerial: "WC-354672",
          pits: [
            { pitNumber: "EP-1", location: "Canopy", equipmentConnected: "Canopy Structure", gridEarthValue: 1.2, remarks: "Ok" },
            { pitNumber: "EP-2", location: "Dispenser 1", equipmentConnected: "Dispenser 1 Body", gridEarthValue: 1.4, remarks: "Ok" },
            { pitNumber: "EP-3", location: "Dispenser 2", equipmentConnected: "Dispenser 2 Neutral", gridEarthValue: 1.1, remarks: "Ok" },
            { pitNumber: "EP-4", location: "Tank Farm", equipmentConnected: "Tank Farm Static", gridEarthValue: 1.3, remarks: "Ok" },
            { pitNumber: "EP-5", location: "LT Room", equipmentConnected: "Main LT Panel", gridEarthValue: 0.9, remarks: "Ok" }
          ]
        };
      });

      await store.onboardReports(newReports);
      showToast({ title: "Onboarding Complete", description: `Imported ${newReports.length} retail outlets.`, variant: "success" });
      window.location.hash = '#/';
    } catch(err) {
      showToast({ title: "Upload Failed", description: "Could not parse Excel file.", variant: "destructive" });
    }
  };
  reader.readAsArrayBuffer(file);
}


// ==========================================
// 9. VIEW 5: GOOGLE SYNC HUB (#/google-sync)
// ==========================================
function renderGoogleSyncView() {
  const currentUrl = getGoogleWebhookUrl();
  const logs = getSyncLogs();
  const queue = getPendingQueue();

  const html = `
    <div class="space-y-6 fade-in max-w-4xl mx-auto pb-16">
      <!-- Header -->
      <div class="flex items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-2xl sm:text-3xl font-bold text-slate-900 font-display tracking-tight">Google Sheets & Drive Sync</h1>
            <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
              Live Cloud Bridge
            </span>
          </div>
          <p class="text-xs text-slate-500 mt-1">Automatic inspection push to Google Sheets & photo uploads to Google Drive.</p>
        </div>

        <button onclick="testGoogleConnection()" class="inline-flex h-9 items-center justify-center rounded-lg bg-blue-600 text-white px-3.5 text-xs font-bold hover:bg-blue-700 shadow transition gap-1.5">
          <i data-lucide="zap" class="h-4 w-4 text-amber-300"></i>
          <span>Test Connection</span>
        </button>
      </div>

      <!-- Connection Status Card -->
      <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center gap-2.5">
            <div class="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <i data-lucide="cloud" class="h-5 w-5"></i>
            </div>
            <div>
              <h2 class="text-sm font-bold text-slate-900">Master Google Apps Script Webhook</h2>
              <p class="text-[11px] text-slate-400">Centrally locked production endpoint &bull; All submissions auto-push here</p>
            </div>
          </div>
          <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5">
            <i data-lucide="lock" class="h-3 w-3"></i>
            <span>Protected &bull; Active</span>
          </span>
        </div>

        <div class="space-y-2.5">
          <div class="flex flex-col sm:flex-row gap-2">
            <div class="relative flex-1">
              <i data-lucide="lock" class="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400"></i>
              <input 
                type="url" 
                id="google-webhook-input" 
                readonly 
                disabled
                value="${escapeHtml(MASTER_GAS_WEBHOOK_URL)}" 
                class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 bg-slate-100 text-slate-700 font-mono select-all cursor-not-allowed"
              />
            </div>
            <div class="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold shrink-0 shadow-xs">
              <i data-lucide="shield-check" class="h-4 w-4 text-emerald-600"></i>
              <span>Locked by Administrator</span>
            </div>
          </div>
          <p class="text-[11px] text-slate-500 flex items-center gap-1.5">
            <i data-lucide="info" class="h-3.5 w-3.5 text-blue-600 shrink-0"></i>
            <span>This script endpoint is permanent. Whosoever accesses the application cannot modify or tamper with this URL.</span>
          </p>
          <p class="text-[11px] text-slate-400">Target Sheet: <strong>BPCL_Earthing_Testing_Records</strong> &bull; Target Drive Folder: <strong>BPCL_Earthing_Photos</strong></p>
        </div>
      </div>

      <!-- 1-Minute Setup Guide & Copy Script Accordion -->
      <div class="bg-gradient-to-br from-slate-900 to-blue-950 text-white rounded-xl p-5 shadow-sm space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <i data-lucide="file-code" class="h-5 w-5 text-amber-400"></i>
            <div>
              <h3 class="text-sm font-bold font-display">Deploy to Your Google Account (1-Minute Guide)</h3>
              <p class="text-xs text-slate-300">Zero-cost Google Apps Script to write Sheet rows and upload Drive photos</p>
            </div>
          </div>
          <button onclick="copyAppsScriptCode()" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-xs font-bold text-white transition flex items-center gap-1.5 shadow">
            <i data-lucide="copy" class="h-3.5 w-3.5"></i>
            <span>Copy Code.gs</span>
          </button>
        </div>

        <div class="bg-black/30 rounded-lg p-3 text-xs space-y-1 text-slate-200">
          <p class="font-semibold text-amber-300 mb-1">Quick Steps:</p>
          <p>1. Open Google Sheets at <a href="https://sheets.new" target="_blank" class="text-blue-400 underline font-mono">sheets.new</a></p>
          <p>2. Click <strong>Extensions &gt; Apps Script</strong></p>
          <p>3. Paste the copied code into <strong>Code.gs</strong></p>
          <p>4. Click <strong>Deploy &gt; New deployment &gt; Select type: Web app</strong></p>
          <p>5. Set Execute as: <strong>"Me"</strong> and Who has access: <strong>"Anyone"</strong></p>
          <p>6. Click <strong>Deploy</strong> and paste the URL into the box above!</p>
        </div>
      </div>

      <!-- Sync Activity Logs Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden space-y-0">
        <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <i data-lucide="history" class="h-4 w-4 text-blue-600"></i>
            <span>Recent Sync Logs (${logs.length})</span>
          </h3>
          ${queue.length > 0 ? `
            <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800">
              ${queue.length} Pending Offline
            </span>
          ` : ''}
        </div>

        <div class="max-h-64 overflow-y-auto divide-y divide-slate-100 text-xs">
          ${logs.length === 0 ? `
            <div class="p-8 text-center text-slate-400">No sync activities recorded yet. When an MST submits an inspection, it will appear here.</div>
          ` : logs.map(l => `
            <div class="p-3.5 flex items-center justify-between hover:bg-slate-50 transition">
              <div class="space-y-0.5">
                <div class="flex items-center gap-2">
                  <span class="font-bold text-slate-900">${escapeHtml(l.siteName || 'Retail Outlet')}</span>
                  ${l.roid ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-50 text-blue-800">ROID: ${escapeHtml(l.roid)}</span>` : ''}
                  <span class="px-2 py-0.5 rounded text-[10px] font-bold ${l.status.includes('Synced') ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${escapeHtml(l.status)}</span>
                </div>
                <p class="text-[11px] text-slate-400">${escapeHtml(l.details)} &bull; ${l.photoCount || 0} Drive photos</p>
              </div>
              <span class="text-[10px] font-mono text-slate-400">${escapeHtml(l.timestamp)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  document.getElementById('app-content').innerHTML = html;
  lucide.createIcons();
}

window.saveWebhookSettings = () => {
  showToast({ title: "Settings Locked", description: "The Master Google Webhook URL is permanently locked by the administrator.", variant: "default" });
};

window.testGoogleConnection = async () => {
  const url = MASTER_GAS_WEBHOOK_URL;
  showToast({ title: "Testing Connection", description: "Pinging Master Google Apps Script endpoint...", variant: "default" });

  try {
    await fetch(url, { 
      method: "POST", 
      mode: "no-cors", 
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "ping", timestamp: new Date().toISOString() }) 
    });
    showToast({ title: "Connection Ping Sent", description: "Ping request successfully delivered to master Google Apps Script endpoint.", variant: "success" });
  } catch(e) {
    showToast({ title: "Connection Notice", description: "If 403 occurs in Apps Script, ensure Deployment access is set to 'Anyone'.", variant: "default" });
  }
};

window.copyAppsScriptCode = async () => {
  try {
    const res = await fetch('./google_apps_script.js');
    let code = '';
    if (res.ok) {
      code = await res.text();
    } else {
      code = `// Please open google_apps_script.js in your project directory to copy Code.gs`;
    }
    await navigator.clipboard.writeText(code);
    showToast({ title: "Code.gs Copied", description: "Paste into Google Apps Script editor and click Deploy.", variant: "success" });
  } catch(e) {
    showToast({ title: "Copy Failed", description: "You can find google_apps_script.js in the project root.", variant: "default" });
  }
};

// ==========================================
// 10. ROUTING & EVENT HANDLERS
// ==========================================
function handleRouting() {
  const hash = window.location.hash || '#/';
  const cleanHash = hash.replace(/^#/, '');

  // Highlight exact sidebar menus (5 items)
  const navMap = {
    '/update-test': 'nav-update-test',
    '/': 'nav-dashboard',
    '/reports': 'nav-directory',
    '/hsse-audit': 'nav-hsse-audit',
    '/google-sync': 'nav-google-sync'
  };

  document.querySelectorAll('.nav-item').forEach(el => {
    el.className = 'nav-item flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors text-slate-300 hover:bg-slate-800 hover:text-white';
  });

  const activeNavId = navMap[cleanHash] || (cleanHash.startsWith('/reports') ? 'nav-directory' : null);
  if (activeNavId) {
    const activeEl = document.getElementById(activeNavId);
    if (activeEl && activeNavId !== 'nav-google-sync') {
      activeEl.className = 'nav-item flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-bold transition-colors bg-blue-600 text-white shadow-md shadow-blue-900/20';
    }
  }

  // Update mobile bottom nav highlights
  document.querySelectorAll('.mobile-nav').forEach(el => {
    const route = el.getAttribute('data-route');
    if (route === cleanHash || (route === '/reports' && cleanHash.startsWith('/reports'))) {
      el.classList.add('text-blue-600', 'font-bold');
      el.classList.remove('text-slate-600');
    } else if (route !== '/google-sync') {
      el.classList.remove('text-blue-600', 'font-bold');
      el.classList.add('text-slate-600');
    }
  });

  // Views dispatch
  if (cleanHash === '/update-test' || cleanHash === '/field') {
    renderUpdateTestView();
  } else if (cleanHash === '/' || cleanHash === '') {
    renderDashboard();
  } else if (cleanHash === '/reports') {
    renderReports();
  } else if (cleanHash === '/hsse-audit') {
    renderHsseAuditView();
  } else if (cleanHash === '/google-sync') {
    renderGoogleSyncView();
  } else if (cleanHash === '/onboard') {
    renderOnboard();
  } else if (cleanHash === '/new' || cleanHash === '/reports/new') {
    renderReportForm(null);
  } else if (cleanHash.startsWith('/reports/') && cleanHash.endsWith('/edit')) {
    renderReportForm(cleanHash.split('/')[2]);
  } else if (cleanHash.startsWith('/reports/')) {
    renderReportDetail(cleanHash.split('/')[2]);
  } else {
    renderDashboard();
  }
}

// Global App Initialization
window.addEventListener('DOMContentLoaded', async () => {
  await store.init();
  handleRouting();
  window.addEventListener('hashchange', handleRouting);
  updatePendingBadge();

  // PWA Modal button listeners
  const confirmInstallBtn = document.getElementById('btn-pwa-confirm-install');
  const dismissBtn = document.getElementById('btn-pwa-dismiss');
  const sidebarInstallBtn = document.getElementById('btn-install-sidebar');

  if (confirmInstallBtn) {
    confirmInstallBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt = null;
      }
      hidePwaInstallModal();
    });
  }
  if (dismissBtn) dismissBtn.addEventListener('click', hidePwaInstallModal);
  if (sidebarInstallBtn) sidebarInstallBtn.addEventListener('click', showPwaInstallModal);
});
