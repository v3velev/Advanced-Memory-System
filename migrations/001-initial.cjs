#!/usr/bin/env node
// migrate.js - Database migration for memory system rebuild (Steps 1-3)
// Ref: SYSTEM.md Sections 16, 24

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(require('os').homedir(), '.claude', 'memory-server', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const DB_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory.db');
const BACKUP_PATH = path.join(require('os').homedir(), '.claude', 'memory-server', 'data', 'memory-backup-premigrate.db');

const TYPE_DECAY_RATES = {
  preference: 0.15,
  decision: 0.15,
  architecture: 0.15,
  pattern: 0.30,
  reasoning_chain: 0.30,
  anti_pattern: 0.30,
  debugging: 0.40,
  fact: 0.40,
  workaround: 0.40,
  tool_config: 0.40,
  correction: 0.50,
};

async function getEmbeddings(texts) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: 1536,
  });
  return response.data.map(d => d.embedding);
}

function floatArrayToBuffer(arr) {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i], i * 4);
  }
  return buf;
}

async function main() {
  console.log('=== Memory System Migration ===\n');

  // 2a. Backup DB
  console.log('Step 2a: Backing up database...');
  const db = new Database(DB_PATH, { timeout: 5000 });
  const backupDest = fs.existsSync(BACKUP_PATH)
    ? BACKUP_PATH.replace('.db', `-${Date.now()}.db`)
    : BACKUP_PATH;
  db.backup(backupDest);
  console.log(`  Backup saved to ${backupDest}`);

  // 2b. Load sqlite-vec extension
  console.log('Step 2b: Loading sqlite-vec extension...');
  try {
    sqliteVec.load(db);
    console.log('  sqlite-vec loaded successfully');
  } catch (err) {
    console.error('FATAL: Failed to load sqlite-vec:', err.message);
    process.exit(1);
  }

  // Set pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // 2c. Create new tables
  console.log('Step 2c: Creating new tables...');

  db.exec(`
    -- THREADS
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_name TEXT,
      turn_count INTEGER NOT NULL,
      timestamp_start TEXT,
      timestamp_end TEXT,
      priority TEXT DEFAULT 'routine' CHECK(priority IN ('critical','significant','routine')),
      has_corrections INTEGER DEFAULT 0,
      has_decisions INTEGER DEFAULT 0,
      has_debugging INTEGER DEFAULT 0,
      source_file TEXT NOT NULL,
      file_mtime REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project);
    CREATE INDEX IF NOT EXISTS idx_threads_priority ON threads(priority, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_timestamp ON threads(timestamp_start, timestamp_end);
  `);
  console.log('  Created: threads');

  db.exec(`
    -- TURNS
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_number INTEGER NOT NULL,
      user_content TEXT,
      assistant_content TEXT,
      timestamp TEXT,
      is_key_exchange INTEGER DEFAULT 0,
      key_exchange_type TEXT,
      tool_calls_count INTEGER DEFAULT 0,
      has_error INTEGER DEFAULT 0,
      embed_status TEXT DEFAULT 'pending' CHECK(embed_status IN ('pending','done','failed')),
      UNIQUE(thread_id, turn_number)
    );
    CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, turn_number);
    CREATE INDEX IF NOT EXISTS idx_turns_key ON turns(is_key_exchange) WHERE is_key_exchange = 1;
  `);
  console.log('  Created: turns');

  db.exec(`
    -- TURN EMBEDDINGS (vec0)
    CREATE VIRTUAL TABLE IF NOT EXISTS turn_embeddings USING vec0(
      turn_id INTEGER PRIMARY KEY,
      embedding float[1536] distance_metric=cosine
    );
  `);
  console.log('  Created: turn_embeddings');

  db.exec(`
    -- TURNS FTS
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      content,
      content='turns',
      content_rowid='id',
      tokenize='porter unicode61'
    );
  `);
  console.log('  Created: turns_fts');

  // FTS sync triggers for turns
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
      INSERT INTO turns_fts(rowid, content)
      VALUES (new.id, COALESCE(new.user_content,'') || ' ' || COALESCE(new.assistant_content,''));
    END;

    CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content)
      VALUES('delete', old.id, COALESCE(old.user_content,'') || ' ' || COALESCE(old.assistant_content,''));
    END;

    CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE ON turns BEGIN
      INSERT INTO turns_fts(turns_fts, rowid, content)
      VALUES('delete', old.id, COALESCE(old.user_content,'') || ' ' || COALESCE(old.assistant_content,''));
      INSERT INTO turns_fts(rowid, content)
      VALUES (new.id, COALESCE(new.user_content,'') || ' ' || COALESCE(new.assistant_content,''));
    END;
  `);
  console.log('  Created: turns_fts triggers');

  db.exec(`
    -- KNOWLEDGE EMBEDDINGS (vec0)
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_embeddings USING vec0(
      atom_id INTEGER PRIMARY KEY,
      embedding float[1536] distance_metric=cosine
    );
  `);
  console.log('  Created: knowledge_embeddings');

  // Rebuild knowledge_fts: drop old (has concepts column), recreate with just content+tags
  console.log('  Rebuilding knowledge_fts (removing concepts column)...');
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_fts_ai;
    DROP TRIGGER IF EXISTS knowledge_fts_ad;
    DROP TRIGGER IF EXISTS knowledge_fts_au;
    DROP TABLE IF EXISTS knowledge_fts;

    CREATE VIRTUAL TABLE knowledge_fts USING fts5(
      content, tags,
      content='knowledge',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END;

    CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
    END;

    CREATE TRIGGER knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags)
      VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
      INSERT INTO knowledge_fts(rowid, content, tags)
      VALUES (new.id, new.content, COALESCE(new.tags,''));
    END;
  `);

  // Rebuild FTS index from existing knowledge data
  const activeAtoms = db.prepare('SELECT id, content, tags FROM knowledge WHERE status = ?').all('active');
  const insertFts = db.prepare('INSERT INTO knowledge_fts(rowid, content, tags) VALUES (?, ?, ?)');
  const rebuildFts = db.transaction(() => {
    for (const atom of activeAtoms) {
      insertFts.run(atom.id, atom.content, atom.tags || '');
    }
  });
  rebuildFts();
  console.log(`  Rebuilt knowledge_fts with ${activeAtoms.length} active atoms`);

  db.exec(`
    -- RECOVERY BUFFER
    CREATE TABLE IF NOT EXISTS recovery_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      session_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_project ON recovery_buffer(project, created_at DESC);
  `);
  console.log('  Created: recovery_buffer');

  db.exec(`
    -- CONNECTIONS
    CREATE TABLE IF NOT EXISTS connections (
      thread_a TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      thread_b TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      similarity REAL NOT NULL,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (thread_a, thread_b)
    );
  `);
  console.log('  Created: connections');

  db.exec(`
    -- INJECTION EVENTS
    CREATE TABLE IF NOT EXISTS injection_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      atom_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      session_file TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('post_tool_use','user_prompt_submit','session_start_compact')),
      injected_at TEXT NOT NULL DEFAULT (datetime('now')),
      was_referenced INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_injection_atom ON injection_events(atom_id);
    CREATE INDEX IF NOT EXISTS idx_injection_session ON injection_events(session_file);
  `);
  console.log('  Created: injection_events');

  // Recreate jobs table with new types
  console.log('  Recreating jobs table with new job types...');
  db.exec(`
    DROP TABLE IF EXISTS jobs;
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN (
        'ingest_thread','consolidate','archive_stale','discover_connections'
      )),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending','processing','done','failed'
      )),
      payload TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      retry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, created_at ASC);
  `);
  console.log('  Created: jobs (new schema)');

  db.exec(`
    -- STATS DAILY
    CREATE TABLE IF NOT EXISTS stats_daily (
      date TEXT PRIMARY KEY,
      atoms_created INTEGER DEFAULT 0,
      atoms_deduplicated INTEGER DEFAULT 0,
      atoms_archived INTEGER DEFAULT 0,
      threads_ingested INTEGER DEFAULT 0,
      api_errors INTEGER DEFAULT 0,
      extraction_time_avg_ms INTEGER DEFAULT 0,
      total_atoms INTEGER DEFAULT 0,
      total_threads INTEGER DEFAULT 0,
      db_size_bytes INTEGER DEFAULT 0
    );
  `);
  console.log('  Created: stats_daily');

  db.exec(`
    -- SCHEMA VERSION
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT,
      embedding_model TEXT
    );
  `);
  console.log('  Created: schema_version');

  // 2d. Add new columns to knowledge table
  console.log('\nStep 2d: Adding new columns to knowledge...');
  const addColumn = (col, type, dflt) => {
    try {
      const stmt = dflt !== undefined
        ? `ALTER TABLE knowledge ADD COLUMN ${col} ${type} DEFAULT ${dflt}`
        : `ALTER TABLE knowledge ADD COLUMN ${col} ${type}`;
      db.exec(stmt);
      console.log(`  Added: ${col}`);
    } catch (err) {
      if (err.message.includes('duplicate column')) {
        console.log(`  Skipped (already exists): ${col}`);
      } else {
        throw err;
      }
    }
  };

  addColumn('decay_rate', 'REAL', undefined);
  addColumn('impasse_severity', 'REAL', '0.0');
  addColumn('last_injected_at', 'TEXT', undefined);
  addColumn('contradiction_note', 'TEXT', undefined);

  // 2e. Backfill decay_rate on existing atoms
  console.log('\nStep 2e: Backfilling decay_rate on existing atoms...');
  const updateDecay = db.prepare('UPDATE knowledge SET decay_rate = ? WHERE type = ? AND decay_rate IS NULL');
  const backfillDecay = db.transaction(() => {
    for (const [type, rate] of Object.entries(TYPE_DECAY_RATES)) {
      const result = updateDecay.run(rate, type);
      if (result.changes > 0) {
        console.log(`  ${type}: ${result.changes} atoms set to ${rate}`);
      }
    }
  });
  backfillDecay();

  // 2f. Drop obsolete tables
  console.log('\nStep 2f: Dropping obsolete tables...');
  // Drop FTS5 parent first (auto-drops sub-tables), then concept_synonyms
  for (const table of ['knowledge_trigram', 'concept_synonyms']) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
      console.log(`  Dropped: ${table}`);
    } catch (err) {
      console.log(`  Skipped ${table}: ${err.message}`);
    }
  }

  // 2g. Drop other unused tables (all confirmed 0 rows)
  console.log('\nStep 2g: Dropping unused empty tables...');
  for (const table of ['corrections', 'feedback_events', 'feedback_prompts', 'knowledge_sightings', 'retrieval_events']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
    console.log(`  Dropped: ${table}`);
  }

  // 2h. Clean garbage/duplicate atoms
  console.log('\nStep 2h: Cleaning garbage/duplicate atoms...');
  // Find exact duplicate content among active atoms, keep highest confidence
  const dupes = db.prepare(`
    SELECT content, COUNT(*) as cnt
    FROM knowledge WHERE status = 'active'
    GROUP BY content HAVING cnt > 1
  `).all();

  if (dupes.length > 0) {
    const archiveDupe = db.prepare(`
      UPDATE knowledge SET status = 'archived'
      WHERE content = ? AND status = 'active'
      AND id != (
        SELECT id FROM knowledge
        WHERE content = ? AND status = 'active'
        ORDER BY confidence DESC, updated_at DESC
        LIMIT 1
      )
    `);
    let totalCleaned = 0;
    const cleanDupes = db.transaction(() => {
      for (const { content, cnt } of dupes) {
        const result = archiveDupe.run(content, content);
        totalCleaned += result.changes;
      }
    });
    cleanDupes();
    console.log(`  Archived ${totalCleaned} duplicate atoms`);
  } else {
    console.log('  No duplicate atoms found');
  }

  // 2i. Generate embeddings for existing clean atoms
  console.log('\nStep 2i: Generating embeddings for active atoms...');
  if (!process.env.OPENAI_API_KEY) {
    console.error('  WARNING: OPENAI_API_KEY not set, skipping embeddings');
  } else {
    const atoms = db.prepare('SELECT id, content, tags FROM knowledge WHERE status = ?').all('active');
    console.log(`  ${atoms.length} active atoms to embed`);

    const insertEmbed = db.prepare('INSERT INTO knowledge_embeddings (atom_id, embedding) VALUES (CAST(? AS INTEGER), ?)');
    const BATCH_SIZE = 20;

    for (let i = 0; i < atoms.length; i += BATCH_SIZE) {
      const batch = atoms.slice(i, i + BATCH_SIZE);
      const texts = batch.map(a => {
        const tagStr = a.tags ? ` [${a.tags}]` : '';
        return `${a.content}${tagStr}`;
      });

      try {
        const embeddings = await getEmbeddings(texts);
        const insertBatch = db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            insertEmbed.run(batch[j].id, floatArrayToBuffer(embeddings[j]));
          }
        });
        insertBatch();
        console.log(`  Embedded batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(atoms.length / BATCH_SIZE)} (${batch.length} atoms)`);
      } catch (err) {
        console.error(`  ERROR embedding batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // 2j. Insert schema_version row
  console.log('\nStep 2j: Inserting schema_version...');
  db.prepare(`
    INSERT OR REPLACE INTO schema_version (version, description, embedding_model)
    VALUES (1, 'Initial rebuild schema', 'text-embedding-3-small')
  `).run();
  console.log('  schema_version v1 inserted');

  // 2k. Foreign keys pragma (already set above, just confirm)
  const fkStatus = db.pragma('foreign_keys');
  console.log(`\nStep 2k: foreign_keys = ${fkStatus[0].foreign_keys}`);

  db.close();
  console.log('\n=== Migration complete ===');
}

main().catch(err => {
  console.error('FATAL migration error:', err);
  process.exit(1);
});
