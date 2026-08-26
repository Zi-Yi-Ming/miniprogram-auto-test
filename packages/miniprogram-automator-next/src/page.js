'use strict'

/**
 * 在 evaluate（App.callFunction 协议）之上重建元素层能力。
 *
 * 为什么不用官方 API：在微信开发者工具 2.01.2510290（基础库 3.17.0）上，
 * automation 协议的 Page.* 命令族全部不响应 —— page.data() / setData() /
 * callMethod() / $() / $$() / xpath 系列全超时，Element.* 因为拿不到
 * element handle 而整族不可达。也就是说官方文档教的主要用法
 * （page.$('.btn').tap()）在当前版本工具上是死的。
 *
 * 活着的是 App.* 和 Tool.*，其中 App.callFunction（也就是 mp.evaluate）
 * 能在小程序运行时里执行任意代码。本文件的全部能力都建在它之上。
 *
 * ⚠️ evaluate 的函数是序列化过去执行的，闭包不生效 ——
 *    外部值必须当参数传，函数体内只能用 wx / getCurrentPages 这些运行时全局。
 */

/**
 * 构造一个足够真实的 tap 事件对象。有 rect 时连坐标一起填，让读 detail.x/y 的 handler 也能工作。
 *
 * 注意这个函数在 Node 侧执行、结果当参数传进 evaluate ——
 * 不能塞进 evaluate 的函数体里靠 new Function 还原，
 * 小程序逻辑层禁用 eval / new Function。
 */
function buildTapEvent(dataset, id, rect) {
  const x = rect ? rect.left + rect.width / 2 : 0
  const y = rect ? rect.top + rect.height / 2 : 0
  const touch = { identifier: 0, pageX: x, pageY: y, clientX: x, clientY: y }
  const target = { id: id || '', dataset: dataset || {}, offsetLeft: 0, offsetTop: 0 }
  return {
    type: 'tap',
    timeStamp: 0,
    target,
    currentTarget: target,
    detail: { x, y },
    touches: [touch],
    changedTouches: [touch],
  }
}

class PageProxy {
  /**
   * @param {object} miniProgram 官方 SDK 的 MiniProgram 实例（App 和 Tool 两族协议仍可用）
   */
  constructor(miniProgram) {
    this.mp = miniProgram
  }

  // ─────────────────────────────────────────────────────────
  // 状态读写
  // ─────────────────────────────────────────────────────────

  /** 读当前页的 data。实测 9ms。替代死掉的 page.data()。 */
  async data(key) {
    const res = await this.mp.evaluate((k) => {
      const ps = getCurrentPages()
      if (!ps.length) return { __error: '页面栈为空' }
      const cur = ps[ps.length - 1]
      return { __value: k ? cur.data[k] : cur.data }
    }, key)
    return unwrap(res)
  }

  /** 当前页路由信息。 */
  async route() {
    const res = await this.mp.evaluate(() => {
      const ps = getCurrentPages()
      if (!ps.length) return { __error: '页面栈为空' }
      const cur = ps[ps.length - 1]
      return { __value: { route: cur.route, options: cur.options || {} } }
    })
    return unwrap(res)
  }

  /**
   * 改当前页 data。实测 16ms。替代死掉的 page.setData()。
   * 主要用途：把页面强行摆到想测的状态（比如强制 phase='guest' 让登录按钮渲染出来），
   * 免得为了测一个分支去走完整的前置流程。
   */
  async setData(patch) {
    const res = await this.mp.evaluate(
      (p) =>
        new Promise((resolve) => {
          const ps = getCurrentPages()
          if (!ps.length) return resolve({ __error: '页面栈为空' })
          const cur = ps[ps.length - 1]
          cur.setData(p, () => resolve({ __value: true }))
        }),
      patch
    )
    return unwrap(res)
  }

  /** 直接调页面方法。替代死掉的 page.callMethod()。注意：不带 event 对象，读 e.xxx 的 handler 请用 tap()。 */
  async callMethod(name, ...args) {
    const res = await this.mp.evaluate(
      (n, a) => {
        const ps = getCurrentPages()
        if (!ps.length) return { __error: '页面栈为空' }
        const cur = ps[ps.length - 1]
        if (typeof cur[n] !== 'function') {
          return { __error: '页面上没有方法 ' + n + '，实际有: ' + Object.keys(cur).filter((k) => typeof cur[k] === 'function').join(', ') }
        }
        const r = cur[n].apply(cur, a)
        return { __value: r === undefined ? null : r }
      },
      name,
      args
    )
    return unwrap(res)
  }

  // ─────────────────────────────────────────────────────────
  // 元素查询
  // ─────────────────────────────────────────────────────────

  /**
   * 查元素：存在性 + 几何位置 + dataset + id。实测 34-55ms。
   * 走 wx.createSelectorQuery().fields()，替代死掉的 page.$()。
   *
   * @returns {Promise<object|null>} 没匹配到返回 null
   */
  async query(selector, index = 0) {
    const list = await this.queryAll(selector)
    return list[index] || null
  }

  /** 查所有匹配元素。替代死掉的 page.$$()。 */
  async queryAll(selector) {
    const res = await this.mp.evaluate(
      (sel) =>
        new Promise((resolve) => {
          wx.createSelectorQuery()
            .selectAll(sel)
            .fields({ id: true, dataset: true, rect: true, size: true, scrollOffset: true }, (r) => {
              resolve({ __value: Array.isArray(r) ? r : r ? [r] : [] })
            })
            .exec()
        }),
      selector
    )
    return unwrap(res)
  }

  /** 元素是否存在。断言里最常用的一个。 */
  async exists(selector) {
    const list = await this.queryAll(selector)
    return list.length > 0
  }

  /** 匹配数量。 */
  async count(selector) {
    const list = await this.queryAll(selector)
    return list.length
  }

  // ─────────────────────────────────────────────────────────
  // 交互
  // ─────────────────────────────────────────────────────────

  /**
   * 点击元素。实测 5ms，双向状态切换验证通过。
   *
   * ⚠️ 必须传 handler（WXML 里 bindtap="xxx" 的那个名字）。
   *
   * 为什么不能自动推断：Element.tap 协议不可达，所以「点击」实际是
   * 构造 event 对象直接调页面 handler。而运行时查不到事件绑定 ——
   * selectorQuery.fields() 只给 id/dataset/rect，不给 bindtap。
   * 事件绑定只存在于 WXML 源码里，只能静态读出来。
   *
   * 好消息是 dataset 运行时拿得到，会自动从元素上读出来填进 event，
   * 所以读 e.currentTarget.dataset.xxx 的 handler 能正常工作，你不用手抄。
   *
   * @param {string} selector  CSS 选择器
   * @param {string|object} handler  handler 名，或 {handler, index, dataset}
   */
  async tap(selector, handler) {
    const opts = typeof handler === 'string' ? { handler } : handler || {}
    const { handler: name, index = 0 } = opts

    if (!name) {
      throw new Error(
        `tap('${selector}') 需要 handler 名。\n` +
          '因为 Element.tap 协议在当前 DevTools 上不可达，点击是靠构造 event 调页面 handler 实现的，\n' +
          `而事件绑定运行时读不到。请从 WXML 里找到该元素的 bindtap，例如：\n` +
          `  <view class="..." bindtap="onSomething">  →  tap('${selector}', 'onSomething')`
      )
    }

    const el = await this.query(selector, index)
    if (!el) {
      const total = await this.count(selector)
      throw new Error(
        `tap 失败：选择器 '${selector}' ${total === 0 ? '没匹配到任何元素' : `只匹配到 ${total} 个，取不到 index=${index}`}。\n` +
          '常见原因：元素被 wx:if 藏起来了（可以先 setData 把页面摆到对应状态），或选择器写错了。'
      )
    }

    const dataset = opts.dataset || el.dataset || {}
    const rect = { left: el.left, top: el.top, width: el.width, height: el.height }
    const event = buildTapEvent(dataset, el.id, rect)

    const res = await this.mp.evaluate(
      (n, ev) => {
        const ps = getCurrentPages()
        if (!ps.length) return { __error: '页面栈为空' }
        const cur = ps[ps.length - 1]
        if (typeof cur[n] !== 'function') {
          return {
            __error:
              'WXML 里写的 handler "' + n + '" 在页面对象上不存在。检查拼写，或它是否定义在自定义组件里而不是页面上。' +
              ' 页面上实际有的方法: ' + Object.keys(cur).filter((k) => typeof cur[k] === 'function').join(', '),
          }
        }
        cur[n](ev)
        return { __value: { handler: n, dataset: ev.currentTarget.dataset } }
      },
      name,
      event
    )
    return unwrap(res)
  }

  /**
   * 输入框输入。原理同 tap：构造 {detail:{value}} 调 bindinput 的 handler。
   * @param {string} selector 只用于报错时定位，真正生效的是 handler
   */
  async input(selector, value, handler) {
    const opts = typeof handler === 'string' ? { handler } : handler || {}
    const { handler: name } = opts
    if (!name) {
      throw new Error(
        `input('${selector}') 需要 handler 名（WXML 里 bindinput="xxx" 的那个）。原因同 tap()。`
      )
    }
    const idx = opts.index || 0
    const el = await this.query(selector, idx)
    if (!el) {
      const total = await this.count(selector)
      throw new Error(
        `input 失败：选择器 '${selector}' ${total === 0 ? '没匹配到任何元素' : `只匹配到 ${total} 个，取不到 index=${idx}`}。\n` +
          '常见原因：元素被 wx:if 藏起来了（可以先 setData 把页面摆到对应状态），或选择器写错了。'
      )
    }
    const res = await this.mp.evaluate(
      (n, v, ds, id) => {
        const ps = getCurrentPages()
        if (!ps.length) return { __error: '页面栈为空' }
        const cur = ps[ps.length - 1]
        if (typeof cur[n] !== 'function') return { __error: '页面上没有 handler ' + n }
        const tgt = { id: id || '', dataset: ds || {} }
        cur[n]({ type: 'input', target: tgt, currentTarget: tgt, detail: { value: v, cursor: String(v).length }, timeStamp: 0 })
        return { __value: { handler: n, value: v } }
      },
      name,
      value,
      (el && el.dataset) || {},
      el && el.id
    )
    return unwrap(res)
  }

  /** 触发任意自定义事件的 handler，detail 自己给。表单组件（picker/switch/slider）用这个。 */
  async trigger(handler, detail = {}, dataset = {}) {
    const res = await this.mp.evaluate(
      (n, d, ds) => {
        const ps = getCurrentPages()
        if (!ps.length) return { __error: '页面栈为空' }
        const cur = ps[ps.length - 1]
        if (typeof cur[n] !== 'function') return { __error: '页面上没有 handler ' + n }
        const tgt = { id: '', dataset: ds }
        cur[n]({ type: 'change', target: tgt, currentTarget: tgt, detail: d, timeStamp: 0 })
        return { __value: { handler: n, detail: d } }
      },
      handler,
      detail,
      dataset
    )
    return unwrap(res)
  }

  // ─────────────────────────────────────────────────────────
  // 等待
  // ─────────────────────────────────────────────────────────

  /** 死等若干毫秒。 */
  wait(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** 轮询等元素出现。异步渲染的场景必用，不然会在元素还没渲染时就断言失败。 */
  async waitForSelector(selector, opts = {}) {
    const { timeout = 5000, interval = 200 } = opts
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await this.exists(selector)) return true
      await this.wait(interval)
    }
    throw new Error(`等元素 '${selector}' 超时（${timeout}ms）。它可能被 wx:if 藏着，或选择器写错。`)
  }

  /**
   * 轮询等 data 满足条件。
   * @param {Function} predicate 收到当前 data，返回 boolean。在 Node 侧执行，所以闭包正常可用。
   */
  async waitForData(predicate, opts = {}) {
    const { timeout = 5000, interval = 200 } = opts
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      last = await this.data()
      if (predicate(last)) return last
      await this.wait(interval)
    }
    throw new Error(`等 data 条件超时（${timeout}ms）。最后一次 data: ${JSON.stringify(last)}`)
  }
}

function unwrap(res) {
  if (res && res.__error) throw new Error(res.__error)
  return res ? res.__value : undefined
}

module.exports = { PageProxy }
