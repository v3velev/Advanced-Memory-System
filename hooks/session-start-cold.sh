#!/bin/bash
# SessionStart (startup) Hook: Minimal status check on cold starts
# Timeout: 1000ms

exec 2>>"$HOME/.claude/memory-server/logs/hooks.log"

# Check if worker is disabled (repeated failures)
if [ -f "$HOME/.claude/memory-server/.worker-disabled" ]; then
  echo "WARNING: Memory worker is disabled (repeated failures). Check ~/.claude/memory-server/logs/worker.log for errors."
else
  echo "Memory system active. Use /primeDB to load project context, /saveDB to checkpoint, /reviewDB to audit."
fi
