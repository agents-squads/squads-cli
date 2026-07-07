#!/bin/bash
# P4 — solo repo, no origin, no gh (#979): full loop incl. LOCAL approve.
source /personas/lib.sh
install_squads
mkdir -p ~/app && cd ~/app && git init -q -b main
git config --global user.email p4@test.local && git config --global user.name p4
echo base > README.md && git add -A && git commit -qm base
git checkout -q -b squads/run-demo-p4test-0 && echo art > deliverable.md && git add -A && git commit -qm "demo: deliverable" && git checkout -q main
mkdir -p .agents/squads/demo && printf -- "---\nname: demo\n---\n| Agent | Role |\n|---|---|\n| hello-world | lead |\n" > .agents/squads/demo/SQUAD.md
squads inbox >/tmp/inbox.log 2>&1
assert_contains "inbox surfaces stranded work without a remote" "run-demo-p4test-0" /tmp/inbox.log
squads inbox approve branch-squads/run-demo-p4test-0 --json >/tmp/approve.log 2>&1
assert_eq "approve exits 0 (local landing)" "0" "$?"
assert_contains "approve reports local merge" "merged locally" /tmp/approve.log
[ -f deliverable.md ] && L=yes || L=no
assert_eq "deliverable landed on trunk" "yes" "$L"
finish
