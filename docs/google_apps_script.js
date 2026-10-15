/**
 * ====================================================================
 * BPCL EARTHING TESTING APP - GOOGLE APPS SCRIPT WEBHOOK (V5.2)
 * Live Google Drive Cloud Database Backend + Google Sheets Archive
 * Supports Unlimited Earth Pits (1 to 20+) & Google Drive Photo Archiving
 * Standard: IS 3043:2018 & OISD-STD-147
 * Contractor: CLR FACILITY SERVICES
 * ====================================================================
 *
 * HOW IT WORKS (V5.2):
 * 1. Google Drive holds the primary live database file: "bpcl_live_database.json"
 * 2. Its Drive File ID is cached permanently in PropertiesService for instant 0-latency access.
 * 3. When ANY user saves on laptop or phone:
 *    - The inspection & all pits are written directly to Google Drive live DB
 *    - Photos are saved into station subfolder: "[RO Code] - [RO Name]"
 *    - A backup row is appended to Google Sheet "Earthing_Inspections"
 * 4. When ANY other device opens or syncs:
 *    - doGet reads the live DB directly from Google Drive
 *    - All 12+ earth pits, new test dates, compliance statuses sync to all users!
 *
 * ONE-TIME DEPLOYMENT INSTRUCTIONS:
 * 1. Open https://script.google.com -> open your BPCL project.
 * 2. Press Ctrl+A to select everything, then paste this entire code.
 * 3. Click Deploy > Manage deployments > Edit (pencil icon).
 * 4. Version: select "New version" (description: "v5.2 Google Drive Live Database").
 * 5. Execute as: "Me"
 * 6. Who has access: "Anyone"   <--- MANDATORY!
 * 7. Click "Deploy".
 * ====================================================================
 */

const SPREADSHEET_NAME = "BPCL_Earthing_Testing_Records";
const SHEET_NAME = "Earthing_Inspections";
const DRIVE_FOLDER_NAME = "BPCL_Earthing_Photos";
const LIVE_DB_FILENAME = "bpcl_live_database.json";

// ==========================================
// 1. GET HANDLER (Live Data Query & Health)
// ==========================================
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).toLowerCase() : "";
    const roid = (e && e.parameter && (e.parameter.roid || e.parameter.code)) ? String(e.parameter.roid || e.parameter.code).trim() : "";

    // A. Query live reports from Google Drive Live Database
    if (action === "get_reports" || action === "sync" || action === "reports" || action === "live") {
      const db = getLiveDatabase();
      let reports = db.reports || [];
      if (roid) {
        reports = reports.filter(function(r) {
          return String(r.retailCode || r.id).trim() === roid;
        });
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        version: "5.2",
        source: "google_drive_live_db",
        count: reports.length,
        reports: reports,
        updatedAt: db.updatedAt || new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // B. Debug diagnostic endpoint
    if (action === "debug") {
      const db = getLiveDatabase();
      const props = PropertiesService.getScriptProperties();
      const fileId = props.getProperty("LIVE_DB_FILE_ID");
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        version: "5.2",
        liveFileId: fileId,
        cachedInProperties: !!fileId,
        reportsCount: (db.reports || []).length,
        lastUpdated: db.updatedAt,
        folderName: DRIVE_FOLDER_NAME
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // C. Default Health Check
    return ContentService.createTextOutput(JSON.stringify({
      status: "active",
      version: "5.2",
      service: "BPCL Earthing Testing Google Drive Live DB Webhook",
      message: "Google Drive Live Database is active and operational for all devices!",
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("doGet Error: " + err.toString());
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      version: "5.2",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 2. POST HANDLER (Save Inspection & Drive Photos)
// ==========================================
function doPost(e) {
  try {
    let data = {};
    if (e && e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch(pe) {
        data = {};
      }
    }

    // A. Health check ping
    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        version: "5.2",
        message: "Pong! BPCL Earthing Google Drive Live DB is active.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // B. Query via POST
    if (data.action === "get_reports" || data.action === "sync") {
      const db = getLiveDatabase();
      let reports = db.reports || [];
      if (data.roid) {
        reports = reports.filter(function(r) {
          return String(r.retailCode || r.id).trim() === String(data.roid).trim();
        });
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        version: "5.2",
        source: "google_drive_live_db",
        count: reports.length,
        reports: reports,
        updatedAt: db.updatedAt || new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // C. Bulk sync / Seed database from client
    if (data.action === "bulk_sync" || data.action === "seed_database") {
      const incomingList = data.reports || [];
      if (Array.isArray(incomingList) && incomingList.length > 0) {
        const db = getLiveDatabase();
        const map = new Map();
        (db.reports || []).forEach(function(r) {
          map.set(String(r.retailCode || r.id), r);
        });
        incomingList.forEach(function(r) {
          map.set(String(r.retailCode || r.id), r);
        });
        db.reports = Array.from(map.values());
        db.updatedAt = new Date().toISOString();
        saveLiveDatabase(db);
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          version: "5.2",
          message: "Successfully seeded/updated Google Drive Live Database.",
          totalCount: db.reports.length
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // D. SAVE INSPECTION TO GOOGLE DRIVE LIVE DB & GOOGLE SHEETS
    const rootFolder = getOrCreateFolder(DRIVE_FOLDER_NAME);
    const roCode = (data.retailCode || data.roid || "RO").toString().trim();
    const roName = (data.siteName || "Retail Outlet").toString().trim();
    const subfolderName = roCode + " - " + roName;
    const stationFolder = getOrCreateSubfolder(rootFolder, subfolderName);

    // Save photos into station subfolder
    const photoUrls = {};
    if (data.photos && Array.isArray(data.photos)) {
      data.photos.forEach(function(item) {
        const b64 = item.base64 || item.dataUrl || item.data || "";
        const pitName = item.pit || "EP";
        if (b64) {
          try {
            const rawBase64 = b64.replace(/^data:image\/\w+;base64,/, "");
            const bytes = Utilities.base64Decode(rawBase64);
            const fileName = roCode + "_" + pitName + "_" + Utilities.formatDate(new Date(), "GMT+5:30", "yyyyMMdd_HHmmss") + ".jpg";
            const blob = Utilities.newBlob(bytes, "image/jpeg", fileName);
            const file = stationFolder.createFile(blob);
            try {
              file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            } catch(shareErr) {}
            photoUrls[pitName] = file.getUrl();
          } catch(photoErr) {
            Logger.log("Error saving photo: " + photoErr.toString());
          }
        }
      });
    }

    // Map pits (supports 12+ earth pits)
    const pits = data.pits || [];
    const enrichedPits = pits.map(function(p, idx) {
      const pitNum = p.pitNumber || p.num || ("EP-" + (idx + 1));
      const val = parseFloat(p.gridEarthValue !== undefined ? p.gridEarthValue : p.val) || 0.0;
      return {
        id: p.id || ("ro-" + roCode + "-p" + (idx + 1)),
        reportId: p.reportId || ("ro-" + roCode),
        pitNumber: pitNum,
        location: p.location || "Station Yard",
        equipmentConnected: p.equipmentConnected || ("Earth Pit " + (idx + 1)),
        gridEarthValue: val,
        remarks: p.remarks || (val <= 2.0 ? "Ok" : "Watering Required"),
        photoUrl: photoUrls[pitNum] || p.photoUrl || "",
        sortOrder: p.sortOrder !== undefined ? p.sortOrder : idx
      };
    });

    let maxResistance = 0;
    let hasHigh = false;
    const summaryParts = [];
    const pitMap = {};
    enrichedPits.forEach(function(p) {
      if (p.gridEarthValue > 2.0) hasHigh = true;
      if (p.gridEarthValue > maxResistance) maxResistance = p.gridEarthValue;
      pitMap[p.pitNumber] = p;
      summaryParts.push(p.pitNumber + ": " + p.gridEarthValue + "Ω (" + (p.gridEarthValue <= 2.0 ? "PASS" : "HIGH") + ")");
    });

    function getPit(epNum) {
      if (pitMap[epNum]) return pitMap[epNum];
      const digit = epNum.replace(/[^0-9]/g, '');
      for (const k in pitMap) {
        if (k.replace(/[^0-9]/g, '') === digit) return pitMap[k];
      }
      return { gridEarthValue: "", remarks: "", photoUrl: "" };
    }

    const nowIso = new Date().toISOString();
    const nowStr = Utilities.formatDate(new Date(), "GMT+5:30", "dd-MM-yyyy HH:mm:ss");

    // Retest status & Action
    let retestStatus = data.retestStatus || "VALID";
    let actionToBeTaken = data.actionToBeTaken || (hasHigh ? "Watering & Treatment Required" : "All Compliant");
    if (!data.retestStatus && data.nextTestDate) {
      try {
        const parts = data.nextTestDate.split('-');
        if (parts.length === 3) {
          const nDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          const curDate = new Date(); curDate.setHours(0, 0, 0, 0); nDate.setHours(0, 0, 0, 0);
          const diffDays = Math.ceil((nDate.getTime() - curDate.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays < 0) {
            retestStatus = "OVERDUE (" + Math.abs(diffDays) + "d)";
            actionToBeTaken = hasHigh ? "CRITICAL: Retest & Watering Required" : "RETEST DUE: Schedule MST Inspection";
          } else if (diffDays === 0) {
            retestStatus = "DUE TODAY";
            actionToBeTaken = "RETEST DUE: Schedule MST Inspection";
          } else if (diffDays <= 30) {
            retestStatus = "UPCOMING RETEST (" + diffDays + "d)";
            actionToBeTaken = hasHigh ? "HIGH: Watering Needed (>2.0Ω)" : "UPCOMING: Plan Visit";
          } else {
            retestStatus = "VALID (" + diffDays + "d)";
            actionToBeTaken = hasHigh ? "HIGH: Watering Needed (>2.0Ω)" : "ALL COMPLIANT: Certified Valid";
          }
        }
      } catch(e) {}
    }

    // 1. UPDATE GOOGLE DRIVE LIVE DATABASE (Primary live storage)
    const reportObj = {
      id: "ro-" + roCode,
      retailCode: roCode,
      siteName: roName,
      salesArea: data.salesArea || "",
      eoName: data.eoName || "",
      mstName: data.mstName || "",
      location: data.salesArea || "",
      testDate: data.testDate || "",
      nextTestDate: data.nextTestDate || "",
      retestStatus: retestStatus,
      actionToBeTaken: actionToBeTaken,
      contractorName: data.contractorName || "CLR FACILITY SERVICES",
      technicianName: data.mstName || "",
      earthTesterMake: data.earthTesterMake || "Waco",
      earthTesterModel: "Digital Earth Tester",
      earthTesterSerial: data.earthTesterSerial || "WC-354672",
      calibDate: "2025-11-15",
      createdAt: data.createdAt || nowIso,
      updatedAt: nowIso,
      remarks: data.remarks || "",
      pits: enrichedPits,
      driveFolderUrl: stationFolder.getUrl()
    };

    const db = getLiveDatabase();
    if (!Array.isArray(db.reports)) db.reports = [];
    const existingIndex = db.reports.findIndex(function(r) {
      return String(r.retailCode || r.id).trim() === roCode;
    });

    if (existingIndex !== -1) {
      db.reports[existingIndex] = Object.assign({}, db.reports[existingIndex], reportObj);
    } else {
      db.reports.push(reportObj);
    }
    db.updatedAt = nowIso;
    saveLiveDatabase(db);

    // 2. BACKUP TO GOOGLE SHEET
    try {
      const ss = getOrCreateSpreadsheet();
      let sheet = ss.getSheetByName(SHEET_NAME);
      const baseHeaders = [
        "Timestamp", "ROID", "Retail Outlet", "Sales Area", "EO Name", "MST Name",
        "Test Date", "Next Due Date", "Retest Status", "Action to be Taken", "Contractor", "Instrument Make & Serial",
        "EP-1 Value (Ω)", "EP-1 Status", "EP-1 Photo Link",
        "EP-2 Value (Ω)", "EP-2 Status", "EP-2 Photo Link",
        "EP-3 Value (Ω)", "EP-3 Status", "EP-3 Photo Link",
        "EP-4 Value (Ω)", "EP-4 Status", "EP-4 Photo Link",
        "EP-5 Value (Ω)", "EP-5 Status", "EP-5 Photo Link",
        "All Pits Summary", "Max Resistance (Ω)", "Overall Compliance", "Drive Station Folder", "Remarks",
        "Pits Data JSON"
      ];

      if (!sheet) {
        sheet = ss.insertSheet(SHEET_NAME);
        sheet.appendRow(baseHeaders);
        sheet.getRange(1, 1, 1, baseHeaders.length).setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
        sheet.setFrozenRows(1);
      } else {
        const lastCol = sheet.getLastColumn();
        if (lastCol > 0) {
          const curHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
          if (!curHeaders.includes("Pits Data JSON")) {
            sheet.getRange(1, lastCol + 1).setValue("Pits Data JSON").setFontWeight("bold").setBackground("#003366").setFontColor("#ffffff");
          }
        }
      }

      const ep1 = getPit("EP-1"), ep2 = getPit("EP-2"), ep3 = getPit("EP-3"), ep4 = getPit("EP-4"), ep5 = getPit("EP-5");
      const pitsJson = JSON.stringify(enrichedPits);

      const row = [
        nowStr, roCode, roName, data.salesArea || "", data.eoName || "", data.mstName || "",
        data.testDate || "", data.nextTestDate || "", retestStatus, actionToBeTaken,
        data.contractorName || "CLR FACILITY SERVICES",
        (data.earthTesterMake || "Waco") + " (" + (data.earthTesterSerial || "WC-354672") + ")",
        ep1.gridEarthValue !== "" ? ep1.gridEarthValue : "", ep1.gridEarthValue !== "" ? (ep1.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep1.photoUrl || "",
        ep2.gridEarthValue !== "" ? ep2.gridEarthValue : "", ep2.gridEarthValue !== "" ? (ep2.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep2.photoUrl || "",
        ep3.gridEarthValue !== "" ? ep3.gridEarthValue : "", ep3.gridEarthValue !== "" ? (ep3.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep3.photoUrl || "",
        ep4.gridEarthValue !== "" ? ep4.gridEarthValue : "", ep4.gridEarthValue !== "" ? (ep4.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep4.photoUrl || "",
        ep5.gridEarthValue !== "" ? ep5.gridEarthValue : "", ep5.gridEarthValue !== "" ? (ep5.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep5.photoUrl || "",
        summaryParts.join(" | "), maxResistance,
        hasHigh ? "ATTENTION REQUIRED (>2.0Ω)" : "ALL COMPLIANT (<=2.0Ω)",
        stationFolder.getUrl(), data.remarks || "", pitsJson
      ];
      sheet.appendRow(row);
    } catch(sheetErr) {
      Logger.log("Sheet write error (non-fatal): " + sheetErr.toString());
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      version: "5.2",
      message: "Successfully saved to Google Drive Live Database and Sheet.",
      timestamp: nowStr,
      station: roName,
      folderName: subfolderName,
      folderUrl: stationFolder.getUrl(),
      pitsCount: enrichedPits.length,
      totalLiveStations: db.reports.length,
      drivePhotosUploaded: Object.keys(photoUrls).length,
      photoUrls: photoUrls
    })).setMimeType(ContentService.MimeType.JSON);

  } catch(error) {
    Logger.log("Webhook Error: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      version: "5.2",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 3. GOOGLE DRIVE LIVE DATABASE ENGINE
// ==========================================
function getLiveDatabaseFile() {
  const props = PropertiesService.getScriptProperties();
  const fileId = props.getProperty("LIVE_DB_FILE_ID");
  if (fileId) {
    try {
      const file = DriveApp.getFileById(fileId);
      if (file && !file.isTrashed()) return file;
    } catch(e) {
      Logger.log("Could not find file by ID, searching by name...");
    }
  }

  // Look for existing file in the Drive folder
  const rootFolder = getOrCreateFolder(DRIVE_FOLDER_NAME);
  const files = rootFolder.getFilesByName(LIVE_DB_FILENAME);
  if (files.hasNext()) {
    const file = files.next();
    props.setProperty("LIVE_DB_FILE_ID", file.getId());
    return file;
  }

  // Create new live DB file
  const initialData = JSON.stringify({
    version: "5.2",
    updatedAt: new Date().toISOString(),
    reports: []
  });
  const newFile = rootFolder.createFile(LIVE_DB_FILENAME, initialData, "application/json");
  try {
    newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch(e) {}
  props.setProperty("LIVE_DB_FILE_ID", newFile.getId());
  return newFile;
}

function getLiveDatabase() {
  try {
    const file = getLiveDatabaseFile();
    const content = file.getBlob().getDataAsString();
    if (content && content.trim()) {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.reports)) return parsed;
    }
  } catch(e) {
    Logger.log("Error reading live database: " + e.toString());
  }
  return { version: "5.2", updatedAt: new Date().toISOString(), reports: [] };
}

function saveLiveDatabase(db) {
  try {
    const file = getLiveDatabaseFile();
    file.setContent(JSON.stringify(db));
    return true;
  } catch(e) {
    Logger.log("Error saving live database: " + e.toString());
    return false;
  }
}

// ==========================================
// 4. GOOGLE DRIVE & SPREADSHEET HELPERS
// ==========================================
function getOrCreateFolder(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}

function getOrCreateSubfolder(parentFolder, subfolderName) {
  const folders = parentFolder.getFoldersByName(subfolderName);
  if (folders.hasNext()) return folders.next();
  const newFolder = parentFolder.createFolder(subfolderName);
  try {
    newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch(e) {}
  return newFolder;
}

function getOrCreateSpreadsheet() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch(e) {}

  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.open(f);
  }
  return SpreadsheetApp.create(SPREADSHEET_NAME);
}
