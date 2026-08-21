# 微信小程序自动化 API 能力矩阵（实测版）

> 这是 [`miniprogram-auto-test`](../README.md) 里 API 速查的独立版，方便不装 skill 也能当文档看。
>
> **和官方文档不一样的地方，都是实测结果，不是抄的。** 官方文档：https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/

## 测试环境

| 项 | 版本 |
|---|---|
| 微信开发者工具 | **2.01.2510290**（工具版本号 8.0.5） |
| 基础库 | **3.17.0** |
| `miniprogram-automator` | **0.12.1**（2023-11-07 后未更新） |
| Node | **v24.12.0** |
| OS | Windows 11 |

⚠️ **上面是环境记录，不等于四个变量都是嫌疑人。主要嫌疑变量是开发者工具版本，不是基础库。**

判据：`evaluate` 是**在基础库运行时里执行 JS** 的，它 5-9ms 稳定返回 —— 说明基础库运行时和 WS 通道都健康。死掉的是按**协议域**切分的 `Page.*` / `Element.*` 两族，而 `App.*` / `Tool.*` 整族活着；协议域是**开发者工具那一侧的实现边界**，不是基础库的边界。加上官方 SDK 2023-11 后未更新而工具一直在走，这形状更像 **SDK ↔ 工具** 的版本错配。

**但「是工具版本的锅」是推断，不是实测** —— 本项目没有在别的工具版本上跑过对照。能证明的只有「基础库运行时是好的」，推不出「换个工具版本就好了」。

所以要重测 `Page.*` 有没有复活，**该换的是工具版本**，换基础库大概率白费。重测方法见文末，**只跑一遍很容易把「会话失效」误判成「协议死亡」**。

## 一句话结论

**`App.*` 和 `Tool.*` 两族活着，`Page.*` 和 `Element.*` 两族全死。**

官方文档首页教的那句 `page.$('.btn').tap()`，在这个版本上跑不通。可用的路子是：`miniProgram.evaluate()` 还活着，能在小程序运行时执行任意代码，**把元素层能力整个重建在它上面**。

## ✅ 活着的（`App.*` / `Tool.*` 协议）

括号里是实测耗时；没标数字的是同族协议、未逐个计时。

| API | 耗时 | 说明 |
|---|---|---|
| `mp.evaluate(fn, ...args)` | **5-9ms** | 在小程序运行时执行代码。**一切的地基** |
| `mp.pageStack()` | 5ms | 页面栈 |
| `mp.currentPage()` | 2ms | ⚠️ 能拿到对象，但**这个对象基本没用**——它的方法全走 `Page.*` 协议，全死 |
| `mp.systemInfo()` | 7ms | ⚠️ 底层是 `App.callWxMethod('getSystemInfoSync')`，而 `wx.getSystemInfoSync` 从基础库 **2.20 起已废弃**，返回字段随版本漂移。**别断言具体字段**（比如 `SDKVersion` 不保证有）。要版本信息请自己 `evaluate(() => wx.getAppBaseInfo())` |
| `mp.screenshot()` | 83ms | 返回 base64 字符串，可存盘做测试报告 |
| `mp.reLaunch(path)` | **3.9-7.3s** | 冷启动慢，别给太短超时。同族还有 `redirectTo` / `navigateTo` / `navigateBack` / `switchTab` |
| `mp.mockWxMethod(name, ...)` | 7ms | mock `wx.request` 造数据用。配套 `restoreWxMethod` |
| `mp.callWxMethod(name, ...)` | — | 直接调 wx API |
| `mp.pageScrollTo(y)` | — | |
| `mp.exposeFunction(name, fn)` | — | |
| `mp.close()` / `mp.disconnect()` / `mp.on(...)` | — | |

## ❌ 死了的（`Page.*` / `Element.*` 协议，全部超时）

| API | 状态 |
|---|---|
| `page.data()` / `page.setData()` | 超时 |
| `page.callMethod()` | 超时 |
| `page.$(selector)` / `page.$$(selector)` | 超时 |
| xpath 系列 | 超时 |
| `page.waitFor()` | 超时 |
| `element.*` **全族** | 不可达 —— element handle 只能通过 `Page.getElement` 拿，而那个也死了 |

另外：**`miniProgram.callMethod()` 官方就不存在**（`callMethod` 在 `Page` 上，不在 `MiniProgram` 上）。有些教程里写了这个，是错的。

## 🔧 重建版（`miniprogram-automator-next`，全部建在 `evaluate` 之上）

括号里是实测耗时。

| 方法 | 替代 | 耗时 | 原理 |
|---|---|---|---|
| `page.data(key?)` | `page.data()` | 9ms | `getCurrentPages()` 取栈顶读 `.data` |
| `page.setData(patch)` | `page.setData()` | 16ms | 栈顶 `cur.setData(patch, cb)`，等回调 |
| `page.route()` | — | | 返回 `{route, options}` |
| `page.callMethod(name, ...args)` | `page.callMethod()` | | 直接 `cur[name](...args)`。**不带 event 对象**，读 `e.xxx` 的 handler 用 `tap()` |
| `page.query(sel, index?)` | `page.$()` | 34-55ms | `wx.createSelectorQuery().selectAll(sel).fields({id,dataset,rect,size,scrollOffset})` |
| `page.queryAll(sel)` | `page.$$()` | 同上 | 同上 |
| `page.exists(sel)` / `page.count(sel)` | — | 同上 | 断言里最常用 |
| `page.tap(sel, 'handler')` | `element.tap()` | **5ms** | 构造 event 对象 + 调页面 handler，见下 |
| `page.input(sel, v, 'handler')` | `element.input()` | | 构造 `{detail:{value}}` 调 `bindinput` 的 handler |
| `page.trigger('handler', detail)` | `element.trigger()` | | picker / switch / slider 这类用它 |
| `page.wait(ms)` | `page.waitFor()` | | 纯 Node 侧 sleep |
| `page.waitForSelector(sel, {timeout})` | — | | 轮询等元素出现，异步渲染必用 |
| `page.waitForData(fn, {timeout})` | — | | predicate 在 **Node 侧**执行，所以**闭包正常可用** |
| `mp.open(route, {settle})` | — | | `reLaunch` + 等页面就绪 |
| `mp.baseInfo()` | — | | 走 `wx.getAppBaseInfo()`，拿版本的正确姿势 |
| `mp.saveScreenshot(path)` | — | | 截图直接存盘 |
| `mp.teardown()` | `mp.close()` | | 断开 + 回收 cli 子进程 |

### `tap` 为什么必须手动给 handler 名

「点击」被拆成三个要素：

| 要素 | 运行时拿得到吗 |
|---|---|
| 元素存在性 / 位置 / 尺寸 | ✅ `selectorQuery.fields({rect,size})` |
| 元素的 `dataset` / `id` | ✅ `fields({dataset:true, id:true})`——**包会自动读出来填进 event**，所以读 `e.currentTarget.dataset.xxx` 的 handler 能正常工作，你不用手抄 |
| **`bindtap="xxx"` 这个绑定关系** | ❌ **拿不到**。`fields()` 不给事件绑定，它只存在于 WXML 源码里 |

所以要点一个按钮，必须有人去静态读 WXML 把 handler 名找出来。**这就是「AI 读 WXML」在本方案里不是包装卖点、而是技术必要条件的原因。**

## `evaluate` 的两条硬约束

**① 函数是序列化过去执行的，闭包不生效。** 外部值必须当参数传：

```javascript
const n = 42
await mp.evaluate(() => n + 1)        // ❌ n is not defined
await mp.evaluate((x) => x + 1, n)    // ✅ 43
```

**② 小程序逻辑层禁用 `eval` / `new Function`。** 所以「在运行时侧还原一个函数」这条路是堵死的——凡是需要函数的，在 Node 侧构造好、把**结果**当数据传进去。

（本包的 `tap` 就是这么做的：event 对象在 Node 侧拼好，整个当参数传进 `evaluate`。`waitForData` 的 predicate 也是在 Node 侧跑，顺带获得了「闭包可用」这个好处。）

## selector 不是完整 CSS

`createSelectorQuery` 官方只支持：**id 选择器、class 选择器、标签选择器、`::before` / `::after`，以及它们的并集与后代组合**。

- ✅ `.guest-login-btn`、`#submit`、`.card .title`
- ❌ `:nth-child()`、属性选择器、伪类

另外：**原生小程序的 class 名不会被编译改掉**（不是 CSS Modules），所以 WXML 里写死的 class 直接用就行。选不到基本是三个原因：被 `wx:if` 藏着、跨了自定义组件边界、selector 语法不支持。

## 已知边界

**页面级 `selectorQuery` 不跨自定义组件边界，`tap` 也只调页面方法。** 组件内部的元素查不到，定义在组件里的 handler 会报「页面对象上不存在」。这是本方案当前的边界。

## 两个环境坑（都会伪装成别的问题）

### ① `spawn EINVAL` 被错报成「cliPath 不对」

Node 修了 CVE-2024-27980 之后，不带 `shell:true` 地 `spawn()` 一个 `.bat` 会抛 `EINVAL(-4071)`。官方 `Launcher` 正好这么干，然后把失败错报成：

```
Failed to launch wechat web devTools, please make sure cliPath is correctly specified
```

于是你会去反复检查一个完全没问题的路径。修法：`cli.bat` 的内容就是 `"%~dp0.\node.exe" "%~dp0.\cli.js" %*`，所以直接 spawn 同目录 `node.exe` + `cli.js`——绕开 `.bat`，且不需要 `shell:true`。

### ② 残留自动化端口，被错报成「某个 API 有毒」

cli 子进程被 kill 之后，**DevTools 不会立刻关掉自动化端口**。下一次 `launch()` 会在 0.4s 内「启动成功」——连上的是**上一轮的残留会话**。几秒后新会话把它顶掉，你在随后随便哪个调用上收到：

```
Connection closed, check if wechat web devTools is still running
```

**判据：干净启动实测 6-13s，launch 秒成功必有问题。**

修法：等 cli 输出里那行单独的 `✔ auto` 再连（但它**只是必要条件不是充分条件**，实测它打完端口还可能没起来，所以仍要轮询）；连上后 `evaluate` 探活 → 等 1.5s → **再探一次**，残留会话在第二次探活被筛掉。

⚠️ **别用裸 TCP 探端口占用**：`net.connect` 捅一个 WS 服务端再 `destroy()`，实测把 DevTools 捅坏过一次（`✔ auto` 打了但端口始终不 listen，120s 超时）。

### ③ IDE 服务端口 ≠ 自动化端口

开发者工具「设置 → 安全设置」里显示的那个「服务端口」是 **IDE 的 HTTP 服务端口**（cli 启动时会打 `✔ IDE server has started, listening on http://127.0.0.1:16515`），**每次启动都变**，实测工具同时占着 7 个监听端口。

**自动化端口只有用 CLI 带 `--auto-port` 起会话才有。** 所以用 `launch()`（端口自己指定），别指望人肉抄端口去 `connect()`。

## 三个必须开的开关

设置 → 安全设置：

1. **服务端口** —— 不开则 CLI 完全不可用
2. **CLI/HTTP 调用功能** —— 不开则 `auto` 命令起不来
3. **自动化接口打开工具时默认信任项目** —— **最容易漏**。不开则每次 launch 在工具窗口里弹「是否信任此项目」，而脚本在命令行干等到超时，你看到的症状是「超时」不是「弹窗」

## 怎么自己重测 `Page.*` 是否复活

**别只跑一遍。** 会话失效也会表现成「全超时」，很容易误判。做法：**把 `Page.*` 调用和 `evaluate` 调用交错着跑，并且互换先后顺序各跑一次**。

只有当 `evaluate` 一直是几毫秒返回、而 `Page.*` 一直超时（**哪怕它排在最前面**），才能确定是协议死了而不是会话断了。

```javascript
const t = Date.now(); await mp.evaluate(() => 1); console.log('evaluate', Date.now() - t, 'ms')
const p = await mp.currentPage()
try { const t2 = Date.now(); await p.data(); console.log('Page.data 活了', Date.now() - t2, 'ms') }
catch (e) { console.log('Page.data 死:', e.message) }
```

（本项目当初就是这么排除掉「会话失效」这个可能的：把 `Page.*` 提到 0 秒位置跑，它超时；而 `evaluate` 在 46.9 秒位置跑，13ms 返回。）

## 参考

- npm：https://www.npmjs.com/package/miniprogram-automator
- 官方文档：https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/
- 官方 SDK 的 `repository` 指向腾讯内网域名（`git.code.oa.com`），**没有公开仓库，没法提 PR**。
- 官方另有「真机自动化」「录制回放」「小程序云测」「智能化 Monkey」等相邻能力，本项目未涉及。
