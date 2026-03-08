/**
 * Backfill script - queues un-ingested JSONL sessions for worker processing.
 *
 * Usage:
 *   node backfill.js                    # Queue all un-ingested sessions
 *   node backfill.js --limit 10         # Queue at most 10 sessions
 *   node backfill.js --project Nurch    # Only sessions from projects matching "Nurch"
 *   node backfill.js --dry-run          # Preview without queueing
 *   node backfill.js --priority 3       # Set job priority (default: 1)
 */

import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const PROJECTS_DIR = join(HOME, ".claude", "projects");

// Parse args
const args = process.argv.slice(2);
let limit = Infinity;
let projectFilter = null;
let dryRun = false;
let priority = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === "--project" && args[i + 1]) { projectFilter = args[i + 1]; i++; }
  else if (args[i] === "--dry-run") { dryRun = true; }
  else if (args[i] === "--priority" && args[i + 1]) { priority = parseInt(args[i + 1], 10); i++; }
}

const db = new Database(DB_PATH, { timeout: 5000 });
loadSqliteVec(db);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Get all already-ingested source files
const ingestedFiles = new Set();
const threadFiles = db.prepare("SELECT source_file FROM threads WHERE source_file IS NOT NULL").all();
for (const t of threadFiles) {
  ingestedFiles.add(t.source_file);
}

// Also check pending/processing ingest jobs
const pendingJobs = db.prepare(`
  SELECT json_extract(payload, '$.transcript_path') as path
  FROM jobs WHERE type = 'ingest_thread' AND status IN ('pending', 'processing')
`).all();
for (const j of pendingJobs) {
  if (j.path) ingestedFiles.add(j.path);
}

console.log(`Already ingested or pending: ${ingestedFiles.size} files`);

// Scan all JSONL files
function scanProjects() {
  const results = [];
  let projectDirs;
  try {
    projectDirs = readdirSync(PROJECTS_DIR).filter(d => {
      try { return statSync(join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    console.error("Cannot read projects directory:", PROJECTS_DIR);
    return results;
  }

  for (const projDir of projectDirs) {
    if (projectFilter && !projDir.toLowerCase().includes(projectFilter.toLowerCase())) continue;

    const projPath = join(PROJECTS_DIR, projDir);
    const projectHash = createHash("sha256").update(projDir).digest("hex").slice(0, 16);

    // Get top-level JSONL files (skip subagent files)
    let files;
    try {
      files = readdirSync(projPath).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const f of files) {
      const fullPath = join(projPath, f);
      if (ingestedFiles.has(fullPath)) continue;

      try {
        const size = statSync(fullPath).size;
        if (size < 500) continue; // Skip tiny files
        results.push({
          path: fullPath,
          project: projectHash,
          projectName: projDir,
          size,
          filename: f,
        });
      } catch { continue; }
    }

    // Also check for JSONL in session subdirectories (but not subagent files)
    try {
      const subDirs = readdirSync(projPath).filter(d => {
        try { return statSync(join(projPath, d)).isDirectory() && !d.includes("subagent"); } catch { return false; }
      });

      for (const subDir of subDirs) {
        const subPath = join(projPath, subDir);
        try {
          const subFiles = readdirSync(subPath).filter(f => f.endsWith(".jsonl") && !f.includes("subagent"));
          for (const f of subFiles) {
            const fullPath = join(subPath, f);
            if (ingestedFiles.has(fullPath)) continue;
            try {
              const size = statSync(fullPath).size;
              if (size < 500) continue;
              results.push({
                path: fullPath,
                project: projectHash,
                projectName: projDir,
                size,
                filename: `${subDir}/${f}`,
              });
            } catch { continue; }
          }
        } catch { continue; }
      }
    } catch { /* no subdirs */ }
  }

  return results;
}

const candidates = scanProjects();

// Sort by size (smaller first for faster processing)
candidates.sort((a, b) => a.size - b.size);

// Apply limit
const toQueue = candidates.slice(0, limit);

console.log(`\nFound ${candidates.length} un-ingested sessions`);
if (limit < Infinity) console.log(`Limiting to ${limit}`);
if (projectFilter) console.log(`Filtering to projects matching: ${projectFilter}`);
console.log(`Priority: ${priority}`);
console.log();

// Group by project for summary
const byProject = {};
for (const c of toQueue) {
  (byProject[c.projectName] = byProject[c.projectName] || []).push(c);
}

for (const [proj, files] of Object.entries(byProject)) {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`  ${proj}: ${files.length} files (${(totalSize / 1024).toFixed(0)} KB)`);
}

console.log(`\nTotal: ${toQueue.length} sessions to queue`);

if (dryRun) {
  console.log("\n[DRY RUN] No jobs queued.");
  db.close();
  process.exit(0);
}

if (toQueue.length === 0) {
  console.log("Nothing to queue.");
  db.close();
  process.exit(0);
}

// Queue jobs
const insertJob = db.prepare(`
  INSERT INTO jobs (type, payload, priority, created_at)
  VALUES ('ingest_thread', json_object('transcript_path', ?, 'project', ?, 'project_name', ?), ?, datetime('now'))
`);

let queued = 0;
const queueAll = db.transaction(() => {
  for (const item of toQueue) {
    insertJob.run(item.path, item.project, item.projectName, priority);
    queued++;
  }
});

queueAll();

console.log(`\nQueued ${queued} ingest jobs at priority ${priority}.`);
console.log("Worker will process them automatically. Monitor with: tail -f ~/.claude/memory-server/logs/worker.log");

db.close();
