# miniprogram-auto-test

> 把「手写微信小程序自动化测试脚本」变成「一句话生成」——一个 Claude Code skill，让 AI 读懂你的小程序页面代码，自动生成可运行的测试脚本。
>
> 附带一个修复包 `miniprogram-automator-next`：**官方 SDK 在当前版本开发者工具上有两处是坏的，这里把它们修了。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## 🔴 先说两个实测结论（这是本项目真正的价值）

微信官方的 [`miniprogram-automator`](https://www.npmjs.com/package/miniprogram-automator) 是唯一的技术地基，但它 **2023-11 之后就没更新了**，而工具一直在往前走。实测（DevTools 2.01.2510290 / 基础库 3.17.0 / Node v24.12.0 / Windows 11）：

### ① 官方文档教的主要用法已经跑不通

`automation` 协议的 **`Page.*` 命令族整族不响应** —— `page.data()` / `page.setData()` / `page.callMethod()` / `page.$()` / `page.$$()` / xpath 系列**全部超时**；`Element.*` 因为拿不到 element handle 而整族不可达。

也就是官方文档首页那句 `page.$('.btn').tap()`，死了。

活着的是 `App.*` 和 `Tool.*` 两族，其中 `miniProgram.evaluate()` 能在小程序运行时执行任意代码。**本项目的做法是把元素层能力整个重建在 `evaluate` 之上** —— 查元素、读写 data、点击、输入、等待，全部重写，API 形状尽量贴近官方，换掉底层实现。

### ② `launch()` 在 Windows + Node ≥18.20 上必炸

Node 修了 CVE-2024-27980（BatBadBut）之后，不带 `shell:true` 地 `spawn()` 一个 `.bat` 会抛 `EINVAL(-4071)`。官方 `Launcher` 正好这么干。更坑的是它把这个失败**错报成**：

```
Failed to launch wechat web devTools, please make sure cliPath is correctly specified
```

于是你会去反复检查一个完全没问题的路径。

修法很干净：`cli.bat` 的全部内容就是 `"%~dp0.\node.exe" "%~dp0.\cli.js" %*`，所以直接 spawn 同目录的 `node.exe` + `cli.js` 就行 —— 绕开 `.bat`，且**不需要** `shell:true`（不重新打开 CVE 修掉的那个注入面）。

> 官方 SDK 的 `repository` 字段指向腾讯内网域名（`git.code.oa.com`），**没有公开仓库，物理上没法提 PR**。这也是这个修复包存在的原因。

## 为什么做这个

官方 SDK 是**裸 SDK**：每个测试用例都得你手写「选哪个元素、点什么、断言什么」。本项目的想法是**让 AI 读你的页面代码（WXML + JS），一句话生成这些脚本**。

而且在这个方案里，「AI 读 WXML」**不是包装卖点，是技术必要条件**：

因为 `Element.tap` 协议不可达，「点击」实际是**构造 event 对象直接调页面 handler**。三个要素里——元素存在性、位置、`dataset` 运行时都读得到；但 `bindtap="xxx"` 这个**绑定关系**运行时读不到（`selectorQuery.fields()` 只给 `id`/`dataset`/`rect`），它只存在于 WXML 源码里。所以要点一个按钮，就必须有人去静态读 WXML 把 handler 名找出来。

> 灵感来自 GUI agent（Qwen-UI-Agent 那类「让模型看屏幕操作」的方向），但走**更轻的路线**：不部署视觉模型实时看截图，而是让 AI 理解代码静态结构 → 生成确定性测试脚本。**脚本为主、探索为辅。**

## 它能做什么

- ✅ 读页面的 WXML + JS，理解元素结构、class、`wx:if` 条件、`bindtap` handler、`data` 字段。
- ✅ 按一句话需求生成 `*.test.js`（启动会话 → 打开页 → 摆状态 → 操作 → 断言 → 截图）。
- ✅ **直接把页面摆到想测的状态**（`setData`），不用为了测一个分支去走完整前置流程。
- ✅ 跑失败时按内置清单排错（元素被 `wx:if` 藏着、残留会话、异步没等够……）。

它**不做**：
- ❌ 实时看模拟器截图、自己决定点哪（未来的探索式测试方向）。
- ❌ 用例管理系统 / 报告平台 / 多项目仪表盘（保持轻量）。
- ❌ 云端 / CI 跑（强依赖本地微信开发者工具，天然只能在开发机跑）。

## 快速开始

### 1. 前置环境

装好[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)并**启动过至少一次**，然后在 **设置 → 安全设置** 里开三个开关：

1. **服务端口** —— 不开则 CLI 完全不可用
2. **CLI/HTTP 调用功能** —— 不开则 `auto` 命令起不来
3. **自动化接口打开工具时默认信任项目** —— ⚠️ **最容易漏的一个**。不开则每次 launch 都会在工具窗口里弹「是否信任此项目」，而你的脚本在命令行里干等到超时，看到的症状是「超时」不是「弹窗」

在被测小程序项目里装依赖：

```bash
npm i -D miniprogram-automator
# 修复包（尚未发布到 npm）：把本仓库 packages/miniprogram-automator-next/ 复制进去，用相对路径 require
```

**DevTools CLI 路径别照抄网上的默认值** —— 安装位置用户可改（实测本机在 `D:\微信web开发者工具\`，不在 `Program Files` 下）。不传 `cliPath` 时包会自己探测；要手动查：

```powershell
Get-Process wechatdevtools | Select-Object Path   # 工具开着时最准
```

### 2. 装 skill

把 `skill/` 目录复制到你的 Claude Code skills 目录：

- **Windows**：`C:\Users\<你>\.claude\skills\miniprogram-auto-test\`（里面放 `SKILL.md`）
- **macOS / Linux**：`~/.claude/skills/miniprogram-auto-test/`

然后重启 / 重载 Claude Code。

### 3. 用起来

在你的小程序项目里，对着 Claude Code 说：

> 帮我测一下 `pages/home/index` 这个页面，点登录按钮，断言按钮渲染出来并且 handler 被调起。

skill 会读 `pages/home/index.wxml` + `.ts`，生成脚本并给运行命令。

⚠️ **Node 的 `require` 是从「脚本所在目录」往上找 `node_modules` 的，跟你 `cd` 到哪无关。** 脚本放在被测项目内部最省事；放外面得显式改 resolve（见 demo 里的写法）。

## 目录结构

```
miniprogram-auto-test/
├── README.md
├── LICENSE                              ← MIT
├── skill/
│   └── SKILL.md                         ← skill 本体（复制到你 ~/.claude/skills/）
├── packages/
│   └── miniprogram-automator-next/      ← 修复包
│       └── src/{launcher,page,index}.js
├── demo/
│   └── home-login.test.js               ← 在真实小程序上跑通的示例
├── docs/
│   └── api-cheatsheet.md                ← API 速查（给人看）
└── verify-package.js                    ← 包自检：27 项，跑通才允许发布
```

## 一个示例

测「首页点登录按钮」（完整版见 [`demo/home-login.test.js`](./demo/home-login.test.js)，在真实项目上跑通）：

```javascript
const assert = require('assert')
const { launch } = require('miniprogram-automator-next')

;(async () => {
  let mp
  try {
    // 冷启动 6~13s 是正常的。「秒启动」反而是坏事——说明连上了残留会话
    mp = await launch({ projectPath: 'D:\\your\\miniprogram', port: 9420 })

    const page = await mp.open('/pages/home/index', { settle: 2000 })

    // 登录按钮被 wx:if="{{phase === 'guest'}}" 藏着 → 直接把页面摆过去
    await page.setData({ phase: 'guest' })
    await page.waitForSelector('.guest-login-btn', { timeout: 3000 })

    const btn = await page.query('.guest-login-btn')
    assert.ok(btn.width > 0 && btn.height > 0)

    // 'loginAndLoad' 来自 WXML 的 bindtap —— 运行时读不到，只能静态抄出来
    const r = await page.tap('.guest-login-btn', 'loginAndLoad')
    assert.strictEqual(r.handler, 'loginAndLoad')

    console.log('✓ 通过')
  } finally {
    if (mp) await mp.teardown()   // 必须收，否则 cli 子进程残留
  }
})()
```

## 已知限制（写在前面，不藏着）

| 限制 | 说明 |
|---|---|
| 只能在本机跑 | 强依赖微信开发者工具 CLI，不支持 Linux / CI / 云端 |
| 自定义组件是边界 | 页面级 `selectorQuery` 不跨组件边界，`tap` 也只调页面方法。组件内部的元素和方法当前测不了 |
| `tap` 要手动给 handler 名 | 不是偷懒，是运行时读不到事件绑定（见上文） |
| 结论绑版本 | 上面两个结论在 DevTools 2.01.2510290 / 基础库 3.17.0 / Node v24.12.0 / Win 11 上实测。**嫌疑变量是工具版本不是基础库**（`evaluate` 在基础库运行时里跑得好好的，死的是按协议域切分的 `Page.*`，那是工具侧的边界）——但这是推断不是实测。要重测请换**工具版本**，方法见 SKILL.md 末尾 |
| 修复包未发布 npm | 目前靠复制源码使用 |

## 相关项目（不装作是空白市场）

这个方向上已经有别人的东西，各自解决的问题不一样：

| 项目 | 思路 | 和本项目的关系 |
|---|---|---|
| `miniprogram-automator` | 微信官方 SDK | **本项目的地基**，不是竞品 |
| `@weapp-vite/miniprogram-automator` | 走 headless 模拟器 | 绕过了 `EINVAL` 而不是修它；和本项目路线不同 |
| `miniprogram-automator-mcp` / `@creatoria/miniapp-mcp` / `@purea/wechat-devtools-mcp` / `@chaixueyuan/weapp-agent-mcp` 等 | 包成 MCP server 给 AI 用 | 形态不同（MCP tool vs Claude Code skill）。本项目的差异在于**把 `Page.*` 已死这件事正面解决掉了**，而不是继续包装死掉的 API |

如果你只是想让 AI 能操作小程序，上面几个 MCP 可能更顺手。本项目更适合：想要**确定性、可提交进仓库、可重复跑的测试脚本**，并且撞上了上面两个坑。

## 适用 / 不适用

- 👍 **适合**：开发者本机回归测试、单页面流程验证、重复性 UI 冒烟。
- 👎 **不适合**：CI/CD 流水线、大规模云测、需要实时探索未知 bug（那些看官方「小程序云测」/「智能化 Monkey」）。

## 贡献

欢迎提 issue / PR。尤其欢迎：

- **不同 DevTools / 基础库版本上的 `Page.*` 存活情况**（重测方法见 SKILL.md 末尾，请务必按那个方法测——只跑一遍容易把会话失效误判成协议死亡）。
- 在你的小程序上跑通的 demo。
- 自定义组件内部元素的测试路子（当前的已知边界）。

## License

[MIT](./LICENSE)
