# 数据查询指南

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

本包不连接任何数据库，全部数据都是**仓库内的 JSON 文件**。所有路径都相对「root」，而 root 有两套语义（见下），查数据前先确认你要的是哪一份。

## 1. 数据实体清单

| 实体 | 存储位置 | 写入者 | 读取者 | 入库 |
|---|---|---|---|---|
| 审核请求 | `<root>/.tmp/review/<pr>/request.json` | `review prepare` | `record`、`review prompt`、`review publish` | 否 |
| 审核提示词 | `<root>/.tmp/review/<pr>/prompt.md`（`--out` 指定时） | `review prompt --out` | 人 / reviewer | 否 |
| reviewer 响应 | 由调用方决定（常见 `.tmp/review/<pr>/res.txt` 或 `response.txt`） | 人 / 子代理 | `record --response`、`review publish --response` | 否 |
| **审核记录** | `<root>/.dsh-web/reviews/<pr>-<head_sha>.json` | `record`、`review publish` | `gate`、`merge`、`status`、`review publish --post-review`（读回） | 否 |
| 分片记录 | `<root>/.dsh-web/reviews/<name>`（`record --name` 自定义） | `record --name` | 调用方 | 否 |
| 跳过审计 | `<root>/.dsh-web/reviews/skips/<ts>-<pr>.json` | `gate` / `merge --no-review --reason` | 人（追溯） | 否 |
| 仓库配置 | `<root>/.dsh/pipeline.json` | 人 | 全部子命令（`loadConfig`） | **是** |
| 构建标识 | `<包>/build.json` | `scripts/pack.sh`（打包时写，打包后删） | `doctor`、`selftest --repos`、`--version` | 否 |
| 打包产物 | `dist/<name>-<ver>.tgz`、`dist/latest.tgz` | `scripts/pack.sh` | 消费仓 `file:` 依赖 | 否 |
| 入口 shim | `<root>/scripts/pipeline/{pipeline,new-task,open-pr,merge-pr,review,status}.sh` | `shim install` | 人 / CI | **是** |
| 部署 caller | `<root>/.github/workflows/deploy-web.yml`（生成区 + 标记之后本仓追加的 job） | `deploy init --write` | `deploy check`、GitHub Actions | **是** |
| 回滚 caller | `<root>/.github/workflows/rollback-web.yml`（同上；`workflow_dispatch` 触发） | `deploy init --write --rollback`（文件已存在时 `--write` 也会刷新） | `deploy check`、GitHub Actions | **是** |
| pre-push 钩子 | 主仓 `--git-common-dir` 下 `hooks/pre-push`（或 `core.hooksPath` 指向处） | `hooks install` | git | 否 |
| worktree | `<worktreesDir>` 或 `<root>/.worktrees` 下的 `<号>-<slug>` | `task` | 开发 | 否 |

### root 该取哪个

| 命令 | 缺省 root | 查数据时的含义 |
|---|---|---|
| `gate` / `merge` | **必填 `--root`** | 传主工作区 |
| `record` / `review *` | 显式 `--root` > 主工作区 > 当前目录（与 status / selftest 同一口径） | 在 worktree 里跑也落主仓，不会被清理删掉 |
| `status` / `selftest` / `shim` / `hooks` | 显式 `--root` > 主工作区 > 当前目录 | 查主仓那一份 |
| `task` | 主工作区（显式 root 若是 linked worktree 顶层会折回主工作区） | — |
| `deploy` | **必填 `--root`** | 生成 / 校验的是被指向那个仓的 caller |
| `pr` | 当前工作树顶层 | — |
| `doctor` / `check-all` | 当前目录 | — |

## 2. 常见查询场景

| 我想查… | 去哪 / 怎么查 |
|---|---|
| 某个 PR 有没有审核记录 | `ls <主工作区>/.dsh-web/reviews/ \| grep '^<pr>-'`；文件名形如 `<pr>-<40位sha>.json` |
| 记录内容（判定、findings、是否命中高风险） | `jq '{verdict,round,head_sha,policy,errorCode}' <记录文件>` |
| 记录是否仍然有效 | 看 `createdAt`（TTL 24h）、`head_sha` 是否等于当前 PR head、`policyVersion` 是否等于当前包版本 |
| 哪些 PR 跳过过审核、为什么 | `ls <主工作区>/.dsh-web/reviews/skips/`，文件里 `reason` 是原话、`at` 是时间 |
| 审核记录总数 / 最近一条 | `dsh-pipeline status --root <主工作区>`（无法解析的记录会单独计数） |
| 某仓配置了什么 | `cat <仓>/.dsh/pipeline.json`；不能确定就 `dsh-pipeline selftest --config --root <仓>` |
| 某仓装的是哪次打包 | `dsh-pipeline doctor --repo <仓1>,<仓2>`（读 `tools/node_modules/dsh-pipeline/build.json` 的 `gitSha`） |
| 当前包的构建标识 | `dsh-pipeline --version`（输出 `<版本> (<gitSha7>[+dirty] <builtAt>)`，源码目录会说明是源码） |
| 请求里都有什么 | `jq 'keys' <root>/.tmp/review/<pr>/request.json`；`nonce` 是 12 位 base32，判定行要靠它 |
| 某次审核的输入摘要 | 记录里的 `request.issue` / `request.diffChars`（**不存 diff 全文**） |
| 某仓入口是否被手改 | `dsh-pipeline shim check --root <仓>`（按当前版本渲染模板后逐字节比对） |
| 某仓 pre-push 钩子是否生效 | `dsh-pipeline hooks check --root <仓>`（比内容，也校验可执行位） |
| 某仓部署 caller 是否被手改 / 配置改了没重生成 | `dsh-pipeline deploy check --root <仓>`（只比生成区，标记之后的追加 job 不参与） |
| 某仓部署配置是什么 | `jq '.deploy' <仓>/.dsh/pipeline.json`（字段含义见 `modules/deploy.md`） |
| 本仓有哪些产物没入库 | `git -C <仓> status --ignored`（`.tmp/`、`.dsh-web/`、`dist/`、`node_modules/`、`build.json`） |

## 3. 数据变更链路

### 3.1 审核记录的来源

```text
gh pr view / gh pr diff
  └─ review prepare ──> .tmp/review/<pr>/request.json（pr, head_sha, round, nonce, files, diff[, issue, facts, includes]）
        └─ reviewer（子代理 / product CLI）产出文本
              └─ record 或 review publish
                    ├─ analyzeVerdict（nonce + 判定行 + SHA）
                    ├─ extractFindings（判定行之前的 ```json 块）
                    ├─ mergePolicy.hit（改动文件 + 变更行数 + diff）
                    └─ writeRecord → .dsh-web/reviews/<pr>-<sha>.json（先写 .tmp 再 rename）
```

判定不可用时的**降级写入**（审计优先于结论）：

| 情况 | 写入的 verdict | 其它字段 | 退出码 |
|---|---|---|---|
| 判定行缺失 / 多条 / 标记不符 / diff 含标记 | `ESCALATE` | `errorCode=E_PARSE`，`findings=[]`，`evidence=[解析器给的原因]`（响应内容不可信，一律不留） | 1 |
| 判定行可解析但 SHA 与请求不符 | `ESCALATE` | `errorCode=E_SHA_MISMATCH`，保留 findings，evidence 追加不匹配原因 | 1 |
| 落盘本身失败 | 不写 | — | 2 |

唯一例外：`record --name <文件名>` 直接把记录写成 `<pr>-<sha>.shard-i-of-n.json`（分片审核），避免"先写规范名再删除"那段"单片判定冒充整份判定"的窗口。

### 3.2 记录的下游消费者

| 消费者 | 读什么 | 用来决定 |
|---|---|---|
| `gate` | `pr`、`head_sha`、`verdict`、`createdAt`、`policy.hit`、`policyVersion`、`schemaVersion`、`round` | 能否作为合并依据 |
| `merge` | 同上（同一套 `evaluateGate`）+ `headRefName`（来自 gh） | 走完闸门 → CI → 合并 |
| `status` | 目录下所有 `*.json`，按时间排序 | 记录总数、最近一条、无法解析的条数 |
| `review publish --post-review` | 刚写下的记录（`verdict`、`findings`、`nonce`） | 组 GitHub review 的 event 与 body |

### 3.3 记录的字段漂移防线

`test/contract-format.test.mjs` 用一份**真实运行产出**的夹具 `test/fixtures/plugin-record.json`（来自插件 `dsh-subagents`）校验 `validateRecord`：一旦包侧字段集合与插件侧不一致（历史事故：`policy` 被当成多余字段拒收，导致 `gate` 里 `record.policy?.hit` 成死代码），该测试立刻红。**不要手改这份夹具**，它必须来自真实响应。

## 4. 数据不入库的保障

`.gitignore` 覆盖：`node_modules/`、`dist/`、`*.tgz`、`.dsh-web/`、`.tmp/`、`build.json`。

`test/gitignore.test.mjs` 用**真实 git** 判定（`git check-ignore --no-index .tmp/review.json`），而不只是匹配文本——模式写错（比如漏斜杠）也该被测出来。

⚠️ 当前 `.gitignore` **没有** `.DS_Store`，所以 `git status` 在本机常年显示一条未跟踪的 `.DS_Store`（见 `CONVENTIONS.md` 已知问题）。
