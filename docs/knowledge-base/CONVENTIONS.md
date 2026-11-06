# 约定与陷阱

**最后更新**：2026-11-06 · 对应提交 `cf7544f`

## 1. 代码风格与命名

| 项 | 约定 |
|---|---|
| 语言 | 纯 ESM JavaScript（`"type": "module"`），**没有 TS、没有构建步骤**，直接跑源码 |
| 依赖 | 零运行时依赖、零 devDependency。glob 子集（`**` `*` `?`）在 `lib/policy.mjs` 手写，就是为了不引 minimatch（引了以后每次改 `package.json` 都会自己触发高风险闸门） |
| 文件名 | kebab-case 英文：`build-info.mjs`、`check-all.mjs`、`profile-check.mjs`；命令相关模块与子命令同名（`gate.mjs` ↔ `gate`） |
| 导出 | 函数 camelCase（`resolveMainRoot`）、常量 UPPER_SNAKE（`DEFAULT_TTL_MS`）、错误类 PascalCase（`RecordError`） |
| 注释 | **中文，解释「为什么」**；每个模块顶部有一段背景说明（约束、历史事故、为什么这样设计）。不要写"这行在做什么" |
| 错误信息 | 中文；错误行由 CLI 加 `<子命令>: ` 前缀，lib 只给原因 |
| 错误类型 | `ConfigError` / `RecordError` / `PolicyError` / `RoleError`，带 `code` 字段（`E_CONFIG` / `E_RECORD` / `E_POLICY` / `E_ROLE`）；其余用 `{ ok:false, code, error }` 返回值 |
| 外部命令 | 一律 `{ ok, code, data, error }`，**不抛异常**；上层据此写审计与闸门，不需要 try/catch |
| 打印 | `lib/` 不打印，`bin/cli.mjs` 决定 stdout/stderr |
| 时间 | 纯函数层不读时钟：`now` 由调用方传入（缺省才取当前时间），保证单测与审计可复现 |
| 测试命名 | 中文描述 + 模块前缀：`test('task: --worktrees-dir 相对路径按 --root 解析成绝对路径', …)` |
| Shell | 兼容 macOS 自带 bash 3.2：不用 `${VAR:-默认值}` 的省略写法（相邻 UTF-8 会出乱码）、不用 `mapfile` / 关联数组 / `${var^^}` |

## 2. 文件组织约定

| 规则 | 说明 |
|---|---|
| 一个子命令一个 `run*` 函数 | `bin/cli.mjs` 只做解析 + 校验 + 调 lib + 打印 + 返回码 |
| 规则不落在 CLI | 判定、写盘、外部调用全在 `lib/`；新增规则先判断属于哪一层 |
| 参数表是常量 | 每个子命令一组 `*_VALUE_FLAGS` / `*_BOOL_FLAGS`（`Set`），加参数改这里 + `HELP` + 契约 |
| 一个动作一个模块 | `shim` 的渲染/写入/比对全在 `lib/shim.mjs`；`hooks` 同理；CLI 不复制判定 |
| 测试与实现同名 | `lib/gate.mjs` ↔ `test/gate.test.mjs`；跨层的用 `contract*` / `cli` / `post-review` |
| 夹具来自真实运行 | `test/fixtures/plugin-record.json` 必须取自真实 `.dsh-web/reviews/` 的一条，不许手打（手打的会丢 field，重复段静默丢失） |

## 3. 已知问题 / 历史包袱

> 「已修」指 2026-11-06 这个 PR（issue #68）或它依赖的 #67 已经改掉；「现存」是写这份文档时仍然成立的事实。

| # | 问题 | 状态 | 说明 |
|---|---|---|---|
| 1 | 契约把已实现能力标成「目标」 | **已修（本 PR，契约 v1.2）** | §3.2 / §3.3 / §9 / §10 改为现行；仍未实现项已收敛为 `selftest --peer`、`review.*`、`--legacy-exit-codes`、§6 的 root 统一与 §10 的各仓接入 / 回滚调用（`--exit-codes`、`--lock`、`pipeline.lock.json` 均已实现） |
| 2 | README 的「已实现」清单不全 | **已修（本 PR）** | 补到 14 个子命令（含 `deploy init` / `check`）；顶层 `prepare` 占位已删除 |
| 3 | README 的「本仓高风险只列了 `.github/**`」易被误读 | **已修（本 PR）** | 改为「配置只**追加**了 `.github/**`，而 `lib/policy.mjs` 的默认清单恒生效」——改 `AGENTS.md`、`.gitignore` 等同样属高风险 |
| 4 | `deploy.yml` 只适配 Expo 类仓 | **已修（#67）** | 新增 `quality_cmd` / `build_cmd` / `assemble` 三个 input，均有默认值（老 caller 零改动）；缺省构建命令仍是 Expo Web 导出，非 Expo 仓要显式传 |
| 5 | `.DS_Store` 未进 `.gitignore` | **已修（本 PR）** | 已加一行；此前 `git status` 常年脏一条 |
| 6 | 退出码口径不统一（契约 §4 已记录为现状差异） | 现存 | `record` / `review publish` 解析出 `REJECT` 退 0；`review prepare` 的 gh 失败用 2（不是 3）。统一属契约变更，要同批改消费方 |
| 7 | L2 入口层未统一 | 现存 | `agent-mobile`、`homebase` 是手写转发壳，`self-dsh-plugins` 仍用自有实现（多 `--facts` / `--include` / 提示词生成）；`diff -r scripts/pipeline` 尚未为空 |
| 8 | `pipeline.lock.json` 未实现 | **已修（issue #86 / PR #87）** | 新增 `lock write|check` 与 `selftest --lock`：锁由 `lock write` 生成、逐字节校验装包与锁；消费仓接入 CI 仍待做（本仓 `ci.yml` 只跑测试） |
| 9 | CI 覆盖不到配置 / shim / 跨仓漂移 | 现存 | `ci.yml` 只跑 `node --test`；2026-11-04 的配置多字段事故 CI 测不出来，靠本地 `selftest --config` 与 `doctor` |
| 10 | `.dsh/pipeline.json` 的 `ci` 字段是死字段 | 现存 | README 明确「没有消费方」；CI 判定走 `gh pr checks` |
| 11 | §10 各仓接入未完成 | 现存 | caller 骨架能生成校验，但只有 `agent-mobile` 真正接入；`rollback.yml` 的「消费仓以 `workflow_dispatch` 调起」也还没有样板 |
| 12 | `artifact=oci-image` 只进 schema | 现存 | `deploy init` 生成时报「尚未实现」退 2（不会产出跑不通的 caller），实现前不要放行 |

## 4. 修改红线（动了会破坏什么）

| 对象 | 不能做什么 | 破坏什么 |
|---|---|---|
| `lib/gate.mjs` 判定顺序 | 调整顺序（如把 `policyVersion` 提到 `verdict` 之前） | 顺序即语义；`E_*` 错误码的含义与审计可追溯性都会变 |
| `lib/gate.mjs` 的 `policy.hit` 检查 | 删掉或改成"警告" | 高风险路径不再要求人工放行（这正是 `policy` 曾变死代码的后果） |
| `lib/policy.mjs` 的默认清单 | 把某条挪进"仅配置才生效" | 各仓默认失去保护（仓库差异只能**追加**，不能替换默认） |
| `record` 的 `REJECT` 退出码 | 擅自改成 1 | 打断现有脚本（属契约变更，要同批改契约与消费方） |
| `lib/record.mjs` 的 `ALLOWED_FIELDS` | 随意加字段 / 把 `policy` 当多余字段拒收 | 插件产出的记录被拒 → 闸门全红，或 `policy` 变死代码（`test/contract-format.test.mjs` 守这条） |
| `lib/merge.mjs` 的合并方式 | 加 `--merge` / `--rebase` 参数 | 仓库历史策略被悄悄改变；`gh.mjs` 的 `MERGE_STRATEGY` 固定 squash 是刻意的 |
| `lib/merge.mjs` 的步骤顺序 | 把 `ci` 挪到 `gate` 之前 | 「`--force` 绕不过闸门」这条保证失效（顺序本身就是保证） |
| `lib/git.mjs` 允许清单 | 加 `push origin --delete` | 远端分支删除应当交给 `gh pr merge` 的仓库设置（注释写明"不打算为它开后门"） |
| `lib/roles.mjs` | 允许 `reviewer` 提权为 `full` | 审核方变成可写方，判定可信度归零 |
| 记录里的 `request` 字段 | 改成存 diff 全文 | 记录体积暴涨且泄内容；只存 `{issue, diffChars}` |
| `.gitignore` | 删 `.tmp/` 或 `.dsh-web/` | 审核产物入库（`test/gitignore.test.mjs` 会红） |
| `scripts/pipeline/*.sh`（消费仓） | 手改 | `shim check` / `selftest --shims` 红；要新行为改包或改模板再 `shim install` |
| `templates/shim.sh` | 改完不重新 `shim install` | 各仓入口与模板不一致，门禁红 |
| `test/fixtures/plugin-record.json` | 手写或"顺手改" | 防漂移测试失效（夹具必须来自真实运行） |
| `hooks install` 的目标路径 | 改回固定 `.git/hooks` | 设了 `core.hooksPath` 的仓会装到 git 不看的位置，且 `check` 还会报"一致"（假绿） |
| `deploy-web.yml` 的生成区 | 手改生成区、或改完配置不重跑 `deploy init` | `deploy check` 逐字节比对会红；正确做法是改 `.dsh/pipeline.json` 的 `deploy` 段再 `deploy init --write`（标记之后的追加 job 不会被覆盖） |
| `deploy.yml` 的 `quality_cmd` / `build_cmd` / `assemble` | 删掉默认值 | 不传这三个 input 的老 caller 会当场失败（默认值就是兼容性） |

## 5. 易踩的坑

1. **两种 root**：`pr` 要当前工作树，`task` / `selftest` / `status` / `hooks` 要主工作区。在 worktree 里按 cwd 推 worktree 容器会嵌套出 `<wt>/.worktrees/<x>`（脚本以 `--git-common-dir` 的父目录为准，不是 `--show-toplevel`）。
2. **记录落进 worktree**：`record` / `review` 缺省不会上溯主工作区，记录会随 worktree 清理被删（2026-11-04 真实发生）。要保证写进主仓就走转发壳，或显式 `--root <主工作区>`。
3. **`merge` 取的是 PR head，不是本机 HEAD**：合并通常从主工作区发起，本机 HEAD 是 main，拿它比记录永远对不上。
4. **主工作区停在 PR 分支**：`merge --ff-only origin/main` 必失败；脚本会先 checkout（干净时）或跳过快进并给提示（脏时），不会静默失败。
5. **主工作区不可 `worktree remove`**：git 报 `is a main working tree`；脚本识别后跳过移除、只删分支。
6. **squash 后 `branch -d` 必拒**：原提交不是 main 祖先，所以显式 `-D`；仍被检出时跳过并给手动命令。
7. **`pnpm update` 不可靠**：`file:` 本地 tarball 的锁文件钉不住内容，刷新一律 `rm -rf node_modules pnpm-lock.yaml && pnpm install`。
8. **shim 的比对必须先渲染**：文件头内嵌版本号，直接比模板原文会永远假红。
9. **`--force` ≠ 跳过审核**：它只豁免 CI、不写跳过审计、不在 PR 留评论，因此不能替代 `--no-review --reason`。
10. **`review prompt` 没有缺省 `--request`**：拿错请求文件的代价是把错提示词发给 reviewer，所以强制显式给。
11. **`review publish` 的 `--round` 必须与请求一致**：不一致当场退 2，避免第 2 轮的判定静默写成第 1 轮。
12. **`--post-review` 失败不回滚记录**：记录已落盘、review 未发出（退 3）；修好 gh 重跑即可，同 SHA 已发过会自动跳过。
13. **`check-all` 缺 `node_modules` 算跳过不算失败**：CI 里拿它当门禁时要确认依赖已装，否则全绿但什么都没跑。
14. **`doctor` 的"旧包无 build.json"算漂移**：能区分"没装"和"装了但没标识"，后者必然不是同一个构建。
15. **`deploy init` 重跑只替换生成区**：标记之后的追加 job 原样保留；但文件里没有成对标记（手写文件）时**拒绝覆盖**并退 1——这时要先决定是删掉手写文件还是补标记。
16. **源码运行不能 `deploy init`**：`uses` 必须 pin 安装包 `build.json` 的 `gitSha`，源码目录没有它 → 退 2。别用假 pin 绕（会让 caller 指到不存在的版本）。
17. **`resolveDeploy` 的 `null` 是「不写这一行」**：可选项没配就不写进 caller，交给 `deploy.yml` 的默认值；写成空串会把默认值顶掉。

## 6. 文档与注释的维护约定

- 契约（`docs/CONTRACT.md`）是唯一规范来源；本仓文档只写**差异与索引**，不复述契约。
- 命令面 / 退出码 / 落盘 / 配置 schema 变更 → 同一次提交里改契约 + `HELP` + 知识库 + 测试。
- 知识库每篇顶部写「最后更新 + commit 短 hash」，只写**代码里真实存在**的内容；拿不准标「待确认」，不要臆测。
