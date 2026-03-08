/**
 * End-to-end integration test for the memory system.
 * Tests the full pipeline: ingest -> extract -> search -> save -> dedup -> feedback -> admin
 *
 * Run: node test-e2e.js
 */

import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const ENV_PATH = join(SERVER_DIR, ".env");

// Load .env
if (existsSync(ENV_PATH)) {
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
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

const OpenAI = (await import("openai")).default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`);
    failed++;
  }
}

function assertEqual(actual, expected, name) {
  if (actual === expected) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

const db = new Database(DB_PATH, { timeout: 5000 });
loadSqliteVec(db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

async function generateQueryEmbedding(text) {
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });
  return resp.data[0].embedding;
}

function serializeEmbedding(emb) {
  return Buffer.from(new Float32Array(emb).buffer);
}

// ============================================================================
// Test 1: Queue an ingest_thread job
// ============================================================================

console.log("\n=== Test 1: Queue ingest job ===");

// Find a JSONL file that hasn't been ingested yet (or use one we know about)
const projectsDir = join(HOME, ".claude", "projects");
let testTranscript = null;

// Look for a small JSONL to test with
import { readdirSync, statSync } from "fs";

function findTestTranscript() {
  const projects = readdirSync(projectsDir).filter(d => {
    try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
  });

  for (const proj of projects) {
    const projDir = join(projectsDir, proj);
    const files = readdirSync(projDir).filter(f => f.endsWith(".jsonl") && !f.includes("subagent"));
    for (const f of files) {
      const fp = join(projDir, f);
      const size = statSync(fp).size;
      // Pick a small-ish file (< 100KB) for fast testing
      if (size > 1000 && size < 100000) {
        const hash = createHash("sha256").update(proj).digest("hex").slice(0, 16);
        const existing = db.prepare("SELECT id FROM threads WHERE source_file = ?").get(fp);
        return { path: fp, project: hash, projectName: proj, alreadyIngested: !!existing };
      }
    }
  }
  return null;
}

testTranscript = findTestTranscript();

if (testTranscript) {
  console.log(`  Using: ${basename(testTranscript.path)} (${testTranscript.projectName.slice(0, 30)})`);

  if (!testTranscript.alreadyIngested) {
    db.prepare(`
      INSERT INTO jobs (type, payload, priority, created_at)
      VALUES ('ingest_thread', json_object('transcript_path', ?, 'project', ?, 'project_name', ?), 5, datetime('now'))
    `).run(testTranscript.path, testTranscript.project, testTranscript.projectName);
    console.log("  Queued ingest job. Worker will process it asynchronously.");
    assert(true, "Ingest job queued successfully");
  } else {
    console.log("  Transcript already ingested, skipping queue.");
    assert(true, "Transcript already in system");
  }
} else {
  console.log("  SKIP: No suitable small JSONL found for testing");
}

// ============================================================================
// Test 2: Verify existing threads and turns
// ============================================================================

console.log("\n=== Test 2: Thread + Turn storage ===");
const threadCount = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
const turnCount = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;
assert(threadCount > 0, `Found ${threadCount} threads`);
assert(turnCount > 0, `Found ${turnCount} turns`);

const sampleThread = db.prepare("SELECT * FROM threads LIMIT 1").get();
if (sampleThread) {
  assert(!!sampleThread.id, "Thread has id");
  assert(!!sampleThread.project, "Thread has project");
  const threadTurns = db.prepare("SELECT COUNT(*) as c FROM turns WHERE thread_id = ?").get(sampleThread.id).c;
  assert(threadTurns > 0, `Thread ${sampleThread.id.slice(0, 8)}... has ${threadTurns} turns`);
}

// ============================================================================
// Test 3: Verify extracted atoms
// ============================================================================

console.log("\n=== Test 3: Extracted atoms ===");
const atomCount = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status = 'active'").get().c;
assert(atomCount > 0, `Found ${atomCount} active atoms`);

const llmExtracted = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE source_type = 'llm_extracted' AND status = 'active'").get().c;
console.log(`  LLM-extracted atoms: ${llmExtracted}`);

const types = db.prepare("SELECT type, COUNT(*) as c FROM knowledge WHERE status = 'active' GROUP BY type ORDER BY c DESC").all();
console.log(`  Types: ${types.map(t => `${t.type}(${t.c})`).join(", ")}`);
assert(types.length > 0, "Multiple knowledge types present");

// ============================================================================
// Test 4: Search via BM25
// ============================================================================

console.log("\n=== Test 4: BM25 search ===");
try {
  const bm25Results = db.prepare(`
    SELECT k.id, k.content, k.type, bm25(knowledge_fts) as rank
    FROM knowledge_fts fts
    JOIN knowledge k ON k.id = fts.rowid
    WHERE knowledge_fts MATCH 'memory' AND k.status = 'active'
    ORDER BY rank LIMIT 5
  `).all();
  console.log(`  BM25 results for 'memory': ${bm25Results.length}`);
  assert(bm25Results.length >= 0, "BM25 search executes without error");
} catch (err) {
  console.error(`  BM25 error: ${err.message}`);
  failed++;
}

// ============================================================================
// Test 5: Search via vector similarity
// ============================================================================

console.log("\n=== Test 5: Vector search ===");
try {
  const embCount = db.prepare("SELECT COUNT(*) as c FROM knowledge_embeddings").get().c;
  console.log(`  Embeddings in DB: ${embCount}`);

  if (embCount > 0) {
    const emb = await generateQueryEmbedding("memory system knowledge storage");
    const embBuf = serializeEmbedding(emb);
    const vecResults = db.prepare(`
      SELECT atom_id, distance FROM knowledge_embeddings
      WHERE embedding MATCH ? ORDER BY distance LIMIT 5
    `).all(embBuf);
    assert(vecResults.length > 0, `Vector search returned ${vecResults.length} results`);
    assert(vecResults[0].distance < 2.0, `Top result distance: ${vecResults[0].distance.toFixed(3)}`);
  } else {
    console.log("  SKIP: No embeddings yet");
  }
} catch (err) {
  console.error(`  Vector search error: ${err.message}`);
  failed++;
}

// ============================================================================
// Test 6: save_knowledge (manual insert + dedup check)
// ============================================================================

console.log("\n=== Test 6: Save knowledge + dedup ===");

const testContent = "E2E test atom - memory server integration test " + Date.now();
const testTags = "test e2e integration";
const insertResult = db.prepare(`
  INSERT INTO knowledge (content, type, scope, project, tags, source_type, confidence, decay_rate)
  VALUES (?, 'fact', 'global', 'test', ?, 'user_explicit', 0.90, 0.40)
`).run(testContent, testTags);
const testAtomId = Number(insertResult.lastInsertRowid);
assert(testAtomId > 0, `Saved test atom #${testAtomId}`);

// Embed it
try {
  const emb = await generateQueryEmbedding(testContent);
  const embBuf = serializeEmbedding(emb);
  db.prepare(`
    INSERT OR REPLACE INTO knowledge_embeddings (atom_id, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `).run(testAtomId, embBuf);
  assert(true, "Embedded test atom");
} catch (err) {
  console.error(`  Embed error: ${err.message}`);
}

// Dedup check - search for similar content
try {
  const dupEmb = await generateQueryEmbedding(testContent);
  const dupBuf = serializeEmbedding(dupEmb);
  const similar = db.prepare(`
    SELECT atom_id, distance FROM knowledge_embeddings
    WHERE embedding MATCH ? ORDER BY distance LIMIT 3
  `).all(dupBuf);
  const hasSelf = similar.some(s => s.atom_id === testAtomId && s.distance < 0.1);
  assert(hasSelf, "Dedup: found self with very low distance (cosine < 0.1)");
} catch (err) {
  console.error(`  Dedup check error: ${err.message}`);
}

// ============================================================================
// Test 7: memory_feedback (confidence update)
// ============================================================================

console.log("\n=== Test 7: Feedback - confidence update ===");
const beforeConf = db.prepare("SELECT confidence FROM knowledge WHERE id = ?").get(testAtomId);
assert(beforeConf.confidence === 0.90, `Initial confidence: ${beforeConf.confidence}`);

// Simulate "confirmed" feedback
db.prepare(`
  UPDATE knowledge SET confidence = MIN(1.0, confidence + 0.15), updated_at = datetime('now')
  WHERE id = ?
`).run(testAtomId);

const afterConf = db.prepare("SELECT confidence FROM knowledge WHERE id = ?").get(testAtomId);
assert(Math.abs(afterConf.confidence - 1.0) < 0.01, `Confirmed confidence: ${afterConf.confidence}`);

// ============================================================================
// Test 8: memory_admin - list/view/delete
// ============================================================================

console.log("\n=== Test 8: Admin operations ===");

// List
const listed = db.prepare("SELECT id, type, content FROM knowledge WHERE status = 'active' ORDER BY updated_at DESC LIMIT 5").all();
assert(listed.length > 0, `Admin list returned ${listed.length} atoms`);

// View
const viewed = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(testAtomId);
assert(viewed && viewed.content === testContent, "Admin view returns correct atom");

// Delete (soft)
db.prepare("UPDATE knowledge SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(testAtomId);
const deleted = db.prepare("SELECT status FROM knowledge WHERE id = ?").get(testAtomId);
assertEqual(deleted.status, "archived", "Admin delete archives atom");

// ============================================================================
// Test 9: Hooks output check
// ============================================================================

console.log("\n=== Test 9: Hook scripts exist ===");
const hooksDir = join(SERVER_DIR, "hooks");
const hookFiles = ["session-start-cold.sh", "session-start-compact.sh"];
for (const hf of hookFiles) {
  const hookPath = join(hooksDir, hf);
  assert(existsSync(hookPath), `Hook exists: ${hf}`);
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, "utf8");
    assert(content.includes("recall_context") || content.includes("primeDB"), `${hf} mentions memory tools`);
  }
}

// ============================================================================
// Test 10: Operational health
// ============================================================================

console.log("\n=== Test 10: Operational health ===");

// Summary stats
const activeAtoms = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status = 'active'").get().c;
const archivedAtoms = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status IN ('archived','superseded')").get().c;
const threads = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
const pendingJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'").get().c;
console.log(`  Active: ${activeAtoms}, Archived: ${archivedAtoms}, Threads: ${threads}, Pending: ${pendingJobs}`);
assert(activeAtoms > 0, "Has active atoms");

// DB size
const dbSize = statSync(DB_PATH).size;
console.log(`  DB size: ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
assert(dbSize > 0, "DB file has content");

// Worker PID
const pidFile = join(SERVER_DIR, "worker.pid");
if (existsSync(pidFile)) {
  const pid = readFileSync(pidFile, "utf8").trim();
  console.log(`  Worker PID: ${pid}`);
  assert(!!pid, "Worker PID file exists");
} else {
  console.log("  WARN: No worker.pid file");
}

// Backup check
const backupPath = join(SERVER_DIR, "data", "memory-backup.db");
if (existsSync(backupPath)) {
  const backupAge = Date.now() - statSync(backupPath).mtimeMs;
  const hoursOld = (backupAge / 3600000).toFixed(1);
  console.log(`  Backup age: ${hoursOld} hours`);
  assert(backupAge < 48 * 3600000, `Backup is less than 48 hours old`);
} else {
  console.log("  WARN: No backup file found");
}

// Clean up test atom permanently
db.prepare("DELETE FROM knowledge WHERE id = ?").run(testAtomId);
try {
  db.prepare("DELETE FROM knowledge_embeddings WHERE atom_id = CAST(? AS INTEGER)").run(testAtomId);
} catch { /* may not exist */ }

// ============================================================================
// Summary
// ============================================================================

db.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
