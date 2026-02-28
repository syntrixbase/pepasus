---
name: push-changes
description: Push local commits to remote, check for uncommitted changes, and create a PR with structured summary, changes list, and test plan.
---
# Push & Create PR

1. If uncommitted changes exist, ask user to commit first
2. Push to remote: `git push -u origin <branch>`
3. If PR already exists for this branch, show URL and stop
4. Analyze diff against base branch, create PR with `gh pr create`

## PR Format

- Title: conventional commit style (`feat: ...`, `fix: ...`)
- Body sections: Summary, Changes (bullet points from actual diff), Test Plan
- Always English, no co-author tags
