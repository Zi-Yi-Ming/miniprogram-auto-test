'use strict'

const path = require('path')
const fs = require('fs')
const cp = require('child_process')

/**
 * 把 DevTools 的 cli 路径解析成一个能被 spawn 的命令。
 *
 * 为什么需要这个：官方 SDK 直接 spawn cli.bat，而 Node 修了 CVE-2024-27980
 * （BatBadBut）之后，不带 shell:true 地 spawn .bat/.cmd 会抛 EINVAL(-4071)。
 * Node ≥18.20 / ≥20.12 都受影响，也就是说官方的 launch() 在 Windows 上必炸。
 *
 * cli.bat 的全部内容就是 `"%~dp0.\node.exe" "%~dp0.\cli.js" %*`，
 * 所以直接跑同目录的 node.exe + cli.js 即可 —— 绕开 .bat，
 * 同时不需要 shell:true（不重新打开 CVE 修掉的那个命令注入面）。
 */
function resolveCliRunner(cliPath) {
  const dir = path.dirname(cliPath)
  const nodeExe = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
  const cliJs = path.join(dir, 'cli.js')

  if (fs.existsSync(nodeExe) && fs.existsSync(cliJs)) {
    return { cmd: nodeExe, prefixArgs: [cliJs], useShell: false, mode: 'node+cli.js' }
  }
  // 兜底：老版本工具目录结构不同。参数全由我们构造、不拼接用户输入，注入面可控。
  return { cmd: cliPath, prefixArgs: [], useShell: true, mode: 'shell+bat' }
}

/** DevTools 常见安装位置。装到别处的（比如 D:\微信web开发者工具\）靠 detectCliPath 探测。 */
const COMMON_CLI_PATHS =
  process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
        'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
        'D:\\微信web开发者工具\\cli.bat',
      ]
    : ['/Applications/wechatwebdevtools.app/contents/macos/cli']

/**
 * 探测本机 DevTools cli 路径。
 *
 * 安装路径是用户可改的，所以「照抄网上的默认路径」是第一个坑。
 * 顺序：常见位置 → 正在运行的进程路径（最可靠，工具开着时百发百中）。
 */
function detectCliPath() {
  for (const p of COMMON_CLI_PATHS) {
    if (fs.existsSync(p)) return p
  }

  if (process.platform === 'win32') {
    try {
      const out = cp.execFileSync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-Process wechatdevtools -ErrorAction Stop).Path'],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const exe = out.trim().split(/\r?\n/)[0]
      if (exe) {
        const guess = path.join(path.dirname(exe), 'cli.bat')
        if (fs.existsSync(guess)) return guess
      }
    } catch {
      /* 工具没开着，探测不到，让调用方显式传 cliPath */
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ANSI = /\[[0-9;]*[A-Za-z]/g

/**
 * cli 的 `auto` 命令跑完会单独打一行 `✔ auto`。这是「自动化会话已就绪」的信号。
 * 不直接匹配 "✔ auto"：那个对勾在不同终端编码下不一定是同一串字节，
 * 所以剥掉行首所有非字母数字字符再比，只认内容是 auto 的那一行。
 */
function sawAutoReady(text) {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/^[^A-Za-z0-9]+/, '') === 'auto')
}

/** 探一下连接是真的活着（协议通），而不只是 TCP 连上了。 */
async function isAlive(mp) {
  try {
    await mp.evaluate(() => 1)
    return true
  } catch {
    return false
  }
}

/**
 * 启动 DevTools 自动化会话并连上。官方 launch() 的可用替代。
 *
 * 跟官方实现的四处区别：
 *  1. 走 resolveCliRunner，不 spawn .bat —— 修掉 EINVAL。
 *  2. cli 的 stdout/stderr 默认透传（官方写死 stdio:'ignore'，
 *     出问题时你什么都看不到，这是它难排查的另一半原因）。
 *  3. 自己轮询 connect，超时报真实原因，而不是笼统甩一句 "cliPath 不对"。
 *  4. 等 cli 打出 auto 就绪信号再连，避免连上「上次残留的会话」（见下）。
 *
 * ⚠️ 关于残留会话（这是个真踩过的坑）：
 * cli 子进程被 kill 之后，DevTools 那边的自动化端口不会立刻关。
 * 下一次 launch 如果一上来就 connect，会秒连上那个残留会话并「启动成功」，
 * 几秒后新会话把它顶掉 → 你在随便哪个后续调用上收到
 * "Connection closed, check if wechat web devTools is still running"，
 * 看起来像那句调用有毒，其实是启动阶段抢跑了。
 *
 * @param {object}   opts
 * @param {string}   opts.projectPath              被测小程序项目根目录（必填）
 * @param {string}  [opts.cliPath]                 DevTools cli 路径，不传则自动探测
 * @param {number}  [opts.port=9420]               自动化端口
 * @param {number}  [opts.timeout=120000]          等端口就绪的超时（冷启动很慢，别调太小）
 * @param {boolean} [opts.verbose=true]            是否透传 cli 输出
 * @param {boolean} [opts.trustProject=true]       带 --trust-project，免掉工具里的信任弹窗
 */
async function launch(opts = {}) {
  const {
    projectPath,
    port = 9420,
    timeout = 120000,
    verbose = true,
    trustProject = true,
  } = opts

  if (!projectPath) throw new Error('launch() 需要 projectPath（被测小程序项目根目录）')
  if (!fs.existsSync(projectPath)) throw new Error(`projectPath 不存在: ${projectPath}`)

  const cliPath = opts.cliPath || detectCliPath()
  if (!cliPath) {
    throw new Error(
      '找不到微信开发者工具的 cli。请显式传 cliPath，或先把开发者工具打开再试。\n' +
        'Windows 上探测方法：Get-Process wechatdevtools | Select-Object Path'
    )
  }
  if (!fs.existsSync(cliPath)) throw new Error(`cliPath 不存在: ${cliPath}`)

  const runner = resolveCliRunner(cliPath)
  const args = [...runner.prefixArgs, 'auto', '--project', projectPath, '--auto-port', String(port)]
  if (trustProject) args.push('--trust-project')

  if (verbose) console.log(`[automator-next] ${runner.mode} → ${runner.cmd}`)

  // 不去探端口占用：那得用裸 TCP 捅一个 WS 服务端再立刻断开，
  // 有把 DevTools 捅出问题的风险（实测过一次端口直接不起来）。
  // 反正处理办法一样 —— 等就绪信号 + 连上后复探，所以无条件都做。
  const child = cp.spawn(runner.cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: runner.useShell,
  })

  let spawnError = null
  child.on('error', (e) => {
    spawnError = e
  })
  // 注意：这个监听不能被 verbose 关掉 —— 就绪信号是从 cli 输出里读的。
  let cliOut = ''
  let cliReady = false
  const onData = (d) => {
    const s = d.toString()
    cliOut += s
    if (!cliReady && sawAutoReady(cliOut)) cliReady = true
    if (verbose) process.stdout.write('[devtools-cli] ' + s)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const automator = require('miniprogram-automator')
  const wsEndpoint = `ws://127.0.0.1:${port}`
  const deadline = Date.now() + timeout
  let lastErr = null

  const throwIfSpawnFailed = () => {
    if (!spawnError) return
    const hint =
      spawnError.code === 'EINVAL'
        ? '（spawn EINVAL —— 本该被本包修掉，说明兜底路径也失败了，请提 issue）'
        : ''
    throw new Error(`启动 DevTools cli 失败: ${spawnError.code} ${spawnError.message} ${hint}`)
  }

  // ── 阶段一：等 cli 说 auto 会话就绪 ──────────────────────
  // ⚠️ `✔ auto` 只是必要条件不是充分条件 —— 实测它打出来之后端口还可能没起来。
  // 所以它只用来「拦住抢跑」，端口就绪与否仍然靠下面轮询判断。
  // 万一某个工具版本不打这行，就退回到「直接轮询连接」的老行为，别死等。
  const markerDeadline = Date.now() + Math.min(timeout, 60000)
  while (!cliReady && Date.now() < markerDeadline) {
    throwIfSpawnFailed()
    if (child.exitCode !== null) break // cli 自己退了，不会再有输出
    await sleep(200)
  }

  // ── 阶段二：连接，并确认这个连接是稳的 ───────────────────
  while (Date.now() < deadline) {
    throwIfSpawnFailed()
    let mp
    try {
      mp = await automator.connect({ wsEndpoint })
    } catch (e) {
      lastErr = e
      await sleep(1500)
      continue
    }
    // TCP 连上不等于协议通；先打一发 evaluate 确认。
    if (!(await isAlive(mp))) {
      lastErr = new Error('连上了但 evaluate 不通，会话可能正在被替换')
      await sleep(1500)
      continue
    }
    // 再等一拍复探，确认没被新会话顶掉（残留会话就是在这儿被筛掉的）。
    await sleep(1500)
    if (!(await isAlive(mp))) {
      lastErr = new Error('会话在建立后被替换了（疑似连到了上一轮的残留会话）')
      await sleep(500)
      continue
    }
    return { miniProgram: mp, cliProcess: child, port, cliPath }
  }

  child.kill()
  throw new Error(
    `等自动化端口 ${port} 超时（${timeout}ms）。逐项确认：\n` +
      '  1. 开发者工具「设置 → 安全设置 → 服务端口」已开启\n' +
      '  2. 开发者工具「设置 → 安全设置 → CLI/HTTP 调用功能」已开启\n' +
      '  3. 项目能在工具里正常编译（编译报错时自动化端口不会就绪）\n' +
      `最后一次连接错误: ${lastErr && lastErr.message}`
  )
}

/** 连一个已经起好的自动化会话（自己在工具里开了 automation 端口时用这个）。 */
async function connect(opts = {}) {
  const { port = 9420, wsEndpoint } = opts
  const automator = require('miniprogram-automator')
  return automator.connect({ wsEndpoint: wsEndpoint || `ws://127.0.0.1:${port}` })
}

module.exports = { launch, connect, resolveCliRunner, detectCliPath }
