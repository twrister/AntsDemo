// 客户端共享常量 (与服务器 protocol.js 对应)
export const ROLE = { SEEKER: 'seeker', HIDER: 'hider' };

/**
 * 计算使整个世界完整落入视口的 zoom。
 * 用于搜寻者默认概览：全图可见，暗角仍限制有效观察区。
 */
export function computeFitZoom(canvas, world) {
  if (!canvas.width || !canvas.height || !world?.w || !world?.h) return 1;
  return Math.min(canvas.width / world.w, canvas.height / world.h);
}
