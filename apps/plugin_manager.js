import { exec, execSync } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

// 安全的 logger（Yunzai 启动前 / 非 Yunzai 环境降级为 console）
const Logger = new Proxy({}, {
  get(_, key) {
    if (typeof logger !== 'undefined' && logger[key]) {
      return (...args) => { try { logger[key](...args) } catch (_) { console.log(`[nidie][${key}]`, ...args) } }
    }
    return (...args) => { console.log(`[nidie][${key}]`, ...args) }
  }
})

// 兼容不同 Yunzai 版本的 plugin 父类路径
let PluginBase
try {
  PluginBase = (await import('../../lib/plugins/plugin.js')).default
} catch (_a) {
  try {
    PluginBase = (await import('../../../lib/plugins/plugin.js')).default
  } catch (_b) {
    try {
      PluginBase = (await import(`${process.cwd()}/lib/plugins/plugin.js`)).default
    } catch (_c) {
      PluginBase = class PluginFallback {
        constructor(cfg) { Object.assign(this, cfg) }
        accept() { return true }
      }
    }
  }
}

// 兼容不同 Yunzai 版本的 puppeteer 路径
// 优先级：全局 puppeteer 对象 → 多级相对路径 → 绝对路径 → TRSS components
let Puppeteer = null
const PUPPETEER_PATHS = [
  '../../lib/puppeteer/puppeteer.js',
  '../../../lib/puppeteer/puppeteer.js',
  `${process.cwd()}/lib/puppeteer/puppeteer.js`,
  // TRSS-Yunzai 等分支路径
  '../../components/puppeteer/lib/puppeteer.js',
  '../../../components/puppeteer/lib/puppeteer.js',
  `${process.cwd()}/components/puppeteer/lib/puppeteer.js`
]

// 1) 先尝试 Yunzai 全局挂载的 puppeteer 单例（最可靠）
if (typeof globalThis.puppeteer !== 'undefined' && globalThis.puppeteer?.screenshot) {
  Puppeteer = globalThis.puppeteer
} else if (typeof puppeteer !== 'undefined' && puppeteer?.screenshot) {
  // 全局变量形式（var puppeteer）
  Puppeteer = puppeteer
}

// 2) 全局没有则逐个尝试 import
if (!Puppeteer) {
  for (const p of PUPPETEER_PATHS) {
    try {
      const mod = await import(p)
      if (mod?.default?.screenshot) {
        Puppeteer = mod.default
        break
      } else if (mod?.default?.default?.screenshot) {
        // 双 default 嵌套
        Puppeteer = mod.default.default
        break
      }
    } catch (_) { /* 路径不存在，继续 */ }
  }
}

// 3) 最后兜底：从 globalThis.runtime 或 Bot 上找
if (!Puppeteer) {
  try {
    if (globalThis.runtime?.puppeteer?.screenshot) {
      Puppeteer = globalThis.runtime.puppeteer
    } else if (globalThis.Bot?.puppeteer?.screenshot) {
      Puppeteer = globalThis.Bot.puppeteer
    }
  } catch (_) {}
}

// 额外：保存原始的 npm puppeteer 包引用（用于自己开 page 截图），
// 以及已启动的 browser 对象（优先直接用实例，不需要 WSR 字符串）
let RawPuppeteer = null
let BrowserWSR = null
let SharedBrowser = null   // 直接可用的 browser 实例（优先级最高）

// 4) 直接 import 已安装的 puppeteer npm 包
for (const p of ['puppeteer', `${process.cwd()}/node_modules/puppeteer`, `${process.cwd()}/node_modules/puppeteer/lib/cjs/puppeteer/puppeteer.js`]) {
  try {
    const mod = await import(p)
    if (mod?.default?.launch) RawPuppeteer = mod.default
    else if (mod?.launch) RawPuppeteer = mod
    if (RawPuppeteer) break
  } catch (_) {}
}

// 5) 兜底：try require (ESM/CJS双兼容：import 失败用 createRequire + node_modules 绝对路径)
if (!RawPuppeteer) {
  try {
    const { createRequire } = await import('module')
    const req = createRequire(`${process.cwd()}/lib/index.js`)
    const r = req.resolve('puppeteer')
    if (r) {
      const m = req(r)
      if (m?.launch) RawPuppeteer = m
      else if (m?.default?.launch) RawPuppeteer = m.default
    }
  } catch (_) {}
}

// 6) 获取 SharedBrowser：直接拿到 PuppeteerRenderer 内部已经 newPage 的那个 Browser 实例
//    从 20+ 可能的挂载位置逐个取
const browserGetters = [
  // 直接有 browser 对象（最完美）
  () => globalThis.browser,
  () => globalThis.puppeteer?.browser,
  () => typeof puppeteer !== 'undefined' ? puppeteer.browser : undefined,
  () => Puppeteer?.browser,
  () => Renderer?.browser,
  () => globalThis.runtime?.browser,
  () => globalThis.Bot?.browser,
  () => globalThis.PuppeteerRenderer?.browser,
  // browser 放在 renderer 里
  () => globalThis.renderer?.browser,
  () => Renderer?.renderer?.browser,
  // PuppeteerRenderer 单例
  () => globalThis.PuppeteerRenderer,
  () => Puppeteer?.PuppeteerRenderer
]
for (const getter of browserGetters) {
  try {
    const b = getter()
    // 判定标准：有 newPage / close 方法
    if (b && typeof b.newPage === 'function' && typeof b.close === 'function') {
      SharedBrowser = b
      break
    }
  } catch (_) {}
}

// 7) 拿不到 SharedBrowser 才退一步找 WSR 字符串
if (!SharedBrowser) {
  const wsrGetters = [
    () => globalThis.browser?.wsEndpoint,
    () => globalThis.browserWSEndpoint,
    () => globalThis.puppeteer?.browserWSEndpoint,
    () => typeof puppeteer !== 'undefined' ? puppeteer.browserWSEndpoint : undefined,
    () => globalThis.runtime?.browserWSEndpoint,
    () => Puppeteer?.browserWSEndpoint,
    () => Puppeteer?.browser?.wsEndpoint?.(),
    // Renderer / PuppeteerRenderer
    () => Renderer?.browserWSEndpoint,
    () => Renderer?.browser?.wsEndpoint?.(),
    () => globalThis.PuppeteerRenderer?.browser?.wsEndpoint?.(),
    () => globalThis.renderer?.browserWSEndpoint
  ]
  for (const getter of wsrGetters) {
    try {
      const v = getter()
      if (typeof v === 'string' && v.startsWith('ws://')) { BrowserWSR = v; break }
    } catch (_) {}
  }
}

if (Puppeteer) {
  try { Logger.mark(`[nidie] puppeteer 加载成功; raw=${!!RawPuppeteer}; sharedBrowser=${!!SharedBrowser}; wsr=${!!BrowserWSR}` ) } catch (_) {}
} else {
  try { Logger.warn(`[nidie] 未找到 puppeteer，将尝试 Renderer 或降级 (raw=${!!RawPuppeteer}; sharedBrowser=${!!SharedBrowser}; wsr=${!!BrowserWSR})` ) } catch (_) {}
}

// 兼容 TRSS / Miao-TRSS 等分支使用的 Renderer.render() 模板渲染系统
let Renderer = null
const RENDERER_PATHS = [
  '../../lib/renderer/renderer.js',
  '../../../lib/renderer/renderer.js',
  `${process.cwd()}/lib/renderer/renderer.js`,
  '../../utils/renderer.js',
  '../../../utils/renderer.js',
  `${process.cwd()}/utils/renderer.js`
]

// 1) 先全局查找
if (typeof globalThis.Renderer !== 'undefined') {
  Renderer = globalThis.Renderer
} else if (typeof Renderer !== 'undefined') {
  Renderer = Renderer  // eslint-disable-line
} else if (globalThis.runtime?.Renderer) {
  Renderer = globalThis.runtime.Renderer
}

// 2) 再 import
if (!Renderer) {
  for (const p of RENDERER_PATHS) {
    try {
      const mod = await import(p)
      if (mod?.default?.render) {
        Renderer = mod.default
        break
      } else if (mod?.render) {
        Renderer = mod
        break
      }
    } catch (_) { /* 继续 */ }
  }
}

if (Renderer) {
  try { Logger.mark(`[nidie] Renderer 加载成功` ) } catch (_) {}
} else {
  try { Logger.warn(`[nidie] 未加载 Renderer` ) } catch (_) {}
}

const execAsync = promisify(exec)

// ===== 超时配置（毫秒）=====
const TIMEOUT = {
  // 克隆仓库：10 分钟（拉取慢时卡最久的一步）
  GIT_CLONE: 10 * 60 * 1000,
  // 拉取远程 / 更新：5 分钟
  GIT_PULL: 5 * 60 * 1000,
  // 安装依赖：15 分钟（pnpm/npm 有时很慢）
  NPM_INSTALL: 15 * 60 * 1000
}

const PLUGINS_DIR = path.resolve(process.cwd(), 'plugins')
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 带超时 & 进程树清理的 exec 封装
 * @param {string} cmd  执行的 shell 命令
 * @param {object} opts exec 参数（cwd、maxBuffer 等）
 * @param {number} timeoutMs 超时毫秒
 * @param {string} stepName 用于日志显示的步骤名
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function execWithTimeout(cmd, opts, timeoutMs, stepName) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, opts, (err, stdout, stderr) => {
      if (timeoutRef) clearTimeout(timeoutRef)
      if (killed) return
      if (err) return reject(err)
      resolve({ stdout: stdout || '', stderr: stderr || '' })
    })

    let killed = false
    const timeoutRef = setTimeout(() => {
      killed = true
      // 先温柔 SIGTERM，1.5s 后 SIGKILL，并杀整组进程
      try {
        const pid = child.pid
        Logger.warn(`[nidie] ${stepName} 超时 (${(timeoutMs / 1000 / 60).toFixed(1)} 分钟)，正在中止 (pid=${pid})`)
        // 杀整个进程组（父进程 + 子进程 git/npm 等）
        try {
          if (pid) process.kill(-pid, 'SIGTERM')
        } catch (_) {
          try { if (pid) child.kill('SIGTERM') } catch (__) {}
        }
        // 1.5s 后强杀
        setTimeout(() => {
          try {
            if (pid) process.kill(-pid, 'SIGKILL')
          } catch (_) {
            try { if (pid) child.kill('SIGKILL') } catch (__) {}
          }
        }, 1500).unref?.()
      } catch (_) {}
      reject(new Error(`${stepName} 超时 (${(timeoutMs / 1000 / 60).toFixed(1)} 分钟未完成)`))
    }, timeoutMs)
    // 如果 Promise 被外层 unref，timeout 也不阻塞进程
    timeoutRef.unref?.()
  })
}

const PRESET_PLUGINS = {
  'ws-plugin': 'https://gitee.com/xiaoye12123/ws-plugin.git',
  'guoba-plugin': 'https://gitee.com/guoba-yunzai/guoba-plugin.git',
  'miao-plugin': 'https://gitee.com/yoimiya-kokomi/miao-plugin.git',
  'py-plugin': 'https://gitee.com/realhuhu/py-plugin.git',
  'earth-kun-plugin': 'https://gitee.com/SmallK12137/earth-kun-plugin.git',
  'humid-ql-plugin': 'https://gitee.com/qiannianyiyu/humid-ql-plugin.git',
  'delta-plugin': 'https://gitee.com/delta-dun/delta-plugin.git',
  'xiaofei-plugin': 'https://gitee.com/xiaofeio/Xiaofei-Plugin.git',
  'cm-plugin': 'https://gitee.com/kyrk01/cm-plugin.git'
}

function isMaster(e) {
  if (!e) return false
  if (e.isMaster === true || e.isMaster === 'true') return true
  try {
    if (typeof cfg !== 'undefined' && cfg?.master) {
      const masters = Array.isArray(cfg.master) ? cfg.master : [String(cfg.master)]
      const uid = String(e.user_id ?? e.sender?.user_id ?? '')
      if (masters.includes(uid)) return true
    }
    if (globalThis?.cfg?.master) {
      const masters = Array.isArray(globalThis.cfg.master) ? globalThis.cfg.master : [String(globalThis.cfg.master)]
      const uid = String(e.user_id ?? e.sender?.user_id ?? '')
      if (masters.includes(uid)) return true
    }
  } catch (_) {}
  return false
}

function reply(e, msg) {
  if (!e) {
    console.log(String(msg))
    return Promise.resolve()
  }
  if (typeof e.reply === 'function') {
    try {
      const r = e.reply(msg)
      return (r && typeof r.catch === 'function') ? r.catch(err => { Logger.error('reply失败', err.message) }) : Promise.resolve(r)
    } catch (err) {
      Logger.error('reply异常', err.message)
      return Promise.resolve()
    }
  }
  console.log(String(msg))
  return Promise.resolve()
}

// HTML 转义
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export class PluginManager extends PluginBase {
  constructor() {
    super({
      name: 'plugin-manager',
      dsc: '插件管理器 - 安装、删除、更新、查看插件',
      event: 'message',
      priority: 50,
      rule: [
        { reg: '^#?插件管理帮助$', fnc: 'showHelp' },
        { reg: '^#?安装', fnc: 'installPlugin' },
        { reg: '^#?删除', fnc: 'uninstallPlugin' },
        { reg: '^#?更新插件', fnc: 'updatePlugin' },
        { reg: '^#?更新全部插件$', fnc: 'updateAllPlugins' },
        { reg: '^#?插件列表$', fnc: 'listPlugins' },
        { reg: '^#?插件详情', fnc: 'pluginDetail' },
        { reg: '^#?插件市场$', fnc: 'listPresetPlugins' },
        { reg: '^#?重载插件$', fnc: 'reloadPlugins' },
        { reg: '^#?重启(插件)?$', fnc: 'restartBot' }
      ]
    })
    this.taskLock = false
  }

  // ===== 指令方法 =====

  async installPlugin(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #安装')
    if (this.taskLock) return reply(e, '⚠️ 当前已有任务在执行中，请稍后再试...')

    const text = String(e?.msg ?? e?.raw_message ?? '')
    const input = text.replace(/^#?安装\s*/, '').trim()
    if (!input) return reply(e, '请提供插件名称或仓库地址\n示例：#安装 miao-plugin\n示例：#安装 https://gitee.com/xxx/xxx.git')

    const repoUrl = this.resolveRepoUrl(input)
    if (!repoUrl) return reply(e, `❌ 未找到插件「${input}」\n可发送 #插件市场 查看支持的插件\n或直接使用 git 仓库地址安装`)

    const dirName = this.parseRepoName(repoUrl)
    const targetPath = path.join(PLUGINS_DIR, dirName)

    if (fs.existsSync(targetPath)) {
      return reply(e, `❌ 插件「${dirName}」已存在\n如需更新请使用：#更新插件 ${dirName}\n如需重装请先删除：#删除 ${dirName}`)
    }

    this.taskLock = true
    try {
      await reply(e,
        `⏳ 正在安装插件「${dirName}」...\n` +
        `仓库地址：${repoUrl}\n` +
        `⏱️ 每步超时：克隆 ${(TIMEOUT.GIT_CLONE / 60000).toFixed(0)} 分钟 / 依赖 ${(TIMEOUT.NPM_INSTALL / 60000).toFixed(0)} 分钟\n` +
        `请耐心等待，超时后会自动中止并回滚`
      )

      let timeouted = false
      await reply(e, `📦 [1/3] 正在克隆仓库... (最长 ${(TIMEOUT.GIT_CLONE / 60000).toFixed(0)} 分钟)`)
      try {
        await this.gitClone(repoUrl, targetPath)
      } catch (err) {
        if (/超时/.test(err.message)) timeouted = true
        throw err
      }

      await reply(e, `📦 [2/3] 正在安装依赖... (最长 ${(TIMEOUT.NPM_INSTALL / 60000).toFixed(0)} 分钟)`)
      try {
        await this.installDependencies(targetPath)
      } catch (err) {
        if (/超时/.test(err.message)) timeouted = true
        // 依赖安装失败不阻断（很多插件 package.json 里其实没有必填依赖）
        Logger.warn(`[nidie] 依赖安装告警: ${err.message}`)
        await reply(e, `⚠️ 依赖安装出现问题：${err.message}\n插件本体仍已保留，可稍后手动 pnpm install`)
      }

      await reply(e, `📦 [3/3] 正在校验插件结构...`)
      const valid = this.validatePlugin(targetPath)
      const tips = []
      if (!valid) tips.push('⚠️ 未检测到 apps 目录或 index.js，请确认插件结构是否正确')

      this.taskLock = false
      const timeTip = timeouted ? `\n⚠️ 本次安装过程中出现过超时，已尽可能保留已完成部分\n` : ''
      return reply(
        e,
        `✅ 插件「${dirName}」安装成功！\n` +
        `📁 安装路径：${path.relative(process.cwd(), targetPath)}\n` +
        `${tips.length ? tips.join('\n') + '\n' : ''}` +
        timeTip +
        `💡 发送 #重启 让机器人重启后即可生效`
      )
    } catch (err) {
      this.taskLock = false
      // 超时或其他失败：统一清理目录回滚
      try { this.removeDir(targetPath) } catch (clErr) { Logger.warn(`[nidie] 清理失败残留目录: ${clErr.message}`) }
      Logger.error(`安装失败: ${err.stack || err}`)
      return reply(e, `❌ 插件安装失败：${err.message}\n⏪ 已自动中止并清理残留文件`)
    }
  }

  async uninstallPlugin(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #删除')

    const text = String(e?.msg ?? e?.raw_message ?? '')
    const name = text.replace(/^#?删除\s*/, '').trim()
    if (!name) return reply(e, '请提供插件名称\n示例：#删除 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return reply(e, `❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)

    if (path.resolve(targetPath) === SELF_DIR) {
      return reply(e, '⚠️ 无法删除插件管理器自身')
    }

    try {
      this.removeDir(targetPath)
      return reply(
        e,
        `✅ 插件「${path.basename(targetPath)}」已删除\n` +
        `📁 已删除：${path.relative(process.cwd(), targetPath)}\n` +
        `💡 发送 #重启 让机器人重启后即可生效`
      )
    } catch (err) {
      Logger.error(`删除失败: ${err.stack || err}`)
      return reply(e, `❌ 插件删除失败：${err.message}`)
    }
  }

  async updatePlugin(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #更新插件')
    if (this.taskLock) return reply(e, '⚠️ 当前已有任务在执行中，请稍后再试...')

    const text = String(e?.msg ?? e?.raw_message ?? '')
    const name = text.replace(/^#?更新插件\s*/, '').trim()
    if (!name) return reply(e, '请提供插件名称\n示例：#更新插件 miao-plugin\n示例：#更新插件 nidie')

    // 识别本插件（自我更新）
    const selfNames = ['nidie', 'plugin-manager', path.basename(SELF_DIR)]
    const isSelfUpdate = selfNames.includes(name) || this.isSelfRepoUrl(name)

    let targetPath
    if (isSelfUpdate) {
      targetPath = SELF_DIR
    } else {
      targetPath = this.findPluginPath(name)
      if (!targetPath) return reply(e, `❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)
    }

    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return reply(e, `⚠️ 插件「${path.basename(targetPath)}」不是 git 仓库，无法更新`)
    }

    this.taskLock = true
    try {
      const isSelf = path.resolve(targetPath) === SELF_DIR
      const label = isSelf ? '插件管理器 (本插件)' : path.basename(targetPath)

      // 1) 先检测是否有可用更新（fetch + HEAD 比对）
      await reply(e, `🔍 正在检查${isSelf ? '本插件' : `插件「${path.basename(targetPath)}」`}是否有可用更新...`)
      let status
      try {
        status = await this.checkUpdateAvailable(targetPath)
      } catch (err) {
        this.taskLock = false
        return reply(e, `❌ ${label} 检测更新失败：${err.message}`)
      }

      // 2) 已是最新 → 直接跳过，不拉不装
      if (!status.needUpdate) {
        this.taskLock = false
        return reply(e, `✅ ${label} 已是最新版本，无需更新\n分支：${status.branch}  提交：${(status.local || '').slice(0, 8)}`)
      }

      // 3) 有更新 → 告知落后多少个提交，再执行 pull
      const behindTxt = status.behind > 0 ? `（落后 ${status.behind} 个提交）` : ''
      await reply(e, `⏳ 发现可用更新${behindTxt}，正在拉取... (最长 ${(TIMEOUT.GIT_PULL / 60000).toFixed(0)} 分钟)`)

      let output = ''
      try {
        const result = await this.safeGitPull(targetPath)
        output = result.output
      } catch (err) {
        this.taskLock = false
        return reply(e, `❌ ${label} 更新失败：${err.message}\n⏪ 已中止（原版本未被修改）`)
      }

      // 4) 装依赖（仅有更新时）
      let depMsg = ''
      try {
        await this.installDependencies(targetPath)
        depMsg = '\n✅ 依赖已更新'
      } catch (err) {
        depMsg = /超时/.test(err.message)
          ? `\n⚠️ 依赖安装超时（${(TIMEOUT.NPM_INSTALL / 60000).toFixed(0)} 分钟），可手动进入目录执行 pnpm install`
          : `\n⚠️ 依赖安装失败：${err.message}`
      }

      this.taskLock = false
      return reply(e, `✅ ${label} 更新成功\n${output}${depMsg}\n💡 发送 #重启 让机器人重启后即可生效`)
    } catch (err) {
      this.taskLock = false
      Logger.error(`更新失败: ${err.stack || err}`)
      return reply(e, `❌ 插件更新失败：${err.message}`)
    }
  }

  // 判断输入是否是本插件的仓库 URL
  isSelfRepoUrl(input) {
    if (!input || typeof input !== 'string') return false
    const SELF_REPO_PATTERNS = [
      /github\.com[/:]nidie2580\/nidie/i,
      /gitee\.com[/:]nidie2580\/nidie/i,
      /^nidie2580\/nidie$/i
    ]
    return SELF_REPO_PATTERNS.some(re => re.test(input))
  }

  /**
   * 检查插件是否有可用更新（不修改工作区）
   * 通过 git fetch + 比对本地 HEAD 与远程 HEAD 来判断
   * @param {string} targetPath 插件目录
   * @returns {Promise<{needUpdate:boolean, branch:string, local:string, remote:string, behind:number, reason?:string}>}
   */
  async checkUpdateAvailable(targetPath) {
    // 1) git fetch 拉取远程引用，但不合并
    try {
      await execWithTimeout(
        'git fetch --tags --depth=1 origin',
        { cwd: targetPath, maxBuffer: 5 * 1024 * 1024 },
        TIMEOUT.GIT_PULL,
        `检测更新 ${path.basename(targetPath)}`
      )
    } catch (err) {
      // fetch 失败 → 走老路直接 pull
      Logger.warn(`[nidie] fetch 失败，回退到直接 pull: ${err.message}`)
      return { needUpdate: true, branch: '', local: '', remote: '', behind: -1, reason: 'fetch_failed' }
    }

    // 2) 获取当前分支名
    let branch = ''
    try {
      const { stdout: brOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: targetPath })
      branch = (brOut || '').trim()
    } catch (_) {}
    if (!branch || branch === 'HEAD') {
      // 处于 detached HEAD 状态，无法用 origin/<branch> 比对，回退到直接 pull
      return { needUpdate: true, branch: 'detached', local: '', remote: '', behind: -1, reason: 'detached_head' }
    }

    // 3) 比对本地 HEAD 与 origin/<branch>
    try {
      const { stdout: localOut } = await execAsync('git rev-parse HEAD', { cwd: targetPath })
      const local = (localOut || '').trim()
      let remote = ''
      try {
        const { stdout: rOut } = await execAsync(`git rev-parse origin/${branch}`, { cwd: targetPath })
        remote = (rOut || '').trim()
      } catch (_) {
        // 远程分支不存在（可能 origin 默认分支是 main/master，但本地是 master/main）
        // 尝试常见默认分支
        for (const candidate of ['main', 'master']) {
          try {
            const { stdout: rOut } = await execAsync(`git rev-parse origin/${candidate}`, { cwd: targetPath })
            if (rOut && rOut.trim()) {
              remote = rOut.trim()
              branch = candidate  // 用真实存在的远程分支
              break
            }
          } catch (_) {}
        }
        if (!remote) {
          return { needUpdate: true, branch, local, remote: '', behind: -1, reason: 'remote_branch_not_found' }
        }
      }

      // 4) 计算落后多少个提交
      let behind = 0
      if (local && remote && local !== remote) {
        try {
          const { stdout: bOut } = await execAsync(
            `git rev-list --count HEAD..origin/${branch}`,
            { cwd: targetPath }
          )
          behind = parseInt((bOut || '0').trim(), 10) || 0
        } catch (_) {
          behind = -1
        }
      }

      const needUpdate = !local || !remote || local !== remote
      return { needUpdate, branch, local, remote, behind }
    } catch (err) {
      Logger.warn(`[nidie] 比对 HEAD 失败，回退直接 pull: ${err.message}`)
      return { needUpdate: true, branch, local: '', remote: '', behind: -1, reason: 'compare_failed' }
    }
  }

  async updateAllPlugins(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #更新全部插件')
    if (this.taskLock) return reply(e, '⚠️ 当前已有任务在执行中，请稍后再试...')

    const plugins = this.scanPlugins()
    const updatable = plugins.filter(p => fs.existsSync(path.join(p.path, '.git')))
    if (updatable.length === 0) return reply(e, '❌ 没有可通过 git 更新的插件')

    this.taskLock = true
    await reply(e, `⏳ 开始检查并更新 ${updatable.length} 个插件...`)

    let updated = 0
    let upToDate = 0
    let failed = 0
    const results = []

    for (const p of updatable) {
      // 1) 检测是否有可用更新
      let status
      try {
        status = await this.checkUpdateAvailable(p.path)
      } catch (err) {
        failed++
        results.push(`❌ ${p.name}：检测更新失败：${err.message}`)
        continue
      }

      // 2) 已是最新 → 跳过，不执行 pull、不装依赖
      if (!status.needUpdate) {
        upToDate++
        results.push(`✅ ${p.name}：已是最新`)
        continue
      }

      // 3) 有更新 → 执行 pull
      const behindTxt = status.behind > 0 ? `（落后 ${status.behind} 个提交）` : ''
      try {
        const pullResult = await this.safeGitPull(p.path)
        updated++
        results.push(`🔄 ${p.name}：已更新${behindTxt}`)
      } catch (err) {
        failed++
        const suffix = /超时/.test(err.message) ? '（已跳过）' : ''
        results.push(`❌ ${p.name}：${err.message}${suffix}`)
      }
    }

    this.taskLock = false
    return reply(e,
      `📊 批量更新完成\n` +
      `   总计：${updatable.length}\n` +
      `   ✅ 已是最新：${upToDate}\n` +
      `   🔄 已更新：${updated}\n` +
      `   ❌ 失败：${failed}\n\n` +
      results.join('\n') +
      `\n\n💡 发送 #重启 让机器人重启后即可生效`
    )
  }

  async listPlugins(e) {
    const plugins = this.scanPlugins()
    if (plugins.length === 0) return reply(e, '当前未检测到任何插件')

    const rows = plugins.map((p, i) => {
      const isGit = fs.existsSync(path.join(p.path, '.git'))
      const relPath = path.relative(PLUGINS_DIR, p.path)
      return {
        index: i + 1,
        name: p.name,
        type: isGit ? 'git' : 'local',
        path: relPath
      }
    })

    return this.renderListImage(e, {
      title: '已安装插件',
      subtitle: `共 ${plugins.length} 个`,
      columns: ['#', '名称', '类型', '路径'],
      rows: rows.map(r => [r.index, r.name, r.type, r.path]),
      footer: '发送 #插件详情 <名称> 查看详情'
    })
  }

  async pluginDetail(e) {
    const text = String(e?.msg ?? e?.raw_message ?? '')
    const name = text.replace(/^#?插件详情\s*/, '').trim()
    if (!name) return reply(e, '请提供插件名称\n示例：#插件详情 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return reply(e, `❌ 未找到插件「${name}」`)

    const dirName = path.basename(targetPath)
    const isGit = fs.existsSync(path.join(targetPath, '.git'))
    let gitInfo = ''
    if (isGit) {
      try {
        const remote = execSync('git remote get-url origin', { cwd: targetPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        const commit = execSync('git log -1 --format=%h %s', { cwd: targetPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        gitInfo = `\nGit 信息：\n  远程：${remote}\n  分支：${branch}\n  最新提交：${commit}`
      } catch (_) {}
    }

    let appCount = 0
    const appsDir = path.join(targetPath, 'apps')
    if (fs.existsSync(appsDir)) {
      appCount = fs.readdirSync(appsDir).filter(f => f.endsWith('.js')).length
    }

    let pkgInfo = ''
    const pkgPath = path.join(targetPath, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        pkgInfo = `\n版本：${pkg.version || '未知'}\n描述：${pkg.description || '无'}`
      } catch (_) {}
    }

    const relPath = path.relative(process.cwd(), targetPath)
    return reply(
      e,
      `📦 插件详情：${dirName}\n\n` +
      `路径：${relPath}\n` +
      `类型：${isGit ? 'git 仓库' : '本地目录'}\n` +
      `apps 文件数：${appCount}${pkgInfo}${gitInfo}`
    )
  }

  async listPresetPlugins(e) {
    const entries = Object.entries(PRESET_PLUGINS)
    const rows = entries.map(([name, url], i) => {
      const installed = this.findPluginPath(name) ? '✅ 已安装' : '⬜ 未安装'
      return {
        index: i + 1,
        name,
        url,
        status: installed
      }
    })

    return this.renderListImage(e, {
      title: '插件市场',
      subtitle: `共 ${entries.length} 个可用插件`,
      columns: ['#', '名称', '仓库地址', '状态'],
      rows: rows.map(r => [r.index, r.name, r.url, r.status]),
      footer: '发送 #安装 <名称> 即可安装'
    })
  }

  /**
   * 重载插件 — 尽力尝试，但坦诚告知限制
   * 大多数 Yunzai 版本的 loadPlugins() 只能刷新已存在插件的代码，
   * 不能扫描到新装的 plugins/xxx/ 目录。新装插件必须重启。
   */
  async reloadPlugins(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #重载插件')
    await reply(e, '⏳ 正在尝试重载插件...')

    const tried = []
    let loaded = false

    // 1) PluginsLoader.loadPlugins (TRSS / Miao)
    const PluginsLoader =
      globalThis.PluginsLoader ||
      globalThis.pluginsLoader ||
      globalThis.Bot?.pluginsLoader ||
      globalThis.runtime?.PluginsLoader
    if (PluginsLoader?.loadPlugins) {
      tried.push('PluginsLoader.loadPlugins')
      try {
        await PluginsLoader.loadPlugins()
        loaded = true
        Logger.mark(`[nidie] PluginsLoader.loadPlugins() 调用成功`)
      } catch (err) {
        Logger.warn(`[nidie] PluginsLoader.loadPlugins 失败: ${err.message}`)
      }
    }

    // 2) Bot.reloadPlugins
    if (!loaded && globalThis.Bot?.reloadPlugins) {
      tried.push('Bot.reloadPlugins')
      try {
        await globalThis.Bot.reloadPlugins()
        loaded = true
        Logger.mark(`[nidie] Bot.reloadPlugins() 调用成功`)
      } catch (err) {
        Logger.warn(`[nidie] Bot.reloadPlugins 失败: ${err.message}`)
      }
    }

    // 3) runtime.loadPlugins
    if (!loaded && globalThis.runtime?.loadPlugins) {
      tried.push('runtime.loadPlugins')
      try {
        await globalThis.runtime.loadPlugins()
        loaded = true
        Logger.mark(`[nidie] runtime.loadPlugins() 调用成功`)
      } catch (err) {
        Logger.warn(`[nidie] runtime.loadPlugins 失败: ${err.message}`)
      }
    }

    if (loaded) {
      return reply(e,
        `✅ 已调用重载接口 (${tried[0]})\n\n` +
        `⚠️ 注意：重载只能刷新【已存在插件】的代码修改，\n` +
        `   【新安装】的插件目录不会被扫描到，必须重启机器人才能生效。\n\n` +
        `💡 如果是装了新插件后用这条命令发现没生效，请改发 #重启`
      )
    }
    return reply(e,
      `⚠️ 当前 Yunzai 版本没有可用的热重载接口\n` +
      `已尝试: ${tried.length ? tried.join(' / ') : '无'}\n\n` +
      `💡 请直接发送 #重启 让机器人重启加载全部插件`
    )
  }

  /**
   * #重启 — 调用 Yunzai restart 机制或退回 process.exit
   * 进程管理器 (pm2 / systemd / npm) 会自动拉起
   */
  async restartBot(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #重启')

    // 1) Yunzai 自带的 restart 插件机制
    //    一些分支挂载在 Bot.restart / globalThis.restart / process restart 事件
    const candidates = [
      { name: 'Bot.restart', fn: () => globalThis.Bot?.restart?.() },
      { name: 'globalThis.restart', fn: () => globalThis.restart?.() },
      { name: 'runtime.restart', fn: () => globalThis.runtime?.restart?.() },
      { name: 'Bot.emit(restart)', fn: () => globalThis.Bot?.emit?.('restart', { time: 0 }) },
      // exec child_process 重启
      { name: 'process exec', fn: () => {
        // 触发 Yunzai 自带的 restart 监听
        try { process.emit('restart', { time: 0 }) } catch (_) {}
      } }
    ]

    for (const c of candidates) {
      try {
        if (typeof c.fn === 'function') {
          const r = c.fn()
          if (r !== false) {
            await reply(e, `🔄 正在重启 (${c.name})...\n稍后约 10-30 秒后机器人会重新上线`)
            Logger.mark(`[nidie] 触发重启: ${c.name}`)
            // 给消息一点时间发出去
            setTimeout(() => {
              try { process.exit(0) } catch (_) {}
            }, 1500)
            return true
          }
        }
      } catch (err) {
        Logger.warn(`[nidie] ${c.name} 失败: ${err.message}`)
      }
    }

    // 2) 兜底：直接 process.exit(0)，依赖进程管理器拉起
    await reply(e,
      `🔄 即将强制重启进程\n` +
      `⚠️ 如果机器人没有自动重新上线，说明没有用 pm2/systemd 等进程管理器，请手动启动`
    )
    Logger.mark(`[nidie] 1.5 秒后 process.exit(0) 强制重启`)
    setTimeout(() => {
      try { process.exit(0) } catch (_) {}
    }, 1500)
    return true
  }

  async showHelp(e) {
    // 走图片渲染（和 #插件列表/#插件市场 同一渲染管线）
    return this.renderListImage(e, {
      title: '插件管理器 - 使用帮助',
      subtitle: '指令列表',
      columns: ['指令', '说明', '权限'],
      rows: [
        ['#安装 <名称|仓库地址>', '安装一个插件，支持预设名或 git 地址', '主人'],
        ['#删除 <名称>', '删除指定插件', '主人'],
        ['#更新插件 <名称>', '更新指定插件（支持更新本插件自身）', '主人'],
        ['#更新全部插件', '更新所有 git 插件', '主人'],
        ['#插件列表', '查看已安装的插件（图片）', '全员'],
        ['#插件市场', '查看可一键安装的插件（图片）', '全员'],
        ['#插件详情 <名称>', '查看插件详细信息', '全员'],
        ['#重载插件', '尝试热重载（仅刷新已存在插件代码，新装无效）', '主人'],
        ['#重启', '重启机器人进程（推荐，新装插件后必用）', '主人'],
        ['#插件管理帮助', '查看本帮助（图片）', '全员']
      ],
      footer: '⚠️ 安装/删除/更新/重载/重启 操作仅主人可用\n💡 仓库：https://github.com/nidie2580/nidie'
    })
  }

  // ===== 图片渲染 =====

  async renderListImage(e, { title, subtitle, columns, rows, footer }) {
    Logger.mark(`[nidie] 开始渲染图片: ${title}`)
    const data = { title, subtitle, columns, rows, footer }
    const html = this.buildListHtml(data)
    const htmlPath = path.join(SELF_DIR, `.render_${Date.now()}.html`)
    let lastErr = null
    const recordErr = (label, err) => {
      lastErr = err
      if (err?.stack) Logger.warn(`[nidie] ${label} 失败:\n${err.stack}`)
      else Logger.warn(`[nidie] ${label} 失败: ${err?.message || String(err)}`)
    }

    // ====== 方案 0：直接用 browser 实例开 page，绕开所有 Yunzai 封装层 ======
    // 0a. SharedBrowser（直接拿到浏览器实例，优先级最高）
    // 0b. BrowserWSR → RawPuppeteer.connect
    // 0c. RawPuppeteer.launch 自己开一个（兜底）
    let htmlTmpCreated = false
    if (SharedBrowser || RawPuppeteer || BrowserWSR) {
      let page = null
      let browser = null
      let weStartedBrowser = false
      try {
        if (SharedBrowser) {
          Logger.mark(`[nidie] 截图方案 0a: 使用共享 browser 实例`)
          browser = SharedBrowser
        } else if (RawPuppeteer && BrowserWSR) {
          Logger.mark(`[nidie] 截图方案 0b: connect WSR=${BrowserWSR.slice(0, 40)}...`)
          browser = await RawPuppeteer.connect({ browserWSEndpoint: BrowserWSR })
        } else if (RawPuppeteer && typeof RawPuppeteer.launch === 'function') {
          Logger.mark(`[nidie] 截图方案 0c: 独立启动 puppeteer chromium`)
          browser = await RawPuppeteer.launch({
            headless: 'new',
            args: [
              '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
              '--window-size=1000,1600',
              '--hide-scrollbars'
            ],
            defaultViewport: null  // 不做默认 viewport 限制，使用窗口大小
          })
          weStartedBrowser = true
        } else {
          Logger.warn(`[nidie] 方案 0 跳过: 无可用于启动 browser 的条件 (raw=${!!RawPuppeteer}, shared=${!!SharedBrowser}, wsr=${!!BrowserWSR})`)
        }
        if (browser) {
          fs.writeFileSync(htmlPath, html, 'utf-8')
          htmlTmpCreated = true
          const fileUrl = 'file://' + htmlPath.replace(/\\/g, '/')
          Logger.mark(`[nidie] 加载本地 HTML: ${fileUrl.slice(0, 80)}`)
          page = await browser.newPage()
          // 安全地设置 viewport：
          // puppeteer-core@24.42.0 ESM 版本里 EmulationManager 有 bug：
          // setViewport 时如果之前的内部 state 包含 deviceScaleFactor，
          // sync() → #applyViewport() 会把 height 丢掉，
          // 报 Protocol error (Emulation.setDeviceMetricsOverride): height missing
          // 所以这里：
          //   1) 只传 width + height，绝对不传 deviceScaleFactor / isMobile 等
          //   2) 外层 try/catch，失败了就忽略（使用默认视口），不阻断截图
          try {
            await page.setViewport({ width: 900, height: 1200 })
            Logger.mark(`[nidie] setViewport 成功 (900x1200)`)
          } catch (vpErr) {
            Logger.warn(`[nidie] setViewport 失败（忽略，继续用默认视口）: ${vpErr.message}`)
          }
          await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 })
          await new Promise(r => setTimeout(r, 500))
          // fullPage 截图：整页截取，无需手动算 height/clip
          const img = await page.screenshot({ type: 'png', fullPage: true, captureBeyondViewport: true })
          if (img && (Buffer.isBuffer(img) ? img.length : typeof img === 'string' ? img.length : 0) > 1000) {
            const len = Buffer.isBuffer(img) ? img.length : (typeof img === 'string' ? img.length : 0)
            Logger.mark(`[nidie] 方案 0(fullPage) 截图成功 (${len} 字节)`)
            return reply(e, img)
          } else {
            // fullPage 返回太小（<1KB）时再退一步，用简单 clip 截图
            Logger.warn(`[nidie] 方案 0 fullPage 结果过小，退一步 clip 截图`)
            const { width, height } = await page.evaluate(() => ({
              width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, 800),
              height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 300)
            }))
            const img2 = await page.screenshot({
              type: 'png', captureBeyondViewport: true,
              clip: { x: 0, y: 0, width, height }
            })
            if (img2) {
              const len2 = Buffer.isBuffer(img2) ? img2.length : (typeof img2 === 'string' ? img2.length : 0)
              Logger.mark(`[nidie] 方案 0(clip fallback) 截图成功 (${len2} 字节)`)
              return reply(e, img2)
            }
            Logger.warn(`[nidie] 方案 0 两次 screenshot 都返回空`)
          }
        }
      } catch (err) {
        recordErr('方案0(直连puppeteer page)', err)
      } finally {
        try { if (page && !SharedBrowser) await page.close().catch(() => {}) } catch (_) {}
        try { if (weStartedBrowser && browser) await browser.close().catch(() => {}) } catch (_) {}
        try { if (htmlTmpCreated && fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath) } catch (_) {}
      }
    } else {
      Logger.warn(`[nidie] 方案 0 整体跳过：未获取到任何可用于截图的 browser/wsr/raw 能力`)
    }

    // ====== 方案 1：Renderer.render (TRSS 分支模板渲染) ======
    if (Renderer && typeof Renderer.render === 'function') {
      const renderers = [
        () => Renderer.render('plugin-manager/list', {
          data, name: 'plugin-manager/list',
          file: path.join(SELF_DIR, 'resources', 'apps', 'list.html'),
          plugin: SELF_DIR
        }),
        () => Renderer.render('plugin-manager/list', data),
        () => Renderer.render({
          tpl: path.join(SELF_DIR, 'resources', 'apps', 'list.html'),
          data, name: 'plugin-manager'
        })
      ]
      for (let i = 0; i < renderers.length; i++) {
        try {
          const img = await renderers[i]()
          if (img) { Logger.mark(`[nidie] Renderer 方式 ${i + 1} 成功`); return reply(e, img) }
        } catch (err) { recordErr(`Renderer 方式 ${i + 1}`, err) }
      }
      Logger.warn(`[nidie] Renderer 全部失败，尝试 Puppeteer.screenshot`)
    }

    // ====== 方案 2：puppeteer.screenshot (原版 Yunzai 封装) ======
    if (Puppeteer && typeof Puppeteer.screenshot === 'function') {
      const tmpHtml2 = path.join(SELF_DIR, `.render2_${Date.now()}.html`)
      try {
        const ss = [
          () => Puppeteer.screenshot('plugin-manager/list', {
            data, file: path.join(SELF_DIR, 'resources', 'apps', 'list.html')
          }),
          () => Puppeteer.screenshot('plugin-manager', { html }),
          () => { fs.writeFileSync(tmpHtml2, html, 'utf-8'); return Puppeteer.screenshot('plugin-manager', { file: tmpHtml2, html }) },
          () => Puppeteer.screenshot({ html })
        ]
        for (let i = 0; i < ss.length; i++) {
          try {
            const img = await ss[i]()
            if (img) { Logger.mark(`[nidie] puppeteer.screenshot 方式 ${i + 1} 成功`); return reply(e, img) }
          } catch (err) { recordErr(`puppeteer.screenshot ${i + 1}`, err) }
        }
      } finally {
        try { if (fs.existsSync(tmpHtml2)) fs.unlinkSync(tmpHtml2) } catch (_) {}
      }
    }

    // ====== 方案 3：文本兜底 ======
    if (lastErr) Logger.error(`[nidie] 所有渲染路径失败（lastErr=${lastErr?.message || lastErr || '无'}），降级文本`)
    else Logger.warn(`[nidie] 所有渲染路径失败，降级文本`)
    return this.renderListText(e, data)
  }

  renderListText(e, { title, subtitle, columns, rows, footer }) {
    const lines = rows.map(r => r.map((c, i) => `${columns[i]}: ${c}`).join('\n   '))
    return reply(
      e,
      `📦 ${title} (${subtitle})\n\n${lines.join('\n\n')}\n\n${footer}`
    )
  }

  buildListHtml({ title, subtitle, columns, rows, footer }) {
    const headerCells = columns.map(c => `<th>${esc(c)}</th>`).join('')
    const bodyRows = rows.map((r, rowIdx) => {
      const cells = r.map((c, colIdx) => {
        // 权限列（最后一列，名为"权限"）做颜色渲染
        if (columns[colIdx] === '权限') {
          const isMaster = /主人/.test(String(c))
          const color = isMaster ? '#d97706' : '#10b981'
          const bg = isMaster ? '#fef3c7' : '#d1fae5'
          return `<td><span style="display:inline-block;padding:3px 10px;border-radius:10px;background:${bg};color:${color};font-size:12px;font-weight:600;">${esc(c)}</span></td>`
        }
        return `<td>${esc(c)}</td>`
      }).join('')
      return `<tr>${cells}</tr>`
    }).join('')

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    padding: 24px;
    width: 760px;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.2);
    overflow: hidden;
  }
  .header {
    padding: 24px 28px;
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: #fff;
  }
  .header .title {
    font-size: 26px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .header .subtitle {
    font-size: 14px;
    opacity: 0.85;
  }
  .table-wrap {
    padding: 20px 28px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    padding: 12px 10px;
    text-align: left;
    font-size: 14px;
    border-bottom: 1px solid #f0f0f5;
  }
  th {
    color: #888;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  tr:last-child td { border-bottom: none; }
  td { color: #333; }
  /* 列表页（4 列：序号 名称 仓库 状态）的列宽设置 */
  table.cols-4 td:nth-child(1) { color: #888; width: 40px; }
  table.cols-4 td:nth-child(2) { font-weight: 600; color: #333; }
  table.cols-4 td:nth-child(4) { color: #666; font-size: 13px; }
  /* 帮助页（3 列：指令 说明 权限）的列宽设置 */
  table.cols-3 td:nth-child(1) { font-weight: 600; color: #333; white-space: nowrap; width: 35%; }
  table.cols-3 td:nth-child(2) { color: #555; font-size: 13px; }
  table.cols-3 td:nth-child(3) { width: 70px; text-align: center; }
  .footer {
    padding: 16px 28px 24px;
    font-size: 13px;
    color: #888;
    border-top: 1px solid #f0f0f5;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title">${esc(title)}</div>
      <div class="subtitle">${esc(subtitle)}</div>
    </div>
    <div class="table-wrap">
      <table class="cols-${columns.length}">
        <thead>
          <tr>${headerCells}</tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
    <div class="footer">${esc(footer)}</div>
  </div>
</body>
</html>`
  }

  // ===== 内部工具方法 =====

  resolveRepoUrl(input) {
    if (/^(https?|git):\/\//.test(input) || input.startsWith('git@')) return input
    if (/^[\w.-]+\/[\w.-]+$/.test(input)) return `https://gitee.com/${input}.git`
    if (PRESET_PLUGINS[input]) return PRESET_PLUGINS[input]
    return null
  }

  parseRepoName(url) {
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '')
    const parts = cleaned.split(/[:/]/)
    return parts[parts.length - 1]
  }

  /**
   * 安全的 git pull：先尝试 --ff-only，失败则自动 stash → pull → pop
   * 应对本地有修改导致无法快进合并的情况
   */
  async safeGitPull(targetPath) {
    // 1) 尝试 --ff-only（最干净，不产生 merge commit）
    try {
      const { stdout } = await execWithTimeout(
        'git pull --ff-only',
        { cwd: targetPath, maxBuffer: 10 * 1024 * 1024 },
        TIMEOUT.GIT_PULL,
        `拉取更新 ${path.basename(targetPath)}`
      )
      return { ok: true, output: (stdout || '').trim() }
    } catch (ffErr) {
      // 不是 fast-forward 错误 → 直接抛
      if (!/Not possible to fast-forward|refusing to merge unrelated histories/i.test(ffErr.message || '')) {
        throw ffErr
      }
      // 是 ff-only 错误 → 走 stash 流程
      Logger.warn(`[nidie] --ff-only 失败，尝试 stash + pull + pop`)
    }

    // 2) stash 本地修改
    let stashed = false
    try {
      await execAsync('git stash push -u -m "nidie-auto-stash-before-update"', { cwd: targetPath })
      stashed = true
    } catch (_) {
      // stash 失败（可能没东西可 stash），继续尝试直接 pull
    }

    // 3) 普通 pull（允许 merge / rebase）
    let output = ''
    try {
      const { stdout } = await execWithTimeout(
        'git pull',
        { cwd: targetPath, maxBuffer: 10 * 1024 * 1024 },
        TIMEOUT.GIT_PULL,
        `拉取更新 ${path.basename(targetPath)}`
      )
      output = (stdout || '').trim()
    } catch (err) {
      // pull 也失败 → 尝试 rebase 方式
      try {
        const { stdout } = await execWithTimeout(
          'git pull --rebase',
          { cwd: targetPath, maxBuffer: 10 * 1024 * 1024 },
          TIMEOUT.GIT_PULL,
          `rebase 拉取 ${path.basename(targetPath)}`
        )
        output = (stdout || '').trim()
      } catch (rebaseErr) {
        // 全部失败 → 恢复 stash
        if (stashed) {
          try { await execAsync('git stash pop', { cwd: targetPath }) } catch (_) {}
        }
        throw err  // 抛原始 pull 错误
      }
    }

    // 4) 恢复 stash
    if (stashed) {
      try {
        const { stdout } = await execAsync('git stash pop', { cwd: targetPath })
        const stashOut = (stdout || '').trim()
        if (/conflict/i.test(stashOut)) {
          Logger.warn(`[nidie] stash pop 有冲突，请手动解决: ${stashOut}`)
        }
      } catch (popErr) {
        Logger.warn(`[nidie] stash pop 失败，已保留 stash: ${popErr.message}`)
      }
    }

    return { ok: true, output, stashed: true }
  }

  async gitClone(repoUrl, targetPath) {
    // 加 --progress 强制输出进度，同时 stderr 合并到 err 信息里
    const cmd = `git clone --depth=1 --progress "${repoUrl}" "${targetPath}"`
    try {
      const { stdout } = await execWithTimeout(
        cmd,
        { cwd: PLUGINS_DIR, maxBuffer: 10 * 1024 * 1024 },
        TIMEOUT.GIT_CLONE,
        `克隆仓库 ${this.parseRepoName(repoUrl)}`
      )
      return stdout
    } catch (err) {
      // 超时信息已经由 execWithTimeout 包装好错误文案，直接抛
      // 普通 git 错误保留 stderr
      if (/超时/.test(err.message)) throw err
      throw err
    }
  }

  async installDependencies(targetPath) {
    const pkgPath = path.join(targetPath, 'package.json')
    if (!fs.existsSync(pkgPath)) return

    let cmd = 'npm install --omit=dev'
    try {
      execSync('pnpm -v', { stdio: 'ignore' })
      cmd = 'pnpm install --prod'
    } catch (_) {}

    const { stdout, stderr } = await execWithTimeout(
      cmd,
      { cwd: targetPath, maxBuffer: 50 * 1024 * 1024 },
      TIMEOUT.NPM_INSTALL,
      `安装依赖 ${path.basename(targetPath)}`
    )
    if (stderr) Logger.warn(`依赖安装 stderr: ${stderr.trim()}`)
    return stdout || ''
  }

  validatePlugin(targetPath) {
    return (
      fs.existsSync(path.join(targetPath, 'apps')) ||
      fs.existsSync(path.join(targetPath, 'index.js')) ||
      fs.existsSync(path.join(targetPath, 'package.json'))
    )
  }

  scanPlugins() {
    const result = []
    if (!fs.existsSync(PLUGINS_DIR)) return result

    let entries = []
    try {
      entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    } catch (err) {
      Logger.error(`扫描插件目录失败: ${err.message}`)
      return result
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (['example', 'genshin', 'system', 'other'].includes(name)) continue
      if (name.startsWith('.')) continue
      const full = path.join(PLUGINS_DIR, name)
      const isPlugin =
        fs.existsSync(path.join(full, 'apps')) ||
        fs.existsSync(path.join(full, 'index.js')) ||
        fs.existsSync(path.join(full, 'package.json'))
      if (isPlugin) result.push({ name, path: full })
    }
    return result
  }

  findPluginPath(name) {
    const plugins = this.scanPlugins()
    const exact = plugins.find(p => p.name === name)
    if (exact) return exact.path
    const fuzzy = plugins.find(p => p.name.toLowerCase().includes(name.toLowerCase()))
    if (fuzzy) return fuzzy.path
    return null
  }

  removeDir(dirPath) {
    if (!fs.existsSync(dirPath)) return
    try {
      fs.rmSync(dirPath, { recursive: true, force: true })
    } catch (err) {
      Logger.error(`删除目录失败: ${err.message}`)
      throw err
    }
  }
}
