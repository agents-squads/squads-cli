# CLI Squad

## Mission

Build and maintain the Squads CLI - the command-line interface for managing AI agent squads.

## Q1 2026 Goals

- [ ] Dashboard shows ROI - cost projections, before/after metrics, baseline command
- [ ] Zero P1 issues open for >7 days
- [ ] Test coverage >80% for core commands

## Priority Management

### P1 (Critical) - 7 Day Policy

**Policy**: No P1 issue may remain open for more than 7 days.

**Automated Enforcement**:
- Daily workflow (`.github/workflows/p1-alert.yml`) checks all open P1 issues
- Warning notification at 5 days (approaching threshold)
- Critical alert + workflow failure at 7 days (threshold exceeded)

**Escalation Process**:

When a P1 issue ages past 5 days:

1. **Day 5**: Automatic warning generated
   - Squad lead reviews issue status
   - Identify blockers (external dependencies, approvals needed, complexity)
   - Update issue with current status and ETA

2. **Day 6**: Active intervention required
   - If blocked on external dependency → Escalate to stakeholder
   - If blocked on approval → Request expedited review
   - If too complex → Break down into smaller issues or request additional resources
   - If stale → Re-prioritize or downgrade to P2

3. **Day 7**: Policy violation
   - Workflow fails, blocking other CI processes
   - Squad lead must either:
     - **Resolve the issue** (merge fix)
     - **Downgrade priority** (with justification)
     - **Escalate to leadership** (for resource allocation)

**Exemptions**:
- Issues blocked on third-party dependencies (e.g., library approvals) may be documented as exceptions
- Document exemption reason in issue comment with `[P1-EXEMPTION]` tag
- Exempted issues still tracked but won't fail workflow

### P2 (Important)

Target resolution: 14 days. No automated enforcement, but monitored in squad dashboards.

### P3 (Nice to Have)

Addressed as capacity allows. May be closed if stale >60 days without activity.

## Issue Lifecycle

1. **Created**: Issue opened with squad:cli label
2. **Triaged**: Priority assigned (P1/P2/P3)
3. **In Progress**: PR opened referencing issue
4. **Review**: PR in review
5. **Resolved**: PR merged, issue closed

## Team

- **Squad Lead**: Human (architecture, prioritization, reviews)
- **Issue Solver Agent**: Autonomous (discovers issues, creates PRs)
- **Specialists**: Domain-specific agents (testing, refactoring, features)
