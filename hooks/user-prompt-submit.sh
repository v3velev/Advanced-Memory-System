#!/bin/bash
# UserPromptSubmit Hook: Inhibitory gating - only inject on high-confidence signal matches
# Timeout: 500ms - MUST be fast
# Output to stdout becomes additionalContext prepended to user message

SERVER_DIR="$HOME/.claude/memory-server"
DB_PATH="$SERVER_DIR/data/memory.db"

# Log errors instead of silently discarding them
exec 2>>"$SERVER_DIR/logs/hooks.log"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty')

[ -z "$PROMPT" ] && exit 0

# Gate: skip very short messages (no useful signal)
if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

# Per-session rate limit: max 3 injections
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
SEEN_DIR="$SERVER_DIR/seen"
mkdir -p "$SEEN_DIR"
INJECT_FILE="$SEEN_DIR/prompt-${SESSION_ID:-unknown}"
if [ -f "$INJECT_FILE" ]; then
  COUNT=$(cat "$INJECT_FILE" | tr -d ' ')
  [ "$COUNT" -ge 3 ] && exit 0
fi

SEARCH_TERM=""
SIGNAL_TYPE=""

# Signal 1: Explicit file paths (src/components/Foo.tsx)
FILE_MATCH=$(echo "$PROMPT" | grep -oE 'src/[a-zA-Z0-9/_.-]+\.[a-z]+' | head -1)
if [ -n "$FILE_MATCH" ]; then
  SEARCH_TERM=$(basename "$FILE_MATCH" | sed 's/\.[^.]*$//')
  SIGNAL_TYPE="phrase"
fi

# Signal 2: Error-like strings
if [ -z "$SEARCH_TERM" ]; then
  ERROR_MATCH=$(echo "$PROMPT" | grep -oiE '(TypeError|ReferenceError|SyntaxError|Cannot read|undefined is not|ENOENT|EACCES|404|500|502|503)' | head -1)
  if [ -n "$ERROR_MATCH" ]; then
    SEARCH_TERM="$ERROR_MATCH"
    SIGNAL_TYPE="phrase"
  fi
fi

# Signal 3: Multi-segment PascalCase (3+ segments to avoid false positives)
if [ -z "$SEARCH_TERM" ]; then
  COMPONENT=$(echo "$PROMPT" | grep -oE '\b[A-Z][a-z]+([A-Z][a-z]+){2,}\b' | head -1)
  if [ -n "$COMPONENT" ]; then
    SEARCH_TERM="$COMPONENT"
    SIGNAL_TYPE="phrase"
  fi
fi

# Signal 4: Problem language - restricted to first 40 chars
# Only triggers when problem word is NEAR THE BEGINNING
if [ -z "$SEARCH_TERM" ]; then
  FIRST_PART="${PROMPT:0:40}"
  PROBLEM=$(echo "$FIRST_PART" | grep -oiE '\b(crash(ing|ed)?|break(ing)?|broken|slow|fail(ing|ed|s)?|wrong|stuck|bug(gy)?)\b' | head -1)
  if [ -n "$PROBLEM" ]; then
    RAW_TERM=$(echo "$PROMPT" | sed -E "s/$PROBLEM//i" | tr -s ' ' | sed 's/^ *//;s/ *$//' | head -c 80)
    # Sanitize FTS5 operators
    RAW_TERM=$(echo "$RAW_TERM" | sed 's/[()\"*^{}:]//g' | sed 's/\bAND\b//gi; s/\bOR\b//gi; s/\bNOT\b//gi; s/\bNEAR\b//gi')
    # Require 2+ non-stopword terms (words > 3 chars) to prevent garbage queries
    WORD_COUNT=$(echo "$RAW_TERM" | grep -oE '\b[a-zA-Z]{4,}\b' | wc -l | tr -d ' ')
    if [ "$WORD_COUNT" -ge 2 ]; then
      SEARCH_TERM="$RAW_TERM"
      SIGNAL_TYPE="terms"
    fi
  fi
fi

# No signal detected - stay silent
[ -z "$SEARCH_TERM" ] && exit 0

# Search knowledge atoms via FTS5
# Confidence >= 0.70 for auto-injection (higher bar than on-demand search)
SAFE_TERM="${SEARCH_TERM//\'/\'\'}"

# Phrase match for precise signals (1-3), OR-based for multi-word Signal 4
if [ "$SIGNAL_TYPE" = "terms" ]; then
  # Convert to OR query: extract significant words
  FTS_MATCH=$(echo "$SAFE_TERM" | grep -oE '\b[a-zA-Z]{4,}\b' | head -5 | tr '\n' ' ' | sed 's/ *$//' | sed 's/ / OR /g')
else
  FTS_MATCH="\"$SAFE_TERM\""
fi

[ -z "$FTS_MATCH" ] && exit 0

ATOMS=$(sqlite3 "$DB_PATH" ".timeout 3000" -separator '|' "
  SELECT k.id, k.type, k.content FROM knowledge k
  WHERE k.status = 'active' AND k.confidence >= 0.70
  AND (k.injection_success_rate IS NULL OR k.injection_success_rate >= 0.20)
  AND (
    k.id IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH '$FTS_MATCH')
    OR k.id IN (SELECT rowid FROM knowledge_fts_exact WHERE knowledge_fts_exact MATCH '$FTS_MATCH')
  )
  ORDER BY k.confidence DESC LIMIT 2;
" 2>/dev/null)

[ -z "$ATOMS" ] && exit 0

# Get session file for injection tracking
TRANSCRIPT=$(echo "$INPUT" | jq -r '.session_id // empty')
SAFE_TRANSCRIPT="${TRANSCRIPT//\'/\'\'}"

echo "<memory-context>"
while IFS='|' read -r id type content; do
  echo "[#$id] [$type] $content"
  # Record injection event
  sqlite3 "$DB_PATH" ".timeout 3000" "
    INSERT INTO injection_events (atom_id, session_file, trigger_type)
    VALUES ($id, '$SAFE_TRANSCRIPT', 'user_prompt_submit');
  " 2>/dev/null
done <<< "$ATOMS"
echo "</memory-context>"

# Increment injection counter
echo $(( ${COUNT:-0} + 1 )) > "$INJECT_FILE"
