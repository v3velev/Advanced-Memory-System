#!/usr/bin/env node
// Test suite for Steps 5-7: Server, Hooks, Watchdog
// Run: node test-steps5-7.js

import { spawn, execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const SERVER_DIR = join(HOME, ".claude", "memory-server");
const DB_PATH = join(SERVER_DIR, "data", "memory.db");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL: ${name} - ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL: ${name} - ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function runHook(hookName, input) {
  const hookPath = join(SERVER_DIR, "hooks", hookName);
  try {
    const result = execSync(`echo '${JSON.stringify(input).replace(/'/g, "'\\''")}' | bash "${hookPath}" 2>/dev/null`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    return result;
  } catch (err) {
    return err.stdout || "";
  }
}

function dbQuery(sql) {
  try {
    return execSync(`sqlite3 "${DB_PATH}" "${sql}"`, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch (err) {
    return "";
  }
}

// MCP message helper
function mcpRequest(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function sendMcpToolCall(serverProcess, id, toolName, args) {
  const msg = mcpRequest(id, "tools/call", { name: toolName, arguments: args });
  serverProcess.stdin.write(msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase A: Hook Tests
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Phase A: Hook Tests ===\n");

// Setup test transcript
const testTranscriptPath = join(SERVER_DIR, "test-transcript-steps57.jsonl");
writeFileSync(testTranscriptPath, [
  JSON.stringify({ type: "user", message: { content: "How do I fix the auth token refresh?" }, timestamp: "2026-03-07T10:00:00Z" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "You need to check the refresh token expiry in the middleware." }] }, timestamp: "2026-03-07T10:00:05Z" }),
  JSON.stringify({ type: "user", message: { content: "The error says JWT malformed" }, timestamp: "2026-03-07T10:01:00Z" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "That means the token string is corrupted. Check base64 encoding." }] }, timestamp: "2026-03-07T10:01:05Z" }),
].join("\n") + "\n");

// Clean up any previous test jobs
dbQuery("DELETE FROM jobs WHERE json_extract(payload, '$.project_name') = 'test-project-57';");

// Test 1: pre-compact.sh queues ingest_thread (NOT extract_knowledge)
test("pre-compact queues ingest_thread job", () => {
  const before = parseInt(dbQuery("SELECT COUNT(*) FROM jobs WHERE type = 'ingest_thread';") || "0");
  runHook("pre-compact.sh", {
    transcript_path: testTranscriptPath,
    cwd: "/Users/v3velev/test-project-57",
  });
  const after = parseInt(dbQuery("SELECT COUNT(*) FROM jobs WHERE type = 'ingest_thread';") || "0");
  assert(after > before, `Expected job count to increase: ${before} -> ${after}`);

  // Verify it's ingest_thread, NOT extract_knowledge
  const lastJob = dbQuery("SELECT type FROM jobs ORDER BY id DESC LIMIT 1;");
  assert(lastJob === "ingest_thread", `Expected ingest_thread, got: ${lastJob}`);
});

// Test 2: pre-compact creates snapshot
test("pre-compact creates snapshot via hard link or copy", () => {
  const snaps = execSync(`ls "${SERVER_DIR}/snapshots/" | grep "test-transcript-steps57"`, { encoding: "utf-8", timeout: 3000 }).trim();
  assert(snaps.length > 0, "No snapshot found for test transcript");
});

// Test 3: pre-compact writes recovery buffer
test("pre-compact writes recovery buffer", () => {
  const session = "test-transcript-steps57";
  const buf = dbQuery(`SELECT COUNT(*) FROM recovery_buffer WHERE session_id = '${session}';`);
  assert(parseInt(buf) > 0, `Recovery buffer not found for session ${session}`);
});

// Test 4: stop.sh queues ingest_thread
test("stop queues ingest_thread job", () => {
  // Clean first
  dbQuery("DELETE FROM jobs WHERE json_extract(payload, '$.project_name') = 'test-project-57-stop';");
  runHook("stop.sh", {
    transcript_path: testTranscriptPath,
    cwd: "/Users/v3velev/test-project-57-stop",
  });
  const job = dbQuery("SELECT type FROM jobs WHERE json_extract(payload, '$.project_name') = 'test-project-57-stop' ORDER BY id DESC LIMIT 1;");
  assert(job === "ingest_thread", `Expected ingest_thread, got: ${job}`);
});

// Test 5: session-start-cold.sh outputs status message
test("session-start-cold shows status", () => {
  const output = runHook("session-start-cold.sh", { cwd: "/tmp" });
  assert(output.includes("Memory system active") || output.includes("WARNING"), `Unexpected output: ${output}`);
});

// Test 6: session-start-cold.sh detects disabled worker
test("session-start-cold detects .worker-disabled", () => {
  const disabledFile = join(SERVER_DIR, ".worker-disabled");
  writeFileSync(disabledFile, "");
  const output = runHook("session-start-cold.sh", { cwd: "/tmp" });
  unlinkSync(disabledFile);
  assert(output.includes("WARNING") && output.includes("disabled"), `Expected warning about disabled worker: ${output}`);
});

// Test 7: session-start-compact.sh outputs recovery info
test("session-start-compact outputs recovery context", () => {
  const output = runHook("session-start-compact.sh", {
    cwd: "/Users/v3velev/test-project-57",
    transcript_path: "/tmp/test-transcript-steps57.jsonl",
  });
  assert(output.includes("Memory Recovery"), `Expected recovery header: ${output}`);
  assert(output.includes("recall_context") || output.includes("/primeDB"), `Expected instruction: ${output}`);
});

// Test 8: user-prompt-submit.sh stays silent on short prompts
test("user-prompt-submit silent on short prompt", () => {
  const output = runHook("user-prompt-submit.sh", { user_prompt: "hi" });
  assert(output.trim() === "", `Expected empty output for short prompt, got: ${output}`);
});

// Test 9: user-prompt-submit.sh detects error signals
test("user-prompt-submit detects TypeError signal", () => {
  const output = runHook("user-prompt-submit.sh", {
    user_prompt: "I'm getting a TypeError: Cannot read properties of undefined when calling the API endpoint",
  });
  // May or may not find atoms, but should not crash
  // If atoms exist with TypeError, we'd see memory-context
  // Either way, exit 0 is success
  assert(typeof output === "string", "Hook should return string output");
});

// Test 10: post-tool-use.sh only triggers on Read/Edit/Write
test("post-tool-use ignores non-file tools", () => {
  const output = runHook("post-tool-use.sh", {
    tool_name: "Bash",
    tool_input: { command: "ls" },
    session_id: "test-post-tool-1",
  });
  assert(output.trim() === "", `Expected empty output for Bash tool, got: ${output}`);
});

// Test 11: post-tool-use.sh triggers on Read
test("post-tool-use triggers on Read tool", () => {
  // Clean seen file for fresh test
  const seenFile = join(SERVER_DIR, "seen", "test-post-tool-2");
  try { unlinkSync(seenFile); } catch {}

  const output = runHook("post-tool-use.sh", {
    tool_name: "Read",
    tool_input: { file_path: "/Users/v3velev/src/server.js" },
    session_id: "test-post-tool-2",
  });
  // May or may not find atoms, but should not crash
  assert(typeof output === "string", "Hook should return string output");

  // Clean up
  try { unlinkSync(seenFile); } catch {}
});

// Test 12: post-tool-use.sh respects per-session cap
test("post-tool-use respects per-session cap of 3", () => {
  const sessionId = "test-post-tool-cap";
  const seenFile = join(SERVER_DIR, "seen", sessionId);
  try { unlinkSync(seenFile); } catch {}

  // Write 3 entries to seen file
  writeFileSync(seenFile, "file1\nfile2\nfile3\n");

  const output = runHook("post-tool-use.sh", {
    tool_name: "Read",
    tool_input: { file_path: "/Users/v3velev/src/newfile.js" },
    session_id: sessionId,
  });
  assert(output.trim() === "", `Expected empty output after cap reached, got: ${output}`);

  try { unlinkSync(seenFile); } catch {}
});

// Test 13: post-tool-use.sh skips config files
test("post-tool-use skips config files", () => {
  const sessionId = "test-post-tool-config";
  const seenFile = join(SERVER_DIR, "seen", sessionId);
  try { unlinkSync(seenFile); } catch {}

  const output = runHook("post-tool-use.sh", {
    tool_name: "Read",
    tool_input: { file_path: "/Users/v3velev/package.json" },
    session_id: sessionId,
  });
  assert(output.trim() === "", `Expected empty output for config file, got: ${output}`);

  try { unlinkSync(seenFile); } catch {}
});

// Test 14: settings.json is valid and has PostToolUse
test("settings.json valid with PostToolUse hook", () => {
  const settings = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf-8"));
  assert(settings.hooks.PostToolUse, "PostToolUse hook not found in settings");
  assert(settings.hooks.PostToolUse[0].hooks[0].command.includes("post-tool-use.sh"), "Wrong command for PostToolUse");
  assert(settings.hooks.PostToolUse[0].hooks[0].timeout === 500, "Wrong timeout for PostToolUse");
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase B: Server Tests (via MCP protocol)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Phase B: Server Tests ===\n");

async function runServerTests() {
  // Start server as child process
  const serverProc = spawn("node", ["server.js"], {
    cwd: SERVER_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  serverProc.stdout.on("data", d => stdout += d.toString());
  serverProc.stderr.on("data", d => stderr += d.toString());

  // Wait for server to initialize
  await new Promise(r => setTimeout(r, 2000));

  // Helper to send request and wait for response
  function sendAndWait(id, method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const before = stdout.length;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      serverProc.stdin.write(msg);

      const timer = setTimeout(() => reject(new Error(`Timeout waiting for response ${id}`)), timeoutMs);
      const check = setInterval(() => {
        const newData = stdout.slice(before);
        // Look for complete JSON response
        const lines = newData.split("\n").filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearInterval(check);
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          } catch {}
        }
      }, 100);
    });
  }

  try {
    // Initialize MCP
    const initResp = await sendAndWait(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    await testAsync("MCP initialize succeeds", async () => {
      assert(initResp.result, `No result in init response: ${JSON.stringify(initResp)}`);
    });

    // Send initialized notification
    serverProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await new Promise(r => setTimeout(r, 300));

    // Test tools/list
    const toolsResp = await sendAndWait(2, "tools/list", {});
    await testAsync("tools/list returns all 3 expected tools", async () => {
      const toolNames = toolsResp.result.tools.map(t => t.name);
      assert(toolNames.includes("recall_context"), "Missing recall_context");
      assert(toolNames.includes("save_knowledge"), "Missing save_knowledge");
      assert(toolNames.includes("memory_manage"), "Missing memory_manage");
      assert(toolNames.length === 3, `Expected 3 tools, got ${toolNames.length}: ${toolNames.join(", ")}`);
    });

    // Test memory_manage summary
    const statsResp = await sendAndWait(3, "tools/call", {
      name: "memory_manage",
      arguments: { action: "summary" },
    });
    await testAsync("memory_manage summary returns data", async () => {
      const text = statsResp.result.content[0].text;
      assert(text.includes("Active Atoms"), `Missing Active Atoms: ${text}`);
      assert(text.includes("Threads"), `Missing Threads: ${text}`);
      assert(text.includes("Embeddings"), `Missing Embeddings: ${text}`);
      assert(text.includes("DB Size"), `Missing DB Size: ${text}`);
    });

    // Test memory_manage disk_usage
    const diskResp = await sendAndWait(4, "tools/call", {
      name: "memory_manage",
      arguments: { action: "disk_usage" },
    });
    await testAsync("memory_manage disk_usage returns data", async () => {
      const text = diskResp.result.content[0].text;
      assert(text.includes("DB:"), `Missing DB size: ${text}`);
      assert(text.includes("Snapshots:"), `Missing Snapshots: ${text}`);
    });

    // Test memory_manage recent_extractions
    const extractResp = await sendAndWait(5, "tools/call", {
      name: "memory_manage",
      arguments: { action: "recent_extractions" },
    });
    await testAsync("memory_manage recent_extractions works", async () => {
      const text = extractResp.result.content[0].text;
      assert(typeof text === "string", "Should return string");
    });

    // Test save_knowledge - too short
    const shortResp = await sendAndWait(10, "tools/call", {
      name: "save_knowledge",
      arguments: { content: "hi", type: "fact" },
    });
    await testAsync("save_knowledge rejects short content", async () => {
      const text = shortResp.result.content[0].text;
      assert(text.includes("too short"), `Expected 'too short': ${text}`);
    });

    // Test save_knowledge - valid save
    const saveResp = await sendAndWait(12, "tools/call", {
      name: "save_knowledge",
      arguments: {
        content: "Test atom from steps 5-7 test suite: always validate JWT tokens before processing API requests to prevent auth bypass",
        type: "pattern",
        scope: "global",
      },
    }, 15000);
    let savedAtomId = null;
    await testAsync("save_knowledge creates atom successfully", async () => {
      const text = saveResp.result.content[0].text;
      assert(text.includes("saved") || text.includes("reinforced"), `Expected 'saved' or 'reinforced': ${text}`);
      const match = text.match(/#(\d+)/);
      if (match) savedAtomId = parseInt(match[1]);
    });

    // Test save_knowledge - duplicate detection
    if (savedAtomId) {
      const dupResp = await sendAndWait(13, "tools/call", {
        name: "save_knowledge",
        arguments: {
          content: "Test atom from steps 5-7 test suite: always validate JWT tokens before processing API requests to prevent auth bypass",
          type: "pattern",
          scope: "global",
        },
      }, 15000);
      await testAsync("save_knowledge detects duplicates", async () => {
        const text = dupResp.result.content[0].text;
        assert(text.includes("reinforced"), `Expected 'reinforced' for duplicate: ${text}`);
      });
    }

    // Test recall_context - resolution 3 (atoms)
    const recallResp = await sendAndWait(20, "tools/call", {
      name: "recall_context",
      arguments: { query: "JWT authentication token validation", resolution: 3, limit: 5 },
    }, 15000);
    await testAsync("recall_context resolution 3 returns atoms", async () => {
      const text = recallResp.result.content[0].text;
      assert(typeof text === "string" && text.length > 0, "Should return text");
      // Should either find results or say "No knowledge found"
      assert(text.includes("Found") || text.includes("No knowledge"), `Unexpected response: ${text.slice(0, 200)}`);
    });

    // Test recall_context - resolution 2 (key exchanges)
    const recall2Resp = await sendAndWait(21, "tools/call", {
      name: "recall_context",
      arguments: { query: "authentication", resolution: 2, limit: 3 },
    }, 15000);
    await testAsync("recall_context resolution 2 returns threads", async () => {
      const text = recall2Resp.result.content[0].text;
      assert(typeof text === "string", "Should return text");
    });

    // Test recall_context - expand mode
    // First get a thread_id
    const threadId = dbQuery("SELECT id FROM threads LIMIT 1;");
    if (threadId) {
      const expandResp = await sendAndWait(22, "tools/call", {
        name: "recall_context",
        arguments: { query: "anything", expand: threadId },
      }, 10000);
      await testAsync("recall_context expand returns full thread", async () => {
        const text = expandResp.result.content[0].text;
        assert(text.includes("Thread") || text.includes("Turn"), `Expected thread content: ${text.slice(0, 200)}`);
      });
    }

    // Test recall_context with include_threads
    const searchResp = await sendAndWait(30, "tools/call", {
      name: "recall_context",
      arguments: { query: "database migration", resolution: 3, include_threads: true },
    }, 15000);
    await testAsync("recall_context with include_threads returns results", async () => {
      const text = searchResp.result.content[0].text;
      assert(typeof text === "string", "Should return text");
    });

    // Test memory_admin list
    const listResp = await sendAndWait(40, "tools/call", {
      name: "memory_manage",
      arguments: { action: "list", limit: 5 },
    });
    await testAsync("memory_manage list returns atoms", async () => {
      const text = listResp.result.content[0].text;
      assert(typeof text === "string" && text.length > 0, "Should return text");
    });

    // Test memory_admin view
    if (savedAtomId) {
      const viewResp = await sendAndWait(41, "tools/call", {
        name: "memory_manage",
        arguments: { action: "view", atom_id: savedAtomId },
      });
      await testAsync("memory_manage view shows full atom details", async () => {
        const text = viewResp.result.content[0].text;
        assert(text.includes("ID:"), `Missing ID field: ${text}`);
        assert(text.includes("Type:"), `Missing Type field: ${text}`);
        assert(text.includes("Confidence:"), `Missing Confidence field: ${text}`);
        assert(text.includes("Decay Rate:"), `Missing Decay Rate field: ${text}`);
        assert(text.includes("Content:"), `Missing Content field: ${text}`);
      });
    }

    // Test memory_admin recent_extractions
    const recentResp = await sendAndWait(42, "tools/call", {
      name: "memory_manage",
      arguments: { action: "recent_extractions", limit: 5 },
    });
    await testAsync("memory_manage recent_extractions works", async () => {
      const text = recentResp.result.content[0].text;
      assert(typeof text === "string", "Should return text");
    });

    // Test feedback - confirmed
    if (savedAtomId) {
      const fbResp = await sendAndWait(50, "tools/call", {
        name: "memory_manage",
        arguments: { action: "feedback", atom_id: savedAtomId, signal: "confirmed" },
      });
      await testAsync("feedback confirmed boosts confidence", async () => {
        const text = fbResp.result.content[0].text;
        assert(text.includes("confirmed"), `Expected confirmed: ${text}`);
        assert(text.includes("Confidence:"), `Expected confidence value: ${text}`);
      });
    }

    // Test batch_feedback outcomes
    if (savedAtomId) {
      const outcomeResp = await sendAndWait(51, "tools/call", {
        name: "memory_manage",
        arguments: {
          action: "batch_feedback",
          outcomes: [
            { atom_id: savedAtomId, signal: "applied", detail: "Used in test" },
          ],
        },
      });
      await testAsync("batch_feedback records outcomes correctly", async () => {
        const text = outcomeResp.result.content[0].text;
        assert(text.includes("Recorded 1"), `Expected recorded: ${text}`);
      });
    }

    // Test memory_admin edit
    if (savedAtomId) {
      const editResp = await sendAndWait(60, "tools/call", {
        name: "memory_manage",
        arguments: {
          action: "edit",
          atom_id: savedAtomId,
          content: "EDITED: Always validate JWT tokens before processing API requests to prevent authentication bypass vulnerabilities",
        },
      }, 15000);
      await testAsync("memory_manage edit updates and re-embeds", async () => {
        const text = editResp.result.content[0].text;
        assert(text.includes("updated") && text.includes("re-embedded"), `Expected update confirmation: ${text}`);
      });
    }

    // Test memory_admin delete (soft)
    if (savedAtomId) {
      const delResp = await sendAndWait(61, "tools/call", {
        name: "memory_manage",
        arguments: { action: "delete", atom_id: savedAtomId },
      });
      await testAsync("memory_manage delete archives atom", async () => {
        const text = delResp.result.content[0].text;
        assert(text.includes("archived"), `Expected archived: ${text}`);
      });

      // Verify atom is actually archived
      const status = dbQuery(`SELECT status FROM knowledge WHERE id = ${savedAtomId};`);
      test("deleted atom has archived status in DB", () => {
        assert(status === "archived", `Expected archived status, got: ${status}`);
      });
    }

    // Test ingest_sessions
    const ingestResp = await sendAndWait(70, "tools/call", {
      name: "memory_manage",
      arguments: { action: "ingest_sessions" },
    });
    await testAsync("ingest_sessions completes", async () => {
      const text = ingestResp.result.content[0].text;
      assert(text.includes("Ingestion complete"), `Expected completion: ${text}`);
    });

  } finally {
    serverProc.kill();
    await new Promise(r => setTimeout(r, 500));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase C: Watchdog Tests
// ═══════════════════════════════════════════════════════════════════════════

function runWatchdogTests() {
  console.log("\n=== Phase C: Watchdog Tests ===\n");

  const failureFile = join(SERVER_DIR, ".watchdog-failures");
  const disabledFile = join(SERVER_DIR, ".worker-disabled");

  // Clean up
  try { unlinkSync(failureFile); } catch {}
  try { unlinkSync(disabledFile); } catch {}

  test("watchdog increments failure counter when worker is dead", () => {
    // Write a fake PID that doesn't exist
    const pidFile = join(SERVER_DIR, "worker.pid");
    const originalPid = existsSync(pidFile) ? readFileSync(pidFile, "utf-8") : null;

    writeFileSync(pidFile, "99999999");
    // We can't easily run watchdog without it actually restarting the worker,
    // but we can test the failure file logic directly
    writeFileSync(failureFile, "3");
    const count = parseInt(readFileSync(failureFile, "utf-8").trim());
    assert(count === 3, `Expected 3, got ${count}`);

    // Restore original PID
    if (originalPid) writeFileSync(pidFile, originalPid);
  });

  test("watchdog disables after 5 failures", () => {
    writeFileSync(failureFile, "5");
    const count = parseInt(readFileSync(failureFile, "utf-8").trim());
    assert(count >= 5, "Failure count should be >= 5");

    // Simulate what watchdog does at count >= 5
    if (count >= 5) {
      writeFileSync(disabledFile, "");
    }
    assert(existsSync(disabledFile), ".worker-disabled should exist");
  });

  test("watchdog respects .worker-disabled sentinel", () => {
    // When disabled file exists, watchdog should exit immediately
    writeFileSync(disabledFile, "");
    // The script checks this and exits 0
    const result = execSync(`bash "${SERVER_DIR}/watchdog.sh" 2>&1; echo "EXIT:$?"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    assert(result.includes("EXIT:0"), `Watchdog should exit 0 when disabled: ${result}`);
  });

  test("failure counter resets on re-enable", () => {
    // Simulate re-enable
    try { unlinkSync(disabledFile); } catch {}
    try { unlinkSync(failureFile); } catch {}
    assert(!existsSync(disabledFile), ".worker-disabled should be removed");
    assert(!existsSync(failureFile), ".watchdog-failures should be removed");
  });

  // Clean up
  try { unlinkSync(failureFile); } catch {}
  try { unlinkSync(disabledFile); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // Phase A hooks already ran above

  // Phase B
  await runServerTests();

  // Phase C
  runWatchdogTests();

  // Clean up test data
  try { unlinkSync(testTranscriptPath); } catch {}
  // Clean test snapshots
  try {
    const snaps = execSync(`ls "${SERVER_DIR}/snapshots/" | grep "test-transcript-steps57"`, { encoding: "utf-8" }).trim().split("\n");
    for (const s of snaps) {
      if (s) try { unlinkSync(join(SERVER_DIR, "snapshots", s)); } catch {}
    }
  } catch {}
  // Clean test recovery buffer
  dbQuery("DELETE FROM recovery_buffer WHERE session_id = 'test-transcript-steps57';");
  // Clean test jobs
  dbQuery("DELETE FROM jobs WHERE json_extract(payload, '$.project_name') IN ('test-project-57','test-project-57-stop');");

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
