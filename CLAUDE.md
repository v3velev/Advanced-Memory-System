# Memory Server - Development Rules

## Schema
- Schema changes MUST update `SCHEMA.md` and increment `schema_version`
- SQLite CHECK constraint changes require table rebuild (see `migrate-check-constraints.cjs` pattern)
- After any migration: verify with `PRAGMA table_info`, test INSERTs for each status value, test FTS queries

## Migration Scripts
- Use `.cjs` extension (package.json has `"type": "module"`)
- Always back up DB before destructive migrations
- Follow pattern: backup -> count -> rebuild -> verify count -> drop old -> reindex
- FTS content-sync rebuild must happen OUTSIDE the table-rebuild transaction

## FTS
- Triggers must include ALL columns of the FTS virtual table (content AND tags)
- After virtual table schema changes: `INSERT INTO <fts>(<fts>) VALUES('rebuild')`

## Project vs ProjectName
- `project` is always a hash - used as DB key
- `projectName` is human-readable - used for semantic search/embeddings
- Never embed the project hash for semantic search (garbage similarity scores)
