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
