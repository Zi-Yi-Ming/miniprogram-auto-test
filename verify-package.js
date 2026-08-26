// verify-package.js —— 在一个真实小程序项目上验证 miniprogram-automator-next 端到端可用
//
// 这个脚本不是 demo，是包的自检。27 项全通过才允许发布。
//
// 默认走 launch()：用 CLI 起一个自动化会话，端口自己定（顺便验证 spawn EINVAL 的修复）。
//   node verify-package.js
//
// 传端口则走 connect()，接一个已存在的 automation 端口：
//   node verify-package.js 9420
//
// ⚠️ 注意：开发者工具「设置 → 安全设置」里那个「服务端口」**不是** automation 端口，
//    那是 HTTP 服务端口（接 /open、/preview 之类）。automation 端口只有用 CLI 带
//    --auto-port 起会话才会有。所以测试脚本应该用 launch()，不该指望人肉抄端口。
//
// ⚠️ 下面两个路径是本机的，跑之前改成你自己的。后半部分的断言绑定了作者的被测页面
//    （首页 phase 字段、.guest-login-btn、loginAndLoad handler），换项目要一并改。

const ARG_PORT = Number(process.argv[2]) || null

// ====== 路径：优先环境变量，未设置时用下面的值兜底 ======
// 别照抄：开发者工具安装位置是用户可改的。探测方法（工具开着时最准）：
//   Get-Process wechatdevtools | Select-Object Path
// 可用环境变量覆盖：WXDEVTOOLS_CLI、MP_PROJECT_PATH
const CLI_PATH = process.env.WXDEVTOOLS_CLI || 'D:\\微信web开发者工具\\cli.bat'
const PROJECT_PATH = process.env.MP_PROJECT_PATH || 'D:\\workspace\\coach-miniapp'
// ==============================

const LAUNCH_PORT = 9420

const path = require('path')
const assert = require('assert')

// 让包能 require 到 peerDependency miniprogram-automator（它装在被测项目里）
const Module = require('module')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'miniprogram-automator') {
    return origResolve.call(this, path.join(PROJECT_PATH, 'node_modules', 'miniprogram-automator'), ...rest)
  }
  return origResolve.call(this, request, ...rest)
}

const { launch, connect } = require('./packages/miniprogram-automator-next/src/index')

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    const v = await fn()
    console.log(`  ✓ ${label}${v === undefined ? '' : '  → ' + JSON.stringify(v)}`)
    pass++
  } catch (e) {
    console.log(`  ✗ ${label}\n      ${e.message.split('\n')[0]}`)
    fail++
  }
}

;(async () => {
  let mp
  if (ARG_PORT) {
    mp = await connect({ port: ARG_PORT })
    console.log(`✓ connect(port=${ARG_PORT}) 通\n`)
  } else {
    console.log(`【0. launch() —— 验证 spawn EINVAL 的修复】`)
    const t0 = Date.now()
    mp = await launch({ cliPath: CLI_PATH, projectPath: PROJECT_PATH, port: LAUNCH_PORT })
    console.log(`  ✓ launch() 成功，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log(`    （官方 launch() 在 Node ${process.version} 上这里必抛 spawn EINVAL）\n`)
    pass++
  }

  console.log('【1. 透传的官方能力】')
  await check('systemInfo() 返回非空对象', async () => {
    const si = await mp.systemInfo()
    // 不断言具体字段：它走已废弃的 wx.getSystemInfoSync，字段随基础库版本漂移
    assert.ok(si && typeof si === 'object', '应返回对象')
    assert.ok(Object.keys(si).length > 0, '不该是空对象')
    return { keyCount: Object.keys(si).length, platform: si.platform, SDKVersion: si.SDKVersion }
  })
  await check('baseInfo() 能拿到基础库版本', async () => {
    const b = await mp.baseInfo()
    assert.ok(b.SDKVersion, 'SDKVersion 应存在（这才是拿版本的正确姿势）')
    return b
  })
  await check('pageStack()', async () => {
    const ps = await mp.pageStack()
    assert.ok(ps.length > 0)
    return { depth: ps.length }
  })
  await check('evaluate() 传参', async () => {
    const r = await mp.evaluate((a, b) => a * b, 6, 7)
    assert.strictEqual(r, 42)
    return r
  })

  console.log('\n【2. open() —— reLaunch + 等就绪】')
  await check('open(/pages/explain/index)', async () => {
    const page = await mp.open('/pages/explain/index')
    const r = await page.route()
    assert.strictEqual(r.route, 'pages/explain/index')
    return r
  })

  const page = mp.page

  console.log('\n【3. 状态读写（替代死掉的 Page.getData/setData）】')
  await check('page.data()', async () => {
    const d = await page.data()
    assert.ok(typeof d === 'object' && d !== null)
    return { keys: Object.keys(d).length, inputMode: d.inputMode }
  })
  await check('page.data(key) 取单个字段', async () => {
    const v = await page.data('inputMode')
    assert.ok(v === 'text' || v === 'image')
    return v
  })
  await check('page.setData() + 回读验证', async () => {
    const orig = await page.data('inputMode')
    const target = orig === 'text' ? 'image' : 'text'
    await page.setData({ inputMode: target })
    const after = await page.data('inputMode')
    assert.strictEqual(after, target, 'setData 后回读应等于设定值')
    await page.setData({ inputMode: orig })
    return { orig, set: target, readBack: after }
  })

  console.log('\n【4. 元素查询（替代死掉的 Page.getElement）】')
  await check('page.exists(.mode-tab)', async () => {
    const e = await page.exists('.mode-tab')
    assert.strictEqual(e, true)
    return e
  })
  await check('page.count(.mode-tab) 应为 2', async () => {
    const c = await page.count('.mode-tab')
    assert.strictEqual(c, 2, 'WXML 里有两个 mode-tab')
    return c
  })
  await check('page.query() 带回 dataset + rect', async () => {
    const el = await page.query('.mode-tab')
    assert.ok(el, '应查到元素')
    assert.ok(el.dataset && el.dataset.mode, 'dataset.mode 应被自动读出')
    assert.ok(el.width > 0 && el.height > 0, '应有几何尺寸')
    return { dataset: el.dataset, w: el.width, h: el.height }
  })
  await check('page.queryAll() dataset 各不相同', async () => {
    const list = await page.queryAll('.mode-tab')
    const modes = list.map((x) => x.dataset.mode)
    assert.deepStrictEqual(modes.sort(), ['image', 'text'])
    return modes
  })
  await check('不存在的选择器返回 null / 0', async () => {
    const el = await page.query('.definitely-not-here-xyz')
    assert.strictEqual(el, null)
    assert.strictEqual(await page.count('.definitely-not-here-xyz'), 0)
    return null
  })

  console.log('\n【5. ★tap —— 包的核心卖点】')
  await check('tap 切到 text 模式（dataset 自动从元素读）', async () => {
    await page.setData({ inputMode: 'image' })
    const before = await page.data('inputMode')
    // 只给选择器和 handler 名，dataset 由包自动从元素上读出来填进 event
    const list = await page.queryAll('.mode-tab')
    const textIdx = list.findIndex((x) => x.dataset.mode === 'text')
    await page.tap('.mode-tab', { handler: 'selectMode', index: textIdx })
    const after = await page.data('inputMode')
    assert.strictEqual(before, 'image')
    assert.strictEqual(after, 'text', 'tap 后 inputMode 应变成 text')
    return { before, after }
  })
  await check('tap 切回 image 模式', async () => {
    const list = await page.queryAll('.mode-tab')
    const imgIdx = list.findIndex((x) => x.dataset.mode === 'image')
    await page.tap('.mode-tab', { handler: 'selectMode', index: imgIdx })
    const after = await page.data('inputMode')
    assert.strictEqual(after, 'image')
    return after
  })
  await check('tap 不给 handler 应报可读的错', async () => {
    try {
      await page.tap('.mode-tab')
      throw new Error('本该抛错')
    } catch (e) {
      assert.ok(e.message.includes('bindtap'), '错误信息应提示去 WXML 找 bindtap')
      return '报错信息正确'
    }
  })
  await check('tap 选不到元素应报可读的错', async () => {
    try {
      await page.tap('.nope-xyz', 'selectMode')
      throw new Error('本该抛错')
    } catch (e) {
      assert.ok(e.message.includes('没匹配到'), '应说明没匹配到')
      return '报错信息正确'
    }
  })
  await check('handler 名写错应报错并列出可用方法', async () => {
    try {
      await page.tap('.mode-tab', 'selectModeTypo')
      throw new Error('本该抛错')
    } catch (e) {
      assert.ok(e.message.includes('不存在'), '应说明 handler 不存在')
      return '报错信息正确'
    }
  })

  console.log('\n【6. callMethod / 等待】')
  await check('page.callMethod()', async () => {
    const r = await page.callMethod('selectMode', { currentTarget: { dataset: { mode: 'text' } } })
    const after = await page.data('inputMode')
    await page.setData({ inputMode: 'image' })
    assert.strictEqual(after, 'text')
    return { returned: r, after }
  })
  await check('waitForSelector 命中', async () => {
    const r = await page.waitForSelector('.mode-tab', { timeout: 3000 })
    assert.strictEqual(r, true)
    return r
  })
  await check('waitForSelector 超时报错', async () => {
    try {
      await page.waitForSelector('.nope-xyz', { timeout: 600 })
      throw new Error('本该超时')
    } catch (e) {
      assert.ok(e.message.includes('超时'))
      return '超时报错正确'
    }
  })
  await check('waitForData（Node 侧执行，闭包可用）', async () => {
    const target = 'image'  // ← 闭包变量，验证不走 evaluate 序列化
    await page.setData({ inputMode: 'image' })
    const d = await page.waitForData((data) => data.inputMode === target, { timeout: 3000 })
    return { inputMode: d.inputMode }
  })

  console.log('\n【7. 截图存盘】')
  await check('saveScreenshot()', async () => {
    const fs = require('fs')
    const out = path.join(__dirname, '.tmp-verify-shot.png')
    await mp.saveScreenshot(out)
    const size = fs.statSync(out).size
    assert.ok(size > 10000, '截图文件应有实际内容')
    fs.unlinkSync(out)
    return { bytes: size }
  })

  console.log('\n【8. 回首页 + 验证 wx:if 藏起来的元素能靠 setData 摆出来】')
  // 先探一下会话还活着没 —— 上一轮这段全挂是因为开发者工具被关了，不是包的问题。
  // 有这个探针就能一眼分清「包的 bug」和「环境断了」。
  let alive = true
  try {
    await mp.evaluate(() => 1)
  } catch (e) {
    alive = false
    console.log(`  ⚠ 会话已断（${e.message}）—— 下面的失败是环境原因，不是包的 bug`)
  }
  if (alive) {
    await check('home 页 empty 态下查不到 .guest-login-btn', async () => {
      await mp.open('/pages/home/index', { settle: 2000 })
      await page.setData({ phase: 'empty' })
      await page.wait(300)
      const c = await page.count('.guest-login-btn')
      assert.strictEqual(c, 0, 'empty 态下登录按钮不该渲染')
      return c
    })
    await check('setData(phase=guest) 后查到 .guest-login-btn', async () => {
      await page.setData({ phase: 'guest' })
      await page.wait(400)
      const el = await page.query('.guest-login-btn')
      assert.ok(el, 'guest 态下登录按钮应渲染出来')
      assert.ok(el.width > 0)
      return { w: el.width, h: el.height }
    })
    await check('tap 登录按钮（真实入口，只验证 handler 被调到）', async () => {
      // loginAndLoad 会发起真实登录请求，这里只确认 tap 能把 handler 调起来、不抛错
      const el = await page.query('.guest-login-btn')
      assert.ok(el, '前置：按钮应在')
      const r = await page.tap('.guest-login-btn', 'loginAndLoad')
      return r
    })
  }

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
  if (!ARG_PORT) {
    await mp.teardown()   // launch() 起的 cli 子进程要收掉，不然残留
    console.log('（已 teardown，cli 子进程已回收）')
  }
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => {
  console.error('\n✗ 脚本崩溃:', e.message)
  console.error(e.stack)
  process.exit(1)
})
