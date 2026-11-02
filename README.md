# dsh-pipeline

统一交付与审核流程的单一实现，包名 `@guraul/dsh-pipeline`。
`bin/cli.mjs` 负责参数分发，流程与外部命令封装在 `lib/`。
已实现：`gate` / `merge` / `record` / `status` / `task` / `pr`（`prepare` 未实现）。
设计与版本策略见下。

- ADR：`self-dsh-plugins` 的 [docs/adr/0003-pipeline-单一实现与版本策略.md](https://github.com/guraul/self-dsh-plugins/blob/main/docs/adr/0003-pipeline-%E5%8D%95%E4%B8%80%E5%AE%9E%E7%8E%B0%E4%B8%8E%E7%89%88%E6%9C%AC%E7%AD%96%E7%95%A5.md)

## CI

`.github/workflows/ci.yml` 在 `push`（任意分支）与 `pull_request` 上跑 `node --test`（Node 24，pnpm `--frozen-lockfile`）。

**CI 只跑测试；审核闸门与合并只在本地。** 按 ADR-0003 §5，`gate` / `merge` 属于本地闸门，不在 CI 中执行，CI 也不跑 `scripts/pack.sh`、不上传任何产物。

## 本仓怎么合并自己的 PR

本仓 dogfood 自己的闸门：PR 一律走 `merge`，不手工点合并。

**本仓的高风险只列了 `.github/**`（改 CI 本身）**：`bin/**`、`lib/**`、`scripts/**` 都是本仓日常代码，走正常的 `record → merge`，不会因为「改了主路径」被要求人工放行。高风险的含义是「例外路径」，不是「主要路径」。

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
