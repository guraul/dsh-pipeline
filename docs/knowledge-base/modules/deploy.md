# 模块：部署 caller 骨架（deploy）

**最后更新**：2026-11-08 · 对应提交 `943d92a`

## 职责

各仓的部署 caller workflow **不是手写的**：由 `deploy init` 按该仓 `.dsh/pipeline.json` 的 `deploy` 段生成、由 `deploy check` 逐字节校验。回滚 caller（`rollback-web.yml`）由 `deploy init --write --rollback` 一并生成，`deploy check` 在它已是生成物时也逐字节校验——回滚与前进同构，只是 `uses` 指向 `rollback.yml`、触发方式换成 `workflow_dispatch`。真正的部署实现在本包仓的 `.github/workflows/deploy.yml` 与 `rollback.yml`（`on: workflow_call`），消费仓只留一个十几行的 caller。

## 关键文件

| 文件 | 职责 |
|---|---|
| `lib/deploy.mjs` | 标记文案、路径常量、`resolveDeploy`（补默认值）、`renderRegion` / `renderSkeleton`、`extractRegion`、`firstDifference`、`replaceRegion` |
| `lib/config.mjs` | `deploy` 段的 schema 校验（`DEPLOY_FIELDS` / `DEPLOY_HEALTH_FIELDS` / `DEPLOY_ARTIFACTS` / `DEPLOY_HEALTH_CHECKS`） |
| `bin/cli.mjs` | `runDeploy`（`init` / `check` 两个动作、`--write` / `--rollback`、读 `build.json` 拿 gitSha） |

## 产物与标记

| 项 | 值 |
|---|---|
| 生成文件 | `<root>/.github/workflows/deploy-web.yml`；带 `--rollback`（或文件已存在）时另有 `<root>/.github/workflows/rollback-web.yml` |
| 起始标记 | `# >>> dsh-pipeline 生成区（勿手改，改配置后重跑 deploy init）` |
| 结束标记 | `# <<< dsh-pipeline 生成区结束（以下可追加本仓自己的后置 job）` |
| 生成区内容 | `name` / `on`（push main + workflow_dispatch）/ `concurrency` + 单个 job 的 `uses` + `with` + `secrets: inherit` |
| `uses` | `guraul/dsh-pipeline/.github/workflows/deploy.yml@<gitSha>`，gitSha 来自**当前安装包**的 `build.json` |
| 标记之后 | 各仓可追加自己的后置 job，`check` 不比对、`init` 重跑也不覆盖 |

## 可见性前提（2026-11-08 实测踩坑）

GitHub 有一条硬规则：**公开仓不能调用私有仓里的可复用工作流**（reusable workflow，即 `on: workflow_call` 的文件）。本包仓的 `deploy.yml` / `rollback.yml` 是**被调用方**，所以组合决定成败：

| 本包仓 | 消费仓 | 能否部署 |
|---|---|---|
| 公开 | 公开 / 私有 | 可以 |
| 私有 | 私有 | 可以 |
| **私有** | **公开** | **必然失败** |

失败时的表现极具误导性：**运行连 job 都不会创建**（`referenced_workflows: []`），GitHub 只给一句「This run likely failed because of a workflow file issue」——不提可见性。

2026-11-08 实测：本包仓当时是私有，`guraul/agent-mobile` 是公开仓，它的 `deploy-web` 从切换共享工作流那天起连续失败 3 天（5 次运行全红）。期间排查过 YAML 语法、caller 的 inputs 与 `deploy.yml` 声明是否一一对应、`secrets` 是否存在、pin 的 SHA 是否存在于远端——**全部正常**。真正的判据只有两条命令：

```bash
gh api repos/<消费仓> --jq .private
gh api repos/guraul/dsh-pipeline --jq .private
```

处置：把本包仓改为公开（2026-11-08 已执行；转公开前确认过无凭据、无 `.env`、无字面主机地址，git 历史里也没有）。

**排障提示**：同一套 caller 骨架在一个仓成功、另一个仓失败时，**先比两仓的可见性**，不要先怀疑 YAML、inputs 或 pin。

## 命令

```bash
dsh-pipeline deploy init --root <dir> [--write] [--rollback]
dsh-pipeline deploy check --root <dir>
```

| 动作 | 行为 | 退出码 |
|---|---|---|
| `init`（不带 `--write`） | 只把部署骨架打到 stdout | 0 |
| `init --rollback`（不带 `--write`） | 用法错误：`--rollback` 只影响落盘 | 2 |
| `init --write`，文件不存在 | 创建（`mkdir -p` 目录） | 0 |
| `init --write`，已有生成区 | **只替换生成区**，标记之后的追加 job 原样保留；`rollback-web.yml` 已是生成物时**一并刷新**（不用每次记着加 `--rollback`） | 0 |
| `init --write`，部署 caller 缺标记（手写） | 拒绝覆盖 | 1 |
| `init --write`，回滚 caller 是手写文件 | 跳过它并提示，部署 caller 照常刷新；显式 `--rollback` 才拒绝覆盖 | 0 / 1 |
| `check`，生成区一致 | 打印一致 | 0 |
| `check`，不一致 | 打印**第一处差异**（行号 + 期望 / 实际两行） | 1 |
| `check`，部署 caller 缺标记 | 「不是生成的骨架」 | 1 |
| `check`，部署 caller 不存在 | 提示先跑 `deploy init` | 1 |
| `check`，回滚 caller 不存在 | 静默跳过（迁移期，不改变既有输出） | 0 |
| `check`，回滚 caller 是手写文件 | 跳过 + stderr 提示（与 `init` 同口径） | 0 |
| 参数错误 / 配置错误 | 明确报错 | 2 |

**源码运行不能生成**：`uses` 必须 pin 到 `build.json` 的 gitSha，源码目录没有 `build.json` → 退 2 并提示「请在已安装包内运行」；不要用假 pin 掩盖这一点。

## `deploy` 段的默认值（`resolveDeploy`）

| 字段 | 必填 | 缺省 / 约束 |
|---|---|---|
| `artifact` | 是 | 只有 `static-dir` / `node-standalone`；`oci-image` 在配置层即 `E_CONFIG`（容器部署明确不做，见契约 §10） |
| `service` | 是 | 非空字符串（systemd 服务名） |
| `remoteDir` | 是 | 非空字符串 + **绝对路径** |
| `workDir` | 是 | 非空字符串（`deploy.yml` 的 `work_dir` 是必填 input） |
| `artifactDir` | 否 | `null`（不写进 caller，交给 `deploy.yml` 的默认 `dist`） |
| `sshHost` | 否 | `null`（不写，让 `deploy.yml` 从 `health_url` 解析主机） |
| `health.url` | 是 | — |
| `health.check` | 否 | `http`；可选 `ssh` |
| `health.publicUrl` | 否 | `null`（不写，跳过对外链路检查） |
| `health.insecure` | 否 | `true`（允许自签证书） |
| `keepReleases` | 否 | `5`；范围 1..50 |

**写 caller 的规则**：可选项只在配置里给了才写——`deploy.yml` 对这些 input 都有默认值，写空串会把默认值顶掉。

## `artifact` 如何决定 `deploy.yml` 的行为

| `artifact` | `mode` | `assemble` | 说明 |
|---|---|---|---|
| `static-dir` | `releases` | `static-dir` | 直接用构建产物目录 |
| `node-standalone` | `releases` | `node-standalone` | 多一步「组装 release」：`.next/standalone/**` → `<artifact_dir>/`、`.next/static` 与 `public` 按 standalone 前缀补位、仓根 `scripts/` → `<artifact_dir>/scripts`；组装阶段**不建 data 软链**；需要外置状态（数据库/上传）时在 `deploy.linkPaths` 声明，由 `Link persistent paths` 在切 dist 软链前创建（路径部分不许含 `..`，越界由执行前的 `realpath` 断言拦下） |

## 三条铁律（契约 §10）

1. **不可变产物**：一次构建的产物落进 `releases/<id>` 后不再修改；
2. **原子切换**：新 release 就绪后一次性把 `dist` 软链指过去再重启，失败时线上仍指向上一个可用 release；
3. **回滚与前进同构**：回滚只是换个 release id，其余步骤与前进相同，同样幂等、不重新构建。

## 依赖

`lib/deploy.mjs` 无 lib 依赖（纯字符串处理）；gitSha 由 CLI 经 `lib/build-info.mjs` 读入后传入（`deps.buildInfo` 可注入，**判据是「显式传了没有」**——测试注入 `null` 表示「没有 build.json」，不能用 `isPlainObject` 判断）。

## 修改本模块的注意事项

1. **标记文案与路径是契约**：改了标记，已生成的**部署** caller 会被判「不是生成的骨架」（`check` 退 1、`init` 拒绝覆盖）；回滚 caller 因缺标记会被当作手写文件跳过（退 0）——所以改标记时必须同步重建回滚 caller，不能指望 `check` 报错。
2. **比对只比生成区**：不要改成比整份文件，否则各仓追加的后置 job 会被判不一致。
3. **`firstDifference` 给的是第一处差异**，不要只打印「不一致」——排障时要能直接看到哪一行。
4. **不要给可选项写默认值**：`resolveDeploy` 的 `null` 语义是「不写这一行」，写成空串会顶掉 `deploy.yml` 的默认值。
5. **不要把本包仓改回私有**：消费仓里只要有一个是公开仓，它的部署就会立刻全红，且报错只说「workflow file issue」（见上面「可见性前提」）。真要改私有，先确认所有消费仓都是私有。
6. **不要重新引入 `oci-image` 枚举**：容器部署已明确不做（契约 §10），该值在配置层就 `E_CONFIG`；真要支持容器是新需求，需同时加 `deploy.yml` 分支并更新契约。

## 相关测试

`test/deploy.test.mjs`、`test/config.test.mjs`（deploy 段校验）、`test/cli.test.mjs`（命令层）。
