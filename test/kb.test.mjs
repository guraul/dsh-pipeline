/**
 * 知识库三件套（kb check / init / refresh / impact）的测试（issue #154）。
 *
 * 覆盖：
 *   - 页眉解析：canonical 两行 + 三种旧格式 + W_LEGACY_HEADER；
 *   - 12 类错误码：文档级 7 类（E_NO_STAMP / E_BAD_DATE / E_STAMP_ORPHAN / E_NO_COVERAGE /
 *     E_DEAD_GLOB / E_BROAD_GLOB / E_FORBIDDEN_PATH）+ 入口级 5 类（E_NO_AGENTS / E_NO_KB_ROUTE /
 *     E_ROUTE_DEAD / E_ROUTE_MISMATCH / E_NAV_MISMATCH）；
 *   - --exclude / --strict / --allow-missing / --json；
 *   - 退出码 0 / 1 / 2 / 3；
 *   - init 只读（不写 AGENTS.md、不写 KB）、已有 KB 退 1、--out 落文件；
 *   - refresh 无 KB 退 1、--doc 过滤、未知 --doc 退 2；
 *   - impact 的 --staged / --range / 互斥 / 删除 / 改名 / --json+--out。
 *
 * 全部用临时 git 仓库 + 本地提交，不触网、不碰真实仓库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { DOC_ERROR_CODES, ENTRY_ERROR_CODES, parseHeader } from '../lib/kb.mjs'

const KB = 'docs/knowledge-base'
const TODAY = '2026-11-09'

/** 在进程内跑 CLI，捕获 stdout / stderr。 */
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

function commitAll(root, message) {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD').trim()
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

/** 最小仓库：package.json + lib/a.mjs，已初始化 git 但还没有提交。 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kb-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'kb@example.com')
  git(root, 'config', 'user.name', 'kb')
  writeFileSync(join(root, 'package.json'), '{"name":"demo","scripts":{"test":"node --test"}}\n')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  commitAll(root, '初始')
  return root
}

function headerLines({ date = '2026-11-01', stamp, coverage = ['lib/a.mjs'] }) {
  return `> 最后更新: ${date} | commit: \`${stamp}\`\n> 覆盖路径: ${coverage.map((item) => `\`${item}\``).join(', ')}`
}

/** 写一篇 canonical 页眉的文档。 */
function writeDoc(root, rel, options = {}) {
  const {
    title = '文档',
    date = '2026-11-01',
    stamp,
    coverage = ['lib/a.mjs'],
    body = '',
    header = true,
  } = options
  const file = join(root, KB, rel)
  mkdirSync(dirname(file), { recursive: true })
  const head = header ? `${headerLines({ date, stamp, coverage })}\n\n` : ''
  writeFileSync(file, `# ${title}\n\n${head}${body}\n`)
}

const INDEX_BODY = `## 文档导航

| 文档 | 适用场景 |
|---|---|
| \`INDEX.md\`（本文） | 入口 |
| \`ARCHITECTURE.md\` | 架构 |
| \`API.md\` | 接口 |
| \`DATA.md\` | 数据 |
| \`OPERATIONS.md\` | 运维 |
| \`CONVENTIONS.md\` | 约定 |
| \`modules/core.md\` | 核心模块 |
`

const AGENTS_TEXT = `# demo

## 知识库路由

| 场景 | 加载文档 |
|---|---|
| 入口 | \`${KB}/INDEX.md\`（每次对话优先） |
| 核心模块 | \`${KB}/modules/core.md\` |
`

const TOP_LEVEL = ['ARCHITECTURE.md', 'API.md', 'DATA.md', 'OPERATIONS.md', 'CONVENTIONS.md']

/** 干净仓库：KB 7 篇 + AGENTS 路由 + INDEX 导航全一致，stamp 是 HEAD 的祖先。 */
function makeCleanRepo() {
  const root = makeRepo()
  const stamp = git(root, 'rev-parse', 'HEAD').trim()
  writeDoc(root, 'INDEX.md', { title: '索引', stamp, body: INDEX_BODY })
  for (const name of TOP_LEVEL) writeDoc(root, name, { title: name, stamp })
  writeDoc(root, 'modules/core.md', { title: '核心模块', stamp })
  writeFileSync(join(root, 'AGENTS.md'), AGENTS_TEXT)
  commitAll(root, '知识库基线')
  return { root, stamp }
}

function check(root, extra = [], deps = {}) {
  return run(['kb', 'check', '--root', root, ...extra], deps)
}

// ---------------------------------------------------------------- 页眉解析

test('parseHeader：canonical 两行解析成功，没有警告', () => {
  const parsed = parseHeader(
    `# 标题\n\n> 最后更新: 2026-11-01 | commit: \`abc1234\`\n> 覆盖路径: \`lib/a.mjs\`\n`,
    { today: TODAY },
  )
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.canonical, true)
  assert.equal(parsed.date, '2026-11-01')
  assert.equal(parsed.commit, 'abc1234')
  assert.deepEqual(parsed.coverage, ['lib/a.mjs'])
})

test('parseHeader：三种旧格式都能解析，只给 W_LEGACY_HEADER', () => {
  const variants = [
    '> 最后更新: 2026-10-25 · commit `c232168`',
    '**最后更新**：2026-11-06 · 对应提交 `cf7544f`',
    '> 最后更新：2026-10-12 · commit 6d432c5 · 说明文字',
  ]
  for (const line of variants) {
    const parsed = parseHeader(`# 标题\n\n${line}\n> 覆盖路径: \`lib/a.mjs\`\n`, { today: TODAY })
    assert.deepEqual(parsed.errors, [], line)
    assert.deepEqual(parsed.warnings, ['W_LEGACY_HEADER'], line)
    assert.equal(parsed.canonical, false)
    assert.match(parsed.commit, /^[0-9a-f]{7}$/)
  }
})

test('parseHeader：没有页眉 → E_NO_STAMP；日期不合法 / 晚于今天 → E_BAD_DATE', () => {
  assert.equal(parseHeader('# 只有标题\n', { today: TODAY }).errors[0].code, 'E_NO_STAMP')

  const badMonth = parseHeader(
    '# 标题\n\n> 最后更新: 2026-13-01 | commit: `abc1234`\n> 覆盖路径: `lib/a.mjs`\n',
    { today: TODAY },
  )
  assert.ok(badMonth.errors.some((error) => error.code === 'E_BAD_DATE'))

  const future = parseHeader(
    '# 标题\n\n> 最后更新: 2099-01-01 | commit: `abc1234`\n> 覆盖路径: `lib/a.mjs`\n',
    { today: TODAY },
  )
  assert.ok(future.errors.some((error) => error.code === 'E_BAD_DATE'))
})

test('parseHeader：commit 位置写提交标题（不是十六进制 sha）→ E_NO_STAMP', () => {
  const parsed = parseHeader(
    '# 标题\n\n> 最后更新: 2026-11-01 | commit: 修正文案\n> 覆盖路径: `lib/a.mjs`\n',
    { today: TODAY },
  )
  assert.ok(parsed.errors.some((error) => error.code === 'E_NO_STAMP'))
})

test('parseHeader：缺覆盖路径行 → E_NO_COVERAGE', () => {
  const parsed = parseHeader('# 标题\n\n> 最后更新: 2026-11-01 | commit: `abc1234`\n', {
    today: TODAY,
  })
  assert.ok(parsed.errors.some((error) => error.code === 'E_NO_COVERAGE'))
})

test('错误码清单：文档级 7 类、入口级 5 类', () => {
  assert.equal(DOC_ERROR_CODES.length, 7)
  assert.equal(ENTRY_ERROR_CODES.length, 5)
  assert.equal(new Set([...DOC_ERROR_CODES, ...ENTRY_ERROR_CODES]).size, 12)
})

// ---------------------------------------------------------------- check：文档级

test('kb check：干净仓库退 0，--json 形状稳定', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))

  const human = check(root)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /kb: 检查通过/)

  const json = check(root, ['--json'])
  assert.equal(json.code, 0)
  const payload = JSON.parse(json.out)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.entry, { agents: true, kbRoute: true, errors: [] })
  assert.equal(payload.summary.docs, 7)
  assert.equal(payload.summary.errors, 0)
  assert.ok(Array.isArray(payload.docs))
})

test('E_NO_STAMP：缺页眉的文档退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', { title: '坏文档', stamp, header: false })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_NO_STAMP/)
})

test('E_BAD_DATE：日期晚于今天退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', { title: '坏文档', stamp, date: '2099-01-01' })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_BAD_DATE/)
})

test('E_STAMP_ORPHAN：stamp 不存在（squash 后的悬空 sha）退 1', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', { title: '坏文档', stamp: 'a'.repeat(40) })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_STAMP_ORPHAN/)
})

test('E_NO_COVERAGE：只有页眉没有覆盖路径退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(
    join(root, KB, 'modules', 'broken.md'),
    `# 坏文档\n\n> 最后更新: 2026-11-01 | commit: \`${stamp}\`\n`,
  )
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_NO_COVERAGE/)
})

test('E_DEAD_GLOB：glob 命中 0 个已跟踪文件退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', {
    title: '坏文档',
    stamp,
    coverage: ['lib/nope.mjs'],
  })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_DEAD_GLOB/)
})

test('E_BROAD_GLOB：单条 glob 命中超过 30 个文件退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  mkdirSync(join(root, 'lib', 'broad'), { recursive: true })
  for (let index = 0; index < 31; index += 1) {
    writeFileSync(join(root, 'lib', 'broad', `f${index}.mjs`), 'export {}\n')
  }
  commitAll(root, '加 31 个文件')
  writeDoc(root, 'modules/broken.md', {
    title: '坏文档',
    stamp,
    coverage: ['lib/broad/*.mjs'],
  })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_BROAD_GLOB/)
})

test('E_FORBIDDEN_PATH：覆盖路径指向 docs/** 退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', {
    title: '坏文档',
    stamp,
    coverage: ['docs/readme.md'],
  })
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_FORBIDDEN_PATH/)
})

// ---------------------------------------------------------------- check：入口级

test('E_NO_AGENTS：仓库根没有 AGENTS.md 退 1', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  rmSync(join(root, 'AGENTS.md'))
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_NO_AGENTS/)
})

test('E_NO_KB_ROUTE：AGENTS.md 没有 INDEX 路由退 1', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'AGENTS.md'), '# demo\n\n没有知识库路由。\n')
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_NO_KB_ROUTE/)
})

test('E_ROUTE_DEAD：路由指向不存在的文档退 1', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(
    join(root, 'AGENTS.md'),
    `${AGENTS_TEXT}| 幽灵模块 | \`${KB}/modules/ghost.md\` |\n`,
  )
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_ROUTE_DEAD/)
})

test('E_ROUTE_MISMATCH：模块文档没出现在 AGENTS 路由表退 1', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/extra.md', { title: '额外模块', stamp })
  const indexFile = join(root, KB, 'INDEX.md')
  const index = readFileSync(indexFile, 'utf8').replace(
    '| `modules/core.md` | 核心模块 |',
    '| `modules/core.md` | 核心模块 |\n| `modules/extra.md` | 额外模块 |',
  )
  writeFileSync(indexFile, index)
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_ROUTE_MISMATCH/)
})

test('E_NAV_MISMATCH：INDEX 文档导航漏掉实际文档退 1', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const indexFile = join(root, KB, 'INDEX.md')
  writeFileSync(indexFile, readFileSync(indexFile, 'utf8').replace('| `modules/core.md` | 核心模块 |', ''))
  const result = check(root)
  assert.equal(result.code, 1)
  assert.match(result.out, /E_NAV_MISMATCH/)
})

// ---------------------------------------------------------------- check：开关与退出码

test('W_LEGACY_HEADER：旧格式页眉可解析，不失败', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(
    join(root, KB, 'modules', 'core.md'),
    `# 核心模块\n\n> 最后更新: 2026-11-01 · commit \`${stamp}\`\n> 覆盖路径: \`lib/a.mjs\`\n`,
  )
  const result = check(root)
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /W_LEGACY_HEADER/)
})

test('--exclude：被排除的坏文档不参与检查', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', { title: '坏文档', header: false })
  assert.equal(check(root).code, 1)
  assert.equal(check(root, ['--exclude', 'modules/broken.md']).code, 0)
})

test('--strict：stale > 0 时退 1，缺省只报告不失败', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 2\n')
  commitAll(root, '改 lib/a.mjs')

  const relaxed = check(root)
  assert.equal(relaxed.code, 0, relaxed.out)
  assert.match(relaxed.out, /stale 1/)

  const strict = check(root, ['--strict'])
  assert.equal(strict.code, 1)
  assert.match(strict.out, /--strict/)
})

test('--allow-missing：知识库不存在时退 0；不加则退 2', (t) => {
  const root = makeRepo()
  t.after(() => cleanup(root))
  const missing = check(root)
  assert.equal(missing.code, 2)
  assert.match(missing.err, /E_CONFIG/)

  const allowed = check(root, ['--allow-missing'])
  assert.equal(allowed.code, 0)
  assert.match(allowed.out, /跳过/)
})

test('退出码 2：未知选项 / 未知动作 / 缺动作', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  assert.equal(check(root, ['--nope']).code, 2)
  assert.equal(run(['kb', 'check', '--root', root, '--kb-dir', '/abs/path']).code, 2)
  assert.equal(run(['kb']).code, 2)
  assert.equal(run(['kb', 'nope', '--root', root]).code, 2)
})

test('退出码 3：git 调用失败按环境错误处理', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const result = check(root, [], {
    runner: () => {
      throw new Error('git 挂了')
    },
  })
  assert.equal(result.code, 3)
  assert.match(result.err, /E_ENV/)
})

// ---------------------------------------------------------------- init

test('kb init：无知识库时输出提示词与 AGENTS 草稿，且不写任何文件', (t) => {
  const root = makeRepo()
  t.after(() => cleanup(root))
  const result = run(['kb', 'init', '--root', root])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /# 知识库初始化任务/)
  assert.match(result.out, /## 仓库事实/)
  assert.match(result.out, /## 覆盖路径契约/)
  assert.match(result.out, /AGENTS\.md 草稿（只打印，不落盘/)
  assert.match(result.out, /kb check --root/)
  assert.equal(git(root, 'status', '--porcelain').trim(), '', 'init 不允许写任何文件')
})

test('kb init：已有知识库退 1，提示改用 refresh', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const result = run(['kb', 'init', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.err, /kb refresh/)
})

test('kb init --out：提示词落文件，草稿仍打印', (t) => {
  const root = makeRepo()
  const out = join(root, 'init-prompt.md')
  t.after(() => cleanup(root))
  const result = run(['kb', 'init', '--root', root, '--out', out])
  assert.equal(result.code, 0, result.err)
  const written = readFileSync(out, 'utf8')
  assert.match(written, /# 知识库初始化任务/)
  assert.match(result.out, /AGENTS\.md 草稿/)
})

// ---------------------------------------------------------------- refresh

test('kb refresh：无知识库退 1', (t) => {
  const root = makeRepo()
  t.after(() => cleanup(root))
  const result = run(['kb', 'refresh', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.err, /kb init/)
})

test('kb refresh：提示词包含写作指令、结构违规与 stale 原文', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/broken.md', { title: '坏文档', stamp, header: false })
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 3\n')
  commitAll(root, '改 lib/a.mjs 触发 stale')

  const result = run(['kb', 'refresh', '--root', root])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /## 写作指令（全文/)
  assert.match(result.out, /E_NO_STAMP/)
  assert.match(result.out, /## 每篇的 stale 原文/)
  assert.match(result.out, /改 lib\/a\.mjs 触发 stale/)
  assert.match(result.out, /## 禁止项/)
  assert.match(result.out, /不许只改 stamp 不改内容/)
})

test('kb refresh --doc：只处理指定文档；未知文档退 2', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const json = run(['kb', 'refresh', '--root', root, '--doc', 'modules/core.md', '--json'])
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out).docs, ['modules/core.md'])

  assert.equal(run(['kb', 'refresh', '--root', root, '--doc', 'modules/nope.md']).code, 2)
})

// ---------------------------------------------------------------- impact

test('kb impact --staged：命中覆盖 lib/a.mjs 的文档', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 4\n')
  git(root, 'add', 'lib/a.mjs')

  const result = run(['kb', 'impact', '--root', root, '--staged'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /modules\/core\.md/)
  assert.match(result.out, /lib\/a\.mjs/)

  const json = run(['kb', 'impact', '--root', root, '--staged', '--json'])
  const payload = JSON.parse(json.out)
  assert.equal(payload.ok, true)
  assert.equal(payload.mode, 'staged')
  assert.ok(payload.affected.some((item) => item.doc === 'modules/core.md'))
})

test('kb impact --range：区间内改动命中文档；无知识库退 2', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 5\n')
  commitAll(root, '改 a')

  const result = run(['kb', 'impact', '--root', root, '--range', `${stamp}..HEAD`])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /modules\/core\.md/)

  const empty = makeRepo()
  t.after(() => cleanup(empty))
  assert.equal(run(['kb', 'impact', '--root', empty, '--staged']).code, 2)
})

test('kb impact：--staged 与 --range 互斥，非法区间退 2', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  assert.equal(run(['kb', 'impact', '--root', root, '--staged', '--range', 'a..b']).code, 2)
  assert.equal(run(['kb', 'impact', '--root', root, '--range', 'not-a-range']).code, 2)
})

test('kb impact --range：删除被覆盖文件也能报出文档（#163）', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  git(root, 'rm', 'lib/a.mjs')
  commitAll(root, '删除 a')

  const result = run(['kb', 'impact', '--root', root, '--range', `${stamp}..HEAD`, '--json'])
  assert.equal(result.code, 0, result.err)
  const payload = JSON.parse(result.out)
  assert.ok(payload.affected.some((item) => item.doc === 'modules/core.md'))
  assert.ok(payload.changed.includes('lib/a.mjs'))
})

test('kb impact --range：改名时旧路径与新路径都能报出（#163）', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/renamed.md', { title: '改名后', stamp, coverage: ['lib/b.mjs'] })
  commitAll(root, '加改名后文档')
  const base = git(root, 'rev-parse', 'HEAD').trim()

  git(root, 'mv', 'lib/a.mjs', 'lib/b.mjs')
  commitAll(root, '改名 a→b')

  const payload = JSON.parse(
    run(['kb', 'impact', '--root', root, '--range', `${base}..HEAD`, '--json']).out,
  )
  const docs = payload.affected.map((item) => item.doc)
  assert.ok(docs.includes('modules/core.md'), '旧路径应命中旧文档')
  assert.ok(docs.includes('modules/renamed.md'), '新路径应命中新文档')
  assert.ok(payload.changed.includes('lib/a.mjs'))
  assert.ok(payload.changed.includes('lib/b.mjs'))
})

test('kb impact：--json 与 --out 同时给，文件与 stdout 都是 JSON（#163）', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 6\n')
  git(root, 'add', 'lib/a.mjs')
  const out = join(root, '.tmp', 'impact.json')

  const result = run(['kb', 'impact', '--root', root, '--staged', '--json', '--out', out])
  assert.equal(result.code, 0, result.err)
  const stdout = JSON.parse(result.out)
  const file = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(file, stdout)
  assert.equal(stdout.ok, true)
  assert.ok(stdout.affected.some((item) => item.doc === 'modules/core.md'))

  // 只给 --out 时：文件仍是 JSON，stdout 保持人读摘要。
  const human = run(['kb', 'impact', '--root', root, '--staged', '--out', out])
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /影响分析/)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), stdout)
})

test('kb impact：目录写法与 glob 写法都能命中删除（#163）', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/dir.md', { title: '目录', stamp, coverage: ['lib'] })
  writeDoc(root, 'modules/glob.md', { title: 'Glob', stamp, coverage: ['lib/**'] })
  commitAll(root, '目录 / glob 文档')
  const base = git(root, 'rev-parse', 'HEAD').trim()

  git(root, 'rm', 'lib/a.mjs')
  commitAll(root, '删除 a')

  const payload = JSON.parse(
    run(['kb', 'impact', '--root', root, '--range', `${base}..HEAD`, '--json']).out,
  )
  const docs = payload.affected.map((item) => item.doc)
  assert.ok(docs.includes('modules/dir.md'), '目录写法应命中')
  assert.ok(docs.includes('modules/glob.md'), 'glob 写法应命中')
  assert.ok(docs.includes('modules/core.md'), '字面写法应命中')
})

// ---------------------------------------------------------------- 审核修复的回归

test('git 不可用（非 git 目录）按环境错误退 3，不报成 E_DEAD_GLOB', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kb-nogit-'))
  t.after(() => cleanup(root))
  writeDoc(root, 'INDEX.md', { title: '索引', stamp: 'abc1234', body: INDEX_BODY })
  const result = check(root)
  assert.equal(result.code, 3)
  assert.match(result.err, /E_ENV/)
  assert.doesNotMatch(result.out, /E_DEAD_GLOB/)
})

test('覆盖路径带空格（合法文件名）可以正常展开', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeFileSync(join(root, 'lib', 'a b.mjs'), 'export const b = 1\n')
  commitAll(root, '加带空格的文件')
  writeFileSync(
    join(root, KB, 'modules', 'core.md'),
    `# 核心模块\n\n> 最后更新: 2026-11-01 | commit: \`${git(root, 'rev-parse', 'HEAD').trim()}\`\n> 覆盖路径: \`lib/a b.mjs\`\n`,
  )
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})

test('--exclude 同时过滤 INDEX 导航，排除导航里列着的文档不报 E_NAV_MISMATCH', (t) => {
  const { root, stamp } = makeCleanRepo()
  t.after(() => cleanup(root))
  writeDoc(root, 'modules/extra.md', { title: '额外模块', stamp })
  const indexFile = join(root, KB, 'INDEX.md')
  writeFileSync(
    indexFile,
    readFileSync(indexFile, 'utf8').replace(
      '| `modules/core.md` | 核心模块 |',
      '| `modules/core.md` | 核心模块 |\n| `modules/extra.md` | 额外模块 |',
    ),
  )
  writeFileSync(
    join(root, 'AGENTS.md'),
    `${AGENTS_TEXT}| 额外模块 | \`${KB}/modules/extra.md\` |\n`,
  )
  assert.equal(check(root).code, 0)
  assert.equal(check(root, ['--exclude', 'modules/extra.md']).code, 0)
})

test('INDEX 导航写全仓相对路径（docs/knowledge-base/…）也能识别', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const indexFile = join(root, KB, 'INDEX.md')
  const text = readFileSync(indexFile, 'utf8')
  const rewritten = text
    .replace(/`(INDEX|ARCHITECTURE|API|DATA|OPERATIONS|CONVENTIONS)\.md`/g, `\`${KB}/$1.md\``)
    .replace(/`modules\/(core)\.md`/g, `\`${KB}/modules/$1.md\``)
  assert.match(rewritten, new RegExp(`\`${KB}/INDEX\\.md\``), '导航必须真的改写成全仓相对路径')
  assert.match(rewritten, new RegExp(`\`${KB}/modules/core\\.md\``))
  writeFileSync(indexFile, rewritten)
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})

// ---------------------------------------------------------------- 导航解析：格式兼容

/** 把 INDEX 的导航表改写成给定格式（保留其余正文）。 */
function rewriteNav(root, formatter) {
  const indexFile = join(root, KB, 'INDEX.md')
  const text = readFileSync(indexFile, 'utf8')
  const rows = [
    ['INDEX.md', '入口'],
    ['ARCHITECTURE.md', '架构'],
    ['API.md', '接口'],
    ['DATA.md', '数据'],
    ['OPERATIONS.md', '运维'],
    ['CONVENTIONS.md', '约定'],
    ['modules/core.md', '核心模块'],
  ]
  const body = rows.map(([path, label]) => formatter(path, label)).join('\n')
  const rewritten = text.replace(
    /## 文档导航[\s\S]*$/,
    `## 文档导航\n\n${body}\n`,
  )
  writeFileSync(indexFile, rewritten)
  return rewritten
}

test('INDEX 导航是 Markdown 链接表（memx 风格）也能识别', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const rewritten = rewriteNav(root, (path, label) => `| [${path}](${path}) | ${label} |`)
  assert.match(rewritten, /\[INDEX\.md\]\(INDEX\.md\)/)
  assert.match(rewritten, /\[modules\/core\.md\]\(modules\/core\.md\)/)
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})

test('INDEX 导航是反引号表（dsh-pipeline 风格）能识别', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const rewritten = rewriteNav(root, (path, label) => `| \`${path}\` | ${label} |`)
  assert.match(rewritten, /`modules\/core\.md`/)
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})

test('INDEX 导航是纯文本列表也能识别', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const rewritten = rewriteNav(root, (path) => `- ${path}`)
  assert.match(rewritten, /^- modules\/core\.md$/m)
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})

test('INDEX 导航是链接 + 全仓相对路径也能识别', (t) => {
  const { root } = makeCleanRepo()
  t.after(() => cleanup(root))
  const rewritten = rewriteNav(
    root,
    (path, label) => `| [${path}](${KB}/${path}) | ${label} |`,
  )
  assert.match(rewritten, new RegExp(`\\[modules/core\\.md\\]\\(${KB}/modules/core\\.md\\)`))
  const result = check(root)
  assert.equal(result.code, 0, result.out)
})
