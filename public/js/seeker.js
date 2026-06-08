// 搜寻者控制器：镜头平移、视野半径、点击标记、工具使用与各工具独立冷却。
import { computeFitZoom } from './const.js';

/** 点击地图即放置的工具（非光束类） */
const PLACE_TOOLS = new Set(['fakeFood']);
/** 持续照射类工具：选中后需显示生效范围预览 */
const BEAM_TOOLS = new Set(['panic', 'sniff']);

export class SeekerController {
  constructor({ canvas, input, net, world }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.debugMode = !!world.debugMode;
    this.noToolCd = !!world.noToolCd;
    this.baseZoom = computeFitZoom(canvas, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.baseZoom };
    this.armedTool = null;        // 已选中待施放的瞄准类工具
    this.toolKeys = Object.keys(world.tools); // 工具顺序
    this.lastSnap = null;
    this._localMarkCdUntil = 0; // 误标后本地预判冷却，弥补快照延迟

    this.beamActive = false;
    this.beamTool = null;        // 当前照射中的光束工具：panic / sniff
    this._localBeam = null;
    this._beamSendTimer = 0;
    this._beamConfirmed = false; // 服务器已确认光束，避免首帧误判结束
    this._cursorSendTimer = 0;   // 鼠标位置同步限频

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
        if (PLACE_TOOLS.has(this.armedTool)) {
          this._placeTool(wp, this.armedTool);
        } else {
          this._startBeam(wp, this.armedTool);
        }
        return;
      }
      // 标记最近的蚂蚁 (需在合理半径内，避免误点)
      if (this._isMarkBlocked()) return;
      const ant = this._antAt(wp.x, wp.y);
      if (ant) this.net.send({ type: 'mark', antId: ant.id });
    });
  }

  /** 光束向目标点限速移动（像素/秒） */
  _moveBeamToward(target, dt) {
    const speed = this.world.tools[this.beamTool]?.beamSpeed ?? 280;
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

  /** 判断某工具是否处于独立 CD 中 */
  _isToolBlocked(tool, snap = this.lastSnap) {
    if (this.noToolCd || !snap) return false;
    return (snap.toolCooldownLeft?.[tool] ?? 0) > 0;
  }

  /** 用于标记判定的最新快照（优先无延迟版本） */
  _markSnap() {
    return this.net.latestSnap?.() ?? this.lastSnap;
  }

  /** 本地预判的标记冷却剩余 (秒) */
  _localMarkCdLeft() {
    return Math.max(0, (this._localMarkCdUntil - performance.now()) / 1000);
  }

  /** 标记功能是否在冷却中（无 CD 模式仅豁免工具 CD，标记冷却始终生效） */
  _isMarkBlocked(snap = this._markSnap()) {
    const serverCd = snap?.markCdLeft ?? 0;
    return Math.max(serverCd, this._localMarkCdLeft()) > 0;
  }

  /** 收到误标事件后立即锁定标记，避免等下一帧快照 */
  onMarkMiss() {
    const cd = this.world?.markCooldown ?? 3;
    this._localMarkCdUntil = Math.max(this._localMarkCdUntil, performance.now() + cd * 1000);
  }

  /** 点击放置类工具：在地图落点生成实体（如假食物） */
  _placeTool(wp, tool) {
    if (this._isToolBlocked(tool)) return;
    if (tool === 'fakeFood') {
      this.net.send({ type: 'place_fake_food', x: wp.x, y: wp.y });
    }
    this.armedTool = null;
    this._refreshArmed();
  }

  /** 持续照射类工具：点击地图开始，自动持续至时长结束 */
  _startBeam(wp, tool) {
    if (this.beamActive) return;
    if (this._isToolBlocked(tool)) return;
    this.beamActive = true;
    this.beamTool = tool;
    this._beamConfirmed = false;
    this._beamSendTimer = 0;
    this._localBeam = { x: wp.x, y: wp.y };
    this.net.send({ type: 'tool_beam', tool, x: wp.x, y: wp.y, active: true });
    this.armedTool = null;
    this._refreshArmed();
  }

  /** 光束工具在快照中对应的字段名 */
  _beamSnapKey(tool) {
    return tool === 'sniff' ? 'sniffBeam' : 'lightBeam';
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < this.toolKeys.length) this._activateTool(this.toolKeys[idx]);
    });
  }

  _activateTool(tool) {
    if (this._isToolBlocked(tool)) return;
    this.armedTool = tool; // 进入瞄准，等待点击落点
    this._refreshArmed();
  }

  _antAt(x, y) {
    if (!this.lastSnap) return null;
    let best = null, bd = 18 * 18;
    for (const a of this.lastSnap.ants) {
      if (a.marked || a.verified || a.hiding) continue;
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
      el.innerHTML = `<div class="tool-tip">${def.desc || ''}</div><div class="key">[${i + 1}]</div><div class="name">${def.name}</div><div class="cd">${this.noToolCd ? '无 CD' : `CD ${def.cd}s`}</div><div class="cover hidden"></div>`;
      el.addEventListener('click', () => this._activateTool(key));
      bar.appendChild(el);
      this.toolEls[key] = el;
    });
    document.getElementById('seekerHint').classList.remove('hidden');
  }

  _refreshArmed() {
    for (const key of this.toolKeys) this.toolEls[key].classList.toggle('active', key === this.armedTool);
    const aiming = !!this.armedTool && BEAM_TOOLS.has(this.armedTool) && !this.beamActive;
    this.canvas.classList.toggle('tool-aiming', aiming);
  }

  // 每帧更新：工具冷却 UI，并返回渲染参数
  update(snap, dt = 0) {
    this.lastSnap = snap;
    if (snap.noToolCd !== undefined) this.noToolCd = !!snap.noToolCd;
    for (const key of this.toolKeys) {
      const cdEl = this.toolEls[key].querySelector('.cd');
      const def = this.world.tools[key];
      cdEl.textContent = this.noToolCd ? '无 CD' : `CD ${def.cd}s`;
    }
    // 与服务器同步本地标记冷却
    if ((snap.markCdLeft ?? 0) > 0) {
      this._localMarkCdUntil = Math.max(
        this._localMarkCdUntil,
        performance.now() + snap.markCdLeft * 1000,
      );
    }
    this.cam.zoom = this.baseZoom;
    this._clampCam();

    // 照射中：限速跟随鼠标，限频 ~10Hz 同步服务器
    if (this.beamActive) {
      const tool = this.beamTool;
      const snapKey = this._beamSnapKey(tool);
      const target = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      this._moveBeamToward(target, dt);
      if (snap[snapKey]) this._beamConfirmed = true;
      // 先检测结束再同步，避免到期帧仍发送 active:true 导致服务器误重启
      if (this._beamConfirmed && !snap[snapKey]) {
        this.net.send({ type: 'tool_beam', tool, x: target.x, y: target.y, active: false });
        this.beamActive = false;
        this.beamTool = null;
        this._localBeam = null;
        this._beamConfirmed = false;
        this.armedTool = null;
        this._refreshArmed();
      } else {
        this._beamSendTimer -= dt;
        if (this._beamSendTimer <= 0) {
          this.net.send({ type: 'tool_beam', tool, x: target.x, y: target.y, active: true });
          this._beamSendTimer = 0.1;
        }
      }
    }

    // 各工具独立冷却遮罩（无 CD 模式无限制）
    for (const key of this.toolKeys) {
      const cover = this.toolEls[key].querySelector('.cover');
      const cdLeft = snap.toolCooldownLeft?.[key] ?? 0;
      const blocked = !this.noToolCd && cdLeft > 0;
      if (blocked) { cover.classList.remove('hidden'); cover.textContent = cdLeft.toFixed(0); }
      else cover.classList.add('hidden');
    }

    // 标记冷却期间鼠标显示不可点击样式
    const markBlocked = this._isMarkBlocked(snap) && !this.armedTool;
    this.canvas.classList.toggle('mark-cooldown', markBlocked);
    if (this.armedTool && this._isToolBlocked(this.armedTool, snap)) {
      this.armedTool = null;
      this._refreshArmed();
    }

    const toolDef = this.beamActive ? this.world.tools[this.beamTool] : null;
    const localBeam = this.beamActive && this._localBeam && toolDef
      ? { x: this._localBeam.x, y: this._localBeam.y, radius: toolDef.radius }
      : null;

    const lightBeam = this.beamActive && this.beamTool === 'panic'
      ? localBeam
      : snap.lightBeam;
    const sniffBeam = this.beamActive && this.beamTool === 'sniff'
      ? { ...localBeam, hiderDetected: !!snap.sniffBeam?.hiderDetected }
      : snap.sniffBeam;

    // 限频同步鼠标世界坐标，供隐藏者方显示大手
    this._cursorSendTimer -= dt;
    if (this._cursorSendTimer <= 0) {
      const wp = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      this.net.send({ type: 'cursor', x: wp.x, y: wp.y });
      this._cursorSendTimer = 0.1;
    }

    const viewRadius = Math.min(this.canvas.width, this.canvas.height) * this.world.viewRatio;

    // 光束工具选中待施放：在鼠标处显示生效范围预览
    let toolPreview = null;
    if (this.armedTool && BEAM_TOOLS.has(this.armedTool) && !this.beamActive) {
      const wp = this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      const def = this.world.tools[this.armedTool];
      toolPreview = {
        tool: this.armedTool,
        x: wp.x,
        y: wp.y,
        radius: def?.radius ?? (this.armedTool === 'sniff' ? 100 : 120),
      };
    }

    return {
      cam: this.cam,
      viewRadius,
      lightBeam,
      sniffBeam,
      toolPreview,
    };
  }
}
