---
name: commit-changes
description: Create clear, informative, and well-structured Git commit messages following best practices and conventional commit standards.
---
# Commit Changes

1. Review changes: `git diff`, `git status`
2. If on main/master, create a feature branch first
3. Stage relevant files (prefer specific files over `git add -A`)
4. Commit with conventional commit format: `type(scope): subject`

## Rules

- Imperative mood, subject ≤72 chars, no trailing period
- Body explains **what/why**, not how
- No co-author credits or "Generated with..." tags
- If changes are too diverse for one commit, suggest splitting
- Types: feat, fix, docs, style, refactor, test, chore
