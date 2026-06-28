import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "aeo.db");
const db = new Database(dbPath);

// Initialize DB schema
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    url TEXT,
    industry TEXT NOT NULL,
    visibility_pct REAL NOT NULL,
    prompts_tracked INTEGER NOT NULL,
    prompts_mentioned INTEGER NOT NULL,
    raw_results TEXT NOT NULL,
    scanned_at TEXT NOT NULL
  )
`);

export function insertScan(scanRecord) {
  const stmt = db.prepare(`
    INSERT INTO scans (
      brand, url, industry, visibility_pct, prompts_tracked,
      prompts_mentioned, raw_results, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    scanRecord.brand,
    scanRecord.url,
    scanRecord.industry,
    scanRecord.visibility_pct,
    scanRecord.prompts_tracked,
    scanRecord.prompts_mentioned,
    JSON.stringify(scanRecord.results),
    scanRecord.scanned_at
  );
}
