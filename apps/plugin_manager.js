import plugin from '../../lib/plugins/plugin.js'
import cfg from '../../lib/config/config.js'
import { exec, execSync } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

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

export class PluginManager extends plugin {
  constructor() {
    super({
      name: 'plugin-manager',
      dsc: '插件管理器 - 安装、卸载、更新、查看插件',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#?安装插件\\s*(.+)$',
          fnc: 'installPlugin',
          permission: 'master'
        },
        {
          reg: '^#?卸载插件\\s*(.+)$',
          fnc: 'uninstallPlugin',
          permission: 'master'
        },
        {
          reg: '^#?更新插件\\s*(.+)$',
          fnc: 'updatePlugin',
          permission: 'master'
        },
        {
          reg: '^#?更新全部插件$',
          fnc: 'updateAllPlugins',
          permission: 'master'
        },
        {
          reg: '^#?插件列表$',
          fnc: 'listPlugins'
        },
        {
          reg: '^#?插件详情\\s*(.+)$',
          fnc: 'pluginDetail'
        },
        {
          reg: '^#?可用插件$',
          fnc: 'listPresetPlugins'
        },
        {
          reg: '^#?重载插件$',
          fnc: 'reloadPlugins',
          permission: 'master'
        },
        {
          reg: '^#?插件管理帮助$',
          fnc: 'showHelp'
        }
      ]
    })
    this.taskLock = false
  }

  /**
   * 安装插件
   * 支持: git 仓库地址、预设插件名称、压缩包链接
   */
  async installPlugin(e) {
    if (this.taskLock) return e.reply('⚠️ 当前已有任务在执行中，请稍后再试...')
    const input = e.msg.replace(/^#?安装插件\s*/, '').trim()
    if (!input) return e.reply('请提供插件名称或仓库地址\n示例：#安装插件 miao-plugin\n示例：#安装插件 https://gitee.com/xxx/xxx.git')

    // 解析目标仓库地址
    const repoUrl = this.resolveRepoUrl(input)
    if (!repoUrl) return e.reply(`❌ 未找到插件「${input}」\n可发送 #可用插件 查看支持的插件\n或直接使用 git 仓库地址安装`)

    // 插件目录名
    const dirName = this.parseRepoName(repoUrl)
    const targetPath = path.join(PLUGINS_DIR, dirName)

    if (fs.existsSync(targetPath)) {
      return e.reply(`❌ 插件「${dirName}」已存在\n如需更新请使用：#更新插件 ${dirName}\n如需重装请先卸载：#卸载插件 ${dirName}`)
    }

    this.taskLock = true
    const msg = await e.reply(`⏳ 正在安装插件「${dirName}」...\n仓库地址：${repoUrl}\n请耐心等待，安装过程可能需要一些时间`)
    try {
      // 1. 克隆仓库
      await e.reply(`📦 [1/3] 正在克隆仓库...`)
      await this.gitClone(repoUrl, targetPath)

      // 2. 安装依赖
      await e.reply(`📦 [2/3] 正在安装依赖...`)
      await this.installDependencies(targetPath)

      // 3. 校验插件结构
      await e.reply(`📦 [3/3] 正在校验插件结构...`)
      const valid = this.validatePlugin(targetPath)

      const tips = []
      if (!valid) tips.push('⚠️ 未检测到 apps 目录或 index.js，请确认插件结构是否正确')

      this.taskLock = false
      return e.reply(
        `✅ 插件「${dirName}」安装成功！\n` +
        `📁 安装路径：${path.relative(process.cwd(), targetPath)}\n` +
        `${tips.length ? tips.join('\n') + '\n' : ''}` +
        `💡 发送 #重载插件 即可生效`
      )
    } catch (err) {
      this.taskLock = false
      // 安装失败时清理目录
      this.removeDir(targetPath)
      logger.error(`[plugin-manager] 安装失败: ${err.stack || err}`)
      return e.reply(`❌ 插件安装失败：${err.message}\n已自动清理残留文件`)
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(e) {
    const name = e.msg.replace(/^#?卸载插件\s*/, '').trim()
    if (!name) return e.reply('请提供插件名称\n示例：#卸载插件 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return e.reply(`❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)

    // 禁止卸载本插件自身
    if (path.resolve(targetPath) === SELF_DIR) {
      return e.reply('⚠️ 无法卸载插件管理器自身')
    }

    try {
      this.removeDir(targetPath)
      return e.reply(
        `✅ 插件「${path.basename(targetPath)}」已卸载\n` +
        `📁 已删除：${path.relative(process.cwd(), targetPath)}\n` +
        `💡 发送 #重载插件 即可生效`
      )
    } catch (err) {
      logger.error(`[plugin-manager] 卸载失败: ${err.stack || err}`)
      return e.reply(`❌ 插件卸载失败：${err.message}`)
    }
  }

  /**
   * 更新单个插件
   */
  async updatePlugin(e) {
    if (this.taskLock) return e.reply('⚠️ 当前已有任务在执行中，请稍后再试...')
    const name = e.msg.replace(/^#?更新插件\s*/, '').trim()
    if (!name) return e.reply('请提供插件名称\n示例：#更新插件 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return e.reply(`❌ 未找到插件「${name}」\n可发送 #插件列表 查看已安装插件`)

    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return e.reply(`⚠️ 插件「${path.basename(targetPath)}」不是 git 仓库，无法更新`)
    }

    this.taskLock = true
    try {
      const { stdout } = await execAsync('git pull', { cwd: targetPath })
      const output = (stdout || '').trim()

      // 检查是否有依赖更新
      let depMsg = ''
      try {
        await this.installDependencies(targetPath)
        depMsg = '\n✅ 依赖已更新'
      } catch (err) {
        depMsg = `\n⚠️ 依赖安装失败：${err.message}`
      }

      this.taskLock = false

      if (/already up|up to date|已经是最新|没有内容更新/i.test(output)) {
        return e.reply(`✅ 插件「${path.basename(targetPath)}」已是最新版本${depMsg}`)
      }
      return e.reply(`✅ 插件「${path.basename(targetPath)}」更新成功\n${output}${depMsg}\n💡 发送 #重载插件 即可生效`)
    } catch (err) {
      this.taskLock = false
      logger.error(`[plugin-manager] 更新失败: ${err.stack || err}`)
      return e.reply(`❌ 插件更新失败：${err.message}`)
    }
  }

  /**
   * 更新全部插件
   */
  async updateAllPlugins(e) {
    if (this.taskLock) return e.reply('⚠️ 当前已有任务在执行中，请稍后再试...')

    const plugins = this.scanPlugins()
    const updatable = plugins.filter(p => fs.existsSync(path.join(p.path, '.git')))

    if (updatable.length === 0) return e.reply('❌ 没有可通过 git 更新的插件')

    this.taskLock = true
    await e.reply(`⏳ 开始更新 ${updatable.length} 个插件，请耐心等待...`)

    const results = []
    for (const p of updatable) {
      try {
        const { stdout } = await execAsync('git pull', { cwd: p.path })
        const out = (stdout || '').trim()
        if (/already up|up to date|已经是最新|没有内容更新/i.test(out)) {
          results.push(`✅ ${p.name}：已是最新`)
        } else {
          results.push(`✅ ${p.name}：已更新`)
        }
      } catch (err) {
        results.push(`❌ ${p.name}：${err.message}`)
      }
    }

    this.taskLock = false
    return e.reply(`插件更新完成：\n${results.join('\n')}\n\n💡 发送 #重载插件 即可生效`)
  }

  /**
   * 列出已安装插件
   */
  async listPlugins(e) {
    const plugins = this.scanPlugins()
    if (plugins.length === 0) return e.reply('当前未检测到任何插件')

    const list = plugins.map((p, i) => {
      const isGit = fs.existsSync(path.join(p.path, '.git'))
      const relPath = path.relative(PLUGINS_DIR, p.path)
      return `${i + 1}. ${p.name}${isGit ? ' (git)' : ''}\n   ${relPath}`
    })

    return e.reply(`📦 已安装插件列表 (共 ${plugins.length} 个)\n\n${list.join('\n\n')}`)
  }

  /**
   * 插件详情
   */
  async pluginDetail(e) {
    const name = e.msg.replace(/^#?插件详情\s*/, '').trim()
    if (!name) return e.reply('请提供插件名称\n示例：#插件详情 miao-plugin')

    const targetPath = this.findPluginPath(name)
    if (!targetPath) return e.reply(`❌ 未找到插件「${name}」`)

    const dirName = path.basename(targetPath)
    const isGit = fs.existsSync(path.join(targetPath, '.git'))
    let gitInfo = ''
    if (isGit) {
      try {
        const remote = execSync('git remote get-url origin', { cwd: targetPath }).toString().trim()
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetPath }).toString().trim()
        const commit = execSync('git log -1 --format=%h %cd %s', { cwd: targetPath, env: { ...process.env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' } }).toString().trim()
        gitInfo = `\nGit 信息：\n  远程：${remote}\n  分支：${branch}\n  最新提交：${commit}`
      } catch {}
    }

    // 统计 apps 目录下的 js 文件
    let appCount = 0
    const appsDir = path.join(targetPath, 'apps')
    if (fs.existsSync(appsDir)) {
      appCount = fs.readdirSync(appsDir).filter(f => f.endsWith('.js')).length
    }

    // package.json 信息
    let pkgInfo = ''
    const pkgPath = path.join(targetPath, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        pkgInfo = `\n版本：${pkg.version || '未知'}\n描述：${pkg.description || '无'}`
      } catch {}
    }

    const relPath = path.relative(process.cwd(), targetPath)
    return e.reply(
      `📦 插件详情：${dirName}\n\n` +
      `路径：${relPath}\n` +
      `类型：${isGit ? 'git 仓库' : '本地目录'}\n` +
      `apps 文件数：${appCount}${pkgInfo}${gitInfo}`
    )
  }

  /**
   * 列出可用预设插件
   */
  async listPresetPlugins(e) {
    const entries = Object.entries(PRESET_PLUGINS)
    const list = entries.map(([name, url], i) => {
      const installed = this.findPluginPath(name) ? '✅ 已安装' : '⬜ 未安装'
      return `${i + 1}. ${name}\n   ${url}\n   ${installed}`
    })
    return e.reply(
      `📋 可用插件列表 (共 ${entries.length} 个)\n\n` +
      `${list.join('\n\n')}\n\n` +
      `💡 使用 #安装插件 <名称> 即可安装`
    )
  }

  /**
   * 重载插件
   */
  async reloadPlugins(e) {
    try {
      if (typeof globalThis.runtime === 'object' && runtime.loadPlugins) {
        await runtime.loadPlugins()
        return e.reply('✅ 插件已重新加载')
      }
      // 兜底：提示手动重启
      return e.reply('✅ 已尝试重载插件\n若未生效请手动重启 Yunzai')
    } catch (err) {
      logger.error(`[plugin-manager] 重载失败: ${err.stack || err}`)
      return e.reply(`❌ 重载失败：${err.message}`)
    }
  }

  /**
   * 显示帮助
   */
  async showHelp(e) {
    return e.reply(
      `📦 插件管理器 - 使用帮助\n\n` +
      `#安装插件 <名称|仓库地址>\n   安装一个插件，支持预设名称或 git 地址\n` +
      `#卸载插件 <名称>\n   卸载指定插件\n` +
      `#更新插件 <名称>\n   更新指定插件\n` +
      `#更新全部插件\n   更新所有 git 插件\n` +
      `#插件列表\n   查看已安装的插件\n` +
      `#插件详情 <名称>\n   查看插件详细信息\n` +
      `#可用插件\n   查看可一键安装的插件\n` +
      `#重载插件\n   重新加载所有插件\n\n` +
      `⚠️ 安装/卸载/更新/重载 操作仅主人可用\n` +
      `💡 仓库：https://github.com/nidie2580/nidie`
    )
  }

  // ===== 内部工具方法 =====

  /**
   * 解析仓库地址：预设名称 → 完整 URL
   */
  resolveRepoUrl(input) {
    // 直接是 git 地址
    if (/^(https?|git):\/\//.test(input) || input.startsWith('git@')) {
      return input
    }
    // gitee/github 简写 owner/repo
    if (/^[\w.-]+\/[\w.-]+$/.test(input)) {
      return `https://gitee.com/${input}.git`
    }
    // 预设插件名
    if (PRESET_PLUGINS[input]) {
      return PRESET_PLUGINS[input]
    }
    return null
  }

  /**
   * 从仓库地址解析插件目录名
   */
  parseRepoName(url) {
    const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '')
    const parts = cleaned.split(/[:/]/)
    return parts[parts.length - 1]
  }

  /**
   * git 克隆
   */
  async gitClone(repoUrl, targetPath) {
    return new Promise((resolve, reject) => {
      const cmd = `git clone --depth=1 "${repoUrl}" "${targetPath}"`
      exec(cmd, { cwd: PLUGINS_DIR, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message))
        } else {
          resolve(stdout)
        }
      })
    })
  }

  /**
   * 安装依赖
   */
  async installDependencies(targetPath) {
    const pkgPath = path.join(targetPath, 'package.json')
    if (!fs.existsSync(pkgPath)) return

    // 优先使用 pnpm, 其次 npm
    let cmd = 'npm install --omit=dev'
    try {
      execSync('pnpm -v', { stdio: 'ignore' })
      cmd = 'pnpm install --prod'
    } catch {}

    await new Promise((resolve, reject) => {
      exec(cmd, { cwd: targetPath, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // 依赖安装失败不阻断整体流程，给出警告
          logger.warn(`[plugin-manager] 依赖安装告警: ${stderr?.trim() || err.message}`)
          resolve(stdout)
        } else {
          resolve(stdout)
        }
      })
    })
  }

  /**
   * 校验插件结构是否合法
   */
  validatePlugin(targetPath) {
    const hasAppsDir = fs.existsSync(path.join(targetPath, 'apps'))
    const hasIndex = fs.existsSync(path.join(targetPath, 'index.js'))
    const hasPackage = fs.existsSync(path.join(targetPath, 'package.json'))
    return hasAppsDir || hasIndex || hasPackage
  }

  /**
   * 扫描 plugins 目录下的插件
   */
  scanPlugins() {
    const result = []
    if (!fs.existsSync(PLUGINS_DIR)) return result

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      // 过滤系统目录
      if (['example', 'genshin', 'system', 'other'].includes(name)) continue
      if (name.startsWith('.')) continue
      const full = path.join(PLUGINS_DIR, name)
      // 判断是否为插件目录
      const isPlugin =
        fs.existsSync(path.join(full, 'apps')) ||
        fs.existsSync(path.join(full, 'index.js')) ||
        fs.existsSync(path.join(full, 'package.json'))
      if (isPlugin) {
        result.push({ name, path: full })
      }
    }
    return result
  }

  /**
   * 查找插件路径（支持模糊匹配）
   */
  findPluginPath(name) {
    const plugins = this.scanPlugins()
    // 精确匹配
    const exact = plugins.find(p => p.name === name)
    if (exact) return exact.path
    // 包含匹配
    const fuzzy = plugins.find(p => p.name.toLowerCase().includes(name.toLowerCase()))
    if (fuzzy) return fuzzy.path
    return null
  }

  /**
   * 递归删除目录
   */
  removeDir(dirPath) {
    if (!fs.existsSync(dirPath)) return
    try {
      fs.rmSync(dirPath, { recursive: true, force: true })
    } catch (err) {
      logger.error(`[plugin-manager] 删除目录失败: ${err.message}`)
      throw err
    }
  }
}
