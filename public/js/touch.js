// 触屏操作层：#1 左下虚拟摇杆（MOBA 风格）、#2 右下冲刺切换钮、#3 技能轮盘容器。
//
// 只有触屏模式创建 DOM；桌面模式整层隐藏，所有监听保留但不再触发（visible 由角色决定）。
// 摇杆输出写入 input.axis，控制器每帧读取即可，与桌面鼠标移动向量同构。
import { INPUT_MODE } from './view.js';
import { axisFromOffset } from './input.js';
import { ROLE } from './const.js';

/** 摇杆可视半径上限（CSS px），实际由 CSS clamp 决定，这里读回元素尺寸 */
const JOY_KNOB_RATIO = 0.46;

export class TouchControls {
  /**
   * @param {{ view: import('./view.js').viewport, input: import('./input.js').Input }} deps
   */
  constructor({ view, input }) {
    this.view = view;
    this.input = input;
    this.role = null;
    this.enabled = false;
    this._joyPointerId = null;
    this._sprintPointerId = null;
    this._built = false;
  }

  /** 轮盘容器（供 toolui 渲染；可能为 null，表示尚未创建 DOM） */
  get wheelHost() {
    return this._wheel || null;
  }

  /** 构建 DOM（幂等）。由 main.js 在启动时调用一次。 */
  build(parent) {
    if (this._built) return;
    this._built = true;

    const layer = document.createElement('div');
    layer.id = 'touchLayer';
    layer.className = 'touch-layer hidden';
    layer.innerHTML = `
      <div id="joyBase" class="joystick" role="slider" aria-label="移动摇杆"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
        <span class="joy-ring"></span>
        <span class="joy-knob"></span>
      </div>
      <button id="sprintBtn" class="sprint-toggle hidden" type="button" aria-pressed="false">冲刺</button>
      <div id="skillWheel" class="skill-wheel"></div>
    `;
    (parent ?? document.getElementById('game') ?? document.body).appendChild(layer);

    this._layer = layer;
    this._joyBase = layer.querySelector('#joyBase');
    this._joyKnob = layer.querySelector('#joyKnob') ?? layer.querySelector('.joy-knob');
    this._sprintBtn = layer.querySelector('#sprintBtn');
    this._wheel = layer.querySelector('#skillWheel');

    this._bindJoystick();
    this._bindSprint();
    this._bindGlobalRelease();
  }

  // ---- 摇杆 ----

  _bindJoystick() {
    const base = this._joyBase;
    base.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this._joyPointerId !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this._joyPointerId = e.pointerId;
      try { base.setPointerCapture(e.pointerId); } catch (_) {}
      base.classList.add('active');
      this._updateFromEvent(e);
    });

    base.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._joyPointerId) return;
      e.preventDefault();
      this._updateFromEvent(e);
    });

    const end = (e) => {
      if (e.pointerId !== this._joyPointerId) return;
      this._joyPointerId = null;
      try { base.releasePointerCapture(e.pointerId); } catch (_) {}
      this._resetKnob();
    };
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
    base.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId === this._joyPointerId) end(e);
    });
  }

  /** 由触点位置计算摇杆轴并移动摇杆头 */
  _updateFromEvent(e) {
    const rect = this._joyBase.getBoundingClientRect();
    if (!rect.width) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);
    const clamped = len > radius && len > 0
      ? { x: (dx / len) * radius, y: (dy / len) * radius }
      : { x: dx, y: dy };

    const knobR = rect.width * JOY_KNOB_RATIO / 2;
    const maxOffset = radius - knobR * 0.35;
    const offsetLen = Math.hypot(clamped.x, clamped.y);
    const scale = offsetLen > maxOffset && offsetLen > 0 ? maxOffset / offsetLen : 1;
    this._joyKnob.style.transform = `translate(${clamped.x * scale}px, ${clamped.y * scale}px)`;

    const axis = axisFromOffset(clamped.x, clamped.y, radius);
    this.input.setAxis(axis.x, axis.y);
    this._joyBase.setAttribute('aria-valuenow', String(Math.round(Math.hypot(axis.x, axis.y) * 100)));
  }

  _resetKnob() {
    this._joyKnob.style.transform = 'translate(0px, 0px)';
    this.input.setAxis(0, 0);
    this._joyBase.classList.remove('active');
    this._joyBase.setAttribute('aria-valuenow', '0');
  }

  // ---- 冲刺 ----

  _bindSprint() {
    const btn = this._sprintBtn;
    btn.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      this._sprintPointerId = e.pointerId;
      this.setSprint(!this.input.sprintHeld);
    });
    btn.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this._sprintPointerId) return;
      this._sprintPointerId = null;
      e.preventDefault();
    });
    btn.addEventListener('pointercancel', () => { this._sprintPointerId = null; });
    // 阻止长按弹出系统菜单
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 设置冲刺开/关（切换式），并同步按钮状态 */
  setSprint(on) {
    this.input.sprintHeld = !!on;
    this._sprintBtn.classList.toggle('sprinting', !!on);
    this._sprintBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    this._sprintBtn.textContent = on ? '加速中' : '冲刺';
  }

  // ---- 全局兜底 ----

  _bindGlobalRelease() {
    // 触点被系统回收 / 切后台 / 失焦：摇杆必须回中，否则蚂蚁会持续移动
    window.addEventListener('blur', () => this.release());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.release(); });
    this.view.onChange(() => this.layout());
  }

  /** 强制回中并关闭冲刺（不改变可见性） */
  release() {
    this._joyPointerId = null;
    if (this._joyKnob) this._resetKnob();
    if (this._sprintBtn) this.setSprint(false);
  }

  /** 设置当前角色：null 隐藏整层；隐藏者额外显示冲刺钮 */
  setRole(role) {
    this.role = role ?? null;
    this.enabled = !!role && this.view.mode === INPUT_MODE.TOUCH;
    if (!this._built) return;
    this._layer.classList.toggle('hidden', !this.enabled);
    const showSprint = this.enabled && role === ROLE.HIDER;
    this._sprintBtn.classList.toggle('hidden', !showSprint);
    this._wheel?.classList.toggle('hidden', !this.enabled);
    if (!this.enabled) this.release();
    else this.layout();
  }

  /** 尺寸 / 方向变化后重排（CSS 负责布局，这里只保证摇杆头回中） */
  layout() {
    if (!this._built) return;
    const shouldEnable = !!this.role && this.view.mode === INPUT_MODE.TOUCH;
    if (shouldEnable !== this.enabled) {
      this.setRole(this.role);
      return;
    }
    this.release();
  }
}
