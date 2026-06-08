// 全局开发者调参：3001 调试面板写入，3000 联机对局共享读取（同进程内存）。

/** @type {Record<string, unknown>|null} */
let cfg = null;

/** 去掉 WebSocket 消息外壳，返回纯调参对象 */
export function stripDevConfigMsg(msg) {
  if (!msg || typeof msg !== 'object') return {};
  const { type, ...rest } = msg;
  return rest;
}

/** 读取当前全局调参（可能为 null，表示尚未配置） */
export function getGlobalDevConfig() {
  return cfg;
}

/**
 * 合并并保存调参（3001 dev_config 入口）。
 * @returns {Record<string, unknown>} 合并后的全局配置
 */
export function setGlobalDevConfig(msg) {
  const rest = stripDevConfigMsg(msg);
  if (!cfg) cfg = {};
  Object.assign(cfg, rest);
  if (rest.AI_SPEED) {
    cfg.AI_SPEED = { ...(cfg.AI_SPEED || {}), ...rest.AI_SPEED };
  }
  if (rest.TOOL_CD) {
    cfg.TOOL_CD = { ...(cfg.TOOL_CD || {}), ...rest.TOOL_CD };
  }
  if (rest.MARK_COOLDOWN !== undefined) {
    cfg.MARK_COOLDOWN = rest.MARK_COOLDOWN;
  }
  return cfg;
}
