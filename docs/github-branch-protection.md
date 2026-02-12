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

## Quick Setup Checklist

如果你赶时间，按照这个清单操作：

1. ✅ 访问 `https://github.com/codetrek/pegasus/settings/branches`
2. ✅ 点击 "Add rule" 或编辑已有的 `main` 规则
3. ✅ Branch name pattern: 输入 `main`
4. ✅ 勾选 **"Require a pull request before merging"**
5. ✅ 勾选 **"Require status checks to pass before merging"**
   - ✅ 子选项：勾选 "Require branches to be up to date"
   - ✅ 搜索并选择 `test` 或 `Test and Coverage (95% Required)`
6. ✅ **滚动到页面最底部** 👇
7. ✅ 找到 "Rules applied to everyone including administrators"
8. ✅ 勾选 **"Do not allow bypassing the above settings"** ⚠️ 关键！
9. ✅ 点击 "Create" 或 "Save changes"

完成！现在测试一下：创建一个会失败的 PR，尝试合并，应该会被阻止。

---

## Required Configuration Steps

### 1. Access Branch Protection Settings

1. Go to your repository on GitHub
2. Navigate to: **Settings → Branches**
3. Or visit directly: `https://github.com/codetrek/pegasus/settings/branches`

### 2. Add/Edit Branch Protection Rule for `main`

Click **"Add rule"** or edit existing rule for `main` branch:

#### 页面布局说明

GitHub Branch Protection 设置页面从上到下的结构：

```
┌─────────────────────────────────────────────────────────┐
│ Branch name pattern: main                               │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ☑️ Require a pull request before merging                │
│   └─ Require approvals: [1] ▼                          │
│                                                          │
│ ☑️ Require status checks to pass before merging         │
│   └─ ☑️ Require branches to be up to date              │
│   └─ Search for status checks: [test________] 🔍       │
│       ☑️ test                                           │
│                                                          │
│ ☑️ Require conversation resolution before merging       │
│                                                          │
│ ☐ Require signed commits                                │
│                                                          │
│ ☑️ Require linear history                               │
│                                                          │
│ ☐ Require deployments to succeed before merging        │
│                                                          │
│ ☐ Lock branch                                           │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ ⚠️ 重点！滚动到这里 ⬇️                                    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Rules applied to everyone including administrators       │
│                                                          │
│ ☑️ Do not allow bypassing the above settings           │
│    ⚠️ 这是关键设置！必须勾选！                            │
│                                                          │
│ ☐ Allow force pushes                                    │
│ ☐ Allow deletions                                       │
│                                                          │
│                              [Create] or [Save changes]  │
└─────────────────────────────────────────────────────────┘
```

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
**这是最关键的设置！必须启用！**

**位置**：在页面最底部，"Rules applied to everyone including administrators" 部分

**具体操作**：
1. 向下滚动到页面底部
2. 找到标题 **"Rules applied to everyone including administrators"**
3. 勾选 ☑️ **"Do not allow bypassing the above settings"**

**效果**：
- ✅ 即使是仓库管理员（Admin）也不能绕过上述检查
- ✅ 没有人可以在 CI 失败时强制合并
- ✅ 没有人可以在 CI 运行时强制合并
- ❌ 如果不勾选，管理员仍然可以点击 "Merge without waiting for requirements to be met"

**重要提示**：
- 这个选项在页面**最底部**单独一个区域，容易被忽略
- 不要和上面的其他选项混淆
- 这是唯一能阻止管理员绕过检查的设置

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
3. **最重要**：检查页面底部的 "Do not allow bypassing the above settings" 是否勾选
   - 这是最常见的遗漏！
   - 如果没勾选，管理员仍然可以点击 "Merge without waiting" 绕过检查

### 找不到 "Do not allow bypassing the above settings" 选项

**Problem**: 在页面上找不到这个选项。

**Solution**:
1. **向下滚动**到页面最底部
2. 这个选项在单独的区域：**"Rules applied to everyone including administrators"**
3. 它不在上面那些选项里，而是在页面底部单独一块
4. 如果你的账号不是管理员，可能看不到这个选项（需要让仓库管理员设置）

### 设置后仍然可以直接 push 到 main

**Problem**: 配置了 branch protection 但仍然可以直接 push。

**Explanation**:
- Branch protection 只保护 **GitHub 上的分支**
- 本地的 pre-commit hook 负责阻止本地 commit
- 如果有人用 `git push --force` 或 `--no-verify`，需要在 GitHub 上额外设置：
  - 勾选 "Do not allow bypassing the above settings"
  - **不要**勾选 "Allow force pushes"

## References

- [GitHub Docs: About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Docs: Managing branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
