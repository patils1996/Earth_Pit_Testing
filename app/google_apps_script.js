/**
 * ====================================================================
 * BPCL EARTHING TESTING APP - GOOGLE APPS SCRIPT WEBHOOK (V4.0)
 * Automatically updates Google Sheet & uploads photos to Google Drive
 * Standard: IS 3043:2018 & OISD-STD-147
 * Contractor: CLR FACILITY SERVICES
 * ====================================================================
 * 
 * CRITICAL DEPLOYMENT SETTINGS (MANDATORY TO AVOID 403 ACCESS DENIED):
 * 1. Open Google Sheets (https://sheets.new) OR https://script.google.com
 * 2. Paste this entire code into "Code.gs".
 * 3. Click Deploy > New deployment (or Manage deployments > Edit).
 * 4. Select type: "Web app".
 * 5. Set Description: "BPCL Earthing Sync Webhook v4.0".
 * 6. Set Execute as: "Me" (your Google account).
 * 7. Set Who has access: "Anyone"  <--- CRITICAL! (If set to "Only myself", external devices get 403 Access Denied)
 * 8. Click "Deploy" and Authorize permissions ("Advanced" > "Go to BPCL Earthing Sync" > "Allow").
 * 9. Copy the Web App URL (starts with https://script.google.com/macros/s/...)
 *    and paste into the "Google Sync" menu in the app!
 */

const SPREADSHEET_NAME = "BPCL_Earthing_Testing_Records";
const SHEET_NAME = "Earthing_Inspections";
const DRIVE_FOLDER_NAME = "BPCL_Earthing_Photos";

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
        message: "Pong! BPCL Earthing Testing webhook is live, authorized, and operational.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 2. Get or create root Google Drive Folder
    const rootFolder = getOrCreateFolder(DRIVE_FOLDER_NAME);
    
    // 3. Get or create Station Subfolder named "[RO code] - [RO name]"
    const roCode = (data.retailCode || data.roid || "RO").toString().trim();
    const roName = (data.siteName || "Retail Outlet").toString().trim();
    const subfolderName = `${roCode} - ${roName}`;
    const stationFolder = getOrCreateSubfolder(rootFolder, subfolderName);

    // 4. Process and save any uploaded photos into Station Subfolder
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
              // Safely bypass domain link-sharing restrictions
            }
            photoUrls[pitName] = file.getUrl();
          } catch (photoErr) {
            Logger.log("Error saving photo for " + pitName + ": " + photoErr.toString());
          }
        }
      });
    }
    
    // 5. Get or create the Google Sheet (Handles container-bound or standalone script)
    const ss = getOrCreateSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    const headers = [
      "Timestamp", "ROID", "Retail Outlet", "Sales Area", "EO Name", "MST Name",
      "Test Date", "Next Due Date", "Contractor", "Instrument Make & Serial",
      "EP-1 Value (Ω)", "EP-1 Status", "EP-1 Photo Link",
      "EP-2 Value (Ω)", "EP-2 Status", "EP-2 Photo Link",
      "EP-3 Value (Ω)", "EP-3 Status", "EP-3 Photo Link",
      "EP-4 Value (Ω)", "EP-4 Status", "EP-4 Photo Link",
      "EP-5 Value (Ω)", "EP-5 Status", "EP-5 Photo Link",
      "All Pits Summary", "Max Resistance (Ω)", "Overall Compliance", "Drive Station Folder", "Remarks"
    ];

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    } else {
      // Check if existing sheet headers need "Drive Station Folder" column
      const lastCol = sheet.getLastColumn();
      if (lastCol > 0) {
        const headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
        if (!headerValues.includes("Drive Station Folder")) {
          const remIdx = headerValues.indexOf("Remarks");
          if (remIdx !== -1) {
            sheet.insertColumnBefore(remIdx + 1);
            sheet.getRange(1, remIdx + 1).setValue("Drive Station Folder").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
          } else {
            sheet.getRange(1, lastCol + 1).setValue("Drive Station Folder").setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
          }
        }
      }
    }
    
    // 6. Map Pit Measurements
    const pits = data.pits || [];
    const pitMap = {};
    let maxResistance = 0;
    let hasHigh = false;
    const summaryParts = [];
    
    pits.forEach((p, idx) => {
      const num = p.pitNumber || p.num || ("EP-" + (idx + 1));
      const val = parseFloat(p.gridEarthValue !== undefined ? p.gridEarthValue : p.val) || 0;
      const status = val <= 2.0 ? "PASS" : "HIGH";
      if (val > 2.0) hasHigh = true;
      if (val > maxResistance) maxResistance = val;
      const pPhoto = photoUrls[num] || p.photoUrl || "";
      pitMap[num] = { val: val, status: status, photo: pPhoto };
      summaryParts.push(`${num}: ${val}Ω (${status})`);
    });
    
    // Helper to find pit data flexibly by number
    function getPit(epNum) {
      if (pitMap[epNum]) return pitMap[epNum];
      const digit = epNum.replace(/[^0-9]/g, '');
      for (const k in pitMap) {
        if (k.replace(/[^0-9]/g, '') === digit) return pitMap[k];
      }
      return { val: "", status: "", photo: "" };
    }
    
    const ep1 = getPit("EP-1");
    const ep2 = getPit("EP-2");
    const ep3 = getPit("EP-3");
    const ep4 = getPit("EP-4");
    const ep5 = getPit("EP-5");
    
    const nowStr = Utilities.formatDate(new Date(), "GMT+5:30", "dd-MM-yyyy HH:mm:ss");
    
    const row = [
      nowStr,
      roCode,
      roName,
      data.salesArea || "",
      data.eoName || "",
      data.mstName || "",
      data.testDate || "",
      data.nextTestDate || "",
      data.contractorName || "CLR FACILITY SERVICES",
      `${data.earthTesterMake || 'Waco'} (${data.earthTesterSerial || 'WC-354672'})`,
      ep1.val, ep1.status, ep1.photo,
      ep2.val, ep2.status, ep2.photo,
      ep3.val, ep3.status, ep3.photo,
      ep4.val, ep4.status, ep4.photo,
      ep5.val, ep5.status, ep5.photo,
      summaryParts.join(" | "),
      maxResistance,
      hasHigh ? "ATTENTION REQUIRED (>2.0Ω)" : "ALL COMPLIANT (<=2.0Ω)",
      stationFolder.getUrl(),
      data.remarks || ""
    ];
    
    // 7. Append Row to Sheet
    sheet.appendRow(row);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Successfully recorded in Google Sheet and uploaded photos to Google Drive station subfolder.",
      timestamp: nowStr,
      station: roName,
      folderName: subfolderName,
      folderUrl: stationFolder.getUrl(),
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

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    service: "BPCL Earthing Testing Google Sync Webhook",
    message: "Endpoint is live, authorized, and operational!",
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

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
