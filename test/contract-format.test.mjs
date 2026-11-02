/**
 * 防漂移：插件（dsh-subagents）产出的记录必须被包的校验接受。
 *
 * 背景：两套记录实现曾因字段集合不同而静默失效——包把 policy 当多余字段拒收，
 * 而 gate 依赖 record.policy.hit 判高风险，结果高风险检查成了死代码。
 * 这个夹具来自真实运行（`.dsh-web/reviews/` 里的一条），任何一边改字段都会让它红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateRecord } from '../lib/record.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plugin-record.json', import.meta.url), 'utf8'))

test('插件产出的记录能通过包侧校验（防字段漂移）', () => {
  const result = validateRecord(fixture)
  assert.equal(result.ok, true, `校验失败: ${JSON.stringify(result.errors ?? result)}`)
})

test('夹具覆盖了 gate 依赖的 policy 字段', () => {
  assert.equal(typeof fixture.policy, 'object')
  assert.equal(typeof fixture.policy.hit, 'boolean')
})

test('夹具含 round 与 policyVersion（闸门要用）', () => {
  assert.equal(Number.isInteger(fixture.round), true)
  assert.equal(typeof fixture.policyVersion, 'string')
})
