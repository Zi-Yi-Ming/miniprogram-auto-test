'use strict'

const { launch, connect, resolveCliRunner, detectCliPath } = require('./launcher')
const { PageProxy } = require('./page')

/**
 * 官方 SDK 上仍然可用的能力（走 App.* / Tool.* 协议，实测通）。
 * 直接代理过来，不重复实现。
 */
const PASSTHROUGH = [
  'evaluate',        // 5-9ms   —— 本包一切能力的地基
  'pageStack',       // 5ms
  'currentPage',     // 2ms     （返回的 Page 对象没用，它的方法全走 Page 协议，全死）
  'systemInfo',      // 7ms     ⚠️ 实际是 App.callWxMethod('getSystemInfoSync')，
                     //            而 wx.getSystemInfoSync 从基础库 2.20 起已废弃，
                     //            返回字段随基础库版本变（比如 SDKVersion 不一定有）。
                     //            别断言具体字段，要版本信息请自己 evaluate wx.getAppBaseInfo()。
  'screenshot',      // 83ms    返回 base64 字符串，可存盘做测试报告
  'callWxMethod',
  'mockWxMethod',    // 7ms     mock wx.request 造数据用
  'restoreWxMethod',
  'navigateTo',
  'redirectTo',
  'navigateBack',
  'reLaunch',        // 3.9-7.3s 冷启动慢，别给太短的超时
  'switchTab',
  'pageScrollTo',
  'exposeFunction',
  'close',
  'disconnect',
  'on',
]

class MiniProgram {
  constructor(rawMiniProgram, cliProcess) {
    /** 官方 SDK 的 MiniProgram 实例。需要用本包没包装的原生能力时走这个。 */
    this.raw = rawMiniProgram
    this._cliProcess = cliProcess || null

    /** 当前页操作入口。替代死掉的 Page.* 协议。 */
    this.page = new PageProxy(rawMiniProgram)

    for (const name of PASSTHROUGH) {
      if (typeof rawMiniProgram[name] === 'function') {
        this[name] = rawMiniProgram[name].bind(rawMiniProgram)
      }
    }
  }

  /** 打开指定页面并等它就绪。reLaunch 之后必须等一会儿，onLoad/onShow 是异步的。 */
  async open(route, opts = {}) {
    const { settle = 1200 } = opts
    await this.raw.reLaunch(route)
    await new Promise((r) => setTimeout(r, settle))
    return this.page
  }

  /**
   * 拿基础库版本和运行环境。
   * 为什么不用 systemInfo()：它走已废弃的 wx.getSystemInfoSync，字段随版本漂移。
   * 这里用官方推荐的替代接口，并对老基础库做降级。
   */
  async baseInfo() {
    return this.raw.evaluate(() => {
      if (typeof wx.getAppBaseInfo === 'function') {
        const b = wx.getAppBaseInfo()
        return { SDKVersion: b.SDKVersion, version: b.version, language: b.language, source: 'getAppBaseInfo' }
      }
      const s = wx.getSystemInfoSync()
      return { SDKVersion: s.SDKVersion, version: s.version, platform: s.platform, source: 'getSystemInfoSync(fallback)' }
    })
  }

  /** 存一张截图到磁盘，返回路径。跑失败时留证据用。 */
  async saveScreenshot(filePath) {
    const fs = require('fs')
    const path = require('path')
    const data = await this.raw.screenshot()
    const base64 = String(data).replace(/^data:image\/\w+;base64,/, '')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
    return filePath
  }

  /** 收尾。launch() 起的 cli 子进程一并收掉，不然会残留。 */
  async teardown() {
    try {
      await this.raw.disconnect()
    } catch {
      /* 断开失败无所谓，进程要杀掉的 */
    }
    if (this._cliProcess && !this._cliProcess.killed) {
      this._cliProcess.kill()
    }
  }
}

/**
 * 起一个 DevTools 自动化会话并返回可用的 MiniProgram。
 * 修掉了官方 launch() 在 Windows + Node ≥18.20 上必炸的 spawn EINVAL。
 */
async function launchMiniProgram(opts) {
  const { miniProgram, cliProcess } = await launch(opts)
  return new MiniProgram(miniProgram, cliProcess)
}

/** 连一个已经在跑的自动化会话（在开发者工具里手动开了端口时用）。 */
async function connectMiniProgram(opts) {
  const raw = await connect(opts)
  return new MiniProgram(raw, null)
}

module.exports = {
  launch: launchMiniProgram,
  connect: connectMiniProgram,
  MiniProgram,
  PageProxy,
  // 低层工具，给想自己控制流程的人
  resolveCliRunner,
  detectCliPath,
  rawLaunch: launch,
}
