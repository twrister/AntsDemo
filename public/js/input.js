// 底层输入：键盘状态 + 鼠标事件 + 触屏指针事件（摇杆轴 / 点按 / 拖拽）。
//
// 两类输入来源互不合成：
// - 鼠标：保持桌面原有语义（down/up/move/click），由控制器按需消费。
// - 触屏：转换为抽象事件（tap / dragstart / dragmove / dragend）+ 摇杆轴 axis，
//   控制器不需要知道具体是哪种设备，也不关心坐标从哪来。
import { INPUT_MODE } from './view.js';

/** 触点位移超过该值（CSS px）即视为拖拽而非点按 */
const TAP_MOVE_TOLERANCE = 10;
/** 按住超过该时长（ms）即便未移动也视为拖拽（避免长按被当成点按） */
const TAP_HOLD_LIMIT = 300;

export class Input {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./view.js').viewport} view 视口单例（提供 CSS 尺寸与输入模式）
   */
  constructor(canvas, view) {
    this.canvas = canvas;
    this.view = view;
    this.keys = {};
    this.mouse = { x: 0, y: 0, down: false, leftDown: false };
    /** 摇杆轴（-1..1），触屏模式下由 TouchControls 写入 */
    this.axis = { x: 0, y: 0 };
    /** 触屏冲刺开关（桌面走 Space 键） */
    this.sprintHeld = false;
    /** 活动触点 pointerId -> { x, y, startX, startY, t0, moved, target } */
    this.pointers = new Map();
    /** 最近一次触点位置（CSS px，供预览锚点使用） */
    this.lastTouch = null;

    this._handlers = { down: [], up: [], move: [], click: [], tap: [], dragstart: [], dragmove: [], dragend: [] };

    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.isPointer) return;
      if (e.button === 0) this.mouse.leftDown = true;
      this.mouse.down = true; this._set(e); this._emit('down', e);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.leftDown = false;
      this.mouse.down = false;
      if (this.isPointer) this._emit('up', e);
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!this.isPointer) return;
      this._set(e); this._emit('move', e);
    });
    canvas.addEventListener('click', (e) => {
      if (!this.isPointer) return;
      this._set(e); this._emit('click', e);
    });

    // 触屏 / 手写笔：Pointer Events 统一处理，鼠标指针不进入该分支
    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
    // 触屏长按会弹出系统菜单，且拖动会触发页面滚动
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('selectstart', (e) => e.preventDefault());
  }

  /** 当前是否指针（鼠标）输入模式 */
  get isPointer() {
    return this.view.mode === INPUT_MODE.POINTER;
  }

  /** 当前是否触屏输入模式 */
  get isTouch() {
    return this.view.mode === INPUT_MODE.TOUCH;
  }

  _set(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;
  }

  _emit(type, e, extra) {
    for (const h of this._handlers[type]) h(e, extra ?? this.mouse);
  }

  /**
   * 订阅输入事件。
   * @param {'down'|'up'|'move'|'click'|'tap'|'dragstart'|'dragmove'|'dragend'} type
   * @param {(e: Event, data: object) => void} cb
   */
  on(type, cb) {
    if (!this._handlers[type]) throw new Error(`unknown input event: ${type}`);
    this._handlers[type].push(cb);
  }

  // ---- 触屏指针 ----

  _onPointerDown(e) {
    // 触屏设备上插入真实鼠标：实时切回桌面 UI，本次事件交给 mousedown 路径
    if (e.pointerType === 'mouse' && !this.view.forcedMode) {
      this.view.notePointerType('mouse');
      return;
    }
    // 输入模式由 viewport 决定；?input=touch 时鼠标也走触点语义，便于桌面验证
    if (!this.isTouch) return;
    this.view.notePointerType(e.pointerType);
    const p = this._clientToLocal(e);
    const rec = {
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      t0: performance.now(),
      moved: false,
      pointerType: e.pointerType,
    };
    this.pointers.set(e.pointerId, rec);
    this.lastTouch = { x: p.x, y: p.y };
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this.isTouch) return;
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    const p = this._clientToLocal(e);
    rec.x = p.x;
    rec.y = p.y;
    this.lastTouch = { x: p.x, y: p.y };
    if (!rec.moved) {
      const moved = Math.hypot(p.x - rec.startX, p.y - rec.startY) > TAP_MOVE_TOLERANCE;
      const held = performance.now() - rec.t0 > TAP_HOLD_LIMIT;
      if (moved || held) {
        rec.moved = true;
        this._emit('dragstart', e, { x: rec.startX, y: rec.startY, pointerId: e.pointerId });
      }
    }
    if (rec.moved) {
      this._emit('dragmove', e, { x: p.x, y: p.y, pointerId: e.pointerId });
    }
    e.preventDefault();
  }

  _onPointerUp(e) {
    if (!this.isTouch) return;
    const rec = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!rec) return;
    const p = this._clientToLocal(e);
    if (rec.moved) {
      this._emit('dragend', e, { x: p.x, y: p.y, pointerId: e.pointerId });
    } else if (performance.now() - rec.t0 <= TAP_HOLD_LIMIT * 3) {
      this._emit('tap', e, { x: p.x, y: p.y, pointerId: e.pointerId });
    }
    e.preventDefault();
  }

  _onPointerCancel(e) {
    const rec = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (rec?.moved) this._emit('dragend', e, { x: rec.x, y: rec.y, pointerId: e.pointerId });
  }

  _clientToLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- 摇杆 ----

  /**
   * 写入摇杆轴（由 TouchControls 调用）。
   * @param {number} x -1..1
   * @param {number} y -1..1
   */
  setAxis(x, y) {
    this.axis.x = x;
    this.axis.y = y;
  }

  /** 清空所有输入状态（切后台 / 失焦 / 触点被系统回收时调用） */
  releaseAll() {
    for (const code of Object.keys(this.keys)) this.keys[code] = false;
    this.mouse.down = false;
    this.mouse.leftDown = false;
    this.pointers.clear();
    this.axis.x = 0;
    this.axis.y = 0;
    this.sprintHeld = false;
  }

  /**
   * 统一的移动方向向量（未归一化，长度即强度）：
   * - 触屏：摇杆轴直接给出方向与力度
   * - 桌面：按住左键时从目标点指向鼠标（世界坐标），松手即静止
   *
   * @param {{ antX: number, antY: number, cam: { x: number, y: number, zoom?: number },
   *           viewport: { width: number, height: number, offsetX: number, offsetY: number }|null }} ctx
   */
  moveVector({ antX, antY, cam, viewport = null }) {
    if (this.isTouch) {
      return { dx: this.axis.x, dy: this.axis.y };
    }
    if (!this.mouse.leftDown) return { dx: 0, dy: 0 };
    const zoom = cam.zoom || 1;
    const cx = viewport ? viewport.offsetX + viewport.width / 2 : this.view.w / 2;
    const cy = viewport ? viewport.offsetY + viewport.height / 2 : this.view.h / 2;
    const wx = cam.x + (this.mouse.x - cx) / zoom;
    const wy = cam.y + (this.mouse.y - cy) / zoom;
    const dx = wx - antX;
    const dy = wy - antY;
    // 鼠标贴近蚂蚁时视为静止，便于拾取
    if (Math.hypot(dx, dy) < 4) return { dx: 0, dy: 0 };
    return { dx, dy };
  }

  /** 是否处于加速状态（触屏切换钮 / 桌面空格） */
  get sprinting() {
    return this.isTouch ? this.sprintHeld : !!this.keys['Space'];
  }
}

/** 死区：摇杆中心小范围视为静止，避免手指微抖导致蚂蚁乱动 */
export const JOY_DEADZONE = 0.16;

/**
 * 把摇杆原始偏移量转换为 -1..1 的轴（含死区与归一化）。
 * @param {number} dx 触点相对摇杆原点的 X 偏移（CSS px）
 * @param {number} dy 触点相对摇杆原点的 Y 偏移（CSS px）
 * @param {number} radius 摇杆可视半径（CSS px）
 */
export function axisFromOffset(dx, dy, radius) {
  const len = Math.hypot(dx, dy);
  if (!len || radius <= 0) return { x: 0, y: 0 };
  const norm = Math.min(1, len / radius);
  if (norm < JOY_DEADZONE) return { x: 0, y: 0 };
  // 死区外重新映射到 0..1，保证刚出死区时是缓慢起步而不是突然半速
  const scaled = (norm - JOY_DEADZONE) / (1 - JOY_DEADZONE);
  const strength = Math.min(1, scaled);
  return { x: (dx / len) * strength, y: (dy / len) * strength };
}
