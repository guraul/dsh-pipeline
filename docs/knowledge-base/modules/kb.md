# 模块：知识库三件套（kb check / init / refresh）、影响分析（kb impact）与日更队列（kb queue）

> 最后更新: 2026-11-10 | commit: `3676219`
> 覆盖路径: `lib/kb.mjs`, `lib/git.mjs`, `lib/policy.mjs`, `bin/cli.mjs`, `templates/kb-prompt.md`, `templates/agents.md`, `test/kb.test.mjs`, `test/git.test.mjs`

这一组命令把「知识库从零建起来 / 存量重新对齐 / 判断一篇文档是否过期 / 这次改动影响哪几篇」收进本包。设计边界：**只读仓库**（除 `--out` 指定的文件），不写 KB 正文、不改 `AGENTS.md`、不装定时任务。

## 职责

| 命令 | 职责 |
|---|---|
| `kb check` | 校验每篇页眉（最后更新 + commit / 覆盖路径）与入口（`AGENTS.md` 路由、`INDEX.md` 导航），并报告 stale |
| `kb init` | 生成「从零建知识库」提示词 + `AGENTS.md` 草稿（只打印，不落盘） |
| `kb refresh` | 生成「存量更新」提示词：结构违规 + 每篇 stale 的 `git log` 原文 + 升级/页眉规则 + 禁止项 |
| `kb impact` | 算「这次改动影响哪几篇文档」（`--staged` 或 `--range`） |
| `kb queue` | 日更队列：算「水位..HEAD」的影响，有影响才投滚动 issue 评论；投递成功才推进水位 |

`check` 是唯一验收器：`init` / `refresh` 的「完成」定义都是 `kb check` 退 0（或只剩被 `--exclude` 明确排除的文件）。`check` 不判断「文档写得对不对」，只判断「声明是否完整、路径是否活着、有没有变过」。

## 关键文件

| 文件 | 职责 |
|---|---|
| `lib/kb.mjs` | 页眉解析、覆盖路径校验、入口检查、stale 计算、四种提示词渲染、影响分析 |
| `lib/git.mjs` | 新增具名封装：`lsFiles` / `commitExists` / `isAncestor` / `logOnelineRange` / `diffShortstat` / `diffNameOnly` / `diffNameStatus`（`--name-status -M`，删除取旧路径、改名/复制取旧+新） |
| `lib/policy.mjs` | 复用 `globToRegExp`（`--exclude` 与路径匹配）与 `normalizePath`；不引第三方 glob |
| `bin/cli.mjs` | `runKb` 分派 + `runKbCheck` / `runKbInit` / `runKbRefresh` / `runKbImpact`；`parseArgs` 支持可重复参数（`--exclude` / `--doc`） |
| `templates/kb-prompt.md` | 写作指令模板（init 的回退来源；本仓 `docs/kb-prompt.md` 与它同源） |
| `templates/agents.md` | `AGENTS.md` 五段草稿模板（`{{REPO}}` / `{{KB_DIR}}` / `{{MODULES_ROWS}}` / `{{RULES}}` / `{{COMMANDS}}`） |
| `test/kb.test.mjs` | 12 类错误码 + 旧格式兼容 + `--exclude` / `--strict` / `--allow-missing` + 退出码 0/1/2/3 + init/refresh/impact |

## 页眉解析（`parseHeader`）

只在前 **10 行**里找；canonical 两行：

```markdown
> 最后更新: YYYY-MM-DD | commit: `<7–40 位十六进制 sha>`
> 覆盖路径: `path/to/file.ts`, `path/to/dir/**`
```

- stamp 语义 = **内容对齐的代码提交**，不是写文档那天；与代码同 PR 提交时取该提交的父提交。
- stamp 必须是 `HEAD` 的祖先（`git merge-base --is-ancestor`）。
- 兼容三种旧格式（`· commit` / `**最后更新**：` / `commit <sha> · 说明`）：能解析就只给 `W_LEGACY_HEADER`，不失败。
- commit 位置写提交标题（不是十六进制 sha）按 `E_NO_STAMP` 处理，不猜。

## 错误码（12 类）

| 文档级（7） | 触发条件 |
|---|---|
| `E_NO_STAMP` | 没有页眉 / 没有「最后更新」/ 没有 commit 或不是十六进制 sha |
| `E_BAD_DATE` | 日期不是 `YYYY-MM-DD`（含 2 月 30 日这类不存在的日期）或晚于今天 |
| `E_STAMP_ORPHAN` | commit 不存在（squash 后原 sha 悬空），或不是 `HEAD` 的祖先 |
| `E_NO_COVERAGE` | 没有「覆盖路径」行或该行为空 |
| `E_DEAD_GLOB` | 单条 glob 用 `git ls-files` 展开命中 0 个已跟踪文件 |
| `E_BROAD_GLOB` | 单条 glob >30 个文件 / 单篇 >200 个 / 顶层文档 >10 条 / `**` 单独成条 |
| `E_FORBIDDEN_PATH` | 绝对路径、`./` 前缀、含 `..`、指向 `docs/**` / 知识库自身 / `test/fixtures/**` |

| 入口级（5） | 触发条件 |
|---|---|
| `E_NO_AGENTS` | 仓库根没有 `AGENTS.md` |
| `E_NO_KB_ROUTE` | `AGENTS.md` 里没有指向 `<kb-dir>/INDEX.md` 的路由 |
| `E_ROUTE_DEAD` | 路由里写的文档不存在 |
| `E_ROUTE_MISMATCH` | `modules/*.md` 与 `AGENTS.md` 路由表双向不一致（模块文档没被路由） |
| `E_NAV_MISMATCH` | `INDEX.md` 的「文档导航」与实际文件双向不一致 |

警告只有 `W_LEGACY_HEADER`，不失败。

## 入口检查

- `AGENTS.md` 必须有指向 `<kb-dir>/INDEX.md` 的路由；路由里提到的每个 `<kb-dir>/*.md` 都必须存在（否则 `E_ROUTE_DEAD`）。
- `modules/*.md` 与 `AGENTS.md` 路由表双向一致：模块文档没被路由 → `E_ROUTE_MISMATCH`。
- `INDEX.md` 的「文档导航」小节与实际文件双向一致（缺项 / 指向不存在的文档都是 `E_NAV_MISMATCH`）。
- 导航项可以是纯路径（`modules/x.md`）、反引号路径，或 Markdown 链接 `[文字](modules/x.md)`（memx / homebase 的导航表就是链接格式）：链接只取目标，链接文字不参与匹配。
- 路径可以写知识库相对路径，也可以写全仓相对路径（`docs/knowledge-base/modules/x.md`），两者都会归一到知识库相对路径；`../CONTRACT.md` 这类知识库外的文档不算导航项。
- `--exclude` 同时作用于文档枚举与导航比对：排除一篇导航里列着的文档，不会反过来报 `E_NAV_MISMATCH`。

## 覆盖路径的机械判据

1. 只列正文点名的代码 / 配置 / 脚本；按目录聚合。
2. 单条 glob 展开 ≤30 个 tracked 文件；单篇 ≤200 个；顶层文档（`INDEX` / `ARCHITECTURE` / `API` / `DATA` / `OPERATIONS` / `CONVENTIONS`）只列结构锚点 ≤10 条。
3. `check` 展开一律 `git ls-files -- <glob>`——`fs` 递归会把 `node_modules` 与未跟踪文件算进去；`impact` 例外（按改动路径直匹配，见下节）。
4. 文档自身、`docs/**`、`test/fixtures/**` 不进覆盖路径（否则文档改一下自己就 stale）。
5. 路径相对仓库根，不带 `./` 前缀，不写绝对路径。

## stale 与影响分析

- stale = `git log --oneline <stamp>..HEAD -- <覆盖路径>` 的条数；`--strict` 时 stale>0 也退 1，缺省只报告。
- 用**原始 glob** 而不是展开后的文件列表做 pathspec：覆盖目录下新增的文件也算改动。
- `kb impact` 取 `git diff --name-status -M`（`--staged` 或 `--range`）：A/M/T 取新路径、D 取旧路径、R/C 取旧+新；用覆盖路径的 glob 匹配器**直接测试改动路径**（字面文件 / 目录前缀 / glob 三种写法），不先用 `lsFiles` 展开——删除的旧路径已不在 tracked 集合里，展开必然漏报。`--json` 与 `--out` 同时给时两者都生效（文件写 JSON、stdout 也输出 JSON）；只读。
- `kb refresh` 对单篇 stale >30 条或 diff >2000 行的情况，在提示词里要求「放弃逐条 diff、按写作指令重写该篇」。

## 日更队列（`kb queue`，P7.1）

`dsh-pipeline kb queue --root <dir> --repo <owner/name> --issue <n> [--since <sha>] [--state <file>] [--dry-run] [--json]`

- **水位**：首次用 `--since`；之后从 `--state` 读（缺省 `~/.dsh/kb-queue/<repo>.json`，**不进仓库**）。`--since` 可以是 ref（`HEAD~5`），命令内先 `revParse` 成完整 sha。
- **计算**：复用 `computeImpact` 算 `<水位>..HEAD` 的影响；无影响静默退 0（`--json` 给 `{ok:true,affected:[]}`）。
- **有影响**：生成评论（日期、受影响文档、命中文件、涉及提交、`kb refresh --doc` 建议），首行标记 `<!-- kb-queue: <repo> -->`，用 `lib/gh.mjs` 的 `issueComment` 投到 `--issue` 指定的滚动 issue。
- **推进**：只在**评论投递成功**后写水位；投递失败退 3 且水位不动（下次重扫同一段，不丢改动）。
- **`--dry-run`**：只打印评论正文，不投递、不写状态文件。
- 不装定时任务、不自动开 PR / 合并——调度与自动更新属 P7.2/P7.3，需用户授权。

## 退出码（契约 §4）

| 场景 | check | init | refresh | impact | queue |
|---|---|---|---|---|---|
| 成功 | 0 | 0 | 0 | 0 | 0（含无影响静默） |
| 业务拒绝 | 1（有结构违规；`--strict` 且有 stale） | 1（已有 KB） | 1（无 KB，提示用 init） | — | — |
| 用法 / 配置 | 2（参数错；`--kb-dir` 不存在且没给 `--allow-missing`） | 2 | 2（含未知 `--doc`） | 2 | 2（缺 `--repo` / `--issue` / 水位） |
| 环境错误 | 3（git / 读盘失败） | 3（写 `--out` 失败） | 3 | 3 | 3（gh 投递 / 水位写盘失败） |

## 修改本模块的注意事项

1. **`check` 的判据不许放宽**：放过 `E_STAMP_ORPHAN` 或 `E_BROAD_GLOB` 会让「信任靠 diff」失去数据层支撑（issue #154 §6 的 1–6 条都是真实踩过的坑）。
2. **`check` 不要用 `fs` 展开覆盖路径**：一律 `lsFiles`（`git ls-files -z --`），否则未跟踪文件与 `node_modules` 会混进来。**`impact` 例外**：它按 `git diff --name-status` 的改动路径直接匹配（删除/改名要算旧路径），不要改回「先展开再求交」。
3. **`init` / `refresh` 只读**：`AGENTS.md` 是高危文件，草稿只打印；`docs/kb-prompt.md` 缺失时用包内模板作为回退，不替调用方复制。
4. **新增错误码先改契约**：`docs/CONTRACT.md` §3.2 / §4 / §5 与 `HELP` 同步；测试里 `DOC_ERROR_CODES` / `ENTRY_ERROR_CODES` 的长度断言（7 / 5）是「12 类」的守门。
5. **`--doc` / `--exclude` 可重复**：`parseArgs` 的第 4 个参数是 `repeatableFlags`，不要退回「重复参数一律报错」。
6. **stale 用原始 glob**：用展开后的文件列表会漏掉覆盖目录里的新增文件。
7. **在 worktree 里跑 `kb check` 用 `--root .`**：缺省 root 是 `git rev-parse --show-toplevel`（当前工作树），不是主工作区；这与 `record` / `review` 的口径不同（契约 §3.1）。
8. **git 失败与「glob 命中 0」必须分开**：非 git 仓 / git 不可用 / `safe.directory` 拒绝时 `git ls-files` 非零退出 → 环境错误退 3；只有 git 正常跑完、命中 0 个 tracked 文件才是 `E_DEAD_GLOB`（退 1）。`commitExists` / `isAncestor` 同理：`isAncestor` 只有退出码 1 是「不是祖先」。

## 相关测试

`test/kb.test.mjs`（页眉解析、12 类错误码、开关、退出码、init/refresh/impact）、`test/git.test.mjs`（6 个新封装）。
