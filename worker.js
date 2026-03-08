import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import OpenAI from "openai";
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, statSync,
  createReadStream, readdirSync
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { execFile, execSync } from "child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");
const PID_FILE = join(SERVER_DIR, "worker.pid");
const LOG_FILE = join(SERVER_DIR, "logs", "worker.log");
const SNAPSHOTS_DIR = join(SERVER_DIR, "snapshots");
const ENV_PATH = join(SERVER_DIR, ".env");
const POLL_INTERVAL_MS = 10000;
const CONCURRENCY = 4;

const TYPE_CONFIG = {
  preference:      { ttl: Infinity, decay_rate: 0.15 },
  decision:        { ttl: Infinity, decay_rate: 0.15 },
  correction:      { ttl: Infinity, decay_rate: 0.20 },
  insight:         { ttl: 180,      decay_rate: 0.25 },
  // Legacy types kept for existing atoms - no new atoms will use these
  architecture:    { ttl: Infinity, decay_rate: 0.15 },
  pattern:         { ttl: 180,      decay_rate: 0.30 },
  reasoning_chain: { ttl: 180,      decay_rate: 0.30 },
  anti_pattern:    { ttl: 180,      decay_rate: 0.30 },
  debugging:       { ttl: 90,       decay_rate: 0.40 },
  fact:            { ttl: 90,       decay_rate: 0.40 },
  workaround:      { ttl: 90,       decay_rate: 0.40 },
  tool_config:     { ttl: 90,       decay_rate: 0.40 },
};

const STOPWORDS = new Set([
  "this","that","with","from","have","been","were","more","some","each",
  "what","when","then","also","just","only","very","will","would","should",
  "could","about","after","before","other","their","these","those","which",
  "being","does","doing","done","into","over","under","between","through",
  "during","most","such","both","same","than","them","they","here","there",
  "where","while","because","since","until","using","used","make","made",
  "like","need","want","take","come","know","think","look","find","give",
  "tell","work","call","first","last","long","great","little","right",
  "still","every","must","might","much","well","back","even","keep","many",
  "content","instead",
]);

// Valid extraction types
// All extracted atoms get type "insight" - no categorization needed

// ── Concept Enrichment (shared with server.js) ──────────────────────────────

const CONCEPT_MAP = {
  "auth|login|signin|oauth|token|session|credential": "authentication login auth access identity",
  "api|endpoint|rest|graphql|request|response|fetch": "api endpoint http integration backend",
  "error|exception|crash|fail|bug|broken|throw": "error failure bug problem exception",
  "database|sql|query|migration|schema|table|postgres|sqlite|supabase": "database sql data storage persistence",
  "test|spec|assert|expect|mock|stub|jest|vitest": "test testing assertion mock verification",
  "deploy|ci|cd|pipeline|build|release|docker|vercel": "deployment cicd pipeline build release",
  "cache|redis|memcache|invalidat": "cache caching invalidation performance",
  "react|component|hook|state|props|render|jsx|tsx": "react component frontend ui rendering",
  "route|router|navigate|path|url|link|page": "routing navigation url path page",
  "style|css|tailwind|class|theme|color|font": "styling css design theme visual",
  "git|commit|branch|merge|push|pull|rebase": "git version-control branch commit",
  "env|environment|config|setting|variable|secret|key": "configuration environment setup settings",
  "type|interface|generic|typescript|enum|union": "typescript types typing interface",
  "async|await|promise|callback|concurrent|parallel": "async asynchronous concurrency promise",
};

function enrichConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();
  for (const [pattern, expansion] of Object.entries(CONCEPT_MAP)) {
    if (new RegExp(pattern, "i").test(lower)) {
      for (const term of expansion.split(" ")) {
        concepts.add(term);
      }
    }
  }
  return concepts.size > 0 ? [...concepts].join(" ") : null;
}

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    writeFileSync(LOG_FILE, line, { flag: "a" });
  } catch { /* ignore */ }
}

// ── Load .env ───────────────────────────────────────────────────────────────

function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
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

// ── JSONL Parser (streaming) ────────────────────────────────────────────────

async function parseJSONL(filePath) {
  const messages = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines (truncated file, concurrent write)
      continue;
    }
  }
  return messages;
}

// ── Transcript Pre-Processing ───────────────────────────────────────────────

function extractTextContent(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter(b => b.type === "text").map(b => b.text).join("\n");
  }
  return "";
}

function countToolUseBlocks(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return 0;
  return c.filter(b => b.type === "tool_use").length;
}

function hasErrorInToolResults(messages, startIdx) {
  // Look ahead for the next user message containing tool_result blocks
  for (let i = startIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === "assistant") break; // Next assistant turn - stop looking
    if (m.type === "user") {
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          if (block.is_error) return true;
          const text = typeof block.content === "string" ? block.content : "";
          if (/error|Error|ERROR|fail|FAIL|exception|Exception|EXCEPTION/.test(text)) return true;
        }
      }
      break; // Only check the immediately following user message
    }
  }
  return false;
}

function pairIntoTurns(rawMessages) {
  // Filter to user and assistant messages, extract text only
  const textMessages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (m.type === "user") {
      textMessages.push({
        role: "user",
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
      });
    } else if (m.type === "assistant") {
      const toolCalls = countToolUseBlocks(m.message);
      const hasError = hasErrorInToolResults(rawMessages, i);
      textMessages.push({
        role: "assistant",
        content: extractTextContent(m.message),
        timestamp: m.timestamp,
        toolCalls,
        hasError,
      });
    }
  }

  // Pair into turns
  const turns = [];
  let turnNum = 1;
  let i = 0;
  while (i < textMessages.length) {
    const turn = { turn_number: turnNum };

    if (textMessages[i].role === "user") {
      turn.user_content = textMessages[i].content;
      turn.timestamp = textMessages[i].timestamp;
      i++;
      // Collect assistant response(s) for this turn
      if (i < textMessages.length && textMessages[i].role === "assistant") {
        turn.assistant_content = textMessages[i].content;
        turn.tool_calls_count = textMessages[i].toolCalls || 0;
        turn.has_error = textMessages[i].hasError ? 1 : 0;
        if (!turn.timestamp) turn.timestamp = textMessages[i].timestamp;
        i++;
      }
    } else if (textMessages[i].role === "assistant") {
      // Assistant without preceding user (rare)
      turn.assistant_content = textMessages[i].content;
      turn.tool_calls_count = textMessages[i].toolCalls || 0;
      turn.has_error = textMessages[i].hasError ? 1 : 0;
      turn.timestamp = textMessages[i].timestamp;
      i++;
    }

    // Skip empty turns
    if ((turn.user_content || "").trim() || (turn.assistant_content || "").trim()) {
      turns.push(turn);
      turnNum++;
    }
  }
  return turns;
}

// ── Thread ID Generation ────────────────────────────────────────────────────

function generateThreadId(turns, filePath) {
  // Content hash of first 3 turns + file basename for entropy
  const content = turns.slice(0, 3).map(t =>
    (t.user_content || "") + (t.assistant_content || "")
  ).join("\n");
  const fileBase = basename(filePath);
  const firstTimestamp = turns[0]?.timestamp || "";
  const hashInput = content + "\n" + fileBase + "\n" + firstTimestamp;
  return createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
}

// ── OpenAI Embeddings ───────────────────────────────────────────────────────

let openai = null;

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

async function generateEmbeddings(texts) {
  const client = getOpenAI();
  // text-embedding-3-small has 8192 token limit; ~4 chars per token, cap at 30000 chars
  const truncated = texts.map(t => t.length > 30000 ? t.slice(0, 30000) : t);
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: truncated,
    dimensions: 1536,
  });
  return response.data.map(d => d.embedding);
}

// ── Claude CLI for Sonnet Extraction ────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a highly selective knowledge extraction system. Extract ONLY knowledge that will change how the assistant behaves in future sessions.

=== THREE GATES - ALL MUST PASS ===

1. NOT GENERIC: Is this specific to the user's projects or preferences? "Use transactions for atomicity" fails. "Nurch uses Clerk because Supabase auth didn't support LinkedIn OAuth" passes.

2. NOT IN THE CODE: Could the assistant figure this out by reading the codebase? Architecture, schema, config are all discoverable. Business decisions, rejected alternatives, user constraints, debugging journeys are NOT.

3. CHANGES BEHAVIOR: If this atom appears in a future session, does the assistant do something differently? "Cosine threshold is 0.20" changes nothing. "Don't suggest Nylas, we evaluated it and it's 3x too expensive" prevents wasted time.

MOST SESSIONS (80%+) YIELD ZERO ATOMS. This is correct. Only extract when something genuinely important happened.

=== SCOPE ===

"scope" determines whether knowledge is project-specific or cross-project:
- "project": Only useful for THIS specific codebase/product. Remove the project name - does it still make sense? If not, it's project.
- "global": Useful regardless of which project. User preferences, working style, cross-cutting tool choices.

Examples: "Nurch uses Clerk for auth" = project. "Always challenge my ideas" = global. "Unipile webhook missing email body" = project. "Ship fast, bugs OK" = global.

=== DO NOT EXTRACT ===
- Implementation details discoverable from code (file paths, schema, config)
- Generic programming knowledge any LLM already knows
- Process commentary about the conversation itself
- One-off fixes unlikely to recur
- Multiple atoms about the same thing

=== RESPONSE FORMAT ===

Respond with ONLY a raw JSON object. No markdown code fences. No explanation.

{
  "atoms": [
    {
      "content": "The core knowledge - one clear sentence of what matters",
      "context": "The full war story with every detail",
      "scope": "project|global"
    }
  ],
  "thread_priority": "critical|significant|routine",
  "impasse_severity": 0.0
}

Rules:
- Maximum 3 atoms. Most sessions produce 0.
- thread_priority and impasse_severity are ALWAYS required.
- "content" is the headline - concise, what matters.
- "context" is the full war story. Step by step, chronological, include EVERYTHING:
  - What was tried first and what happened
  - Specific bugs, errors, or issues encountered along the way
  - How those bugs were debugged and solved (exact steps, commands, fixes)
  - Which alternatives were actually attempted vs just discussed
  - Why things failed - specific technical reasons, not vague summaries
  - The exact path from problem to solution
  This is the most valuable part. Be detailed. Include error messages, API responses, config issues, version conflicts - the messy reality, not a clean summary.
- Do NOT add any fields beyond content, context, scope. No "type" field.`;

function callClaudeCLI(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", "sonnet",
      "--output-format", "json",
      "--tools", "",
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
    ];

    const claudePath = process.env.CLAUDE_CLI_PATH || join(HOME, ".local", "bin", "claude");

    const child = execFile(claudePath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
      env: { ...process.env, CLAUDECODE: "" },
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`CLI failed: ${err.message}${stderr ? " stderr: " + stderr : ""}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          reject(new Error(`CLI error: ${envelope.result}`));
          return;
        }
        resolve(envelope);
      } catch (parseErr) {
        reject(new Error(`CLI output parse failed: ${parseErr.message}. Raw: ${stdout.slice(0, 200)}`));
      }
    });

    // Send prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseExtractionResult(resultText) {
  let cleaned = resultText.trim();
  // Strip code fences if present
  cleaned = cleaned.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  cleaned = cleaned.replace(/^```\s*\n?/, "").trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Extract JSON object from surrounding text (LLM sometimes adds commentary)
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`No JSON object found in response: ${cleaned.slice(0, 200)}`);
  }
}

async function extractViaCLI(transcriptText, existingAtomsContext = "") {
  const prompt = `TRANSCRIPT:\n<transcript>\n${transcriptText}\n</transcript>${existingAtomsContext}`;

  let envelope;
  try {
    envelope = await callClaudeCLI(prompt, EXTRACTION_SYSTEM_PROMPT);
  } catch (err) {
    log(`CLI extraction failed: ${err.message}`);
    throw err;
  }

  const costUsd = envelope.total_cost_usd || 0;
  const durationMs = envelope.duration_ms || 0;
  log(`  Extraction: ${durationMs}ms, $${costUsd.toFixed(4)}`);

  try {
    return parseExtractionResult(envelope.result);
  } catch (firstErr) {
    // Retry once with stricter prompt
    log(`  First parse failed: ${firstErr.message}. Retrying with stricter prompt...`);
    const retryPrompt = `Your previous response was not valid JSON. Respond with ONLY a raw JSON object. No code fences. No explanation.\n\n${prompt}`;
    try {
      const retryEnvelope = await callClaudeCLI(retryPrompt, EXTRACTION_SYSTEM_PROMPT);
      return parseExtractionResult(retryEnvelope.result);
    } catch (retryErr) {
      log(`  Retry parse also failed: ${retryErr.message}`);
      throw new Error(`Extraction parse failed after retry: ${retryErr.message}`);
    }
  }
}

// ── Consolidation via CLI ───────────────────────────────────────────────────

const CONSOLIDATION_SYSTEM_PROMPT = `You are a knowledge consolidation system. Review knowledge atoms and identify duplicates, outdated items, and contradictions.

RESPONSE FORMAT: Respond with ONLY a raw JSON object. No markdown code fences. No explanation.

JSON schema:
{
  "merge": [{"atom_ids": [1, 2], "merged_content": "combined statement", "reason": "why"}],
  "archive": [{"atom_id": 1, "reason": "why outdated"}],
  "contradictions": [{"atom_ids": [1, 2], "description": "what conflicts"}]
}
All arrays are optional. Return {} if no actions needed.`;

async function callConsolidationCLI(atomList, type) {
  const prompt = `Review these ${type} knowledge atoms. Identify:
1. DUPLICATES: atoms saying the same thing differently. Merge into one clean statement.
2. OUTDATED: atoms likely no longer true. Recommend archival.
3. CONTRADICTIONS: atoms that disagree. Flag them - do not resolve.

IMPORTANT: Atoms about same topic created >7 days apart may be TEMPORAL VERSIONS. Archive older, don't merge.

Atoms:
${atomList}`;

  const envelope = await callClaudeCLI(prompt, CONSOLIDATION_SYSTEM_PROMPT);
  return parseExtractionResult(envelope.result);
}

// ── Database Operations ─────────────────────────────────────────────────────

function openDatabase() {
  const db = new Database(DB_PATH, { timeout: 5000 });
  loadSqliteVec(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

// ── Embedding Helpers ───────────────────────────────────────────────────────

function serializeEmbedding(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function storeTurnEmbeddings(db, turnRows, embeddings) {
  // vec0 virtual tables don't support OR IGNORE/OR REPLACE, so check existence first
  const exists = db.prepare("SELECT 1 FROM turn_embeddings WHERE turn_id = ?");
  const insert = db.prepare(`
    INSERT INTO turn_embeddings (turn_id, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `);
  for (let i = 0; i < turnRows.length; i++) {
    if (embeddings[i] && !exists.get(turnRows[i].id)) {
      insert.run(turnRows[i].id, serializeEmbedding(embeddings[i]));
    }
  }
}

function storeKnowledgeEmbedding(db, atomId, embedding) {
  db.prepare(`
    INSERT OR REPLACE INTO knowledge_embeddings (atom_id, embedding)
    VALUES (CAST(? AS INTEGER), ?)
  `).run(atomId, serializeEmbedding(embedding));
}

// ── Deduplication (cosine via sqlite-vec) ───────────────────────────────────

function findSimilarAtoms(db, embedding, topK = 3) {
  const buf = serializeEmbedding(embedding);
  try {
    return db.prepare(`
      SELECT atom_id, distance
      FROM knowledge_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, topK);
  } catch {
    return [];
  }
}

function deduplicateAtom(db, content, type, embedding) {
  // Stage 0: exact match
  const exact = db.prepare(
    "SELECT id FROM knowledge WHERE content = ? AND status = 'active' LIMIT 1"
  ).get(content);
  if (exact) return { action: "reinforce", existingId: exact.id };

  // Stage 1: cosine similarity via embeddings
  if (embedding) {
    const similar = findSimilarAtoms(db, embedding, 3);
    for (const s of similar) {
      if (s.distance < 0.20) {
        // Near duplicate (cosine distance < 0.20 = similarity > 0.80)
        // Only reinforce active atoms - archived/superseded ones are dead
        const active = db.prepare(
          "SELECT id FROM knowledge WHERE id = ? AND status = 'active'"
        ).get(s.atom_id);
        if (active) return { action: "reinforce", existingId: s.atom_id };
      }
    }
  }

  return { action: "create" };
}

// ── Store Extracted Atom ────────────────────────────────────────────────────

async function storeAtom(db, { content, type, scope, project, projectName, sourceThreadId, metadata, impasseSeverity, gitCommitHash, gitProjectDir, initialConfidence = 0.75 }) {
  // Merge metadata into content so it's visible at injection time
  let atomContent = content;
  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    const skip = new Set(["scope", "key_exchange_snippet"]);
    const entries = Object.entries(metadata).filter(([k]) => !skip.has(k));
    if (entries.length > 0) {
      const metaLines = entries.map(([k, v]) => {
        const label = k.replace(/_/g, " ");
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${label}: ${val}`;
      });
      atomContent = atomContent + "\n" + metaLines.join("\n");
    }
  }

  // No hard truncation - store full content so nothing is lost
  // Extraction prompt already constrains output length naturally

  // Generate embedding
  let embedding = null;
  try {
    const [emb] = await generateEmbeddings([atomContent]);
    embedding = emb;
  } catch (err) {
    log(`  Embedding failed for atom, will store without: ${err.message}`);
  }

  // Deduplicate
  const dedup = deduplicateAtom(db, atomContent, type, embedding);

  if (dedup.action === "reinforce") {
    db.prepare(`
      UPDATE knowledge SET
        reinforcement_count = reinforcement_count + 1,
        confidence = MIN(1.0, confidence + 0.05),
        last_reinforced_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(dedup.existingId);
    log(`  Reinforced atom #${dedup.existingId} [${type}]`);
    return { action: "reinforced", atomId: dedup.existingId };
  }

  // Create new atom
  const decayRate = TYPE_CONFIG[type]?.decay_rate || 0.30;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const result = db.prepare(`
    INSERT INTO knowledge (
      content, type, scope, project, source_type, source_thread_id,
      confidence, decay_rate, impasse_severity, metadata,
      git_commit_hash, git_project_dir
    ) VALUES (?, ?, ?, ?, 'llm_extracted', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    atomContent, type, scope || "project", project,
    sourceThreadId, initialConfidence, decayRate, impasseSeverity || 0.0, metadataJson,
    gitCommitHash || null, gitProjectDir || null
  );

  const newId = Number(result.lastInsertRowid);

  // Store embedding
  if (embedding) {
    storeKnowledgeEmbedding(db, newId, embedding);
  }

  log(`  Created atom #${newId} [${type}]: ${atomContent.slice(0, 60)}...`);
  return { action: "created", atomId: newId };
}

// ── Mark Key Exchanges ──────────────────────────────────────────────────────

function markKeyExchanges(db, threadId, snippets) {
  if (!snippets || snippets.length === 0) return;

  const turns = db.prepare(
    "SELECT id, turn_number, user_content, assistant_content FROM turns WHERE thread_id = ?"
  ).all(threadId);

  for (const snippet of snippets) {
    const lowerSnippet = snippet.toLowerCase();
    let matchedTurn = null;

    // Substring match
    for (const t of turns) {
      const combined = ((t.user_content || "") + " " + (t.assistant_content || "")).toLowerCase();
      if (combined.includes(lowerSnippet)) {
        matchedTurn = t;
        break;
      }
    }

    if (matchedTurn) {
      // Mark this turn and adjacent turns
      const turnNums = [matchedTurn.turn_number - 1, matchedTurn.turn_number, matchedTurn.turn_number + 1];
      db.prepare(`
        UPDATE turns SET is_key_exchange = 1
        WHERE thread_id = ? AND turn_number IN (${turnNums.map(() => "?").join(",")})
      `).run(threadId, ...turnNums);
    }
  }
}

// ── Format Transcript for Extraction ────────────────────────────────────────

function formatTranscriptForExtraction(turns) {
  const formatTurn = t => {
    let text = "";
    if (t.user_content) text += `Turn ${t.turn_number} [user]: ${t.user_content}\n`;
    if (t.assistant_content) {
      let label = `Turn ${t.turn_number} [assistant]`;
      const annotations = [];
      if (t.tool_calls_count > 0) annotations.push(`${t.tool_calls_count} tool calls`);
      if (t.has_error) annotations.push("ERROR in tool results");
      if (annotations.length > 0) label += ` (${annotations.join(", ")})`;
      text += `${label}: ${t.assistant_content}\n`;
    }
    return text;
  };

  const formatted = turns.map(formatTurn);
  const full = formatted.join("\n");
  if (full.length < 50000) return full;

  // Truncate: keep first 3 + last 5 turns, omit middle
  const head = formatted.slice(0, 3);
  const tail = formatted.slice(-5);
  const omitted = turns.length - 8;
  return [...head, `\n[... ${omitted} turns omitted ...]\n\n`, ...tail].join("\n");
}

// ── Ingest Thread Pipeline ──────────────────────────────────────────────────

async function ingestThread(db, filePath, project, projectName, isFullSession, gitCommitHash, gitProjectDir, forceExtract = false) {
  // Step 1: Parse JSONL
  const rawMessages = await parseJSONL(filePath);
  if (rawMessages.length === 0) {
    log("  Empty transcript, skipping.");
    return 0;
  }

  // Step 2: Pair into turns
  const turns = pairIntoTurns(rawMessages);
  if (turns.length === 0) {
    log("  No turns found, skipping.");
    return 0;
  }

  // Skip trivial sessions (1 turn with short content)
  if (turns.length === 1) {
    const totalContent = (turns[0].user_content || "").length + (turns[0].assistant_content || "").length;
    if (totalContent < 500) {
      log(`  Trivial session (1 turn, ${totalContent} chars), skipping extraction.`);
      return 0;
    }
  }

  // Step 3: Create thread record
  const threadId = generateThreadId(turns, filePath);
  const fileMtime = statSync(filePath).mtimeMs / 1000;

  const existingThread = db.prepare("SELECT id, turn_count FROM threads WHERE id = ?").get(threadId);

  if (existingThread) {
    // Update thread metadata if this is a full session re-ingestion
    if (isFullSession && turns.length > existingThread.turn_count) {
      db.prepare(`
        UPDATE threads SET
          turn_count = ?,
          timestamp_end = ?,
          file_mtime = ?,
          source_file = ?
        WHERE id = ?
      `).run(turns.length, turns[turns.length - 1].timestamp, fileMtime, filePath, threadId);
      log(`  Updated thread ${threadId}: ${existingThread.turn_count} -> ${turns.length} turns`);
    } else if (forceExtract) {
      log(`  Force re-extraction for thread ${threadId} (${existingThread.turn_count} turns)`);
    } else {
      log(`  Thread ${threadId} already exists with ${existingThread.turn_count} turns, skipping.`);
      return 0;
    }
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO threads (id, project, project_name, turn_count, timestamp_start, timestamp_end, source_file, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId, project, projectName, turns.length,
      turns[0].timestamp, turns[turns.length - 1].timestamp,
      filePath, fileMtime
    );
  }

  // Step 4: Store turns
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (thread_id, turn_number, user_content, assistant_content, timestamp, tool_calls_count, has_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const storedTurns = [];
  for (const t of turns) {
    try {
      insertTurn.run(threadId, t.turn_number, t.user_content || null, t.assistant_content || null,
        t.timestamp || null, t.tool_calls_count || 0, t.has_error || 0);
      const turnRow = db.prepare(
        "SELECT id FROM turns WHERE thread_id = ? AND turn_number = ?"
      ).get(threadId, t.turn_number);
      if (turnRow) storedTurns.push(turnRow);
    } catch (err) {
      // UNIQUE constraint violation = already stored, get existing
      const existing = db.prepare(
        "SELECT id FROM turns WHERE thread_id = ? AND turn_number = ?"
      ).get(threadId, t.turn_number);
      if (existing) storedTurns.push(existing);
    }
  }
  log(`  Stored ${storedTurns.length} turns for thread ${threadId}`);

  // Step 5: Generate turn embeddings (batch)
  try {
    // Only embed turns that aren't already done (avoids vec0 UNIQUE constraint on thread updates)
    const alreadyDone = new Set(
      storedTurns
        .filter(t => db.prepare("SELECT embed_status FROM turns WHERE id = ?").get(t.id)?.embed_status === 'done')
        .map(t => t.id)
    );

    const pairs = turns.map((t, idx) => ({
      text: ((t.user_content || "") + " " + (t.assistant_content || "")).trim(),
      turn: storedTurns[idx]
    })).filter(p => p.text.length > 0 && p.turn && !alreadyDone.has(p.turn.id));

    // Batch in groups of 20
    for (let i = 0; i < pairs.length; i += 20) {
      const batch = pairs.slice(i, i + 20);
      const embeddings = await generateEmbeddings(batch.map(p => p.text));
      storeTurnEmbeddings(db, batch.map(p => p.turn), embeddings);

      // Mark embedded turns
      for (const p of batch) {
        db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.turn.id);
      }
    }
    log(`  Generated embeddings for ${pairs.length} turns (${alreadyDone.size} already done)`);
  } catch (err) {
    log(`  Turn embedding failed (will retry later): ${err.message}`);
    // Only mark turns as failed if they weren't already done
    for (const t of storedTurns) {
      const current = db.prepare("SELECT embed_status FROM turns WHERE id = ?").get(t.id);
      if (current?.embed_status !== 'done') {
        db.prepare("UPDATE turns SET embed_status = 'failed' WHERE id = ?").run(t.id);
      }
    }
  }

  // Step 5.5: Gather existing atoms for dedup context
  let existingAtomsContext = "";
  if (storedTurns.length > 0) {
    try {
      const meanText = turns.map(t =>
        ((t.user_content || "") + " " + (t.assistant_content || "")).trim()
      ).join(" ").slice(0, 500);
      const [meanEmb] = await generateEmbeddings([meanText]);
      const similar = findSimilarAtoms(db, meanEmb, 10);
      if (similar.length > 0) {
        const ids = similar.map(s => s.atom_id);
        const atoms = db.prepare(
          `SELECT id, type, content FROM knowledge WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`
        ).all(...ids);
        if (atoms.length > 0) {
          existingAtomsContext = "\n\n=== EXISTING KNOWLEDGE (do NOT re-extract these) ===\n" +
            atoms.map(a => `[#${a.id}] [${a.type}] ${a.content}`).join("\n");
        }
      }
    } catch { /* non-critical */ }
  }

  // Step 6: LLM Extraction via CLI
  const transcriptText = formatTranscriptForExtraction(turns);
  let extraction = null;
  try {
    extraction = await extractViaCLI(transcriptText, existingAtomsContext);
  } catch (err) {
    log(`  Extraction failed: ${err.message}`);
    // Thread and turns are preserved, extraction can be retried
    return 0;
  }

  // Step 7: Store extracted knowledge atoms
  let atomCount = 0;
  const impasseSeverity = extraction.impasse_severity || 0.0;

  const atoms = Array.isArray(extraction.atoms) ? extraction.atoms : [];
  for (const item of atoms) {
    if (!item.content) continue;
    try {
      const meta = {};
      if (item.context) meta.context = item.context;

      const scope = item.scope || "project";
      await storeAtom(db, {
        content: item.content,
        type: "insight",
        scope,
        project: scope === "global" ? null : project,
        projectName,
        sourceThreadId: threadId,
        metadata: Object.keys(meta).length > 0 ? meta : null,
        impasseSeverity,
        gitCommitHash,
        gitProjectDir,
      });
      atomCount++;
    } catch (err) {
      log(`  Failed to store atom: ${err.message}`);
    }
  }

  // Step 7.5: Mark key exchanges based on extracted atom content
  const snippets = atoms
    .filter(a => a.content)
    .map(a => a.content.slice(0, 100));
  markKeyExchanges(db, threadId, snippets);

  // Step 8: Set thread metadata
  // No type categorization - detect from content keywords
  const allContent = atoms.map(a => `${a.content} ${a.context || ""}`).join(" ").toLowerCase();
  const hasCorrections = /\b(corrected|wrong|mistake|fix|actually)\b/.test(allContent) ? 1 : 0;
  const hasDecisions = /\b(chose|decided|picked|switched|went with)\b/.test(allContent) ? 1 : 0;
  const hasDebugging = /\b(bug|debug|error|crash|broke|issue)\b/.test(allContent) ? 1 : 0;
  db.prepare(`
    UPDATE threads SET
      priority = ?,
      has_corrections = ?,
      has_decisions = ?,
      has_debugging = ?
    WHERE id = ?
  `).run(
    extraction.thread_priority || "routine",
    hasCorrections,
    hasDecisions,
    hasDebugging,
    threadId
  );

  // Step 10: Injection feedback - check if previously injected atoms were referenced
  checkInjectionFeedback(db, filePath, turns);

  // Step 11: Refresh injection cache for this project
  await refreshInjectionCache(db, project, projectName);

  log(`  Ingestion complete: ${atomCount} atoms, priority=${extraction.thread_priority}`);
  return atomCount;
}

// ── Hindsight Extraction ─────────────────────────────────────────────────────

const HINDSIGHT_SYSTEM_PROMPT = `You are a cross-session pattern detector. You review multiple recent sessions for a project to find patterns that single-session extraction misses.

RESPONSE FORMAT: Respond with ONLY a raw JSON object. No markdown code fences. No explanation.

JSON schema:
{
  "atoms": [
    {
      "content": "concise headline of the cross-session pattern",
      "context": "detailed explanation: which sessions showed this pattern, what recurred, why it matters",
      "scope": "project|global"
    }
  ],
  "repeat_events": [
    {
      "thread_id": "session thread ID where the repeat occurred",
      "atom_id": 123,
      "description": "what happened again despite the existing atom"
    }
  ]
}

Focus on:
1. RECURRING PROBLEMS: Same mistake, error, or confusion appearing across multiple sessions
2. EMERGING PATTERNS: Approaches or solutions that keep working (or failing) across sessions
3. MISSED EXTRACTIONS: Important knowledge from past sessions that wasn't captured
4. REPEAT EVENTS: Cases where an existing atom should have prevented a mistake but didn't

Rules:
- Maximum 2 atoms. Most reviews produce 0.
- Only extract if you see a CROSS-SESSION pattern. Single-session observations should have been caught already.
- For repeat_events: only flag cases where an existing atom directly relates to a mistake that was repeated.
- All arrays are optional. Return {} if nothing stands out.`;

async function processHindsightExtraction(db, project, projectName) {
  // Load last 5 threads for this project
  const threads = db.prepare(`
    SELECT id, project_name, turn_count, timestamp_start, timestamp_end
    FROM threads WHERE project = ?
    ORDER BY created_at DESC LIMIT 5
  `).all(project);

  if (threads.length < 2) {
    log(`  Hindsight: skipping, only ${threads.length} thread(s) for project`);
    return 0;
  }

  // For each thread: load key exchange turns + first/last turns (compact view)
  const threadSummaries = [];
  for (const thread of threads) {
    const keyTurns = db.prepare(`
      SELECT turn_number, user_content, assistant_content
      FROM turns WHERE thread_id = ? AND is_key_exchange = 1
      ORDER BY turn_number
    `).all(thread.id);

    const firstTurn = db.prepare(`
      SELECT turn_number, user_content, assistant_content
      FROM turns WHERE thread_id = ? ORDER BY turn_number ASC LIMIT 1
    `).get(thread.id);

    const lastTurn = db.prepare(`
      SELECT turn_number, user_content, assistant_content
      FROM turns WHERE thread_id = ? ORDER BY turn_number DESC LIMIT 1
    `).get(thread.id);

    // Deduplicate: don't repeat first/last if they're already key exchanges
    const keyTurnNums = new Set(keyTurns.map(t => t.turn_number));
    const selectedTurns = [...keyTurns];
    if (firstTurn && !keyTurnNums.has(firstTurn.turn_number)) {
      selectedTurns.unshift(firstTurn);
    }
    if (lastTurn && !keyTurnNums.has(lastTurn.turn_number)) {
      selectedTurns.push(lastTurn);
    }

    // Format compactly
    const turnText = selectedTurns.map(t => {
      const u = (t.user_content || "").slice(0, 500);
      const a = (t.assistant_content || "").slice(0, 500);
      return `  [Turn ${t.turn_number}] User: ${u}\n  Assistant: ${a}`;
    }).join("\n");

    threadSummaries.push(
      `=== Thread ${thread.id} (${thread.turn_count} turns, ${thread.timestamp_start || "?"}) ===\n${turnText}`
    );
  }

  // Load top 20 existing atoms for context
  let existingAtomsText = "";
  try {
    const atoms = db.prepare(`
      SELECT id, type, content FROM knowledge
      WHERE (project = ? OR scope = 'global') AND status = 'active'
      ORDER BY confidence DESC, access_count DESC LIMIT 20
    `).all(project);
    if (atoms.length > 0) {
      existingAtomsText = "\n\n=== EXISTING KNOWLEDGE ATOMS ===\n" +
        atoms.map(a => `[#${a.id}] [${a.type}] ${a.content}`).join("\n");
    }
  } catch { /* non-critical */ }

  // Load recent repeat events for feedback
  let repeatEventsText = "";
  try {
    const events = db.prepare(`
      SELECT re.description, re.session_thread_id, re.similar_atom_id, k.content as atom_content
      FROM repeat_events re
      JOIN knowledge k ON k.id = re.similar_atom_id
      WHERE k.project = ? AND re.resolved = 0
      ORDER BY re.detected_at DESC LIMIT 10
    `).all(project);
    if (events.length > 0) {
      repeatEventsText = "\n\n=== KNOWN REPEAT PROBLEMS (system failed to prevent these) ===\n" +
        events.map(e => `- Atom #${e.similar_atom_id} "${e.atom_content.slice(0, 80)}" was violated in thread ${e.session_thread_id}: ${e.description}`).join("\n");
    }
  } catch { /* non-critical */ }

  // Build prompt, cap at ~30k chars
  let prompt = `PROJECT: ${projectName}\n\nRECENT SESSIONS:\n${threadSummaries.join("\n\n")}${existingAtomsText}${repeatEventsText}`;
  if (prompt.length > 30000) {
    prompt = prompt.slice(0, 30000) + "\n\n[TRUNCATED]";
  }

  // Call Sonnet
  let result;
  try {
    const envelope = await callClaudeCLI(prompt, HINDSIGHT_SYSTEM_PROMPT);
    const costUsd = envelope.total_cost_usd || 0;
    const durationMs = envelope.duration_ms || 0;
    log(`  Hindsight extraction: ${durationMs}ms, $${costUsd.toFixed(4)}`);
    result = parseExtractionResult(envelope.result);
  } catch (err) {
    log(`  Hindsight extraction failed: ${err.message}`);
    return 0;
  }

  // Store atoms with higher initial confidence (cross-session patterns are more reliable)
  let atomCount = 0;
  const atoms = Array.isArray(result.atoms) ? result.atoms : [];
  for (const item of atoms.slice(0, 2)) {
    if (!item.content) continue;
    try {
      const meta = {};
      if (item.context) meta.context = item.context;
      meta.source = "hindsight";

      const scope = item.scope || "project";
      await storeAtom(db, {
        content: item.content,
        type: "insight",
        scope,
        project: scope === "global" ? null : project,
        projectName,
        sourceThreadId: threads[0].id,
        metadata: Object.keys(meta).length > 0 ? meta : null,
        initialConfidence: 0.85,
      });
      atomCount++;
    } catch (err) {
      log(`  Failed to store hindsight atom: ${err.message}`);
    }
  }

  // Store repeat events
  const repeatEvents = Array.isArray(result.repeat_events) ? result.repeat_events : [];
  for (const event of repeatEvents) {
    if (!event.thread_id || !event.atom_id || !event.description) continue;
    // Validate references exist
    const threadExists = db.prepare("SELECT 1 FROM threads WHERE id = ?").get(event.thread_id);
    const atomExists = db.prepare("SELECT 1 FROM knowledge WHERE id = ?").get(event.atom_id);
    if (!threadExists || !atomExists) continue;

    try {
      db.prepare(`
        INSERT INTO repeat_events (session_thread_id, similar_atom_id, description)
        VALUES (?, ?, ?)
      `).run(event.thread_id, event.atom_id, event.description);
      log(`  Repeat event: atom #${event.atom_id} violated in ${event.thread_id}`);
    } catch (err) {
      log(`  Failed to store repeat event: ${err.message}`);
    }
  }

  log(`  Hindsight complete: ${atomCount} atoms, ${repeatEvents.length} repeat events`);
  return atomCount;
}

// ── Injection Feedback Loop ──────────────────────────────────────────────────

function checkInjectionFeedback(db, sessionFile, turns) {
  // Find injection events for this session (match by filename or session_id)
  const sessionBasename = basename(sessionFile, ".jsonl");
  const events = db.prepare(`
    SELECT ie.id, ie.atom_id, k.content
    FROM injection_events ie
    JOIN knowledge k ON k.id = ie.atom_id
    WHERE (ie.session_file = ? OR ie.session_file = ? OR ie.session_file LIKE ?)
    AND ie.was_referenced IS NULL
  `).all(sessionFile, sessionBasename, `%${sessionBasename}%`);

  if (events.length === 0) return;

  // Build assistant text from all turns
  const assistantText = turns
    .map(t => (t.assistant_content || "").toLowerCase())
    .join(" ");

  for (const event of events) {
    // Extract key terms from atom content (words 5+ chars, no stopwords)
    const terms = (event.content || "")
      .toLowerCase()
      .match(/\b[a-z_]{5,}\b/g) || [];
    const uniqueTerms = [...new Set(terms)]
      .filter(t => !STOPWORDS.has(t))
      .slice(0, 15);

    if (uniqueTerms.length === 0) continue;

    // Check if at least 40% of key terms appear in assistant responses (word boundary match)
    const matched = uniqueTerms.filter(t => {
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return re.test(assistantText);
    }).length;
    const ratio = matched / uniqueTerms.length;
    const wasReferenced = ratio >= 0.4 ? 1 : 0;

    db.prepare("UPDATE injection_events SET was_referenced = ? WHERE id = ?")
      .run(wasReferenced, event.id);

    // Recompute denormalized injection stats
    const stats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN was_referenced = 1 THEN 1 ELSE 0 END) as referenced
      FROM injection_events
      WHERE atom_id = ? AND was_referenced IS NOT NULL
    `).get(event.atom_id);

    const rate = stats.total >= 5 ? (stats.referenced / stats.total) : null;
    db.prepare(`
      UPDATE knowledge SET injection_success_rate = ? WHERE id = ?
    `).run(rate, event.atom_id);

    if (wasReferenced) {
      // Boost confidence by 0.05 (capped at 1.0)
      db.prepare(`
        UPDATE knowledge SET confidence = MIN(1.0, confidence + 0.05), updated_at = datetime('now')
        WHERE id = ? AND status = 'active'
      `).run(event.atom_id);
    } else {
      // Check total unreferenced injections for this atom
      const unreferenced = db.prepare(`
        SELECT COUNT(*) as c FROM injection_events
        WHERE atom_id = ? AND was_referenced = 0
      `).get(event.atom_id).c;

      if (unreferenced >= 5) {
        // Lower confidence by 0.03 per unreferenced (floor at 0.30)
        db.prepare(`
          UPDATE knowledge SET confidence = MAX(0.30, confidence - 0.03), updated_at = datetime('now')
          WHERE id = ? AND status = 'active'
        `).run(event.atom_id);
      }
    }
  }

  if (events.length > 0) {
    const referenced = events.filter(e => {
      const terms = (e.content || "").toLowerCase().match(/\b[a-z_]{5,}\b/g) || [];
      const unique = [...new Set(terms)].filter(t => !STOPWORDS.has(t)).slice(0, 15);
      if (unique.length === 0) return false;
      const matched = unique.filter(t => {
        const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        return re.test(assistantText);
      }).length;
      return (matched / unique.length) >= 0.4;
    }).length;
    log(`  Injection feedback: ${referenced}/${events.length} injected atoms were referenced`);
  }
}

// ── Injection Cache ─────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function deserializeEmbedding(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

async function refreshInjectionCache(db, project, projectName) {
  try {
    // Load all active atoms with embeddings for this project
    const rows = db.prepare(`
      SELECT k.id, ke.embedding FROM knowledge k
      JOIN knowledge_embeddings ke ON ke.atom_id = k.id
      WHERE k.project = ? AND k.status = 'active' AND k.confidence >= 0.70
    `).all(project);

    if (rows.length === 0) return;

    const atoms = rows.map(r => ({
      id: r.id,
      vec: deserializeEmbedding(r.embedding),
    }));

    // Delete old cache for this project
    db.prepare("DELETE FROM injection_cache WHERE project = ?").run(project);

    const insertCache = db.prepare(`
      INSERT OR REPLACE INTO injection_cache (project, atom_id, score, context_type, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);

    // 1. Project-general: embed project name, rank all atoms
    const [projectEmb] = await generateEmbeddings([projectName || project]);
    const ranked = atoms
      .map(a => ({ id: a.id, score: cosineSimilarity(projectEmb, a.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    for (const r of ranked) {
      insertCache.run(project, r.id, r.score, "project_general");
    }

    // 2. File-based: collect file basenames from recent atoms
    const recentAtoms = db.prepare(`
      SELECT id, content FROM knowledge
      WHERE project = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 50
    `).all(project);

    const fileSet = new Set();
    for (const atom of recentAtoms) {
      for (const f of extractFileReferences(atom)) {
        fileSet.add(f.replace(/\.[^.]*$/, "")); // basename without extension
      }
    }

    const files = [...fileSet].slice(0, 20); // cap to avoid excessive API calls
    if (files.length > 0) {
      const fileEmbs = await generateEmbeddings(files);
      for (let i = 0; i < files.length; i++) {
        const fileRanked = atoms
          .map(a => ({ id: a.id, score: cosineSimilarity(fileEmbs[i], a.vec) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        for (const r of fileRanked) {
          insertCache.run(project, r.id, r.score, `file:${files[i]}`);
        }
      }
    }

    const totalEntries = db.prepare("SELECT COUNT(*) as c FROM injection_cache WHERE project = ?").get(project).c;
    log(`  Injection cache refreshed: ${totalEntries} entries for ${project}`);
  } catch (err) {
    log(`  Injection cache refresh failed (non-critical): ${err.message}`);
  }
}

// ── Consolidation ───────────────────────────────────────────────────────────

async function runConsolidation(db) {
  const atoms = db.prepare(`
    SELECT id, type, content, confidence, created_at, project
    FROM knowledge WHERE status = 'active'
    ORDER BY type, created_at DESC
  `).all();

  if (atoms.length === 0) return;

  const byType = {};
  for (const atom of atoms) {
    (byType[atom.type] = byType[atom.type] || []).push(atom);
  }

  let totalActions = 0;

  const CONSOLIDATION_BATCH_SIZE = 25;
  for (const [type, group] of Object.entries(byType)) {
    if (group.length < 3) continue;

    for (let batchStart = 0; batchStart < group.length; batchStart += CONSOLIDATION_BATCH_SIZE) {
    const batch = group.slice(batchStart, batchStart + CONSOLIDATION_BATCH_SIZE);
    const atomList = batch.map(a =>
      `[#${a.id}] (confidence: ${a.confidence}, created: ${a.created_at}) ${a.content}`
    ).join("\n");

    let result;
    try {
      result = await callConsolidationCLI(atomList, type);
    } catch (err) {
      log(`Consolidation failed for type ${type} batch ${batchStart}: ${err.message}`);
      continue;
    }

    // Process merges
    for (const merge of (result.merge || [])) {
      try {
        db.transaction(() => {
          const keepId = merge.atom_ids[0];
          const tags = enrichConcepts(merge.merged_content);
          db.prepare("UPDATE knowledge SET content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?")
            .run(merge.merged_content, tags, keepId);
          for (const id of merge.atom_ids.slice(1)) {
            db.prepare("UPDATE knowledge SET status = 'archived', superseded_by = ? WHERE id = ?")
              .run(keepId, id);
            try { db.prepare("DELETE FROM knowledge_embeddings WHERE atom_id = ?").run(id); } catch {}
          }
        })();
        totalActions++;
        log(`  Merged atoms ${merge.atom_ids.join(",")} -> #${merge.atom_ids[0]}`);

        // Re-embed merged content
        try {
          const [emb] = await generateEmbeddings([merge.merged_content]);
          storeKnowledgeEmbedding(db, merge.atom_ids[0], emb);
        } catch { /* stale embedding persists until next consolidation */ }
      } catch (err) {
        log(`  Merge failed for atoms ${merge.atom_ids}: ${err.message}`);
      }
    }

    // Process archives
    for (const arch of (result.archive || [])) {
      try {
        db.prepare("UPDATE knowledge SET status = 'archived' WHERE id = ?").run(arch.atom_id);
        try { db.prepare("DELETE FROM knowledge_embeddings WHERE atom_id = ?").run(arch.atom_id); } catch {}
        totalActions++;
        log(`  Archived atom #${arch.atom_id}: ${arch.reason}`);
      } catch (err) {
        log(`  Archive failed for atom ${arch.atom_id}: ${err.message}`);
      }
    }

    // Store contradictions
    for (const c of (result.contradictions || [])) {
      for (const atomId of c.atom_ids) {
        try {
          const otherIds = c.atom_ids.filter(id => id !== atomId).join(",");
          db.prepare("UPDATE knowledge SET contradiction_note = ? WHERE id = ?")
            .run(`Conflicts with atom(s) #${otherIds}: ${c.description}`, atomId);
        } catch (err) {
          log(`  Contradiction store failed for atom ${atomId}: ${err.message}`);
        }
      }
      totalActions++;
      log(`  CONTRADICTION: atoms ${c.atom_ids.join(",")} - ${c.description}`);
    }
    } // end batch loop
  }

  // Git-aware staleness: check if referenced files have changed significantly
  try {
    totalActions += runGitAwareStaleness(db);
  } catch (err) {
    log(`  Git-aware staleness check failed: ${err.message}`);
  }

  // 180-day fallback: flag very old atoms for review (not auto-archived)
  try {
    const veryOld = db.prepare(`
      SELECT id FROM knowledge
      WHERE status = 'active'
      AND created_at < datetime('now', '-180 days')
      AND (updated_at IS NULL OR updated_at < datetime('now', '-90 days'))
    `).all();
    for (const atom of veryOld) {
      db.prepare(`
        UPDATE knowledge SET contradiction_note = COALESCE(contradiction_note, '') || ' [180-day review needed]'
        WHERE id = ? AND (contradiction_note IS NULL OR contradiction_note NOT LIKE '%180-day%')
      `).run(atom.id);
    }
    if (veryOld.length > 0) {
      log(`  Flagged ${veryOld.length} atoms older than 180 days for review`);
      totalActions += veryOld.length;
    }
  } catch { /* non-critical */ }

  log(`Consolidation complete: ${totalActions} actions`);
}

// ── Git-Aware Staleness ─────────────────────────────────────────────────────

const FILE_PATTERN = /(?:^|\s|\/)([\w.-]+\.(?:js|ts|jsx|tsx|py|sh|css|json|yaml|yml|toml|sql|go|rs|rb))\b/g;

function extractFileReferences(atom) {
  const files = [];
  let match;
  const regex = new RegExp(FILE_PATTERN.source, FILE_PATTERN.flags);
  while ((match = regex.exec(atom.content)) !== null) {
    files.push(match[1]);
  }
  return [...new Set(files)];
}

function resolveProjectDirFromHash(projectHash) {
  const PROJECTS_DIR = join(HOME, ".claude", "projects");
  try {
    const dirs = readdirSync(PROJECTS_DIR);
    for (const d of dirs) {
      const hash = createHash("sha256").update(d).digest("hex").slice(0, 16);
      if (hash === projectHash) {
        const actualPath = d.replace(/^-/, "/").replace(/-/g, "/");
        if (existsSync(actualPath) && existsSync(join(actualPath, ".git"))) {
          return actualPath;
        }
        break;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function runGitAwareStaleness(db) {
  let flagged = 0;

  // Phase 1: Hash-based staleness (new atoms with git context)
  const hashAtoms = db.prepare(`
    SELECT id, content, metadata, project, git_commit_hash, git_project_dir
    FROM knowledge WHERE status = 'active'
    AND git_commit_hash IS NOT NULL AND git_project_dir IS NOT NULL
    AND (content LIKE '%.js%' OR content LIKE '%.ts%' OR content LIKE '%.py%'
      OR content LIKE '%.jsx%' OR content LIKE '%.tsx%' OR content LIKE '%.sh%')
  `).all();

  for (const atom of hashAtoms) {
    const files = extractFileReferences(atom);
    if (files.length === 0) continue;

    const dir = atom.git_project_dir;
    if (!existsSync(join(dir, ".git"))) continue;

    // Check if HEAD has moved since atom creation
    let currentHead;
    try {
      currentHead = execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: "utf8", timeout: 3000 }).trim();
    } catch { continue; }

    if (currentHead === atom.git_commit_hash) {
      // No changes since atom was created - clear any stale flag
      db.prepare(`UPDATE knowledge SET git_staleness = NULL WHERE id = ? AND git_staleness IS NOT NULL`).run(atom.id);
      continue;
    }

    for (const file of files) {
      try {
        const diffStat = execSync(
          `git -C "${dir}" diff --stat ${atom.git_commit_hash}..HEAD -- "*${file}"`,
          { encoding: "utf8", timeout: 5000 }
        ).trim();

        if (!diffStat) continue;

        const insertions = parseInt((diffStat.match(/(\d+) insertion/) || [0, 0])[1]);
        const deletions = parseInt((diffStat.match(/(\d+) deletion/) || [0, 0])[1]);
        const totalChanges = insertions + deletions;

        if (totalChanges > 50) {
          const staleness = `${file} changed ${totalChanges} lines since ${atom.git_commit_hash.slice(0, 8)}`;
          db.prepare(`
            UPDATE knowledge SET
              git_staleness = ?,
              confidence = MAX(0.30, confidence - 0.15),
              updated_at = datetime('now')
            WHERE id = ?
          `).run(staleness, atom.id);
          flagged++;
          log(`  Git-stale (hash): atom #${atom.id} - ${staleness}`);
          break;
        }
      } catch { /* git command failed, skip */ }
    }
  }

  // Phase 2: Legacy date-based staleness (atoms without git context)
  const legacyAtoms = db.prepare(`
    SELECT id, content, metadata, project, created_at
    FROM knowledge WHERE status = 'active'
    AND git_commit_hash IS NULL
    AND (content LIKE '%.js%' OR content LIKE '%.ts%' OR content LIKE '%.py%'
      OR content LIKE '%.jsx%' OR content LIKE '%.tsx%' OR content LIKE '%.sh%')
  `).all();

  // Group by project to minimize dir lookups
  const projectAtoms = new Map();
  for (const atom of legacyAtoms) {
    const files = extractFileReferences(atom);
    if (files.length === 0) continue;
    const key = atom.project || "unknown";
    if (!projectAtoms.has(key)) projectAtoms.set(key, []);
    projectAtoms.get(key).push({ ...atom, referencedFiles: files });
  }

  for (const [projectHash, atoms] of projectAtoms) {
    const projectDir = resolveProjectDirFromHash(projectHash);
    if (!projectDir) continue;

    for (const atom of atoms) {
      const createdAt = atom.created_at || "";
      for (const file of atom.referencedFiles) {
        try {
          const diffStat = execSync(
            `git -C "${projectDir}" log --since="${createdAt}" --stat --oneline -- "*${file}" 2>/dev/null | tail -1`,
            { encoding: "utf8", timeout: 5000 }
          ).trim();

          if (!diffStat) continue;

          const insertions = parseInt((diffStat.match(/(\d+) insertion/) || [0, 0])[1]);
          const deletions = parseInt((diffStat.match(/(\d+) deletion/) || [0, 0])[1]);
          const totalChanges = insertions + deletions;

          if (totalChanges > 50) {
            const staleness = `${file} changed ${totalChanges} lines (date-based)`;
            const note = ` [git: ${file} changed ${totalChanges} lines since atom created]`;
            db.prepare(`
              UPDATE knowledge SET
                git_staleness = ?,
                confidence = MAX(0.30, confidence - 0.15),
                contradiction_note = COALESCE(contradiction_note, '') || ?,
                updated_at = datetime('now')
              WHERE id = ? AND (contradiction_note IS NULL OR contradiction_note NOT LIKE ?)
            `).run(staleness, note, atom.id, `%git:%${file}%`);
            flagged++;
            log(`  Git-stale (legacy): atom #${atom.id} - ${staleness}`);
            break;
          }
        } catch { /* git command failed, skip */ }
      }
    }
  }

  return flagged;
}

// ── Type-Based Decay / Archive Stale ────────────────────────────────────────

function runArchiveStale(db) {
  // Delete any atom not accessed or updated in the last 180 days
  const staleIds = db.prepare(`
    SELECT id FROM knowledge WHERE status = 'active'
    AND MAX(
      COALESCE(last_accessed_at, created_at),
      COALESCE(updated_at, created_at)
    ) < datetime('now', '-180 days')
  `).all();
  for (const { id } of staleIds) {
    try { db.prepare("DELETE FROM knowledge_embeddings WHERE atom_id = ?").run(id); } catch {}
  }
  if (staleIds.length > 0) {
    db.prepare(`
      DELETE FROM knowledge WHERE status = 'active'
      AND MAX(
        COALESCE(last_accessed_at, created_at),
        COALESCE(updated_at, created_at)
      ) < datetime('now', '-180 days')
    `).run();
    log(`Deleted ${staleIds.length} stale atoms (180+ days unused)`);
  }
  return staleIds.length;
}

// ── Retry Failed Embeddings ──────────────────────────────────────────────────

async function retryFailedEmbeddings(db) {
  // Process up to 5 threads per cycle, handle each turn individually on failure
  const failedThreads = db.prepare(
    "SELECT DISTINCT thread_id FROM turns WHERE embed_status IN ('failed', 'pending') LIMIT 5"
  ).all();

  if (failedThreads.length === 0) return 0;

  const exists = db.prepare("SELECT 1 FROM turn_embeddings WHERE turn_id = ?");
  let fixed = 0;
  for (const { thread_id } of failedThreads) {
    const turns = db.prepare(
      "SELECT id, user_content, assistant_content FROM turns WHERE thread_id = ? AND embed_status IN ('failed', 'pending')"
    ).all(thread_id);

    // Filter out turns that already have embeddings (from partial previous runs)
    const needsEmbed = turns.filter(t => !exists.get(t.id));
    // Mark already-embedded turns as done
    for (const t of turns) {
      if (exists.get(t.id)) {
        db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(t.id);
        fixed++;
      }
    }

    const pairs = needsEmbed
      .map(t => ({ id: t.id, text: ((t.user_content || "") + " " + (t.assistant_content || "")).trim() }))
      .filter(p => p.text.length > 0);

    if (pairs.length === 0) continue;

    try {
      for (let i = 0; i < pairs.length; i += 20) {
        const batch = pairs.slice(i, i + 20);
        const embeddings = await generateEmbeddings(batch.map(p => p.text));
        storeTurnEmbeddings(db, batch.map(p => ({ id: p.id })), embeddings);
        for (const p of batch) {
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
        }
        fixed += batch.length;
      }
    } catch (err) {
      // Batch failed - likely one oversized turn. Try individually.
      for (const p of pairs) {
        try {
          const [emb] = await generateEmbeddings([p.text]);
          storeTurnEmbeddings(db, [{ id: p.id }], [emb]);
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
          fixed++;
        } catch (singleErr) {
          // Permanently too large or other error - mark done with no embedding
          db.prepare("UPDATE turns SET embed_status = 'done' WHERE id = ?").run(p.id);
          log(`  Skipped oversized turn ${p.id} (${p.text.length} chars): ${singleErr.message.slice(0, 80)}`);
          fixed++;
        }
      }
    }
  }

  if (fixed > 0) log(`  Retried ${fixed} failed embeddings`);
  return fixed;
}

// ── Daily Backup ────────────────────────────────────────────────────────────

function runDailyBackup(db) {
  const backupPath = join(SERVER_DIR, "data", "memory-backup.db");
  db.backup(backupPath);
  log("Daily backup complete");

  // Truncate worker.log if too large
  try {
    const logStat = statSync(LOG_FILE);
    if (logStat.size > 1024 * 1024) { // > 1MB
      const lines = readFileSync(LOG_FILE, "utf8").split("\n");
      writeFileSync(LOG_FILE, lines.slice(-500).join("\n"));
      log("Truncated worker.log");
    }
  } catch { /* ignore */ }

  // Clean old snapshots (>7 days, successfully ingested)
  if (existsSync(SNAPSHOTS_DIR)) {
    try {
      const now = Date.now();
      const files = readdirSync(SNAPSHOTS_DIR);
      for (const f of files) {
        const fp = join(SNAPSHOTS_DIR, f);
        const age = now - statSync(fp).mtimeMs;
        if (age > 7 * 24 * 60 * 60 * 1000) {
          unlinkSync(fp);
          log(`  Deleted old snapshot: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  // Clean old recovery buffer
  db.prepare("DELETE FROM recovery_buffer WHERE created_at < datetime('now', '-1 hour')").run();
}

// ── Stats Snapshot ──────────────────────────────────────────────────────────

function runStatsSnapshot(db) {
  const active = db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE status='active'").get().c;
  const threads = db.prepare("SELECT COUNT(*) as c FROM threads").get().c;
  const turns = db.prepare("SELECT COUNT(*) as c FROM turns").get().c;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO stats_daily (date, total_atoms, total_threads)
      VALUES (date('now'), ?, ?)
    `).run(active, threads);
  } catch (err) {
    log(`Stats snapshot skipped: ${err.message}`);
  }
}

// ── Scheduled Job Checks ────────────────────────────────────────────────────

function shouldRunConsolidation(db) {
  // Every 20 extractions or weekly
  const lastConsolidation = db.prepare(`
    SELECT MAX(completed_at) as last FROM jobs
    WHERE type = 'consolidate' AND status = 'done'
  `).get();

  if (!lastConsolidation?.last) return true; // Never ran

  const daysSince = (Date.now() - new Date(lastConsolidation.last + "Z").getTime()) / 86400000;
  if (daysSince >= 7) return true;

  // Count extractions since last consolidation
  const recentExtractions = db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE type = 'ingest_thread' AND status = 'done'
    AND completed_at > ?
  `).get(lastConsolidation.last).c;

  return recentExtractions >= 20;
}

function shouldRunArchiveStale(db) {
  const lastRun = db.prepare(`
    SELECT MAX(completed_at) as last FROM jobs
    WHERE type = 'archive_stale' AND status = 'done'
    AND completed_at > datetime('now', '-1 day')
  `).get();
  return !lastRun?.last;
}

function shouldRunDailyBackup(db) {
  // Check backup file age
  const backupPath = join(SERVER_DIR, "data", "memory-backup.db");
  if (!existsSync(backupPath)) return true;
  const age = Date.now() - statSync(backupPath).mtimeMs;
  return age > 24 * 60 * 60 * 1000;
}

// ── Job Processing ──────────────────────────────────────────────────────────

async function processJob(db, job) {
  const payload = JSON.parse(job.payload || "{}");

  switch (job.type) {
    case "ingest_thread": {
      const filePath = payload.transcript_path || payload.session_file;
      const project = payload.project || "unknown";
      const projectName = payload.project_name || basename(project);
      const isFullSession = !!payload.is_full_session;

      if (!filePath || !existsSync(filePath)) {
        log(`Transcript not found: ${filePath}`);
        return 0;
      }

      const gitCommitHash = payload.git_commit_hash || null;
      const gitProjectDir = payload.git_project_dir || null;
      const forceExtract = !!payload.force_extract;

      log(`Ingesting: ${basename(filePath)} (project: ${projectName})${forceExtract ? ' [force re-extract]' : ''}`);
      return await ingestThread(db, filePath, project, projectName, isFullSession, gitCommitHash, gitProjectDir, forceExtract);
    }

    case "consolidate": {
      log("Running consolidation");
      await runConsolidation(db);
      return 1;
    }

    case "archive_stale": {
      log("Running archive_stale");
      return runArchiveStale(db);
    }

    case "hindsight_extract": {
      const project = payload.project || "unknown";
      const projectName = payload.project_name || basename(project);
      log(`Running hindsight extraction for project: ${projectName}`);
      return await processHindsightExtraction(db, project, projectName);
    }

    default:
      log(`Unknown job type: ${job.type}`);
      return 0;
  }
}

// ── Claim Job (atomic) ──────────────────────────────────────────────────────

function claimNextJob(db) {
  return db.prepare(`
    UPDATE jobs SET status = 'processing', started_at = datetime('now')
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND attempts < 3
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get();
}

function markDone(db, jobId) {
  db.prepare("UPDATE jobs SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(jobId);
}

function markFailed(db, jobId, error) {
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(error, jobId);
}

function markPending(db, jobId) {
  db.prepare(`
    UPDATE jobs SET status = 'pending', attempts = attempts + 1
    WHERE id = ?
  `).run(jobId);
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function startup() {
  loadEnv();

  // Validate API keys
  if (!process.env.OPENAI_API_KEY) {
    log("FATAL: OPENAI_API_KEY not set. Check .env file.");
    process.exit(1);
  }

  // Test OpenAI connectivity
  try {
    await generateEmbeddings(["test"]);
    log("OpenAI API: OK");
  } catch (err) {
    log(`FATAL: OpenAI API test failed: ${err.message}`);
    process.exit(1);
  }

  // Test Claude CLI
  try {
    const claudePath = process.env.CLAUDE_CLI_PATH || join(HOME, ".local", "bin", "claude");
    if (!existsSync(claudePath)) {
      log(`FATAL: Claude CLI not found at ${claudePath}`);
      process.exit(1);
    }
    log("Claude CLI: found");
  } catch (err) {
    log(`FATAL: Claude CLI check failed: ${err.message}`);
    process.exit(1);
  }

  // Open database
  const db = openDatabase();

  // Recovery sweep: reset stuck jobs
  const stuck = db.prepare(`
    UPDATE jobs SET status = 'pending', attempts = attempts + 1
    WHERE status = 'processing'
    AND started_at < datetime('now', '-5 minutes')
  `).run();
  if (stuck.changes > 0) {
    log(`Recovered ${stuck.changes} stuck jobs from previous crash`);
  }

  // Acquire worker lock - prevent duplicate workers from race conditions
  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if dead
        const cmd = `ps -p ${existingPid} -o command=`;
        const out = execSync(cmd, { encoding: "utf-8", timeout: 2000 }).trim();
        if (out.includes("worker.js")) {
          log(`Another worker already running (PID ${existingPid}), exiting.`);
          process.exit(0);
        }
      } catch {
        // PID dead or not our worker - take over
      }
    }
  }

  // Write PID file
  writeFileSync(PID_FILE, process.pid.toString());
  log(`Worker started (PID: ${process.pid})`);

  return db;
}

async function handleJob(db, job) {
  try {
    const result = await processJob(db, job);
    markDone(db, job.id);

    // Queue hindsight extraction after successful ingest_thread
    if (job.type === "ingest_thread") {
      const payload = JSON.parse(job.payload || "{}");
      const atomsExtracted = result > 0;
      const forceExtract = !!payload.force_extract;

      if (atomsExtracted || forceExtract) {
        const project = payload.project || "unknown";
        // Check for existing pending hindsight job for this project
        const existing = db.prepare(`
          SELECT 1 FROM jobs
          WHERE type = 'hindsight_extract' AND status = 'pending'
          AND json_extract(payload, '$.project') = ?
        `).get(project);

        if (!existing) {
          db.prepare(`
            INSERT INTO jobs (type, payload, priority, status, created_at)
            VALUES ('hindsight_extract', ?, 1, 'pending', datetime('now'))
          `).run(JSON.stringify({
            project,
            project_name: payload.project_name || basename(project),
          }));
          log(`Queued hindsight_extract for project ${payload.project_name || project}`);
        }
      }
    }
  } catch (err) {
    const isAuthError = err.status === 401 || err.status === 403
      || (err.message && err.message.includes("invalid_api_key"));
    if (isAuthError) {
      log(`FATAL: API authentication failed: ${err.message}`);
      markFailed(db, job.id, "auth_error: " + err.message);
      throw err; // Propagate to stop the worker
    } else if (job.attempts < 3) {
      log(`Job ${job.id} failed (will retry): ${err.message}`);
      markPending(db, job.id);
    } else {
      log(`Job ${job.id} permanently failed: ${err.message}`);
      markFailed(db, job.id, err.message);
    }
  }
}

async function pollLoop(db) {
  const inFlight = new Set();
  let authError = null;

  while (true) {
    // Check for auth errors from previous cycle
    if (authError) {
      log(`Fatal auth error (${authError.status}), stopping worker.`);
      process.exit(1);
    }

    try {
      // Claim jobs up to CONCURRENCY limit
      while (inFlight.size < CONCURRENCY) {
        const job = claimNextJob(db);
        if (!job) break;

        const promise = handleJob(db, job).then(() => {
          inFlight.delete(promise);
        }).catch((err) => {
          inFlight.delete(promise);
          if (err.status === 401 || err.status === 403) {
            authError = err;
          }
        });
        inFlight.add(promise);
      }

      // If we have in-flight jobs, wait for at least one to finish
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
        continue; // Try to fill slots immediately
      }

      // Scheduled jobs (only check when idle)
      if (shouldRunConsolidation(db)) {
        db.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('consolidate', '{}', 2)").run();
        log("Queued consolidation job");
      }
      if (shouldRunArchiveStale(db)) {
        db.prepare("INSERT INTO jobs (type, payload, priority) VALUES ('archive_stale', '{}', 1)").run();
        log("Queued archive_stale job");
      }
      // Retry failed embeddings periodically
      try {
        await retryFailedEmbeddings(db);
      } catch { /* non-critical */ }
      if (shouldRunDailyBackup(db)) {
        runDailyBackup(db);
        runStatsSnapshot(db);
      }
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── Signal Handlers ─────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("Worker shutting down (SIGTERM)");
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Worker shutting down (SIGINT)");
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(0);
});

// ── Entry Point ─────────────────────────────────────────────────────────────

startup().then(db => pollLoop(db)).catch(err => {
  log(`Fatal error: ${err.message}`);
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.exit(1);
});
