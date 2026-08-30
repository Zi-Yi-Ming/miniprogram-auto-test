---
name: miniprogram-auto-test
description: "AI 辅助微信小程序自动化测试 / UI 测试 / 回归测试。当开发者说『帮我测一下这个小程序页面 / 生成小程序测试脚本 / 自动化测试小程序 / UI 测试 miniprogram / 端到端测试 weapp / regression test wechat miniprogram / 小程序冒烟测试』时使用。读懂小程序 WXML + JS 页面代码，生成可直接运行的自动化测试脚本，在微信开发者工具里跑并出报告。覆盖点击 tap、输入 input、页面跳转、数据断言、状态摆位。开源工具。"
---

# miniprogram-auto-test — AI 辅助微信小程序自动化测试

## 这是什么

把「手写小程序自动化测试脚本」变成「一句话生成」。开发者指一个页面 + 说要测什么流程，本 skill 引导你（AI）读懂页面的 WXML/JS，生成一个能直接跑的测试脚本，并在微信开发者工具里执行、出报告。

> ⚠️ 这是 AI 辅助生成脚本的工具，不是实时看屏幕自己决定点哪的 GUI agent。那种是未来方向，本 skill 不做。

## 🔴 先读这段：官方 SDK 的两个坑，本 skill 的做法和官方文档不一样

微信官方 SDK 是 `miniprogram-automator`（npm，latest `0.12.1`，**2023-11 后未更新**）。它是唯一的技术地基，但**官方文档教的主要用法在当前版本开发者工具上是死的**。以下两条都是实测确诊，不是推测：

**① `Page.*` 协议整族不响应**（DevTools 2.01.2510290 / 基础库 3.17.0 实测）
`page.data()` / `page.setData()` / `page.callMethod()` / `page.$()` / `page.$$()` / xpath 系列**全部超时**；`Element.*` 因为拿不到 element handle 而整族不可达。也就是官方文档首页那个 `page.$('.btn').tap()`，跑不通。
活着的是 `App.*` 和 `Tool.*` 两族 —— 其中 `miniProgram.evaluate()` 能在小程序运行时里执行任意代码。**所以正确做法是把元素层能力全部重建在 `evaluate` 之上。**

**② `launch()` 在 Windows + Node ≥18.20 上必抛 `spawn EINVAL`**
Node 修了 CVE-2024-27980（BatBadBut）之后，不带 `shell:true` 地 spawn `.bat` 会抛 `EINVAL(-4071)`。官方 `Launcher` 正好这么干，而且把它错报成「`cliPath` 不对」，害你去查一个没问题的路径。

**结论：生成脚本时用 `miniprogram-automator-next`**（本项目提供，把上面两条都修了，并把 `tap`/`query`/`setData` 重建在 `evaluate` 上）。它以 `miniprogram-automator` 为 peerDependency，底层还是官方 SDK。

> 适用范围声明：以上结论在 **DevTools 2.01.2510290 / 基础库 3.17.0 / Node v24.12.0 / Windows 11** 上实测。
>
> **嫌疑变量是开发者工具版本，不是基础库。** 判据：`evaluate` 是在基础库运行时里执行 JS 的，它 5-9ms 正常返回 —— 基础库运行时和 WS 通道都健康。死掉的是按**协议域**切分的 `Page.*`/`Element.*` 两族（协议域是工具那一侧的实现边界），更像 SDK ↔ 工具 的版本错配。**不过这是推断不是实测**（没在别的工具版本上跑过对照）。所以要重测就换**工具版本**，换基础库大概率白费 —— 判据见文末「怎么自己重测 Page.* 是否复活」。

## 前置环境（缺一不可）

| 依赖 | 说明 | 怎么确认 |
|---|---|---|
| 微信开发者工具 | 驱动模拟器 | 装了并**启动过至少一次**（首次要登录） |
| Node.js | 跑测试脚本 | `node -v` |
| `miniprogram-automator-next` | 本项目的修复包（底层还是官方 SDK） | 在**被测小程序项目**里 `npm i -D miniprogram-automator-next` |
| `miniprogram-automator` | 官方 SDK，是上面那个包的 peerDependency | **npm 7+ 会自动装上**，不用单独装；要锁版本才手动 `npm i -D miniprogram-automator` |

**开发者工具里必须开的三个开关**（设置 → 安全设置），少一个就卡住：

1. **服务端口** —— 不开则 CLI 完全不可用。
2. **CLI/HTTP 调用功能** —— 不开则 `auto` 命令起不来。
3. **自动化接口打开工具时默认信任项目** —— 不开则每次 launch 会弹「是否信任此项目」，脚本在那儿干等到超时。这条最容易漏，因为它的症状是「超时」而不是「弹窗」（弹窗在工具窗口里，跑脚本的人看不到）。

**DevTools CLI 路径**：
**别照抄网上的默认路径。**安装位置是用户可改的（实测本机装在 `D:\微信web开发者工具\`，不在 `Program Files` 下）。让包自己探测（不传 `cliPath` 即可），探不到再问用户。手动探测方法：

```powershell
Get-Process wechatdevtools | Select-Object Path   # 工具开着时最准
```

**天然边界**：强依赖本地 DevTools，**只能在开发者本机跑（Win/Mac），不能 Linux/CI/云端**。这是官方 SDK 的限制。定位就是「开发者本机的 AI 测试助手」。

## 触发后的工作流

1. **定位被测页面**：让用户给出页面目录（如 `pages/home/`）。读两个文件：
   - `index.wxml` —— 拿 class、`wx:if` 条件、**`bindtap`/`bindinput` 的 handler 名**（这个最关键，见第 3 步）
   - `index.ts` / `index.js` —— 拿 `data` 字段、handler 实现、前置校验逻辑
2. **确认测试目标**：一句话问用户「要测什么流程」。**别擅自扩大范围**。
3. **生成脚本**，照下方模板改。生成时必须做的两个判断：
   - **元素被 `wx:if` 藏着吗？** 看 WXML 的条件。藏着就先 `page.setData({...})` 把页面摆到目标状态，别去走完整前置流程。
   - **`tap` 的 handler 名是什么？** 从 WXML 的 `bindtap="xxx"` 抄出来传给 `tap()`。**运行时读不到事件绑定**，只能静态读 —— 这是「AI 读 WXML」在本方案里不是包装卖点、而是技术必要条件的原因。
4. **给运行命令**：`node xxx.test.js`。
   ⚠️ Node 的 `require` 是从**脚本所在目录**往上找 `node_modules` 的，**跟你 cd 到哪无关**。脚本放在被测项目内部最省事；放外面就得像模板那样显式改 resolve。
5. **跑失败就帮排错**：按下方「失败排查」逐条对，先看是不是环境问题。

## 脚本模板（这份是在真实项目上跑通的）

```javascript
const assert = require('assert')
const path = require('path')

const PROJECT_PATH = 'D:\\your\\miniprogram'   // 含 project.config.json 那层
// cliPath 不传则自动探测；探不到再显式给
// const CLI_PATH = 'D:\\微信web开发者工具\\cli.bat'

const { launch } = require('miniprogram-automator-next')

;(async () => {
  let mp
  try {
    // launch 冷启动 6~13s 是正常的。它会等 cli 的就绪信号再连，别嫌慢——
    // 「秒启动」反而是坏事，说明连上了上一轮的残留会话（见坑点表）。
    mp = await launch({ projectPath: PROJECT_PATH, port: 9420 })

    const info = await mp.baseInfo()
    console.log(`基础库 ${info.SDKVersion} / 工具 ${info.version}`)

    // open = reLaunch + 等页面就绪（onLoad/onShow 是异步的，settle 太短会拿到半成品状态）
    const page = await mp.open('/pages/home/index', { settle: 2000 })
    assert.strictEqual((await page.route()).route, 'pages/home/index')

    // ── 断言 1：某态下元素不该渲染 ──
    // WXML: <button wx:if="{{phase === 'guest'}}" class="guest-login-btn" bindtap="loginAndLoad">
    await page.setData({ phase: 'empty' })
    await page.wait(300)
    assert.strictEqual(await page.count('.guest-login-btn'), 0)

    // ── 断言 2：摆到目标态后元素出现且有实际尺寸 ──
    await page.setData({ phase: 'guest' })
    await page.waitForSelector('.guest-login-btn', { timeout: 3000 })
    const btn = await page.query('.guest-login-btn')
    assert.ok(btn.width > 0 && btn.height > 0, `按钮应有尺寸，实际 ${btn.width}×${btn.height}`)

    // ── 断言 3：点击，handler 被真实调起 ──
    // 'loginAndLoad' 来自 WXML 的 bindtap，运行时读不到，只能静态抄
    const r = await page.tap('.guest-login-btn', 'loginAndLoad')
    assert.strictEqual(r.handler, 'loginAndLoad')

    console.log('===== 全部通过 =====')
  } catch (e) {
    console.error('✗ 失败:', e.message)
    // 失败时留截图，比看报错文字有用
    if (mp) try { await mp.saveScreenshot(path.join(__dirname, 'fail.png')) } catch {}
    process.exitCode = 1
  } finally {
    if (mp) await mp.teardown()   // 必须收，否则 cli 子进程残留
  }
})()
```

## API 速查

### 能用的官方能力（`App.*` / `Tool.*` 协议，本包直接透传，括号内是实测耗时）

| 方法 | 作用 | 备注 |
|---|---|---|
| `mp.evaluate(fn, ...args)` (5-9ms) | 在小程序运行时执行代码 | **本方案一切能力的地基** |
| `mp.pageStack()` (5ms) | 页面栈 | |
| `mp.screenshot()` (83ms) | 截图，返回 base64 | 本包另有 `saveScreenshot(路径)` 直接存盘 |
| `mp.callWxMethod(name, ...)` | 调 wx API | |
| `mp.mockWxMethod(name, ...)` (7ms) | mock wx API | mock `wx.request` 造数据用 |
| `mp.reLaunch/redirectTo/navigateTo/navigateBack/switchTab` (3.9-7.3s) | 导航 | 冷启动慢，别给太短超时 |
| `mp.systemInfo()` (7ms) | 系统信息 | ⚠️ 底层是已废弃的 `wx.getSystemInfoSync`，字段随基础库版本漂移，**别断言具体字段**。要版本信息用本包 `mp.baseInfo()`（走 `wx.getAppBaseInfo()`） |

### 本包重建的能力（替代死掉的 `Page.*` / `Element.*`）

| 方法 | 替代了官方的 | 说明 |
|---|---|---|
| `page.data(key?)` | `page.data()` | 不给 key 拿整个 data |
| `page.setData(patch)` | `page.setData()` | **把页面强行摆到想测的状态**，是本方案最好用的一招 |
| `page.route()` | — | 返回 `{route, options}` |
| `page.callMethod(name, ...args)` | `page.callMethod()` | 不带 event 对象；读 `e.xxx` 的 handler 请用 `tap()` |
| `page.query(sel, index?)` | `page.$()` | 返回 `{id, dataset, left, top, width, height, ...}`，没匹配到返回 `null` |
| `page.queryAll(sel)` | `page.$$()` | |
| `page.exists(sel)` / `page.count(sel)` | — | 断言里最常用 |
| `page.tap(sel, 'handlerName')` | `element.tap()` | **必须给 handler 名**，见下 |
| `page.input(sel, value, 'handlerName')` | `element.input()` | 构造 `{detail:{value}}` 调 `bindinput` 的 handler |
| `page.trigger('handlerName', detail)` | `element.trigger()` | picker/switch/slider 这类用它 |
| `page.wait(ms)` | `page.waitFor(ms)` | |
| `page.waitForSelector(sel, {timeout})` | — | 异步渲染必用 |
| `page.waitForData(fn, {timeout})` | — | predicate 在 **Node 侧**执行，所以闭包正常可用 |
| `mp.open(route, {settle})` | — | `reLaunch` + 等就绪 |
| `mp.baseInfo()` / `mp.saveScreenshot(p)` / `mp.teardown()` | — | |

**`tap` 为什么必须给 handler 名**：`Element.tap` 协议不可达，所以「点击」实际是**构造 event 对象直接调页面 handler**。三个要素里：元素存在性/位置/`dataset` 运行时读得到（包会自动读出来填进 event，所以读 `e.currentTarget.dataset.xxx` 的 handler 能正常工作，你不用手抄）；但 `bindtap="xxx"` 这个绑定关系 `selectorQuery.fields()` 不给，**只存在于 WXML 源码里**。

### ❌ 已死，别生成（当前版本工具上必超时）

`page.$()`、`page.$$()`、`page.data()`、`page.setData()`、`page.callMethod()`、`page.waitFor()`、xpath 系列、`element.*` 全族。
另外 `miniProgram.callMethod()` **官方就不存在**（`callMethod` 在 `Page` 上，不在 `MiniProgram` 上），别写。

## 坑点清单（生成脚本时主动规避）

| 坑 | 症状 | 规避 |
|---|---|---|
| **残留自动化端口** | launch **不到 1 秒就"成功"**，然后随便哪个后续调用抛 `Connection closed, check if wechat web devTools is still running` | cli 子进程被 kill 后 DevTools 不会立刻关端口，你连上的是**上一轮的残留会话**，几秒后被新会话顶掉。报错会伪装成「某个 API 有毒」。本包已修（等就绪信号 + 连上后隔 1.5s 复探）。**判据：干净启动要 6-13s，秒启动必有问题** |
| **IDE 服务端口 ≠ 自动化端口** | 抄了设置里的「服务端口」去 `connect`，报 `Failed connecting to ws://...` | 设置里那个是 IDE 的 HTTP 服务端口（cli 启动时打 `IDE server has started`），**每次启动都变**。自动化端口只有用 CLI 带 `--auto-port` 起会话才有。**所以用 `launch()`（端口自己定），别指望人肉抄端口** |
| **`evaluate` 的闭包不生效** | 函数体里引用外部变量 → `xxx is not defined` | 函数是序列化过去执行的。外部值**必须当参数传**：`evaluate((a,b)=>a+b, 3, 4)` |
| **小程序逻辑层禁用 `eval`/`new Function`** | 想在 evaluate 里还原一个函数 → 报错 | 凡是需要函数的，在 Node 侧构造好、把**结果**当数据传进去 |
| **元素被 `wx:if` 藏着** | 选择器选不到，看着像选择器写错 | 先读 WXML 的条件，`setData` 摆到对应状态，再 `waitForSelector` |
| **异步没等够** | 断言拿到半成品状态 | `open()` 给足 `settle`；关键操作后用 `waitForSelector`/`waitForData` 轮询，别用固定 sleep 赌 |
| **selector 不是完整 CSS** | 写了 `nth-child`、属性选择器选不到 | `createSelectorQuery` 官方只支持 id / class / 标签 / `::before` `::after` 及其并集与后代组合 |
| **自定义组件内的元素/方法** | 元素查不到，或 handler「在页面对象上不存在」 | 页面级查询不跨组件边界，`tap` 也只调页面方法。测组件内部要另找路子（本方案当前的已知边界） |
| **`tap` 后没反应** | handler 有前置校验（未登录拦截之类） | 读页面 JS 的 handler 实现，先满足前置条件 |
| **SDK 两年没更新** | 新版工具上协议行为变了 | 就是上面「`Page.*` 已死」的来源。遇到全族超时先怀疑这条，别怀疑自己代码 |

## 失败排查（按序对）

| 报错关键词 | 大概率原因 | 处理 |
|---|---|---|
| `spawn EINVAL` / `-4071` | Node ≥18.20 禁 spawn `.bat` | 用 `miniprogram-automator-next` 的 `launch()`；官方 `launch()` 在 Windows 上没救 |
| `Failed to launch wechat web devTools, please make sure cliPath is correctly specified` | **大概率不是 cliPath 的问题**，是上一条 | 同上。这句错误信息本身就是误导 |
| 等端口超时 | 三个开关有没开的（尤其「默认信任项目」）/ 项目编译不过 | 逐个开关确认；去工具里手动编译一次看有没有报错 |
| `Connection closed, check if wechat web devTools is still running` | 残留会话抢跑（看 launch 是不是秒成功）/ 工具真被关了 | 看坑点表第一条；再确认 `Get-Process wechatdevtools` 有没有进程 |
| `Failed connecting to ws://127.0.0.1:xxxxx` | 抄了 IDE 服务端口 | 改用 `launch()` |
| 所有 `page.*` 超时 | `Page.*` 协议已死 | 换本包的 `PageProxy` 用法 |
| `miniprogram-automator` 找不到 | require 从**脚本所在目录**找 node_modules | 脚本挪进被测项目，或按模板显式改 resolve |
| 选不到元素 | `wx:if` / 组件边界 / selector 语法 | `page.data()` 看状态；`page.count()` 确认数量；见坑点表 |

## 安全约束

- **不动用户的 `project.config.json`**（尤其 `appid`），只读不改。
- 测试脚本里**别写真实手机号、支付、敏感个人信息**，用占位（`13800000000`、`测试`）。
- **`tap` 真实入口会发起真实请求**（登录、下单）。碰到这类 handler，要么只断言「handler 被调起」，要么先 `mockWxMethod('request', ...)` 把网络挡掉。
- 生成的脚本默认放被测项目的 `tests/` 或当前目录，**不覆盖已有同名文件** —— 加 `_auto` 后缀或先问用户。

## 怎么自己重测「`Page.*` 是否在你的版本上复活了」

别只跑一遍就下结论 —— 会话失效也会表现成「全超时」，容易误判。做法：**把 `Page.*` 调用和一个 `evaluate` 调用交错着跑，并且互换先后顺序各跑一次**。如果 `evaluate` 一直是几毫秒返回、而 `Page.*` 一直超时（哪怕它排在最前面），才能确定是协议死了而不是会话断了。

```javascript
const t = Date.now(); await mp.evaluate(() => 1); console.log('evaluate', Date.now() - t, 'ms')
const p = await mp.currentPage()
try { const t2 = Date.now(); await p.data(); console.log('Page.data 活了', Date.now() - t2, 'ms') }
catch (e) { console.log('Page.data 死:', e.message) }
```

## 评测套件（`evals/`）

本 skill 目录下带一套 skill-up 风格的评测套件（`eval.yaml` + `evals/cases/` 共 7 个用例），考察 AI 读完本 skill 后的输出质量：避开已死 API、`wx:if` 状态摆位、识别误导性的 `spawn EINVAL` 报错、识别残留会话、基础脚本生成、真实请求的安全处理、拒绝在 Linux/CI 上跑。**改完本 skill 建议跑一遍**，确认措辞调整没有把某个用例带崩；单例实测约 260s，报告输出 json + html。

## 参考

- 官方 SDK：`miniprogram-automator`（npm，latest `0.12.1`，⚠️ 2023-11 后未更新）。`repository` 指向腾讯内网域名，**没有公开仓库，没法提 PR**，这也是本项目存在的原因。
- 官方文档：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/`（正文是 JS 动态渲染，难实时抓，所以速查表写进本 skill）
- 官方另有「小程序云测」「智能化 Monkey」（云端平台），与本 skill 定位不同。
