# 交付契约（CONTRACT）

**版本**：v1.2（2026-11-06）
**适用**：所有接入本包的仓库——`self-dsh-plugins`、`agent-mobile`、`homebase`、`memx`，以及包仓自身。
**地位**：这是唯一的规范来源。各仓文档只写差异与索引，不复述本文件。

## 0.1 怎么读这份文档（重要）

本文件同时描述**现状**与**目标**。每条能力的状态只有两种：

| 标记 | 含义 |
|---|---|
| **现行** | 本仓代码今天就是这样，照它写配置/脚本立刻能跑 |
| **目标（P2/P3）** | 尚未实现；实现合并前**不得**被任何入口 shim 调用，也不得在文档里写成可用 |

**硬规则**：任何「目标」条目在落地前，若有人照着做，必须先看 `§3.3 实现状态`。2026-11-04 的事故就是「文档写了、代码没有」造成的（有人照文档加了字段，三条命令一起失效）。

---

## 1. 目的

让「五个仓的交付流程」成为**同一份实现**：

- 行为只在一个地方定义（本包）；
- 仓库之间的差异**只能由配置数据表达**，不能由代码表达；
- 任何“某仓行为不一样”都能被机器检查出来。

判定完成的唯一标准：

```bash
diff -r <仓A>/scripts/pipeline <仓B>/scripts/pipeline   # 必须为空
```

---

## 2. 三层架构

| 层 | 是什么 | 谁维护 | 状态 |
|---|---|---|---|
| **L1 实现层** | 本包：全部子命令与逻辑 | 本包仓 | 现行 |
| **L2 入口层** | 各仓 `scripts/pipeline/*`：**生成物**，逐字节相同 | 由 `dsh-pipeline shim install` 生成 | **生成能力现行**（§3.2 / §8）；各仓接入未完成——`agent-mobile` / `homebase` 是手写转发壳，`self-dsh-plugins` 仍用自有实现 |
| **L3 配置层** | 各仓 `.dsh/pipeline.json` + `.dsh/pipeline.lock.json` | 各仓（锁由 `lock write` 生成，不手改） | 两者均现行 |

L2 之所以要变成生成物：入口一旦允许手写，就等于给“某仓加一点私有逻辑”留了后门，`diff -r` 立刻失真。

---

## 3. 命令面

### 3.1 各仓入口 → 包子命令（**现行**）

| 入口文件 | 转发到 | 说明 |
|---|---|---|
| `pipeline.sh` | `<子命令>`（原样透传） | 通用入口；等价于直接调包 |
| `new-task.sh` | `task` | 建 worktree + 任务分支 |
| `open-pr.sh` | `pr` | 推送分支并开 PR |
| `merge-pr.sh` | `merge` | 闸门通过后 squash 合并并清理现场 |
| `review.sh` | `review` | `prepare` / `prompt` / `publish` |
| `status.sh` | `status` | 审核记录概况 |

关于 `-C/--root`：包侧只认 `--root <dir>`（`parseArgs` 拒绝非 `--` 形式的位置参数）。**由 shim 负责把 `-C <dir>` 翻译成 `--root <dir>`**，包本身不解析 `-C`。

各子命令的 `--root` 缺省值（**现行**）：`pr` 取当前任务 worktree（提交必须落在被审分支上）；`record` / `review` / `selftest` / `shim` / `hooks` / `status` 缺省定位**主工作区**（同一实现 `resolveMainWorktreeRoot`，见 §6）；`merge` / `gate` **必填** `--root`。`doctor` / `check-all` 按当前目录。

### 3.2 包子命令全集

| 子命令 | 作用 | 状态 |
|---|---|---|
| `task` | 从 issue 建 `task/<号>-<slug>` 分支与 worktree | 现行 |
| `pr` | 推送当前任务分支并创建 PR | 现行 |
| `review prepare` | 读 PR 的 head/diff/issue 正文，写审核请求（含 nonce） | 现行 |
| `review prompt` | 由请求渲染审核提示词 | 现行 |
| `review publish` | 把判定落成记录 | 现行 |
| `review publish --post-review` | 同时把判定发成 GitHub review（幂等）；配置 `review.postReview=true` 等价于每次都带该开关，`review.identity` 决定发送身份 | 现行 |
| `record` | 只落盘判定记录（供外部流程使用） | 现行 |
| `gate` | 审核闸门检查（记录存在性、SHA 绑定、高风险路径） | 现行 |
| `merge` | 闸门通过后 squash 合并 + 清理 worktree/分支 + 快进 main；`--review-record` 是 `--record` 的兼容别名（旧写法，后续将弃用；两者取值不同则报错） | 现行 |
| `status` | 审核记录概况，含仓库概览（root/branch/head/worktrees；git 取不到时该段只提示，不影响退出码） | 现行 |
| `doctor` | 检查仓库装的共享包是否同一构建；`--profile <dir>` 可选：体检 profile 包声明、插件软链有效性、`dsh --dump-config` 可见性（dsh 不可用时跳过）、审核记录目录可写，另含原 review-loop-check.sh 没有的 `cordis.patch.yml` 非空与目录/DSH_HOME 报告两项 | 现行 |
| `selftest` | 一致性自检（见 §9）：`--shims` / `--config` / `--lock` / `--peer` / `--exit-codes` / `--fast` / `--repos` 全部可用 | 现行 |
| `lock write\|check` | 写入 / 核对 `.dsh/pipeline.lock.json`（见 §7.2）；`write` 从装包 `build.json` 取标识，`check` 与 `selftest --lock` 同一实现 | 现行 |
| `check-all` | 按配置逐包跑声明的检查并汇总 | 现行 |
| `shim install\|check` | 生成 / 校验入口 shim | 现行 |
| `hooks install\|check` | 安装 / 校验 pre-push 直推拦截钩子 | 现行 |
| `deploy init\|check` | 生成 / 校验 caller workflow 骨架：`deploy-web.yml`（生成区 = `name` / `on` / `concurrency` + 单 job 的 `uses`+`with`+`secrets`，`with:` 含按 artifact 推导的 `mode` 与 `assemble`）；`--write --rollback` 连带生成 / 更新 `rollback-web.yml`（`workflow_dispatch` + `rollback.yml` 同一 pin，见 §10）。**回滚文件已是生成物时，只跑 `--write` 也会刷新它**（不用每次记着加 `--rollback`）；它是手写文件时跳过并提示（显式 `--rollback` 才拒绝覆盖）。`check` 逐字节比对：部署 caller 必须存在且一致（缺标记退 1），回滚 caller 是生成物才校验——**不存在或手写（缺标记）都跳过并退 0**（手写时 stderr 提示「要接管请删除它再跑 `deploy init --write --rollback`」），因此 CI 不能强制回滚 caller 被接管；标记之后允许各仓追加自己的后置 job | **现行** |

新增子命令属于**契约变更**，必须同时更新本文件与 §3.3。

### 3.3 实现状态（v1.2 校正，2026-11-06）

**已实现**：`task` / `pr` / `review prepare|prompt|publish`（含 `--post-review`）/ `record` / `gate` / `merge` / `status` / `doctor`（含 `--profile`）/ `selftest`（`--shims` / `--config` / `--lock` / `--peer` / `--exit-codes` / `--fast` / `--repos`）/ `lock write|check` / `shim install|check` / `hooks install|check` / `check-all` / `deploy init|check`（`artifact` 支持 `static-dir` 与 `node-standalone`）。

**配置字段（已进 schema）**：`worktreesDir` 由 `task` 消费——缺省读配置、`--worktrees-dir` 优先；`checks` 由 `check-all` 消费——`--packages` 优先，其次 `checks.packages`（按给定顺序），再否则自动发现并按 `checks.exclude` 过滤；`deploy` 由 `deploy init|check` 消费（字段见 §7.1，部署行为见 §10）；`review` 段的 `tier` / `postReview` / `identity` / `rounds` 全部进 schema 并被消费（见 §7.3）。

**目标**：无。§3.2 / §4 / §5 / §6 / §7 / §9 / §10 / §11 的能力已全部落地；容器部署（原 `oci-image` 占位）已明确不做，见 §10。

硬规则：目标条目在实现合并前**不得**被入口 shim 调用，也不得在文档里写成可用；§9 的门禁项现已全部落地，CI 可以直接引用。

---

## 4. 退出码

| 码 | 含义 | 范围 |
|---|---|---|
| 0 | 成功 | 全部命令；`record` / `review publish` 在 `APPROVE` 或带 `--legacy-exit-codes` 的 `REJECT` 下 |
| 1 | **业务拒绝** | `gate` / `merge`（闸门拒绝、CI 未过）；`record` / `review publish`（判定 `REJECT`，或判定不可用时的兜底 `ESCALATE`） |
| 2 | **用法 / 配置错误** | 全部命令（入参、配置读取与校验、`--checks-file` 等） |
| 3 | **环境错误** | 全部命令的 gh / git / 写盘 / 读盘失败与未捕获异常（`merge`、`gate`、`task`、`pr`、`status`、`lock`、`record`、`shim`、`hooks`、`check-all`、`selftest --lock` 都按此） |

**`record` / `review publish` 的判定与退出码**：`REJECT` → **1**（记录照常落盘——落盘成功不代表判定通过）；判定不可用（解析失败 / 提交不匹配）→ 兜底 `ESCALATE` → 1；`APPROVE` → 0。

**迁移开关 `--legacy-exit-codes`（现行，切换完成后删除）**：带它时 `REJECT` 退回 **0**，给还没改 `set -e` 脚本的调用方留过渡期；其余判定不变。

**例外：`--post-review`** 的退出码反映「review 是否发出」（成功 0 / 配置错误 2 / gh 失败 3），不反映判定——`REJECT` 的 review 照常发出，判定看记录。**记录没写成时不发送**：前置校验失败退 2、写盘失败退 3，两种都不发 review——没有记录就没有可追溯的判定。

**例外：dist 新鲜度校验（`lib/dist-freshness.mjs`，2026-11-07 起）**：CLI 启动时比对装包 `build.json.sourceHash` 与源码重算值，不一致（源码改了却没重新 `pnpm pack`）→ stderr 打印原因并**退 1**；设 `DSH_PIPELINE_ALLOW_STALE=1` 临时放行。没有 `build.json`（源码运行）、源码 checkout 已删除、旧版打包缺字段 → 静默跳过，不影响任何命令。

硬规则：

1. 入口 shim **不得**改写退出码，只透传；
2. 不得用 `1` 表示用法错误，也不得用 `2` 表示业务拒绝；
3. 迁移期用 `--legacy-exit-codes` 保持旧行为（`REJECT` 退 0），切换完成后删除该开关。

---

## 5. 输出格式

| 类型 | 现行 | 目标 |
|---|---|---|
| 数据行 | stdout，无前缀 | 同 |
| 状态行 | `<阶段>: <状态>`，中文（阶段：`审核` / `合并` / `构建`；其余命令仍用子命令前缀，见下） | 同 |
| 错误行 | stderr，`dsh-pipeline: <子命令>: <错误码>: <说明>` | 同 |
| 机器模式 | `--json` 输出一个 JSON 对象 | 同 |

**阶段的划分**（契约 §5 的状态行）：`审核` = `review prepare` / `review prompt` / `review publish` / `record` / `gate`；`合并` = `merge`（其进度行 `repo:` / `head:` / `gate:` / `ci:` / `merge:` / `worktree:` / `fetch:` / `ff:` / `branch:` 本身就是阶段式）；`构建` = `deploy init` / `deploy check`。其余命令（`task` / `pr` / `shim` / `hooks` / `lock` / `selftest` / `check-all` / `doctor` / `status`）不在这三个阶段里，保留子命令前缀。

**错误码**只有 6 个（`argError` / `errorLine` 两个出口统一渲染，见 §5 的错误行）：

| 码 | 含义 |
|---|---|
| `E_USAGE` | 参数 / 用法错误（缺必填、未知选项、取值非法） |
| `E_CONFIG` | 配置读取或校验失败；`review.identity.account` 与实际登录不符也归此类 |
| `E_RECORD` | 审核记录缺失 / 不可用 |
| `E_PARSE` | 判定解析失败（nonce / SHA / 格式） |
| `E_ENV` | 外部命令或环境失败（gh / git / pnpm / 目录不可读） |
| `E_STATE` | 状态不匹配（PR 号、head、文件缺标记、PR 无 headRefOid） |

警告行（`警告:` / `提示:`）**不带**错误码——它们不是错误。

---

## 6. 落盘路径

| 产物 | 路径 | 状态 |
|---|---|---|
| 审核请求 | `<root>/.tmp/review/<pr>/request.json` | 现行 |
| 审核提示词 | `<root>/.tmp/review/<pr>/prompt.md` | 现行 |
| 审核记录 | `<root>/.dsh-web/reviews/<pr>-<head_sha>.json` | 现行 |
| 跳过审计 | `<root>/.dsh-web/reviews/skips/<ts>-<pr>.json` | 现行 |

**现行**：产生上述产物的命令，`<root>` 缺省口径统一——显式 `--root` 优先；否则定位**主工作区**（`git rev-parse --git-common-dir` 的父目录，即 `git worktree list --porcelain` 首条）；git 定位不到（非仓库 / git 失败）退回当前目录。

这条口径就是为 2026-11-04 那次事故设的：在 task worktree 里跑 `record` / `review`，记录会落进 worktree，`merge` 清理时连同 worktree 一起删掉，事后查不到「审过没有」。现在 `record` / `review prepare|publish` / `selftest` / `shim` / `hooks` / `status` 共用同一个 `resolveMainWorktreeRoot`。

**全部产物不入库**：`.gitignore` 覆盖 `.tmp/` 与 `.dsh-web/`。

---

## 7. 配置

### 7.1 `.dsh/pipeline.json`（入库；**严格 schema**）

**现行字段**（`lib/config.mjs` 的 `CONFIG_FIELDS`，多一个字段就报 `E_CONFIG`）：

```jsonc
{
  "repo": "guraul/<name>",        // 可选；缺省 null（下游命令报“无法确定仓库”）
  "ci": [],                       // 可选；**已废弃**，CI 判定改走 gh pr checks
  "highRisk": ["…"],              // 可选；缺省 []；**追加**语义——默认清单恒生效，配置只做追加
  "roles": {},                    // 可选；review prompt 的角色定义
  "worktreesDir": "~/workspace/<name>-worktrees",  // 可选；缺省 <主工作区>/.worktrees
  "checks": { "packages": ["pkg-a"], "exclude": ["tools"] },  // 可选；缺省 null：check-all 的显式包清单与自动发现排除项
  "review": { "tier": "inline", "postReview": true,
              "identity": { "ghConfigDir": "~/.config/gh-reviewer", "account": "guraul-review" },
              "rounds": 3 },  // 可选；见 §7.3（tier / postReview / identity / rounds 均已实现）
  "deploy": { … }                 // 可选；缺省 null：deploy init|check 消费，字段见下方「现行字段：deploy 段」
}
```

**现行字段：`review` 段**（由 `review prepare` / `review prompt` / `review publish` / `record` / `gate` 消费）：

```jsonc
{
  "review": {
    "tier": "tools",                  // 可选；inline | tools，缺省 tools（见 §7.3）
    "postReview": true,               // 可选布尔，缺省 false；true = review publish 默认发送（等价每次带 --post-review）
    "identity": {                     // 可选对象；发 review 用的身份
      "ghConfigDir": "~/.config/gh-reviewer", // 可选；展开 ~ 后作为 GH_CONFIG_DIR 传给 gh
      "account": "guraul-review"      // 可选；发请求前用 gh api user 校验登录名，不一致退 2（配置错误，记录已落盘、review 未发出）
    },
    "rounds": 3                       // 可选；1..3 的整数，缺省 3；只能把上限往下收（记录层最大就是 3）
  }
}
```

**现行字段：`deploy` 段**（2026-11-06 起进 schema，由 `deploy init|check` 消费；部署行为见 §10）：

```jsonc
{
  "deploy": {
    "artifact": "static-dir",          // 必填；static-dir / node-standalone 可用
                                       // （node-standalone 由 deploy.yml 的 assemble 步骤组装 release）；
                                       // 容器部署已明确不做（见 §10），oci-image 不是合法值
    "service": "serve-9928",           // 必填非空字符串（systemd 服务名）
    "remoteDir": "/root/project/<app>", // 必填非空字符串（绝对路径，服务器部署根目录）
    "workDir": "app",                  // 必填非空字符串（仓内构建目录；deploy.yml 的 work_dir 是必填 input）
    "artifactDir": "dist",             // 可选字符串（产物目录，相对 workDir）
    "sshHost": "10.0.0.8",             // 可选字符串（SSH 目标主机）
    "health": {                        // 必填对象
      "url": "http://127.0.0.1:9929/", // 必填字符串（健康检查 URL）
      "check": "http",                 // 可选；http | ssh，缺省 http
      "publicUrl": "https://…",        // 可选（对外链路检查）
      "insecure": true                 // 可选布尔，缺省 true（允许自签证书）
    },
    "qualityCmd": "pnpm run lint && pnpm test", // 可选字符串（渲染成 with.quality_cmd；缺省用共享 workflow 默认）
    "buildCmd": "pnpm run build",      // 可选字符串（渲染成 with.build_cmd；缺省用共享 workflow 默认）
    "paths": ["packages/web/**", "scripts/**"], // 可选字符串数组（渲染成 on.push.paths；缺省=任何 push 都部署）
    "linkPaths": ["data=../../data"],  // 可选字符串数组，每项「相对路径=目标」含 '='（渲染成 with.link_paths，逗号+空格拼接；切 dist 软链前在 release 内逐对建持久化路径软链；缺省=不建、步骤跳过）
                                       // 路径部分约束：必须相对、不许含 '..' 段、不许含 ','；目标可为相对（**按软链所在目录解析，不是 remote_dir**）或绝对
    "keepReleases": 5                  // 可选整数 1..50，缺省 5
  }
}
```

硬规则：

1. **未声明字段一律报错**（`E_CONFIG`）。新增字段顺序固定：**先改本包 schema → 再改本文件 → 最后改各仓配置**。顺序反了就是 2026-11-04 那次事故；
2. `ci` 已废弃，新配置不要写；
3. 仓库差异只能落在 `repo` / `highRisk` / `roles` / `worktreesDir` / `checks.*` / `deploy.*` / `review.*` 之内；
4. `deploy.paths` 是**非空**数组：写成 `[]` 会被拒（`E_CONFIG`）——空数组等于静默丢掉过滤，想要「任何 push 都部署」就整个省略该字段。
5. `deploy.linkPaths` 的**路径部分**是相对路径、不许含 `..` 段、不许含 `,`：它会拼进远端 `rm -f`/`ln -s` 的路径，`../..` 能建到 release 之外（越界由执行前的 `realpath` 断言拦下，属双保险）。要外置状态就写 `data=../../shared/data` 这类平级路径。
6. `deploy.linkPaths` 的**目标必须已存在**（fail-closed）：`ln -s` 不要求目标存在，会静默建出悬空软链，而健康检查打的是**旧进程**，部署会绿着过去、把问题推迟到切换时才炸（起点是空库最危险）。因此远端建链前会解析目标并 `[ -e ]` 断言，不存在即 `::error::` 退 1。持久化目录要先准备好，不能指望部署替你创建。

> 反面教材：2026-11-04 有人往本文件加了 `doctorRepos`，包判未知字段，`task`/`pr`/`merge` 三条同时失效，CI 不覆盖这类错误。

### 7.2 `.dsh/pipeline.lock.json`（**现行**）

```json
{ "expect": "<sha7> <builtAt>" }
```

**谁写**：`dsh-pipeline lock write --root <仓>`——从该仓装包位置（`tools/node_modules/dsh-pipeline/build.json`）读出 `gitSha` / `builtAt` 写进锁；再次运行即「刷新锁」。**不手改**：手工编辑会绕过校验，且 `+dirty` 之类的打包态信息不该进锁。

**谁读**：`selftest --lock` 与 `lock check` 是同一份实现（`lib/lock.mjs` 的 `checkLock`），比对的双方是「锁里的 `expect`」与「装包的 `sha7 builtAt`」。

**状态语义**（与 `--config` 的「没有配置是合法状态」对齐）：

| 情形 | 结果 |
|---|---|
| 锁文件不存在 | **跳过**（退 0）：这个仓还没启用锁 |
| 锁文件或装包 `build.json` 读不出来（权限 / IO） | **失败**（退 3，`E_IO`）：环境问题，不是「没启用锁」 |
| 装包目录不存在 | **跳过**（退 0）：还没 install |
| 装了包但没有 `build.json`（旧版本包） | **失败**（退 1）：无法证明与锁一致 |
| 锁与装包不一致 / 锁格式非法（多余字段、`expect` 不是 `<sha7> <构建时间>`） | **失败**（退 1） |
| `lock write\|check` 的 `--root` 不存在或不是目录 | **退 2**（用法/路径错误，不是锁的问题；`selftest --lock` 不校验 root） |

**为什么值得入库**：它把「这个仓装的是哪次打包」变成 review 里能看见的一行。消费仓把 `selftest --lock` 接进 CI 之后，只改依赖不刷新锁就会红（本仓 `ci.yml` 只跑测试，尚未接入）。

### 7.3 审核档位与身份（`review.tier` / `review.identity` / `review.rounds`，**现行**）

审核分两档，由各仓 `.dsh/pipeline.json` 选择；**缺省 `tools`**，与加入档位前的行为一致。

| 档位 | 审核方权限 | 依据 |
|---|---|---|
| `inline` | **没有工具权限**，不能读文件、不能执行命令 | 控制面内联的材料：diff、issue 正文、`request.facts` / `request.includes` |
| `tools`（缺省） | 可读仓库、跑只读命令核验断言 | diff + 自己核验 |

行为：

- `review prepare` 在 `inline` 档**自动**把 `git show --stat <head_sha>` 与 `gh pr checks <pr>` 的结果并进 `request.facts`；两者取不到时写「未取到」，**不阻断 prepare**。调用方另传 `--facts` 时拼接，不覆盖。
- `review prompt` 按档改「输出要求」第 0.1 条：`inline` 明确「没有工具权限，下面的材料就是全部依据」，并写明「只对材料里的必答问题负责，答不了才 `ESCALATE`，其余细节标『未核验』不影响判定」；`tools` 保留原文，要求把实际核验方式写进 `evidence`。两档共用第 4–8 条（`ESCALATE` 判据、建议上限与去向、不重复、APPROVE 不提建议、超限合并）。
- **如实标注**：`tools` 档在 codebuddy 下**不是硬只读**——该产品没有「只读 + 工具」档位，审核方仍可能写入。兜底靠任务书写明边界 + 事后 `git status` + 闸门的 SHA 比对；记录与汇报里**不得**写成「只读审核」。
- 选档看材料能否自证，不按改动大小拍脑袋：纯配置 / 纯文档且 diff 自包含用 `inline`；行为改动、跨文件改动，或 PR 里出现「我跑过 / 我验证过」这类需要复核的断言用 `tools`。
- **身份**：`review.identity.ghConfigDir` 在发 review 前设为 `GH_CONFIG_DIR`（`~` 会展开），命令结束后还原；`review.identity.account` 非空时先用 `gh api user --jq .login` 校验，不一致退 2（`E_CONFIG`）且不发送（记录已落盘）。
- **轮次上限**：`review.rounds`（1..3，缺省 3）同时约束 `record` / `review prepare` / `review publish` 的 `--round`、`review publish` 请求里的 `round`，以及 `gate` 与 `merge` 的轮次判定；超限即「人在环」。**只能收紧不能放宽**——记录层（`lib/record.mjs` 的 `MAX_ROUND`）最大就是 3，写不进去的轮次不该被配置放行。

#### 时限与体量

审核交给外部产品 CLI（形态 B，`product_delegate`）时，单次调用有硬上限，当前是 **600 秒**：默认值在 `dsh-subagents/lib/provider.js` 的 `defaultTimeoutMs`（opencode 侧 300000，配置档用 `timeoutMs` 覆盖，当前配置两条通道都是 600000）。这个上限属于调用方，不是审核方可以自己放宽的东西，所以**任务体量要按它来设计**：

- **只读 diff + 少量只读命令**。一次审核里不要塞「跑全量测试 + 建临时环境 + 多场景试跑」——这些属于编排方的准备动作，不该占用审核预算。
- 预计超过约 10 分钟的核验，由编排方先跑好、把结果放进 `request.facts`（与 `inline` 档给材料的方式一致），或拆成多轮审核；不要指望一次调用跑完长流程。
- **超时不等于模型不可用**。判据是「同一模型小材料正常返回、大材料超时」：命中这一条时按体量拆材料或改走 `request.facts`，不要据此换模型、降级或判定该模型故障。

#### 超时之后必须清理残留进程

调用被判超时**不等于进程已退出**。实测（2026-11-06，issue #82）：超时后 `codebuddy -p` 进程继续存活 10 分钟以上并占着会话，下一次调用排在它后面，于是**必然**一起超时——表现为「连续超时」，容易被误判成模型故障。

**执行主体**：编排方（控制面）。审核方在 `inline` 档没有工具权限，不应也不会执行本节动作。**适用范围**：仅限有 `timeoutMs` 的通道（形态 B）；形态 A（原生 subagent）没有这个上限，不适用本节。

判据与时序（别用固定分钟数一刀切，`timeoutMs` 是可配的）：

1. 判定「本次调用已超时」之后**立即**处理，不要等：此刻造成阻塞的残留进程 `etime` **等于或略大于**超时值，用「≥ 11 分钟」这类固定阈值会把它排除，流程反而卡住。
2. 列候选并连同命令行与运行时长一起打印，人眼确认后再动手：

   ```bash
   pgrep -f "codebuddy -p" | while read p; do
     printf '%s\t%s\t%s\n' "$p" "$(ps -o etime= -p "$p" | tr -d ' ')" "$(ps -o command= -p "$p" | cut -c1-80)"
   done
   ```

   `pgrep -f` 是**子串匹配**，会命中命令行里含该串的其它进程，所以必须打印 `command` 核对；`--prewarm` 的常驻池进程**不得**清理。
3. 清理条件：**父调用已超时**，且该 PID 由那次调用产生（拿任务书里的 `--model` / 提示词片段核对）。历史上遗留的（`etime` 转成秒后 > `timeoutMs/1000 + 60`）一并清掉。
4. `etime` 在 macOS 是 `[[dd-]hh:]mm:ss`，**不能**直接和秒数比较；Linux 的 `ps -o etimes=` 在 macOS 上不可用。转成秒用这段（macOS/Linux 都跑得通）：

   ```bash
   ps -o etime= -p "$PID" | tr -d ' ' | awk -F'[-:]' 'NF<2{exit} { if (NF==4) s=$1*86400+$2*3600+$3*60+$4; else if (NF==3) s=$1*3600+$2*60+$3; else s=$1*60+$2; print s }'
   ```
5. 清理前后都要留痕，字段固定：**PID、`etime`、`command` 前 80 字、kill 时间、复查结果**。留痕落在会话记录里（控制面执行，用户可见）；涉及生产或跨会话时同时写进 `request.facts` 或仓库 `.dsh-web/` 下的日志，便于事后审计。
6. 复查：`kill -9` 后重新 `pgrep` 确认为空才允许重试。**复查非空**时不要重发调用——先查明它是否阻塞在同一会话上，仍不退出就上报，不要用「再发一次试试」掩盖问题。
7. **禁止并发重发**：残留未清时再发一次，在串行队列下只会排队到超时，把问题从「一次卡住」放大成「连续超时」。

#### 审核材料的模板与上限（`inline` 档）

`inline` 档的材料由编排方拼装；`tools` 档可对着仓库核验，不受本节行数限制，但同样不该把「跑全量测试」塞进审核预算。

按下面的结构写：**正文各段合计 ≤48 行，含标题与空行总计 ≤60 行**；超了就按下方「拆轮规则」处理：

| 段 | 内容 | 上限 |
|---|---|---|
| 目的 | 这次改动解决什么、不解决什么 | 2 行 |
| 改动要点 | 逐条说明**行为变化**，不是文件清单 | 5 行 |
| 关键 diff | 只贴决定行为的 hunk（边界校验、删除/覆盖、顺序），不贴整份文件 | 40 行 |
| 控制面证据 | 编排方已跑好的门禁结果（测试条数、CI 结论），并写明「不要自行跑测试」 | 5 行 |
| 必答问题 | 3–4 个**必须回答**的问句，指向最容易错的地方；审核方只对这些负责 | 4 行 |
| 判定格式 | 按 `ABCDEFGHIJKL VERDICT: <APPROVE\|REJECT\|ESCALATE> SHA: <40 位小写十六进制>` 的形状**替换占位符**（标记 12 位、SHA 40 位），判定行全篇只出现一次 | 2 行 |

- 超过 40 行 diff，或需要判断 5 个以上独立风险点 → **拆成两轮**，每轮只审一个风险面（如「路径安全」与「向后兼容」分开）。
- 材料里出现「我跑过 / 我验证过」这类断言时，必须把**输出原文**一并贴上；贴不上时：若该断言属于必答问题 → `ESCALATE`，否则在材料里注明「未核验」并允许审核方照此写（能升到 `tools` 档就升档核验）。
- **「必答问题」是材料与审核之间的契约**：审核方只对这些问题的答案负责。某个必答问题靠材料答不了 → `ESCALATE` 并写明缺哪一项证据；问题之外的边角细节核验不了 → 如实写「未核验」，**不影响判定**。
- 建议（`minor` / `nit`）**每轮最多 3 条，每条必须把去向写在 message 文本里**：`去向：本轮修` / `去向：开 issue` / `去向：不修（理由）`（仍是 message 内容，不新增记录字段）。没有去向的建议无效；材料里已列出的既有建议不要重复。
  - **超过 3 条**：按影响排序保留前 3 条正文，其余合并成一条摘要，文案为「另有 N 条同类未展开」。摘要**不计入**上限（上限只压正文建议），所以一轮最多 3 条正文 + 1 条摘要。
  - **例外**：只有**第 4 条**若属真问题（会影响正确性），升级为 `major` 后保留、不受上限约束；第 5 条及以后一律并入摘要。
- 判定为 `APPROVE` 时**不再提需要改动代码或文档的建议**——真正值得改的留到后续 issue；确有影响正确性的问题应当判 `REJECT`。这与 Google 审核实践一致：`Nit:` 类意见显式标注且作者可忽略，不阻塞合并。
- 「写明不要自行跑测试」只是 `inline` 材料的写法；`tools` 档允许审核方跑只读命令核验。

## 8. 入口 shim 契约（**现行**）

- 由 `pipeline shim install` 从包内模板生成，文件头固定带 `GENERATED by dsh-pipeline v<版本> — do not edit`；
- 内容包含：定位包（`$DSH_PIPELINE_HOME` → 主工作区 `tools/` → 当前仓 `tools/`）、推导子命令、翻译 `-C`→`--root`、`exec node <cli>`、透传参数与退出码；
- **禁止手改**：CI 与 pre-push 跑 `pipeline shim check`，不一致即红；
- `shim check` 的判据必须是「**先用当前包版本渲染模板，再逐字节比对**」——文件头内嵌版本号，直接比模板原文会永远假红；此外还要反向扫描目录（见 §11）：清单之外的条目判失败，枚举失败按环境错误处理；
- 需要新行为时，改包或改模板，再 `shim install` 重新生成。

---

## 9. 一致性门禁（`selftest`，**现行**）

**已实现**：`--shims` / `--config` / `--lock` / `--peer` / `--exit-codes` / `--fast` / `--repos`（pre-push 用 `--fast`）。没有未实现的检查项。

| 检查 | 内容 | 失败 |
|---|---|---|
| `--shims` | 6 个入口 == 按当前版本渲染后的模板 | 退出 1 |
| `--config` | `.dsh/pipeline.json` 能被 schema 接受，无未声明字段 | 退出 1 |
| `--lock` | 安装的构建 == `pipeline.lock.json` 的 `expect`（读锁 → 读装包 `build.json` → 比对；锁不存在 / 未装包跳过，旧版本包或不一致失败，见 §7.2；锁文件或 `build.json` 读不出来退 **3**） | 退出 1（读盘失败 3） |
| `--peer` | 各包的 DSH 版本声明覆盖当前版本（静态比较）：按优先级取 `engines.dsh` → `dsh.engines.dsh` → `dsh.compatibility.dsh` → `@deepseek-ai/dsh*` peer；版本用 `--dsh-version` 或仓内装包；无声明跳过、不知道版本退 2 | 退出 1 |
| `--exit-codes` | 退出码口径自检：起子进程真跑七条用例——APPROVE 记录过闸门→0；REJECT 记录过闸门、按旧规则审的记录（`E_POLICY_VERSION`）→1；缺必填参数/未知参数/未知子命令→2；入口找不到共享包→3（并断言输出里出现「找不到共享包」）；cwd 钉在临时目录、只有环境错误那条注入 `DSH_PIPELINE_HOME`；任一不符即失败并点名用例 | 退出 1 |
| `--repos` | 多个仓装的共享包是不是同一构建（读各自 `tools/node_modules/dsh-pipeline/build.json` 的 `gitSha`/`builtAt`，比对 `gitSha`；目录不存在 / 未装包的仓跳过并列出，可比对的仓不足 2 个则跳过退 0；`build.json` 读不出来退 **3**；`--json` 给 `{ok,baseline,repos,skipped}`） | 退出 1（读盘失败 3） |
| `--fast` | 只跑 `--shims --config`（pre-push 用，<2 秒） | 退出 1 |

`doctor` 的多仓比对属于本机检查，不进 CI（CI 没有兄弟仓）。

---

## 10. 部署契约（**现行**：复用 workflow、`deploy init|check`、回滚 caller 与三个消费仓的接入均已落地）

**三条铁律（规范性）**——先于本节任何现状 / 目标描述，对所有仓的部署无条件生效：

1. **不可变产物**：一次构建的产物落进 `releases/<id>` 后不再修改；禁止在服务器上就地改产物，同一 `id` 的内容永远等于当时构建出的内容。
2. **原子切换**：切换必须一步完成——新 release 就绪后一次性把 `dist` 软链指过去再重启；切换失败时线上仍指向上一个可用 release，不存在「切了一半」的中间态。
3. **回滚与前进同构**：回滚不走特殊路径——把目标换成旧 release id，其余步骤（切软链、重启、验活、按 `keepReleases` 清理）与前进完全相同；因此两者同样幂等、同样可重复执行，回滚也不重新构建、不重新上传。

**已落地**：`deploy` 配置字段（§7.1）与 `deploy init | check`（§3.2）——部署 caller 骨架由包生成、生成区逐字节校验；复用 workflow 的构建步骤已参数化，`artifact=node-standalone` 可生成可用骨架；`deploy init --write --rollback` 连带生成回滚 caller（`rollback-web.yml`），`deploy check` 在它已是生成物时一并校验（缺失或手写跳过、退 0）。**三个消费仓均已接入**：`homebase` 补了回滚 caller（#176），`agent-mobile` 把手写的两个 caller 换成生成物并把 pin 统一到装包构建（#237），`self-dsh-plugins` 只做 CI。各仓不再手写部署步骤。

部署**不进本包**，也不留在各仓脚本里，统一走 GitHub Actions：

| 项 | 规定 |
|---|---|
| 实现 | 本仓 `.github/workflows/deploy.yml`（`on: workflow_call`）与 `rollback.yml` |
| 构建 | 三个 input 均有默认值（老 caller 零改动）：`quality_cmd`（默认 `pnpm exec tsc --noEmit && pnpm test`）/ `build_cmd`（默认 `pnpm exec expo export --platform web --clear`）/ `assemble`（`static-dir` \| `node-standalone`，默认 `static-dir`；**容器部署不做**——不引入 Docker / Kubernetes，两台服务器都是 systemd 直跑，`static-dir` / `node-standalone` + 软链切换已满足本节三条铁律）；`assemble: node-standalone` 时多一步「组装 release」——`.next/standalone/**` → `<artifact_dir>/`、`.next/static` 与 `public` 按 standalone 自带前缀补位、仓根 `scripts/` → `<artifact_dir>/scripts`，**组装阶段不建 data 软链**——需要外置状态（数据库/上传）就在 `deploy.linkPaths` 声明，由 `Link persistent paths` 在切软链前创建；不声明则 release 内没有这些路径 |
| 各仓 | 只保留一个 caller workflow（约 15 行），传 `service` / `remote_dir` / `work_dir` / `artifact_dir` / `health_url` / `keep_releases`，按需再传 `quality_cmd` / `build_cmd` / `assemble` |
| 凭据 | 各仓 `secrets.DEPLOY_SSH_KEY`，caller 用 `secrets: inherit` |
| 布局 | **统一**「`releases/<id>` + `dist` 软链 + 重启服务 + 验活 + 保留最近 N 个」 |
| 回滚 | `rollback.yml`（`on: workflow_call`）：消费仓以 `workflow_dispatch` 调起并输入 release id，留空取上一版；不删旧 release（清理仍归 `deploy.yml` 按 `keepReleases` 执行） |

**手工兜底**（GitHub 不可用时）。各仓在 caller workflow 同目录放一份 `DEPLOY.md`，内含可直接粘贴的命令，值从 caller 的 inputs 抄：

```bash
ssh root@<host>
cd <remoteDir> && ln -sfn releases/<release-id> dist
systemctl restart <service>
curl -s -m 8 -o /dev/null -w '%{http_code}\n' <healthUrl>
# 切回上一版：把 <release-id> 换成 `ls -1dt releases/*/ | sed -n 2p`
```

**为什么部署不进包**：部署脚本的价值在于“其他自动化都挂了时还能救回线上”。让它依赖一个随时可能升级的包，等于在故障时再叠加一个故障源。

---

## 11. 变更流程（防止再次分叉）

| 想改什么 | 正确做法 | 禁止 |
|---|---|---|
| 交付行为 | 改本包 + 更新本文件 + 发新构建 | 改入口 shim |
| 仓库差异 | 改该仓 `.dsh/pipeline.json` | 加仓库私有脚本进 `scripts/pipeline/` |
| 新配置字段 | 先改包 schema → 改本文件 → 改配置 | 直接往 json 里加字段 |
| 部署行为 | 改复用 workflow | 各仓各写一份 |

`scripts/pipeline/` 下**不允许**出现仓库私有文件：`shim check` 与 `selftest --shims` 会反向扫描该目录，清单之外的任何条目（含隐藏文件）都判失败并逐个点名。

---

## 12. 非目标

- 插件自身的构建、测试、发布；
- 生产部署的具体实现（§10 只定契约）；
- 宿主级工具（本机诊断脚本等）——不属于任何仓库的交付流程。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-05 | v1 冻结：命令面、退出码、输出、落盘、配置 schema、shim 契约、门禁、部署契约 |
| 2026-11-05 | v1.1：按审核意见修正——区分「现行/目标」，配置只把已进 schema 的字段写成现行，退出码与落盘口径按实际行为澄清，补 `roles`、`-C` 翻译、`prepare` 占位、shim 渲染后比对、部署手工命令模板 |
| 2026-11-06 | §10 加三条规范性铁律（不可变产物 / 原子切换 / 回滚与前进同构）；§7.1 列入 `deploy` 配置字段（本轮实现）；§3.2 / §3.3 补 `deploy init\|check` |
| 2026-11-06 | §10 补 `quality_cmd` / `build_cmd` / `assemble` 三个输入与 node-standalone 的「组装 release」规定；§3.2 / §3.3 / §7.1 同步 `artifact=node-standalone` 放行 |
| 2026-11-06 | v1.2：按实现状态校正「现行 vs 目标」——`review publish --post-review`、`selftest`（`--shims` / `--config` / `--fast` / `--repos`）、`check-all`、`shim`、`hooks` 改为现行；`deploy` 段从「目标字段」移入现行字段；仍未实现项收敛为 `selftest --lock` / `--peer` / `--exit-codes`、`pipeline.lock.json`、`review.*`、`--legacy-exit-codes`、§6 的 root 统一与 §10 的各仓接入 / 回滚调用 |
| 2026-11-06 | 删除顶层 `prepare` 占位（从未实现、无消费方、各分支均无实现痕迹）：§3.2 去掉该行，§3.3 从已实现清单移除；`dsh-pipeline prepare` 现在报「未知子命令」退 2 |
| 2026-11-06 | 审核第 1 轮 REJECT 修正：§2 的 L2 状态改为「生成能力现行、各仓接入未完成」；§3.3 目标清单补 `selftest --lock`；§9 写清 `--lock` 尚未进选项表（传了报「未知选项」），与 `--peer` / `--exit-codes` 的「尚未实现」区分 |
| 2026-11-06 | 新增 §7.3 审核档位：`review.tier`（inline / tools，缺省 tools）进 schema；`review prepare` 在 inline 档自动并入 `git show --stat` 与 `gh pr checks` 证据。v1.2 里「`review.*` 仍未实现」一项自此收窄为「`review` 的其余字段仍未实现」 |
| 2026-11-06 | §7.1 `deploy` 段补 `qualityCmd` / `buildCmd` / `paths` 三个可选字段（issue #71），硬规则补「`paths` 空数组被拒」 |
| 2026-11-06 | §7.1 `deploy` 段补 `linkPaths` 可选字段（issue #80）：渲染成 `with.link_paths`，切 dist 软链前在 release 内逐对建持久化路径软链；`deploy.yml` 新增同名 input 与 `Link persistent paths` 步骤 |
| 2026-11-07 | `link_paths` 目标改为 fail-closed（issue #94）：建链前解析目标并 `[ -e ]` 断言，目标不存在即退 1——避免建出悬空软链、部署绿着过去，切换时才以空库形态炸 |
| 2026-11-06 | 审核第 1 轮 REJECT 修正（issue #81）：`linkPaths` 的路径部分拒绝绝对路径 / `..` 段 / `,`（它会拼进远端 `rm -f`/`ln -s` 的路径）；远端执行前用 `realpath` 断言仍在 `releases/<id>/` 内，且只对父目录做规范化、末段用 `rm -f` 解链重建（避免解析已存在的软链后误删目标） |
| 2026-11-06 | §7.3 补「超时之后必须清理残留进程」与「审核材料的模板与上限」（issue #82）：600 秒超时后 `codebuddy -p` 残留会导致连续误超时；inline 材料按模板拼装、总长 ≤60 行（diff ≤40 行），超出即拆轮；清理判据用「父调用已超时」而非固定分钟数 |
| 2026-11-06 | §9 实现 `selftest --exit-codes`（起子进程真跑：缺必填参数 / 未知参数 / 未知子命令 → 2，入口找不到共享包 → 3）；§3.2 / §3.3 / §9 标题与「仍未实现」清单同步收敛为 `--lock` / `--peer` |
| 2026-11-06 | 按第 1 轮审核建议加固 `--exit-codes`：补「成功 0 / 业务拒绝 1」两条用例（用 APPROVE / REJECT 记录过闸门）、`runner` 抛异常折成失败条目、子进程统一在受控 cwd 与环境里跑；`--lock` 补进选项表，与 `--peer` 一样报「尚未实现」（不再是「未知选项」） |
| 2026-11-06 | 按第 2 轮审核建议再加固：补「按旧规则审的记录 → `E_POLICY_VERSION` → 1」用例；环境错误那条同时断言输出含「找不到共享包」；`DSH_PIPELINE_HOME` 只在环境错误那条注入；清理失败不再把检查判红；detail 的用例数由数组长度算，不写死 |
| 2026-11-06 | §7.2 转现行并写清「谁写、谁读、四种状态」；新增 `lock write|check`（`lib/lock.mjs`），§9 的 `--lock` 落地，未实现项收敛为 `--peer` 一项 |
| 2026-11-06 | §7.3 审核噪声治理（issue #86）：「判断问题」升级为「必答问题」并写清 ESCALATE 判据（只对必答问题负责）；建议每轮 ≤3 条且必须写去向；APPROVE 后不再提本 PR 的建议。依据 Google eng-practices（Nit 可忽略）与 CodeRabbit（门禁与评论分离、过滤低价值项） |
| 2026-11-07 | §7.3 补齐提示词第 8 条的规范细节（issue #93）：超过 3 条时保留前 3 条正文、其余合并为「另有 N 条同类未展开」摘要且**摘要不计入**上限；仅第 4 条属真问题时升 `major` 豁免，第 5 条起并入摘要 |
| 2026-11-07 | §9 实现 `selftest --peer`：四来源按优先级，版本取 `--dsh-version` 或仓内装包；门禁项全部落地 |
| 2026-11-07 | §6 的 root 统一落地：`record` / `review prepare\|publish` 与 `selftest` / `shim` / `hooks` / `status` 共用 `resolveMainWorktreeRoot`（显式 `--root` > 主工作区 > 当前目录），审核记录不再随 worktree 被删；上面 v1.2 那条里「§6 的 root 统一」已不再是目标 |
| 2026-11-07 | §7.1 的 `review` 目标字段全部落地：`postReview`（配置层默认发送）、`identity.ghConfigDir` / `identity.account`（发送身份与账号校验）、`rounds`（1..3，缺省 3，同时约束 `--round`、请求里的 `round`、`gate` 与 `merge`）；§3.3 目标清单只剩 `oci-image` |
| 2026-11-07 | 删掉 `oci-image` 空枚举：明确不做容器部署（不引入 Docker / Kubernetes），`DEPLOY_ARTIFACTS` 只留 `static-dir` / `node-standalone`，配了 `oci-image` 在配置层即 `E_CONFIG`；§3.3 目标清单如实收敛为三处 P2（§5 状态行格式 / §5 错误行错误码 / §11 shim check 私有文件） |
| 2026-11-07 | §11 的「`scripts/pipeline/` 不许有私有文件」落地：`checkShims` 增加反向扫描，清单外条目（含隐藏文件）判失败并点名；目录枚举不了退 3（fail-closed）。§3.3 目标清单只剩 §5 的两处输出格式 |
| 2026-11-07 | §5 的状态行落地：`review prepare\|prompt\|publish` / `record` / `gate` 统一用 `审核: `，`deploy init\|check` 用 `构建: `，`merge` 的进度行本就是阶段式；其余命令保留子命令前缀。§3.3 目标只剩「错误行带错误码」 |
| 2026-11-07 | §5 的错误行落地：统一走 `argError` / `errorLine`，格式 `dsh-pipeline: <子命令>: <错误码>: <说明>`，错误码收为 6 个（E_USAGE / E_CONFIG / E_RECORD / E_PARSE / E_ENV / E_STATE）；警告行不带码。§3.3 目标清单清零 |
| 2026-11-08 | `merge` 的退出码按失败码分类（契约 §4 口径不变、实现对齐）：用法/配置 → 2，gh / git / 读不到 head → 3，闸门拒绝 / CI 未过 / 记录与状态问题 → 1；此前 gh 失败被报成 2 |
| 2026-11-08 | 退出码口径统一：环境错误（gh / git / 写盘 / 读盘 / 未捕获异常）全命令退 3，入参 / 配置退 2，业务拒绝退 1；`E_REPO` 拆成 `E_CONFIG`（配置读不出）与 `E_ENV`（origin 读不出） |
