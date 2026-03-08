#!/usr/bin/env node
/**
 * Migration: Fix knowledge table schema.
 * - Add superseded_by column (correction workflow)
 * - Add git_staleness column (git-aware staleness)
 * - Fix status CHECK constraint: replace 'rejected' with 'superseded'
 * - Fix FTS triggers to include tags
 * - Fix knowledge_fts_exact to include tags column
 *
 * Run: node migrate-schema-fix.cjs
 */

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory.db');
const BACKUP_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', `memory-backup-premigrate-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.db`);

// Back up DB first
console.log(`Backing up database to ${path.basename(BACKUP_PATH)}...`);
fs.copyFileSync(DB_PATH, BACKUP_PATH);
console.log('Backup complete.');

const db = new Database(DB_PATH, { timeout: 5000 });
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

// Record pre-migration counts
const preCounts = {
  knowledge: db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c,
  threads: db.prepare("SELECT COUNT(*) as c FROM threads").get().c,
  turns: db.prepare("SELECT COUNT(*) as c FROM turns").get().c,
};
console.log(`Pre-migration counts: knowledge=${preCounts.knowledge}, threads=${preCounts.threads}, turns=${preCounts.turns}`);

db.transaction(() => {
  // 1. Drop FTS triggers
  console.log('Dropping FTS triggers...');
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ai");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_ad");
  db.exec("DROP TRIGGER IF EXISTS knowledge_fts_au");

  // 2. Rename knowledge table
  console.log('Recreating knowledge table...');
  db.exec("ALTER TABLE knowledge RENAME TO knowledge_old");

  // 3. Create knowledge table with fixed schema
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
      decay_rate REAL NOT NULL DEFAULT 0.30,
      last_accessed_at DATETIME,
      injection_success_rate REAL,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
        'active', 'superseded', 'archived'
      )),
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      git_commit_hash TEXT,
      git_project_dir TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      impasse_severity REAL DEFAULT 0.0,
      last_reinforced_at DATETIME,
      last_injected_at DATETIME,
      contradiction_note TEXT,
      superseded_by INTEGER REFERENCES knowledge(id),
      git_staleness TEXT
    )
  `);

  // 4. Copy data from old table
  console.log('Copying data...');
  db.exec(`
    INSERT INTO knowledge (
      id, content, type, scope, project, scope_path, tags, concepts,
      source_type, source_session, source_thread_id, confidence, reinforcement_count,
      decay_rate, last_accessed_at, injection_success_rate, metadata,
      status, created_at, updated_at,
      git_commit_hash, git_project_dir, access_count, impasse_severity,
      last_reinforced_at, last_injected_at, contradiction_note
    )
    SELECT
      id, content, type, scope, project, scope_path, tags, concepts,
      source_type, source_session, source_thread_id, confidence, reinforcement_count,
      decay_rate, last_accessed_at, injection_success_rate, metadata,
      CASE WHEN status = 'rejected' THEN 'archived' ELSE status END,
      created_at, updated_at,
      git_commit_hash, git_project_dir, access_count, impasse_severity,
      last_reinforced_at, last_injected_at, contradiction_note
    FROM knowledge_old
  `);

  // 5. Verify row count
  const newCount = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c;
  if (newCount !== preCounts.knowledge) {
    throw new Error(`Row count mismatch! Expected ${preCounts.knowledge}, got ${newCount}`);
  }
  console.log(`Verified: ${newCount} rows copied.`);

  // 6. Drop old table
  db.exec("DROP TABLE knowledge_old");

  // 7. Recreate indexes
  console.log('Recreating indexes...');
  db.exec("CREATE INDEX idx_knowledge_scope_project ON knowledge(scope, project)");
  db.exec("CREATE INDEX idx_knowledge_type ON knowledge(type)");
  db.exec("CREATE INDEX idx_knowledge_status ON knowledge(status)");
  db.exec("CREATE INDEX idx_knowledge_confidence ON knowledge(confidence DESC) WHERE status = 'active'");
  db.exec("CREATE INDEX idx_knowledge_source_thread ON knowledge(source_thread_id)");

  // 8. Drop and recreate knowledge_fts_exact WITH tags column
  console.log('Rebuilding knowledge_fts_exact with tags column...');
  db.exec("DROP TABLE IF EXISTS knowledge_fts_exact");
  db.exec(`
    CREATE VIRTUAL TABLE knowledge_fts_exact USING fts5(
      content, tags,
      content='knowledge',
      content_rowid='id',
      tokenize='unicode61'
    )
  `);

  // 9. Recreate FTS triggers with tags in BOTH fts tables
  console.log('Recreating FTS triggers with tags...');
  db.exec(`
    CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
      INSERT INTO knowledge_fts_exact(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
    END
  `);
  db.exec(`
    CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
      INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      INSERT INTO knowledge_fts_exact(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END
  `);

  // 10. Update schema version
  db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (1, datetime('now'))").run();
})();

// Rebuild FTS indexes OUTSIDE transaction (content-sync tables need the final table state)
console.log('Rebuilding FTS indexes...');
db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
db.exec("INSERT INTO knowledge_fts_exact(knowledge_fts_exact) VALUES('rebuild')");

db.pragma('foreign_keys = ON');

// Verification
console.log('\n--- Verification ---');

// Check new columns exist
const cols = db.prepare("PRAGMA table_info(knowledge)").all().map(c => c.name);
const requiredCols = ['superseded_by', 'git_staleness'];
for (const col of requiredCols) {
  if (cols.includes(col)) {
    console.log(`Column '${col}': OK`);
  } else {
    console.error(`Column '${col}': MISSING!`);
    process.exit(1);
  }
}

// Test status='superseded' constraint
try {
  db.prepare(`
    INSERT INTO knowledge (content, type, status, superseded_by, git_staleness)
    VALUES ('test-migration-verify', 'fact', 'superseded', NULL, 'test-staleness')
  `).run();
  const testId = db.prepare("SELECT last_insert_rowid() as id").get().id;

  // Test FTS includes tags
  db.prepare("UPDATE knowledge SET tags = 'migrationtesttag' WHERE id = ?").run(testId);
  const ftsMatch = db.prepare("SELECT COUNT(*) as c FROM knowledge_fts WHERE tags MATCH 'migrationtesttag'").get().c;
  const ftsExactMatch = db.prepare("SELECT COUNT(*) as c FROM knowledge_fts_exact WHERE tags MATCH 'migrationtesttag'").get().c;

  // Clean up
  db.prepare("DELETE FROM knowledge WHERE id = ?").run(testId);

  console.log(`Status 'superseded' constraint: OK`);
  console.log(`FTS tags (knowledge_fts): ${ftsMatch > 0 ? 'OK' : 'FAILED'}`);
  console.log(`FTS tags (knowledge_fts_exact): ${ftsExactMatch > 0 ? 'OK' : 'FAILED'}`);

  if (ftsMatch === 0 || ftsExactMatch === 0) {
    console.error('FTS tag indexing FAILED!');
    process.exit(1);
  }
} catch (err) {
  console.error('Verification FAILED:', err.message);
  process.exit(1);
}

// Verify 'rejected' status is blocked
try {
  db.prepare("INSERT INTO knowledge (content, type, status) VALUES ('test', 'fact', 'rejected')").run();
  console.error("Status 'rejected' should be blocked but was accepted!");
  process.exit(1);
} catch {
  console.log("Status 'rejected' correctly blocked.");
}

// Post-migration counts
const postCounts = {
  knowledge: db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c,
  threads: db.prepare("SELECT COUNT(*) as c FROM threads").get().c,
  turns: db.prepare("SELECT COUNT(*) as c FROM turns").get().c,
};
console.log(`\nPost-migration counts: knowledge=${postCounts.knowledge}, threads=${postCounts.threads}, turns=${postCounts.turns}`);

if (postCounts.knowledge !== preCounts.knowledge) {
  console.error('Knowledge count changed! Migration may have lost data.');
  process.exit(1);
}

db.close();
console.log('\nMigration complete. All checks passed.');
