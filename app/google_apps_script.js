/**
 * ====================================================================
 * BPCL EARTHING TESTING APP - GOOGLE APPS SCRIPT WEBHOOK (V5.0)
 * Real-time Bidirectional Multi-User Cloud Synchronization
 * Supports Dynamic Pits (EP-1 to EP-20+) & Google Drive Photo Archiving
 * Standard: IS 3043:2018 & OISD-STD-147
 * Contractor: CLR FACILITY SERVICES
 * ====================================================================
 * 
 * CRITICAL DEPLOYMENT SETTINGS (MANDATORY TO AVOID 403 ACCESS DENIED):
 * 1. Open Google Sheets (https://sheets.new) OR https://script.google.com
 * 2. Paste this entire code into "Code.gs".
 * 3. Click Deploy > New deployment (or Manage deployments > Edit).
 * 4. Select type: "Web app".
 * 5. Set Description: "BPCL Earthing Sync Webhook v5.0".
 * 6. Set Execute as: "Me" (your Google account).
 * 7. Set Who has access: "Anyone"  <--- CRITICAL! (Allows field mobile phones and laptops to sync)
 * 8. Click "Deploy" and Authorize permissions ("Advanced" > "Go to BPCL Earthing Sync" > "Allow").
 * 9. Copy the Web App URL (starts with https://script.google.com/macros/s/...)
 *    and paste into the "Google Sync" menu in the app!
 */

const SPREADSHEET_NAME = "BPCL_Earthing_Testing_Records";
const SHEET_NAME = "Earthing_Inspections";
const DRIVE_FOLDER_NAME = "BPCL_Earthing_Photos";

// ==========================================
// 1. GET HANDLER (Cloud Data Query & Health)
// ==========================================
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? e.parameter.action.toLowerCase() : "";
    const roid = (e && e.parameter && (e.parameter.roid || e.parameter.code)) ? String(e.parameter.roid || e.parameter.code).trim() : "";

    // A. Query recorded reports for live multi-user sync
    if (action === "get_reports" || action === "sync" || action === "reports") {
      const reports = readAllReportsFromSheet(roid);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        count: reports.length,
        reports: reports,
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // B. Default Ping / Health Check
    return ContentService.createTextOutput(JSON.stringify({
      status: "active",
      version: "5.0",
      service: "BPCL Earthing Testing Google Sync Webhook",
      message: "Endpoint is live, authorized, and operational with bidirectional sync enabled!",
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("doGet Error: " + err.toString());
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 2. POST HANDLER (Record Inspection & Photos)
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

    // 1. Health check ping
    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        version: "5.0",
        message: "Pong! BPCL Earthing Testing webhook is live, authorized, and operational.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Data query via POST
    if (data.action === "get_reports" || data.action === "sync") {
      const reports = readAllReportsFromSheet(data.roid || "");
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        count: reports.length,
        reports: reports,
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3. Get or create root Google Drive Folder
    const rootFolder = getOrCreateFolder(DRIVE_FOLDER_NAME);
    
    // 4. Get or create Station Subfolder named "[RO code] - [RO name]"
    const roCode = (data.retailCode || data.roid || "RO").toString().trim();
    const roName = (data.siteName || "Retail Outlet").toString().trim();
    const subfolderName = `${roCode} - ${roName}`;
    const stationFolder = getOrCreateSubfolder(rootFolder, subfolderName);

    // 5. Process and save any uploaded photos into Station Subfolder
    const photoUrls = {};
    if (data.photos && Array.isArray(data.photos)) {
      data.photos.forEach((item) => {
        const b64 = item.base64 || item.dataUrl || item.data || "";
        const pitName = item.pit || "EP";
        if (b64) {
          try {
            const rawBase64 = b64.replace(/^data:image\/\w+;base64,/, "");
            const bytes = Utilities.base64Decode(rawBase64);
            const fileName = `${roCode}_${pitName}_${Utilities.formatDate(new Date(), "GMT+5:30", "yyyyMMdd_HHmmss")}.jpg`;
            const blob = Utilities.newBlob(bytes, "image/jpeg", fileName);
            const file = stationFolder.createFile(blob);
            try {
              file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            } catch(shareErr) {
              // Safely bypass domain restrictions
            }
            photoUrls[pitName] = file.getUrl();
          } catch (photoErr) {
            Logger.log("Error saving photo for " + pitName + ": " + photoErr.toString());
          }
        }
      });
    }

    // 6. Map Pit Measurements (supports unlimited pits)
    const pits = data.pits || [];
    const enrichedPits = pits.map((p, idx) => {
      const pitNum = p.pitNumber || p.num || ("EP-" + (idx + 1));
      const val = parseFloat(p.gridEarthValue !== undefined ? p.gridEarthValue : p.val) || 0.0;
      return {
        id: p.id || `ro-${roCode}-p${idx + 1}`,
        reportId: p.reportId || `ro-${roCode}`,
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

    enrichedPits.forEach((p) => {
      if (p.gridEarthValue > 2.0) hasHigh = true;
      if (p.gridEarthValue > maxResistance) maxResistance = p.gridEarthValue;
      pitMap[p.pitNumber] = p;
      summaryParts.push(`${p.pitNumber}: ${p.gridEarthValue}Ω (${p.gridEarthValue <= 2.0 ? 'PASS' : 'HIGH'})`);
    });

    // Helper to find pit data flexibly by number
    function getPit(epNum) {
      if (pitMap[epNum]) return pitMap[epNum];
      const digit = epNum.replace(/[^0-9]/g, '');
      for (const k in pitMap) {
        if (k.replace(/[^0-9]/g, '') === digit) return pitMap[k];
      }
      return { gridEarthValue: "", remarks: "", photoUrl: "" };
    }

    // 7. Get or create the Google Sheet
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
      // Dynamic header column upgrade for existing sheets
      const lastCol = sheet.getLastColumn();
      if (lastCol > 0) {
        const headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
        if (!headerValues.includes("Retest Status")) {
          const nextDueIdx = headerValues.indexOf("Next Due Date");
          if (nextDueIdx !== -1) {
            sheet.insertColumnsAfter(nextDueIdx + 1, 2);
            sheet.getRange(1, nextDueIdx + 2).setValue("Retest Status").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
            sheet.getRange(1, nextDueIdx + 3).setValue("Action to be Taken").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
          }
        }
        if (!headerValues.includes("Drive Station Folder")) {
          const remIdx = headerValues.indexOf("Remarks");
          if (remIdx !== -1) {
            sheet.insertColumnBefore(remIdx + 1);
            sheet.getRange(1, remIdx + 1).setValue("Drive Station Folder").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
          } else {
            sheet.getRange(1, lastCol + 1).setValue("Drive Station Folder").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
          }
        }
        // Ensure "Pits Data JSON" column is present for full pit fidelity
        const curHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        if (!curHeaders.includes("Pits Data JSON")) {
          const newCol = sheet.getLastColumn() + 1;
          sheet.getRange(1, newCol).setValue("Pits Data JSON").setFontWeight("bold").setBackground("#003366").setFontColor("#ffffff");
        }
      }
    }

    const ep1 = getPit("EP-1");
    const ep2 = getPit("EP-2");
    const ep3 = getPit("EP-3");
    const ep4 = getPit("EP-4");
    const ep5 = getPit("EP-5");

    const nowStr = Utilities.formatDate(new Date(), "GMT+5:30", "dd-MM-yyyy HH:mm:ss");

    // Retest status & Action to be taken calculation
    let retestStatus = data.retestStatus || "VALID";
    let actionToBeTaken = data.actionToBeTaken || (hasHigh ? "Watering & Treatment Required" : "All Compliant");
    if (!data.retestStatus && data.nextTestDate) {
      try {
        const parts = data.nextTestDate.split('-');
        if (parts.length === 3) {
          const nDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          const curDate = new Date();
          curDate.setHours(0, 0, 0, 0);
          nDate.setHours(0, 0, 0, 0);
          const diffDays = Math.ceil((nDate.getTime() - curDate.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays < 0) {
            retestStatus = `OVERDUE (${Math.abs(diffDays)}d)`;
            actionToBeTaken = hasHigh ? "CRITICAL: Retest & Watering Required" : "RETEST DUE: Schedule MST Inspection";
          } else if (diffDays === 0) {
            retestStatus = "DUE TODAY";
            actionToBeTaken = "RETEST DUE: Schedule MST Inspection";
          } else if (diffDays <= 30) {
            retestStatus = `UPCOMING RETEST (${diffDays}d)`;
            actionToBeTaken = hasHigh ? "HIGH: Watering Needed (>2.0Ω)" : "UPCOMING: Plan Visit";
          } else {
            retestStatus = `VALID (${diffDays}d)`;
            actionToBeTaken = hasHigh ? "HIGH: Watering Needed (>2.0Ω)" : "ALL COMPLIANT: Certified Valid";
          }
        }
      } catch(e) {}
    }

    const pitsJson = JSON.stringify(enrichedPits);

    const row = [
      nowStr,
      roCode,
      roName,
      data.salesArea || "",
      data.eoName || "",
      data.mstName || "",
      data.testDate || "",
      data.nextTestDate || "",
      retestStatus,
      actionToBeTaken,
      data.contractorName || "CLR FACILITY SERVICES",
      `${data.earthTesterMake || 'Waco'} (${data.earthTesterSerial || 'WC-354672'})`,
      ep1.gridEarthValue !== "" ? ep1.gridEarthValue : "", ep1.gridEarthValue !== "" ? (ep1.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep1.photoUrl || "",
      ep2.gridEarthValue !== "" ? ep2.gridEarthValue : "", ep2.gridEarthValue !== "" ? (ep2.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep2.photoUrl || "",
      ep3.gridEarthValue !== "" ? ep3.gridEarthValue : "", ep3.gridEarthValue !== "" ? (ep3.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep3.photoUrl || "",
      ep4.gridEarthValue !== "" ? ep4.gridEarthValue : "", ep4.gridEarthValue !== "" ? (ep4.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep4.photoUrl || "",
      ep5.gridEarthValue !== "" ? ep5.gridEarthValue : "", ep5.gridEarthValue !== "" ? (ep5.gridEarthValue <= 2.0 ? "PASS" : "HIGH") : "", ep5.photoUrl || "",
      summaryParts.join(" | "),
      maxResistance,
      hasHigh ? "ATTENTION REQUIRED (>2.0Ω)" : "ALL COMPLIANT (<=2.0Ω)",
      stationFolder.getUrl(),
      data.remarks || "",
      pitsJson
    ];

    // 8. Append Row to Sheet
    sheet.appendRow(row);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      version: "5.0",
      message: "Successfully recorded in Google Sheet and uploaded photos to Google Drive station subfolder.",
      timestamp: nowStr,
      station: roName,
      folderName: subfolderName,
      folderUrl: stationFolder.getUrl(),
      pitsCount: enrichedPits.length,
      drivePhotosUploaded: Object.keys(photoUrls).length,
      photoUrls: photoUrls
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("Webhook Error: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 3. READ ALL REPORTS FOR BIDIRECTIONAL SYNC
// ==========================================
function readAllReportsFromSheet(filterRoid) {
  const ss = getOrCreateSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1 || lastCol === 0) return [];

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colMap = {};
  headers.forEach((h, i) => {
    colMap[String(h).trim()] = i;
  });

  const dataValues = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const reportsByRoid = new Map();

  // Read backwards from newest row to oldest
  for (let r = dataValues.length - 1; r >= 0; r--) {
    const row = dataValues[r];
    const roid = String(row[colMap["ROID"]] || "").trim();
    if (!roid) continue;
    if (filterRoid && roid !== filterRoid) continue;

    // If we already have the newest test for this ROID, skip older rows
    if (reportsByRoid.has(roid)) continue;

    const siteName = String(row[colMap["Retail Outlet"]] || "").trim();
    const salesArea = String(row[colMap["Sales Area"]] || "").trim();
    const eoName = String(row[colMap["EO Name"]] || "").trim();
    const mstName = String(row[colMap["MST Name"]] || "").trim();
    const testDate = String(row[colMap["Test Date"]] || "").trim();
    const nextTestDate = String(row[colMap["Next Due Date"]] || "").trim();
    const contractorName = String(row[colMap["Contractor"]] || "").trim();
    const instrumentStr = String(row[colMap["Instrument Make & Serial"]] || "").trim();
    const remarks = String(row[colMap["Remarks"]] || "").trim();

    // Reconstruct pits
    let pits = [];
    const pitsJsonIdx = colMap["Pits Data JSON"];
    if (pitsJsonIdx !== undefined && row[pitsJsonIdx]) {
      try {
        const parsed = JSON.parse(row[pitsJsonIdx]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          pits = parsed;
        }
      } catch (pe) {}
    }

    // Fallback reconstruction if Pits Data JSON wasn't recorded
    if (pits.length === 0) {
      for (let i = 1; i <= 5; i++) {
        const valCol = colMap[`EP-${i} Value (Ω)`];
        const photoCol = colMap[`EP-${i} Photo Link`];
        const val = valCol !== undefined ? parseFloat(row[valCol]) : NaN;
        if (!isNaN(val)) {
          pits.push({
            id: `ro-${roid}-p${i}`,
            reportId: `ro-${roid}`,
            pitNumber: `EP-${i}`,
            location: i === 1 ? "Canopy Column 1" : i === 2 ? "Dispenser Island 1" : i === 3 ? "Dispenser Island 2" : i === 4 ? "Tank Farm Area" : "Electrical Room",
            equipmentConnected: i === 1 ? "Canopy Structure" : i === 2 ? "Dispenser 1 Body" : i === 3 ? "Dispenser 1 Neutral" : i === 4 ? "Tank Body & Static Ground" : "Main LT Panel Body",
            gridEarthValue: val,
            remarks: val <= 2.0 ? "Ok" : "Watering Required",
            photoUrl: photoCol !== undefined ? String(row[photoCol] || "") : "",
            sortOrder: i - 1
          });
        }
      }
    }

    // Parse instrument make and serial
    let earthTesterMake = "Waco";
    let earthTesterSerial = "WC-354672";
    if (instrumentStr) {
      const match = instrumentStr.match(/^(.*?)\s*\((.*?)\)$/);
      if (match) {
        earthTesterMake = match[1].trim();
        earthTesterSerial = match[2].trim();
      } else {
        earthTesterMake = instrumentStr;
      }
    }

    const reportObj = {
      id: `ro-${roid}`,
      retailCode: roid,
      siteName: siteName || `Retail Outlet ${roid}`,
      salesArea: salesArea,
      eoName: eoName,
      mstName: mstName,
      location: salesArea,
      testDate: testDate,
      nextTestDate: nextTestDate,
      contractorName: contractorName || "CLR FACILITY SERVICES",
      technicianName: mstName,
      earthTesterMake: earthTesterMake,
      earthTesterModel: "Digital Earth Tester",
      earthTesterSerial: earthTesterSerial,
      calibDate: "2025-11-15",
      createdAt: new Date().toISOString(),
      updatedAt: String(row[colMap["Timestamp"]] || new Date().toISOString()),
      remarks: remarks,
      pits: pits
    };

    reportsByRoid.set(roid, reportObj);
  }

  return Array.from(reportsByRoid.values());
}

// ==========================================
// 4. SPREADSHEET & DRIVE HELPERS
// ==========================================
function getOrCreateSpreadsheet() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch(e) {}

  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.open(f);
    }
  }

  return SpreadsheetApp.create(SPREADSHEET_NAME);
}

function getOrCreateFolder(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function getOrCreateSubfolder(parentFolder, subfolderName) {
  const folders = parentFolder.getFoldersByName(subfolderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  const newFolder = parentFolder.createFolder(subfolderName);
  try {
    newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch(e) {}
  return newFolder;
}
