#!/usr/bin/env node
// Migration: Add non-stemmed FTS5 index for exact identifier matching
// knowledge_fts uses 'porter unicode61' which mangles identifiers like useInfiniteQuery
// knowledge_fts_exact uses just 'unicode61' for exact token matching

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(require("os").homedir(), ".claude", "memory-server", "data", "memory.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

console.log("Creating knowledge_fts_exact (non-stemmed FTS5 index)...");

db.exec(`
  DROP TRIGGER IF EXISTS knowledge_fts_exact_ai;
  DROP TRIGGER IF EXISTS knowledge_fts_exact_ad;
  DROP TRIGGER IF EXISTS knowledge_fts_exact_au;
  DROP TABLE IF EXISTS knowledge_fts_exact;

  CREATE VIRTUAL TABLE knowledge_fts_exact USING fts5(
    content, tags,
    content='knowledge',
    content_rowid='id',
    tokenize='unicode61'
  );

  CREATE TRIGGER knowledge_fts_exact_ai AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts_exact(rowid, content, tags)
    VALUES (new.id, new.content, COALESCE(new.tags,''));
  END;

  CREATE TRIGGER knowledge_fts_exact_ad AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
    VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
  END;

  CREATE TRIGGER knowledge_fts_exact_au AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts_exact(knowledge_fts_exact, rowid, content, tags)
    VALUES ('delete', old.id, old.content, COALESCE(old.tags,''));
    INSERT INTO knowledge_fts_exact(rowid, content, tags)
    VALUES (new.id, new.content, COALESCE(new.tags,''));
  END;
`);

// Populate from existing knowledge data
const atoms = db.prepare("SELECT id, content, tags FROM knowledge WHERE status = 'active'").all();
const insert = db.prepare("INSERT INTO knowledge_fts_exact(rowid, content, tags) VALUES (?, ?, ?)");
const populate = db.transaction(() => {
  for (const atom of atoms) {
    insert.run(atom.id, atom.content, atom.tags || "");
  }
});
populate();

console.log(`Populated knowledge_fts_exact with ${atoms.length} active atoms.`);
db.close();
console.log("Done.");
