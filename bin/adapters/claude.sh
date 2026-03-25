#!/bin/bash
# Claude adapter for squads
# Wraps the official Claude CLI

set -euo pipefail

MODEL="${1:-sonnet}"
PROMPT_FILE="${2:-}"
ADD_DIRS="${3:-}"

# Map short names to full model IDs
map_model() {
  case "$1" in
    opus)   echo "opus" ;;
    sonnet) echo "sonnet" ;;
    haiku)  echo "haiku" ;;
    *)      echo "$1" ;;
  esac
}

MAPPED_MODEL=$(map_model "$MODEL")

# Build command
CMD="claude --print --model $MAPPED_MODEL"

# Add directories if specified
if [[ -n "$ADD_DIRS" ]]; then
  IFS=',' read -ra DIRS <<< "$ADD_DIRS"
  for dir in "${DIRS[@]}"; do
    CMD="$CMD --add-dir $dir"
  done
fi

# Execute with prompt from file or stdin
if [[ -n "$PROMPT_FILE" && -f "$PROMPT_FILE" ]]; then
  $CMD < "$PROMPT_FILE"
else
  $CMD
fi
