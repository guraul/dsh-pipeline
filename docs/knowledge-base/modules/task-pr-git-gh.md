# 模块：task / pr / 仓库定位 / git 与 gh 封装

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

## 职责

覆盖交付链的头尾两段：从 issue 建任务工作树（`task`）、推送分支并开 PR（`pr`），以及它们共用的「在哪 / 对谁」定位与外部命令封装。

## 关键文件

| 文件 | 职责 |
|---|---|
| `lib/task.mjs` | `runTask`、`slugify`、`normalizeSlug`、`taskBranchName`、`taskWorktreePath`、`resolveWorktreesDir` |
| `lib/pr.mjs` | `runPr`、`prBody`、`issueFromBranch`、`TASK_BRANCH_PATTERN` |
| `lib/repo.mjs` | `resolveRoot`（当前工作树）、`resolveMainRoot`（主工作区）、`resolveRepo`、`repoFromRemote`、`mainRootFromCommonDir` |
| `lib/git.mjs` | 16 个具名 git 操作 |
| `lib/gh.mjs` | 10 个具名 gh 操作；`MERGE_STRATEGY = 'squash'` |

## `task`（`lib/task.mjs`）

```bash
dsh-pipeline task <issue号> [--slug <slug>] [--root <dir>] [--worktrees-dir <dir>]
```

| 项 | 规则 |
|---|---|
| 分支 | `task/<issue号>-<slug>` |
| worktree | `<父目录>/<issue号>-<slug>`；父目录 = `--worktrees-dir` > 配置 `worktreesDir` > `<root>/.worktrees` |
| 基线 | **恒为 `origin/main`**（不是本机 HEAD） |
| root | 主工作区（`git rev-parse --git-common-dir` 的父目录）；显式 `--root` 若正好是 linked worktree 顶层会**折回主工作区** |
| slug | 标题小写 → 非 `[a-z0-9]` 折成 `-` → 去首尾 `-` → 截断 40；**非 ASCII 标题会被整段清空**，此时回退成标题 `sha1` 前 8 位（必须确定性，重跑要得到同一分支名） |
| `--slug` | 与自动 slug 同一字符集与长度上限；规范化后为空 → 退 2，**不静默回退**到自动 slug |
| 幂等 | worktree 已存在 → 只打印路径，退 0，**不 fetch、不动现场** |
| 路径冲突 | 路径存在但不是本仓 worktree → `E_PATH` 退 2 |
| fetch | 失败重试 3 次（间隔 3s，`Atomics.wait` 同步等待）仍失败 → `E_FETCH` 退 2 |
| 身份 | worktree 建好后把 `user.name` / `user.email` 从主工作区复制到 worktree 局部配置；读不到就跳过（不把身份缺失判成失败） |

**`--worktrees-dir` 的存在理由**：宿主会从主仓加载源码（如 memx），worktree 建在仓内会让宿主加载到未合并代码，所以要能把 worktree 挪到仓库外。只在显式给了该 flag 时才 `mkdir -p` 父目录——缺省路径行为一个字节都不变。

## `pr`（`lib/pr.mjs`）

```bash
dsh-pipeline pr [--issue <号>] [--root <dir>]
```

| 项 | 规则 |
|---|---|
| 分支 | 必须是 `task/<号>-<slug>`（正则 `TASK_BRANCH_PATTERN`）；分支名不含号时用 `--issue` 补，但仍必须在 `task/*` 上 |
| `--issue` 冲突 | 与分支名里的号不一致 → 退 2（要改 PR 关哪个 issue，先改分支名） |
| 工作区 | 必须干净（`status --porcelain` 为空），否则 `E_DIRTY` |
| 幂等 | 先 `gh pr view --head <branch>`，已存在 → 只打印链接，不重推 |
| PR 标题 | `<issue 标题> (#<号>)` |
| PR 正文 | 首行 `Closes #<号>`，其后是合并前提（与 `docs/pipeline/README.md` §四 口径一致，改动要同步） |
| base | `main` |

顺序：定位 root → 读当前分支 → 解析 issue（含 `--issue` 校验）→ `resolveRepo` → `gh issue view`（取标题）→ 查已有 PR → 查工作区干净 → `git push -u origin <branch>` → `gh pr create`。

## `lib/repo.mjs`（两套 root，不能混用）

| 函数 | 取值方式 | 谁用 |
|---|---|---|
| `resolveRoot({root, cwd, git})` | 显式 root 优先，否则 `git rev-parse --show-toplevel` | `pr` |
| `resolveMainRoot({root, cwd, git})` | 显式 root（若是 linked worktree 顶层则折回主工作区），否则 `--git-common-dir` 的父目录 | `task`；`record`/`review`/`selftest`/`shim`/`status`/`hooks` 经 `bin/cli.mjs` 的 `resolveMainWorktreeRoot` |
| `resolveRepo({root, git})` | 配置 `repo` 优先，否则从 `origin` 远端地址反推；两条都拿不到**明确失败**（绝不猜一个仓库去开 PR） | `task` / `pr` |

- `repoFromRemote` 覆盖 `git@github.com:o/n.git`、`https://github.com/o/n.git`、`ssh://git@github.com/o/n` 三种写法；
- `mainRootFromCommonDir` 要先把 git 返回的**相对**路径（`.git` / `../.git`）按 cwd 归一成绝对路径，再取父目录；
- 路径比较用 `realpathSync`（macOS 的 `/var` → `/private/var` 很常见），不存在时退回字面归一。

## `lib/git.mjs`（具名操作，固定 argv）

`worktreeList`（解析 `--porcelain`）、`currentBranch`、`headSha`、`remoteUrl`、`toplevel`、`gitCommonDir`、`statusPorcelain`、`checkout`、`fetch`、`mergeFF`、`worktreeAdd`、`push`、`configGet`、`configSet`、`worktreeRemove`、`deleteBranch`。

约定：

- 目录用 `git -C <cwd>` 传，不用 spawn 的 `cwd` 选项（命令自解释，测试断言不必看 options）；
- 引用名 / 路径校验 `REF_PATTERN = /^[^\s-][^\s]*$/`（不许以 `-` 开头，挡掉被当成选项）；
- 一律返回 `{ ok, code, data, error }`，不抛异常；
- **允许清单里没有 `push origin --delete`**：远端分支删除交给 `gh pr merge` 的仓库设置（auto-delete-branch），不打算为它开后门；
- `worktreeList` 返回数组，**第一条是主工作区**（git 保证）。

## `lib/gh.mjs`（具名操作）

`prView`、`prChecks`（`--json name,state,bucket,…`）、`prDiff`、`prMerge`、`prComment`、`prReview`、`prList`、`issueView`、`prViewByBranch`、`prCreate`。

- 只暴露具名操作，argv 在内部拼好，调用方**不能传任意子命令或任意参数**；
- 合并策略固定 `--squash`，不接受参数；
- `prReview` 的 event 映射到互斥的 `--approve` / `--request-changes` / `--comment` 开关。

## 两条封装共用的测试形状

所有函数接受 `{ runner }`：`runner(command, args, options)` 返回 `{ status, stdout, stderr, error }`。单测用假 runner 断言"实际发出的命令"，**不触网、不动真实仓库**。新增外部调用必须沿用这个形状，否则没法测。

## 修改本模块的注意事项

1. **不要用 `--show-toplevel` 推 worktree 容器**：那是当前工作树；容器必须以主工作区为基准（2026-11-02 实测踩过三次）。
2. **`--worktrees-dir` 缺省时必须零行为变化**：`task` 的 `mkdirSync` 只在显式给了 flag 时执行。
3. **slug 保底必须确定性**：固定串会让不同 issue 撞同一个分支/目录。
4. **`pr` 的幂等要放在推送之前**：已存在 PR 时不要重推。
5. **不要在 `git.mjs` 里加任意参数透传**，也不要为了某个功能放宽 `REF_PATTERN`。
6. **`prBody` 的文案与 `docs/pipeline/README.md` §四 口径绑定**，改一处要看另一处。

## 相关测试

`test/task.test.mjs`、`test/task-worktree.test.mjs`、`test/pr.test.mjs`、`test/git.test.mjs`、`test/gh.test.mjs`。
