'use strict'

/**
 * 冒烟测试：不需要微信开发者工具、也不需要装 peerDependency 就能跑。
 *
 * 为什么要有这个：本包的核心能力（launch / tap / setData）强依赖本地 DevTools，
 * CI 的 Linux 机器上装不了，跑不了真会话。但有三件事在没有工具的机器上也能验，
 * 而且正好是最容易被改坏的：
 *   ① 导出面没缺 —— 改 index.js 时手滑最容易砸这里
 *   ② EINVAL 的修复逻辑还在 —— resolveCliRunner 是纯函数，用假目录就能测
 *   ③ 官方 SDK 是懒加载的 —— 不装 peerDependency 也必须能 require 进来
 *
 * 真会话的端到端验证在仓库根的 verify-package.js（27 项，需要本机有开发者工具）。
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
let fail = 0

/** 同时接受同步和 async 的检查函数 —— async 的必须 await，否则 reject 会漏判成通过 */
async function t(label, fn) {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
    pass++
  } catch (e) {
    console.log(`  ✗ ${label}\n      ${e.message.split('\n')[0]}`)
    fail++
  }
}

/** 造一个假的 DevTools 安装目录 */
function fakeCliDir(withNodeAndCliJs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpan-smoke-'))
  fs.writeFileSync(path.join(dir, 'cli.bat'), '@echo off\r\n')
  if (withNodeAndCliJs) {
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), '')
    fs.writeFileSync(path.join(dir, 'cli.js'), '')
  }
  return dir
}

;(async () => {
  console.log('【1. 不装 peerDependency 也能 require】')
  // 官方 SDK 在 launcher.js 里是函数内部 require 的（懒加载）。
  // 这条如果挂了，说明谁把它提到了模块顶层 —— 那样没装 peer dep 的人一 require 就炸。
  const api = require('../src/index')
  await t('require 成功（官方 SDK 未安装）', () => {
    assert.ok(api)
  })

  console.log('\n【2. 导出面完整】')
  const EXPORTS = ['launch', 'connect', 'MiniProgram', 'PageProxy', 'resolveCliRunner', 'detectCliPath', 'rawLaunch']
  for (const name of EXPORTS) {
    await t(`导出 ${name}`, () => {
      assert.strictEqual(typeof api[name], 'function', `${name} 应是函数/类`)
    })
  }
  await t('PageProxy 上的元素层方法齐全', () => {
    const METHODS = [
      'data', 'setData', 'route', 'callMethod',
      'query', 'queryAll', 'exists', 'count',
      'tap', 'input', 'trigger',
      'wait', 'waitForSelector', 'waitForData',
    ]
    const missing = METHODS.filter((m) => typeof api.PageProxy.prototype[m] !== 'function')
    assert.deepStrictEqual(missing, [], `缺方法: ${missing.join(', ')}`)
  })

  console.log('\n【3. spawn EINVAL 的修复逻辑（本包存在的理由之一）】')
  await t('目录里有 node + cli.js → 绕开 .bat，且不开 shell', () => {
    const dir = fakeCliDir(true)
    const r = api.resolveCliRunner(path.join(dir, 'cli.bat'))
    assert.strictEqual(r.mode, 'node+cli.js')
    // ↓ 这一条就是修复点本身：useShell 一旦变成 true，CVE-2024-27980 修掉的注入面就又开了
    assert.strictEqual(r.useShell, false, 'useShell 必须是 false')
    assert.strictEqual(r.cmd, path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))
    assert.deepStrictEqual(r.prefixArgs, [path.join(dir, 'cli.js')])
  })
  await t('目录里没有 node/cli.js → 回退到 shell+bat', () => {
    const dir = fakeCliDir(false)
    const r = api.resolveCliRunner(path.join(dir, 'cli.bat'))
    assert.strictEqual(r.mode, 'shell+bat')
    assert.strictEqual(r.useShell, true)
  })

  console.log('\n【4. 参数校验发生在 require 官方 SDK 之前】')
  await t('launch() 不给 projectPath → 报可读的错', async () => {
    await assert.rejects(() => api.launch({}), /projectPath/)
  })
  await t('launch() 给不存在的 projectPath → 报可读的错', async () => {
    await assert.rejects(
      () => api.launch({ projectPath: path.join(os.tmpdir(), 'definitely-not-here-xyz') }),
      /不存在/
    )
  })

  console.log('\n【5. package.json 自身】')
  const pkg = require('../package.json')
  await t('main 指向的文件存在', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', pkg.main)), `${pkg.main} 不存在`)
  })
  await t('files 字段包含 src', () => {
    assert.ok(pkg.files.includes('src'), 'files 少了 src，发出去的包会是空的')
  })
  await t('声明了 miniprogram-automator 作为 peerDependency', () => {
    assert.ok(pkg.peerDependencies && pkg.peerDependencies['miniprogram-automator'])
  })
  await t('没有 dependencies（本包零运行时依赖）', () => {
    assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0)
  })

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => {
  console.error('\n✗ 冒烟测试自身崩了:', e.stack)
  process.exit(1)
})
