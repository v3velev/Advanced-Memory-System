#!/bin/bash
# Stop Hook: Queue ingestion job when session ends
# Checks for existing snapshot to prevent duplicate ingestion
# Timeout: 2000ms

SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
PROJECT_NAME=$(basename "$CWD")
SESSION_BASENAME=$(basename "$TRANSCRIPT")

# Check if a snapshot already exists for this session file
EXISTING=$(sqlite3 "$DB_PATH" ".timeout 3000" "
  SELECT COUNT(*) FROM jobs
  WHERE type = 'ingest_thread'
  AND json_extract(payload, '$.transcript_path') LIKE '%$SESSION_BASENAME'
  AND status IN ('pending','processing','done');
" 2>/dev/null)

SAFE_PATH="${TRANSCRIPT//\'/\'\'}"
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SAFE_PROJECT_NAME="${PROJECT_NAME//\'/\'\'}"

# Capture git context
GIT_HASH=""
GIT_DIR=""
if [ -d "$CWD/.git" ]; then
  GIT_HASH=$(git -C "$CWD" rev-parse HEAD 2>/dev/null || true)
  GIT_DIR="$CWD"
fi
SAFE_GIT_HASH="${GIT_HASH//\'/\'\'}"
SAFE_GIT_DIR="${GIT_DIR//\'/\'\'}"

JOB_SQL_COMMON="json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$SAFE_PROJECT_NAME','git_commit_hash','$SAFE_GIT_HASH','git_project_dir','$SAFE_GIT_DIR'"

if [ "${EXISTING:-0}" -gt 0 ]; then
  # Session may have continued after compaction - queue full transcript
  # The worker's atom-level dedup (cosine > 0.92) handles overlap
  if ! sqlite3 "$DB_PATH" ".timeout 3000" "
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', ${JOB_SQL_COMMON},'is_full_session', 1), 5, datetime('now'));
  " 2>>"$SERVER_DIR/logs/hooks.log"; then
    echo "$(date): CRITICAL - Failed to queue stop job (full), retrying" >> "$SERVER_DIR/logs/hooks.log"
    sleep 0.5
    sqlite3 "$DB_PATH" ".timeout 3000" "
      INSERT INTO jobs (type, payload, priority, created_at)
      VALUES ('ingest_thread', ${JOB_SQL_COMMON},'is_full_session', 1), 5, datetime('now'));
    " 2>>"$SERVER_DIR/logs/hooks.log"
  fi
else
  # No snapshot - queue normally
  if ! sqlite3 "$DB_PATH" ".timeout 3000" "
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', ${JOB_SQL_COMMON}), 5, datetime('now'));
  " 2>>"$SERVER_DIR/logs/hooks.log"; then
    echo "$(date): CRITICAL - Failed to queue stop job, retrying" >> "$SERVER_DIR/logs/hooks.log"
    sleep 0.5
    sqlite3 "$DB_PATH" ".timeout 3000" "
      INSERT INTO jobs (type, payload, priority, created_at)
      VALUES ('ingest_thread', ${JOB_SQL_COMMON}), 5, datetime('now'));
    " 2>>"$SERVER_DIR/logs/hooks.log"
  fi
fi

# Clean seen files for this session
SEEN_DIR="$SERVER_DIR/seen"
SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)
rm -f "$SEEN_DIR/$SESSION_ID" "$SEEN_DIR/prompt-$SESSION_ID" 2>/dev/null

exit 0
