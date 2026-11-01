import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ROLES,
  resolveRoles,
} from '../lib/roles.mjs'

const code = (expected) => (error) => {
  assert.equal(error.code, expected)
  return true
}

test('默认角色：executor 可写、reviewer 只读', () => {
  const roles = resolveRoles()
  assert.deepEqual(roles, DEFAULT_ROLES)
  assert.equal(roles.executor.permissionMode, 'full')
  assert.equal(roles.executor.outputContract, 'text')
  assert.equal(roles.reviewer.permissionMode, 'readonly')
  assert.equal(roles.reviewer.outputContract, 'verdict')
})

test('空配置/无 roles 字段返回默认角色', () => {
  assert.deepEqual(resolveRoles({}), DEFAULT_ROLES)
  assert.deepEqual(resolveRoles({ roles: {} }), DEFAULT_ROLES)
})

test('允许覆盖 model / provider / instructions / outputContract', () => {
  const roles = resolveRoles({
    roles: {
      executor: {
        model: 'fast-model',
        provider: 'acme',
        instructions: '按任务书执行',
        outputContract: 'json',
      },
      reviewer: { model: 'deep-model' },
    },
  })
  assert.equal(roles.executor.permissionMode, 'full')
  assert.equal(roles.executor.model, 'fast-model')
  assert.equal(roles.executor.provider, 'acme')
  assert.equal(roles.executor.instructions, '按任务书执行')
  assert.equal(roles.executor.outputContract, 'json')
  assert.equal(roles.reviewer.model, 'deep-model')
  assert.equal(roles.reviewer.permissionMode, 'readonly')
})

test('reviewer 提权到 full 被拒绝（安全红线）', () => {
  assert.throws(
    () => resolveRoles({ roles: { reviewer: { permissionMode: 'full' } } }),
    code('E_ROLE'),
  )
})

test('覆盖含未知字段被拒绝', () => {
  assert.throws(
    () => resolveRoles({ roles: { executor: { sandbox: false } } }),
    code('E_ROLE'),
  )
  assert.throws(
    () => resolveRoles({ roles: { reviewer: { permission_mode: 'readonly' } } }),
    code('E_ROLE'),
  )
})

test('未知角色名被拒绝', () => {
  assert.throws(
    () => resolveRoles({ roles: { admin: { permissionMode: 'full' } } }),
    code('E_ROLE'),
  )
})

test('非法 permissionMode 被拒绝', () => {
  assert.throws(
    () => resolveRoles({ roles: { executor: { permissionMode: 'root' } } }),
    code('E_ROLE'),
  )
  assert.throws(
    () => resolveRoles({ roles: { reviewer: { permissionMode: null } } }),
    code('E_ROLE'),
  )
})

test('覆盖块不是对象或字段类型错误被拒绝', () => {
  assert.throws(() => resolveRoles({ roles: { executor: 'full' } }), code('E_ROLE'))
  assert.throws(() => resolveRoles({ roles: { executor: { model: 42 } } }), code('E_ROLE'))
  assert.throws(
    () => resolveRoles({ roles: { executor: { outputContract: '' } } }),
    code('E_ROLE'),
  )
  assert.throws(
    () => resolveRoles({ roles: { executor: { instructions: 1 } } }),
    code('E_ROLE'),
  )
})

test('返回结果被冻结，不能就地提权', () => {
  const roles = resolveRoles()
  assert.throws(() => {
    roles.reviewer.permissionMode = 'full'
  }, TypeError)
  assert.equal(roles.reviewer.permissionMode, 'readonly')
})
