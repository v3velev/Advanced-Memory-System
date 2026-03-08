#!/usr/bin/env node
/**
 * Migration: Fix injection_events FK reference from knowledge_old to knowledge.
 * Run: node migrate-fix-injection-fk.cjs
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory.db');
const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

console.log('Starting migration: fix injection_events FK...');

const count = db.prepare("SELECT COUNT(*) as c FROM injection_events").get().c;
console.log(`Current injection_events rows: ${count}`);

db.transaction(() => {
  db.exec(`
    CREATE TABLE injection_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      atom_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      session_file TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('post_tool_use','user_prompt_submit','session_start_compact')),
      injected_at TEXT NOT NULL DEFAULT (datetime('now')),
      was_referenced INTEGER DEFAULT NULL
    )
  `);

  db.exec("INSERT INTO injection_events_new SELECT * FROM injection_events");

  const newCount = db.prepare("SELECT COUNT(*) as c FROM injection_events_new").get().c;
  if (newCount !== count) {
    throw new Error(`Row count mismatch: ${count} -> ${newCount}`);
  }

  db.exec("DROP TABLE injection_events");
  db.exec("ALTER TABLE injection_events_new RENAME TO injection_events");

  // Recreate index
  db.exec("CREATE INDEX IF NOT EXISTS idx_injection_events_atom ON injection_events(atom_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_injection_events_session ON injection_events(session_file)");
})();

const finalCount = db.prepare("SELECT COUNT(*) as c FROM injection_events").get().c;
console.log(`Migration complete. ${finalCount} rows preserved.`);

db.close();
