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
      // 最后兜底：定义一个最小可用的父类，至少能实例化不报错
      PluginBase = class PluginFallback {
        constructor(cfg) { Object.assign(this, cfg) }
        accept() { return true }
      }
    }
  }
}

const execAsync = promisify(exec)

// 插件根目录 (Yunzai 的 plugins 目录)
const PLUGINS_DIR = path.resolve(process.cwd(), 'plugins')
// 本插件所在目录
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 常用 Yunzai 插件预设仓库
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

// 主人权限判断（兼容不同 Yunzai 版本的字段名）
function isMaster(e) {
  if (!e) return false
  if (e.isMaster === true || e.isMaster === 'true') return true
  // 部分版本存的是 e.master / e.user_id
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

// 统一回复方法：兼容 e.reply / 终端 stdin 的 fallback
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
  // 兜底：控制台打印
  console.log(String(msg))
  return Promise.resolve()
}

export class PluginManager extends PluginBase {
  constructor() {
    super({
      name: 'plugin-manager',
      dsc: '插件管理器 - 安装、卸载、更新、查看插件',
      event: 'message',
      priority: 50,
      rule: [
        {
          reg: '^#?插件管理帮助$',
          fnc: 'showHelp'
        },
        {
          reg: '^#?安装插件\\s+\\S',
          fnc: 'installPlugin'
        },
        {
          reg: '^#?卸载插件\\s+\\S',
          fnc: 'uninstallPlugin'
        },
        {
          reg: '^#?更新插件\\s+\\S',
          fnc: 'updatePlugin'
        },
        {
          reg: '^#?更新全部插件$',
          fnc: 'updateAllPlugins'
        },
        {
          reg: '^#?插件列表$',
          fnc: 'listPlugins'
        },
        {
          reg: '^#?插件详情\\s+\\S',
          fnc: 'pluginDetail'
        },
        {
          reg: '^#?可用插件$',
          fnc: 'listPresetPlugins'
        },
        {
          reg: '^#?重载插件$',
          fnc: 'reloadPlugins'
        }
      ]
    })
    this.taskLock = false
  }

  // ===== 指令方法 =====

  async installPlugin(e) {
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #安装插件')
    if (this.taskLock) return reply(e, '⚠️ 当前已有任务在执行中，请稍后再试...')

    const text = String(e?.msg ?? e?.raw_message ?? '')
    const input = text.replace(/^#?安装插件\s*/, '').trim()
    if (!input) return reply(e, '请提供插件名称或仓库地址\n示例：#安装插件 miao-plugin\n示例：#安装插件 https://gitee.com/xxx/xxx.git')

    const repoUrl = this.resolveRepoUrl(input)
    if (!repoUrl) return reply(e, `❌ 未找到插件「${input}」\n可发送 #可用插件 查看支持的插件\n或直接使用 git 仓库地址安装`)

    const dirName = this.parseRepoName(repoUrl)
    const targetPath = path.join(PLUGINS_DIR, dirName)

    if (fs.existsSync(targetPath)) {
      return reply(e, `❌ 插件「${dirName}」已存在\n如需更新请使用：#更新插件 ${dirName}\n如需重装请先卸载：#卸载插件 ${dirName}`)
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
    if (!isMaster(e)) return reply(e, '⚠️ 仅主人可使用 #卸载插件')

    const text = String(e?.msg ?? e?.raw_message ?? '')
    const name = text.replace(/^#?卸载插件\s*/, '').trim()
    if (!name) return reply(e, '请提供插件名称\n示例：#卸载插件 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return reply(e, `❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)

    if (path.resolve(targetPath) === SELF_DIR) {
      return reply(e, '⚠️ 无法卸载插件管理器自身')
    }

    try {
      this.removeDir(targetPath)
      return reply(
        e,
        `✅ 插件「${path.basename(targetPath)}」已卸载\n` +
        `📁 已删除：${path.relative(process.cwd(), targetPath)}\n` +
        `💡 发送 #重载插件 即可生效`
      )
    } catch (err) {
      Logger.error(`卸载失败: ${err.stack || err}`)
      return reply(e, `❌ 插件卸载失败：${err.message}`)
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

    const list = plugins.map((p, i) => {
      const isGit = fs.existsSync(path.join(p.path, '.git'))
      const relPath = path.relative(PLUGINS_DIR, p.path)
      return `${i + 1}. ${p.name}${isGit ? ' (git)' : ''}\n   ${relPath}`
    })

    return reply(e, `📦 已安装插件列表 (共 ${plugins.length} 个)\n\n${list.join('\n\n')}`)
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
    const list = entries.map(([name, url], i) => {
      const installed = this.findPluginPath(name) ? '✅ 已安装' : '⬜ 未安装'
      return `${i + 1}. ${name}\n   ${url}\n   ${installed}`
    })
    return reply(
      e,
      `📋 可用插件列表 (共 ${entries.length} 个)\n\n` +
      `${list.join('\n\n')}\n\n` +
      `💡 使用 #安装插件 <名称> 即可安装`
    )
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
      `#安装插件 <名称|仓库地址>\n   安装一个插件，支持预设名称或 git 地址\n` +
      `#卸载插件 <名称>\n   卸载指定插件\n` +
      `#更新插件 <名称>\n   更新指定插件\n` +
      `#更新全部插件\n   更新所有 git 插件\n` +
      `#插件列表\n   查看已安装的插件\n` +
      `#插件详情 <名称>\n   查看插件详细信息\n` +
      `#可用插件\n   查看可一键安装的插件\n` +
      `#重载插件\n   重新加载所有插件\n` +
      `#插件管理帮助\n   查看本帮助\n\n` +
      `⚠️ 安装/卸载/更新/重载 操作仅主人可用\n` +
      `💡 仓库：https://github.com/nidie2580/nidie`
    )
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
