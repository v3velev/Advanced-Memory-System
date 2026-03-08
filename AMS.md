> **What this is**: A portable blueprint for project documentation architecture.
>
> **How to use**: Copy this single file into any project root. Tell Claude Code:
> *"Read AMS.md and implement it."*
>
> Claude will: (1) read this blueprint, (2) create the `/implement-ams` skill from the
> embedded definition in Section 12, (3) execute all phases to generate docs, (4) rename
> this file to `AMS.reference.md` so it stops inflating context.
>
> After setup, only the generated docs load into context. This file is a recipe, not a runtime document.

# Autonomous Memory System (AMS) - Ultimate Context & Memory Strategy

## 1. Mental Model

Three constraints govern everything:

1. **Context is finite** - every token of context displaces a token of reasoning
2. **Exploration is expensive** - a single grep+read cycle costs 500-2000 tokens; five exploratory reads waste 5-10k tokens before any real work begins
3. **Wrong context is worse than none** - stale or irrelevant information causes confident mistakes

Five principles follow:

| Principle | Definition |
|-----------|-----------|
| **Information Density** | Every line in context must change behavior. If it doesn't prevent a mistake or guide a decision, delete it. |
| **Predictive Loading** | Structure projects so the right context loads automatically before Claude needs it. |
| **Layered Specificity** | Global rules are broad, folder rules are narrow, inline comments are surgical. |
| **Anti-Exploration** | Eliminate searches by making answers discoverable from file names, types, and CLAUDE.md alone. |
| **Prevention > Recovery** | A 1-line rule that prevents a bug saves more than a 20-minute debugging session. |

---

## 2. CLAUDE.md Architecture

### The Hierarchy

```
~/.claude/CLAUDE.md                          # Global (all projects, all machines)
project/CLAUDE.md                            # Project root (checked in, shared with team)
project/src/CLAUDE.md                        # Source-level rules
project/src/api/CLAUDE.md                    # Domain-scoped: API layer
project/src/db/CLAUDE.md                     # Domain-scoped: database layer
project/.claude/rules/*.md                   # Path-scoped rules (loaded on demand)
~/.claude/projects/<project-hash>/CLAUDE.md  # Personal overrides (not checked in)
```

Claude auto-loads every CLAUDE.md from the root down to the directory of the file being edited. This is **progressive disclosure** - Claude gets general rules always, specific rules only when working in that area.

### What Goes Where

**Root CLAUDE.md** - The entry point. Contains only what Claude needs on every single task regardless of which file it touches. Target: under 80 lines of directives.

Rules for root:

| Include | Why | Example |
|---------|-----|---------|
| Stack summary (one line) | Claude must know runtime, language, and framework before writing any code | `Node v22, ESM, TypeScript 5.4, Vitest` |
| Architecture map | Eliminates directory exploration - Claude knows where to look | `src/api/ - HTTP handlers`, `src/db/ - queries and migrations` |
| Cross-cutting constraints | Rules that apply everywhere belong here, not repeated in subdirectories | `Run tests after any code change: npm test` |
| Gotchas that cause silent failures | High-value negative rules that prevent hard-to-debug mistakes | `vec0 tables do NOT support INSERT OR IGNORE` |
| Pointers to detail files | Root should index, not explain | `See SCHEMA.md before writing SQL`, `See DECISIONS.md#db-driver` |

Rules for root - what to exclude:

| Exclude | Why | Where It Belongs |
|---------|-----|-----------------|
| Domain-specific rules | Only relevant when working in that domain | Subdirectory CLAUDE.md |
| Rationale and history | Burns tokens on every task, even when irrelevant | DECISIONS.md |
| Schema details | Changes frequently, better as single-source file | SCHEMA.md |
| Long explanations | Directive style is 40% cheaper | Rewrite as "Use X" not "We use X because..." |

**Subdirectory CLAUDE.md** - Domain-scoped rules only. Loaded automatically when Claude works in that directory. Never repeat root rules.

Rules for subdirectories:

| Rule | Rationale |
|------|-----------|
| One CLAUDE.md per domain boundary, not per directory | `src/db/CLAUDE.md` yes, `src/db/migrations/CLAUDE.md` no - too granular |
| Only rules a newcomer to this module would violate | If it's obvious from the code, skip it. If it's a trap, document it. |
| Include naming conventions specific to this layer | API response shape, migration file naming, test patterns |
| Include integration constraints | "This module assumes X is initialized first", "Never call Y directly - use Z wrapper" |
| Do NOT duplicate root rules | If it's in root, it's already loaded. Repetition wastes tokens. |

Example - what belongs at each level:

```
ROOT:   "Schema changes MUST update SCHEMA.md and increment schema_version"
        (cross-cutting - applies to any file that touches the schema)

SUBDIR: "Migration scripts use .cjs extension (package.json has type: module)"
        (domain-specific - only relevant when writing migrations)

ROOT:   "Run tests after any code change: npm test"
        (cross-cutting - applies everywhere)

SUBDIR: "All handlers return { success: boolean, data?: T, error?: string }"
        (domain-specific - only relevant in the API layer)

ROOT:   "See SCHEMA.md before writing any SQL"
        (pointer to detail - applies to multiple domains)

SUBDIR: "project is always a hash (DB key); projectName is human-readable (search)"
        (domain trap - only relevant when working in DB layer)
```

**Personal overrides** (`~/.claude/projects/<hash>/CLAUDE.md`) - Not checked in. Per-developer preferences and local environment specifics.

| Include | Example |
|---------|---------|
| Local environment quirks | `DB path: ~/data/dev.sqlite` |
| Personal workflow preferences | `Always show git diff before committing` |
| Temporary debugging rules | `Log all SQL queries until issue #42 is fixed` |
| Rules you want but the team hasn't agreed on | `Prefer early returns over nested conditionals` |

**`.claude/rules/`** - Path-scoped rule files with YAML frontmatter. Loaded automatically when Claude touches files matching the `paths:` globs. Not checked into subdirectories - all live in `.claude/rules/`.

When to use `.claude/rules/` vs subdirectory CLAUDE.md:

| Use `.claude/rules/` When | Use Subdirectory CLAUDE.md When |
|---|---|
| Rules apply to a file pattern across directories (e.g., `**/*.test.*`) | Rules apply to everything in one directory subtree |
| You want centralized rule management | You want rules colocated with the code they govern |
| Path patterns are complex or cross-cutting | Path scoping is simply "this directory and below" |
| Team prefers a single `.claude/rules/` directory | Team prefers rules next to the code |

Rules for `.claude/rules/`:

| Rule | Rationale |
|------|-----------|
| One file per domain boundary, not per file | `database.md` yes, `users-table.md` no - too granular |
| YAML frontmatter must include `paths:` array | Without paths, the file loads on every task (defeats the purpose) |
| Max 40 lines per file | Longer = split by sub-domain |
| Focus on traps and anti-patterns | Obvious conventions are discoverable from code |
| Do NOT duplicate root CLAUDE.md rules | Root rules already load on every task |

### What Does NOT Belong in CLAUDE.md

| Do NOT Include | Why | Where It Belongs |
|---|---|---|
| Implementation details (port numbers, column names, env values) | Change frequently, become stale silently | SCHEMA.md or code |
| Generic programming knowledge | Claude already knows this, wastes tokens | Nowhere - delete it |
| Temporary debugging notes | Expire quickly, clutter permanent rules | Memory atoms (auto-expire) |
| Process documentation (how to deploy, how to release) | Not relevant to code tasks | README or wiki |
| Rules Claude would follow anyway | "Write clean code" changes nothing | Nowhere - delete it |

### Writing Style Rules

**Use directive style.** "Use X" not "We use X because..." - rationale belongs in DECISIONS.md.

```
BAD:  We decided to use better-sqlite3 because it's synchronous and faster
      than node-sqlite3 for our use case of single-writer workloads.

GOOD: Use better-sqlite3 (synchronous, single-writer). See DECISIONS.md#db-driver.
```

Directive style saves ~40% tokens compared to explanatory prose.

**Negative rules are higher-value per token than positive rules.** "Do NOT use INSERT OR IGNORE with vec0" prevents a specific, hard-to-debug mistake. "Use standard INSERT" is generic and forgettable.

**Use tables over prose** for structured information:

```
BAD:  The project uses Node v22 with ESM modules. We use TypeScript 5.4
      for type checking. The database is SQLite via better-sqlite3 with
      the sqlite-vec extension for vector operations.

GOOD: | Component | Version/Detail |
      |-----------|---------------|
      | Runtime   | Node v22, ESM |
      | Types     | TypeScript 5.4 |
      | Database  | better-sqlite3 + sqlite-vec |
```

**Token budget target**: All CLAUDE.md files combined should be under 2000 tokens. Measure with `claude --print-system-prompt | wc -w` (rough: words * 1.3 = tokens).

### Writing Rules Claude Actually Follows

**Rules that get followed:**

| Pattern | Example |
|---------|---------|
| Specific and falsifiable | "Column is `trigger_type` not `trigger`" |
| Negative/preventive | "Do NOT use INSERT OR IGNORE with vec0" |
| Includes consequence | "FTS rebuild MUST happen OUTSIDE transaction - inside causes content mismatch" |
| One line, two max | Short rules fit in working memory; long rules get skimmed |

**Rules that get ignored:**

| Pattern | Why It Fails |
|---------|-------------|
| Multi-step procedures | Claude loses track after step 2 - put procedures in scripts or .context.md |
| Conditional/branching rules | "If X then Y, unless Z then W" - too complex for a directive |
| Rules that restate defaults | "Write clean code", "Handle errors" - Claude already does this |
| Rules longer than 2 lines | Gets skimmed; split into multiple atomic rules instead |

---

## 3. Schema Documentation

One authoritative schema file, always current. No exceptions.

```markdown
# SCHEMA.md
schema_version: 14

## Tables
### knowledge
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| content | TEXT | min 15 chars |
| status | TEXT | CHECK: 'active','superseded','archived' |
| confidence | REAL | 0.0-1.0, injection threshold: 0.70 |
| atom_type | TEXT | preference/decision/correction/insight |
```

**Enforcement**: Put `Schema changes MUST update SCHEMA.md and increment schema_version` in root CLAUDE.md. Claude follows explicit rules.

Column name mismatches are the #1 database bug in AI-assisted development. SCHEMA.md eliminates them.

---

## 4. Decision Log

Records **why** and **what else was considered** - not what.

```markdown
# DECISIONS.md

## 2026-03-01: Merged search_memory into recall_context
**Context**: 4 separate MCP tools, too many for LLM tool selection
**Decision**: Merge into 3 tools, add include_threads param
**Rejected**: Keep separate tools with aliases - more tools = more confusion
**Consequence**: Breaking change for existing configs
```

Prevents the #1 time waster: Claude re-proposing solutions you already tried and rejected. When Claude reads the decision log, it understands constraints it cannot infer from code alone.

---

## 5. Living Documentation

PRDs, feature specs, API docs, and user guides are **descriptive docs** - they describe what the system does, not rules for how to work on it. AMS keeps them in sync through three layers: a **root pointer**, a **doc index**, and **domain-scoped update triggers**.

### The Three Layers

```
Root CLAUDE.md (always loaded, 1 line):
  "Living docs in docs/. See docs/README.md for full index."

docs/README.md (read on demand, unlimited size):
  Full index of every doc - what it covers, its lifecycle status,
  when it was last verified. This is the table of contents.

.claude/rules/<domain>.md (loaded when touching that domain):
  "Related docs: update docs/features/search.md when changing search behavior"
  The update trigger lives next to the code rules it relates to.
```

**Why this scales**: Root CLAUDE.md cost is 1 line regardless of whether you have 5 or 500 docs. The mapping from code-area to doc lives in domain rules files that only load when Claude touches that area. The full index exists but only loads on demand.

### docs/README.md - The Doc Index

```markdown
# Documentation Index

## Features
| Doc | Covers | Status | Last Verified |
|-----|--------|--------|---------------|
| docs/features/search.md | Search pipeline, query syntax, ranking | Living | 2026-03-01 |
| docs/features/injection.md | Hook-based injection, confidence gating | Living | 2026-02-15 |

## API
| Doc | Covers | Status |
|-----|--------|--------|
| docs/api/tools.md | MCP tool surface, parameters, responses | Living |

## Specs (pre-implementation)
| Doc | Covers | Target |
|-----|--------|--------|
| docs/specs/batch-export.md | Bulk export API | Q2 2026 |

## Setup
- docs/setup.md - Installation, configuration, first run
- README.md - Project overview, quick start
```

This file is never auto-loaded. Claude reads it when asked about docs, when running `/audit-docs`, or when creating a new feature doc (to check what already exists).

### Domain Rules as Update Triggers

Each `.claude/rules/` file includes a "Related docs" section at the bottom:

```markdown
# .claude/rules/database.md
---
paths: ["src/db/**", "**/migrations/**"]
---

- Use .cjs extension for migration scripts
- Rebuild FTS OUTSIDE the transaction
- ...existing domain rules...

## Related docs
- Schema change: update docs/features/data-model.md
- New table or major restructure: update docs/features/data-model.md
```

When Claude edits database code, this rules file loads automatically. The related docs section tells Claude exactly which doc to update. No root CLAUDE.md bloat. No guessing.

**Root CLAUDE.md doc update rules** stay general:

```
- Behavior change in area with a related doc: update that doc (check domain rules file)
- New user-facing feature: create docs/features/<name>.md, add to docs/README.md index
- Removed feature: archive doc to docs/archive/, remove from index
- Completed spec: move from docs/specs/ to docs/features/, update to reflect what was actually built
```

### Doc Lifecycle

```
1. SPEC (planning)     docs/specs/feature-name.md    What we intend to build
2. LIVING (active)     docs/features/feature-name.md What the system actually does
3. ARCHIVED            docs/archive/feature-name.md  Superseded or removed
```

**Spec to living doc**: After implementing a feature, update the spec to reflect what was actually built (not what was planned), then move it from `docs/specs/` to `docs/features/`. Update `docs/README.md`. The domain rules triggers keep it current from that point.

**Archiving**: When a feature is removed or fully replaced, move its doc to `docs/archive/` and remove it from `docs/README.md`. Don't delete - it may contain decision context.

### What Belongs Where

| Doc Type | Location | Auto-loaded? | Update Trigger |
|---|---|---|---|
| Feature descriptions | `docs/features/` | No | Domain rules file "Related docs" |
| API/tool documentation | `docs/api/` | No | Domain rules file "Related docs" |
| Setup/installation | `docs/setup.md` or README | No | Root CLAUDE.md config change rule |
| Active specs/PRDs | `docs/specs/` | No - read at task start | Moved to `docs/features/` after implementation |
| Changelog | `CHANGELOG.md` | No | Root CLAUDE.md: any user-facing change |
| Doc index | `docs/README.md` | No | Updated when docs are added/removed/archived |
| Architecture overview | Root CLAUDE.md (map only) | Yes | New/removed/renamed directories |

### Verification

`/audit-docs` catches descriptive doc drift:

| Check | What It Catches |
|---|---|
| `docs/README.md` vs actual files | Index lists a doc that doesn't exist, or doc exists but isn't indexed |
| Domain rules "Related docs" vs actual doc files | Rules point to docs that don't exist |
| Doc content vs current code | Feature doc describes behavior the code no longer implements |
| Spec still in `docs/specs/` | Feature was implemented but spec was never promoted to living doc |
| Domain with docs but no "Related docs" in rules | Code area can change without updating its docs |

---

## 6. Memory Server Integration (Optional)

> This section requires the memory server MCP. Everything above works without it.

### What Happens Automatically

The memory server runs via 6 Claude Code hooks that fire at specific lifecycle points:

| Hook | Trigger | Timeout | What It Does |
|------|---------|---------|-------------|
| **PreCompact** | Before session compaction | 2000ms | Snapshots transcript, queues ingestion job |
| **Stop** | Session ends | 2000ms | Queues ingestion job, cleans rate-limit files |
| **SessionStart (compact)** | Resuming compacted session | 1000ms | Injects recovery buffer + top 3 relevant atoms |
| **SessionStart (cold)** | Cold start (24h+ gap) | 1000ms | Status check, warns if worker disabled |
| **PostToolUse** | After Read/Edit/Write | 500ms | Injects up to 2 atoms matching the file being touched |
| **UserPromptSubmit** | User submits prompt | 500ms | Injects up to 2 atoms matching detected signals in prompt |

After ingestion, a **hindsight extraction** job runs - loading the last 5 threads to find cross-session patterns. Hindsight atoms start at confidence 0.85 (vs 0.75 for single-session extractions).

### Injection Gating

Every injection must pass two gates:

1. **Confidence >= 0.70** - atoms below this threshold are never auto-injected
2. **Injection success rate >= 0.20** - atoms that consistently fail to help get suppressed (NULL = new atom, accepted)

Additional rate limits prevent injection spam:

| Scope | Limit |
|-------|-------|
| UserPromptSubmit per session | Max 3 injections |
| PostToolUse per session | Max 3 file-based injections |
| PostToolUse per file | Max 1 injection per unique file |

PostToolUse skips config files (package.json, tsconfig, vite.config, etc.) to avoid noise.

UserPromptSubmit requires signals to fire - it detects file paths, error strings (`TypeError`, `ENOENT`, `404`), PascalCase component names, and problem language (crash/broken/fail/bug). Prompts under 20 characters are skipped.

### Confidence Lifecycle

**Initial confidence by source:**

| Source | Initial Confidence |
|--------|-------------------|
| Regular extraction (ingest_thread) | 0.75 |
| User-explicit (save_knowledge) | 0.80 |
| Hindsight extraction | 0.85 |
| User correction | 0.95 |

**Confidence changes via feedback:**

| Signal | Delta | Trigger |
|--------|-------|---------|
| `applied` | +0.02 | Model used atom in response |
| `task_success` | +0.05 | Task completed without corrections |
| `confirmed` | +0.15 | User says "that's right" |
| `helpful` | +0.10 | User says "that helped" |
| `ignored` | -0.01 | Injected but not referenced |
| `task_failure` | -0.08 | User corrected after retrieval |
| `contradicted` | -0.10 | New learning contradicts atom |
| `stale` | -0.15 | Older than TTL without access |
| `rejected` | archived | User says "that's wrong" |
| `corrected` | superseded | User says "actually it's X now" - new atom at 0.95 |

**Bounds**: 0.0-1.0 range, auto-signal floor at 0.30, confirmed atoms floor at 0.70 for 30 days.

**Deduplication**: Cosine distance < 0.20 = duplicate. Existing atom gets +0.05 confidence instead of creating a new atom.

### What You Should Do

**Start of session** - run `/primeDB` to load relevant context from previous sessions.

**End of session** - run `/saveDB` to review and persist decisions, preferences, corrections, and insights.

**Periodically** - run `/reviewDB` to audit recent extractions and flag low-confidence atoms.

**When Claude gets something wrong** - state corrections as rules: "X is wrong. The correct approach is Y because Z." This creates a correction atom at 0.95 confidence.

**When Claude gets something right from memory** - say so. Positive feedback ("good memory", "that's right") boosts confidence by +0.15 and protects the atom from decay for 30 days.

### Accelerating the Feedback Loop

The memory server learns faster when you:

1. **State corrections as rules** - "Never use X, always use Y because Z" extracts cleanly as a correction atom
2. **Include alternatives in decisions** - "Chose X over Y because Z" gives Sonnet the full picture for extraction
3. **Describe gotchas as anti-patterns** - "X looks like it should work but fails because Y" maps directly to the anti_pattern atom type
4. **Be specific about scope** - "In this project" vs "always" affects whether an atom is project-scoped or global

### What Gets Extracted (and What Doesn't)

Every potential atom must pass three gates before extraction:

| Gate | Question | Pass | Fail |
|------|----------|------|------|
| **NOT GENERIC** | Is this specific to the user's projects? | "vec0 tables need existence check before INSERT" | "JavaScript has async/await" |
| **NOT IN CODE** | Would reading the codebase miss this? | "We chose SQLite over Postgres for single-user latency" | "The server runs on port 3000" (visible in config) |
| **CHANGES BEHAVIOR** | Would knowing this cause a different action next time? | "FTS rebuild MUST happen outside the transaction" | "The refactor went smoothly" (no actionable insight) |

All three gates must pass. A piece of knowledge that is specific and not in code but doesn't change behavior (e.g., "the migration took 2 hours") gets filtered out.

---

## 7. Token Optimization

### The Cost of Exploration

| Action | Token Cost | Notes |
|--------|-----------|-------|
| Single grep + read result | 500-2000 | Depends on file size |
| 5 exploratory reads | 5,000-10,000 | Common when searching for a function |
| Reading a 500-line file | 3,000-5,000 | Most of it irrelevant |
| Reading a 50-line file | 300-500 | Almost all relevant |

Every token spent exploring is a token not spent reasoning. The goal: Claude starts with 90%+ of needed context without searching.

### Structural Strategies

**Semantic file sizing** - keep files under 200 lines. A 50-line file is fully readable in one shot. A 500-line file gets partially read, and the critical detail is in the part that was skipped.

**Context anchors** - use predictable, descriptive naming so Claude can locate files without searching:

```
BAD:  utils.ts, helpers.ts, common.ts
GOOD: string-validators.ts, date-formatters.ts, sql-builders.ts
```

**Type-driven discovery** - TypeScript interfaces at module boundaries let Claude understand inputs/outputs without reading implementation:

```typescript
// src/types/injection.ts
interface InjectionResult {
  atom_id: number
  content: string
  confidence: number
  trigger_type: 'post_tool_use' | 'user_prompt_submit' | 'session_start_compact'
}
```

Claude reads the type file (20 lines) instead of the implementation file (200 lines) and knows everything needed to call the function.

**Index files** - `src/db/index.ts` re-exports the public API. Claude reads one file instead of scanning the directory.

**Colocated tests** - `foo.ts` + `foo.test.ts` in the same directory. Claude reads both naturally. Tests in a separate tree get forgotten and Claude has to search for them.

**Constants files** - one file for magic values, referenced everywhere. Claude reads it once instead of grepping for string literals scattered across the codebase.

### CLAUDE.md Token Optimization

| Technique | Token Savings | Example |
|-----------|--------------|---------|
| Directive style | ~40% | "Use X" vs "We use X because..." |
| Tables over prose | ~30% | Stack table vs stack paragraph |
| Negative rules | Higher value/token | "Do NOT X" prevents specific bugs |
| Abbreviate obvious context | ~20% | "Node v22, ESM" vs "We use Node.js version 22 with ECMAScript modules" |
| Link to detail files | Variable | "See DECISIONS.md#db-driver" vs inline explanation |

---

## 8. Anti-Exploration Strategies

### Decision Tombstones

Embed decisions directly in code where they matter. Zero extra context cost - Claude reads them naturally when reading the file:

```typescript
// DECISION: Using raw SQL not query builder - sqlite-vec requires raw
// virtual table syntax that no query builder supports correctly.
const result = db.prepare(`
  SELECT * FROM knowledge_embeddings WHERE ...
`).all()
```

These get extracted as atoms automatically during ingestion.

### Pre-computed Context Files

Place `.context.md` next to complex modules:

```markdown
# src/workers/.context.md

## Dependencies
- src/db/jobs.ts - job queue operations
- src/extraction/extract.ts - Sonnet extraction
- src/embedding/embed.ts - embedding generation

## Invariants
- Only one worker instance runs at a time (file lock)
- Jobs are processed in priority order (lower number = higher priority)
- Failed jobs retry up to 3 times with exponential backoff

## Failure Modes
- Sonnet extraction timeout: job retried, transcript preserved
- Embedding API failure: individual turns skipped, batch continues
- DB lock contention: worker backs off 1s, retries
```

Claude reads this before diving into implementation. Eliminates 3-5 exploratory reads.

### Architecture Maps

Put a directory-to-responsibility map in root CLAUDE.md:

```
src/core/     - Business logic, pure functions, no I/O
src/api/      - HTTP handlers, input validation, response formatting
src/db/       - Database queries, migrations, schema management
src/workers/  - Background job processing, single-instance
src/hooks/    - Claude Code hook scripts, injection logic
src/types/    - Shared TypeScript interfaces
```

This tells Claude exactly where to look. No `find` or `grep` needed.

### Error Dictionaries

One file mapping error patterns to causes and fixes:

```markdown
# ERRORS.md

## "SQLITE_CONSTRAINT: UNIQUE constraint failed: knowledge.id"
**Cause**: Attempting INSERT OR IGNORE on vec0 virtual table
**Fix**: Check existence with SELECT before INSERT

## "Cannot find module './foo' - ERR_MODULE_NOT_FOUND"
**Cause**: Missing .js extension in ESM import
**Fix**: Add explicit .js extension: import { bar } from './foo.js'

## "FTS content mismatch after migration"
**Cause**: FTS rebuild ran inside table-rebuild transaction
**Fix**: Run FTS rebuild OUTSIDE the transaction block
```

When Claude encounters an error, it checks ERRORS.md first instead of exploring the codebase.

### Canonical Import Paths

Document import conventions so Claude never searches for module locations:

```markdown
# In CLAUDE.md or src/CLAUDE.md

## Import Conventions
- Database: import { db } from '../db/index.js'
- Types: import type { Atom, Thread } from '../types/index.js'
- Config: import { config } from '../core/config.js'
- Never import from internal module files directly - use index re-exports
```

### How These Feed the Memory Server

Decision tombstones, error patterns, and gotchas in code naturally get extracted as atoms during session ingestion. The memory server sees Claude reading these comments and captures them as correction or insight atoms. This means well-annotated code improves memory quality without any manual effort.

---

## 9. Advanced Strategies

### Self-Healing Knowledge Loop

The memory server creates a feedback loop:

```
Mistake in session
  -> Ingestion extracts correction atom (confidence 0.75)
    -> Hindsight compares across sessions (confidence 0.85)
      -> Atom injected if confidence >= 0.70 AND success_rate >= 0.20
        -> If injected but ignored: success_rate drops, injection suppressed
        -> If mistake recurs: repeat_event flagged
          -> Atom reworded or escalated to CLAUDE.md rule
```

**Accelerate it**: Don't wait for automatic extraction. When you fix a bug, explicitly state the root cause and prevention rule. This gives Sonnet clean extraction material instead of making it infer from debugging noise.

### Predictive Loading Pattern

Project structure determines what loads at each hook point:

1. **Session start** - CLAUDE.md hierarchy loads (root + path to current file). Recovery buffer loads if resuming.
2. **User prompt** - Signal detection triggers injection of relevant atoms (error messages, file names, component names).
3. **Tool use** - Reading/editing a file triggers injection of atoms tagged to that file.
4. **Compaction** - Transcript is snapshotted, recovery buffer prepared for next session.

The more predictably your project is structured, the more accurately each hook injects. Consistent naming, colocated files, and clear architecture maps all improve injection precision.

### Semantic Boundaries via Types

TypeScript interfaces at domain boundaries eliminate implementation tracing:

```typescript
// Instead of Claude reading 200 lines of extraction logic:
interface ExtractionInput {
  transcript: Turn[]
  existingAtoms: Atom[]      // top 10 similar - prevents re-extraction
  maxAtoms: number           // default 3
}

interface ExtractionOutput {
  atoms: Array<{
    content: string          // min 15 chars
    atom_type: 'preference' | 'decision' | 'correction' | 'insight'
    confidence: number       // initial: 0.75
    rationale: string
  }>
}
```

Claude reads the types (15 lines) and knows exactly what the extraction pipeline expects and returns. The 200-line implementation only needs reading if there's a bug in it.

### Context Compounding

When all layers work together:

```
Folder CLAUDE.md (src/db/)     -> "Use .cjs for migrations, rebuild FTS outside tx"
+ Memory atom                   -> "Last time vec0 INSERT OR IGNORE failed silently"
+ Type definitions              -> "Migration function takes BackupConfig, returns MigrationResult"
+ Colocated test                -> "foo.test.ts shows exact usage patterns"
= Claude starts with 90%+ of needed context, zero searches
```

Each layer covers a different gap. CLAUDE.md covers rules, memory covers learned experience, types cover interfaces, tests cover usage patterns. Together they eliminate exploration almost entirely.

---

## 10. The Layers - What Each One Covers

| Layer | What It Covers | Failure Mode Prevented |
|-------|---------------|----------------------|
| CLAUDE.md hierarchy | Rules and constraints | Known mistakes |
| .claude/rules/ | Path-scoped domain rules | Out-of-context domain mistakes |
| SCHEMA.md | Current data structures | Structural misunderstandings |
| Living docs (docs/) | Feature behavior, API surface | Stale user/developer documentation |
| DECISIONS.md | Historical reasoning | Re-litigating past choices |
| Memory Server | Learned experience | Cross-session amnesia |
| Types | Interfaces and contracts | Implementation tracing |
| Tests | Expected behavior | Regressions |
| Decision tombstones | Inline rationale | Per-location exploration |
| Error dictionaries | Known failure patterns | Repeated debugging |

### Signs the System Is Degrading

| Signal | What It Means | Fix |
|---|---|---|
| Root CLAUDE.md exceeds 80 lines | Bloat - domain rules leaked in | Move domain rules to .claude/rules/ |
| Claude corrected on something CLAUDE.md should prevent | Rule is missing or too vague | Add specific negative rule |
| Claude proposes already-rejected approach | DECISIONS.md missing the entry | Add decision with rejected alternatives |
| Same bug appears twice | No rule preventing it | Add anti-pattern to nearest rule file or CLAUDE.md |
| Claude reads 5+ files before starting work | Architecture map incomplete or names unpredictable | Update map, rename files descriptively |
| Rule references file/pattern that no longer exists | Rule is stale | Delete or update the rule |

---

## 11. Getting Started

### Tier 1: Minimum Viable (30 minutes)

1. Create root `CLAUDE.md` with stack, architecture map, and top 10 gotchas
2. Create `SCHEMA.md` if you have a database
3. Add the rule: "Schema changes MUST update SCHEMA.md and increment schema_version"
4. Add the rule: "When a bug is fixed, add the anti-pattern to CLAUDE.md"

This alone prevents 60-70% of repeated mistakes. Or run `/implement-ams` to automate all of the above (see Section 12).

### Tier 2: With Memory Server (1 hour)

5. Install and configure the memory server MCP
6. Add `/primeDB`, `/saveDB`, `/reviewDB` commands to global CLAUDE.md
7. Configure the 6 hooks in `~/.claude/settings.json`
8. Run one session, then `/saveDB` to seed initial atoms
9. Run `/primeDB` in the next session to verify injection works

The automated extraction loop starts working immediately. Corrections and decisions from every session feed into future sessions.

### Tier 3: Full System (ongoing)

10. Add folder-level CLAUDE.md files as your project grows
11. Create `.context.md` for complex modules
12. Create `ERRORS.md` as you encounter recurring errors
13. Add decision tombstones in code when making non-obvious choices
14. Run `/reviewDB` weekly to audit atom quality and prune stale knowledge
15. Move high-confidence, frequently-injected atoms into CLAUDE.md as permanent rules

The system compounds over time. Each session makes future sessions more efficient. The goal is not perfect documentation - it's a self-improving loop where Claude gets better at your project with every interaction.

---

## 12. Operationalizing AMS

### Bootstrap (Self-Contained)

This file is the only thing you need. Copy it to a project root and tell Claude Code to read and implement it. Claude will:

1. **Create the `/implement-ams` skill** from the embedded definition below
2. **Execute the skill** to generate all documentation
3. **Rename this file** to `AMS.reference.md`

After setup, run `/implement-ams` again anytime to re-audit (the skill persists in `.claude/skills/`).

### Embedded Skill Definition

When Claude reads this file and is asked to implement it, it MUST first create `.claude/skills/implement-ams/SKILL.md` with the content below, then execute it.

````markdown
---
name: implement-ams
description: Implement AMS doc structure for current project. Run this after copying AMS.md into a project root to auto-generate the full documentation architecture.
argument-hint: [optional: path to AMS.md if not in project root]
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
---

# Implement AMS

You are setting up the Autonomous Memory System documentation architecture for this project. Read AMS.md (in project root, or at the path provided via $ARGUMENTS if given) as the reference specification, then execute all phases below.

## Phase 0: Preview

Before writing ANY files, present the user with a summary of what will be created:

1. List every file that will be created or modified
2. For existing files (CLAUDE.md, docs/): state whether you will CREATE, MERGE, or SKIP
3. Flag any uncertain decisions (guessed domain boundaries, ambiguous gotchas)
4. Wait for user confirmation before proceeding

This prevents surprises. The user must approve the plan.

## Phase 1: Audit

Explore the project thoroughly before generating anything:

- Read package.json / pyproject.toml / Cargo.toml / go.mod / Makefile / whatever exists for stack info
- Map the directory structure (top 2 levels)
- Identify domain boundaries (database, API, workers, tests, etc.)
- Check for existing CLAUDE.md files, SCHEMA.md, DECISIONS.md
- If a database exists: read migration files or schema definitions
- Look for decision tombstones in code (comments starting with DECISION:, NOTE:, HACK:, FIXME:, TODO:)
- Identify non-obvious patterns and gotchas from code (unusual conventions, workarounds, traps)
- Scan for existing documentation: docs/, README.md, *.md in project root, wiki/, guides/
- Categorize found docs: specs/PRDs, feature docs, API docs, setup/install guides, changelogs
- Check if memory server MCP is available (try calling recall_context)
- If available: include memory-related instructions in generated docs (/primeDB, /saveDB references)
- If NOT available: skip all memory-related content, note in report that memory server can be added later

### Scale Detection

Assess project size to calibrate output:

| Project Size | Indicators | Calibration |
|---|---|---|
| Tiny (<10 files, 1 directory) | No subdirectories, single concern | Root CLAUDE.md only. No .claude/rules/. No SCHEMA.md unless there's a DB. |
| Small (10-50 files, 2-3 domains) | A few directories with distinct concerns | Root CLAUDE.md + 1-2 rules files. Only create what's justified. |
| Medium (50-200 files, 4+ domains) | Clear domain boundaries, multiple conventions | Full setup: root + rules + schema + decisions |
| Large / Monorepo (200+ files or multiple packages) | packages/, apps/, or independent modules | Per-package CLAUDE.md. Shared rules at root. Package-specific rules in package .claude/rules/. |

Do NOT over-generate for tiny projects. A 3-file script does not need .claude/rules/, SCHEMA.md, DECISIONS.md, and docs/. Root CLAUDE.md alone may be sufficient.

## Phase 2: Generate Root CLAUDE.md

**If CLAUDE.md already exists**: Read it. Identify which AMS sections are missing (stack summary, architecture map, cross-cutting rules, doc update rules, pointers). Propose additions only for missing sections. Show the user the proposed merged result before writing. NEVER delete existing content without asking.

**If CLAUDE.md does not exist**: Create it from scratch.

Target: under 80 lines of directives. Must include:

1. **Stack summary** - one line, inferred from config files
2. **Architecture map** - directory-to-responsibility table, inferred from actual structure
3. **Cross-cutting rules** - gotchas that apply across the entire project (inferred from code patterns, package.json config like `"type": "module"`, tsconfig settings, etc.)
4. **Doc update rules**:

```
## Doc Update Rules
- Schema change (CREATE/ALTER/migration): update SCHEMA.md, increment schema_version
- New/removed endpoint or public API: update architecture map in this file
- New directory with its own domain: create .claude/rules/<domain>.md
- Non-obvious technical choice: add to DECISIONS.md with rejected alternatives
- Bug caused by wrong assumption: add anti-pattern to nearest rule file
- Removed feature or renamed file: grep all .md files in .claude/ for stale references
- Config change (new env var, new dependency): update stack section
- Behavior change in area with a related doc: update that doc (check domain rules file)
- New user-facing feature: create docs/features/<name>.md, add to docs/README.md index
- Removed feature: archive doc to docs/archive/, remove from docs/README.md index
- Completed spec: move from docs/specs/ to docs/features/, update to reflect what was actually built
```

5. **Pointers** to SCHEMA.md, DECISIONS.md (if created)
6. **Living docs pointer** (1 line): `Living docs in docs/. See docs/README.md for full index.` (only if docs/ was created in Phase 6)

Style: directive ("Use X", "Do NOT Y"). No rationale in CLAUDE.md - rationale goes in DECISIONS.md.

If memory server is NOT available, omit:
- /primeDB, /saveDB, /reviewDB references
- Memory atom references in doc update rules
- Any rules that reference injection or extraction

### Quality Gates (Root CLAUDE.md)

Before finalizing, verify:
- [ ] Under 80 lines
- [ ] Every rule is directive style (no "We use X because...")
- [ ] Every rule is specific and falsifiable (no "Write clean code")
- [ ] No implementation details (port numbers, column names, env values) - those go in SCHEMA.md or code
- [ ] No generic programming knowledge Claude already knows
- [ ] Architecture map matches actual directory structure
- [ ] No domain-specific rules (those go in .claude/rules/)

## Phase 3: Generate .claude/rules/

Create path-scoped rule files for each domain boundary identified in Phase 1. Each file:

- Uses YAML frontmatter with `paths:` array to scope when it loads
- Contains only rules specific to that domain (never repeat root rules)
- Targets 20-40 lines max
- Focuses on traps and anti-patterns over obvious conventions
- Ends with a `## Related docs` section listing which docs to update when this domain changes

Example structure (adapt to actual project):

```
.claude/rules/
  database.md     # paths: ["src/db/**", "**/migrations/**"]
  api.md          # paths: ["src/api/**", "src/routes/**"]
  testing.md      # paths: ["**/*.test.*", "**/*.spec.*"]
  workers.md      # paths: ["src/workers/**", "src/jobs/**"]
```

If a domain has no non-obvious rules, do NOT create a rule file for it. Empty rules waste tokens.

### Quality Gates (.claude/rules/)

- [ ] Every file has YAML frontmatter with `paths:` array
- [ ] No rule duplicates a root CLAUDE.md rule
- [ ] Every rule is specific to this domain (would not apply elsewhere)
- [ ] Each file has a `## Related docs` section (even if just `(none yet)`)
- [ ] Path globs actually match files that exist in the project

## Phase 4: Generate SCHEMA.md (if database exists)

Read migration files or schema definitions and produce SCHEMA.md with:

- `schema_version: 1` (or inferred from existing migrations)
- Every table with columns, types, constraints, and non-obvious notes
- Use table format (not prose)
- Include the rule in root CLAUDE.md: "Read SCHEMA.md before writing any SQL"

Skip this phase if no database exists in the project.

## Phase 5: Generate DECISIONS.md

Create DECISIONS.md with:

- Any decisions found as code tombstones (DECISION: comments)
- Any non-obvious architectural choices visible from code (unusual library choices, custom patterns over standard ones, workarounds)
- Use this format per entry:

```
## YYYY-MM-DD: [Short description]
**Context**: Why this decision was needed
**Decision**: What was chosen
**Rejected**: What alternatives were considered
**Consequence**: Any tradeoffs or breaking changes
```

If no decisions are discoverable, create the file with just the format template and a note to populate it over time.

## Phase 6: Index and Organize Living Docs

Using the docs inventory from Phase 1:

1. **Create `docs/` structure** if it doesn't exist:
   - `docs/features/` - living feature documentation
   - `docs/specs/` - active PRDs and specs (pre-implementation)
   - `docs/api/` - API/tool surface documentation (if applicable)
   - `docs/archive/` - superseded or removed feature docs

2. **Classify existing docs**:
   - Specs/PRDs that describe unimplemented features -> `docs/specs/`
   - Specs for already-implemented features -> update to reflect actual behavior, move to `docs/features/`
   - API documentation -> `docs/api/`
   - Stale docs describing removed features -> `docs/archive/`
   - Do NOT move README.md or CHANGELOG.md - they stay at project root
   - Do NOT reorganize existing docs without asking - show proposed moves first

3. **Generate `docs/README.md`** as the full doc index (see AMS.md Section 5 for format)

4. **Add root CLAUDE.md pointer** (1 line only):
   `Living docs in docs/. See docs/README.md for full index.`

5. **Add "Related docs" sections** to each `.claude/rules/` file generated in Phase 3

6. **Verify each living doc** reflects current code, not planned behavior. Flag any that need human review.

Skip this phase if the project has no existing documentation beyond what AMS generates AND is a small project (< 50 files).

## Phase 7: Generate /audit-docs Skill

Create `.claude/skills/audit-docs/SKILL.md`:

```yaml
---
name: audit-docs
description: Audit project docs for staleness, contradictions, and gaps against actual code
allowed-tools:
  - Read
  - Glob
  - Grep
  - Agent
---
```

With instructions to check:
1. SCHEMA.md vs actual schema (migrations or DB)
2. Root CLAUDE.md architecture map vs actual directory structure
3. .claude/rules/ path patterns vs actual file paths
4. DECISIONS.md entries vs current implementation
5. Cross-file contradictions (root says X, rule file says NOT X)
6. Dead references (links to files/functions that no longer exist)
7. Rules about patterns no longer in the codebase
8. docs/README.md index vs actual doc files (missing docs, unindexed docs)
9. Domain rules "Related docs" sections vs actual doc files (pointing to nonexistent docs)
10. Living docs vs current code behavior (feature docs describing outdated behavior)
11. Specs in docs/specs/ for already-implemented features (should be promoted to docs/features/)
12. Domains with docs but no "Related docs" in their rules file (changes won't trigger doc updates)

Output format: grouped by severity [STALE] [CONTRADICTION] [DEAD REF] [GAP], with file, line, problem, suggested fix.

## Phase 8: Verify and Report

1. **Verify generated docs**:
   - Read root CLAUDE.md - confirm it passes all quality gates
   - Read each .claude/rules/ file - confirm paths: globs match real files
   - If SCHEMA.md was created - spot-check one table against actual code/migrations
   - Confirm no file exceeds its size limit (root: 80 lines, rules: 40 each, schema: 150)

2. **Rename AMS.md**: If AMS.md is in the project root, rename to `AMS.reference.md`

3. **Print summary**:
   - Files created (with line counts)
   - Files that already existed and were skipped or merged (list them so user can review)
   - Uncertain decisions (anything you guessed at - flag for human review)
   - Phases that were skipped and why
   - Recommended next steps

## Conflict Resolution (reference for all generated docs)

When sources disagree, resolve in this priority order:
1. Current code (ground truth)
2. SCHEMA.md (must match code)
3. Root CLAUDE.md (explicit, reviewed)
4. .claude/rules/ (domain-scoped)
5. Living docs in docs/ (descriptive, may lag behind code)
6. Memory atoms (learned, may be outdated)
7. DECISIONS.md (historical)

Include this priority order as a comment in root CLAUDE.md.

## Context Budget Targets

| Doc | Max Lines | Split Strategy |
|-----|-----------|---------------|
| Root CLAUDE.md | 80 | Move domain rules to .claude/rules/ |
| .claude/rules/* | 40 each | Split by sub-domain |
| SCHEMA.md | 150 | Split into schema/<domain>.md |
| DECISIONS.md | 100 | Archive old entries to DECISIONS-archive.md |
````

### What the Skill Produces

| Phase | Output | Skip Condition |
|-------|--------|----------------|
| **Preview** | Plan shown to user for approval | Never skipped |
| **Root CLAUDE.md** | <80 line directive file | Never skipped (merged if exists) |
| **`.claude/rules/`** | Path-scoped rule files per domain | Tiny projects (<10 files) |
| **SCHEMA.md** | Schema from migrations/definitions | No database |
| **DECISIONS.md** | Decision log from code tombstones | No decisions found (template created) |
| **Living docs index** | `docs/README.md` + organized docs/ | No existing docs and small project |
| **`/audit-docs` skill** | Consistency audit command | Never skipped |
| **Verify + Cleanup** | Quality check, AMS.md renamed | Never skipped |

After setup, doc update rules baked into CLAUDE.md handle incremental maintenance during normal work.

### Ongoing Maintenance: `/audit-docs`

`/audit-docs` is a skill generated by `/implement-ams`. Run it periodically (monthly, or after major refactors) to catch doc drift before it causes mistakes.

What it checks:

| Check | What It Catches |
|-------|----------------|
| SCHEMA.md vs actual migrations/DB | Columns that were added, renamed, or removed without updating SCHEMA.md |
| Architecture map vs directory structure | New directories missing from the map, deleted directories still listed |
| `.claude/rules/` path patterns vs real files | Path globs that match nothing (dead rules), domains with code but no rule file |
| DECISIONS.md vs current code | Decisions listed as current that the code no longer reflects |
| Cross-file contradictions | Root CLAUDE.md says "Use X", a rule file says "Never use X" |
| Dead references | Links to files, functions, sections, or error codes that no longer exist |
| Orphaned rules | Rules about patterns, conventions, or files no longer in the codebase |

Output is grouped by severity:

- **[CONTRADICTION]** - two docs disagree (highest priority - causes confident mistakes)
- **[STALE]** - doc references something outdated (causes wrong assumptions)
- **[DEAD REF]** - doc points to something that doesn't exist (causes failed lookups)
- **[GAP]** - code area with no doc coverage (causes unnecessary exploration)

Each finding includes: file, line, problem description, and suggested fix.

### Conflict Resolution Order

When `/audit-docs` finds contradictions, or when you encounter conflicting information during work, resolve using this priority (highest wins):

```
1. Current code        - ground truth, it's what actually runs
2. SCHEMA.md           - must match code; if not, SCHEMA.md is stale
3. Root CLAUDE.md      - explicit, reviewed, cross-cutting
4. .claude/rules/*     - domain-scoped, may lag behind root
5. Living docs (docs/) - descriptive, may lag behind code
6. Memory atoms        - learned, may be outdated
7. DECISIONS.md        - historical, may describe superseded choices
```

If code contradicts CLAUDE.md and you're unsure which is wrong - ask. Don't silently update either.

### Context Budget Architecture

Three tiers prevent context inflation while keeping Claude informed:

```
ALWAYS LOADED (root CLAUDE.md, <80 lines):
  Stack, architecture map, cross-cutting rules, doc update rules,
  pointers to detail files. Loaded on every session, every task.

LOADED ON DEMAND (.claude/rules/ with path scoping):
  Domain rules load ONLY when Claude touches matching files.
  Database rules load when editing src/db/. API rules load when
  editing src/api/. Testing rules load when editing *.test.ts.
  Zero cost when working in unrelated areas.

NEVER AUTO-LOADED (read manually or via pointer rules):
  SCHEMA.md     - referenced by database rule file, read on demand
  DECISIONS.md  - consulted before architectural changes
  ERRORS.md     - consulted when debugging known error patterns
  AMS.md        - bootstrap only, renamed after setup
```

Size limits before splitting:

| Doc | Max Lines | When to Split |
|-----|-----------|---------------|
| Root CLAUDE.md | 80 | Move domain rules to .claude/rules/ |
| .claude/rules/* | 40 each | Split by sub-domain |
| SCHEMA.md | 150 | Split into schema/<domain>.md files |
| DECISIONS.md | 100 | Archive entries older than 6 months to DECISIONS-archive.md |
