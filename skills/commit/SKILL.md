---
name: commit
description: Use when committing changes to git with conventional commit format
disable-model-invocation: true
argument-hint: "[-m 'message']"
---

Create a git commit following conventional commits:

1. Run `git status` to see all changes
2. Run `git diff` to review changes (staged and unstaged)
3. Run `git log --oneline -5` to see recent commit style
4. Draft a commit message following the pattern: type(scope): description
5. Stage relevant files (prefer specific files over `git add -A`)
6. Commit with the message

Types: feat, fix, refactor, docs, test, chore
