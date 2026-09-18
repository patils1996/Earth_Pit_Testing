# BPCL Earthing Testing App (By CLR FACILITY SERVICES)
> **Simple, Direct Progressive Web Application (PWA) with Google Sheets & Google Drive Cloud Sync**
> Standards: **IS 3043:2018** & **OISD-STD-147**
> Fully loaded with **389 Retail Outlets** and **1,945 Earth Pits** from `RetailOutlet_Details.xlsx`.
> **100% Online & Offline Functional** on GitHub Pages without requiring any backend server.

---

## 🌟 Key Highlights & Features

1. **Simple, Clean & Direct UI (Zero Login)**:
   - No login portal, no passwords, no barrier.
   - Anyone opening the app immediately lands on the **Territory Earthing Dashboard** with full access to all metrics, charts, 389 stations, and inspection tools.

2. **Fast MST Earthing Test Updates (`#/field`)**:
   - **Station Lookup**: Select any retail outlet from the 389 list (type ROID e.g. `116218` or Name).
   - **Auto-Fill**: Automatically loads ROID, Sales Area, Engineering Officer (EO), and existing pit readings.
   - **MST Technician**: Choose from the 12 assigned MSTs (*Sanjay Korvi*, *Rajesab Bhagavan*, *Chetan Dalawai*, *Mahesh Patil*, *Anand Joshi*, *Hemareddi*, *Shivaraj Dalawai*, *Nithin Ningaraddi*, *Vasureddi Meti*, *Shubham Sutar*, *Ravi Badiger*, *MRUTUNJAYYA H*).
   - **5-Pit Touch Inputs**: Large touch steppers (`-` / `+` 0.1 Ohm) with live Pass (&le; 2.0 &Omega;) / Fail (> 2.0 &Omega;) indicators.
   - **Camera Photo Capture**: Snap pit links, tester readings, or chambers directly from the mobile camera.
   - **Instant Live Update**: Saving immediately updates the station's readings in the app, recalculates dashboard KPIs, and updates compliance charts.

3. **Auto-Save to Google Sheets & Google Drive (`google_apps_script.js`)**:
   - Every submitted inspection is automatically appended to a **Google Sheet**.
   - Attached inspection photos are automatically uploaded to a **Google Drive folder** (`BPCL_EarthPit_Photos`), and the direct viewable Google Drive link is placed in the Google Sheet row!

---

## ⚡ 1-Minute Google Sheets & Drive Setup

You can connect your Google Sheet & Drive in less than 2 minutes:

1. Go to [Google Sheets](https://sheets.google.com/) and create a new blank spreadsheet.
2. In the top menu, click **Extensions** &rarr; **Apps Script**.
3. Delete any code in the editor, and copy & paste the code from [`google_apps_script.js`](./google_apps_script.js).
4. Click the blue **Deploy** button (top right) &rarr; **New deployment**.
5. Click the gear icon (Select type) &rarr; choose **Web app**.
6. Set:
   - **Description**: `BPCL Earthing Webhook`
   - **Execute as**: `Me (your email)`
   - **Who has access**: `Anyone` *(Crucial: allows field technicians to submit without Google login)*
7. Click **Deploy**, authorize access when prompted, and copy the **Web app URL** (ends in `/exec`).
8. In the app, click **"Google Sync"** in the top bar or sidebar, paste your URL, and click **Save Webhook URL**!

Every field test submitted by MSTs will now automatically append to your Google Sheet and upload photos to Google Drive.

---

## 📱 Mobile App Installation (PWA)

- When opened from a phone via web link, the app automatically shows an **"Install App"** prompt.
- **Android / Chrome / Edge**: One-tap installation onto the home screen with custom BPCL circular icon.
- **iOS Safari**: Tap *Share* &rarr; *Add to Home Screen*.
- Works **100% offline** at petrol pumps with zero cellular signal using Service Worker caching.

---

## 🌐 Live Web & Mobile App (GitHub Pages)

- **GitHub Repository**: [https://github.com/patils1996/Earth_Pit_Testing](https://github.com/patils1996/Earth_Pit_Testing)
- **Live Mobile & Web App**: [https://patils1996.github.io/Earth_Pit_Testing/](https://patils1996.github.io/Earth_Pit_Testing/)

### To enable GitHub Pages on your repository:
1. Open your repository on GitHub: **Settings** &rarr; **Pages**.
2. Under **Build and deployment** &rarr; **Branch**, select `main` and folder `/ (root)`.
3. Click **Save**.
4. In 1 minute, the app is live for all field employees and managers at:
   `https://patils1996.github.io/Earth_Pit_Testing/`

---

## 💻 Running Locally

- Double-click `start.bat` to launch the local server at `http://localhost:5000`.
- Or run:
  ```powershell
  python server.py
  ```
