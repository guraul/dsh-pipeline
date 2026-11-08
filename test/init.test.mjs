/**
 * init：新仓库一键接入交付流程（契约 §3.2）。
 *
 * 覆盖：干净仓一次生成四件套（配置 / shim / hooks / docs）且各自校验通过、
 * 二次 init 幂等（内容不变）、--check 逐项指出缺项、手写 docs 拒绝覆盖而 --force 接管、
 * 已有配置不覆盖、repo 从 origin 推导 / 缺失时省略、workspace 展开成 checks.packages、
 * selftest --init 齐备退 0 / 缺项退 1、--check 与 --force 同用退 2。
 * 只做本地 git 操作（init / remote add），不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { DOC_REGION_BEGIN, DOCS_DIR } from '../lib/init.mjs'
import { SHIM_DIR, SHIM_ENTRIES } from '../lib/shim.mjs'

function run(argv, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    ...deps,
  })
  return { code, ...state }
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败: ${result.stderr}`)
  return result.stdout
}

/** 临时 git 仓：根 package.json + workspaces 指向 packages/*（含一个子包）。 */
function makeRepo({ remote = null, workspaces = ['packages/*'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-init-'))
  const init = spawnSync('git', ['init', root], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'demo', private: true, workspaces }, null, 2)}\n`,
  )
  mkdirSync(join(root, 'packages', 'a'), { recursive: true })
  writeFileSync(join(root, 'packages', 'a', 'package.json'), `${JSON.stringify({ name: 'a' }, null, 2)}\n`)
  if (remote !== null) git(root, 'remote', 'add', 'origin', remote)
  return root
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

test('init 一次生成四件套，且各自校验通过', () => {
  const root = makeRepo({ remote: 'git@github.com:a/b.git' })
  try {
    const result = run(['init', '--root', root])
    assert.equal(result.code, 0, result.err)

    // 1. 配置
    const config = JSON.parse(readFileSync(join(root, '.dsh', 'pipeline.json'), 'utf8'))
    assert.equal(config.repo, 'a/b')
    assert.deepEqual(config.checks.packages, ['packages/a'])

    // 2. shim
    for (const entry of SHIM_ENTRIES) assert.ok(existsSync(join(root, SHIM_DIR, entry.file)), entry.file)

    // 3. hooks
    assert.ok(existsSync(join(root, '.git', 'hooks', 'pre-push')))

    // 4. docs
    for (const file of ['README.md', 'review-loop.md']) {
      const text = readFileSync(join(root, DOCS_DIR, file), 'utf8')
      assert.ok(text.includes(DOC_REGION_BEGIN), `${file} 缺生成区标记`)
      assert.ok(text.includes('a/b'), `${file} 没渲染 repo`)
    }

    assert.equal(run(['shim', 'check', '--root', root]).code, 0)
    assert.equal(run(['hooks', 'check', '--root', root]).code, 0)
    assert.equal(run(['init', '--check', '--root', root]).code, 0)
  } finally {
    cleanup(root)
  }
})

test('二次 init 幂等：内容不变、输出全部跳过', () => {
  const root = makeRepo()
  try {
    assert.equal(run(['init', '--root', root]).code, 0)
    const files = [
      join(root, '.dsh', 'pipeline.json'),
      join(root, DOCS_DIR, 'README.md'),
      join(root, DOCS_DIR, 'review-loop.md'),
      join(root, SHIM_DIR, 'pipeline.sh'),
    ]
    const before = files.map((file) => readFileSync(file, 'utf8'))

    const second = run(['init', '--root', root])
    assert.equal(second.code, 0, second.err)
    assert.match(second.out, /跳过:/)

    const after = files.map((file) => readFileSync(file, 'utf8'))
    assert.deepEqual(after, before)
  } finally {
    cleanup(root)
  }
})

test('init --check 逐项指出缺项并退 1', () => {
  const root = makeRepo()
  try {
    const empty = run(['init', '--check', '--root', root])
    assert.equal(empty.code, 1)
    assert.match(empty.out, /✗ config/)
    assert.match(empty.out, /✗ shim/)
    assert.match(empty.out, /✗ hooks/)
    assert.match(empty.out, /✗ docs/)

    assert.equal(run(['init', '--root', root]).code, 0)
    rmSync(join(root, DOCS_DIR, 'README.md'))
    const missingDoc = run(['init', '--check', '--root', root])
    assert.equal(missingDoc.code, 1)
    assert.match(missingDoc.out, /✗ docs/)
    assert.match(missingDoc.out, /README\.md/)
  } finally {
    cleanup(root)
  }
})

test('手写 docs 拒绝覆盖，--force 才接管', () => {
  const root = makeRepo()
  try {
    assert.equal(run(['init', '--root', root]).code, 0)
    const file = join(root, DOCS_DIR, 'README.md')
    writeFileSync(file, '# 手写的说明\n')

    const refused = run(['init', '--root', root])
    assert.equal(refused.code, 1)
    assert.match(refused.err, /E_STATE/)
    assert.equal(readFileSync(file, 'utf8'), '# 手写的说明\n')

    const forced = run(['init', '--force', '--root', root])
    assert.equal(forced.code, 0, forced.err)
    assert.ok(readFileSync(file, 'utf8').includes(DOC_REGION_BEGIN))
  } finally {
    cleanup(root)
  }
})

test('已有配置不覆盖', () => {
  const root = makeRepo({ remote: 'git@github.com:a/b.git' })
  try {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    const file = join(root, '.dsh', 'pipeline.json')
    writeFileSync(file, `${JSON.stringify({ repo: 'x/y' }, null, 2)}\n`)

    assert.equal(run(['init', '--root', root]).code, 0)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).repo, 'x/y')
  } finally {
    cleanup(root)
  }
})

test('repo 推导不到时省略该字段', () => {
  const root = makeRepo()
  try {
    assert.equal(run(['init', '--root', root]).code, 0)
    const config = JSON.parse(readFileSync(join(root, '.dsh', 'pipeline.json'), 'utf8'))
    assert.equal(config.repo, undefined)
    assert.deepEqual(config.checks.packages, ['packages/a'])
  } finally {
    cleanup(root)
  }
})

test('selftest --init：齐备退 0，缺 shim 退 1', () => {
  const root = makeRepo()
  try {
    assert.equal(run(['init', '--root', root]).code, 0)
    assert.equal(run(['selftest', '--init', '--root', root]).code, 0)

    rmSync(join(root, SHIM_DIR, 'status.sh'))
    const broken = run(['selftest', '--init', '--root', root])
    assert.equal(broken.code, 1)
    assert.match(broken.err, /status\.sh/)
  } finally {
    cleanup(root)
  }
})

test('--check 与 --force 同用退 2', () => {
  const root = makeRepo()
  try {
    const result = run(['init', '--check', '--force', '--root', root])
    assert.equal(result.code, 2)
    assert.match(result.err, /E_USAGE/)
  } finally {
    cleanup(root)
  }
})

test('--root 不存在或不是目录退 2，且不创建目录树', () => {
  const missing = join(tmpdir(), `dsh-init-missing-${process.pid}-${Date.now()}`)
  const file = join(tmpdir(), `dsh-init-file-${process.pid}-${Date.now()}`)
  try {
    const result = run(['init', '--root', missing])
    assert.equal(result.code, 2)
    assert.match(result.err, /E_USAGE/)
    assert.equal(existsSync(missing), false, '不能替调用方创建目录树')

    const checked = run(['init', '--check', '--root', missing])
    assert.equal(checked.code, 2)
    assert.equal(existsSync(missing), false)

    writeFileSync(file, 'x')
    const asFile = run(['init', '--root', file])
    assert.equal(asFile.code, 2)
    assert.match(asFile.err, /不是目录/)
  } finally {
    rmSync(missing, { recursive: true, force: true })
    rmSync(file, { force: true })
  }
})

test('预演失败时一项都不写（配置非法）', () => {
  const root = makeRepo()
  try {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'pipeline.json'), '{ 坏 JSON\n')

    const result = run(['init', '--root', root])
    assert.equal(result.code, 2)
    assert.match(result.err, /E_CONFIG/)
    assert.equal(existsSync(join(root, SHIM_DIR)), false, '配置非法时不该写 shim')
    assert.equal(existsSync(join(root, DOCS_DIR)), false, '配置非法时不该写 docs')
    assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-push')), false, '配置非法时不该装钩子')
  } finally {
    cleanup(root)
  }
})

test('预演失败时一项都不写（shim 冲突）', () => {
  const root = makeRepo()
  try {
    mkdirSync(join(root, SHIM_DIR), { recursive: true })
    writeFileSync(join(root, SHIM_DIR, 'pipeline.sh'), '#!/bin/sh\necho hand-written\n')

    const result = run(['init', '--root', root])
    assert.equal(result.code, 1)
    assert.match(result.err, /E_STATE/)
    assert.equal(existsSync(join(root, '.dsh', 'pipeline.json')), false, 'shim 冲突时不该写配置')
    assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-push')), false, 'shim 冲突时不该装钩子')
    assert.equal(existsSync(join(root, DOCS_DIR)), false, 'shim 冲突时不该写 docs')
  } finally {
    cleanup(root)
  }
})

test('预演失败时一项都不写（钩子冲突）', () => {
  const root = makeRepo()
  try {
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const result = run(['init', '--root', root])
    assert.equal(result.code, 1)
    assert.match(result.err, /E_STATE/)
    assert.equal(existsSync(join(root, '.dsh', 'pipeline.json')), false, '钩子冲突时不该写配置')
    assert.equal(existsSync(join(root, SHIM_DIR)), false, '钩子冲突时不该写 shim')
    assert.equal(existsSync(join(root, DOCS_DIR)), false, '钩子冲突时不该写 docs')
  } finally {
    cleanup(root)
  }
})
