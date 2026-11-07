#!/usr/bin/env node
/**
 * 源码指纹：对 `lib/**`、`bin/**`、`templates/**`、`package.json` 的
 * 「相对路径 + 文件内容」按路径字典序拼接后做 sha256。
 *
 * 只看内容、不看 mtime/权限/所有者，因此同一份源码在任何机器上算出同一个值。
 * 消费方 link 的是 `dist/pkg`，打包时把该指纹写进 `build.json.sourceHash`，
 * 运行时（`lib/dist-freshness.mjs`）重算比对，源码改了却忘 `pnpm pack` 就会立刻失败。
 *
 * 实现放在 `lib/dist-freshness.mjs`（本文件只做 re-export + CLI）：
 * 打包后的包里没有 `scripts/`（`package.json` 的 `files` 未列），运行时必须能从包内 import。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sourceHash } from '../lib/dist-freshness.mjs'

export { sourceHash }

// 直接执行（`node scripts/source-hash.mjs [root]`）时打印指纹；被 import 时无副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd()
  process.stdout.write(`${sourceHash(root)}\n`)
}
