#!/bin/sh
# Test double for the notifier: records argv and stdin into $CAPTURE_FILE.
{
  printf 'ARGS %s\n' "$*"
  printf 'STDIN '
  cat
  printf '\nENV AGENT_ATTENTION_IDLE=%s AGENT_ATTENTION_IDLE_DELAY=%s\n' "${AGENT_ATTENTION_IDLE:-}" "${AGENT_ATTENTION_IDLE_DELAY:-}"
  printf 'SECRETS %s\n' "$(env | grep -E '(_API_KEY|_AUTH_TOKEN)=|^(ANTHROPIC|OPENAI)_' | cut -d= -f1 | sort | tr '\n' ' ')"
} >> "$CAPTURE_FILE"
