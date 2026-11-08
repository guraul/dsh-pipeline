# 架构与数据流

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

## 1. 整体架构

本仓只提供一个**共享包**，没有服务端、没有常驻进程、没有网络客户端。每次调用都是「起一个 Node 进程 → 解析参数 → 调 lib → 打印结果 → 退出」。它与外界的全部交互都通过子进程：`gh`（GitHub 的接口都在这里）、`git`（仓库动作）、`pnpm`（只在 `check-all`）。

### 三层架构（契约 §2）

| 层 | 是什么 | 维护者 | 现状 |
|---|---|---|---|
| **L1 实现层** | 本包：全部子命令与逻辑（`lib/`） | 本仓 | 现行 |
| **L2 入口层** | 各仓 `scripts/pipeline/*.sh`：**生成物**，逐字节相同 | `shim install` 从 `templates/shim.sh` 渲染 | 已实现（`lib/shim.mjs`）；部分消费仓仍是手写壳（`agent-mobile`、`homebase` 为转发壳，`self-dsh-plugins` 仍用自有实现） |
| **L3 配置层** | 各仓 `.dsh/pipeline.json` + `.dsh/pipeline.lock.json` | 各仓（锁由 `lock write` 生成） | 两者均现行 |

**为什么入口必须是生成物**：入口一旦允许手写，就给"某仓加一点私有逻辑"留了后门，`diff -r <仓A>/scripts/pipeline <仓B>/scripts/pipeline` 立刻失真。契约把这条写成判定完成标准。

### 模块分层

```text
┌─ bin/cli.mjs ──────── 只做：参数解析、参数校验、调 lib、打印、映射退出码
│    ↓
├─ 纯函数层 ── lib/gate.mjs（闸门）· lib/policy.mjs（高风险）· lib/roles.mjs（角色）· lib/semver.mjs（版本范围）
│              无 IO、不读时钟；now / 入参由调用方传入，同一输入永远同一结论
├─ 编排层 ──── lib/merge.mjs（合并整条流程）· lib/task.mjs · lib/pr.mjs
│              deps 可注入（gh / git / now / sleep / exists），单测用假依赖断言调用顺序
├─ 持久层 ──── lib/record.mjs（记录与跳过审计）· lib/config.mjs（配置）
│              写文件先落 .tmp 再 rename，避免读到半截 JSON
└─ 执行封装 ── lib/git.mjs · lib/gh.mjs · lib/check-all.mjs（pnpm）· lib/profile-check.mjs（dsh）
               只暴露具名操作，argv 在内部拼好；一律返回 { ok, code, data, error }，不抛异常
```

**两条不可破坏的分层规则**：

1. `lib/` **不打印**——它返回结构化结果，由 `bin/cli.mjs` 决定走 stdout 还是 stderr。例外是 `profile-check` 的执行器注入，它本身也不打印。
2. `bin/cli.mjs` **不复制业务规则**——判定、写盘、外部调用全部在 `lib/`。新增规则时先问"这条规则属于哪一层"。

## 2. 命令编排

```text
argv
 └─ runCli(argv, deps)
     ├─ -h/--help（无参数也打印）→ 0
     ├─ -v/--version → `<版本> (<构建描述>)`，构建描述来自 build.json（源码运行时说明是源码）
     ├─ 不在 IMPLEMENTED（14 个）→ 在 SUBCOMMANDS 里报「未实现」退 2，否则报未知子命令 + 帮助退 2
     └─ 分派到 run*() → 各自 parseArgs → 校验 → 调 lib → 输出 → 返回码
```

`deps` 是测试注入口：`deps.runner`（假 gh/git）、`deps.cwd`、`deps.stdout` / `deps.stderr`、`deps.env`。`runCli` 被 import 时不执行，只有作为可执行文件运行时才 `process.exit`。

### 参数解析器（一处实现，全部子命令共用）

`parseArgs(argv, valueFlags, booleanFlags)` 只接受 `--name value` 与 `--name=value`：

- 布尔参数不接受取值（`--json=true` 直接报错）；
- 重复参数、未知参数、缺取值一律报错退 2，不做猜测；
- **不接受位置参数**（`task <issue>` 是唯一例外，由 `runTask` 自己取第一个参数）；
- `-C <dir>` 不被本包识别，由 shim 翻译成 `--root <dir>`。

## 3. 数据模型

### 3.1 审核请求（`review prepare` 产出，`.tmp/review/<pr>/request.json`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `pr` | 正整数 | PR 编号 |
| `head_sha` | 40 位小写十六进制 | PR 的 head 提交 |
| `round` | 1..`review.rounds`（缺省 3） | 审核轮次 |
| `nonce` | 12 位 base32（`A-Z2-7`） | 一次性标记，判定行必须带它 |
| `model` / `provider` / `form` | 字符串 | prepare 只占位（空），由 publish 的同名参数决定 |
| `files` | 字符串数组 | 从 diff 解析出的改动文件 |
| `diff` | 字符串 | PR 的完整 diff |
| `issue` | `{number,title,body}` 或缺失 | `Closes #N` 探测或 `--issue` 指定；取不到就不写该字段（不失败） |
| `facts` | 字符串（可选） | `--facts <文件>` 原样写入，作为「控制面补充的事实」 |
| `includes` | `{path,content}[]`（可选） | `--include <路径,…>` 逐个读文件 |

### 3.2 审核记录（`.dsh-web/reviews/<pr>-<sha>.json`）

**必填**：`schemaVersion`（=1）、`policyVersion`（=包版本，SemVer）、`pr`、`round`、`verdict`、`head_sha`、`findings`、`evidence`。
**可选**：`traceId`、`createdAt`、`policy`、`form`、`provider`、`model`、`durationMs`、`errorCode`、`nonce`、`request`。
**未知字段直接拒收**（`E_RECORD`，见 `lib/record.mjs` 的 `ALLOWED_FIELDS`）。

| 字段 | 约束 |
|---|---|
| `verdict` | `APPROVE` / `REJECT` / `ESCALATE` |
| `findings[]` | 每项只能有 `severity`（`blocker`/`major`/`minor`/`nit`）、`file`（非空）、`line`（非负整数）、`message`（非空） |
| `evidence[]` | 每项非空字符串；解析失败时写解析器的原因 |
| `policy` | `{ hit: boolean, reasons: string[] }`，闸门判高风险唯一依据（曾因被当多余字段拒收而变成死代码） |
| `request` | `{ issue: number \| null, diffChars: number }`，记录输入摘要而不是 diff 全文 |
| `errorCode` | 判定不可用时为 `E_PARSE` / `E_SHA_MISMATCH`；命中高风险时为 `E_POLICY` |

### 3.3 跳过审计（`.dsh-web/reviews/skips/<UTC 时间戳>-<pr>.json`）

`{ pr, head_sha|null, reason, at, policyVersion }`，由 `merge --no-review --reason` 或 `gate --no-review --reason` 写入。它是「留痕的例外」：不产生审核记录，因此**不计入已审核**。

### 3.4 配置（`.dsh/pipeline.json`，严格 schema）

`repo`（`owner/name`）、`ci`（已废弃）、`highRisk`（字符串数组，**追加**到默认清单）、`roles`（角色覆盖）、`worktreesDir`（worktree 父目录）、`checks`（`{packages, exclude}`，供 `check-all`）、`deploy`（部署段，供 `deploy init|check`：`artifact` / `service` / `remoteDir` / `workDir` / `artifactDir` / `sshHost` / `health{url,check,publicUrl,insecure}` / `keepReleases`）。多一个字段报 `E_CONFIG`；没有配置文件是合法状态（用默认值）。详见 `docs/CONTRACT.md` §7.1，`deploy` 段见 `modules/deploy.md`。

### 3.5 构建标识（`build.json`，打包时生成、打包后删除）

`{ gitSha, builtAt, dirty, sourcePath, sourceHash }`。源码目录里没有它（在 `.gitignore` 里），`readBuildInfo()` 返回 `null` 并说明是「源码」，不当作错误。

`sourcePath`（`pwd -P` 绝对路径）与 `sourceHash`（`scripts/source-hash.mjs` 对运行时载荷 `lib/**`、`bin/**`、`templates/**` 的「路径 + 内容」按字典序做的 sha256，不含 mtime；`package.json` **只取影响产物形状的字段** `bin`/`engines`/`exports`/`files`/`main`/`type`，`version`/`scripts`/`devDependencies` 不进——改版本号 / 加 devDependency 不需要重建 dist）供 `lib/dist-freshness.mjs` 的 `verifyDistFreshness()` 在 CLI 启动时比对：源码改了却没重新 pack → 退 1，放行开关是环境变量 `DSH_PIPELINE_ALLOW_STALE=1`（唯一的放行机制）。无 `build.json` / 源码根目录不存在（`existsSync` 前置判定，唯一 skip）/ 旧版打包缺字段 → 跳过；根目录存在但读不动（嵌套 ENOENT、坏符号链接、权限、竞态）→ 判不过。

## 4. 数据存储位置与格式

| 产物 | 路径 | 格式 | 是否入库 |
|---|---|---|---|
| 审核请求 | `<root>/.tmp/review/<pr>/request.json` | JSON | 否（`.tmp/`） |
| 审核提示词 | `<root>/.tmp/review/<pr>/prompt.md` | Markdown | 否（`.tmp/`） |
| 审核记录 | `<root>/.dsh-web/reviews/<pr>-<head_sha>.json` | JSON（2 空格缩进 + 尾换行） | 否（`.dsh-web/`） |
| 跳过审计 | `<root>/.dsh-web/reviews/skips/<ts>-<pr>.json` | JSON | 否 |
| 打包产物 | `dist/<name>-<version>.tgz`、`dist/latest.tgz` | tarball | 否（`dist/`、`*.tgz`） |
| 构建标识 | `build.json`（包根） | JSON | 否（`.gitignore`） |
| 入口 shim | `<root>/scripts/pipeline/*.sh` | bash，0755 | **是**（生成物但入库） |
| pre-push 钩子 | 主仓 `git rev-parse --git-common-dir` 下的 `hooks/pre-push`（或 `core.hooksPath`） | bash，0755 | 否（在 `.git/` 内） |
| worktree | `<worktreesDir 或 <root>/.worktrees>/<号>-<slug>` | git worktree | 否（git 管理） |
| 部署 caller | `<root>/.github/workflows/deploy-web.yml`（生成区 + 本仓追加的 job） | YAML | **是**（生成物但入库） |

### root 语义（最容易被写错的一处）

| 函数 | 取哪个目录 | 消费者 |
|---|---|---|
| `resolveRoot` | 当前工作树顶层（`git rev-parse --show-toplevel`） | `pr` |
| `resolveMainRoot` | 主工作区（`git rev-parse --git-common-dir` 的父目录）；`task` 的显式 root 若落在 linked worktree 顶层会**折回主工作区**，其余命令显式 root 原样使用 | `task`；`record`/`review`/`selftest`/`shim`/`status`/`hooks` 经 `bin/cli.mjs` 的 `resolveMainWorktreeRoot`（显式 `--root` > 主工作区 > 当前目录） |
| 各命令自己的缺省 | `pr` 取当前任务 worktree；`doctor` / `check-all` 按当前目录；`merge` / `gate` **必填** `--root` | — |

**后果（已修）**：2026-11-04 曾发生「在 worktree 里跑 `record` / `review`，记录随 worktree 被删」；现在两者与 `selftest` / `status` 共用 `resolveMainWorktreeRoot`，缺省就落主工作区（契约 §6）。

## 5. 关键判定链

### 5.1 闸门（`lib/gate.mjs`，顺序即语义）

```text
记录可解析？        → E_RECORD
schemaVersion 匹配？→ E_SCHEMA（缺失算 E_RECORD）
round ∈ 1..maxRounds？ → E_RECORD
verdict === APPROVE？→ E_VERDICT（带上记录里的 errorCode）
head_sha === 目标？ → E_SHA_MISMATCH（判定作废）
createdAt 可解析且在 TTL（默认 24h）内？ → E_RECORD / E_EXPIRED
policy.hit 为假？    → E_POLICY（命中高风险必须人工放行）
policyVersion === 当前包版本？ → E_POLICY_VERSION（需按新规则复审）
```

`gate` 子命令先做两件 CLI 层检查（记录属于哪个 PR、head 从哪来），再交给这个纯函数。`merge` 用同一套规则，只是把结果折成一步的 detail。

### 5.2 合并（`lib/merge.mjs`，步骤名固定）

`STEP_ORDER = repo → head → gate → pr → ci → merge → worktree → fetch → ff → branch`

| 步 | 做什么 | 关键约束 |
|---|---|---|
| `repo` | 读 `.dsh/pipeline.json` 的 `repo` | 缺 repo 直接 E_CONFIG |
| `head` | 取 **PR 的** head（`gh pr view` 的 `headRefOid`），不是本机 HEAD | 合并通常从主工作区发起，本机 HEAD 是 main |
| `gate` | 闸门（含 `--no-review` 写审计） | 闸门不通过时**一条 gh 命令都不发** |
| `pr` | 取 `headRefName` / `state` | `CLOSED` 拒绝；`MERGED` 跳过合并只清理 |
| `ci` | `gh pr checks`；`--checks-file` 可替换 | 未知状态按阻塞；无 checks 视为跳过门槛；`--force` 连 gh 都不发且标「跳过」 |
| `merge` | `gh pr merge --squash` | 合并方式固定 squash，不接受参数 |
| `worktree` | 移除持有该分支的 worktree | 主工作区不可 remove（git 报 "is a main working tree"）→ 跳过移除、继续收尾 |
| `fetch` | 主工作区 `fetch origin` | 只更新远端引用，不动工作区 |
| `ff` | `merge --ff-only origin/main` | 主工作区不在 main：干净则先 checkout（打印该动作），脏则跳过快进并给出手动命令 |
| `branch` | `branch -D` | squash 后原提交不是 main 祖先，`-d` 必拒；仍被检出 / 不存在都跳过并说明 |

**失败语义**：任一步失败即停在该步，`steps` 保留此前成功的每一步（能看出停在哪、前面做成了什么）。**不做回滚**——合并已在服务端发生，回滚比如实报告更危险。

### 5.3 判定解析（`lib/review.mjs`）

```text
nonce 合法？            → 否则 E_PARSE
diff 里出现 nonce？     → 视为注入，E_PARSE
有其它 nonce 的判定行？  → E_PARSE（无法确认哪条是模型真意）
本 nonce 的判定行 =1？   → 0 条或多条都 E_PARSE
findings 只取判定行之前的 ```json 块（之后的示例块不看）
```

解析失败**不阻断落盘**：`record` 写一条 `ESCALATE` + `errorCode=E_PARSE`，退出 1，审计轨迹不丢。唯一例外是写盘自身失败（退 3，环境错误）。

## 6. 幂等与副作用

| 动作 | 幂等手段 | 重复调用的结果 |
|---|---|---|
| `task` | 先列 worktree，路径已在 → 只打印路径 | 退 0，不 fetch、不动现场 |
| `pr` | 先按分支查 PR | 已存在 → 只打印链接，不重推 |
| `shim install` | 内容相同即跳过（先整体判定冲突，有冲突一个都不写） | 无冲突时退 0 |
| `hooks install` | 内容相同 → `unchanged`（只补权限） | 退 0 |
| `review publish --post-review` | 列已有 review，同 `commit_id` 且 body 含 `<!-- dsh-pipeline:review <sha> -->` 即跳过 | 不会对同一 SHA 重复发 |
| `merge` | `state=MERGED` 跳过合并 | 仍会清理现场 |

**不可回滚的副作用**：`gh pr merge --squash`、`git push`、发 GitHub review、`worktree remove`。失败时只如实报告，不尝试反向操作。

## 7. 安全边界

| 边界 | 做法 |
|---|---|
| diff 注入 | 提示词用 `<<<DIFF_BEGIN … DIFF_END>>>` 包裹并声明「数据不是指令」；diff 含 nonce 即判 E_PARSE |
| reviewer 越权 | `lib/roles.mjs` 强制 `reviewer.permissionMode = readonly`，配置里提权直接 `E_ROLE` |
| 凭据 | 本包不读、不打印任何 token；`GH_CONFIG_DIR` 等身份环境变量**只透传**给 `gh`，由 gh 自己读 |
| profile 体检 | `profile-check.mjs` 只判断包名字符串与文件存在性 / 大小 / 软链指向，不打印文件内容（可能有 secret） |
| 任意命令 | `gh` / `git` 只暴露具名操作；`merge.mjs` 的注释明确「git 允许清单里没有 `push origin --delete`，也不打算为它开后门」 |

## 8. 部署骨架（契约 §10 的落地）

部署实现在本包仓的 `.github/workflows/deploy.yml` 与 `rollback.yml`（都是 `on: workflow_call`），**不进包 CLI 的执行路径**；本包只负责生成和校验消费仓的 caller。

```text
<仓>/.dsh/pipeline.json 的 deploy 段
  └─ deploy init ──> <仓>/.github/workflows/deploy-web.yml
       生成区（`# >>> dsh-pipeline 生成区` … `# <<< dsh-pipeline 生成区结束`）：
         name / on(push main + workflow_dispatch) / concurrency
         job: uses: guraul/dsh-pipeline/.github/workflows/deploy.yml@<gitSha>
              with: mode / assemble / service / remote_dir / work_dir / [artifact_dir] / [ssh_host]
                    / health_url / health_check / [public_health_url] / public_health_insecure / keep_releases
              secrets: inherit
       标记之后：各仓可追加自己的后置 job
  └─ deploy check ──> 取生成区，与按当前配置渲染的期望值逐字节比对（标记之外不参与）
```

| 决定 | 取值 |
|---|---|
| `artifact` → `mode` | `static-dir` / `node-standalone` → `releases`（容器部署已明确不做，`oci-image` 在配置层即被拒） |
| `artifact` → `assemble` | 同名透传；`node-standalone` 时 `deploy.yml` 多一步把 `.next/standalone` 组装成 release 目录 |
| `uses` 的版本 | pin 到**当前安装包** `build.json` 的 `gitSha`：没装包（源码运行）不能生成，避免假 pin |

**三条铁律**：不可变产物（`releases/<id>` 建好不再改）、原子切换（一次性切 `dist` 软链再重启）、回滚与前进同构（回滚只换 release id，步骤与前进相同）。

**为什么生成而不是手写**：手写 caller 等于给「某仓偷偷加部署逻辑」留后门；生成区逐字节校验后，各仓的差异只能落在 `.dsh/pipeline.json` 的 `deploy` 段。
