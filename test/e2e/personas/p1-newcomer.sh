#!/bin/bash
# P1 — brand-new dev, README verbatim, no claude installed anywhere.
source /personas/lib.sh
install_squads
mkdir -p ~/app && cd ~/app && git init -q
git config --global user.email p1@test.local && git config --global user.name p1
squads init >/tmp/init.log 2>&1
assert_eq "init exits 0" "0" "$?"
assert_contains "init discloses telemetry" "Telemetry: anonymous usage" /tmp/init.log
[ -d .agents/squads/demo ] && D=yes || D=no
assert_eq "demo squad scaffolded" "yes" "$D"
squads run demo hello-world >/tmp/run.log 2>&1
assert_eq "run without claude exits 1" "1" "$?"
assert_contains "remedy names the install command" "@anthropic-ai/claude-code" /tmp/run.log
squads doctor >/tmp/doc.log 2>&1
assert_eq "doctor exits 1 with core tool missing" "1" "$?"
finish
