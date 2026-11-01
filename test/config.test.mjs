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
