# gh — GitHub CLI Operations

You have access to `gh` (GitHub CLI) for repository and project management.

## Issues

```bash
gh issue list                              # List open issues
gh issue list --label "bug"                # Filter by label
gh issue view <number>                     # View issue details
gh issue create --title "..." --body "..." # Create issue
gh issue close <number>                    # Close issue
gh issue comment <number> --body "..."     # Add comment
```

## Pull Requests

```bash
gh pr list                                 # List open PRs
gh pr view <number>                        # View PR details
gh pr create --title "..." --body "..."    # Create PR
gh pr merge <number>                       # Merge PR
gh pr review <number> --approve            # Approve PR
gh pr checks <number>                      # View CI status
gh pr diff <number>                        # View PR diff
```

## Repository

```bash
gh repo view                               # View repo info
gh repo clone <owner/repo>                 # Clone repo
gh api repos/<owner>/<repo>                # Raw API access
```

## Workflow Runs

```bash
gh run list                                # List recent runs
gh run view <id>                           # View run details
gh run watch <id>                          # Watch run in progress
```

## Search

```bash
gh search repos "<query>"                  # Search repos
gh search issues "<query>"                 # Search issues
gh search prs "<query>"                    # Search PRs
```

## Best Practices

- **Check before creating**: Search existing issues/PRs before creating duplicates
- **Use labels**: Filter and organize with labels
- **Link issues**: Reference issues in PR descriptions with `Fixes #N`
- **Review CI**: Always check `gh pr checks` before merging
