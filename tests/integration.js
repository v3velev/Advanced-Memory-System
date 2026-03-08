/**
 * Integration test: Queue a real transcript as a job and run the worker pipeline.
 * Tests the full ingest_thread flow end-to-end.
 *
 * Run: node test-integration.js
 */

import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");

// Pick a test transcript
const TEST_TRANSCRIPT = join(HOME, ".claude/projects/-Users-v3velev-Duda-Learning-AI/37a37864-9b41-4df6-9e65-5b8b8110ab06.jsonl");

if (!existsSync(TEST_TRANSCRIPT)) {
  console.error("Test transcript not found:", TEST_TRANSCRIPT);
  process.exit(1);
}

const db = new Database(DB_PATH, { timeout: 5000 });
loadSqliteVec(db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Record state before
const beforeAtoms = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status='active'").get().c;
const beforeThreads = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
const beforeTurns = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;

console.log(`Before: ${beforeAtoms} atoms, ${beforeThreads} threads, ${beforeTurns} turns`);

// Queue an ingest_thread job
const payload = JSON.stringify({
  transcript_path: TEST_TRANSCRIPT,
  project: "test-project-duda",
  project_name: "Duda-Learning-AI",
});

db.prepare(`
  INSERT INTO jobs (type, payload, priority) VALUES ('ingest_thread', ?, 10)
`).run(payload);

const jobId = db.prepare("SELECT last_insert_rowid() as id").get().id;
console.log(`Queued job #${jobId}`);
console.log("Starting worker for single job processing...\n");

// Import and run the worker's pipeline directly
// We'll do this by loading .env and running ingestThread
import { readFileSync as rfs } from "fs";

// Load env
const envPath = join(SERVER_DIR, ".env");
if (existsSync(envPath)) {
  const lines = rfs(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// Dynamically import worker functions - but since worker.js runs as main, we can't import it.
// Instead, test by starting the worker and waiting for it to process the job.

import { execFile } from "child_process";

console.log("Launching worker process to handle the job...");
const workerProcess = execFile("node", [join(SERVER_DIR, "worker.js")], {
  env: { ...process.env, CLAUDECODE: "" },
  timeout: 180000,
}, () => {});

// Poll the job status
let attempts = 0;
const maxAttempts = 60; // 60 * 3s = 180s max

const checkInterval = setInterval(() => {
  attempts++;
  const job = db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(jobId);

  if (!job) {
    console.log("Job not found!");
    cleanup();
    return;
  }

  if (job.status === "done") {
    console.log(`\nJob completed after ~${attempts * 3}s`);
    showResults();
    cleanup();
  } else if (job.status === "failed") {
    console.error(`\nJob FAILED: ${job.error}`);
    cleanup();
  } else if (attempts >= maxAttempts) {
    console.error(`\nJob timed out (status: ${job.status})`);
    cleanup();
  } else if (attempts % 5 === 0) {
    process.stdout.write(`  Waiting... (${job.status}, ${attempts * 3}s)\n`);
  }
}, 3000);

function showResults() {
  const afterAtoms = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status='active'").get().c;
  const afterThreads = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
  const afterTurns = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;

  console.log(`\nAfter:  ${afterAtoms} atoms (+${afterAtoms - beforeAtoms}), ${afterThreads} threads (+${afterThreads - beforeThreads}), ${afterTurns} turns (+${afterTurns - beforeTurns})`);

  // Show new atoms
  const newAtoms = db.prepare(`
    SELECT id, type, content, source_type, impasse_severity
    FROM knowledge
    WHERE source_type = 'llm_extracted'
    ORDER BY id DESC
    LIMIT 10
  `).all();

  if (newAtoms.length > 0) {
    console.log("\nNew extracted atoms:");
    for (const a of newAtoms) {
      console.log(`  #${a.id} [${a.type}] (impasse: ${a.impasse_severity}): ${a.content.slice(0, 100)}...`);
    }
  }

  // Show thread
  const thread = db.prepare("SELECT * FROM threads ORDER BY created_at DESC LIMIT 1").get();
  if (thread) {
    console.log(`\nThread: ${thread.id} | priority=${thread.priority} | turns=${thread.turn_count} | corrections=${thread.has_corrections} decisions=${thread.has_decisions} debugging=${thread.has_debugging}`);
  }

  // Check key exchanges
  const keyExchanges = db.prepare(
    "SELECT COUNT(*) as c FROM turns WHERE thread_id = ? AND is_key_exchange = 1"
  ).get(thread?.id || "").c;
  console.log(`Key exchanges marked: ${keyExchanges}`);

  console.log("\nINTEGRATION TEST PASSED");
}

function cleanup() {
  clearInterval(checkInterval);
  try { workerProcess.kill(); } catch {}
  db.close();
  process.exit(0);
}
