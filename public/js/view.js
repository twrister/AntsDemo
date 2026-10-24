// 视口与设备能力单例：统一尺寸来源、DPR、安全区、输入模式（触屏 / 指针）。
//
// 设计要点：
// - 尺寸以「布局视口」(documentElement.clientWidth/Height) 为准，避免移动端地址栏
//   伸缩导致反复重算；视觉视口 (visualViewport) 仅用于兜底与滚动同步。
// - 旋转 / 地址栏伸缩 / 软键盘都会触发多次 resize，这里用 rAF + 尾部去抖合并为一次广播。
// - 输入模式可在运行中热切换（触屏设备插上鼠标、平板切换键盘等），带迟滞避免抖动。
import { ROLE } from './const.js';

/** 设备输入模式 */
export const INPUT_MODE = { POINTER: 'pointer', TOUCH: 'touch' };

/** 尺寸变化超过该阈值才广播（CSS px），过滤亚像素抖动 */
const SIZE_EPSILON = 2;
/** 尺寸变化后的尾部去抖时长（ms） */
const RESIZE_DEBOUNCE = 80;
/** 指针类型切换的迟滞（ms），避免触摸+鼠标混用时反复切换 */
const MODE_SWITCH_HYSTERESIS = 250;
/** DPR 上限：低端机 3x 屏直绘 4K 后备缓冲会掉帧 */
const MAX_DPR = 2;

const TOUCH_QUERY = '(pointer: coarse)';
/** 与 style.css 竖屏遮罩使用同一媒体查询，避免 JS 标记与 CSS 判断分叉 */
const PORTRAIT_QUERY = '(orientation: portrait)';
/** 轮询兜底间隔（ms）：部分 WebView 旋转后既不触发事件、尺寸也不刷新 */
const ORIENTATION_POLL = 800;

/** 解析 CSS 安全区变量（由 style.css 的 env(safe-area-inset-*) 提供） */
function readSafeArea() {
  const cs = getComputedStyle(document.documentElement);
  const num = (name) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return { top: num('--sat'), right: num('--sar'), bottom: num('--sab'), left: num('--sal') };
}

/** 读取布局视口尺寸（CSS px） */
function readSize() {
  const de = document.documentElement;
  const w = de.clientWidth || window.innerWidth || 1;
  const h = de.clientHeight || window.innerHeight || 1;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** 解析 ?input= 强制覆盖（QA 用，不改变设备检测本身） */
function readForcedMode() {
  try {
    const v = new URLSearchParams(location.search).get('input');
    if (v === 'touch') return INPUT_MODE.TOUCH;
    if (v === 'pointer' || v === 'mouse' || v === 'desktop') return INPUT_MODE.POINTER;
  } catch (_) {}
  return null;
}

/** 系统是否具备触屏能力 */
function detectTouchCapable() {
  if (typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches) return true;
  return (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
}

/**
 * 视口 / 设备单例。
 *
 * 用法：
 *   viewport.start();
 *   viewport.onChange(() => relayout());
 *   canvas 尺寸交给 viewport.applyCanvas(canvas)。
 */
class Viewport {
  constructor() {
    const { w, h } = readSize();
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.insets = readSafeArea();
    this._portraitMq = typeof window.matchMedia === 'function' ? window.matchMedia(PORTRAIT_QUERY) : null;
    this._portrait = this._portraitMq ? this._portraitMq.matches : h > w;
    this.touchCapable = detectTouchCapable();
    this._forcedMode = readForcedMode();
    this.mode = this._forcedMode ?? (this.touchCapable ? INPUT_MODE.TOUCH : INPUT_MODE.POINTER);
    this._listeners = new Set();
    this._started = false;
    this._raf = 0;
    this._timer = 0;
    this._modeChangedAt = 0;
    this._lastPointer = { type: 'mouse', at: 0 };
  }

  /** 是否触屏输入模式 */
  get isTouch() {
    return this.mode === INPUT_MODE.TOUCH;
  }

  /** 是否被 ?input= / DevTools 强制指定（强制时不响应真实指针类型切换） */
  get forcedMode() {
    return this._forcedMode;
  }

  /** 横屏；移动端据此显示竖屏遮罩。优先用媒体查询（与 CSS 同源），回退到尺寸比较 */
  get isLandscape() {
    if (this._portraitMq) return !this._portraitMq.matches;
    return this.w >= this.h;
  }

  /** 渲染质量档：触屏默认低档，跳过昂贵的合成层 */
  get quality() {
    return this.isTouch ? 'low' : 'high';
  }

  /**
   * 开始监听环境变化（幂等）。
   */
  start() {
    if (this._started) return;
    this._started = true;
    this._schedule = () => this._scheduleUpdate();

    // 旋转后部分移动浏览器的尺寸要几百毫秒才更新，且之后不再触发 resize，需多次补读
    this._scheduleRotate = () => this._scheduleAfterRotate();

    window.addEventListener('resize', this._schedule, { passive: true });
    window.addEventListener('orientationchange', this._scheduleRotate, { passive: true });
    window.visualViewport?.addEventListener('resize', this._schedule, { passive: true });
    window.visualViewport?.addEventListener('scroll', this._schedule, { passive: true });
    window.screen?.orientation?.addEventListener?.('change', this._scheduleRotate);
    this._portraitMq?.addEventListener?.('change', this._scheduleRotate);
    // 兜底：个别 WebView 旋转后既不发事件、clientWidth/Height 也停在旧值，只能轮询校正
    this._poll = setInterval(() => {
      if (!document.hidden) this._flush();
    }, ORIENTATION_POLL);
    window.addEventListener('pointerdown', this._onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', this._onPointerUp, { passive: true, capture: true });

    if (typeof window.matchMedia === 'function') {
      this._mq = window.matchMedia(TOUCH_QUERY);
      const handler = () => this._scheduleUpdate();
      this._mq.addEventListener?.('change', handler);
      this._mqListener = handler;
    }
    // 首帧后校正一次（部分浏览器首次布局尺寸未就绪）
    requestAnimationFrame(() => this._scheduleUpdate());
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    window.removeEventListener('resize', this._schedule);
    window.removeEventListener('orientationchange', this._scheduleRotate);
    window.visualViewport?.removeEventListener('resize', this._schedule);
    window.visualViewport?.removeEventListener('scroll', this._schedule);
    window.screen?.orientation?.removeEventListener?.('change', this._scheduleRotate);
    this._portraitMq?.removeEventListener?.('change', this._scheduleRotate);
    this._rotateTimers?.forEach(clearTimeout);
    clearInterval(this._poll);
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    if (this._mq && this._mqListener) this._mq.removeEventListener?.('change', this._mqListener);
    cancelAnimationFrame(this._raf);
    clearTimeout(this._timer);
  }

  /** 订阅环境变化（尺寸 / 旋转 / 安全区 / 输入模式），返回退订函数 */
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  /**
   * 强制指定输入模式；传 null 恢复自动检测。
   * @param {'touch'|'pointer'|null} mode
   */
  setMode(mode) {
    this._forcedMode = mode;
    this._applyMode(mode ?? (this.touchCapable ? INPUT_MODE.TOUCH : INPUT_MODE.POINTER));
  }

  /**
   * 记录真实指针类型，用于运行中热切换（鼠标 vs 手指）。
   * @param {string} pointerType PointerEvent.pointerType
   */
  notePointerType(pointerType) {
    if (this._forcedMode) return;
    if (pointerType !== 'mouse' && pointerType !== 'touch' && pointerType !== 'pen') return;
    const now = performance.now();
    this._lastPointer = { type: pointerType, at: now };
    // 手指 → 触屏立即生效；鼠标 → 指针输入需迟滞，避免触摸后残留的合成鼠标事件来回切
    if (pointerType !== 'mouse') {
      this.touchCapable = true;
      this._applyMode(INPUT_MODE.TOUCH);
      return;
    }
    if (now - this._modeChangedAt > MODE_SWITCH_HYSTERESIS) {
      this._applyMode(INPUT_MODE.POINTER);
    }
  }

  _onPointerDown = (e) => this.notePointerType(e.pointerType);
  _onPointerUp = (e) => this.notePointerType(e.pointerType);

  _applyMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._modeChangedAt = performance.now();
    this._emit();
  }

  /** 把画布后备缓冲同步为 逻辑尺寸 × DPR */
  applyCanvas(canvas) {
    const { w, h, dpr } = this;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const styleW = `${w}px`;
    const styleH = `${h}px`;
    if (canvas.style.width !== styleW) canvas.style.width = styleW;
    if (canvas.style.height !== styleH) canvas.style.height = styleH;
  }

  _scheduleUpdate() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._flush());
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), RESIZE_DEBOUNCE);
  }

  _scheduleAfterRotate() {
    this._scheduleUpdate();
    this._rotateTimers?.forEach(clearTimeout);
    this._rotateTimers = [150, 400, 800, 1500].map((ms) => setTimeout(() => this._flush(), ms));
  }

  _flush() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearTimeout(this._timer);
    this._timer = 0;

    let { w, h } = readSize();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const insets = readSafeArea();
    const portrait = this._portraitMq ? this._portraitMq.matches : h > w;

    // 媒体查询说竖屏、clientWidth 却是横的（或反之）→ 布局尺寸还没跟上旋转，改用 innerWidth/Height
    if ((portrait && w >= h) || (!portrait && h > w)) {
      w = Math.max(1, Math.round(window.innerWidth || w));
      h = Math.max(1, Math.round(window.innerHeight || h));
    }

    const changed = Math.abs(w - this.w) > SIZE_EPSILON
      || Math.abs(h - this.h) > SIZE_EPSILON
      || Math.abs(dpr - this.dpr) > 0.01
      || portrait !== this._portrait
      || ['top', 'right', 'bottom', 'left'].some((k) => Math.abs(insets[k] - this.insets[k]) > 0.5);

    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.insets = insets;
    this._portrait = portrait;
    if (changed) this._emit();
  }

  _emit() {
    for (const cb of this._listeners) {
      try { cb(this); } catch (err) { console.error('[viewport] listener failed', err); }
    }
  }
}

/** 全局唯一视口 */
export const viewport = new Viewport();

/** 移动端专用文案（触屏输入） */
export const TOUCH_HINTS = {
  [ROLE.SEEKER]: '摇杆移动准星 · 点按蚂蚁标记 · 右侧轮盘使用工具',
  [ROLE.HIDER]: '摇杆移动 · 静止靠近食物自动拾取 · 右侧「冲刺」加速 · 轮盘中心突进',
};

/** 桌面文案（鼠标键盘） */
export const POINTER_HINTS = {
  [ROLE.SEEKER]: '右键拖拽平移 · 左键点击蚂蚁标记 · 数字键/点击使用工具',
  [ROLE.HIDER]: '按住鼠标左键朝鼠标方向移动 · 静止靠近食物自动拾取 · 按住空格加速冲刺 · 按 [1] 突进',
};

/**
 * 申请全屏（best-effort）。必须在用户手势回调内调用。
 * iPhone Safari 无元素全屏 API，此时静默失败。
 * @returns {Promise<boolean>}
 */
export async function requestMobileFullscreen(el = document.documentElement) {
  if (!el?.requestFullscreen || document.fullscreenElement) return false;
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 尝试锁定横屏（仅全屏 / PWA 下有效，桌面与 iOS 会拒绝）。
 * @returns {Promise<boolean>}
 */
export async function lockLandscape() {
  try {
    const orientation = window.screen?.orientation;
    if (!orientation?.lock) return false;
    await orientation.lock('landscape');
    return true;
  } catch (_) {
    return false;
  }
}

/** 触屏设备进入对局前的一次性准备：全屏 + 横屏锁定，全部 best-effort */
export function prepareMobileDisplay() {
  if (!viewport.isTouch) return;
  requestMobileFullscreen().then((ok) => { if (ok) lockLandscape(); });
}
