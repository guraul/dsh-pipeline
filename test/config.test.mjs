import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  validateConfig,
} from '../lib/config.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-config-'))
}

function writeConfig(root, value) {
  const dir = join(root, '.dsh')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pipeline.json')
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8')
  return file
}

const code = (expected) => (error) => {
  assert.equal(error.code, expected)
  return true
}

test('没有配置文件时返回默认值', () => {
  const root = tmp()
  const result = loadConfig(root)
  assert.equal(result.ok, true)
  assert.deepEqual(result.config, DEFAULT_CONFIG)
})

test('默认配置不可被调用方修改（每次返回新副本）', () => {
  const first = loadConfig(tmp()).config
  first.ci.push('x')
  const second = loadConfig(tmp()).config
  assert.deepEqual(second.ci, [])
})

test('非法 repo 被拒绝', () => {
  for (const repo of ['owner', 'a/b/c', 'https://github.com/a/b', '', 'a b/c']) {
    assert.throws(() => loadConfig(tmpAfterWriting({ repo })), code('E_CONFIG'), repo)
  }
})

function tmpAfterWriting(value) {
  const root = tmp()
  writeConfig(root, value)
  return root
}

test('已知字段的合法配置被接受', () => {
  const root = tmpAfterWriting({
    repo: 'guraul/dsh-pipeline',
    ci: ['node --test'],
    highRisk: ['docs/**'],
    roles: { executor: { model: 'm1' } },
  })
  const { config } = loadConfig(root)
  assert.equal(config.repo, 'guraul/dsh-pipeline')
  assert.deepEqual(config.ci, ['node --test'])
  assert.deepEqual(config.highRisk, ['docs/**'])
  assert.deepEqual(config.roles, { executor: { model: 'm1' } })
})

test('未知顶层字段报 E_CONFIG', () => {
  assert.throws(() => validateConfig({ repo: 'a/b', unknow: 1 }), code('E_CONFIG'))
})

test('ci 必须是字符串数组', () => {
  assert.throws(() => validateConfig({ ci: 'node --test' }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ ci: ['ok', 42] }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ ci: [''] }), code('E_CONFIG'))
})

test('highRisk 必须是字符串数组', () => {
  assert.throws(() => validateConfig({ highRisk: { glob: 'x' } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ highRisk: ['ok', null] }), code('E_CONFIG'))
})

test('roles 必须是对象', () => {
  assert.throws(() => validateConfig({ roles: [] }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ roles: 'reviewer' }), code('E_CONFIG'))
})

test('worktreesDir 只接受字符串或 null，默认 null', () => {
  assert.equal(DEFAULT_CONFIG.worktreesDir, null)
  for (const value of [42, ['a'], { dir: 'x' }, true]) {
    assert.throws(() => validateConfig({ worktreesDir: value }), code('E_CONFIG'), String(value))
  }
  assert.equal(validateConfig({ worktreesDir: 'x' }).worktreesDir, 'x')
  assert.equal(validateConfig({ worktreesDir: null }).worktreesDir, null)
})

test('checks 默认 null，只接受对象或 null', () => {
  assert.equal(DEFAULT_CONFIG.checks, null)
  for (const value of ['x', 42, ['a'], true]) {
    assert.throws(() => validateConfig({ checks: value }), code('E_CONFIG'), String(value))
  }
  assert.equal(validateConfig({ checks: null }).checks, null)
  const { config } = loadConfig(tmpAfterWriting({ checks: { packages: ['pkg-a'] } }))
  assert.deepEqual(config.checks, { packages: ['pkg-a'] })
})

test('checks 里只允许 packages / exclude，且各自必须是非空字符串数组', () => {
  // 形状非法（比如 packages 写成字符串）必须报 E_CONFIG，不能静默当成没配
  assert.throws(() => validateConfig({ checks: { packages: 'x' } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ checks: { exclude: 'tools' } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ checks: { packages: ['ok', 42] } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ checks: { exclude: [''] } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ checks: { skipWithoutDeps: true } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ checks: { packages: ['a'], bogus: [] } }), code('E_CONFIG'))
  assert.deepEqual(validateConfig({ checks: { packages: ['a'], exclude: ['b'] } }).checks, {
    packages: ['a'],
    exclude: ['b'],
  })
})

test('review.tier 缺省 tools，只接受 inline | tools', () => {
  assert.deepEqual(loadConfig(tmp()).config.review, { tier: 'tools' })
  assert.deepEqual(loadConfig(tmpAfterWriting({ review: { tier: 'inline' } })).config.review, {
    tier: 'inline',
  })
  // 空对象合法：tier 缺省，由默认值补成 tools
  assert.deepEqual(validateConfig({ review: {} }).review, {})
  for (const value of ['inline', null, ['inline'], 42]) {
    assert.throws(() => validateConfig({ review: value }), code('E_CONFIG'), String(value))
  }
  for (const tier of ['readonly', 'TOOLS', '', 1, null]) {
    assert.throws(() => validateConfig({ review: { tier } }), code('E_CONFIG'), String(tier))
  }
  // review.* 的其余字段仍属目标：现在写进来就是未知字段
  assert.throws(() => validateConfig({ review: { tier: 'inline', postReview: true } }), code('E_CONFIG'))
})

test('配置文件不是合法 JSON 时报 E_CONFIG', () => {
  const root = tmp()
  writeConfig(root, '{ not json')
  assert.throws(() => loadConfig(root), code('E_CONFIG'))
})

test('mergeConfig 数组按追加语义且 base 在前', () => {
  const merged = mergeConfig(
    { ci: ['a', 'b'], highRisk: ['x'] },
    { ci: ['c'], highRisk: ['y', 'z'] },
  )
  assert.deepEqual(merged.ci, ['a', 'b', 'c'])
  assert.deepEqual(merged.highRisk, ['x', 'y', 'z'])
})

test('mergeConfig 深合并对象且不修改入参', () => {
  const base = { roles: { executor: { model: 'base', permissionMode: 'full' } } }
  const override = { roles: { executor: { model: 'override' } } }
  const merged = mergeConfig(base, override)
  assert.deepEqual(merged.roles.executor, { model: 'override', permissionMode: 'full' })
  assert.equal(base.roles.executor.model, 'base')
  assert.equal(override.roles.executor.permissionMode, undefined)
})

test('mergeConfig 标量覆盖、缺失覆盖保留 base', () => {
  const merged = mergeConfig({ repo: 'a/b' }, { repo: 'c/d', ci: ['x'] })
  assert.equal(merged.repo, 'c/d')
  assert.deepEqual(merged.ci, ['x'])
})

test('mergeConfig 拒绝非对象入参', () => {
  assert.throws(() => mergeConfig(null, {}), code('E_CONFIG'))
  assert.throws(() => mergeConfig({}, []), code('E_CONFIG'))
})

const MINIMAL_DEPLOY = {
  artifact: 'static-dir',
  service: 'serve-1',
  remoteDir: '/root/app',
  workDir: 'app',
  health: { url: 'http://127.0.0.1:1/' },
}

test('deploy 默认 null，只接受对象或 null', () => {
  assert.equal(DEFAULT_CONFIG.deploy, null)
  for (const value of ['x', 42, ['a'], true]) {
    assert.throws(() => validateConfig({ deploy: value }), code('E_CONFIG'), String(value))
  }
  assert.equal(validateConfig({ deploy: null }).deploy, null)
  const { config } = loadConfig(tmpAfterWriting({ deploy: MINIMAL_DEPLOY }))
  assert.deepEqual(config.deploy, MINIMAL_DEPLOY)
})

test('deploy 合法配置：全字段、可选项、枚举与边界值', () => {
  const full = {
    artifact: 'oci-image',
    service: 'serve-9928',
    remoteDir: '/root/project/app',
    workDir: 'app',
    artifactDir: 'dist',
    sshHost: '10.0.0.8',
    health: { url: 'http://127.0.0.1:9929/', check: 'ssh', publicUrl: 'https://app.example.com', insecure: false },
    keepReleases: 50,
  }
  assert.deepEqual(validateConfig({ deploy: full }).deploy, full)
  // 可选项缺省即未设置；枚举三值全收（oci-image 生成时才报尚未实现）
  for (const artifact of ['static-dir', 'node-standalone', 'oci-image']) {
    assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, artifact } }).deploy.artifact, artifact)
  }
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, keepReleases: 1 } }).deploy.keepReleases, 1)
  assert.equal(
    validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { url: 'u', check: 'http', insecure: true } } }).deploy.health
      .check,
    'http',
  )
})

test('deploy 字段校验：未知键、artifact 枚举、service / remoteDir / workDir 必填 → E_CONFIG', () => {
  assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, workDir: undefined } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, bogus: 1 } }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ deploy: { artifact: 'tar' } }), code('E_CONFIG'))
  const { artifact, ...noArtifact } = MINIMAL_DEPLOY
  assert.throws(() => validateConfig({ deploy: noArtifact }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, service: '' } }), code('E_CONFIG'))
  const { service: _service, ...noService } = MINIMAL_DEPLOY
  assert.throws(() => validateConfig({ deploy: noService }), code('E_CONFIG'))
  assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, workDir: 'apps/web',
      remoteDir: 'relative/path' } }), code('E_CONFIG'))
  const { remoteDir: _remoteDir, ...noRemoteDir } = MINIMAL_DEPLOY
  assert.throws(() => validateConfig({ deploy: noRemoteDir }), code('E_CONFIG'))
  // workDir 是必填字符串：给 42 / null / 空串都拒
  for (const bad of [42, null, '', '  ']) {
    assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, workDir: bad } }), code('E_CONFIG'), String(bad))
  }
  // 其余可选字符串给了值就必须是字符串
  for (const key of ['artifactDir', 'sshHost']) {
    assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, [key]: 42 } }), code('E_CONFIG'), key)
    assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, [key]: null } }).deploy[key], null, key)
  }
})

test('deploy.health 校验：必填对象、未知键、check 枚举、类型 → E_CONFIG', () => {
  for (const value of ['x', 42, null, ['a']]) {
    assert.throws(() => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: value } }), code('E_CONFIG'), String(value))
  }
  assert.throws(
    () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { check: 'ping' } } }),
    code('E_CONFIG'),
  )
  assert.throws(
    () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { url: 'u', bogus: 1 } } }),
    code('E_CONFIG'),
  )
  assert.throws(
    () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { url: 42 } } }),
    code('E_CONFIG'),
  )
  assert.throws(
    () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { url: 'u', publicUrl: 42 } } }),
    code('E_CONFIG'),
  )
  assert.throws(
    () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, health: { url: 'u', insecure: 'yes' } } }),
    code('E_CONFIG'),
  )
})

test('deploy.keepReleases：必须是 1..50 的整数 → E_CONFIG', () => {
  for (const value of [0, 51, 1.5, '5', true]) {
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, keepReleases: value } }),
      code('E_CONFIG'),
      String(value),
    )
  }
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, keepReleases: 5 } }).deploy.keepReleases, 5)
})

test('deploy.qualityCmd / buildCmd：可选非空字符串，缺省与 null 视为未设置，非法类型 → E_CONFIG', () => {
  const full = { ...MINIMAL_DEPLOY, qualityCmd: 'pnpm run lint && pnpm test', buildCmd: 'pnpm run build' }
  assert.equal(validateConfig({ deploy: full }).deploy.qualityCmd, 'pnpm run lint && pnpm test')
  assert.equal(validateConfig({ deploy: full }).deploy.buildCmd, 'pnpm run build')
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, qualityCmd: null } }).deploy.qualityCmd, null)
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, buildCmd: null } }).deploy.buildCmd, null)

  for (const bad of [42, true, '', '   ', ['pnpm test'], { cmd: 'x' }]) {
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, qualityCmd: bad } }),
      code('E_CONFIG'),
      `qualityCmd ${String(bad)}`,
    )
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, buildCmd: bad } }),
      code('E_CONFIG'),
      `buildCmd ${String(bad)}`,
    )
  }
})

test('deploy.paths：可选非空字符串数组，缺省与 null 视为未设置，非法类型 → E_CONFIG', () => {
  const paths = ['apps/web/**', 'scripts/**']
  assert.deepEqual(validateConfig({ deploy: { ...MINIMAL_DEPLOY, paths } }).deploy.paths, paths)
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, paths: null } }).deploy.paths, null)

  // 非数组、空数组（等于悄悄丢掉过滤）、元素非字符串或空串，一律 E_CONFIG
  for (const bad of ['apps/**', 42, true, {}, [], ['ok', ''], ['ok', 42], [null]]) {
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, paths: bad } }),
      code('E_CONFIG'),
      `paths ${String(bad)}`,
    )
  }
})

test('deploy.linkPaths：可选非空字符串数组且每项含 =，缺省与 null 视为未设置，非法 → E_CONFIG', () => {
  const linkPaths = ['data=../../data', 'uploads=../../../uploads']
  assert.deepEqual(validateConfig({ deploy: { ...MINIMAL_DEPLOY, linkPaths } }).deploy.linkPaths, linkPaths)
  assert.equal(validateConfig({ deploy: { ...MINIMAL_DEPLOY, linkPaths: null } }).deploy.linkPaths, null)

  // 非数组、空数组（等于悄悄丢掉软链）、元素非字符串或空串，一律 E_CONFIG
  for (const bad of ['data=x', 42, true, {}, [], ['data=x', ''], ['data=x', 42], [null]]) {
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, linkPaths: bad } }),
      code('E_CONFIG'),
      `linkPaths ${String(bad)}`,
    )
  }

  // 元素必须是「相对路径=目标」：不含 '=' 一律拒（等号两侧为空由 workflow 的 Link 步骤拒绝）
  for (const bad of [['data'], ['data/x', 'uploads'], ['a=../b', 'no-equals']]) {
    assert.throws(
      () => validateConfig({ deploy: { ...MINIMAL_DEPLOY, linkPaths: bad } }),
      code('E_CONFIG'),
      `linkPaths ${JSON.stringify(bad)}`,
    )
  }
})
