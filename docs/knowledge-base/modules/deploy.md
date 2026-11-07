# 模块：部署 caller 骨架（deploy）

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

## 职责

各仓的部署 caller workflow **不是手写的**：由 `deploy init` 按该仓 `.dsh/pipeline.json` 的 `deploy` 段生成、由 `deploy check` 逐字节校验。回滚 caller（`rollback-web.yml`）由 `deploy init --write --rollback` 一并生成，`deploy check` 在它存在时也逐字节校验——回滚与前进同构，只是 `uses` 指向 `rollback.yml`、触发方式换成 `workflow_dispatch`。真正的部署实现在本包仓的 `.github/workflows/deploy.yml` 与 `rollback.yml`（`on: workflow_call`），消费仓只留一个十几行的 caller。

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

## 命令

```bash
dsh-pipeline deploy init --root <dir> [--write] [--rollback]
dsh-pipeline deploy check --root <dir>
```

| 动作 | 行为 | 退出码 |
|---|---|---|
| `init`（不带 `--write`） | 只把骨架打到 stdout；`--rollback` 必须与 `--write` 同用，否则退 2 | 0 |
| `init --write`，文件不存在 | 创建（`mkdir -p` 目录） | 0 |
| `init --write`，已有生成区 | **只替换生成区**，标记之后的追加 job 原样保留 | 0 |
| `init --write`，已有文件但缺标记（手写文件） | 拒绝覆盖 | 1 |
| `check`，生成区一致 | 打印一致 | 0 |
| `check`，不一致 | 打印**第一处差异**（行号 + 期望 / 实际两行） | 1 |
| `check`，缺标记 | 「不是生成的骨架」 | 1 |
| `check`，文件不存在 | 提示先跑 `deploy init` | 1 |
| 参数错误 / 配置错误 / `artifact=oci-image` | 明确报错 | 2 |

**源码运行不能生成**：`uses` 必须 pin 到 `build.json` 的 gitSha，源码目录没有 `build.json` → 退 2 并提示「请在已安装包内运行」；不要用假 pin 掩盖这一点。

## `deploy` 段的默认值（`resolveDeploy`）

| 字段 | 必填 | 缺省 / 约束 |
|---|---|---|
| `artifact` | 是 | `static-dir` / `node-standalone` 可用；`oci-image` 只在 schema 层放行，生成时报「尚未实现」退 2 |
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

1. **标记文案与路径是契约**：改了标记，所有已生成的 caller 都会被判「不是生成的骨架」（`check` 退 1、`init` 拒绝覆盖）。
2. **比对只比生成区**：不要改成比整份文件，否则各仓追加的后置 job 会被判不一致。
3. **`firstDifference` 给的是第一处差异**，不要只打印「不一致」——排障时要能直接看到哪一行。
4. **不要给可选项写默认值**：`resolveDeploy` 的 `null` 语义是「不写这一行」，写成空串会顶掉 `deploy.yml` 的默认值。
5. **`artifact=oci-image` 目前只在 schema 放行**：实现前不要让它生成骨架（会静默产出一个跑不通的 caller）。

## 相关测试

`test/deploy.test.mjs`（383 行）、`test/config.test.mjs`（deploy 段校验）、`test/cli.test.mjs`（命令层）。
