#!/usr/bin/env node
/**
 * dsh-pipeline CLI 骨架。
 *
 * 只做参数分发：--help / --version 可用，子命令一律「未实现」并 exit 2。
 * 本文件不包含任何业务判定逻辑，也不引入任何依赖。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const SUBCOMMANDS = ['task', 'prepare', 'pr', 'merge', 'gate', 'record', 'status']

const HELP = `dsh-pipeline ${pkg.version} — 统一交付与审核流程的单一实现

用法: dsh-pipeline <子命令> [选项]

子命令:
  task       任务生命周期
  prepare    准备交付
  pr         创建/更新 PR
  merge      合并
  gate       门禁检查
  record     记录
  status     查看状态

选项:
  -h, --help     显示帮助
  -v, --version  显示版本

当前版本仅为骨架，所有子命令尚未实现。`

const [first] = process.argv.slice(2)

if (first === '-h' || first === '--help') {
  process.stdout.write(`${HELP}\n`)
  process.exit(0)
}

if (first === '-v' || first === '--version') {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

if (first === undefined) {
  process.stdout.write(`${HELP}\n`)
  process.exit(0)
}

if (SUBCOMMANDS.includes(first)) {
  process.stderr.write(`dsh-pipeline ${first}: 未实现\n`)
  process.exit(2)
}

process.stderr.write(`dsh-pipeline: 未知子命令 "${first}"\n\n${HELP}\n`)
process.exit(2)
