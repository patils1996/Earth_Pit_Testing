/**
 * ====================================================================
 * BPCL EARTHING TESTING APP - GOOGLE APPS SCRIPT WEBHOOK
 * Automatically updates Google Sheet & uploads photos to Google Drive
 * Standard: IS 3043:2018 & OISD-STD-147
 * ====================================================================
 * 
 * SETUP INSTRUCTIONS (1 MINUTE):
 * 1. Open Google Sheets (https://sheets.new) and name it "BPCL_Earthing_Testing_Records".
 * 2. In Google Sheets, click Extensions > Apps Script.
 * 3. Delete any default code and paste this ENTIRE code into "Code.gs".
 * 4. Click Deploy > New deployment.
 * 5. Select type: "Web app".
 * 6. Set Description: "BPCL Earthing Sync Webhook".
 * 7. Execute as: "Me" (your Google account).
 * 8. Who has access: "Anyone" (allows phone app to push data without login).
 * 9. Click "Deploy" and authorize permissions.
 * 10. Copy the Web App URL (starts with https://script.google.com/macros/s/...)
 *     and paste it into the "Google Sync" menu in the Earthing Testing App!
 */

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

    // Health check ping
    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Pong! BPCL Earthing Testing webhook is live and operational."
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 1. Get or create Google Drive Folder
    const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);
    
    // 2. Process and save any uploaded photos to Google Drive
    const photoUrls = {};
    if (data.photos && Array.isArray(data.photos)) {
      data.photos.forEach((item) => {
        if (item.base64 && item.pit) {
          try {
            const rawBase64 = item.base64.replace(/^data:image\/\w+;base64,/, "");
            const bytes = Utilities.base64Decode(rawBase64);
            const fileName = `${data.roid || 'RO'}_${item.pit}_${Utilities.formatDate(new Date(), "GMT+5:30", "yyyyMMdd_HHmmss")}.jpg`;
            const blob = Utilities.newBlob(bytes, "image/jpeg", fileName);
            const file = folder.createFile(blob);
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            photoUrls[item.pit] = file.getUrl();
          } catch (photoErr) {
            Logger.log("Error saving photo: " + photoErr.toString());
          }
        }
      });
    }
    
    // 3. Get or create the Google Sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      // Create Header Row
      const headers = [
        "Timestamp", "ROID", "Retail Outlet", "Sales Area", "EO Name", "MST Name",
        "Test Date", "Next Due Date", "Contractor", "Instrument",
        "EP-1 Value (Ω)", "EP-1 Status", "EP-1 Photo Link",
        "EP-2 Value (Ω)", "EP-2 Status", "EP-2 Photo Link",
        "EP-3 Value (Ω)", "EP-3 Status", "EP-3 Photo Link",
        "EP-4 Value (Ω)", "EP-4 Status", "EP-4 Photo Link",
        "EP-5 Value (Ω)", "EP-5 Status", "EP-5 Photo Link",
        "Max Resistance (Ω)", "Overall Compliance", "Remarks"
      ];
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#0056b3").setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }
    
    // 4. Map Pit Measurements
    const pits = data.pits || [];
    const pitMap = {};
    let maxResistance = 0;
    let hasHigh = false;
    
    pits.forEach(p => {
      const num = p.pitNumber || p.num || "EP";
      const val = parseFloat(p.gridEarthValue !== undefined ? p.gridEarthValue : p.val) || 0;
      const status = val <= 2.0 ? "PASS" : "HIGH";
      if (val > 2.0) hasHigh = true;
      if (val > maxResistance) maxResistance = val;
      pitMap[num] = { val: val, status: status, photo: photoUrls[num] || p.photoUrl || "" };
    });
    
    const ep1 = pitMap["EP-1"] || { val: "", status: "", photo: "" };
    const ep2 = pitMap["EP-2"] || { val: "", status: "", photo: "" };
    const ep3 = pitMap["EP-3"] || { val: "", status: "", photo: "" };
    const ep4 = pitMap["EP-4"] || { val: "", status: "", photo: "" };
    const ep5 = pitMap["EP-5"] || { val: "", status: "", photo: "" };
    
    const nowStr = Utilities.formatDate(new Date(), "GMT+5:30", "dd-MM-yyyy HH:mm:ss");
    
    const row = [
      nowStr,
      data.retailCode || data.roid || "",
      data.siteName || "",
      data.salesArea || "",
      data.eoName || "",
      data.mstName || "",
      data.testDate || "",
      data.nextTestDate || "",
      data.contractorName || "CLR FACILITY SERVICES",
      `${data.earthTesterMake || 'Waco'} (${data.earthTesterSerial || 'N/A'})`,
      ep1.val, ep1.status, ep1.photo,
      ep2.val, ep2.status, ep2.photo,
      ep3.val, ep3.status, ep3.photo,
      ep4.val, ep4.status, ep4.photo,
      ep5.val, ep5.status, ep5.photo,
      maxResistance,
      hasHigh ? "ATTENTION REQUIRED (>2.0Ω)" : "ALL COMPLIANT (<=2.0Ω)",
      data.remarks || ""
    ];
    
    // 5. Append Row to Sheet
    sheet.appendRow(row);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Successfully updated Google Sheet and uploaded photos to Google Drive.",
      timestamp: nowStr,
      station: data.siteName,
      drivePhotosUploaded: Object.keys(photoUrls).length,
      photoUrls: photoUrls
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
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
    message: "Endpoint is ready to receive POST inspection updates."
  })).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}
