# 构建与运维

**最后更新**：2026-11-08 · 对应提交 `cccfe84`

## 1. 环境变量清单

本包**不读任何业务环境变量**，也不读 `.env`。下面这些只在其所在环节被消费：

| 变量 | 用途 | 必填 | 默认值 | 消费位置 |
|---|---|---|---|---|
| `DSH_PIPELINE_HOME` | 指向共享包安装目录（其下必须有 `bin/cli.mjs`），shim 定位包的第一优先级 | 否 | 空（依次回退主工作区 `tools/` → 脚本所在仓 `tools/`） | `templates/shim.sh` |
| `DSH_PIPELINE_ALLOW_STALE` | 设为 `1` 时放行「dist 过期」（源码改了没重新 `pnpm pack`）的启动校验，其余值无效 | 否 | 空（不放行，过期即退 1） | `bin/cli.mjs` 启动时的 `verifyDistFreshness()`（`lib/dist-freshness.mjs`） |
| `GH_CONFIG_DIR` | gh 的身份配置目录 | 否 | gh 自己的默认（`~/.config/gh`） | **本包只透传**，由 `gh` 读取（`review publish --post-review`、所有 gh 调用） |
| `DSH_HOME` | dsh 家目录 | 否 | `$HOME/.dsh` | `lib/profile-check.mjs` `resolveDshHome`（`doctor --profile`） |
| `HOME` | 家目录 | 否 | 系统值 | `profile-check`（DSH_HOME 缺省基准）、`hooks`（展开 `core.hooksPath` 里的 `~/`）、`task` 的 `~/` 展开 |
| `PATH` | 查找可执行文件 | 是（要能找到 `git`、`gh`、`pnpm`） | 系统值 | `check-all`（pnpm）、`profile-check`（dsh）、`git`/`gh` 封装（spawn） |

CI 侧由 GitHub Actions 提供 `GITHUB_*` 变量；本包不直接读它们。

## 2. 本地开发

```bash
# 依赖：无。node_modules 只用于 pnpm 自己的元数据，不需要 install 也能跑测试
node --version          # >= 20（本机 24.x，与 CI 一致）
node bin/cli.mjs --help # 命令面
node bin/cli.mjs --version
```

**改代码时的最小循环**：改 `lib/` 或 `bin/cli.mjs` → `node --test`（约 21 秒）→ 需要真实验证时在临时目录里跑（不要拿本仓当靶子，见下）。

**验证某条子命令不碰真实仓库**：测试用临时目录 + 假 `gh`/`git`（`test/contract.test.mjs` 的做法：临时 `bin` 目录放只记录 argv 的假脚本，`PATH` 前置）。手工复现同理。

## 3. 测试

| 项 | 值 |
|---|---|
| 命令 | `pnpm test` = `node --test`（`node:test` + `node:assert/strict`） |
| 规模 | `test/*.test.mjs` 若干（条数随 PR 变化，不写死；要对比就与 `main` 同跑一次） |
| 夹具 | `test/fixtures/plugin-record.json`（**真实运行产出**，防字段漂移，不要手改） |
| 特点 | 大量用例注入假 `runner` 断言"实际发出的命令"；`test/contract.test.mjs` 用真实子进程 + 假 gh/git 验证「闸门不通过时一条 gh 命令都不发」；`test/gitignore.test.mjs` 用真实 `git check-ignore` |

按模块看测试分布（同名前缀）：`gate`、`merge`、`policy`、`record`（+ `record-name`）、`review`（+ `review-cmd`）、`roles`、`config`、`task`（+ `task-worktree`）、`pr`、`git`、`gh`、`shim`、`hooks`、`selftest`、`init`、`check-all`、`doctor`、`contract`（+ `contract-format`）、`cli`、`post-review`、`gitignore`。

## 4. 打包（发给消费仓的唯一方式）

```bash
bash scripts/pack.sh
```

`scripts/pack.sh` 做的事（顺序固定）：

1. 写 `build.json` = `{gitSha, builtAt, dirty, sourcePath, sourceHash}`（`dirty` 由 `git status --porcelain` 判断；`sourcePath` 是 `pwd -P`，`sourceHash` 调 `node scripts/source-hash.mjs`）；
2. **门禁**：`node --test`，失败即 `exit 1`，**不产出任何 tarball**；
3. `pnpm pack --pack-destination dist/`；
4. 复制一份为 `dist/latest.tgz`；
5. `trap` 清理：删临时日志，**删 `build.json`**（只在打包期间存在，不入库不留残留）。

输出末尾打印版本、产物路径、`latest`、测试条数。`build.json` 也会被 `pnpm pack` 打进 tarball（`package.json` 的 `files` 里列了它），消费仓的 `doctor` / `selftest --repos` 就是读它；`sourcePath`/`sourceHash` 则供 CLI 启动时的 `verifyDistFreshness()` 比对——改了源码却没重新 pack，消费方 link 的 `dist/pkg` 会静默跑旧代码，现在会直接退 1 报错（放行开关 `DSH_PIPELINE_ALLOW_STALE=1`）。

### 消费仓刷新（重要，别用 `pnpm update`）

消费仓用 `file:` 指向 `dist/latest.tgz`，**版本号常年不变而内容会变**：

```bash
dsh-pipeline ...            # 或者 cd 到消费仓
rm -rf node_modules pnpm-lock.yaml
pnpm install
node bin/cli.mjs doctor --repo <仓A>,<仓B> --expect <gitSha7>   # 验收：各仓 build.json 的 gitSha 一致
```

- 锁文件**钉不住**这种产物（锁里的 integrity 必过期，`pnpm update` 还会复用旧缓存），所以消费仓不应把它入库；
- 验收方式：拿一个**只有新版本才支持**的行为去探测（例如新参数是否被识别），不要看「install 成功」。

## 5. CI

`.github/workflows/ci.yml`：

| 项 | 值 |
|---|---|
| 触发 | `push`（任意分支）+ `pull_request` |
| Runner | `ubuntu-latest`，`timeout-minutes: 10`，并发组按 ref 取消旧的 |
| 版本 | Node `24`，pnpm `12.6.0`（`pnpm/action-setup@v4`，先于 `setup-node`，因为 cache 要跑 `pnpm store path`） |
| 步骤 | checkout → setup pnpm → setup node(cache: pnpm) → `pnpm install --frozen-lockfile` → `node --test` |
| 权限 | `contents: read` |
| **不做的** | 不跑 `scripts/pack.sh`、不上传产物、不跑 `gate`/`merge`（按 ADR-0003 §5，闸门与合并只在本地） |

**CI 覆盖不到的地方**（历史事故来源）：配置 schema 错误（`doctorRepos` 事故）、shim 漂移、跨仓构建不一致。这些靠本地 `selftest` / `doctor` 与各仓的 pre-push 钩子。

## 6. 部署（复用 workflow + 生成的 caller，契约 §10）

部署实现在本包仓的两份 `workflow_call`（`deploy.yml` / `rollback.yml`），**不进包 CLI 的执行路径**；消费仓的 caller 由 `deploy init` 生成、`deploy check` 校验。

### 先在自己的仓里生成 / 校验 caller

```bash
dsh-pipeline deploy init  --root <仓>           # 只打印骨架
dsh-pipeline deploy init  --root <仓> --write   # 写入 .github/workflows/deploy-web.yml（只替换生成区）
dsh-pipeline deploy check --root <仓>           # 生成区逐字节比对；不一致打第一处差异并退 1
dsh-pipeline init --root <仓>                   # 新仓接入：配置 + shim + hooks + docs 骨架（幂等）
dsh-pipeline init --check --root <仓>           # 只读校验四件套，缺项逐条报并退 1
```

前置条件：该仓 `.dsh/pipeline.json` 有 `deploy` 段；且必须在**已安装本包**的环境里跑（`uses` 要 pin `build.json` 的 gitSha，源码运行会退 2）。字段与语义见 `modules/deploy.md`。

### `deploy.yml`（`on: workflow_call`）

| 输入 | 必填 | 说明 |
|---|---|---|
| `service` | 是 | 服务器 systemd 服务名（如 `serve-9928`） |
| `remote_dir` | 是 | 服务器部署根目录 |
| `work_dir` | 是 | 仓内构建目录（如 `agent-mobile-app`） |
| `artifact_dir` | 否 | 产物目录，相对 `work_dir`，默认 `dist` |
| `quality_cmd` | 否 | 质量门禁命令，默认 `pnpm exec tsc --noEmit && pnpm test` |
| `build_cmd` | 否 | 构建命令，默认 `pnpm exec expo export --platform web --clear` |
| `assemble` | 否 | `static-dir`（默认，直接用产物目录）/ `node-standalone`（把 `.next/standalone` 组装成 release 目录） |
| `health_url` | 是 | 健康检查 URL，必须 200 |
| `health_check` | 否 | `http`（在 runner 上探）/ `ssh`（上服务器探本地端口），默认 `http` |
| `public_health_url` | 否 | 对外链路检查（Caddy / 证书），留空不做 |
| `public_health_insecure` | 否 | 允许自签证书（`curl -k`），默认 `true` |
| `keep_releases` | 否 | 保留份数，默认 `5` |
| `dry_run` | 否 | 只打印将执行的命令 |
| `node_version` | 是（caller 传） | setup-node 的版本 |
| `mode` | 否 | `releases`（默认，`releases/<id>` + `dist` 软链）/ `inplace`（原地覆盖，快照进 `.deploy-history`） |
| `ssh_host` | 否 | 留空则从 `health_url` 解析 |
| secret | — | `secrets.DEPLOY_SSH_KEY` |

三个构建相关 input 都有默认值 → **老 caller 零改动**；缺省值仍是 Expo Web 导出，非 Expo 仓必须显式传 `build_cmd`（必要时连 `quality_cmd` 一起传）。

步骤：校验 inputs（不支持的 `mode` / `health_check` / `assemble` 直接失败）→ 安装依赖 → 质量门禁（`quality_cmd`）→ 构建（`build_cmd`）→ `assemble: node-standalone` 时组装 release → rsync → 切软链 → 重启 → 验活 → 清理旧 release。

### 三条铁律（契约 §10，规范性）

1. **不可变产物**：一次构建的产物落进 `releases/<id>` 后不再修改；
2. **原子切换**：新 release 就绪后一次性切 `dist` 软链再重启，失败时线上仍指向上一个可用 release；
3. **回滚与前进同构**：回滚只换 release id，其余步骤与前进相同，同样幂等、不重新构建。

### `rollback.yml`（`on: workflow_call`）

输入：`service`、`remote_dir`、`release`（留空 = 上一版）、`ssh_host`、`health_check`、`health_url`、`public_health_url`、`public_health_insecure`、`dry_run`。

语义：回滚 = 把 `dist` 软链指回旧 release 再重启，**不重新构建、不重新上传**；不删旧 release（清理仍归 `deploy.yml` 按 `keep_releases`）。`dry_run` 仍会只读地连服务器（列 release、读当前 `dist`），否则计划里打不出真实版本。

### 手工兜底（GitHub 不可用时）

各仓在 caller workflow 同目录放 `DEPLOY.md`，命令从 caller 的 inputs 抄：

```bash
ssh root@<host>
cd <remoteDir> && ln -sfn releases/<release-id> dist
systemctl restart <service>
curl -s -m 8 -o /dev/null -w '%{http_code}\n' <healthUrl>
# 切回上一版：把 <release-id> 换成 `ls -1dt releases/*/ | sed -n 2p`
```

## 7. 定时任务

**无**。本包没有 cron / 定时器；所有动作都是被调用时同步执行。

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `gate` 报 `E_STATE`，说明里写「规则版本 / 提交不一致 / 已过期」 | 记录按旧版本包审、绑定的 head 与当前 head 不符、或超过 24h TTL——这三种内部码（`E_POLICY_VERSION` / `E_SHA_MISMATCH` / `E_EXPIRED`）在输出层都折成契约的 `E_STATE`；gate 现场判定的内部码不落盘（`record` 落盘时仍会把内部码写进记录的 `errorCode` 字段） | 重新审核，不要改记录 |
| `merge` 报「主工作区停留在 X，已跳过快进」 | 主工作区检出的是 PR 分支且有未提交改动 | 按提示 `git -C <main> checkout main` 后重跑；未合并前不要动现场 |
| `merge` 报「本地分支仍被工作区检出，跳过删除」 | 分支还在某个 worktree 里 | `git -C <main> branch -D -- <branch>` |
| `shim check` / `selftest --shims` 红 | 入口被手改，或包升级后没重新生成 | `shim install --root <仓>`（会覆盖生成物）；确认不是手写壳 |
| `hooks check` 报「没有可执行位」 | 文件内容对但 `chmod -x` 了 | 重新 `hooks install` |
| `hooks install` 拒绝覆盖 | 已有钩子不是本工具装的（无标记行） | 确认来源后加 `--force` |
| 钩子装了但没生效 | 仓库设了 `core.hooksPath`（husky 等） | 本包已支持装到 `core.hooksPath` 指向处；检查报告里的路径 |
| `check-all` 退 3 | 找不到 `pnpm` | 装 pnpm 并加入 `PATH`（本仓只允许 pnpm） |
| `doctor` 报漂移 | 各仓装的是不同次打包，或某仓装的是没有 `build.json` 的旧包 | 各仓 `rm -rf node_modules pnpm-lock.yaml && pnpm install`，再比对 `gitSha` |
| `gh` 在受限沙盒里报「令牌无效」 | 宿主的文件沙盒拦住了系统钥匙串访问，不是令牌过期 | 用完整权限运行，或走一次审批提权；**不要**重新 `gh auth login`（详见 `~/.dsh/AGENTS.md` §5） |
| `review publish --post-review` 退 3 但记录已写 | gh 调用失败（列/发 review） | 记录不回滚；修好 gh 后重跑同一命令即可（同 SHA 已发过会自动跳过） |
| 在 worktree 里跑 `record` 后记录不见了 | 2026-11-04 的老问题：当时缺省按当前目录落盘 | 已修：缺省落主工作区；若显式传了 `--root <worktree>`，记录会跟着 worktree 一起被删 |

## 9. 本仓自身的交付流程

本仓 dogfood 自己的闸门：

```bash
# 1) 审核记录由 self-dsh-plugins 的 reviewer 产出（跨仓调用）
node <self-dsh-plugins>/dsh-subagents/lib/cli.js prepare --pr <N> --root <本仓>
# 2) 合并（闸门 → CI → squash → 清理）
dsh-pipeline merge --pr <N> --record <记录>
```

`.dsh/pipeline.json` 的 `ci` 字段**没有消费方**（CI 判定走 `gh pr checks`），写它只是预留。
