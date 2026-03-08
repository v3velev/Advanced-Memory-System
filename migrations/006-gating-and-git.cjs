#!/usr/bin/env node
// Migration: Add injection gating columns + git hash tracking columns
// Run: node migrate-gating-and-git.cjs

const Database = require("better-sqlite3");
const { join } = require("path");
const { homedir } = require("os");

const DB_PATH = join(homedir(), ".claude", "memory-server", "data", "memory.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

console.log("Starting migration: injection gating + git hash tracking...");

// Add 5 new columns to knowledge table
const columns = [
  ["injection_count", "INTEGER DEFAULT 0"],
  ["injection_success_rate", "REAL DEFAULT NULL"],
  ["git_commit_hash", "TEXT"],
  ["git_project_dir", "TEXT"],
  ["git_staleness", "TEXT"],
];

for (const [name, type] of columns) {
  try {
    db.exec(`ALTER TABLE knowledge ADD COLUMN ${name} ${type}`);
    console.log(`  Added column: ${name}`);
  } catch (err) {
    if (err.message.includes("duplicate column")) {
      console.log(`  Column already exists: ${name}`);
    } else {
      throw err;
    }
  }
}

// Backfill injection stats from existing injection_events
console.log("\nBackfilling injection stats from injection_events...");

const stats = db.prepare(`
  SELECT atom_id,
    COUNT(*) as total,
    SUM(CASE WHEN was_referenced = 1 THEN 1 ELSE 0 END) as referenced
  FROM injection_events
  WHERE was_referenced IS NOT NULL
  GROUP BY atom_id
`).all();

const update = db.prepare(`
  UPDATE knowledge SET injection_count = ?, injection_success_rate = ?
  WHERE id = ?
`);

let backfilled = 0;
const txn = db.transaction(() => {
  for (const row of stats) {
    const rate = row.total >= 5 ? (row.referenced / row.total) : null;
    update.run(row.total, rate, row.atom_id);
    backfilled++;
  }
});
txn();

console.log(`  Backfilled ${backfilled} atoms with injection stats`);
console.log("  (injection_success_rate set only for atoms with 5+ evaluated events)");

console.log("\nMigration complete.");
db.close();
