# 交付契约（CONTRACT）

**版本**：v1.1（2026-11-05）
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
| **L2 入口层** | 各仓 `scripts/pipeline/*`：**生成物**，逐字节相同 | 由 `pipeline shim install` 生成 | **目标（P2）**；今天是各仓手写壳 |
| **L3 配置层** | 各仓 `.dsh/pipeline.json` + `.dsh/pipeline.lock.json` | 各仓 | pipeline.json 现行；lock 目标（P2） |

L2 之所以要变成生成物：入口一旦允许手写，就等于给“某仓加一点私有逻辑”留了后门，`diff -r` 立刻失真。

---

## 3. 命令面

### 3.1 各仓入口 → 包子命令（**目标，P2**）

| 入口文件 | 转发到 | 说明 |
|---|---|---|
| `pipeline.sh` | `<子命令>`（原样透传） | 通用入口；等价于直接调包 |
| `new-task.sh` | `task` | 建 worktree + 任务分支 |
| `open-pr.sh` | `pr` | 推送分支并开 PR |
| `merge-pr.sh` | `merge` | 闸门通过后 squash 合并并清理现场 |
| `review.sh` | `review` | `prepare` / `prompt` / `publish` |
| `status.sh` | `status` | 审核记录概况 |

关于 `-C/--root`：包侧只认 `--root <dir>`（`parseArgs` 拒绝非 `--` 形式的位置参数）。**由 shim 负责把 `-C <dir>` 翻译成 `--root <dir>`**，包本身不解析 `-C`。

各子命令的 `--root` 缺省值**不统一**（现状）：`pr` 取当前任务 worktree；`record` / `review` 取当前目录；`merge` 取主工作区。`status` 不列入本名单——它缺省自行定位主工作区，与 `doctor` 一样无需显式传。统一为「主工作区」是目标（P2），见 §6。

### 3.2 包子命令全集

| 子命令 | 作用 | 状态 |
|---|---|---|
| `task` | 从 issue 建 `task/<号>-<slug>` 分支与 worktree | 现行 |
| `pr` | 推送当前任务分支并创建 PR | 现行 |
| `prepare` | 顶层占位命令（help 里标注未实现） | 现行占位，**待删除或实现** |
| `review prepare` | 读 PR 的 head/diff/issue 正文，写审核请求（含 nonce） | 现行 |
| `review prompt` | 由请求渲染审核提示词 | 现行 |
| `review publish` | 把判定落成记录 | 现行 |
| `review publish --post-review` | 同时把判定发成 GitHub review（幂等） | **目标（P2）** |
| `record` | 只落盘判定记录（供外部流程使用） | 现行 |
| `gate` | 审核闸门检查（记录存在性、SHA 绑定、高风险路径） | 现行 |
| `merge` | 闸门通过后 squash 合并 + 清理 worktree/分支 + 快进 main；`--review-record` 是 `--record` 的兼容别名（旧写法，后续将弃用；两者取值不同则报错） | 现行 |
| `status` | 审核记录概况，含仓库概览（root/branch/head/worktrees；git 取不到时该段只提示，不影响退出码） | 现行 |
| `doctor` | 检查仓库装的共享包是否同一构建；`--profile <dir>` 可选：体检 profile 包声明、插件软链有效性、`dsh --dump-config` 可见性（dsh 不可用时跳过）、审核记录目录可写，另含原 review-loop-check.sh 没有的 `cordis.patch.yml` 非空与目录/DSH_HOME 报告两项 | 现行 |
| `selftest` | 一致性自检（见 §9） | **目标（P2）** |
| `check-all` | 按配置逐包跑声明的检查并汇总 | **目标（P2）** |
| `shim install\|check` | 生成 / 校验入口 shim | **目标（P2）** |
| `hooks install` | 安装 pre-push 直推拦截钩子 | **目标（P2）** |

新增子命令属于**契约变更**，必须同时更新本文件与 §3.3。

### 3.3 实现状态（v1.1 冻结时）

**已实现**：`task` / `pr` / `prepare`(占位) / `review prepare|prompt|publish` / `record` / `gate` / `merge` / `status` / `doctor`。

**配置字段（P2 已实现）**：`worktreesDir` 已进 schema（见 §7.1），由 `task` 消费——缺省读配置、`--worktrees-dir` 优先；`checks` 已进 schema（见 §7.1），由 `check-all` 消费——`--packages` 优先，其次 `checks.packages`（按给定顺序），再否则自动发现并按 `checks.exclude` 过滤；`review.*` 仍为目标（P2）。

**目标**：`review publish --post-review`、`selftest`、`check-all`、`shim install|check`、`hooks install`、`--legacy-exit-codes`（P2），以及 §10 的部署复用 workflow（P3）。

硬规则：目标条目在实现合并前**不得**被入口 shim 调用，也不得在文档里写成可用；§9 的门禁项同理——`selftest` 落地前，CI 不得引用它。

---

## 4. 退出码

| 码 | 含义 | 现行范围 | 目标范围 |
|---|---|---|---|
| 0 | 成功 | 全部 | 全部 |
| 1 | **业务拒绝** | `gate` / `merge`（闸门拒绝、CI 未过）；`review publish` 只有在 `ESCALATE` 时退 1 | 全部命令：判定 `REJECT`/`ESCALATE` 一律 1 |
| 2 | **用法错误** | 部分命令 | 全部命令 |
| 3 | **环境错误** | 部分命令（现多用 1） | 全部命令 |

**现状差异（必须知道）**：`record` / `review publish` 解析出 `REJECT` 时**正常落盘并退 0**——判定本身是一次成功的落盘。只有 `ESCALATE` 退 1。想统一成“REJECT 也退 1”属于目标（P2），改之前会打断现有脚本。

硬规则：

1. 入口 shim **不得**改写退出码，只透传；
2. 不得用 `1` 表示用法错误，也不得用 `2` 表示业务拒绝；
3. 迁移期用 `--legacy-exit-codes`（**目标，P2**）保持旧行为，切换完成后删除该开关。

---

## 5. 输出格式

| 类型 | 现行 | 目标 |
|---|---|---|
| 数据行 | stdout，无前缀 | 同 |
| 状态行 | `<子命令>: <消息>`，中文 | `<阶段>: <状态>`（`审核` / `合并` / `构建`） |
| 错误行 | stderr，`<子命令>: <消息>` | stderr，`dsh-pipeline: <子命令>: <错误码>: <说明>` |
| 机器模式 | `--json` 输出一个 JSON 对象 | 同 |

错误行要带上错误码属于**目标（P2）**，与退出码统一同批做；在那之前外部脚本不要依赖错误里出现错误码。

---

## 6. 落盘路径

| 产物 | 路径 | 状态 |
|---|---|---|
| 审核请求 | `<root>/.tmp/review/<pr>/request.json` | 现行 |
| 审核提示词 | `<root>/.tmp/review/<pr>/prompt.md` | 现行 |
| 审核记录 | `<root>/.dsh-web/reviews/<pr>-<head_sha>.json` | 现行 |
| 跳过审计 | `<root>/.dsh-web/reviews/skips/<ts>-<pr>.json` | 现行 |

**现状**：`<root>` 取各命令自己的缺省（见 §3.1）——在 worktree 里跑 `record` / `review`，记录会落进 worktree，随 worktree 一起被删（2026-11-04 真实发生过）。

**目标（P2）**：`<root>` 一律取**主工作区**（`git worktree list --porcelain` 首条、分支为 `main` 的那个）。在实现前，worktree 里跑这两个命令必须显式给 `--root <主工作区>`。

**全部产物不入库**：`.gitignore` 覆盖 `.tmp/` 与 `.dsh-web/`。

---

## 7. 配置

### 7.1 `.dsh/pipeline.json`（入库；**严格 schema**）

**现行字段**（`lib/config.mjs` 的 `CONFIG_FIELDS`，多一个字段就报 `E_CONFIG`）：

```jsonc
{
  "repo": "guraul/<name>",        // 可选；缺省 null（下游命令报“无法确定仓库”）
  "ci": [],                       // 可选；**已废弃**，CI 判定改走 gh pr checks
  "highRisk": ["…"],              // 可选；缺省 []
  "roles": {},                    // 可选；review prompt 的角色定义
  "worktreesDir": "~/workspace/<name>-worktrees",  // 可选；缺省 <主工作区>/.worktrees（P2 已实现）
  "checks": { "packages": ["pkg-a"], "exclude": ["tools"] }  // 可选；缺省 null（**已实现**）：check-all 的显式包清单与自动发现排除项
}
```

**目标字段（P2 才会进 schema）**：

```jsonc
{
  "review": {
    "postReview": true,
    "identity": { "ghConfigDir": "~/.config/gh-reviewer", "account": "guraul-review" },
    "rounds": 3
  }
}
```

硬规则：

1. **未声明字段一律报错**（`E_CONFIG`）。新增字段顺序固定：**先改本包 schema → 再改本文件 → 最后改各仓配置**。顺序反了就是 2026-11-04 那次事故；
2. `ci` 已废弃，新配置不要写；
3. 仓库差异只能落在 `repo` / `highRisk` / `roles` / `worktreesDir` 以及（P2 起）`review.*` / `checks.*` 之内。

> 反面教材：2026-11-04 有人往本文件加了 `doctorRepos`，包判未知字段，`task`/`pr`/`merge` 三条同时失效，CI 不覆盖这类错误。

### 7.2 `.dsh/pipeline.lock.json`（**目标，P2**）

```json
{ "expect": "<sha7> <builtAt>" }
```

由发布脚本更新（包仓的工作），消费方只在 CI 与 `selftest` 里读，**不手改**。

---

## 8. 入口 shim 契约（**目标，P2**）

- 由 `pipeline shim install` 从包内模板生成，文件头固定带 `GENERATED by dsh-pipeline v<版本> — do not edit`；
- 内容包含：定位包（`$DSH_PIPELINE_HOME` → 主工作区 `tools/` → 当前仓 `tools/`）、推导子命令、翻译 `-C`→`--root`、`exec node <cli>`、透传参数与退出码；
- **禁止手改**：CI 与 pre-push 跑 `pipeline shim check`，不一致即红；
- `shim check` 的判据必须是「**先用当前包版本渲染模板，再逐字节比对**」——文件头内嵌版本号，直接比模板原文会永远假红；
- 需要新行为时，改包或改模板，再 `shim install` 重新生成。

---

## 9. 一致性门禁（`selftest`，**目标，P2**）

| 检查 | 内容 | 失败 |
|---|---|---|
| `--shims` | 6 个入口 == 按当前版本渲染后的模板 | 退出 1 |
| `--config` | `.dsh/pipeline.json` 能被 schema 接受，无未声明字段 | 退出 1 |
| `--lock` | 安装的构建 == `pipeline.lock.json` 的 `expect` | 退出 1 |
| `--peer` | 各插件声明的 peer 范围覆盖当前 DSH 版本（静态比较，不下载） | 退出 1 |
| `--exit-codes` | 退出码表自检（缺参→2、未知参数→2、找不到包→3） | 退出 1 |
| `--repos` | 多个仓装的共享包是不是同一构建（读各自 `tools/node_modules/dsh-pipeline/build.json` 的 `gitSha`/`builtAt`，比对 `gitSha`；目录不存在 / 未装包的仓跳过并列出，可比对的仓不足 2 个则跳过退 0；`--json` 给 `{ok,baseline,repos,skipped}`） | 退出 1 |
| `--fast` | 只跑 `--shims --config`（pre-push 用，<2 秒） | 退出 1 |

`doctor` 的多仓比对属于本机检查，不进 CI（CI 没有兄弟仓）。

---

## 10. 部署契约（**目标，P3**）

部署**不进本包**，也不留在各仓脚本里，统一走 GitHub Actions：

| 项 | 规定 |
|---|---|
| 实现 | 本仓 `.github/workflows/deploy.yml`（`on: workflow_call`）与 `rollback.yml` |
| 各仓 | 只保留一个 caller workflow（约 15 行），传 `service` / `remoteDir` / `buildCmd` / `artifactDir` / `healthUrl` / `keepReleases` |
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

`scripts/pipeline/` 下**不允许**出现仓库私有文件（P2 落地后由 `shim check` 强制）。

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
