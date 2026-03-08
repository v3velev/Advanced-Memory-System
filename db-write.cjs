#!/usr/bin/env node
// db-write.js - parameterized SQL insert for hook scripts
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(require('os').homedir(), '.claude/memory-server/data/memory.db');
const db = new Database(DB_PATH, { timeout: 5000 });
const [table, ...args] = process.argv.slice(2);
let content = '';
process.stdin.on('data', d => content += d);
process.stdin.on('end', () => {
  try {
    if (table === 'recovery_buffer') {
      const [project, sessionId] = args;
      db.prepare("INSERT INTO recovery_buffer (project, session_id, content, created_at) VALUES (?, ?, ?, datetime('now'))")
        .run(project, sessionId, content);
    }
  } catch (err) {
    process.stderr.write(`db-write error: ${err.message}\n`);
  }
  db.close();
});
