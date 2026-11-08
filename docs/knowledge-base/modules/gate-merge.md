# 模块：闸门、合并与高风险策略

**最后更新**：2026-11-08 · 对应提交 `18289d5`

## 职责

决定「一条审核记录能不能作为合并依据」（闸门），并在通过后完成「CI 校验 → squash 合并 → 清理现场」（合并）。高风险策略负责标注「这次变更是否必须人工放行」。

## 关键文件

| 文件 | 职责 |
|---|---|
| `lib/gate.mjs` | 闸门判定的**纯函数** `evaluateGate`；`DEFAULT_TTL_MS` = 24h |
| `lib/merge.mjs` | 合并编排 `runMerge`；`STEP_ORDER`、`FF_REF`、`MAIN_BRANCH` |
| `lib/policy.mjs` | `mergePolicy` / `DEFAULT_HIGH_RISK` / `MAX_CHANGED_LINES`(400) / `globToRegExp` / `normalizePath` / `dependencyChange` |
| `bin/cli.mjs` | `runGate`、`runMerge`、`decideGate`（CLI 侧那一份）、`parseGateArgs` |

## 闸门（`evaluateGate`）

入参：`{ record, headSha, currentPolicyVersion, now, ttlMs, maxRounds }`。`maxRounds` 缺省 `MAX_ROUND`（3），由调用方按配置 `review.rounds` 传入。`record` 可以是对象或 JSON 文本；解析失败按「不可解析」处理，不猜。

判定顺序（顺序即语义，前面的不成立时后面没有意义）：

| # | 条件 | 失败码 | 说明 |
|---|---|---|---|
| 1 | 记录文件存在 | `E_RECORD` | 缺失即拒（fail-closed） |
| 2 | 文件内容是合法 JSON | `E_PARSE` | 存在但解析不了（由 `readRecord` 抛，CLI 的 `decideGate` 透出；`evaluateGate` 只接收已解析对象） |
| 3 | `schemaVersion === 1` | `E_SCHEMA`（缺失算 `E_RECORD`） | 结构版本 |
| 4 | `round ∈ 1..maxRounds` | `E_RECORD` | 轮次上限取配置 `review.rounds`（1..3，缺省 3） |
| 5 | `verdict === 'APPROVE'` | `E_VERDICT` | 带上记录里的 `errorCode`（可能是 `E_PARSE` / `E_POLICY`）、绝不猜测或补全 |
| 6 | `head_sha === headSha` | `E_SHA_MISMATCH` | 判定绑定的提交 |
| 7 | `createdAt` 可解析且 `now - createdAt <= ttl` | `E_RECORD` / `E_EXPIRED` | TTL 默认 24h |
| 8 | `policy.hit` 为假 | `E_POLICY` | 命中高风险必须人工放行，理由从 `policy.reasons` 里取路径 |
| 9 | `policyVersion === 当前包版本` | `E_POLICY_VERSION` | 按旧规则审的记录必须复审 |

（失败码是**内部码**；输出层的错误行一律折成契约 §5 的 6 码，见 `bin/cli.mjs` 的 `publicCode`。）

**无 IO、不直接读时钟**：`now` 由调用方传入（缺省才取当前时间），同一组输入永远同一结论，单测与审计可复现。

### CLI 侧的 `decideGate`（`gate` 子命令）

在调 `evaluateGate` 之前多做三项 CLI 层检查：

1. `--no-review`：写跳过审计（`.dsh-web/reviews/skips/<ts>-<pr>.json`），打印警告到 stderr，返回 0；写审计失败退 2；
2. 没给 `--record` 且没声明 `--no-review`：**fail-closed** 退 1（`dsh-pipeline: gate: E_RECORD: 未提供审核记录，且未声明 --no-review，按失败关闭处理`）；
3. 记录属于哪个 PR：`record.pr !== --pr` 退 1；`head-sha` 未给时用 `git HEAD`（取不到退 2）。

## 合并（`runMerge`）

`STEP_ORDER = ['repo','head','gate','pr','ci','merge','worktree','fetch','ff','branch']`

| 步 | 动作 | 失败码 | 关键约束 |
|---|---|---|---|
| `repo` | 读 `.dsh/pipeline.json` 的 `repo` | `E_CONFIG` | 缺 repo 直接拒绝 |
| `head` | `gh pr view` 的 `headRefOid`（或 `--head-sha`） | `E_HEAD`（gh 读取失败 → 输出层折成 `E_ENV`）/ `E_STATE`（PR 没有 headRefOid）/ `E_INPUT`（输出层同样折成 `E_STATE`） | **不用本机 HEAD** |
| `gate` | 同闸门（含跳过审计） | 闸门的码 | 不通过时后面的 gh 命令一条都不发 |
| `pr` | 取 `headRefName` / `state` | `E_PR` | `CLOSED` 拒绝；`MERGED` 只清理 |
| `ci` | `gh pr checks` 或 `--checks-file` | `E_CI` | 未知状态按阻塞；无 checks 跳过门槛；`--force` 连 gh 都不发 |
| `merge` | `gh pr merge --squash` | `E_GH` | squash 固定 |
| `worktree` | 移除持有该分支的 worktree | `E_GIT` | 主工作区不可 remove → 跳过并继续 |
| `fetch` | 主工作区 `fetch origin` | `E_GIT` | 只更新远端引用 |
| `ff` | `merge --ff-only origin/main` | `E_GIT` | 不在 main：干净→先 checkout；脏→跳过快进并给提示 |
| `branch` | `branch -D` | `E_BRANCH_UNMERGED` / `E_GIT` | 已不存在 / 仍被检出都跳过并说明 |

### CI 判定口径（`judgeChecksValue` / `judgeGhChecks` / `readChecksFile`）

- 数组：空数组 = 没有 checks（跳过门槛）；每个 item 取 `bucket` 或 `state` 小写后比对；
  - 放行：`pass` `passing` `skipping` `skipped` `success` `successful`
  - 阻塞：`fail` `failure` `failing` `cancel` `canceled` `cancelled` `pending` `queued` `in_progress` `timed_out` `action_required` `startup_failure` `error`
  - **未知状态按阻塞**（判定不出来时不静默放行）
- 对象：`{state}`，`success` 及其放行同义词算通过，其余算失败
- 其它形状：`checks 数据无法判定` → 失败（`E_CI`）
- `gh` 退出码 0 但无输出 → 视为"该 PR 没有配置 checks"，跳过门槛（与参考脚本一致）
- `--checks-file` 不可读 / 非 JSON → `E_CI`，不退化成通过

### 三个开关的边界

| 开关 | 作用 | 不做什么 |
|---|---|---|
| `--check-only` | 跑到 CI 门槛为止，不合并不清理 | 不写任何东西（除闸门的跳过审计） |
| `--checks-file <f>` | 用本地 JSON 代替 `gh pr checks`（自测 / 离线） | 不改变闸门 |
| `--force` | 跳过 CI（连 gh 都不发，步骤标「跳过」而非「通过」） | **不能绕过闸门**（闸门在 CI 之前，顺序即保证）；不写跳过审计；不能替代 `--no-review` |

### 失败语义

任一步失败即停在该步，`steps` 保留此前成功的每一步。**不做回滚**——合并已在服务端发生，回滚比如实报告更危险。

## 高风险策略（`lib/policy.mjs`）

```js
mergePolicy({ highRiskAppend })  // → { patterns, hit(files, changedLines, {diff}) }
```

- **默认清单恒生效**（`DEFAULT_HIGH_RISK`，14 条）：`.github/**`、`scripts/pipeline/**`、`AGENTS.md`、`docs/pipeline/**`、`**/.gitignore`、`.dsh/profiles/**`、`.dsh/**`、`**/.env*`、`**/*.pem`、`**/*.key`、`**/*.p12`、`**/deploy.sh`、`**/rollback.sh`、`**/package.json`（**仅当依赖段变更时**）；
- 仓库配置的 `highRisk` 是**追加**（同 glob 时以追加的 `reason` 为准），不能替换默认；
- `changedLines > 400` 也命中（`变更 N 行（不含测试文件），超过 400 行上限`）；`changedLines` 由 `bin/cli.mjs` 的 `countChangedLines(diff)` 按 `diff --git` 头分段统计，测试文件（`__tests__/`、`test(s)/` 目录、`.test.`/`.spec.` 源码）的增删行只计入 `testLines`，上限判定用 `production`；行数拆分以 `policy.changedLines: { total, production, testLines }` 落盘；
- glob 只实现 `**`（跨目录）、`*`（单层）、`?`（单字符）；路径先 `normalizePath`（反斜杠转 `/`、去 `./`、合并 `//`），否则同一路径换个写法就能绕过；
- `dependencyChange` 用正则判断 diff 里是否增删了 `"dependencies"` / `"devDependencies"` / `"optionalDependencies"` 段。

`record` 子命令负责**计算** `policy` 并写进记录；`gate` 只**读取** `record.policy.hit`。这是两段式：策略算不出来时 `record` 直接退 2（宁可失败，也不写一条 `policy` 缺失的记录）。

## 依赖

`gate.mjs` → `record.mjs`（常量）。`merge.mjs` → `config` / `gate` / `gh` / `git` / `record`。`policy.mjs` 无依赖（纯函数）。

## 修改本模块的注意事项

1. 改判定顺序前先想清楚错误码语义（审计要能复盘"为什么被拒"）。
2. 不要给 `merge` 加合并方式参数（`gh.mjs` 的 `MERGE_STRATEGY` 固定 `squash` 是刻意的）。
3. 不要把 CI 判断挪到闸门之前（`--force` 绕不过闸门靠的就是顺序）。
4. 主工作区判定用 `git worktree list --porcelain` 的**首条**（git 保证主工作区在最前），不要按"哪个 worktree 检出 main"反查。
5. 删分支时不要把 `failed` 一律当错误：`not found` / `checked out` / `not fully merged` 是三种不同语义，代码里分别处理并有测试。

## 相关测试

`test/gate.test.mjs`、`test/merge.test.mjs`、`test/policy.test.mjs`、`test/contract.test.mjs`（真实子进程 + 假 gh/git）。
