#!/bin/bash
# SessionStart (compact) Hook: Recovery injection with buffer + topic-aware atoms
# Timeout: 1000ms

SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')

PROJECT_HASH=$(echo -n "$CWD" | shasum -a 256 | cut -c1-16)
SAFE_PROJECT="${PROJECT_HASH//\'/\'\'}"
SESSION_ID=$(basename "$TRANSCRIPT" .jsonl)
SAFE_SESSION="${SESSION_ID//\'/\'\'}"

echo "=== Memory Recovery (post-compaction) ==="
echo ""

# Priority 1: Recovery buffer scoped to THIS session ONLY
# NO project-level fallback - prevents cross-session contamination
BUFFER=$(sqlite3 "$DB_PATH" ".timeout 3000" "
  SELECT content FROM recovery_buffer
  WHERE session_id = '$SAFE_SESSION'
  ORDER BY created_at DESC LIMIT 1;
" 2>/dev/null)

if [ -n "$BUFFER" ]; then
  echo "$BUFFER"
  echo ""
fi

# Priority 2: Cache-first topic-aware atom selection
ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
  SELECT k.id, k.type, k.content FROM injection_cache ic
  JOIN knowledge k ON k.id = ic.atom_id
  WHERE ic.project = '$SAFE_PROJECT' AND ic.context_type = 'project_general'
  AND k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  ORDER BY ic.score DESC LIMIT 3;
" 2>/dev/null)

# FTS fallback: extract keywords from recovery buffer
if [ -z "$ATOMS" ] && [ -n "$BUFFER" ]; then
  STOPWORDS='this|that|with|from|have|been|were|what|when|will|your|just|like|also|than|then|them|into|some|could|would|should|about|after|before|other|which|their|there|these|those|being|doing|going|using|where|while|does|each|make|made|need|only|over|same|such|take|want|very|more|most|much|many|here|back|know|well|even|work|look|time|file|code|line|sure|used|part|seem|find|test|next|type|call|name|tool|read|edit|near'
  KEYWORDS=$(echo "$BUFFER" | tr '[:upper:]' '[:lower:]' | grep -oE '\b[a-z]{5,}\b' | grep -viE "^($STOPWORDS)$" | sort | uniq -c | sort -rn | head -5 | awk '{print $2}')
  if [ -n "$KEYWORDS" ]; then
    FTS_QUERY=$(echo "$KEYWORDS" | tr '\n' ' ' | sed 's/ *$//' | sed 's/ / OR /g')
    ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
      SELECT k.id, k.type, k.content FROM knowledge k
      WHERE k.status = 'active' AND k.confidence >= 0.70
      AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
      AND (k.project = '$SAFE_PROJECT' OR k.scope = 'global')
      AND (
        k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '$FTS_QUERY')
        OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '$FTS_QUERY')
      )
      ORDER BY k.confidence DESC LIMIT 3;
    " 2>/dev/null)
  fi
fi

# Fallback: confidence-based if both cache and FTS found nothing
if [ -z "$ATOMS" ]; then
  ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
    SELECT id, type, content FROM knowledge
    WHERE status = 'active' AND confidence >= 0.70
    AND (injection_success_rate IS NULL OR injection_success_rate >= 0.20)
    AND (project = '$SAFE_PROJECT' OR scope = 'global')
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 3;
  " 2>/dev/null)
fi

if [ -n "$ATOMS" ]; then
  echo "Related knowledge:"
  while IFS='|' read -r id type content; do
    echo "[#$id] [$type] $content"
    # Record injection event
    sqlite3 "$DB_PATH" ".timeout 3000" "
      INSERT INTO injection_events (atom_id, session_file, trigger_type)
      VALUES ($id, '$SAFE_SESSION', 'session_start_compact');
    " 2>/dev/null
  done <<< "$ATOMS"
  echo ""
fi

echo "Use /primeDB to load more context, or call recall_context with a query relevant to your current task."
