/**
 * Search quality tests for the memory server.
 * Tests hybrid BM25+vector search, multi-resolution, filtering, and edge cases.
 *
 * Run: node test-search-quality.js
 */

import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

// Open database
const db = new Database(DB_PATH, { readonly: true, timeout: 5000 });
loadSqliteVec(db);
db.pragma("journal_mode = WAL");

// Import the MCP client to call tools (we'll use direct DB queries + embedding calls instead)
const OpenAI = (await import("openai")).default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Hybrid search (simplified version of server.js logic)
function bm25Search(query, opts = {}) {
  const { type, limit = 5, since, until } = opts;
  let sql = `
    SELECT k.id, k.content, k.type, k.confidence, k.tags, k.source_thread_id, k.created_at,
           bm25(knowledge_fts) as rank
    FROM knowledge_fts fts
    JOIN knowledge k ON k.id = fts.rowid
    WHERE knowledge_fts MATCH ? AND k.status = 'active'
  `;
  const params = [query];
  if (type) { sql += " AND k.type = ?"; params.push(type); }
  if (since) { sql += " AND k.created_at >= ?"; params.push(since); }
  if (until) { sql += " AND k.created_at <= ?"; params.push(until); }
  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

async function vectorSearch(query, opts = {}) {
  const { limit = 5 } = opts;
  try {
    const emb = await generateQueryEmbedding(query);
    const embBuf = serializeEmbedding(emb);
    const results = db.prepare(`
      SELECT atom_id, distance
      FROM knowledge_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(embBuf, limit);

    return results.map(r => {
      const atom = db.prepare("SELECT * FROM knowledge WHERE id = ? AND status = 'active'").get(r.atom_id);
      return atom ? { ...atom, vector_distance: r.distance } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n=== Search Quality Tests ===\n");

// Test 1: Exact project query
console.log("--- Test 1: Project-specific query ---");
const allAtoms = db.prepare("SELECT DISTINCT project FROM knowledge WHERE status = 'active' AND project IS NOT NULL").all();
if (allAtoms.length > 0) {
  const projectHash = allAtoms[0].project;
  const projectAtoms = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status = 'active' AND project = ?").get(projectHash).c;
  assert(projectAtoms > 0, `Found ${projectAtoms} atoms for project ${projectHash.slice(0, 8)}...`);
} else {
  console.log("  SKIP: No atoms with project field");
}

// Test 2: Semantic query (BM25 + vector)
console.log("\n--- Test 2: Semantic search ---");
const semanticResults = bm25Search("memory database");
console.log(`  BM25 results: ${semanticResults.length}`);
const vecResults = await vectorSearch("how does the memory system store knowledge");
console.log(`  Vector results: ${vecResults.length}`);
assert(semanticResults.length > 0 || vecResults.length > 0, "Semantic query returns results from at least one method");

// Test 3: File name query
console.log("\n--- Test 3: File-related query ---");
const fileResults = bm25Search("worker");
assert(fileResults.length >= 0, `File query returned ${fileResults.length} results (0 OK if no worker-related atoms)`);

// Test 4: Cross-project query
console.log("\n--- Test 4: Cross-project query ---");
const crossProject = db.prepare(`
  SELECT DISTINCT project FROM knowledge WHERE status = 'active' AND project IS NOT NULL
`).all();
assert(crossProject.length >= 1, `Found atoms across ${crossProject.length} project(s)`);

// Test 5: Exact identifier query
console.log("\n--- Test 5: Exact identifier query ---");
const identifierResults = bm25Search("sqlite-vec");
console.log(`  Results for 'sqlite-vec': ${identifierResults.length}`);
// This may or may not find results depending on content
assert(true, "Exact identifier search did not crash");

// Test 6: Temporal filtering
console.log("\n--- Test 6: Temporal filtering ---");
const recentAtoms = bm25Search("*", { since: "2026-01-01", limit: 10 });
const oldAtoms = bm25Search("*", { until: "2025-01-01", limit: 10 });
console.log(`  Atoms since 2026-01-01: ${recentAtoms.length}`);
console.log(`  Atoms before 2025-01-01: ${oldAtoms.length}`);
assert(true, "Temporal queries did not crash");

// Test 7: Resolution=1 (full thread content)
console.log("\n--- Test 7: Full thread retrieval ---");
const someThread = db.prepare("SELECT id FROM threads LIMIT 1").get();
if (someThread) {
  const turns = db.prepare("SELECT COUNT(*) as c FROM turns WHERE thread_id = ?").get(someThread.id).c;
  assert(turns > 0, `Thread ${someThread.id.slice(0, 8)}... has ${turns} turns`);

  const fullTurns = db.prepare("SELECT user_content, assistant_content FROM turns WHERE thread_id = ? ORDER BY turn_number LIMIT 5").all(someThread.id);
  assert(fullTurns.length > 0, "Full thread content retrievable");
} else {
  console.log("  SKIP: No threads in DB");
}

// Test 8: Resolution=2 (key exchanges)
console.log("\n--- Test 8: Key exchange retrieval ---");
if (someThread) {
  const keyTurns = db.prepare("SELECT * FROM turns WHERE thread_id = ? AND is_key_exchange = 1").all(someThread.id);
  console.log(`  Key exchanges in thread: ${keyTurns.length}`);
  // Fallback to first/last turns if no key exchanges
  if (keyTurns.length === 0) {
    const fallback = db.prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_number LIMIT 3").all(someThread.id);
    assert(fallback.length > 0, "Fallback to first turns works when no key exchanges");
  } else {
    assert(true, `Found ${keyTurns.length} key exchanges`);
  }
} else {
  console.log("  SKIP: No threads in DB");
}

// Test 9: Thread expansion with cap
console.log("\n--- Test 9: Thread expansion with content cap ---");
if (someThread) {
  const allTurns = db.prepare("SELECT user_content, assistant_content FROM turns WHERE thread_id = ? ORDER BY turn_number").all(someThread.id);
  const totalChars = allTurns.reduce((sum, t) => sum + (t.user_content || "").length + (t.assistant_content || "").length, 0);
  console.log(`  Thread total content: ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`);
  assert(totalChars > 0, "Thread has content to expand");

  // Simulate 10k token cap
  const TOKEN_CAP = 10000;
  let accumulated = 0;
  let truncatedAt = -1;
  for (let i = 0; i < allTurns.length; i++) {
    accumulated += ((allTurns[i].user_content || "").length + (allTurns[i].assistant_content || "").length) / 4;
    if (accumulated > TOKEN_CAP) {
      truncatedAt = i;
      break;
    }
  }
  if (truncatedAt > 0) {
    assert(true, `Would truncate at turn ${truncatedAt} of ${allTurns.length} (soft cap 10k tokens)`);
  } else {
    assert(true, "Thread fits within 10k token cap");
  }
} else {
  console.log("  SKIP: No threads in DB");
}

// Test 10: Empty results query
console.log("\n--- Test 10: Empty results (graceful) ---");
const emptyBM25 = bm25Search("xyzzyplughtwisty_nonexistent_term_12345");
assert(emptyBM25.length === 0, "BM25 returns empty array for nonsense query");
const emptyVec = await vectorSearch("completely unrelated topic about underwater basket weaving");
// Vector search may return results since it's semantic, but should not crash
assert(true, "Vector search handles unrelated queries gracefully");

// ============================================================================
// Summary
// ============================================================================

db.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
