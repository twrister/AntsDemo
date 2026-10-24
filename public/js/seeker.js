// 搜寻者控制器：镜头平移、视野半径、点击标记、工具使用与各工具独立冷却。
//
// 输入抽象：
// - 桌面：右键拖拽平移镜头、左键点击标记 / 施放工具、数字键 1-4 选工具。
// - 触屏：左侧摇杆移动准星、点按画布标记 / 施放、右下轮盘选工具、拖动导向光束。
import { computeFitZoom } from './const.js';
import { createToolUI } from './toolui.js';

/** 点击地图即放置的工具（非光束类） */
const PLACE_TOOLS = new Set(['fakeFood']);
/** 持续照射类工具：选中后需显示生效范围预览 */
const BEAM_TOOLS = new Set(['panic', 'sniff']);
/** 即时生效类工具：快捷键/工具栏点击后直接施放 */
const INSTANT_TOOLS = new Set(['pathEcho']);

/** 标记判定半径（世界像素）：手指比鼠标粗，触屏放大以便点中 */
const MARK_RADIUS_POINTER = 18;
const MARK_RADIUS_TOUCH = 30;

/** 触屏准星移动速度（世界像素 / 秒） */
const TOUCH_CROSSHAIR_SPEED = 520;
/** 准星显示半径（世界像素换算前的 CSS px） */
const CROSSHAIR_RADIUS_PX = 22;

export class SeekerController {
  constructor({ canvas, view, input, net, world }) {
    this.canvas = canvas;
    this.view = view;
    this.input = input;
    this.net = net;
    this.world = world;
    this.debugMode = !!world.debugMode;
    this.noToolCd = !!world.noToolCd;
    this.baseZoom = computeFitZoom(view, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.baseZoom };
    this.armedTool = null;        // 已选中待施放的瞄准类工具
    this.toolKeys = Object.keys(world.tools); // 工具顺序
    this.lastSnap = null;
    this._localMarkCdUntil = 0; // 误标后本地预判冷却，弥补快照延迟
    this._touchAim = null;      // 触屏最近一次落点（世界坐标），作为预览/光标锚点
    this._tapAt = 0;            // 触屏落点时间戳（渲染涟漪用）
    this._crosshair = null;     // 触屏准星位置（摇杆控制）
    this._beamDragging = false;
    this._activeKey = null;     // 当前高亮工具，避免每帧写 DOM
    this._centerLabel = null;   // 触屏中心按钮当前文案

    this.beamActive = false;
    this.beamTool = null;        // 当前照射中的光束工具：panic / sniff
    this._localBeam = null;
    this._beamSendTimer = 0;
    this._beamConfirmed = false; // 服务器已确认光束，避免首帧误判结束
    this._cursorSendTimer = 0;   // 鼠标位置同步限频

    this._hintEl = document.getElementById('seekerHint');
    this._setupDrag();
    this._buildToolbar();
    this._setupClick();
    this._setupTouch();
    this._setupHotkeys();
    this._setupResize();
  }

  /** 视口尺寸 / 方向变化时重算 fit 缩放，保持全图可见 */
  _setupResize() {
    this._unsubView = this.view.onChange(() => {
      this.baseZoom = computeFitZoom(this.view, this.world);
      this.cam.zoom = this.baseZoom;
      this._clampCam();
    });
  }

  /** 销毁控制器，退订视口监听，避免多局叠加 */
  destroy() {
    this._unsubView?.();
    this._unsubView = null;
    this.ui?.destroy();
    this.ui = null;
  }

  _setupDrag() {
    let dragging = false, last = null;
    this.input.on('down', (e, m) => {
      if (!this.input.isPointer) return;
      if (e.button === 2 || (!this.armedTool && e.shiftKey)) return;
      // 右键拖拽平移；左键留给标记/施放
      if (e.button === 1 || e.button === 2) { dragging = true; last = { x: m.x, y: m.y }; }
    });
    // 用右键拖拽平移更顺手
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.input.isPointer) return;
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
    const hw = this.view.w / this.cam.zoom / 2;
    const hh = this.view.h / this.cam.zoom / 2;
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
      this._handleMapPress(this.screenToWorld(m.x, m.y));
    });
  }

  /** 触屏：点按 = 标记 / 落点施放；拖拽 = 光束导向 */
  _setupTouch() {
    this.input.on('tap', (e, p) => {
      const wp = this.screenToWorld(p.x, p.y);
      this._setCrosshair(wp);
      this._tapAt = performance.now();
      this._handleMapPress(wp);
    });

    this.input.on('dragstart', (e, p) => {
      const wp = this.screenToWorld(p.x, p.y);
      this._setCrosshair(wp);
      this._tapAt = performance.now();
      // 已选瞄准类工具：拖动即起手，落点跟随手指
      if (!this.beamActive && this.armedTool && !PLACE_TOOLS.has(this.armedTool)) {
        this._startBeam(wp, this.armedTool);
      }
      if (this.beamActive) this._beamDragging = true;
    });

    this.input.on('dragmove', (e, p) => {
      if (!this.input.isTouch) return;
      this._setCrosshair(this.screenToWorld(p.x, p.y));
    });

    this.input.on('dragend', () => { this._beamDragging = false; });
  }

  /** 设置触屏准星（世界坐标，已钳制在地图内） */
  _setCrosshair(wp) {
    this._crosshair = {
      x: Math.max(0, Math.min(this.world.w, wp.x)),
      y: Math.max(0, Math.min(this.world.h, wp.y)),
    };
  }

  /** 处理一次「画布落点」：工具施放优先，其次标记蚂蚁 */
  _handleMapPress(wp) {
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

  /** 光束工具在快照中对应的数组字段名 */
  _beamSnapKey(tool) {
    return tool === 'sniff' ? 'sniffBeams' : 'lightBeams';
  }

  /** 合并本地光束与快照中其他搜寻者的光束 */
  _mergeBeams(snapKey, localBeam, snap, extra = {}) {
    const beams = [...(snap[snapKey] ?? [])];
    if (!localBeam) return beams;
    const idx = beams.findIndex((b) => b.self);
    const entry = { ...localBeam, self: true, ...extra };
    if (idx >= 0) beams[idx] = entry;
    else beams.push(entry);
    return beams;
  }

  _setupHotkeys() {
    window.addEventListener('keydown', (e) => {
      // 触屏设备外接键盘时同样可用
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < this.toolKeys.length) this._activateTool(this.toolKeys[idx]);
      if (e.code === 'Escape') this._cancelAim();
    });
  }

  /** 取消当前瞄准状态 */
  _cancelAim() {
    if (!this.armedTool) return;
    this.armedTool = null;
    this._refreshArmed();
  }

  _activateTool(tool) {
    if (this._isToolBlocked(tool)) return;
    if (INSTANT_TOOLS.has(tool)) {
      this._useInstantTool(tool);
      return;
    }
    // 再次点击同一工具 = 取消
    if (this.armedTool === tool) {
      this._cancelAim();
      return;
    }
    this.armedTool = tool; // 进入瞄准，等待点击落点
    this._refreshArmed();
  }

  /** 即时类工具：无需地图落点，直接请求服务器施放 */
  _useInstantTool(tool) {
    if (this._isToolBlocked(tool)) return;
    if (tool === 'pathEcho') {
      this.net.send({ type: 'use_path_echo' });
    }
    this.armedTool = null;
    this._refreshArmed();
  }

  /**
   * 当前瞄准点（世界坐标）：
   * - 触屏：优先手指落点；否则用摇杆准星；都没有时取镜头中心
   * - 桌面：鼠标位置
   */
  _aimWorld() {
    if (this.input.isTouch) {
      if (this._touchAim) return this._touchAim;
      if (this._crosshair) return this._crosshair;
      return { x: this.cam.x, y: this.cam.y };
    }
    return this.screenToWorld(this.input.mouse.x, this.input.mouse.y);
  }

  /** 世界坐标 → 屏幕坐标（CSS px） */
  worldToScreen(wx, wy) {
    const z = this.cam.zoom;
    return {
      x: (wx - this.cam.x) * z + this.view.w / 2,
      y: (wy - this.cam.y) * z + this.view.h / 2,
    };
  }

  _antAt(x, y) {
    if (!this.lastSnap) return null;
    const radius = this.input.isTouch ? MARK_RADIUS_TOUCH : MARK_RADIUS_POINTER;
    let best = null, bd = radius * radius;
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
      x: (sx - this.view.w / 2) / z + this.cam.x,
      y: (sy - this.view.h / 2) / z + this.cam.y,
    };
  }

  /** 构建工具 UI：桌面底部工具栏 / 触屏右下轮盘 */
  _buildToolbar() {
    const touch = this.input.isTouch;
    const barHost = document.getElementById('toolbar');
    const wheelHost = document.getElementById('skillWheel');
    this.ui = createToolUI({
      touch,
      barHost,
      wheelHost,
      tools: this.world.tools,
      center: touch
        ? { label: '标记', action: 'mark', glyph: '◉' }
        : null,
      onActivate: (key) => this._activateTool(key),
      onCenter: () => {
        // 中心按钮：有瞄准中的工具时取消，否则提示点按地图标记
        if (this.armedTool) this._cancelAim();
      },
    });
    this._hintEl?.classList.remove('hidden');
  }

  /** 同步「已选中工具」的高亮状态（仅在状态变化时调用，避免每帧写 DOM） */
  _refreshArmed() {
    const pathEchoLeft = this.lastSnap?.pathEchoLeft ?? 0;
    // 瞄准中的工具优先高亮；否则若残影仍在生效，高亮 pathEcho
    const nextActive = this.armedTool ?? (pathEchoLeft > 0 ? 'pathEcho' : null);
    if (nextActive !== this._activeKey) {
      this._activeKey = nextActive;
      this.ui?.setActive(nextActive);
    }
    const aiming = !!this.armedTool && BEAM_TOOLS.has(this.armedTool) && !this.beamActive;
    const aimingClass = 'tool-aiming';
    if (this.canvas.classList.contains(aimingClass) !== aiming) {
      this.canvas.classList.toggle(aimingClass, aiming);
    }
    // 触屏中心按钮：有瞄准中的工具时变为「取消」
    const wantLabel = this.armedTool ? '取消' : '标记';
    const wantGlyph = this.armedTool ? '✕' : '◉';
    if (this._centerLabel !== wantLabel) {
      this._centerLabel = wantLabel;
      this.ui?.setCenterLabel(wantLabel, wantGlyph);
    }
  }

  // 每帧更新：工具冷却 UI，并返回渲染参数
  update(snap, dt = 0) {
    this.lastSnap = snap;
    if (snap.noToolCd !== undefined) this.noToolCd = !!snap.noToolCd;

    // 触屏摇杆 = 瞄准准星（镜头恒为全图 fit，无法再平移）；
    // 望远镜视野下小幅平移用于微调，钳制后自动归位。
    if (this.input.isTouch) {
      const ax = this.input.axis.x;
      const ay = this.input.axis.y;
      // 准星在无输入时保持原位；有输入时沿轴移动并钳制在地图边界内
      if (ax || ay) {
        const base = this._crosshair ?? { x: this.cam.x, y: this.cam.y };
        this._setCrosshair({
          x: base.x + ax * TOUCH_CROSSHAIR_SPEED * dt,
          y: base.y + ay * TOUCH_CROSSHAIR_SPEED * dt,
        });
        // 摇杆推准星后，旧的指尖落点不再代表意图
        this._touchAim = null;
      } else if (!this._crosshair) {
        this._crosshair = { x: this.cam.x, y: this.cam.y };
      }
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

    // 照射中：限速跟随瞄准点，限频 ~10Hz 同步服务器
    if (this.beamActive) {
      const tool = this.beamTool;
      const snapKey = this._beamSnapKey(tool);
      const beams = snap[snapKey] ?? [];
      const target = this._aimWorld();
      this._moveBeamToward(target, dt);
      if (beams.some((b) => b.self)) this._beamConfirmed = true;
      // 先检测结束再同步，避免到期帧仍发送 active:true 导致服务器误重启
      if (this._beamConfirmed && !beams.some((b) => b.self)) {
        this.net.send({ type: 'tool_beam', tool, x: target.x, y: target.y, active: false });
        this.beamActive = false;
        this.beamTool = null;
        this._localBeam = null;
        this._beamConfirmed = false;
        this._beamDragging = false;
        this.armedTool = null;
        this._refreshArmed();
      } else if (this._beamSendTimer <= 0) {
        this.net.send({ type: 'tool_beam', tool, x: target.x, y: target.y, active: true });
        this._beamSendTimer = 0.1;
      }
    }

    // 各工具独立冷却（节流写 DOM，避免每帧重排）
    const cdLeft = {};
    for (const key of this.toolKeys) {
      const left = snap.toolCooldownLeft?.[key] ?? 0;
      const pathEchoLeft = key === 'pathEcho' ? (snap.pathEchoLeft ?? 0) : 0;
      cdLeft[key] = Math.max(left, pathEchoLeft);
    }
    this.ui?.setCooldown(cdLeft, this.noToolCd);
    this._beamSendTimer -= dt;
    this._refreshArmed();

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

    const selfSniff = (snap.sniffBeams ?? []).find((b) => b.self);
    const lightBeams = this.beamActive && this.beamTool === 'panic'
      ? this._mergeBeams('lightBeams', localBeam, snap)
      : (snap.lightBeams ?? []);
    const sniffBeams = this.beamActive && this.beamTool === 'sniff'
      ? this._mergeBeams('sniffBeams', localBeam, snap, { hiderDetected: !!selfSniff?.hiderDetected })
      : (snap.sniffBeams ?? []);

    // 限频同步瞄准点世界坐标，供隐藏者方显示大手
    this._cursorSendTimer -= dt;
    if (this._cursorSendTimer <= 0) {
      const wp = this._aimWorld();
      this.net.send({ type: 'cursor', x: wp.x, y: wp.y });
      this._cursorSendTimer = 0.1;
    }

    const viewRadius = Math.min(this.view.w, this.view.h) * this.world.viewRatio;

    // 光束工具选中待施放：在瞄准点处显示生效范围预览
    let toolPreview = null;
    if (this.armedTool && BEAM_TOOLS.has(this.armedTool) && !this.beamActive) {
      const wp = this._aimWorld();
      const def = this.world.tools[this.armedTool];
      toolPreview = {
        tool: this.armedTool,
        x: wp.x,
        y: wp.y,
        radius: def?.radius ?? (this.armedTool === 'sniff' ? 100 : 120),
      };
    }

    // 触屏准星（摇杆移动）叠加在画布上，作为瞄准点可视化
    const crosshair = this.input.isTouch && this._crosshair
      ? { ...this.worldToScreen(this._crosshair.x, this._crosshair.y), r: CROSSHAIR_RADIUS_PX }
      : null;

    return {
      cam: this.cam,
      viewRadius,
      lightBeams,
      sniffBeams,
      toolPreview,
      crosshair,
      // 触屏：点按落点的涟漪反馈
      tapMark: this.input.isTouch && this._touchAim && this._tapAt
        ? { x: this._touchAim.x, y: this._touchAim.y, t: this._tapAt }
        : null,
    };
  }
}
