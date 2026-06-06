// 搜寻者控制器：镜头平移、视野半径、点击标记、工具使用与全局冷却。
import { computeFitZoom } from './const.js';

const GLOBAL_TOOLS = ['freeze', 'thermal', 'magnify'];      // 立即生效(全局)
const AIMED_TOOLS = ['panic', 'bait', 'track'];             // 需选点
const MAGNIFY_FACTOR = 2.4;  // 放大镜相对默认 fit 缩放的倍数

export class SeekerController {
  constructor({ canvas, input, net, world }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.baseZoom = computeFitZoom(canvas, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.baseZoom };
    this.armedTool = null;        // 已选中待施放的瞄准类工具
    this.toolKeys = Object.keys(world.tools); // 工具顺序
    this.lastSnap = null;

    this._setupDrag();
    this._buildToolbar();
    this._setupClick();
    this._setupHotkeys();
    this._setupResize();
  }

  /** 窗口尺寸变化时重算 fit 缩放，保持全图可见 */
  _setupResize() {
    window.addEventListener('resize', () => {
      const atBase = Math.abs(this.cam.zoom - this.baseZoom) < 0.02;
      const magnifying = !!this.lastSnap?.magnify;
      this.baseZoom = computeFitZoom(this.canvas, this.world);
      if (atBase && !magnifying) this.cam.zoom = this.baseZoom;
      this._clampCam();
    });
  }

  _setupDrag() {
    let dragging = false, last = null;
    this.input.on('down', (e, m) => {
      if (e.button === 2 || (!this.armedTool && e.shiftKey)) return;
      // 右键拖拽平移；左键留给标记/施放
      if (e.button === 1 || e.button === 2) { dragging = true; last = { x: m.x, y: m.y }; }
    });
    // 用右键拖拽平移更顺手
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) { dragging = true; last = { x: e.offsetX, y: e.offsetY }; this.canvas.classList.add('dragging'); }
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !last) return;
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.cam.x -= (x - last.x) / this.cam.zoom;
      this.cam.y -= (y - last.y) / this.cam.zoom;
      this._clampCam();
      last = { x, y };
    });
    window.addEventListener('mouseup', () => { dragging = false; last = null; this.canvas.classList.remove('dragging'); });
  }

  /** 限制镜头中心，避免 zoom 小于 fit 时露出地图外空白 */
  _clampCam() {
    const hw = this.canvas.width / this.cam.zoom / 2;
    const hh = this.canvas.height / this.cam.zoom / 2;
    this.cam.x = this._clampAxis(this.cam.x, this.world.w, hw);
    this.cam.y = this._clampAxis(this.cam.y, this.world.h, hh);
  }

  _clampAxis(pos, size, halfVisible) {
    if (halfVisible >= size / 2) return size / 2;
    return Math.max(halfVisible, Math.min(size - halfVisible, pos));
  }

  _setupClick() {
    this.input.on('click', (e, m) => {
      if (e.button !== 0) return;
      const wp = this.screenToWorld(m.x, m.y);
      if (this.armedTool) {
        this.net.send({ type: 'use_tool', tool: this.armedTool, x: wp.x, y: wp.y });
        this.armedTool = null;
        this._refreshArmed();
        return;
      }
      // 标记最近的蚂蚁 (需在合理半径内，避免误点)
      const ant = this._antAt(wp.x, wp.y);
      if (ant) this.net.send({ type: 'mark', antId: ant.id });
    });
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < this.toolKeys.length) this._activateTool(this.toolKeys[idx]);
    });
  }

  _activateTool(tool) {
    if (this.lastSnap && (this.lastSnap.cooldownLeft > 0 || this.lastSnap.lockLeft > 0)) return;
    if (GLOBAL_TOOLS.includes(tool)) {
      this.net.send({ type: 'use_tool', tool, x: this.cam.x, y: this.cam.y });
    } else {
      this.armedTool = tool; // 进入瞄准，等待点击落点
    }
    this._refreshArmed();
  }

  _antAt(x, y) {
    if (!this.lastSnap) return null;
    let best = null, bd = 18 * 18;
    for (const a of this.lastSnap.ants) {
      if (a.marked || a.hidden) continue;
      const dx = a.x - x, dy = a.y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    return {
      x: (sx - this.canvas.width / 2) / z + this.cam.x,
      y: (sy - this.canvas.height / 2) / z + this.cam.y,
    };
  }

  _buildToolbar() {
    const bar = document.getElementById('toolbar');
    bar.innerHTML = '';
    bar.classList.remove('hidden');
    this.toolEls = {};
    this.toolKeys.forEach((key, i) => {
      const def = this.world.tools[key];
      const el = document.createElement('div');
      el.className = 'tool';
      el.innerHTML = `<div class="key">[${i + 1}]</div><div class="name">${def.name}</div><div class="cd">CD ${def.cd}s</div><div class="cover hidden"></div>`;
      el.addEventListener('click', () => this._activateTool(key));
      bar.appendChild(el);
      this.toolEls[key] = el;
    });
    document.getElementById('seekerHint').classList.remove('hidden');
  }

  _refreshArmed() {
    for (const key of this.toolKeys) this.toolEls[key].classList.toggle('active', key === this.armedTool);
  }

  // 每帧更新：放大镜缩放 + 工具冷却 UI，并返回渲染参数
  update(snap) {
    this.lastSnap = snap;
    // 默认 fit 全图；放大镜在 fit 基础上再放大
    const targetZoom = snap.magnify ? this.baseZoom * MAGNIFY_FACTOR : this.baseZoom;
    this.cam.zoom += (targetZoom - this.cam.zoom) * 0.15;
    this._clampCam();

    // 冷却 / 锁死遮罩
    const blocked = snap.cooldownLeft > 0 || snap.lockLeft > 0;
    const label = snap.lockLeft > 0 ? snap.lockLeft.toFixed(0) : snap.cooldownLeft.toFixed(0);
    for (const key of this.toolKeys) {
      const cover = this.toolEls[key].querySelector('.cover');
      if (blocked) { cover.classList.remove('hidden'); cover.textContent = label; }
      else cover.classList.add('hidden');
    }
    if (blocked) { this.armedTool = null; this._refreshArmed(); }

    const viewRadius = Math.min(this.canvas.width, this.canvas.height) * this.world.viewRatio;
    return {
      cam: this.cam,
      viewRadius,
      magnify: snap.magnify,
      thermal: snap.thermal,
      frozen: snap.frozen,
      panic: snap.panic,
    };
  }
}
