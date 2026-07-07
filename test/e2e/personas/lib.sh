#!/bin/bash
# Persona battery shared helpers (user-testing validator applied to ourselves).
# Every persona runs in a fresh Docker container against the packed dev tarball.
export SQUADS_TELEMETRY_DISABLED=1
PASS=0; FAIL=0; FAILURES=""

assert_eq() { # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); FAILURES="$FAILURES\n  ✗ $1 (expected '$2', got '$3')"; echo "  ✗ $1 (expected '$2', got '$3')"; fi
}
assert_contains() { # assert_contains <label> <needle> <haystack-file-or-string>
  local hay; [ -f "$3" ] && hay=$(cat "$3") || hay="$3"
  if echo "$hay" | grep -qiF "$2"; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); FAILURES="$FAILURES\n  ✗ $1 (missing '$2')"; echo "  ✗ $1 (missing '$2')"; fi
}
finish() { echo; echo "persona result: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ] || { echo -e "$FAILURES"; exit 1; }; exit 0; }

install_squads() { npm install -g /pkg/squads-cli-dev.tgz >/dev/null 2>&1; }
shim_claude_ok() { # a working fake provider emitting valid stream-json
  cat > /usr/local/bin/claude <<'SHIM'
#!/bin/bash
for a in "$@"; do case "$a" in --version) echo "9.9.9 (shim)"; exit 0;; whoami) echo "shim@example.com"; exit 0;; esac; done
cat > /dev/null 2>&1 &
echo '{"type":"result","result":"done\n\n## HANDOFF\ncompleted: task\nundone: none\ncommands: `true` → 0\nissues: none\nprocedures: followed\n\n## STATUS: DONE","usage":{"input_tokens":10,"output_tokens":10},"total_cost_usd":0.001,"num_turns":1,"model":"shim"}'
SHIM
  chmod +x /usr/local/bin/claude
}
shim_claude_unauth() { # claude installed but not logged in
  cat > /usr/local/bin/claude <<'SHIM'
#!/bin/bash
for a in "$@"; do case "$a" in --version) echo "9.9.9 (shim)"; exit 0;; whoami) echo "Not logged in"; exit 1;; esac; done
cat > /dev/null 2>&1 &
echo "Not logged in · Please run /login"
exit 1
SHIM
  chmod +x /usr/local/bin/claude
}
