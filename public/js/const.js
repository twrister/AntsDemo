// 客户端共享常量 (与服务器 protocol.js 对应)
export const ROLE = { SEEKER: 'seeker', HIDER: 'hider' };

/** 草甸默认基色（开发者工具可调，用于给草地色斑定调） */
export const GROUND_FILL_DEFAULT = '#94b169';

/** 隐藏者视口宽高比 (4:3)，仅 HIDER_VIEW_MODE === 'box' 时用于 letterbox */
export const HIDER_VIEW_ASPECT = 4 / 3;

/**
 * 隐藏者视野模式：
 * - 'area'（默认）：保持「可见世界面积」跨端一致，形状随屏幕变化。横屏手机上不会浪费
 *   左右两侧大片区域，且手机与桌面同局时判定范围一致。
 * - 'box'：旧行为，固定 4:3 letterbox 视口。
 */
export const HIDER_VIEW_MODE = 'area';

/** 隐藏者 zoom 的合理区间，避免极端分辨率下缩放到不可玩 */
export const HIDER_VIEW_MIN_ZOOM = 0.35;
export const HIDER_VIEW_MAX_ZOOM = 2.5;

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * 取出尺寸：兼容视口单例 ({ w, h }) 与画布 ({ width, height })。
 * @returns {{ w: number, h: number }}
 */
function sizeOf(view) {
  if (!view) return { w: 0, h: 0 };
  const w = Number(view.w ?? view.width) || 0;
  const h = Number(view.h ?? view.height) || 0;
  return { w, h };
}

/**
 * 计算使整个世界完整落入视口的 zoom。
 * 用于搜寻者默认概览：全图可见，暗角仍限制有效观察区。
 * @param {{ w: number, h: number }} view 视口（CSS px）
 * @param {{ w: number, h: number }} world
 */
export function computeFitZoom(view, world) {
  const { w, h } = sizeOf(view);
  if (!w || !h || !world?.w || !world?.h) return 1;
  return Math.min(w / world.w, h / world.h);
}

/**
 * 隐藏者视口（屏幕坐标矩形）。
 * - 'area' 模式：铺满整个视口，余量不再留黑边。
 * - 'box' 模式：在屏幕内最大化 4:3 并居中，余量留黑边。
 */
export function computeHiderViewport(view) {
  const { w: W, h: H } = sizeOf(view);
  if (!W || !H) return { width: 1, height: 1, offsetX: 0, offsetY: 0 };
  if (HIDER_VIEW_MODE !== 'box') return { width: W, height: H, offsetX: 0, offsetY: 0 };
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
 * 隐藏者 zoom：按固定世界可见范围缩放，各端分辨率/形状不同但可见范围一致。
 * - 'area' 模式：可见世界面积恒等于 hiderViewWidth × hiderViewHeight。
 * - 'box' 模式：可见范围恒等于该世界矩形（与屏幕形状无关）。
 */
export function computeHiderZoom(view, world) {
  const { w: W, h: H } = sizeOf(view);
  const viewW = world?.hiderViewWidth ?? 960;
  const viewH = world?.hiderViewHeight ?? 720;
  if (!W || !H || !viewW || !viewH) return 1.5;
  if (HIDER_VIEW_MODE === 'box') {
    const vp = computeHiderViewport(view);
    return clamp(Math.min(vp.width / viewW, vp.height / viewH), HIDER_VIEW_MIN_ZOOM, HIDER_VIEW_MAX_ZOOM);
  }
  const areaZoom = Math.sqrt((W * H) / (viewW * viewH));
  return clamp(areaZoom, HIDER_VIEW_MIN_ZOOM, HIDER_VIEW_MAX_ZOOM);
}
