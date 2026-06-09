// 客户端共享常量 (与服务器 protocol.js 对应)
export const ROLE = { SEEKER: 'seeker', HIDER: 'hider' };

/** 场景土壤默认底色（开发者工具可调） */
export const GROUND_FILL_DEFAULT = '#6a7268';

/**
 * 计算使整个世界完整落入视口的 zoom。
 * 用于搜寻者默认概览：全图可见，暗角仍限制有效观察区。
 */
export function computeFitZoom(canvas, world) {
  if (!canvas.width || !canvas.height || !world?.w || !world?.h) return 1;
  return Math.min(canvas.width / world.w, canvas.height / world.h);
}

/** 隐藏者视口宽高比 (4:3) */
export const HIDER_VIEW_ASPECT = 4 / 3;

/**
 * 隐藏者 4:3 视口：在屏幕内最大化并居中，余量留黑边。
 */
export function computeHiderViewport(canvas) {
  const W = canvas.width, H = canvas.height;
  let width, height;
  if (W / H >= HIDER_VIEW_ASPECT) {
    height = H;
    width = H * HIDER_VIEW_ASPECT;
  } else {
    width = W;
    height = W / HIDER_VIEW_ASPECT;
  }
  return { width, height, offsetX: (W - width) / 2, offsetY: (H - height) / 2 };
}

/**
 * 隐藏者 zoom：按固定世界可见范围缩放，各端分辨率不同但 4:3 视野一致。
 */
export function computeHiderZoom(canvas, world) {
  const vp = computeHiderViewport(canvas);
  const viewW = world?.hiderViewWidth ?? 960;
  const viewH = world?.hiderViewHeight ?? 720;
  if (!vp.width || !vp.height || !viewW || !viewH) return 1.5;
  return Math.min(vp.width / viewW, vp.height / viewH);
}
