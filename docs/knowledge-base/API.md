# 接口清单

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

本包没有 HTTP 接口。对外接口分两类：**CLI 子命令**（人 / 脚本 / 消费仓 shim 调用）与 **lib 导出**（测试与被后续子命令复用）。规则来源是 `docs/CONTRACT.md` §3–§5。

## 1. CLI 子命令全集

`dsh-pipeline <子命令> [选项]`；`-h/--help`、`-v/--version` 为全局选项。已实现 14 个，`SUBCOMMANDS` 与 `IMPLEMENTED` 两个集合一致（顶层 `prepare` 占位已删除，调它现在报「未知子命令」退 2）。

| 子命令 | 作用 | 关键选项 | 处理函数 | 退出码 |
|---|---|---|---|---|
| `task` | 从 issue 建 `task/<号>-<slug>` 分支与 worktree | `<issue号>`（位置参数）、`--slug`、`--root`、`--worktrees-dir` | `bin/cli.mjs` `runTask` → `lib/task.mjs` `runTask` | 0 成功或幂等 / 2 全部失败 |
| `pr` | 推送当前任务分支并创建 PR | `--issue`、`--root` | `runPr` → `lib/pr.mjs` `runPr` | 0 / 2 |
| `review prepare` | 读 PR 的 head / 改动文件 / diff，写审核请求 | `--pr`(必填)、`--issue`、`--root`、`--model`、`--round`、`--out`、`--facts`、`--include` | `runReviewPrepare` | 0 / 2 |
| `review prompt` | 由请求 JSON 渲染审核提示词（不发外部命令） | `--request`(必填，无缺省)、`--out`、`--role` | `runReviewPrompt` → `lib/review.mjs` `buildPrompt` | 0 / 2 |
| `review publish` | 把判定落成记录；可选发 GitHub review | `--pr`、`--response`(必填)、`--request`、`--round`、`--root`、`--model`、`--provider`、`--form`、`--post-review`、`--dry-run`、`--legacy-exit-codes` | `runReviewPublish` →（复用）`runRecord` + `sendReview` | 0 APPROVE（或带 `--legacy-exit-codes` 的 REJECT）/ 1 REJECT 或 ESCALATE / 2 参数与配置 / 3 发 review 失败 |
| `record` | 只落盘判定记录（供外部流程使用） | `--request`、`--response`(必填)、`--findings`、`--round`、`--root`、`--model`、`--provider`、`--form`、`--duration-ms`、`--name`、`--json` | `runRecord` | 0（含 REJECT）/ 1 ESCALATE 已落盘 / 2 |
| `gate` | 审核闸门检查 | `--pr`、`--root`(均必填)、`--record`、`--head-sha`、`--no-review`、`--reason` | `runGate` → `decideGate` → `lib/gate.mjs` | 0 / 1 闸门拒绝 / 2 |
| `merge` | 闸门通过后 squash 合并并清理现场 | 同 `gate`，另加 `--check-only`、`--checks-file`、`--force` | `runMerge` → `lib/merge.mjs` `runMerge` | 0 / 1 / 2 |
| `status` | 审核记录概况 | `--root`（缺省主工作区） | `runStatus` | 0 / 2 |
| `doctor` | 多仓「装的共享包是否同一构建」；可选 profile 体检 | `--repo a,b`、`--json`、`--expect <sha>`、`--profile <dir>` | `runDoctor` → `lib/doctor.mjs` / `lib/profile-check.mjs` | 0 / 1 漂移或体检失败 / 2 |
| `selftest` | 一致性自检（契约 §9） | `--shims`、`--config`、`--lock`、`--peer`、`--exit-codes`、`--fast`、`--repos a,b`、`--json`、`--root`、`--dsh-version` | `runSelftest` → `lib/selftest.mjs` | 0 / 1 / 2（`--peer` 不知道当前版本即 2） |
| `lock` | 写入 / 核对 `.dsh/pipeline.lock.json`（契约 §7.2） | `write --root <dir>`、`check --root <dir>` | `runLock` → `lib/lock.mjs` | 0 一致或跳过 / 1 不一致、格式非法或旧版本包 / 2 用法错误或未装包 |
| `shim` | 生成 / 校验入口 shim（契约 §8） | `install [--root] [--force]`、`check [--root]` | `runShim` → `lib/shim.mjs` | 0 / 1 冲突或不一致 / 2 |
| `hooks` | 安装 / 校验 pre-push 直推拦截钩子 | `install [--root] [--force] [--allow-main]`、`check [--root]` | `runHooks` → `lib/hooks.mjs` | 0 / 1 未装、不一致、拒绝覆盖 / 2 |
| `check-all` | 逐包跑 test / check / typecheck 并汇总 | `--root`、`--packages a,b,c`、`--json` | `runCheckAllCommand` → `lib/check-all.mjs` | 0 / 1 有失败 / 2 / 3 找不到 pnpm |
| `deploy` | 生成 / 校验 caller workflow 骨架（契约 §10） | `init --root <dir> [--write] [--rollback]`、`check --root <dir>` | `runDeploy` → `lib/deploy.mjs` | 0 / 1 不一致、缺标记或拒绝覆盖 / 2 |

### 输出约定（契约 §5）

| 类型 | 现行格式 |
|---|---|
| 数据行 | stdout，无前缀（路径、URL、记录路径） |
| 状态行 | `<子命令>: <消息>`，中文（`gate` / `merge` 用人读长句，如 `审核闸门: PR #12 通过`） |
| 错误行 | stderr，`<子命令>: <消息>`；警告也走 stderr（如跳过审核的警告） |
| 机器模式 | `--json` 输出一个 JSON 对象；退出码与人读模式一致 |

**错误行带错误码**（`dsh-pipeline: <子命令>: <错误码>: <说明>`）属于目标（P2），尚未实现——外部脚本目前**不要**依赖错误里出现错误码。

### 退出码口径（契约 §4，含现状差异）

| 码 | 含义 | 现行出现范围 |
|---|---|---|
| 0 | 成功 | 全部；`record` / `review publish` 的 `REJECT` 只有带 `--legacy-exit-codes` 才退 0 |
| 1 | 业务拒绝 | `gate`、`merge`（闸门拒绝 / CI 未过）、`record` 与 `review publish` 的 `REJECT` / `ESCALATE`、`doctor` 漂移、`selftest` 不通过、`shim`/`hooks` 不一致或冲突、`check-all` 有失败 |
| 2 | 用法或环境错误 | 全部子命令的参数错误；`gate` 取不到 head；`task` 的 fetch / worktree 失败；`review prepare` 读 PR 失败 |
| 3 | 环境错误 | `check-all` 找不到 pnpm；`review publish --post-review` 的 gh 调用失败（记录不回滚） |

入口 shim **不得改写退出码**，只透传。

## 2. 两条典型调用链

```bash
# 无 review.sh 的消费仓：review 一趟出请求与记录
dsh-pipeline review prepare --pr 12 --root .            # → request.json / nonce / head 前 7 位
dsh-pipeline review prompt  --request .tmp/review/12/request.json   # → 提示词
# （reviewer 产出判定后）
dsh-pipeline review publish --pr 12 --response .tmp/review/12/res.txt --post-review

# 本仓合并自己的 PR（dogfood）
dsh-pipeline merge --pr 12 --record .dsh-web/reviews/12-<sha>.json
dsh-pipeline merge --pr 13 --check-only                # 演练：只跑闸门 + CI
dsh-pipeline merge --pr 14 --no-review --reason "改 CI 本身，用户当场同意"

# 生成 / 校验消费仓的部署 caller 骨架（必须先装包，源码运行没有 build.json）
dsh-pipeline deploy init --root <消费仓> [--write] [--rollback]
dsh-pipeline deploy check --root <消费仓>
```

## 3. lib 导出（内部接口）

| 模块 | 主要导出 | 用途 |
|---|---|---|
| `lib/gate.mjs` | `evaluateGate`, `DEFAULT_TTL_MS` | 闸门纯函数（TTL 24h） |
| `lib/merge.mjs` | `runMerge`, `STEP_ORDER`, `FF_REF`, `MAIN_BRANCH` | 合并编排 |
| `lib/policy.mjs` | `mergePolicy`, `DEFAULT_HIGH_RISK`, `MAX_CHANGED_LINES`, `globToRegExp`, `normalizePath`, `dependencyChange` | 高风险策略（自己实现的 glob 子集 `**` `*` `?`） |
| `lib/record.mjs` | `readRecord`, `writeRecord`, `validateRecord`, `assertRecord`, `reviewsDir`, `recordFile`, `writeSkipAudit`, `skipAuditFile`, `stamp`, `SCHEMA_VERSION`, `MAX_ROUND`, `PACKAGE_VERSION`, `SHA_PATTERN`, `SEMVER_PATTERN`, `VERDICTS`, `SEVERITIES` | 记录层 |
| `lib/review.mjs` | `makeNonce`, `parseVerdict`, `analyzeVerdict`, `extractFindings`, `buildPrompt`, `buildReviewBody`, `detectIssueFromBody`, `reviewEvent`, `reviewMarker`, `listPullReviews`, `createPullReview`, `NONCE_PATTERN`, `DIFF_BEGIN/DIFF_END`, `MAX_BODY_FINDINGS` | 审核编排 |
| `lib/roles.mjs` | `resolveRoles`, `DEFAULT_ROLES`, `ROLE_FIELDS`, `PERMISSION_MODES` | 角色与权限边界 |
| `lib/config.mjs` | `loadConfig`, `validateConfig`, `mergeConfig`, `defaultConfig`, `CONFIG_FIELDS`, `CONFIG_PATH`, `ConfigError` | 配置层（数组追加、对象深合并） |
| `lib/task.mjs` | `runTask`, `slugify`, `normalizeSlug`, `taskBranchName`, `taskWorktreePath`, `resolveWorktreesDir`, `FETCH_RETRY`, `FETCH_RETRY_DELAY_MS`, `BASE_REF`, `WORKTREES_DIR`, `SLUG_MAX` | 建任务 |
| `lib/pr.mjs` | `runPr`, `prBody`, `issueFromBranch`, `TASK_BRANCH_PATTERN`, `PR_BASE` | 开 PR |
| `lib/repo.mjs` | `resolveRoot`, `resolveMainRoot`, `resolveRepo`, `repoFromRemote`, `mainRootFromCommonDir` | 两种 root 语义 + owner/name |
| `lib/git.mjs` | `worktreeList`, `worktreeAdd`, `worktreeRemove`, `currentBranch`, `headSha`, `toplevel`, `gitCommonDir`, `remoteUrl`, `statusPorcelain`, `checkout`, `fetch`, `mergeFF`, `push`, `deleteBranch`, `configGet`, `configSet` | git 具名操作 |
| `lib/gh.mjs` | `prView`, `prChecks`, `prDiff`, `prMerge`, `prComment`, `prReview`, `prList`, `issueView`, `prViewByBranch`, `prCreate`, `MERGE_STRATEGY` | gh 具名操作 |
| `lib/shim.mjs` | `renderShim`, `installShims`, `checkShims`, `SHIM_ENTRIES`, `SHIM_DIR` | 入口生成与比对 |
| `lib/hooks.mjs` | `renderHook`, `installHook`, `checkHook`, `HOOK_MARKER` | pre-push 钩子 |
| `lib/selftest.mjs` | `runChecks`, `checkConfig`, `checkShimsEntry`, `checkRepos`, `DONE_CHECKS`, `PENDING_CHECKS` | 一致性门禁 |
| `lib/check-all.mjs` | `discoverPackages`, `runCheckAll` | 批量检查 |
| `lib/doctor.mjs` | `inspectRepo`, `describeRow`, `diagnose` | 构建一致性 |
| `lib/lock.mjs` | `readLock`, `writeLock`, `checkLock`, `readInstalledBuild`, `formatExpect`, `LOCK_PATH`, `LockError` | 锁文件（§7.2） |
| `lib/peer.mjs` | `collectRequirements`, `resolveDshVersion`, `checkPeer` | 插件 DSH 版本声明（§9） |
| `lib/semver.mjs` | `parseVersion`, `compare`, `satisfies` | 版本范围匹配（§9） |
| `lib/deploy.mjs` | `renderRegion`, `renderSkeleton`, `extractRegion`, `firstDifference`, `replaceRegion`, `resolveDeploy`, `DEPLOY_WORKFLOW_FILE`, `DEPLOY_WORKFLOW_REPO`, `REGION_BEGIN`, `REGION_END`, `DeployError` | 部署 caller 骨架 |
| `lib/profile-check.mjs` | `checkProfile`, `resolveDshHome`, `resolveProfileDir`, `OLD_PKG`, `NEW_PKGS` | profile 体检 |
| `lib/build-info.mjs` | `readBuildInfo`, `describeBuild` | 构建标识 |

**所有 `lib/gh.mjs` / `lib/git.mjs` / `lib/check-all.mjs` 的调用点都接受 `runner`**：测试用假 runner 断言"实际发出的命令"，不触网、不动真实仓库。新增外部调用时必须沿用这个形状。

## 4. GitHub 侧副作用（会被外部看到的动作）

| 动作 | 命令 | 触发点 |
|---|---|---|
| 建 PR | `gh pr create --base main --head <分支> --title "<issue 标题> (#N)" --body-file`（body 由 `prBody` 生成，首行 `Closes #N`） | `pr` |
| 读 checks | `gh pr checks <n> --json …` | `merge` 的 `ci` 步 |
| squash 合并 | `gh pr merge <n> --squash` | `merge` 的 `merge` 步 |
| 删远端分支 | 不在本包允许清单里，交给仓库设置 auto-delete-branch | — |
| 发 review | `gh api -X GET --paginate repos/<repo>/pulls/<n>/reviews`（幂等检查，显式 GET 否则会被 `-F` 翻成 POST）、`gh api repos/<repo>/pulls/<n>/reviews -X POST -f event=… -f body=…` | `review publish --post-review` |
| 发评论 | `gh pr comment`（封装在 `lib/gh.mjs`，当前 CLI 未调用） | — |
