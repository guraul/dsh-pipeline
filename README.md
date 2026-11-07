# dsh-pipeline

统一交付与审核流程的单一实现，包名 `@guraul/dsh-pipeline`。
`bin/cli.mjs` 负责参数分发，流程与外部命令封装在 `lib/`。
已实现：`task` / `pr` / `review`（`prepare` / `prompt` / `publish`）/ `record` / `gate` / `merge` / `status` / `doctor` / `selftest` / `lock`（`write` / `check`）/ `shim` / `hooks` / `check-all` / `deploy`（`init` / `check`）；顶层 `prepare` 占位已按契约删除。
设计与版本策略见下。

- ADR：`self-dsh-plugins` 的 [docs/adr/0003-pipeline-单一实现与版本策略.md](https://github.com/guraul/self-dsh-plugins/blob/main/docs/adr/0003-pipeline-%E5%8D%95%E4%B8%80%E5%AE%9E%E7%8E%B0%E4%B8%8E%E7%89%88%E6%9C%AC%E7%AD%96%E7%95%A5.md)

## CI

`.github/workflows/ci.yml` 在 `push`（任意分支）与 `pull_request` 上跑 `node --test`（Node 24，pnpm `--frozen-lockfile`）。

**CI 只跑测试；审核闸门与合并只在本地。** 按 ADR-0003 §5，`gate` / `merge` 属于本地闸门，不在 CI 中执行，CI 也不跑 `scripts/pack.sh`、不上传任何产物。

## 没有 review.sh 的消费仓：`review` 一趟出请求与记录

`review` 把「生成审核请求 → 判定落成记录」收进本包，消费仓不必再跨仓调 `dsh-subagents`：

```bash
# 1) 生成审核请求：用 gh 取 PR 的 head 提交、改动文件与 diff，
#    写 <root>/.tmp/review/<N>/request.json（含 12 位 base32 nonce）
#    stdout 三行：请求文件路径、nonce、head 前 7 位
dsh-pipeline review prepare --pr <N> [--root <dir>] [--model <名>] [--round <n>] [--out <文件>]

# 2) 复核后转交 record 落盘：<root>/.dsh-web/reviews/<N>-<sha>.json
dsh-pipeline review publish --pr <N> --response <响应文件> [--request <文件>] [--round <n>] [--root <dir>] [--model <名>] [--provider <名>] [--form <名>]
```

- 请求 JSON 字段：`{pr, head_sha, round, nonce, model, provider, form, files, diff}`；`nonce` 是 12 位 base32（`A-Z2-7`）一次性标记。`.tmp/` 已被忽略，请求文件不入库。
- `publish` 复核后转交 `record` 落盘（复用 `record`，不另起一套落盘逻辑）：判定行解析不出、或判定 SHA 与请求不符时**仍写一条 ESCALATE 记录**并退出 1，审计轨迹不丢。
- `--request` 缺省为 `<root>/.tmp/review/<N>/request.json`；`--round` 与请求里的 `round` 不一致时报错退出 2（拿错请求文件当场失败），没给则沿用请求里的 `round`。
- **落盘口径**：`--root` 缺省定位**主工作区**（`git rev-parse --git-common-dir` 的父目录）——请求落 `<root>/.tmp/review/<N>/`、记录落 `<root>/.dsh-web/reviews/`，都写进主仓，不会随工作树（worktree）清理被删。git 定位不到（非仓库 / git 失败）才退回当前目录；显式 `--root` 永远优先。
  这条口径与 `selftest` / `status` / `shim` / `hooks` 共用 `resolveMainWorktreeRoot`：在 task worktree 里直接跑本包，记录也落主仓。

**消费仓接入现状**：`agent-mobile`、`homebase` 已有 `scripts/pipeline/review.sh` 转发壳（只做参数校验再转给本包）；`self-dsh-plugins` 仍用自有实现（多 `--facts` / `--include` / 提示词生成），属已知欠账，正在统一到本包。

## 本仓怎么合并自己的 PR

本仓 dogfood 自己的闸门：PR 一律走 `merge`，不手工点合并。

**本仓配置的 `highRisk` 只追加了 `.github/**`**（改 CI 本身）：`bin/**`、`lib/**`、`scripts/**` 都是本仓日常代码，走正常的 `record → merge`，不会因为「改了主路径」被要求人工放行。但要注意 `highRisk` 是**追加**语义——`lib/policy.mjs` 的默认清单（`AGENTS.md`、`scripts/pipeline/**`、`docs/pipeline/**`、`**/.gitignore`、`**/package.json` 的依赖变更等）**恒生效**，所以本仓改这些路径**同样**属高风险、需要人工放行。高风险的含义是「例外路径」，不是「主要路径」。

审核记录由 `self-dsh-plugins` 的 reviewer 产出（跨仓调用，`<self-dsh-plugins>` 是那份检出的路径）：

```bash
node <self-dsh-plugins>/dsh-subagents/lib/cli.js prepare --pr <N> --root <本仓>
```

拿到记录后在本仓合并：

```bash
dsh-pipeline merge --pr <N> --record <记录>
```

`merge` 会读 `.dsh/pipeline.json` 的 `repo`（`guraul/dsh-pipeline`），用 `gh pr checks` 校验 CI，再校验记录与 PR 的 head 提交是否一致；任一条不满足即拒绝合并。

合并后收尾时，若主工作区仍停在 PR 分支：工作区干净会自动切回 `main` 再快进；有未提交改动则不改动现场，只跳过快进并提示手动切换，本地分支删除被拒时同样跳过并说明。

`.dsh/pipeline.json` 的 `ci` 字段目前**没有消费方**：CI 判定走 `gh pr checks`，写它只是预留。

**命中高风险时的正式路径**是显式跳过审核，而不是手工点合并：

```bash
dsh-pipeline merge --pr <N> --no-review --reason "<原因>"
```

`--no-review` 必须配 `--reason`（与 `--record` 互斥）。这会写入一条跳过审计（`.dsh-web/reviews/skips/`），并按全局规则在 PR 上留评论说明为什么跳过；该 PR **不计入「已审核」**——它没有审核记录，追溯与统计时不得算作已审。跳过的前提、PR 评论模板与留痕细节见 `self-dsh-plugins` 的 [docs/pipeline/README.md](https://github.com/guraul/self-dsh-plugins/blob/main/docs/pipeline/README.md)。

**`--force` 的边界**：它只豁免 CI 这一步（不再调用 `gh pr checks` 校验），审核闸门完全不受影响——闸门排在 CI 之前，顺序本身就是保证，所以没有审核记录的 PR 照样过不了闸门，`--force` 也替代不了 `--record`；合并步骤里 CI 会被标成「跳过」而非「通过」。它不写跳过审计、不在 PR 上留评论，因此**不能拿它替代 `--no-review --reason`**——想跳过审核仍必须走上面那条留痕路径。统计口径上，由 `--force` 合并的 PR **不计入「已审核且 CI 通过」**（CI 是跳过的），追溯时按「人工例外」单独记录。
