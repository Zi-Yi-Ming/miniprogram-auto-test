/**
 * demo：首页游客态登录入口
 *
 * 这个脚本是 AI 读 pages/home/index.wxml + index.ts 之后生成的，
 * 在真实项目（考氪 coach-miniapp）上跑通过。
 *
 * 跑法：
 *   node demo/home-login.test.js
 *
 * ⚠️ 前置：
 *   - 微信开发者工具已安装并启动过一次
 *   - 设置 → 安全设置：开启「服务端口」和「CLI/HTTP 调用功能」
 *   - 设置 → 安全设置：勾选「自动化接口打开工具时默认信任项目」（否则会被信任弹窗卡住）
 *   - 被测项目里已 npm i -D miniprogram-automator
 *
 * ── 关于本 demo 想说明的三件事 ────────────────────────────────
 *
 * 1) 为什么不用官方的 automator.launch() / page.$() / element.tap()
 *    在微信开发者工具 2.01.2510290（基础库 3.17.0）上，automation 协议的
 *    Page 命令族已经不响应了 —— page.data() / setData() / $() / $$() 全超时，
 *    Element 命令族因为拿不到 handle 而整族不可达。也就是官方文档教的主要用法
 *    page.$('.btn').tap() 在当前版本工具上是死的。
 *    本 demo 用 miniprogram-automator-next，它把这些能力重建在 evaluate 之上。
 *    另外官方 launch() 在 Node ≥18.20 的 Windows 上必抛 spawn EINVAL（CVE-2024-27980），
 *    这个包也一并修了。
 *
 * 2) 为什么 tap 要手动给 handler 名
 *    「点击」实际是构造 event 对象去调页面 handler。元素的 dataset / 位置 / id
 *    运行时都读得到（包会自动填进 event），但 bindtap="xxx" 这个绑定关系
 *    运行时读不到 —— 它只存在于 WXML 源码里。
 *    所以「AI 读 WXML」不是这个工具的包装卖点，是技术上的必要条件。
 *
 * 3) 为什么要先 setData 再断言
 *    首页初始是 empty 态（还没拿到数据），登录按钮被 wx:if 藏着。
 *    与其为了测一个按钮去走完整前置流程，不如直接把页面摆到目标状态。
 *    这是 evaluate 方案额外带来的好处：状态可以随便摆。
 */

const assert = require('assert')
const path = require('path')

// ====== 改成你的真实路径 ======
// ⚠️ 别照抄网上的默认路径。开发者工具的安装位置是用户可改的。
//    本机实测装在 D 盘根目录，不在 Program Files 下。
//    探测方法（PowerShell，工具开着时最准）：
//      Get-Process wechatdevtools | Select-Object Path
//    不传 cliPath 的话，包会自己按常见位置 + 运行进程去探测。
const CLI_PATH = 'D:\\微信web开发者工具\\cli.bat'
const PROJECT_PATH = 'D:\\workspace\\coach-miniapp'
// ==============================

// miniprogram-automator 是本包的 peerDependency，装在被测项目里；
// 而本脚本在被测项目之外。Node 的 require 是从「脚本所在目录」往上找
// node_modules 的，跟你 cd 到哪无关，所以要显式指过去。
// （脚本放在被测项目内部的话，这一段可以整块删掉。）
const Module = require('module')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'miniprogram-automator') {
    return origResolve.call(this, path.join(PROJECT_PATH, 'node_modules', 'miniprogram-automator'), ...rest)
  }
  return origResolve.call(this, request, ...rest)
}

// demo 直接引仓库源码，方便改一行就试。你自己的脚本里应该写：
//   const { launch } = require('miniprogram-automator-next')
const { launch } = require('../packages/miniprogram-automator-next/src/index')

;(async () => {
  let mp
  try {
    // launch 会用 CLI 起一个自动化会话。端口是我们指定的，所以脚本可重复跑。
    //
    // ⚠️ 不要用开发者工具「设置 → 安全设置」里显示的那个「服务端口」——
    //    那是 IDE 的 HTTP 服务端口（CLI 启动时会打印 "IDE server has started"），
    //    不是 automation 端口，而且每次启动都变。automation 端口只有
    //    用 CLI 带 --auto-port 起会话才有，也就是这里的 port。
    console.log('→ 启动自动化会话…（冷启动要几秒）')
    mp = await launch({ cliPath: CLI_PATH, projectPath: PROJECT_PATH, port: 9420 })

    const info = await mp.baseInfo()
    console.log(`环境：基础库 ${info.SDKVersion} / 工具 ${info.version}`)

    // ── 打开首页 ──────────────────────────────────────────
    // reLaunch 冷启动要几秒，settle 是留给 onLoad/onShow 的时间。给太短会拿到半成品状态。
    const page = await mp.open('/pages/home/index', { settle: 2000 })

    const route = await page.route()
    assert.strictEqual(route.route, 'pages/home/index', '应停在首页')
    console.log('✓ 已打开首页')

    // ── 断言 1：empty 态下登录按钮不该渲染 ─────────────────
    // 首页 WXML：<button wx:if="{{phase === 'guest'}}" class="guest-login-btn" bindtap="loginAndLoad">
    await page.setData({ phase: 'empty' })
    await page.wait(300)
    assert.strictEqual(
      await page.count('.guest-login-btn'), 0,
      'empty 态下登录按钮应被 wx:if 藏起来'
    )
    console.log('✓ empty 态：登录按钮未渲染（符合预期）')

    // ── 断言 2：摆到 guest 态后按钮出现，且尺寸合理 ────────
    await page.setData({ phase: 'guest' })
    await page.waitForSelector('.guest-login-btn', { timeout: 3000 })

    const btn = await page.query('.guest-login-btn')
    assert.ok(btn, 'guest 态下应查到登录按钮')
    assert.ok(btn.width > 0 && btn.height > 0, `按钮应有实际尺寸，实际 ${btn.width}×${btn.height}`)
    console.log(`✓ guest 态：登录按钮已渲染，${Math.round(btn.width)}×${Math.round(btn.height)}`)

    // ── 断言 3：点击按钮，handler 被真实调起 ───────────────
    // handler 名 loginAndLoad 来自 WXML 的 bindtap，运行时读不到，只能静态读出来。
    // 这一步会发起真实的登录请求，所以只断言 handler 被调到、没抛错。
    const tapped = await page.tap('.guest-login-btn', 'loginAndLoad')
    assert.strictEqual(tapped.handler, 'loginAndLoad')
    console.log('✓ 点击登录按钮：handler loginAndLoad 已调起')

    // 留一张截图，跑挂时方便对照
    const shot = await mp.saveScreenshot(path.join(__dirname, 'screenshots', 'home-login.png'))
    console.log(`✓ 截图已存：${shot}`)

    console.log('\n===== 全部通过 =====')
  } catch (e) {
    console.error('\n✗ 测试失败:', e.message)
    // 失败时也留一张截图，比看报错文字有用
    if (mp) {
      try {
        const shot = await mp.saveScreenshot(path.join(__dirname, 'screenshots', 'home-login-FAIL.png'))
        console.error(`  失败现场截图：${shot}`)
      } catch { /* 会话可能已断，拿不到就算了 */ }
    }
    process.exitCode = 1
  } finally {
    // 必须 teardown，否则 launch 起的 cli 子进程会残留
    if (mp) await mp.teardown()
  }
})()
