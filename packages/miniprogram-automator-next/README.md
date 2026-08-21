# miniprogram-automator-next

> 微信官方 `miniprogram-automator` 的适配层。修掉它在当前版本环境下**两处已经坏掉**的东西，其余能力原样透传。

**不是要替代官方 SDK** —— 它是本包的 `peerDependency`，底层还是它。

## 它修了什么

### ① `launch()` 在 Windows + Node ≥18.20 上必抛 `spawn EINVAL`

Node 修了 CVE-2024-27980（BatBadBut）之后，不带 `shell:true` 地 `spawn()` 一个 `.bat` 会抛 `EINVAL(-4071)`。官方 `Launcher` 正好这么干，而且把失败**错报**成：

```
Failed to launch wechat web devTools, please make sure cliPath is correctly specified
```

于是你会去反复检查一个完全没问题的路径。

修法：`cli.bat` 的全部内容就是 `"%~dp0.\node.exe" "%~dp0.\cli.js" %*`，所以本包直接 spawn 同目录的 `node.exe` + `cli.js` —— 绕开 `.bat`，且**不需要** `shell:true`（不重新打开 CVE 修掉的那个注入面）。

### ② `Page.*` / `Element.*` 协议整族不响应

实测 `page.data()` / `page.setData()` / `page.callMethod()` / `page.$()` / `page.$$()` / xpath 系列**全部超时**；`Element.*` 因为拿不到 element handle 而整族不可达。也就是官方文档首页那句 `page.$('.btn').tap()`，跑不通。

活着的是 `App.*` 和 `Tool.*` 两族，其中 `miniProgram.evaluate()` 能在小程序运行时执行任意代码。**本包把元素层能力整个重建在 `evaluate` 之上** —— 查元素、读写 data、点击、输入、等待，API 形状尽量贴近官方，换掉底层实现。

### 附带修的：残留自动化端口

cli 子进程被 kill 之后 DevTools 不会立刻关掉自动化端口，官方 `launch()` 会在 0.4s 内「成功」——连上的是**上一轮的残留会话**，几秒后被新会话顶掉，然后你在随后随便哪个调用上收到 `Connection closed, check if wechat web devTools is still running`。本包等 cli 的就绪信号再连，连上后探活 → 等 1.5s → 再探一次，把残留会话筛掉。

> **所以：冷启动 6~13s 是正常的，「秒启动」反而是坏事。**

## ⚠️ 适用范围

上面的存活情况在这个组合上实测：

| 项 | 版本 |
|---|---|
| 微信开发者工具 | 2.01.2510290 |
| 基础库 | 3.17.0 |
| `miniprogram-automator` | 0.12.1（2023-11-07 后未更新） |
| Node | v24.12.0 |
| OS | Windows 11 |

**嫌疑变量是开发者工具版本，不是基础库。** 判据：`evaluate` 是**在基础库运行时里执行 JS** 的，它 5-9ms 稳定返回 —— 基础库运行时和 WS 通道都健康。死掉的是按**协议域**切分的 `Page.*` / `Element.*` 两族，而 `App.*` / `Tool.*` 整族活着；协议域是**工具那一侧的实现边界**。加上官方 SDK 2023-11 后未更新而工具一直在走，更像 **SDK ↔ 工具** 的版本错配。

⚠️ **不过「是工具版本的锅」是推断，不是实测** —— 没在别的工具版本上跑过对照。所以要重测 `Page.*` 有没有复活，**该换的是工具版本**，换基础库大概率白费；只跑一遍还很容易把「会话失效」误判成「协议死亡」，正确重测方法见仓库 `docs/api-cheatsheet.md`。

**就算 `Page.*` 复活了，本包也仍然能用**（它走的是 `evaluate`，不依赖 `Page.*`）。

## 安装

```bash
npm i -D miniprogram-automator miniprogram-automator-next
```

`miniprogram-automator` 是 peerDependency，必须一起装。

> ⚠️ **本包尚未发布到 npm。** 在发布之前，把这个目录（`packages/miniprogram-automator-next/`）复制进你的项目，用相对路径 require：
> ```javascript
> const { launch } = require('./miniprogram-automator-next')
> ```
> `miniprogram-automator` 仍然要正常 `npm i -D`。

⚠️ **装在被测小程序项目里。** Node 的 `require` 是从**脚本所在目录**往上找 `node_modules` 的，跟你 `cd` 到哪无关 —— 测试脚本放在被测项目内部最省事。

**开发者工具里必须开三个开关**（设置 → 安全设置），少一个就卡住：

1. **服务端口** —— 不开则 CLI 完全不可用
2. **CLI/HTTP 调用功能** —— 不开则 `auto` 命令起不来
3. **自动化接口打开工具时默认信任项目** —— 最容易漏。不开则每次 launch 在工具窗口里弹「是否信任此项目」，而脚本在命令行干等到超时，**你看到的症状是「超时」不是「弹窗」**

## 用法

```javascript
const assert = require('assert')
const { launch } = require('miniprogram-automator-next')

;(async () => {
  let mp
  try {
    // cliPath 不传会自动探测。冷启动 6~13s 正常
    mp = await launch({ projectPath: 'D:\\your\\miniprogram', port: 9420 })

    const page = await mp.open('/pages/home/index', { settle: 2000 })
    assert.strictEqual((await page.route()).route, 'pages/home/index')

    // 元素被 wx:if="{{phase === 'guest'}}" 藏着 → 直接把页面摆过去
    await page.setData({ phase: 'guest' })
    await page.waitForSelector('.guest-login-btn', { timeout: 3000 })

    const btn = await page.query('.guest-login-btn')
    assert.ok(btn.width > 0 && btn.height > 0)

    // 'loginAndLoad' 来自 WXML 的 bindtap —— 运行时读不到，只能静态抄
    const r = await page.tap('.guest-login-btn', 'loginAndLoad')
    assert.strictEqual(r.handler, 'loginAndLoad')

    console.log('✓ 通过')
  } finally {
    if (mp) await mp.teardown()   // 必须收，否则 cli 子进程残留
  }
})()
```

## API

### `launch(options)` → `Promise<MiniProgram>`

| 参数 | 默认 | 说明 |
|---|---|---|
| `projectPath` | **必填** | 被测小程序项目根目录（含 `project.config.json` 那层） |
| `cliPath` | 自动探测 | DevTools 的 `cli.bat` / `cli`。**别照抄网上的默认路径**，安装位置用户可改 |
| `port` | `9420` | 自动化端口。⚠️ 不是设置里那个「服务端口」，见下 |
| `timeout` | `120000` | 等就绪的总超时（ms） |
| `verbose` | `true` | 把 cli 输出转发到 stdout |
| `trustProject` | `true` | 给 cli 带 `--trust-project`，免掉工具里的信任弹窗 |

自动探测失败时会抛错并让你显式给 `cliPath`。手动查：

```powershell
Get-Process wechatdevtools | Select-Object Path   # 工具开着时最准
```

### `connect(options)` → `Promise<MiniProgram>`

连一个已经在跑的自动化会话。参数 `{ port = 9420, wsEndpoint }`。

⚠️ **设置里显示的「服务端口」是 IDE 的 HTTP 服务端口，不是自动化端口**，而且每次启动都变。自动化端口只有用 CLI 带 `--auto-port` 起会话才有 —— 所以**优先用 `launch()`**（端口自己指定），别指望人肉抄端口来 `connect()`。

### `MiniProgram`

官方原样透传的（`App.*` / `Tool.*` 协议，活着）：

`evaluate` · `pageStack` · `currentPage` · `systemInfo` · `screenshot` · `reLaunch` · `redirectTo` · `navigateTo` · `navigateBack` · `switchTab` · `callWxMethod` · `mockWxMethod` · `restoreWxMethod` · `pageScrollTo` · `exposeFunction` · `close` · `disconnect` · `on`

> ⚠️ `currentPage()` 能拿到对象，但**这个对象基本没用** —— 它的方法全走已死的 `Page.*` 协议。要操作页面用 `mp.open()` 返回的 `PageProxy`。
>
> ⚠️ `systemInfo()` 底层是已废弃的 `wx.getSystemInfoSync`（基础库 2.20 起废弃），字段随版本漂移，**别断言具体字段**。要版本信息用 `mp.baseInfo()`。

本包新增：

| 方法 | 说明 |
|---|---|
| `mp.open(route, {settle=1200})` → `PageProxy` | `reLaunch` + 等页面就绪。`onLoad`/`onShow` 是异步的，`settle` 太短会拿到半成品状态 |
| `mp.baseInfo()` | 走 `wx.getAppBaseInfo()`，拿基础库/工具版本的正确姿势 |
| `mp.saveScreenshot(filePath)` | 截图直接存盘 |
| `mp.teardown()` | 断开会话 + 回收 cli 子进程。**必须调**，否则子进程残留，下一轮又撞残留端口 |

### `PageProxy`（全部建在 `evaluate` 之上）

| 方法 | 替代了官方的 | 说明 |
|---|---|---|
| `data(key?)` | `page.data()` | 不给 key 拿整个 `data` |
| `setData(patch)` | `page.setData()` | **把页面强行摆到想测的状态**，本包最好用的一招 |
| `route()` | — | `{route, options}` |
| `callMethod(name, ...args)` | `page.callMethod()` | 直接调页面方法，**不带 event 对象**。读 `e.xxx` 的 handler 用 `tap()` |
| `query(sel, index?)` | `page.$()` | `{id, dataset, left, top, width, height, ...}`，没匹配返回 `null` |
| `queryAll(sel)` | `page.$$()` | |
| `exists(sel)` / `count(sel)` | — | 断言里最常用 |
| `tap(sel, handler)` | `element.tap()` | **必须给 handler 名**，见下。也接受 `{handler, index, dataset}` |
| `input(sel, value, handler)` | `element.input()` | 构造 `{detail:{value}}` 调 `bindinput` 的 handler |
| `trigger(handler, detail, dataset?)` | `element.trigger()` | picker / switch / slider 这类用它 |
| `wait(ms)` | `page.waitFor()` | 纯 Node 侧 sleep |
| `waitForSelector(sel, {timeout})` | — | 轮询等元素出现，异步渲染必用 |
| `waitForData(fn, {timeout})` | — | predicate 在 **Node 侧**执行，所以**闭包正常可用** |

### 低层导出

`resolveCliRunner(cliPath)`（`.bat` → `{command, args}` 的 EINVAL 绕法）· `detectCliPath()` · `rawLaunch(opts)`（返回 `{miniProgram, cliProcess, port, cliPath}`，不套 `MiniProgram` 门面）—— 想自己控制流程时用。

## 必须知道的三件事

### ① `tap` 为什么要你手动给 handler 名

`Element.tap` 协议不可达，所以「点击」实际是**构造 event 对象直接调页面 handler**。三个要素：

| 要素 | 运行时拿得到吗 |
|---|---|
| 元素存在性 / 位置 / 尺寸 | ✅ `selectorQuery.fields({rect,size})` |
| 元素的 `dataset` / `id` | ✅ 本包**自动读出来填进 event**，读 `e.currentTarget.dataset.xxx` 的 handler 能正常工作，你不用手抄 |
| **`bindtap="xxx"` 这个绑定关系** | ❌ 拿不到。`fields()` 不给事件绑定，它**只存在于 WXML 源码里** |

所以要点一个按钮，必须有人去静态读 WXML 把 handler 名找出来。

### ② `evaluate` 的闭包不生效

函数是序列化过去执行的，外部值必须当参数传：

```javascript
const n = 42
await mp.evaluate(() => n + 1)        // ❌ n is not defined
await mp.evaluate((x) => x + 1, n)    // ✅ 43
```

而且**小程序逻辑层禁用 `eval` / `new Function`**，所以「在运行时侧还原一个函数」这条路是堵死的 —— 凡是需要函数的，在 Node 侧构造好、把**结果**当数据传进去。（本包的 `tap` 就是这么做的。）

### ③ selector 不是完整 CSS

`createSelectorQuery` 官方只支持 **id 选择器、class 选择器、标签选择器、`::before` / `::after`，以及它们的并集与后代组合**。

- ✅ `.guest-login-btn`、`#submit`、`.card .title`
- ❌ `:nth-child()`、属性选择器、伪类

原生小程序的 class 名不会被编译改掉（不是 CSS Modules），WXML 里写死的 class 直接用。选不到基本是三个原因：被 `wx:if` 藏着、跨了自定义组件边界、selector 语法不支持。

## 已知边界

**页面级 `selectorQuery` 不跨自定义组件边界，`tap` 也只调页面方法。** 组件内部的元素查不到，定义在组件里的 handler 会报「页面对象上不存在」。这是本包当前的边界。

另外：强依赖本地微信开发者工具 CLI，**只能在开发机（Win/Mac）跑，不支持 Linux / CI / 云端**。这是官方 SDK 的限制，不是本包的。

## 排错

| 报错关键词 | 大概率原因 |
|---|---|
| `spawn EINVAL` / `-4071` | 你还在用官方 `launch()`。换本包的 |
| `Failed to launch wechat web devTools, please make sure cliPath is correctly specified` | **大概率不是 cliPath 的问题**，是上一条。这句错误信息本身就是误导 |
| 等端口超时 | 三个开关有没开的（尤其「默认信任项目」）/ 项目编译不过 |
| `Connection closed, check if wechat web devTools is still running` | 残留会话抢跑（看 launch 是不是秒成功）/ 工具真被关了 |
| `Failed connecting to ws://127.0.0.1:xxxxx` | 抄了 IDE 服务端口去 `connect`。改用 `launch()` |
| 所有 `page.*` 超时 | `Page.*` 协议已死。用本包的 `PageProxy` |
| `miniprogram-automator` 找不到 | `require` 从**脚本所在目录**找 `node_modules`。把脚本挪进被测项目 |

## 为什么不去给官方提 PR

官方 SDK 的 `repository` 字段指向腾讯内网域名（`git.code.oa.com`），**没有公开仓库，物理上没法提 PR**。这就是本包存在的原因。

## License

MIT。上游 `miniprogram-automator` 亦为 MIT。

完整背景、AI 辅助生成测试脚本的用法、以及实测数据见仓库：[`miniprogram-auto-test`](../../README.md)。
