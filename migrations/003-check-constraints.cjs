#!/usr/bin/env node
/**
 * Migration: Update CHECK constraints on knowledge table.
 * Adds new types: correction, reasoning_chain, workaround, anti_pattern
 * Adds new source_type: llm_extracted
 * Adds worker_id column to jobs table.
 *
 * Run: node migrate-check-constraints.cjs
 */

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');

const DB_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory.db');
const db = new Database(DB_PATH, { timeout: 5000 });
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // Must be OFF during table recreation

console.log('Starting CHECK constraint migration...');

// Verify current state
const atomCount = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c;
console.log(`Current atoms: ${atomCount}`);

db.transaction(() => {
  // 1. Drop FTS triggers that reference knowledge
  console.log('Dropping triggers...');
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ai");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ad");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_au");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_ai");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_ad");
  db.exec("DROP TRIGGER IF EXISTS knowledge_tri_au");

  // 2. Recreate knowledge table with new CHECK constraints
  console.log('Recreating knowledge table...');
  db.exec("ALTER TABLE knowledge RENAME TO knowledge_old");

  db.exec(`
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'preference', 'decision', 'fact', 'pattern',
        'architecture', 'tool_config', 'debugging',
        'correction', 'reasoning_chain', 'workaround', 'anti_pattern'
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
      metadata TEXT
    )
  `);

  // 3. Copy data from old table
  console.log('Copying data...');
  db.exec(`
    INSERT INTO knowledge (
      id, content, type, scope, project, scope_path, tags, concepts,
      source_type, source_session, confidence, reinforcement_count,
      access_count, promotion_count, created_at, updated_at,
      last_accessed_at, last_reinforced_at, last_injected_at,
      superseded_by, status, decay_rate, impasse_severity, contradiction_note
    )
    SELECT
      id, content, type, scope, project, scope_path, tags, concepts,
      source_type, source_session, confidence, reinforcement_count,
      access_count, promotion_count, created_at, updated_at,
      last_accessed_at, last_reinforced_at, last_injected_at,
      superseded_by, status, decay_rate, impasse_severity, contradiction_note
    FROM knowledge_old
  `);

  // Verify count
  const newCount = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c;
  if (newCount !== atomCount) {
    throw new Error(`Row count mismatch! Expected ${atomCount}, got ${newCount}`);
  }
  console.log(`Verified: ${newCount} rows copied.`);

  // 4. Drop old table
  db.exec("DROP TABLE knowledge_old");

  // 5. Recreate indexes
  console.log('Recreating indexes...');
  db.exec("CREATE INDEX idx_knowledge_scope_project ON knowledge(scope, project)");
  db.exec("CREATE INDEX idx_knowledge_type ON knowledge(type)");
  db.exec("CREATE INDEX idx_knowledge_status ON knowledge(status)");
  db.exec("CREATE INDEX idx_knowledge_confidence ON knowledge(confidence DESC) WHERE status = 'active'");
  db.exec("CREATE INDEX idx_knowledge_source_thread ON knowledge(source_thread_id)");

  // 6. Recreate FTS triggers
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

  // Trigram triggers
  db.exec(`
    CREATE TRIGGER knowledge_tri_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_trigram(rowid, content, tags)
      VALUES (new.id, new.content, new.tags);
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_tri_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_trigram(knowledge_trigram, rowid, content, tags)
      VALUES ('delete', old.id, old.content, old.tags);
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_tri_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_trigram(knowledge_trigram, rowid, content, tags)
      VALUES ('delete', old.id, old.content, old.tags);
      INSERT INTO knowledge_trigram(rowid, content, tags)
      VALUES (new.id, new.content, new.tags);
    END
  `);

  // 7. Add worker_id to jobs if missing
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN worker_id TEXT");
    console.log('Added worker_id column to jobs.');
  } catch {
    console.log('worker_id column already exists on jobs.');
  }
})();

// Re-enable foreign keys
db.pragma('foreign_keys = ON');

// Final verification
const finalCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status='active'").get().c;
console.log(`Migration complete. Active atoms: ${finalCount}`);

// Test new type constraint works
try {
  db.prepare("INSERT INTO knowledge (content, type) VALUES ('test', 'reasoning_chain')").run();
  const testId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  db.prepare("DELETE FROM knowledge WHERE id = ?").run(testId);
  console.log('CHECK constraint test passed: reasoning_chain type accepted.');
} catch (err) {
  console.error('CHECK constraint test FAILED:', err.message);
  process.exit(1);
}

try {
  db.prepare("INSERT INTO knowledge (content, type, source_type) VALUES ('test', 'fact', 'llm_extracted')").run();
  const testId = db.prepare("SELECT last_insert_rowid() as id").get().id;
  db.prepare("DELETE FROM knowledge WHERE id = ?").run(testId);
  console.log('CHECK constraint test passed: llm_extracted source_type accepted.');
} catch (err) {
  console.error('CHECK constraint test FAILED:', err.message);
  process.exit(1);
}

db.close();
console.log('Done.');
