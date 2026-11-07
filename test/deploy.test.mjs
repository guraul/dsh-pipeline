/**
 * deploy：契约 §10 落地第一步——`deploy` 配置字段 + caller workflow 骨架生成 / 校验。
 *
 * 覆盖：init 打印骨架（uses pin、with 逐项含 assemble、concurrency、首尾标记、不落盘）、
 * init --write 落盘 + check 一致退 0、改配置后 check 打印第一处差异退 1（assemble 键也参与比对）、
 * 手改生成区一行退 1、标记之后追加 job 仍退 0、改配置重跑 --write 只换生成区并保留追加内容、
 * node-standalone 放行（mode=releases + assemble）、qualityCmd / buildCmd / paths 三字段
 * （渲染顺序、paths 元素顺序、不配不出现、新行参与 check 逐字节比对）、linkPaths 字段
 * （link_paths 渲染在 build_cmd 之后、逗号+空格拼接、不配不出现、改配置后 check 报差异）、
 * artifact=oci-image 在配置层被拒、
 * 缺文件 / 缺标记退 1、手写文件拒绝覆盖退 1、参数与缺 deploy 段 / 缺 build.json 退 2。
 * 构建标识经 deps.buildInfo 注入，不依赖包内 build.json（CI 源码运行没有该文件）。
 * 只调 runCli（注入输出流），不碰真实 gh / git。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli } from '../bin/cli.mjs'
import { DEPLOY_ROLLBACK_FILE, DEPLOY_WORKFLOW_FILE, REGION_BEGIN, REGION_END } from '../lib/deploy.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const BUILD_INFO = { gitSha: GIT_SHA, builtAt: '2026-11-06T00:00:00Z', dirty: false }

const BASE_DEPLOY = {
  artifact: 'static-dir',
  service: 'serve-9928',
  remoteDir: '/root/project/demo/demo-app',
  workDir: 'demo-app',
  health: { url: 'http://127.0.0.1:9929/' },
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
}

function writeConfig(root, deploy) {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  const value = deploy === undefined ? { repo: 'guraul/demo' } : { repo: 'guraul/demo', deploy }
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify(value, null, 2), 'utf8')
}

function run(argv, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    buildInfo: BUILD_INFO,
    ...deps,
  })
  return { code, ...state }
}

function workflowPath(root) {
  return join(root, ...DEPLOY_WORKFLOW_FILE.split('/'))
}

function init(root, extra = []) {
  return run(['deploy', 'init', '--root', root, ...extra])
}

function check(root) {
  return run(['deploy', 'check', '--root', root])
}

test('deploy init：不带 --write 只打印骨架，uses / with / concurrency / 标记齐全', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const result = init(root)
  assert.equal(result.code, 0)
  assert.equal(result.err, '')
  assert.ok(!existsSync(workflowPath(root)), '不带 --write 不应落盘')

  const out = result.out
  assert.ok(out.startsWith(`${REGION_BEGIN}\n`), '首行应是生成区起始标记')
  assert.ok(out.trimEnd().endsWith(REGION_END), '末行应是生成区结束标记')

  // uses pin 到当前安装包的构建标识（注入的 gitSha）
  assert.ok(out.includes(`uses: guraul/dsh-pipeline/.github/workflows/deploy.yml@${GIT_SHA}\n`), 'uses 应 pin gitSha')
  // concurrency：串行部署，不取消进行中的部署
  assert.ok(out.includes('concurrency:\n  group: deploy-web\n  cancel-in-progress: false\n'))
  // on：push 到 main + 手动触发
  assert.ok(out.includes('on:\n  push:\n    branches:\n      - main\n  workflow_dispatch:\n'))
  // with：配置逐项填入，缺省值补齐
  assert.ok(out.includes("      mode: 'releases'\n"))
  assert.ok(out.includes("      assemble: 'static-dir'\n"), 'with: 应按 artifact 追加 assemble')
  assert.ok(out.includes("      service: 'serve-9928'\n"))
  assert.ok(out.includes("      remote_dir: '/root/project/demo/demo-app'\n"))
  assert.ok(out.includes("      work_dir: 'demo-app'\n"))
  assert.ok(out.includes("      health_url: 'http://127.0.0.1:9929/'\n"))
  assert.ok(out.includes("      health_check: 'http'\n"))
  assert.ok(out.includes('      public_health_insecure: true\n'))
  assert.ok(out.includes('      keep_releases: 5\n'))
  assert.ok(out.includes('    secrets: inherit\n'))
  // 单个 job：jobs 下只有 deploy
  assert.ok(out.includes('jobs:\n  deploy:\n'))
  // 没配置的可选项不写
  assert.ok(!out.includes('artifact_dir:'), '未配 artifactDir 不应出现')
  assert.ok(!out.includes('ssh_host:'), '未配 sshHost 不应出现')
  assert.ok(!out.includes('public_health_url:'), '未配 publicUrl 不应出现')
  assert.ok(!out.includes('quality_cmd:'), '未配 qualityCmd 不应出现')
  assert.ok(!out.includes('build_cmd:'), '未配 buildCmd 不应出现')
  assert.ok(!out.includes('link_paths:'), '未配 linkPaths 不应出现')
  assert.ok(!out.includes('paths:'), '未配 paths 时 on 段不带 paths')
})

test('deploy init：配 qualityCmd / buildCmd / paths → 三处新行渲染、顺序保持、参与 check 逐字节比对', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, {
    ...BASE_DEPLOY,
    qualityCmd: 'pnpm run lint && pnpm test',
    buildCmd: 'pnpm run build',
    paths: ['apps/web/**', 'scripts/**', '!**/*.md'],
  })

  const printed = init(root)
  assert.equal(printed.code, 0)
  assert.equal(printed.err, '')
  const out = printed.out

  // on.push：branches 之后渲染 paths，元素顺序与配置一致
  assert.ok(
    out.includes(
      'on:\n  push:\n    branches:\n      - main\n    paths:\n'
        + "      - 'apps/web/**'\n      - 'scripts/**'\n      - '!**/*.md'\n  workflow_dispatch:\n",
    ),
    'paths 应渲染进 on.push 且元素顺序保持',
  )
  // with：quality_cmd / build_cmd 紧跟 assemble，之后才是 service（其余行序不动）
  assert.ok(
    out.includes(
      "      mode: 'releases'\n      assemble: 'static-dir'\n"
        + "      quality_cmd: 'pnpm run lint && pnpm test'\n      build_cmd: 'pnpm run build'\n"
        + "      service: 'serve-9928'\n",
    ),
    'quality_cmd / build_cmd 应紧跟 assemble',
  )

  // 落盘后 check 一致；改配置里的新行之一 → 报第一处差异（新行参与逐字节比对）
  assert.equal(init(root, ['--write']).code, 0)
  assert.equal(check(root).code, 0)

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.buildCmd = 'pnpm run build:prod'
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /第一处差异在第 \d+ 行/)
  assert.match(result.err, /期望:.*build_cmd: 'pnpm run build:prod'/)
  assert.match(result.err, /实际:.*build_cmd: 'pnpm run build'/)
})

test('deploy init：配 linkPaths → link_paths 渲染在 build_cmd 之后（逗号+空格拼接），参与 check 逐字节比对', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, {
    ...BASE_DEPLOY,
    buildCmd: 'pnpm run build',
    linkPaths: ['data=../../data', 'uploads=../../../uploads'],
  })

  const printed = init(root)
  assert.equal(printed.code, 0)
  assert.equal(printed.err, '')
  const out = printed.out

  // 顺序：assemble → build_cmd → link_paths → service；元素顺序保持，逗号+空格拼接
  assert.ok(
    out.includes(
      "      assemble: 'static-dir'\n"
        + "      build_cmd: 'pnpm run build'\n"
        + "      link_paths: 'data=../../data, uploads=../../../uploads'\n"
        + "      service: 'serve-9928'\n",
    ),
    'link_paths 应紧跟 build_cmd 且在 service 之前',
  )

  // 落盘后 check 一致；改 linkPaths → 报第一处差异（新行参与逐字节比对）
  assert.equal(init(root, ['--write']).code, 0)
  assert.equal(check(root).code, 0)

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.linkPaths = ['data=../../data']
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /第一处差异在第 \d+ 行/)
  assert.match(result.err, /期望:.*link_paths: 'data=\.\.\/\.\.\/data'/)
  assert.match(result.err, /实际:.*link_paths: 'data=\.\.\/\.\.\/data, uploads=\.\.\/\.\.\/\.\.\/uploads'/)
})

test('deploy init：node-standalone 放行，mode=releases 且 with: 按 artifact 追加 assemble', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, {
    artifact: 'node-standalone',
    service: 'serve-node',
    remoteDir: '/srv/node-app',
    workDir: '.',
    health: { url: 'http://127.0.0.1:1/' },
  })

  const printed = init(root)
  assert.equal(printed.code, 0)
  assert.equal(printed.err, '')
  assert.ok(printed.out.includes("      mode: 'releases'\n"), 'node-standalone 仍走 releases 布局')
  assert.ok(printed.out.includes("      assemble: 'node-standalone'\n"), 'assemble 应取 artifact 的值')
  assert.ok(printed.out.includes("      work_dir: '.'\n"))

  assert.equal(init(root, ['--write']).code, 0)
  const checked = check(root)
  assert.equal(checked.code, 0)
  assert.equal(checked.out, '构建: 生成区与配置一致\n')
})

test('deploy check：assemble 键参与逐字节比对（改 artifact 后报第一处差异）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.artifact = 'node-standalone'
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /第一处差异在第 \d+ 行/)
  assert.match(result.err, /期望:.*assemble: 'node-standalone'/)
  assert.match(result.err, /实际:.*assemble: 'static-dir'/)
})

test('deploy init --write 落盘，deploy check 一致退 0', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const written = init(root, ['--write'])
  assert.equal(written.code, 0)
  assert.equal(written.err, '')
  assert.equal(written.out, `构建: 已写入 ${DEPLOY_WORKFLOW_FILE}\n`)
  const file = workflowPath(root)
  assert.ok(existsSync(file), '应生成 workflow 文件')

  const result = check(root)
  assert.equal(result.code, 0)
  assert.equal(result.out, '构建: 生成区与配置一致\n')
  assert.equal(result.err, '')
})

test('deploy check：改配置后报不一致，打印第一处差异并退 1', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.keepReleases = 3
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /第一处差异在第 \d+ 行/)
  assert.match(result.err, /期望:.*keep_releases: 3/)
  assert.match(result.err, /实际:.*keep_releases: 5/)
})

test('deploy check：手改生成区一行 → 退 1，指出该行', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('cancel-in-progress: false', 'cancel-in-progress: true'), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /期望:.*cancel-in-progress: false/)
  assert.match(result.err, /实际:.*cancel-in-progress: true/)
})

test('deploy check：标记之后追加 job → 仍退 0（追加内容不参与比对）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  const appended = [
    '  post-deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo done',
    '',
  ].join('\n')
  writeFileSync(file, readFileSync(file, 'utf8') + appended, 'utf8')

  const result = check(root)
  assert.equal(result.code, 0)
  assert.equal(result.out, '构建: 生成区与配置一致\n')
})

test('deploy init --write --rollback：两份 caller 都落盘，rollback 用 workflow_dispatch + rollback.yml', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const result = init(root, ['--write', '--rollback'])
  assert.equal(result.code, 0, result.err)
  assert.ok(existsSync(workflowPath(root)), '部署 caller 必须落盘')
  const rollbackFile = join(root, DEPLOY_ROLLBACK_FILE)
  assert.ok(existsSync(rollbackFile), '回滚 caller 必须落盘')

  const content = readFileSync(rollbackFile, 'utf8')
  assert.ok(content.includes(`uses: guraul/dsh-pipeline/.github/workflows/rollback.yml@${GIT_SHA}\n`))
  assert.ok(content.includes('on:\n  workflow_dispatch:\n'), '回滚只能手动触发')
  assert.ok(content.includes('      release: ${{ inputs.release }}\n'))
  assert.ok(content.includes('      dry_run: ${{ inputs.dry_run }}\n'))
  assert.ok(content.includes('      remote_dir: '), '要传 remote_dir')
  assert.ok(!content.includes('quality_cmd'), '回滚不重新构建，不该有构建 input')
})

test('deploy init --rollback 缺 --write → 退 2（它只影响落盘，不静默丢弃）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const result = init(root, ['--rollback'])
  assert.equal(result.code, 2)
  assert.match(result.err, /--rollback 必须与 --write 同用/)
  assert.ok(!existsSync(workflowPath(root)), '参数错误不该落盘（部署 caller）')
  assert.ok(!existsSync(join(root, DEPLOY_ROLLBACK_FILE)), '参数错误不该落盘（回滚 caller）')
})

test('deploy init --write：已生成的回滚 caller 会被自动刷新 pin，标记后的追加 job 保留', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write', '--rollback']).code, 0)

  // 在标记之后追加本仓自己的 job，模拟真实仓
  const file = join(root, DEPLOY_ROLLBACK_FILE)
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n  extra:\n    runs-on: ubuntu-latest\n`, 'utf8')

  // 换一个 gitSha 再跑「只 --write」：不该要求显式 --rollback
  const run2 = run(['deploy', 'init', '--root', root, '--write'], { buildInfo: { ...BUILD_INFO, gitSha: 'b'.repeat(40) } })
  assert.equal(run2.code, 0, run2.err)

  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes('rollback.yml@' + 'b'.repeat(40)), 'pin 应被刷新')
  assert.ok(content.includes('  extra:\n'), '标记之后的追加内容应保留')
})

test('deploy init --write：手写的回滚 caller 不阻断部署 caller 刷新；显式 --rollback 才拒绝', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  const file = join(root, DEPLOY_ROLLBACK_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'name: rollback-web\n# 手写，没有生成区标记\n', 'utf8')

  const auto = run(['deploy', 'init', '--root', root, '--write'])
  assert.equal(auto.code, 0, auto.err)
  assert.ok(existsSync(workflowPath(root)), '部署 caller 必须照常落盘')
  assert.match(auto.err, /已存在但不是生成的骨架（手写文件），已跳过/)
  assert.equal(readFileSync(file, 'utf8'), 'name: rollback-web\n# 手写，没有生成区标记\n', '手写文件不许被改')

  const explicit = run(['deploy', 'init', '--root', root, '--write', '--rollback'])
  assert.equal(explicit.code, 1)
  assert.match(explicit.err, /拒绝覆盖/)
})

test('deploy check：手写的回滚 caller → 跳过并提示、退 0（与 init 同口径）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = join(root, DEPLOY_ROLLBACK_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'name: rollback-web\n# 手写\n', 'utf8')

  const result = check(root)
  assert.equal(result.code, 0, result.err)
  assert.equal(result.out, '构建: 生成区与配置一致\n')
  assert.match(result.err, /rollback-web\.yml 是手写文件（缺生成区标记），已跳过/)
})

test('deploy check：两份都在 → 两个生成区一致；改坏回滚那份 → 退 1 并点名', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write', '--rollback']).code, 0)

  const ok = check(root)
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.out, '构建: 两个生成区都与配置一致\n')

  const rollbackFile = join(root, DEPLOY_ROLLBACK_FILE)
  const broken = readFileSync(rollbackFile, 'utf8').replace('      remote_dir:', '      remote_dir_x:')
  writeFileSync(rollbackFile, broken, 'utf8')
  const bad = check(root)
  assert.equal(bad.code, 1)
  assert.match(bad.err, /rollback-web\.yml 的生成区与配置不一致/)
})

test('deploy init --write：改配置重跑只换生成区，保留标记之后追加的 job', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}  post-deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n`,
    'utf8',
  )

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.keepReleases = 3
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const again = init(root, ['--write'])
  assert.equal(again.code, 0)
  assert.match(again.out, /已更新.*生成区/)

  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes('keep_releases: 3'), '新配置应写进生成区')
  assert.ok(content.includes('  post-deploy:'), '追加的 job 应保留')
  assert.equal(check(root).code, 0)
})

test('deploy：artifact=oci-image 在配置层就被拒（容器部署明确不做）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, { ...BASE_DEPLOY, artifact: 'oci-image' })

  const initResult = init(root)
  assert.equal(initResult.code, 2)
  assert.match(initResult.err, /artifact 只能是 static-dir \| node-standalone/)
})

test('deploy check：文件不存在 → 退 1 提示先跑 deploy init；缺标记 → 报不是生成的骨架', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const missing = check(root)
  assert.equal(missing.code, 1)
  assert.equal(missing.out, '')
  assert.match(missing.err, /不存在，请先运行 deploy init/)

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  writeFileSync(workflowPath(root), 'name: hand-written\non: push\n', 'utf8')

  const notGenerated = check(root)
  assert.equal(notGenerated.code, 1)
  assert.equal(notGenerated.out, '')
  assert.match(notGenerated.err, /不是生成的骨架/)
})

test('deploy init --write：已有手写文件（缺标记）→ 退 1 拒绝覆盖，文件不动', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  const file = workflowPath(root)
  const handWritten = 'name: 手写的\non: push\n'
  writeFileSync(file, handWritten, 'utf8')

  const result = init(root, ['--write'])
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /不是生成的骨架.*拒绝覆盖/)
  assert.equal(readFileSync(file, 'utf8'), handWritten, '拒绝时不动磁盘')
})

test('deploy：缺 --root / 未知动作 / 未知选项 / 缺 deploy 段 / 缺 build.json → 退 2', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const noRoot = run(['deploy', 'init'])
  assert.equal(noRoot.code, 2)
  assert.match(noRoot.err, /缺少必填参数 --root/)

  const noAction = run(['deploy'])
  assert.equal(noAction.code, 2)
  assert.match(noAction.err, /用法: dsh-pipeline deploy/)

  const unknownAction = run(['deploy', 'frobnicate', '--root', root])
  assert.equal(unknownAction.code, 2)
  assert.match(unknownAction.err, /未知动作: frobnicate/)

  // check 不接受 --write：严格解析，不静默忽略
  const writeOnCheck = run(['deploy', 'check', '--root', root, '--write'])
  assert.equal(writeOnCheck.code, 2)
  assert.match(writeOnCheck.err, /未知选项: --write/)

  const bareRoot = tmp()
  t.after(() => rmSync(bareRoot, { recursive: true, force: true }))
  writeConfig(bareRoot, undefined)
  const noDeploy = init(bareRoot)
  assert.equal(noDeploy.code, 2)
  assert.match(noDeploy.err, /配置缺少 deploy 段/)

  // 源码运行没有 build.json：拒绝生成假 pin
  const noBuild = run(['deploy', 'init', '--root', root], { buildInfo: null })
  assert.equal(noBuild.code, 2)
  assert.match(noBuild.err, /没有 build.json/)
})

// 回归（issue #64）：pack.sh 先在包根写 build.json 再跑 node --test，此时注入的 null 会被
// isPlainObject 判成「没注入」→ 回退读到真的 build.json → 上面那条用例绿成退出码 0，门禁整段红。
// 断言用意：显式注入 null 表示「这里没有 build.json」，这个语义必须原样生效，不被真实文件顶掉。
test('deploy：包根存在 build.json 时，注入 buildInfo:null 仍退 2（不回退读真实文件）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  // 造一个包根 build.json 复刻打包期间的现场：只在原本没有时才造（打包期间那个是 pack.sh 的
  // 产物，不能碰），且由本用例自己删掉，不留残留；文件在 .gitignore 里，不会弄脏 git status。
  const repoBuild = join(REPO_ROOT, 'build.json')
  const created = !existsSync(repoBuild)
  if (created) {
    writeFileSync(
      repoBuild,
      JSON.stringify({ gitSha: GIT_SHA, builtAt: '2026-11-06T00:00:00Z', dirty: false }),
      'utf8',
    )
    t.after(() => rmSync(repoBuild, { force: true }))
  }

  const result = run(['deploy', 'init', '--root', root], { buildInfo: null })
  assert.equal(result.code, 2, '显式注入 null 必须拒绝，不能读到包根 build.json 而退出码 0')
  assert.match(result.err, /没有 build.json/)
})

test('deploy：配置字段不合规（未知键等）→ 退 2，不落盘', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    JSON.stringify({ deploy: { ...BASE_DEPLOY, bogus: 1 } }),
    'utf8',
  )

  const result = init(root, ['--write'])
  assert.equal(result.code, 2)
  assert.match(result.err, /deploy 未知字段: bogus/)
  assert.ok(!existsSync(workflowPath(root)))
})
