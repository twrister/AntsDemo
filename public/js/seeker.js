// 搜寻者控制器：镜头平移、视野半径、点击标记、工具使用与全局冷却。
import { computeFitZoom } from './const.js';

const GLOBAL_TOOLS = ['freeze'];  // 立即生效(全局)
const BEAM_TOOLS = ['panic'];   // 点击左键开始，自动持续照射

export class SeekerController {
  constructor({ canvas, input, net, world }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.debugMode = !!world.debugMode;
    this.baseZoom = computeFitZoom(canvas, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.baseZoom };
    this.armedTool = null;        // 已选中待施放的瞄准类工具
    this.toolKeys = Object.keys(world.tools); // 工具顺序
    this.lastSnap = null;

    this.beamActive = false;
    this._localBeam = null;
    this._beamSendTimer = 0;
    this._beamConfirmed = false; // 服务器已确认光束，避免首帧误判结束

    this._setupDrag();
    this._buildToolbar();
    this._setupClick();
    this._setupHotkeys();
    this._setupResize();
  }

  /** 窗口尺寸变化时重算 fit 缩放，保持全图可见 */
  _setupResize() {
    window.addEventListener('resize', () => {
      this.baseZoom = computeFitZoom(this.canvas, this.world);
      this.cam.zoom = this.baseZoom;
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
        if (BEAM_TOOLS.includes(this.armedTool)) {
          this._startBeam(wp);
          return;
        }
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

  /** 强光光束向目标点限速移动（像素/秒） */
  _moveBeamToward(target, dt) {
    const speed = this.world.tools.panic.beamSpeed ?? 280;
    const maxMove = speed * dt;
    const dx = target.x - this._localBeam.x;
    const dy = target.y - this._localBeam.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxMove || dist === 0) {
      this._localBeam.x = target.x;
      this._localBeam.y = target.y;
      return;
    }
    this._localBeam.x += (dx / dist) * maxMove;
    this._localBeam.y += (dy / dist) * maxMove;
  }

  /** 强光照射：点击地图开始，自动持续至时长结束 */
  _startBeam(wp) {
    if (this.beamActive) return;
    if (!this.debugMode && this.lastSnap && (this.lastSnap.cooldownLeft > 0 || this.lastSnap.lockLeft > 0)) return;
    this.beamActive = true;
    this._beamConfirmed = false;
    this._beamSendTimer = 0;
    this._localBeam = { x: wp.x, y: wp.y };
    this.net.send({ type: 'tool_beam', tool: 'panic', x: wp.x, y: wp.y, active: true });
    this.armedTool = null;
    this._refreshArmed();
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < this.toolKeys.length) this._activateTool(this.toolKeys[idx]);
    });
  }

  _activateTool(tool) {
    if (!this.debugMode && this.lastSnap && (this.lastSnap.cooldownLeft > 0 || this.lastSnap.lockLeft > 0)) return;
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
      if (a.marked) continue;
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
      el.innerHTML = `<div class="tool-tip">${def.desc || ''}</div><div class="key">[${i + 1}]</div><div class="name">${def.name}</div><div class="cd">${this.debugMode ? '无 CD' : `CD ${def.cd}s`}</div><div class="cover hidden"></div>`;
      el.addEventListener('click', () => this._activateTool(key));
      bar.appendChild(el);
      this.toolEls[key] = el;
    });
    document.getElementById('seekerHint').classList.remove('hidden');
  }

  _refreshArmed() {
    for (const key of this.toolKeys) this.toolEls[key].classList.toggle('active', key === this.armedTool);
  }

  // 每帧更新：工具冷却 UI，并返回渲染参数
  update(snap, dt = 0) {
    this.lastSnap = snap;
    this.cam.zoom = this.baseZoom;
    this._clampCam();

    // 照射中：限速跟随鼠标，限频 ~10Hz 同步服务器
    if (this.beamActive) {
      const target = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      this._moveBeamToward(target, dt);
      this._beamSendTimer -= dt;
      if (this._beamSendTimer <= 0) {
        this.net.send({ type: 'tool_beam', tool: 'panic', x: target.x, y: target.y, active: true });
        this._beamSendTimer = 0.1;
      }
      if (snap.lightBeam) this._beamConfirmed = true;
      // 服务器时长耗尽后自动结束（需先收到确认，避免首帧误判）
      if (this._beamConfirmed && !snap.lightBeam) {
        this.beamActive = false;
        this._localBeam = null;
        this._beamConfirmed = false;
        this.armedTool = null;
        this._refreshArmed();
      }
    }

    // 冷却 / 锁死遮罩（调试模式无限制）
    const blocked = !this.debugMode && (snap.cooldownLeft > 0 || snap.lockLeft > 0);
    const label = snap.lockLeft > 0 ? snap.lockLeft.toFixed(0) : snap.cooldownLeft.toFixed(0);
    for (const key of this.toolKeys) {
      const cover = this.toolEls[key].querySelector('.cover');
      if (blocked) { cover.classList.remove('hidden'); cover.textContent = label; }
      else cover.classList.add('hidden');
    }
    if (blocked) {
      this.armedTool = null;
      this.beamActive = false;
      this._localBeam = null;
      this._refreshArmed();
    }

    const panicDef = this.world.tools.panic;
    const lightBeam = this.beamActive && this._localBeam
      ? { x: this._localBeam.x, y: this._localBeam.y, radius: panicDef.radius || 120 }
      : snap.lightBeam;

    const viewRadius = Math.min(this.canvas.width, this.canvas.height) * this.world.viewRatio;
    return {
      cam: this.cam,
      viewRadius,
      frozen: snap.frozen,
      lightBeam,
    };
  }
}
