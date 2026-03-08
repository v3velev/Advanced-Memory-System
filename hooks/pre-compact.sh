#!/bin/bash
# PreCompact Hook: Snapshot transcript before compaction destroys it
# Writes recovery buffer + hard links transcript + queues ingest_thread job
# Timeout: 2000ms

SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"
SNAPSHOTS="$SERVER_DIR/snapshots"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

[ -z "$TRANSCRIPT" ] && exit 0
[ ! -f "$TRANSCRIPT" ] && exit 0

mkdir -p "$SNAPSHOTS"

# Extract project identifier (hash of full path for stability)
PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
PROJECT_NAME=$(basename "$CWD")
SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)

# Step 1: Write recovery buffer (last 10 turns, text only + recently modified files header)
# Uses db-write.cjs for parameterized SQL (handles all content edge cases)

# Extract recently modified files from transcript
MODIFIED_FILES=$(tail -200 "$TRANSCRIPT" | jq -r '
  select(.type == "assistant") |
  .message.content[]? | select(.type == "tool_use") |
  select(.name == "Edit" or .name == "Write") |
  .input.file_path // empty
' 2>/dev/null | sort -u | head -5 | while read f; do [ -n "$f" ] && basename "$f"; done | tr '\n' ', ' | sed 's/,$//')

# Extract last 10 turns of text conversation
RECENT=$(tail -100 "$TRANSCRIPT" | jq -r '
  select(.type == "user" or .type == "assistant") |
  if .type == "user" then
    "[user]: " + (if (.message.content | type) == "string" then .message.content
    else ([.message.content[] | select(.type == "text") | .text] | join(" ")) end)
  elif .type == "assistant" then
    "[assistant]: " + ([.message.content[] | select(.type == "text") | .text] | join(" "))
  else empty end
' | tail -20)

if [ -n "$RECENT" ]; then
  {
    [ -n "$MODIFIED_FILES" ] && echo "Recently modified files: $MODIFIED_FILES"
    echo ""
    echo "Recent conversation context:"
    echo "$RECENT"
  } | DB_PATH="$DB_PATH" node "$SERVER_DIR/db-write.cjs" recovery_buffer "$PROJECT_HASH" "$SESSION_ID"
fi

# Step 2: Hard link to snapshots (O(1), no file copy)
SNAP_NAME="$(date +%s)-$(basename "$TRANSCRIPT")"
ln "$TRANSCRIPT" "$SNAPSHOTS/$SNAP_NAME" 2>/dev/null || cp "$TRANSCRIPT" "$SNAPSHOTS/$SNAP_NAME"

# Step 3: Capture git context + queue ingestion job
GIT_HASH=""
GIT_DIR=""
if [ -d "$CWD/.git" ]; then
  GIT_HASH=$(git -C "$CWD" rev-parse HEAD 2>/dev/null || true)
  GIT_DIR="$CWD"
fi

SAFE_PATH="${SNAPSHOTS}/${SNAP_NAME}"
SAFE_PATH="${SAFE_PATH//\'/\'\'}"
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SAFE_PROJECT_NAME="${PROJECT_NAME//\'/\'\'}"
SAFE_GIT_HASH="${GIT_HASH//\'/\'\'}"
SAFE_GIT_DIR="${GIT_DIR//\'/\'\'}"

if ! sqlite3 "$DB_PATH" ".timeout 3000" "
  INSERT INTO jobs (type, payload, priority, created_at)
  VALUES ('ingest_thread', json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$SAFE_PROJECT_NAME','git_commit_hash','$SAFE_GIT_HASH','git_project_dir','$SAFE_GIT_DIR'), 10, datetime('now'));
" 2>>"$SERVER_DIR/logs/hooks.log"; then
  echo "$(date): CRITICAL - Failed to queue job for $SNAP_NAME, retrying" >> "$SERVER_DIR/logs/hooks.log"
  sleep 0.5
  sqlite3 "$DB_PATH" ".timeout 3000" "
    INSERT INTO jobs (type, payload, priority, created_at)
    VALUES ('ingest_thread', json_object('transcript_path','$SAFE_PATH','project','$SAFE_PROJECT','project_name','$SAFE_PROJECT_NAME','git_commit_hash','$SAFE_GIT_HASH','git_project_dir','$SAFE_GIT_DIR'), 10, datetime('now'));
  " 2>>"$SERVER_DIR/logs/hooks.log"
fi

exit 0
