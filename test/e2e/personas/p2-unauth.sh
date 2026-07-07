#!/bin/bash
# P2 — claude installed, never logged in (the silent-failure class, #956/#957).
source /personas/lib.sh
install_squads; shim_claude_unauth
mkdir -p ~/app && cd ~/app && git init -q
git config --global user.email p2@test.local && git config --global user.name p2
squads init >/dev/null 2>&1
squads run demo hello-world >/tmp/run.log 2>&1
assert_eq "unauth run exits 1" "1" "$?"
assert_contains "remedy says claude /login" "claude /login" /tmp/run.log
squads doctor >/tmp/doc.log 2>&1 || true
assert_contains "doctor shows unauthenticated" "claude /login" /tmp/doc.log
finish
