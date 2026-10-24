// 隐藏者控制器：移动输入、突进技能、拾取引导、镜头跟随自身蚂蚁；淘汰后切全屏观战。
//
// 输入抽象：
// - 桌面：按住左键朝鼠标方向移动、空格冲刺、数字键 1 / 工具栏突进。
// - 触屏：左摇杆移动、右侧「冲刺」切换加速、轮盘中心突进。
import { computeFitZoom, computeHiderViewport, computeHiderZoom, ROLE } from './const.js';
import { TOUCH_HINTS, POINTER_HINTS } from './view.js';
import { createToolUI } from './toolui.js';

export class HiderController {
  constructor({ canvas, view, input, net, world, antId, touch = null }) {
    this.canvas = canvas;
    this.view = view;
    this.input = input;
    this.net = net;
    this.world = world;
    this.antId = antId;
    this.touch = touch;
    this.noToolCd = !!world.noToolCd;
    this.toolKeys = Object.keys(world.hiderTools || {});
    this.baseZoom = computeFitZoom(view, world);
    this.viewport = computeHiderViewport(view);
    this.hiderZoom = computeHiderZoom(view, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.hiderZoom };
    this._lastMove = { dx: 0, dy: 0 };
    this._lastSprint = false;
    this._sendTimer = 0;
    this._displayBeam = null; // 客户端预测的光束位置，消除 10Hz 快照跳变
    this._spectator = false;
    this._dashKeyHeld = false;
    this._hintEl = document.getElementById('hiderHint');
    /** 默认操作提示（随输入模式变化，观战结束后用于恢复） */
    this._defaultHint = (this.input.isTouch ? TOUCH_HINTS : POINTER_HINTS)[ROLE.HIDER]
      ?? this._hintEl?.textContent ?? '';
    this._hintEl?.classList.remove('hidden');
    this._buildToolbar();
    this._unsubView = view.onChange(() => this._onViewportChange());
  }

  /** 视口尺寸 / 方向 / 安全区变化：重算缩放与隐藏者视口 */
  _onViewportChange() {
    this.baseZoom = computeFitZoom(this.view, this.world);
    this.viewport = computeHiderViewport(this.view);
    this.hiderZoom = computeHiderZoom(this.view, this.world);
    if (this._spectator) {
      this.cam.zoom = this.baseZoom;
      this.cam.x = this.world.w / 2;
      this.cam.y = this.world.h / 2;
      return;
    }
    this.cam.zoom = this.hiderZoom;
    this._clampCam();
  }

  /** 销毁控制器，退订视口监听，避免多局叠加 */
  destroy() {
    this._unsubView?.();
    this._unsubView = null;
    this.ui?.destroy();
    this.ui = null;
  }

  /** 突进技能是否在冷却中 */
  _isDashBlocked(snap = this.lastSnap) {
    if (this.noToolCd || !snap) return false;
    return (snap.hiderToolCooldownLeft?.dash ?? 0) > 0;
  }

  /** 触发突进技能（服务器权威位移） */
  _useDash() {
    if (this._spectator || this._isDashBlocked()) return;
    this.net.send({ type: 'hider_dash' });
  }

  /** 构建隐藏者工具 UI：桌面底部工具栏 / 触屏轮盘中心主技能 */
  _buildToolbar() {
    const barHost = document.getElementById('toolbar');
    const wheelHost = document.getElementById('skillWheel');
    const touch = this.input.isTouch;
    if (touch) {
      // 触屏：突进占用轮盘中心（唯一技能），不额外占扇区
      this.ui = createToolUI({
        touch: true,
        barHost,
        wheelHost,
        tools: {},
        center: { label: '突进', action: 'dash', glyph: '⇥' },
        onActivate: () => this._useDash(),
        onCenter: () => this._useDash(),
      });
    } else {
      this.ui = createToolUI({
        touch: false,
        barHost,
        wheelHost,
        tools: this.world.hiderTools || {},
        onActivate: () => this._useDash(),
        onCenter: () => {},
      });
    }
  }

  /** 同步工具 CD 与无 CD 模式文案 */
  _updateToolbar(snap) {
    if (!this.ui) return;
    if (snap.noToolCd !== undefined) this.noToolCd = !!snap.noToolCd;
    const cdLeft = snap.hiderToolCooldownLeft ?? {};
    this.ui.setCooldown(cdLeft, this.noToolCd);
    const total = this.world.hiderTools?.dash?.cd ?? 10;
    this.ui.setCenterCooldown(cdLeft.dash ?? 0, total);
  }

  /** 生命归零后切换为搜寻者同款全图缩放观战 */
  _enterSpectator() {
    if (this._spectator) return;
    this._spectator = true;
    this.cam.zoom = this.baseZoom;
    this.cam.x = this.world.w / 2;
    this.cam.y = this.world.h / 2;
    if (this._hintEl) this._hintEl.textContent = '你已淘汰，全屏观战中，等待对局结束';
    this.ui?.hide();
    // 观战期间收起触屏控件，避免误操作
    this.touch?.setRole(null);
    this.net.send({ type: 'move', dx: 0, dy: 0 });
    this.net.send({ type: 'sprint', active: false });
  }

  /** 新对局或复活后退出观战：恢复隐藏者视口、工具 UI 与默认提示 */
  _exitSpectator() {
    if (!this._spectator) return;
    this._spectator = false;
    this.cam.zoom = this.hiderZoom;
    if (this._hintEl) this._hintEl.textContent = this._defaultHint;
    this.ui?.show();
    this.touch?.setRole(ROLE.HIDER);
  }

  /** 与服务器同速追向目标点，每帧平滑渲染所有搜寻者强光束 */
  _smoothLightBeams(snap, dt) {
    const servers = snap.lightBeams ?? [];
    if (!this._displayBeams) this._displayBeams = new Map();
    if (!servers.length) {
      this._displayBeams.clear();
      return [];
    }
    const speed = this.world.tools?.panic?.beamSpeed ?? 280;
    const activeIds = new Set();
    const result = [];
    for (const server of servers) {
      const id = server.seekerId ?? 'default';
      activeIds.add(id);
      const target = {
        x: server.targetX ?? server.x,
        y: server.targetY ?? server.y,
      };
      let display = this._displayBeams.get(id);
      if (!display) {
        display = { x: server.x, y: server.y };
        this._displayBeams.set(id, display);
      }
      this._moveToward(display, target, speed * dt);
      const drift = Math.hypot(display.x - server.x, display.y - server.y);
      if (drift > 40) {
        display.x += (server.x - display.x) * 0.35;
        display.y += (server.y - display.y) * 0.35;
      }
      result.push({ x: display.x, y: display.y, radius: server.radius, seekerId: id });
    }
    for (const id of this._displayBeams.keys()) {
      if (!activeIds.has(id)) this._displayBeams.delete(id);
    }
    return result;
  }

  /** 限制镜头中心，避免视口露出地图外空白 */
  _clampCam() {
    const halfW = this.viewport.width / (2 * this.cam.zoom);
    const halfH = this.viewport.height / (2 * this.cam.zoom);
    this.cam.x = this._clampAxis(this.cam.x, this.world.w, halfW);
    this.cam.y = this._clampAxis(this.cam.y, this.world.h, halfH);
  }

  _clampAxis(pos, size, halfVisible) {
    if (halfVisible >= size / 2) return size / 2;
    return Math.max(halfVisible, Math.min(size - halfVisible, pos));
  }

  /** 限速移向目标点（像素/秒） */
  _moveToward(pos, target, maxMove) {
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxMove || dist === 0) {
      pos.x = target.x;
      pos.y = target.y;
      return;
    }
    pos.x += (dx / dist) * maxMove;
    pos.y += (dy / dist) * maxMove;
  }

  /** 数字键 1 触发突进（仅按下沿触发，避免连发） */
  _handleDashKey() {
    const down = !!this.input.keys['Digit1'];
    if (down && !this._dashKeyHeld) this._useDash();
    this._dashKeyHeld = down;
  }

  update(snap, dt) {
    this.lastSnap = snap;
    const self = snap.ants.find(a => a.isSelf) || snap.ants.find(a => a.id === this.antId);

    // 淘汰后固定全图观战（与搜寻者默认缩放一致），不再接收操作
    if (snap.selfEliminated) {
      this._enterSpectator();
      return {
        cam: this.cam,
        lightBeams: this._smoothLightBeams(snap, dt),
        sniffBeams: snap.sniffBeams ?? [],
        spectator: true,
        viewport: null,
      };
    }

    // 上一局残留快照可能误触观战；新局存活时需恢复视口与工具 UI
    if (this._spectator) this._exitSpectator();

    this._handleDashKey();
    this._updateToolbar(snap);

    // 镜头跟随自身蚂蚁
    if (self) {
      this.cam.x += (self.x - this.cam.x) * 0.15;
      this.cam.y += (self.y - this.cam.y) * 0.15;
      this._clampCam();
    }

    // 移动向量：触屏摇杆轴 / 桌面按住左键朝鼠标
    const { dx, dy } = self
      ? this.input.moveVector({ antX: self.x, antY: self.y, cam: this.cam, viewport: this.viewport })
      : { dx: 0, dy: 0 };
    // 冲刺：触屏为切换钮，桌面为按住空格
    const sprint = this.input.sprinting;

    // 限频发送 (~20Hz) 或在状态变化时立即发送
    this._sendTimer -= dt;
    const moveChanged = dx !== this._lastMove.dx || dy !== this._lastMove.dy;
    if (moveChanged || this._sendTimer <= 0) {
      this.net.send({ type: 'move', dx, dy });
      this._lastMove = { dx, dy };
      this._sendTimer = 0.05;
    }
    if (sprint !== this._lastSprint) {
      this.net.send({ type: 'sprint', active: sprint });
      this._lastSprint = sprint;
    }

    return {
      cam: this.cam,
      lightBeams: this._smoothLightBeams(snap, dt),
      sniffBeams: snap.sniffBeams ?? [],
      viewport: this.viewport,
    };
  }
}
