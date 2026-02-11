# GitHub Branch Protection Setup

This document describes how to configure GitHub branch protection rules to prevent merging PRs before CI checks pass.

## Current CI Checks

Our repository has the following GitHub Actions workflows:

- **PR Workflow** (`.github/workflows/pr.yml`)
  - Job name: `Test and Coverage (95% Required)`
  - Runs on: Pull requests to `main`
  - Checks:
    - Type checking (`bun run typecheck`)
    - Tests with 95% coverage requirement
    - Coverage report upload

## Required Configuration Steps

### 1. Access Branch Protection Settings

1. Go to your repository on GitHub
2. Navigate to: **Settings → Branches**
3. Or visit directly: `https://github.com/codetrek/pegasus/settings/branches`

### 2. Add/Edit Branch Protection Rule for `main`

Click **"Add rule"** or edit existing rule for `main` branch:

#### Basic Settings
- **Branch name pattern**: `main`

#### Required Settings

##### ✅ Require a pull request before merging
- This prevents direct pushes to main (complementing our pre-commit hook)
- Optional settings:
  - **Require approvals**: Set to 1+ if you want code reviews
  - **Dismiss stale pull request approvals**: Recommended
  - **Require review from Code Owners**: Optional

##### ✅ Require status checks to pass before merging
This is the **critical setting** to prevent merging before CI finishes.

- Enable: **"Require status checks to pass before merging"**
- Enable: **"Require branches to be up to date before merging"**
- Select required checks from the list (after your first PR run, these will appear):
  - `test` or `Test and Coverage (95% Required)`

  > **Note**: The check name appears after the first workflow run. If you don't see it yet, merge one PR and it will appear.

##### ✅ Require conversation resolution before merging
- Enable if you want all PR comments to be resolved before merge

##### ✅ Do not allow bypassing the above settings
- **Critical**: Enable this to prevent administrators from bypassing checks
- Without this, admins can merge even if checks fail

#### Optional but Recommended Settings

##### ✅ Require linear history
- Prevents merge commits, enforces rebase or squash merge
- Keeps git history clean

##### ✅ Require signed commits
- Enhances security by requiring GPG-signed commits

##### ⬜ Lock branch
- Only enable if you want to make the branch read-only temporarily

### 3. Verify Configuration

After setting up, test the protection:

1. Create a test PR that will fail CI (e.g., add a failing test)
2. Try to merge the PR
3. You should see: **"Merging is blocked"** with the status check listed as required
4. The merge button should be disabled until checks pass

## Example: What You'll See

### ✅ When CI is Passing
```
All checks have passed
✓ test / Test and Coverage (95% Required)

[Merge pull request ▼]
```

### ❌ When CI is Running
```
Some checks haven't completed yet
○ test / Test and Coverage (95% Required) — In progress

[Merge pull request] ← Button is disabled
```

### ❌ When CI Fails
```
Some checks were not successful
✗ test / Test and Coverage (95% Required) — Failed

[Merge pull request] ← Button is disabled
Required status check "test" has not succeeded.
```

## Integration with Pre-commit Hook

Our repository has two layers of protection:

1. **Local (pre-commit hook)**: Prevents commits directly on main
   - Location: `git-hooks/pre-commit`
   - Checks: TypeScript, tests, branch name

2. **Remote (GitHub)**: Prevents merging before CI passes
   - Platform: GitHub Branch Protection
   - Checks: Full CI pipeline with coverage

This defense-in-depth approach ensures code quality at multiple stages.

## Troubleshooting

### Check names not appearing in the list

**Problem**: After clicking "Require status checks to pass", the check list is empty.

**Solution**:
1. Merge at least one PR to `main` branch
2. The workflow must complete (pass or fail)
3. Return to branch protection settings
4. The check name will now appear in the searchable list

### Status check is passing but merge is still blocked

**Problem**: Green checkmark but can't merge.

**Possible causes**:
1. **Branch not up to date**: Enable "Require branches to be up to date" and update your branch
2. **Wrong check selected**: Verify you selected the correct workflow/job name
3. **Pending reviews**: Check if code review approval is required

### Can still merge despite failing checks

**Problem**: Merge button is available even when CI fails.

**Solution**:
1. Verify "Require status checks to pass" is **enabled** (checkbox ticked)
2. Ensure the specific check is **selected** in the status checks list
3. Enable "Do not allow bypassing the above settings"

## References

- [GitHub Docs: About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Docs: Managing branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
