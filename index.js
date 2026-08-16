import { PluginManager } from './apps/plugin_manager.js'

// Yunzai 插件标准入口：导出插件类
// Yunzai 启动时会扫描所有 plugins/*/index.js 的 exports，
// 收集继承自 plugin 的类并实例化，注册 rule 到消息调度器。
const plugins = [PluginManager]

export { plugins }
export { PluginManager }
export default plugins

// 兼容日志打印（安全兜底：logger 未定义时不报错）
try {
  if (typeof logger !== 'undefined' && logger.info) {
    logger.info('[nidie] 插件管理器加载成功')
  } else if (typeof console !== 'undefined') {
    console.log('[nidie] 插件管理器加载成功')
  }
} catch (_) {}
