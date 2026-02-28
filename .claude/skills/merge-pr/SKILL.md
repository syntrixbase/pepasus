---
name: merge-pr
description: Watch CI checks, auto-fix failures, and squash-merge the PR when all checks pass.
---
# Merge PR When CI Passes

Squash-merge a PR after CI passes. Handles uncommitted/unpushed changes, CI failures, and worktree cleanup.

## Usage
```
/merge-pr [pr-number]
```
If no PR number, use the current branch's PR.

## Flow

1. **Pre-flight**: If there are uncommitted changes, ask user to commit. If there are unpushed commits, push them. If no PR exists, ask user if they want to create one.

2. **If PR number was provided and it's a different branch**: Stash changes, switch to the PR branch.

3. **Watch CI**: `gh pr checks <number> --watch`. If checks fail, inspect logs (`gh run view <id> --log-failed`), fix the issue, push, and re-watch.

4. **Merge**: Consolidate commit messages (PR title as main message, unique changes as bullet points), then squash-merge with `--delete-branch`.

5. **Cleanup**:
   - **In a worktree**: `cd` back to main repo, `git worktree remove <path>`, `git fetch origin main`.
   - **Switched branch**: Restore original branch and `git stash pop`.
   - **On the PR branch**: `git fetch origin main && git checkout origin/main` (detached HEAD to avoid main branch conflicts with other worktrees).
