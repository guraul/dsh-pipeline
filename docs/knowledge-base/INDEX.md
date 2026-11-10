# dsh-pipeline 知识库索引

> 最后更新: 2026-11-10 | commit: `d934fd5`
> 覆盖路径: `package.json`, `bin/cli.mjs`, `lib/*.mjs`, `templates/**`, `.dsh/pipeline.json`, `.github/workflows/*.yml`, `scripts/pack.sh`, `test/gate.test.mjs`, `test/merge.test.mjs`, `test/contract-format.test.mjs`

## 使用说明

**加载顺序**：每次对话先读本文件建立全局认知；需要动某个子命令时只加载对应 `modules/*.md`；查产物落在哪读 `DATA.md`；跑测试 / 打包 / 部署读 `OPERATIONS.md`；改行为前先看 `CONVENTIONS.md` 的红线。

**如何更新**：知识库与代码同仓，放 `docs/knowledge-base/`。涉及**架构 / 命令面 / 退出码 / 配置 schema / 落盘路径**的变更必须同步更新对应文档（纯实现细节不必）。每份文档顶部用 canonical 两行（`> 最后更新: … | commit: \`…\`` + `> 覆盖路径: …`），由 `node bin/cli.mjs kb check --root .` 机械校验；生成与本文件的约定见 `docs/kb-prompt.md`；唯一规范来源是 `docs/CONTRACT.md`——本知识库**描述现状**，契约**定义规则**，两者冲突时以契约为准并视为缺陷。

## 项目一句话定位

把「issue → task 分支与 worktree → PR → 审核 → 闸门 → squash 合并 → 清理现场」收成**一份实现**的 Node CLI（`@guraul/dsh-pipeline`，零运行时依赖），供 `self-dsh-plugins` / `agent-mobile` / `homebase` / `memx` 等仓以本地 tarball 安装，仓库差异只允许由 `.dsh/pipeline.json` 表达。

## 核心功能清单

| 功能 | 子命令 / 触发 | 实现文件 |
|---|---|---|
| 从 issue 建任务分支 + worktree | `task` | `lib/task.mjs` |
| 推送任务分支并开 PR | `pr` | `lib/pr.mjs` |
| 生成审核请求（含一次性标记） | `review prepare` | `bin/cli.mjs` `runReviewPrepare` + `lib/gh.mjs` |
| 由请求渲染审核提示词 | `review prompt` | `lib/review.mjs` `buildPrompt` |
| 判定落盘为审核记录 | `record`、`review publish` | `bin/cli.mjs` `runRecord` + `lib/record.mjs` |
| 把判定发成 GitHub review | `review publish --post-review` | `lib/review.mjs` `createPullReview` / `listPullReviews` |
| 审核闸门 | `gate`、`merge` 第一步 | `lib/gate.mjs` |
| 合并并清理现场 | `merge` | `lib/merge.mjs` |
| 高风险路径策略 | `record` 内计算，`gate` 内判定 | `lib/policy.mjs` |
| 审核记录概况 | `status` | `bin/cli.mjs` `runStatus` |
| 跨仓「装的是不是同一构建」 | `doctor` | `lib/doctor.mjs`（+ `lib/profile-check.mjs`） |
| 一致性自检 | `selftest` | `lib/selftest.mjs`（复用 `lib/shim.mjs`） |
| 生成 / 校验入口 shim | `shim install` / `check` | `lib/shim.mjs` + `templates/shim.sh` |
| 安装 / 校验 pre-push 直推拦截钩子 | `hooks install` / `check` | `lib/hooks.mjs` |
| 逐包跑 test/check/typecheck | `check-all` | `lib/check-all.mjs` |
| 生成 / 校验部署 caller workflow 骨架 | `deploy init` / `deploy check` | `lib/deploy.mjs` |
| 新仓库一键接入（配置 + shim + hooks + docs 骨架） | `init` / `init --check` | `lib/init.mjs` |
| 知识库检查 / 初始化 / 更新提示词 / 影响分析 | `kb check` / `kb init` / `kb refresh` / `kb impact` | `lib/kb.mjs` |
| 写入 / 核对锁文件（装的是哪个构建） | `lock write` / `lock check`（`selftest --lock` 同一实现） | `lib/lock.mjs`（自己读装包的 `build.json`） |
| 构建标识（打包时写入） | `bash scripts/pack.sh` | `scripts/pack.sh` + `lib/build-info.mjs` |

## 技术栈表

| 类别 | 技术 / 库 | 版本 | 用途 |
|---|---|---|---|
| 运行时 | Node.js | `engines.node >=20`；CI 用 24 | 纯 ESM，`"type": "module"` |
| 依赖 | 无（零运行时依赖、零 devDependency） | — | glob / 校验 / 参数解析全部手写 |
| 测试 | `node:test` + `node:assert/strict` | 随 Node | `pnpm test` = `node --test`（条数随 PR 变化，不写死） |
| 包管理 | pnpm | CI 钉 `12.6.0`（`pnpm-lock.yaml` 只有 2 行，无依赖） | 只允许 pnpm |
| CI | GitHub Actions | `actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4` | `node --test`，不打包、不上传产物 |
| 部署 | GitHub Actions 复用 workflow | `deploy.yml` / `rollback.yml`（`on: workflow_call`） | rsync + `releases/<id>` + `dist` 软链 + 重启 + 验活 |
| Shell | bash | 兼容 macOS 自带 3.2 | `templates/shim.sh`、`scripts/pack.sh` 不用 bash 4 语法 |
| 外部命令 | `gh`、`git`、`pnpm` | 本机安装版本 | 只经 `lib/gh.mjs` / `lib/git.mjs` / `lib/check-all.mjs` 的具名操作 |

## 仓库拓扑

```text
dsh-pipeline/
├── bin/cli.mjs              # 唯一入口：参数解析、子命令编排、输出与退出码（约 3200 行）
├── lib/                     # 业务实现，28 个模块；CLI 只调它，不复制规则
│   ├── gate.mjs             # 闸门判定（纯函数）
│   ├── merge.mjs            # 合并编排：闸门 → CI → squash → 清理
│   ├── policy.mjs           # 高风险 glob 策略 + 变更行数上限
│   ├── record.mjs           # 记录 schema / 落盘 / 读取 / 跳过审计
│   ├── review.mjs           # 一次性标记、判定行解析、findings、提示词、GitHub review
│   ├── roles.mjs            # 角色默认值与覆盖（reviewer 强制只读）
│   ├── task.mjs / pr.mjs    # 建 worktree / 开 PR
│   ├── repo.mjs             # root 与 owner/name 解析（工作树 vs 主工作区）
│   ├── config.mjs           # .dsh/pipeline.json 严格 schema
│   ├── git.mjs / gh.mjs     # 具名外部命令封装，runner 可注入
│   ├── selftest.mjs / shim.mjs / hooks.mjs / check-all.mjs
│   ├── init.mjs / region.mjs  # 一键接入（四件套）与生成区通用操作
│   ├── deploy.mjs           # 部署 caller workflow 骨架的生成 / 校验（契约 §10）
│   ├── lock.mjs             # .dsh/pipeline.lock.json 的读 / 写 / 核对（契约 §7.2）
│   ├── kb.mjs               # 知识库页眉 / 覆盖路径 / 入口检查与四种提示词（契约 §3.2）
│   ├── doctor.mjs / profile-check.mjs / build-info.mjs
├── templates/               # shim.sh（6 个入口）+ pipeline-docs/ + kb-prompt.md + agents.md
├── scripts/pack.sh          # 打包门禁：先 node --test，通过才 pnpm pack 到 dist/
├── docs/
│   ├── CONTRACT.md          # 交付契约 v1.3（唯一规范来源）
│   ├── kb-prompt.md         # 知识库生成提示词（从 agent-mobile 复制）
│   └── knowledge-base/      # 本知识库
├── .dsh/pipeline.json       # 本仓配置：repo / ci / highRisk
├── .github/workflows/       # ci.yml（测试）、deploy.yml、rollback.yml（复用）
├── test/                    # *.test.mjs + fixtures/plugin-record.json
├── .tmp/ .dsh-web/          # 本机产物（gitignore，不入库）
├── .worktrees/              # task 缺省 worktree 容器（空目录）
├── dist/                    # 打包产物（gitignore）
└── package.json             # @guraul/dsh-pipeline 0.1.0，private
```

## 模块依赖关系（文字版）

```text
bin/cli.mjs  ──> lib/*（全部）
  ├─ 参数解析 / 输出 / 退出码映射（唯一）
  ├─ gate   ──> lib/gate.mjs ──> lib/record.mjs（常量）
  ├─ merge  ──> lib/merge.mjs ──> lib/config.mjs, lib/gate.mjs, lib/record.mjs, lib/gh.mjs, lib/git.mjs
  ├─ record ──> lib/review.mjs（解析）+ lib/policy.mjs + lib/record.mjs + lib/config.mjs
  ├─ task   ──> lib/task.mjs ──> lib/repo.mjs, lib/git.mjs, lib/gh.mjs
  ├─ pr     ──> lib/pr.mjs   ──> lib/repo.mjs, lib/git.mjs, lib/gh.mjs
  ├─ selftest ─> lib/selftest.mjs ──> lib/config.mjs, lib/shim.mjs
  ├─ shim   ──> lib/shim.mjs ──> lib/record.mjs（PACKAGE_VERSION）+ templates/shim.sh
  ├─ hooks  ──> lib/hooks.mjs ──> lib/git.mjs
  └─ doctor ──> lib/doctor.mjs, lib/profile-check.mjs, lib/build-info.mjs

lib/gh.mjs、lib/git.mjs 是叶子：只依赖 node:child_process，不依赖其它 lib。
lib/gate.mjs、lib/policy.mjs、lib/roles.mjs 是纯函数层：无 IO、不读时钟（时间由调用方传入）。
lib/record.mjs 读 package.json 的 version 作为 PACKAGE_VERSION / policyVersion 来源。
```

## 数据流向总览

```text
GitHub issue ──gh──> task ──git──> task/<号>-<slug> 分支 + worktree
                                        │
                                  开发、提交、pnpm test
                                        │
GitHub PR <──gh── pr（推送分支 + Closes #<号>）<──┘
                                        │
review prepare ──gh(prView/prDiff)──> .tmp/review/<pr>/request.json（含 12 位 base32 nonce）
                                        │
review prompt ──> 提示词（stdout 或 --out 文件）──> reviewer（子代理 / product CLI）
                                        │
                                  判定行：<nonce> VERDICT: X SHA: <40hex>
                                        │
record / review publish ──> .dsh-web/reviews/<pr>-<sha>.json（+ 可选 GitHub review）
                                        │
merge ──> gate(读记录 + policyVersion/TTL/SHA) ──> gh pr checks ──> gh pr merge --squash
                                        │
                     worktree remove → fetch → merge --ff-only origin/main → branch -D
```

## 速查表

| 我想做… | 去哪个文件 |
|---|---|
| 加一个子命令 / 改参数 | `bin/cli.mjs`（`SUBCOMMANDS` / `IMPLEMENTED` / `HELP` / `run*`）+ `docs/CONTRACT.md` §3 |
| 改退出码 | `bin/cli.mjs` 各 `run*` 的 `return`，口径见 `docs/CONTRACT.md` §4 |
| 改闸门判定条件 | `lib/gate.mjs`（顺序即语义），测试 `test/gate.test.mjs` |
| 改合并步骤 / 清理逻辑 | `lib/merge.mjs`（`STEP_ORDER` 固定顺序），测试 `test/merge.test.mjs` |
| 改高风险路径清单 | `lib/policy.mjs` 的 `DEFAULT_HIGH_RISK`；仓库差异写 `.dsh/pipeline.json` 的 `highRisk`（追加） |
| 改记录字段 / 加字段 | `lib/record.mjs`（`REQUIRED_FIELDS` / `OPTIONAL_FIELDS`）+ `test/contract-format.test.mjs` 夹具 |
| 改判定行格式 / nonce | `lib/review.mjs`（`NONCE_PATTERN`、`verdictPattern`）+ `bin/cli.mjs` `HELP` |
| 改请求 JSON 字段 | `bin/cli.mjs` `runReviewPrepare`（写）+ `record` / `prompt`（读） |
| 改配置 schema | `lib/config.mjs` `CONFIG_FIELDS` → `docs/CONTRACT.md` §7.1 → 各仓配置 |
| 改入口 shim 行为 | `templates/shim.sh` → 各仓重新 `shim install` |
| 改钩子内容 | `lib/hooks.mjs`（`INTERCEPT_BODY` / `ALLOW_MAIN_BODY`）→ 各仓重新 `hooks install` |
| 查审核记录 / 跳过审计 | `<主工作区>/.dsh-web/reviews/`、`.dsh-web/reviews/skips/`（见 `DATA.md`） |
| 查某仓装的是哪个构建 | `node bin/cli.mjs doctor --repo <仓…>`（读 `tools/node_modules/dsh-pipeline/build.json`）；某仓自己钉的期望值看 `.dsh/pipeline.lock.json` |
| 刷新 / 核对某仓的锁文件 | `node bin/cli.mjs lock write --root <仓>` / `lock check --root <仓>`（见 `modules/tooling.md`） |
| 生成 / 校验某仓的部署 caller 骨架 | `.dsh/pipeline.json` 的 `deploy` 段 → `node bin/cli.mjs deploy init --root <仓> [--write]` / `deploy check --root <仓>`（见 `modules/deploy.md`） |
| 新仓接入 / 校验四件套 | `node bin/cli.mjs init --root <仓>` / `init --check --root <仓>`（见 `modules/tooling.md`） |
| 检查 / 初始化 / 更新知识库 | `node bin/cli.mjs kb check --root .` / `kb init` / `kb refresh` / `kb impact`（见 `modules/kb.md`） |
| 改知识库页眉 / 覆盖路径判据 | `lib/kb.mjs`（`parseHeader` / `checkCoverage` / `checkEntry`）+ `test/kb.test.mjs` |
| 打包给消费仓 | `bash scripts/pack.sh` → `dist/latest.tgz` + `build.json` |

## 文档导航

| 文档 | 适用场景 |
|---|---|
| `INDEX.md`（本文） | 每次对话优先加载：定位、技术栈、拓扑、速查 |
| `ARCHITECTURE.md` | 分层架构、命令编排、数据模型、落盘、幂等与副作用 |
| `API.md` | 子命令 / 动作 / 参数 / 输出 / 退出码（接口视角，含内部模块导出） |
| `DATA.md` | 产物实体在哪、谁写谁读、怎么查 |
| `OPERATIONS.md` | 环境变量、本地开发、测试、打包、CI、部署、排障 |
| `CONVENTIONS.md` | 代码风格、文件组织、已知问题、历史包袱、修改红线 |
| `modules/cli.md` | `bin/cli.mjs` 编排层 |
| `modules/gate-merge.md` | 闸门、合并、高风险策略 |
| `modules/review-record.md` | 审核请求、判定解析、记录、角色 |
| `modules/task-pr-git-gh.md` | task / pr / repo / git / gh |
| `modules/tooling.md` | init / selftest / lock / shim / hooks / check-all / doctor / profile-check / build-info |
| `modules/deploy.md` | 部署 caller 骨架：`deploy init` / `check`、`deploy` 配置段、三条铁律 |
| `modules/kb.md` | 知识库三件套：`kb check` / `init` / `refresh` / `impact`、12 类错误码、页眉与覆盖路径契约 |
| `../CONTRACT.md`（仓内 `docs/CONTRACT.md`） | 契约：命令面、退出码、输出、落盘、配置 schema、shim、门禁、部署 |
