#!/usr/bin/env node
/**
 * Migration: Add 'insight' to knowledge type CHECK constraint.
 * Run: node migrate-add-insight-type.cjs
 */

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');

const DB_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory.db');
const db = new Database(DB_PATH, { timeout: 5000 });
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

console.log('Starting migration: add insight type...');

const atomCount = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c;
console.log(`Current atoms: ${atomCount}`);

// Get full column list from current table
const cols = db.prepare("PRAGMA table_info(knowledge)").all();
const colNames = cols.map(c => c.name);
console.log(`Columns: ${colNames.join(', ')}`);

db.transaction(() => {
  // 1. Drop triggers
  console.log('Dropping triggers...');
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ai");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ad");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_au");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_ai");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_ad");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_au");

  // 2. Rename old table
  db.exec("ALTER TABLE knowledge RENAME TO knowledge_old");

  // 3. Create new table with insight in CHECK constraint
  db.exec(`
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'preference', 'decision', 'fact', 'pattern',
        'architecture', 'tool_config', 'debugging',
        'correction', 'reasoning_chain', 'workaround', 'anti_pattern',
        'insight'
      )),
      scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN (
        'project', 'global', 'cross_project'
      )),
      project TEXT,
      scope_path TEXT,
      tags TEXT,
      concepts TEXT,
      source_type TEXT CHECK(source_type IN (
        'user_explicit', 'model_initiated', 'heuristic', 'llm_extracted'
      )),
      source_session TEXT,
      source_thread_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.60,
      reinforcement_count INTEGER NOT NULL DEFAULT 1,
      access_count INTEGER NOT NULL DEFAULT 0,
      promotion_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      last_reinforced_at TEXT,
      last_injected_at TEXT,
      superseded_by INTEGER REFERENCES knowledge(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
        'active', 'superseded', 'archived', 'pruned'
      )),
      decay_rate REAL,
      impasse_severity REAL DEFAULT 0.0,
      contradiction_note TEXT,
      metadata TEXT,
      git_commit_hash TEXT,
      git_project_dir TEXT,
      git_staleness TEXT,
      injection_success_rate REAL
    )
  `);

  // 4. Copy data - use only columns that exist in both tables
  console.log('Copying data...');
  const newCols = db.prepare("PRAGMA table_info(knowledge)").all().map(c => c.name);
  // Use intersection of old and new columns (minus id which auto-increments)
  const copyColsAll = colNames.filter(c => newCols.includes(c));
  const colList = copyColsAll.join(', ');

  db.exec(`INSERT INTO knowledge (${colList}) SELECT ${colList} FROM knowledge_old`);

  const newCount = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c;
  if (newCount !== atomCount) {
    throw new Error(`Row count mismatch! Expected ${atomCount}, got ${newCount}`);
  }
  console.log(`Verified: ${newCount} rows copied.`);

  // 5. Drop old table
  db.exec("DROP TABLE knowledge_old");

  // 6. Recreate indexes
  console.log('Recreating indexes...');
  db.exec("CREATE INDEX idx_knowledge_scope_project ON knowledge(scope, project)");
  db.exec("CREATE INDEX idx_knowledge_type ON knowledge(type)");
  db.exec("CREATE INDEX idx_knowledge_status ON knowledge(status)");
  db.exec("CREATE INDEX idx_knowledge_confidence ON knowledge(confidence DESC) WHERE status = 'active'");
  db.exec("CREATE INDEX idx_knowledge_source_thread ON knowledge(source_thread_id)");

  // 7. Recreate FTS triggers
  console.log('Recreating FTS triggers...');
  db.exec(`
    CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END
  `);
  // Note: knowledge_trigram table does not exist, skipping trigram triggers

  console.log('Migration complete!');
})();

// Verify
const testInsert = db.prepare("INSERT INTO knowledge (content, type) VALUES ('test insight', 'insight')");
testInsert.run();
const testId = db.prepare("SELECT last_insert_rowid() as id").get().id;
db.prepare("DELETE FROM knowledge WHERE id = ?").run(testId);
console.log('CHECK constraint test passed: insight type accepted.');

db.close();
