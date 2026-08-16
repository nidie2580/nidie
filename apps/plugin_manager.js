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

if (Puppeteer) {
  try { Logger.mark(`[nidie] puppeteer 加载成功 (路径或全局)` ) } catch (_) {}
} else {
  try { Logger.warn(`[nidie] 未找到 puppeteer，列表/市场将降级为文本输出` ) } catch (_) {}
}

const execAsync = promisify(exec)

const PLUGINS_DIR = path.resolve(process.cwd(), 'plugins')
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
        { reg: '^#?安装\\s+\\S', fnc: 'installPlugin' },
        { reg: '^#?删除\\s+\\S', fnc: 'uninstallPlugin' },
        { reg: '^#?更新插件\\s+\\S', fnc: 'updatePlugin' },
        { reg: '^#?更新全部插件$', fnc: 'updateAllPlugins' },
        { reg: '^#?插件列表$', fnc: 'listPlugins' },
        { reg: '^#?插件详情\\s+\\S', fnc: 'pluginDetail' },
        { reg: '^#?插件市场$', fnc: 'listPresetPlugins' },
        { reg: '^#?重载插件$', fnc: 'reloadPlugins' }
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
      await reply(e, `⏳ 正在安装插件「${dirName}」...\n仓库地址：${repoUrl}\n请耐心等待，安装过程可能需要一些时间`)

      await reply(e, `📦 [1/3] 正在克隆仓库...`)
      await this.gitClone(repoUrl, targetPath)

      await reply(e, `📦 [2/3] 正在安装依赖...`)
      await this.installDependencies(targetPath)

      await reply(e, `📦 [3/3] 正在校验插件结构...`)
      const valid = this.validatePlugin(targetPath)
      const tips = []
      if (!valid) tips.push('⚠️ 未检测到 apps 目录或 index.js，请确认插件结构是否正确')

      this.taskLock = false
      return reply(
        e,
        `✅ 插件「${dirName}」安装成功！\n` +
        `📁 安装路径：${path.relative(process.cwd(), targetPath)}\n` +
        `${tips.length ? tips.join('\n') + '\n' : ''}` +
        `💡 发送 #重载插件 即可生效`
      )
    } catch (err) {
      this.taskLock = false
      this.removeDir(targetPath)
      Logger.error(`安装失败: ${err.stack || err}`)
      return reply(e, `❌ 插件安装失败：${err.message}\n已自动清理残留文件`)
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
        `💡 发送 #重载插件 即可生效`
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
    if (!name) return reply(e, '请提供插件名称\n示例：#更新插件 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return reply(e, `❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)

    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return reply(e, `⚠️ 插件「${path.basename(targetPath)}」不是 git 仓库，无法更新`)
    }

    this.taskLock = true
    try {
      const { stdout } = await execAsync('git pull', { cwd: targetPath })
      const output = (stdout || '').trim()

      let depMsg = ''
      try {
        await this.installDependencies(targetPath)
        depMsg = '\n✅ 依赖已更新'
      } catch (err) {
        depMsg = `\n⚠️ 依赖安装失败：${err.message}`
      }

      this.taskLock = false
      if (/already up|up to date|已经是最新|没有内容更新/i.test(output)) {
        return reply(e, `✅ 插件「${path.basename(targetPath)}」已是最新版本${depMsg}`)
      }
      return reply(e, `✅ 插件「${path.basename(targetPath)}」更新成功\n${output}${depMsg}\n💡 发送 #重载插件 即可生效`)
    } catch (err) {
      this.taskLock = false
      Logger.error(`更新失败: ${err.stack || err}`)
      return reply(e, `❌ 插件更新失败：${err.message}`)
    }
  }

  async updateAllPlugins(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #更新全部插件')
    if (this.taskLock) return reply(e, '⚠️ 当前已有任务在执行中，请稍后再试...')

    const plugins = this.scanPlugins()
    const updatable = plugins.filter(p => fs.existsSync(path.join(p.path, '.git')))
    if (updatable.length === 0) return reply(e, '❌ 没有可通过 git 更新的插件')

    this.taskLock = true
    await reply(e, `⏳ 开始更新 ${updatable.length} 个插件，请耐心等待...`)

    const results = []
    for (const p of updatable) {
      try {
        const { stdout } = await execAsync('git pull', { cwd: p.path })
        const out = (stdout || '').trim()
        results.push(/already up|up to date|已经是最新|没有内容更新/i.test(out) ? `✅ ${p.name}：已是最新` : `✅ ${p.name}：已更新`)
      } catch (err) {
        results.push(`❌ ${p.name}：${err.message}`)
      }
    }

    this.taskLock = false
    return reply(e, `插件更新完成：\n${results.join('\n')}\n\n💡 发送 #重载插件 即可生效`)
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

  async reloadPlugins(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #重载插件')
    try {
      if (typeof globalThis.runtime === 'object' && globalThis.runtime.loadPlugins) {
        await globalThis.runtime.loadPlugins()
        return reply(e, '✅ 插件已重新加载')
      }
      if (typeof globalThis.Bot === 'object' && globalThis.Bot.reloadPlugins) {
        await globalThis.Bot.reloadPlugins()
        return reply(e, '✅ 插件已重新加载')
      }
      return reply(e, '✅ 已尝试重载插件\n若未生效请手动重启 Yunzai')
    } catch (err) {
      Logger.error(`重载失败: ${err.stack || err}`)
      return reply(e, `❌ 重载失败：${err.message}`)
    }
  }

  async showHelp(e) {
    return reply(
      e,
      `📦 插件管理器 - 使用帮助\n\n` +
      `#安装 <名称|仓库地址>\n   安装一个插件，支持预设名或 git 地址\n` +
      `#删除 <名称>\n   删除指定插件\n` +
      `#更新插件 <名称>\n   更新指定插件\n` +
      `#更新全部插件\n   更新所有 git 插件\n` +
      `#插件列表\n   查看已安装的插件（图片）\n` +
      `#插件市场\n   查看可一键安装的插件（图片）\n` +
      `#插件详情 <名称>\n   查看插件详细信息\n` +
      `#重载插件\n   重新加载所有插件\n` +
      `#插件管理帮助\n   查看本帮助\n\n` +
      `⚠️ 安装/删除/更新/重载 操作仅主人可用\n` +
      `💡 仓库：https://github.com/nidie2580/nidie`
    )
  }

  // ===== 图片渲染 =====

  async renderListImage(e, { title, subtitle, columns, rows, footer }) {
    // 没有 puppeteer 时降级为纯文本
    if (!Puppeteer || typeof Puppeteer.screenshot !== 'function') {
      Logger.warn(`[nidie] puppeteer 不可用 (${!Puppeteer ? '未加载' : '无 screenshot 方法'})，降级文本`)
      return this.renderListText(e, { title, subtitle, columns, rows, footer })
    }

    const html = this.buildListHtml({ title, subtitle, columns, rows, footer })
    Logger.mark(`[nidie] 开始渲染图片: ${title}`)

    // 临时 HTML 文件路径（部分 Yunzai 版本要求 html 是文件路径）
    const htmlPath = path.join(SELF_DIR, `.render_${Date.now()}.html`)
    try {
      // 尝试多种 screenshot 调用签名，兼容不同 Yunzai 版本
      const callArgs = [
        // 1) Yunzai 标准：screenshot(name, { html })
        () => Puppeteer.screenshot('plugin-manager', { html }),
        // 2) 老版本：screenshot(html, options)
        () => Puppeteer.screenshot(html, {}),
        // 3) 直接传文件路径
        () => {
          fs.writeFileSync(htmlPath, html, 'utf-8')
          return Puppeteer.screenshot('plugin-manager', { file: htmlPath, html })
        },
        // 4) 不传 name，只传 options
        () => Puppeteer.screenshot({ html })
      ]

      let img = null
      let lastErr = null
      for (let i = 0; i < callArgs.length; i++) {
        try {
          img = await callArgs[i]()
          if (img) {
            Logger.mark(`[nidie] 截图成功，方式 ${i + 1}`)
            break
          }
        } catch (err) {
          lastErr = err
          Logger.warn(`[nidie] 截图方式 ${i + 1} 失败: ${err.message}`)
        }
      }

      if (img) return reply(e, img)

      Logger.error(`[nidie] 所有截图方式均失败，降级文本。最后错误: ${lastErr?.message || '无'}`)
      return this.renderListText(e, { title, subtitle, columns, rows, footer })
    } catch (err) {
      Logger.error(`[nidie] 渲染图片失败: ${err.stack || err.message}，降级文本`)
      return this.renderListText(e, { title, subtitle, columns, rows, footer })
    } finally {
      // 清理临时文件
      try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath) } catch (_) {}
    }
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
    const bodyRows = rows.map(r => {
      const cells = r.map(c => `<td>${esc(c)}</td>`).join('')
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
  td:nth-child(1) { color: #888; width: 40px; }
  td:nth-child(2) { font-weight: 600; color: #333; }
  td:nth-child(4) { color: #666; font-size: 13px; }
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
      <table>
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

  async gitClone(repoUrl, targetPath) {
    return new Promise((resolve, reject) => {
      const cmd = `git clone --depth=1 "${repoUrl}" "${targetPath}"`
      exec(cmd, { cwd: PLUGINS_DIR, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })
  }

  async installDependencies(targetPath) {
    const pkgPath = path.join(targetPath, 'package.json')
    if (!fs.existsSync(pkgPath)) return

    let cmd = 'npm install --omit=dev'
    try {
      execSync('pnpm -v', { stdio: 'ignore' })
      cmd = 'pnpm install --prod'
    } catch (_) {}

    await new Promise(resolve => {
      exec(cmd, { cwd: targetPath, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) Logger.warn(`依赖安装告警: ${stderr?.trim() || err.message}`)
        resolve(stdout || '')
      })
    })
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
