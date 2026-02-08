# Issue Escalation Policy

## Goal

**Zero P1 issues open for more than 7 days.**

## Priority Definitions

| Priority | Description | SLA |
|----------|-------------|-----|
| **P1** | Critical bugs, security issues, blockers | 7 days max |
| **P2** | Important features, significant bugs | 30 days target |
| **P3** | Nice to have, minor improvements | Best effort |

## P1 Issue Lifecycle

### Day 0-3: Active Resolution
- Issue labeled `P1` automatically
- Assigned to `issue-solver` agent or squad lead
- Daily standup check in `#squad-cli`

### Day 4: First Alert
- Automated comment on issue: "P1 approaching SLA (4 days old)"
- Squad lead notified in `#squad-cli`

### Day 5: Escalation Warning
- Automated comment: "P1 ESCALATION WARNING (5 days old)"
- Escalated to `#company` channel
- CTO/COO briefed

### Day 6: Active Escalation
- Automated comment: "P1 ESCALATED (6 days old)"
- Must have either:
  - Active PR in review
  - Documented blocker with resolution plan
  - Downgrade justification to P2

### Day 7: SLA Breach
- Automated comment: "P1 SLA BREACH (7 days old)"
- Mandatory review meeting
- Root cause analysis required
- Process improvement documented

## Escalation Process

### 1. Self-Serve Resolution
```bash
# Check P1 aging
gh issue list --repo agents-squads/squads-cli \
  --label P1 \
  --json number,title,createdAt

# Assign to yourself
gh issue edit NUMBER --add-assignee @me

# Update status
gh issue comment NUMBER --body "Working on this, ETA: [date]"
```

### 2. Squad Lead Review
If P1 reaches day 4:
- Squad lead (`cli-lead`) reviews issue
- Determines if scope is accurate
- Assigns to builder or escalates

### 3. Company Escalation
If P1 reaches day 5:
- Escalated to `#company` Slack channel
- CTO/COO review blocker
- Resources allocated or priority adjusted

### 4. Post-Mortem
If P1 breaches 7 days:
- Document what went wrong
- Update process to prevent recurrence
- Add to squad learnings

## Monitoring

### Automated Checks
- **Daily**: issue-solver scans for P1 issues during queue discovery
- **Continuous**: Smart trigger checks P1 age every 15 minutes
- **Weekly**: cli-lead reviews all open P1s in sprint planning

### Manual Checks
```bash
# Find aging P1 issues
gh issue list --repo agents-squads/squads-cli \
  --label P1 \
  --json number,title,createdAt \
  | jq '.[] | select((.createdAt | fromdateiso8601) < (now - 604800))'
```

## Downgrade Criteria

A P1 can be downgraded to P2 if:
- Workaround exists and is documented
- Affects < 5% of users
- Blocked by external dependency with no ETA
- Scope was misclassified (not actually critical)

**Requires:** Approval from squad lead + comment justification

## Upgrade Criteria

Upgrade to P1 if:
- Security vulnerability
- Data loss risk
- Blocks core functionality
- Affects majority of users

## Current Status

Run this to check compliance:
```bash
squads status cli --p1-report
```

Or manually:
```bash
gh issue list --repo agents-squads/squads-cli --label P1 --state open
```

## Related

- [Contributing Guide](../CONTRIBUTING.md)
- [Squad: CLI](../../hq/.agents/squads/cli/SQUAD.md)
- [Quality Gates](../CLAUDE.md#quality-gates)

---

**Last Updated:** 2026-02-08
**Owner:** cli squad lead
**Review Cadence:** Quarterly
