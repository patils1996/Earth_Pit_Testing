import http.server
import socketserver
import sqlite3
import json
import os
import mimetypes
import uuid
import datetime
from urllib.parse import urlparse, parse_qs

PORT = 5000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, 'earth_pits.db')
STATIC_DIR = BASE_DIR if os.path.exists(os.path.join(BASE_DIR, 'index.html')) else os.path.join(BASE_DIR, 'app')

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            siteName TEXT NOT NULL,
            retailCode TEXT,
            location TEXT,
            testDate TEXT NOT NULL,
            nextTestDate TEXT,
            contractorName TEXT,
            technicianName TEXT,
            earthTesterMake TEXT,
            earthTesterModel TEXT,
            earthTesterSerial TEXT,
            calibDate TEXT,
            salesArea TEXT,
            eoName TEXT,
            mstName TEXT,
            createdAt TEXT,
            updatedAt TEXT
        )
    """)
    
    # Check if columns exist (for migration)
    c.execute("PRAGMA table_info(reports)")
    existing_cols = [row[1] for row in c.fetchall()]
    for col in ['salesArea', 'eoName', 'mstName']:
        if col not in existing_cols:
            c.execute(f"ALTER TABLE reports ADD COLUMN {col} TEXT")

    c.execute("""
        CREATE TABLE IF NOT EXISTS pits (
            id TEXT PRIMARY KEY,
            reportId TEXT NOT NULL,
            pitNumber TEXT NOT NULL,
            location TEXT,
            equipmentConnected TEXT,
            gridEarthValue REAL NOT NULL,
            remarks TEXT,
            sortOrder INTEGER DEFAULT 0,
            FOREIGN KEY (reportId) REFERENCES reports (id) ON DELETE CASCADE
        )
    """)
    conn.commit()
    conn.close()

def get_all_reports(filters=None):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    query = 'SELECT * FROM reports'
    params = []
    conditions = []
    
    if filters:
        if filters.get('salesArea'):
            conditions.append('salesArea = ?')
            params.append(filters['salesArea'])
        if filters.get('eoName'):
            conditions.append('eoName = ?')
            params.append(filters['eoName'])
        if filters.get('mstName'):
            conditions.append('mstName = ?')
            params.append(filters['mstName'])
            
    if conditions:
        query += ' WHERE ' + ' AND '.join(conditions)
        
    query += ' ORDER BY testDate DESC, siteName ASC'
    
    c.execute(query, params)
    reports = [dict(row) for row in c.fetchall()]
    for r in reports:
        c.execute('SELECT * FROM pits WHERE reportId = ? ORDER BY sortOrder ASC', (r['id'],))
        r['pits'] = [dict(p) for p in c.fetchall()]
    conn.close()
    return reports

def get_report(report_id):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute('SELECT * FROM reports WHERE id = ?', (report_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return None
    r = dict(row)
    c.execute('SELECT * FROM pits WHERE reportId = ? ORDER BY sortOrder ASC', (r['id'],))
    r['pits'] = [dict(p) for p in c.fetchall()]
    conn.close()
    return r

def save_report(data, report_id=None):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    now = datetime.datetime.now().isoformat()
    if not report_id:
        report_id = data.get('id') or f"rep-{uuid.uuid4().hex[:6]}"
    
    test_date = data.get('testDate') or datetime.date.today().isoformat()
    next_test_date = data.get('nextTestDate')
    if not next_test_date and test_date:
        try:
            d = datetime.date.fromisoformat(test_date)
            month = d.month + 6
            year = d.year
            if month > 12:
                month -= 12
                year += 1
            next_test_date = datetime.date(year, month, min(d.day, 28)).isoformat()
        except Exception:
            next_test_date = test_date

    c.execute("""
        INSERT OR REPLACE INTO reports (
            id, siteName, retailCode, location, testDate, nextTestDate,
            contractorName, technicianName, earthTesterMake, earthTesterModel,
            earthTesterSerial, calibDate, salesArea, eoName, mstName, createdAt, updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        report_id,
        data.get('siteName', 'Untitled Site'),
        str(data.get('retailCode', '')),
        data.get('location', ''),
        test_date,
        next_test_date,
        data.get('contractorName', 'CLR FACILITY SERVICES'),
        data.get('technicianName', ''),
        data.get('earthTesterMake', 'Waco'),
        data.get('earthTesterModel', 'Digital Earth Tester'),
        data.get('earthTesterSerial', ''),
        data.get('calibDate', ''),
        data.get('salesArea', ''),
        data.get('eoName', ''),
        data.get('mstName', ''),
        data.get('createdAt', now),
        now
    ))
    
    c.execute('DELETE FROM pits WHERE reportId = ?', (report_id,))
    pits = data.get('pits', [])
    for idx, p in enumerate(pits):
        p_id = p.get('id') or f"{report_id}-p{idx+1}"
        c.execute("""
            INSERT INTO pits VALUES (?,?,?,?,?,?,?,?)
        """, (
            p_id, report_id,
            p.get('pitNumber', f"EP-{idx+1}"),
            p.get('location', ''),
            p.get('equipmentConnected', ''),
            float(p.get('gridEarthValue', 0.0) or 0.0),
            p.get('remarks', ''),
            idx
        ))
    conn.commit()
    conn.close()
    return get_report(report_id)

def delete_report(report_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('DELETE FROM pits WHERE reportId = ?', (report_id,))
    c.execute('DELETE FROM reports WHERE id = ?', (report_id,))
    conn.commit()
    conn.close()
    return True

class AppHandler(http.server.BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == '/api/reports':
            filters = {k: v[0] for k, v in query.items()}
            reports = get_all_reports(filters)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(reports).encode('utf-8'))
            return

        if path.startswith('/api/reports/'):
            report_id = path[len('/api/reports/'):]
            report = get_report(report_id)
            if report:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps(report).encode('utf-8'))
            else:
                self.send_response(404)
                self.send_cors_headers()
                self.end_headers()
            return

        clean_path = path.lstrip('/')
        if not clean_path:
            clean_path = 'index.html'

        file_path = os.path.join(STATIC_DIR, clean_path)
        
        if not os.path.exists(file_path) or os.path.isdir(file_path):
            if '.' not in os.path.basename(clean_path):
                file_path = os.path.join(STATIC_DIR, 'index.html')
            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"404 Not Found")
                return

        if os.path.exists(file_path):
            mime, _ = mimetypes.guess_type(file_path)
            self.send_response(200)
            self.send_header('Content-Type', (mime or 'application/octet-stream') + '; charset=utf-8' if mime and 'text' in mime else (mime or 'application/octet-stream'))
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_cors_headers()
            self.end_headers()
            with open(file_path, 'rb') as f:
                self.wfile.write(f.read())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if path == '/api/reports':
            saved = save_report(data)
            self.send_response(201)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(saved).encode('utf-8'))
            return

        if path == '/api/onboard':
            results = []
            if isinstance(data, list):
                for item in data:
                    results.append(save_report(item))
            elif isinstance(data, dict):
                results.append(save_report(data))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "imported": len(results), "reports": results}).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith('/api/reports/'):
            report_id = path[len('/api/reports/'):]
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
            data = json.loads(body)
            saved = save_report(data, report_id=report_id)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(saved).encode('utf-8'))
            return
        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith('/api/reports/'):
            report_id = path[len('/api/reports/'):]
            delete_report(report_id)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode('utf-8'))
            return
        self.send_response(404)
        self.end_headers()

def run():
    init_db()
    port = PORT
    server = None
    for p in range(5000, 5010):
        try:
            server = socketserver.TCPServer(('127.0.0.1', p), AppHandler)
            server.allow_reuse_address = True
            port = p
            break
        except OSError:
            continue
            
    if not server:
        print("Could not bind to any port between 5000 and 5010")
        return

    print("=" * 60)
    print(f"  Earth Pit Manager (EPM Pro) is running!")
    print(f"  Access the app at: http://localhost:{port}")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        server.server_close()

if __name__ == '__main__':
    run()
