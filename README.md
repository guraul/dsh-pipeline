# dsh-pipeline

统一交付与审核流程的单一实现，包名 `@guraul/dsh-pipeline`。
`bin/cli.mjs` 负责参数分发，流程与外部命令封装在 `lib/`。
已实现：`gate` / `merge` / `record` / `status` / `task` / `pr`（`prepare` 未实现）。
设计与版本策略见下。

- ADR：`self-dsh-plugins` 的 [docs/adr/0003-pipeline-单一实现与版本策略.md](https://github.com/guraul/self-dsh-plugins/blob/main/docs/adr/0003-pipeline-%E5%8D%95%E4%B8%80%E5%AE%9E%E7%8E%B0%E4%B8%8E%E7%89%88%E6%9C%AC%E7%AD%96%E7%95%A5.md)

## CI

`.github/workflows/ci.yml` 在 `push`（任意分支）与 `pull_request` 上跑 `node --test`（Node 24，pnpm `--frozen-lockfile`）。

**CI 只跑测试；审核闸门与合并只在本地。** 按 ADR-0003 §5，`gate` / `merge` 属于本地闸门，不在 CI 中执行，CI 也不跑 `scripts/pack.sh`、不上传任何产物。
