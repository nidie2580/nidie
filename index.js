import fs from 'node:fs'
import path from 'node:path'

// 插件入口
// 加载 apps 目录下所有插件文件
let ret = []

const files = fs
  .readdirSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), 'apps'))
  .filter(file => file.endsWith('.js'))

files.forEach(file => {
  ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

for (const i in files) {
  const name = files[i]
  const res = ret[i]
  if (res.status !== 'fulfilled') {
    logger.error(`[nidie] 载入插件错误：${name}`)
    logger.error(res.reason)
    continue
  }
  logger.debug(`[nidie] 载入插件成功：${name}`)
}

logger.info('[nidie] 插件管理器加载完成')
