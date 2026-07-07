#!/bin/bash
# P3 — git installed, NO user.name/email anywhere (#980): fallback identity.
source /personas/lib.sh
install_squads; shim_claude_ok
mkdir -p ~/app && cd ~/app && git init -q
squads init >/tmp/init.log 2>&1
assert_eq "init exits 0" "0" "$?"
N=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
[ "$N" -ge 1 ] && C=yes || C=no
assert_eq "init actually committed (fallback identity)" "yes" "$C"
squads run demo hello-world >/tmp/run.log 2>&1
assert_eq "run exits 0 with working shim" "0" "$?"
if grep -qi "worktree creation failed" /tmp/run.log; then W=lost; else W=kept; fi
assert_eq "worktree isolation survives no-identity" "kept" "$W"
finish
