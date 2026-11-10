# 模块：CLI 编排层

> 最后更新: 2026-11-09 | commit: `d934fd5`
> 覆盖路径: `bin/cli.mjs`, `lib/merge.mjs`, `test/cli.test.mjs`, `test/contract.test.mjs`, `test/post-review.test.mjs`, `test/record-name.test.mjs`, `test/review-cmd.test.mjs`

## 职责

`bin/cli.mjs`（约 3200 行）是本包唯一入口：解析参数、校验参数、调用 `lib/`、按 stdout/stderr 打印、把结果映射成退出码。它**不实现任何业务规则**——闸门、写盘、外部命令都在 `lib/`。

## 关键文件

| 文件 | 职责 |
|---|---|
| `bin/cli.mjs` | 参数解析器、`HELP` 文本、16 个子命令的 `run*` 函数、`decideGate`、`runRecord`、`sendReview`、`resolveMainWorktreeRoot`、`expandHome`、`runCli` |

## 结构

```text
常量区：IMPLEMENTED（16 个）· SUBCOMMANDS（16 个，两集合一致；顶层 prepare 占位已删除）· HELP（唯一文案来源）
        GATE_*/MERGE_*/RECORD_*/REVIEW_*/SELFTEST_*/SHIM_*/HOOKS_*/CHECK_ALL_* 参数表（Set）
工具函数：messageOf · isPlainObject · nonEmpty · parseArgs · parsePr · requireRoot · parseRound
          parseDuration · parseGateArgs · argError · emit · requestOf · changedFiles · countChangedLines
命令函数：runGate · runMerge · runRecord · runReviewPrepare · runReviewPublish · sendReview
          runReviewPrompt · runReview · runDoctor · runSelftest · runReposCheck · runShim
          runHooks · runCheckAllCommand · runStatus · runTask · runPr · runDeploy
          runKb（分派）· runKbCheck · runKbInit · runKbRefresh · runKbImpact
入口：runCli(argv, deps) → 分派；invokedDirectly() 时才 process.exit
```

## 参数解析（`parseArgs`）

只接受 `--name value`、`--name=value`；`--exclude` / `--doc` 可重复（第 4 个参数 `repeatableFlags`）：

| 情形 | 结果 |
|---|---|
| 布尔参数带值（`--json=1`） | `--json 不接受取值` → 退 2 |
| 重复参数 | `重复参数: --x` → 退 2（可重复参数除外） |
| 未知参数 | `未知选项: --x` → 退 2 |
| 缺取值 / 下一个 token 以 `--` 开头 | `--x 缺少取值` → 退 2 |
| 非 `--` 开头的位置参数 | `无法识别的参数: x` → 退 2（`task <issue>` 例外，由 `runTask` 自己取） |

**`-C <dir>` 不被识别**：由 shim 翻译成 `--root <dir>`（契约 §3.1）。

## 注释与文案

- `HELP` 是命令面的**唯一文案来源**（各子命令的用法、选项、退出码都在里面），改参数必须同步改它。
- 输出全中文；错误与警告走 stderr；数据行走 stdout。
- 退出码映射散落在各 `run*` 的 `return`，没有统一表——改口径时要逐个看。

## 依赖

`node:fs` / `node:os` / `node:path` / `node:url` + 全部 `lib/*`。**不直接 spawn 外部命令**：`gh` / `git` / `pnpm` 都通过 `lib/` 的封装注入（`deps.runner`）。

`deps` 的形状（测试用）：`{ runner, cwd, stdout, stderr, env }`。

## 修改本模块的注意事项

1. **加子命令要改四处**：`SUBCOMMANDS` → `IMPLEMENTED`（否则报未实现）→ `HELP` → `docs/CONTRACT.md` §3.2/§3.3 + 测试。有子动作的（`review` / `deploy` / `kb` / `lock` / `shim` / `hooks`）在 `run*` 里再分派。
2. **加参数要改两处**：对应 `*_FLAGS` 集合 + `HELP`；如果影响契约（新选项、新语义）还要改契约。
3. **`run*` 只做编排**：出现「怎么判定 / 怎么拼命令 / 怎么序列化」就是在复制 lib 的规则。
4. **`decideGate` 与 `lib/merge.mjs` 的 `decideGate` 是两份实现**（前者给 `gate` 子命令用，后者给 `merge` 用），规则必须一致；改一处要看另一处。注意两处的错误码形状不同（CLI 返回 `{code, skipped, lines}`，merge 返回 `{ok, code, detail}`）。
5. **`requestOf`** 兼容两种请求形态：插件信封 `{request, stats}` 与扁平对象。新增请求字段时两种形态都要能读。
6. **不要在这里加日志**：包没有日志系统，所有输出都是面向人的 stdout/stderr。

## 相关测试

`test/cli.test.mjs`（811 行，覆盖各子命令的参数与输出）、`test/contract.test.mjs`（真实子进程行为）、`test/review-cmd.test.mjs`、`test/post-review.test.mjs`、`test/record-name.test.mjs`。
