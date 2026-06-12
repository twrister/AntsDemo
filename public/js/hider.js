// 隐藏者控制器：移动输入、突进技能、拾取引导、镜头跟随自身蚂蚁；淘汰后切全屏观战。
import { computeFitZoom, computeHiderViewport, computeHiderZoom } from './const.js';

export class HiderController {
  constructor({ canvas, input, net, world, antId }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.antId = antId;
    this.noToolCd = !!world.noToolCd;
    this.toolKeys = Object.keys(world.hiderTools || {});
    this.baseZoom = computeFitZoom(canvas, world);
    this.viewport = computeHiderViewport(canvas);
    this.hiderZoom = computeHiderZoom(canvas, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.hiderZoom };
    this._lastMove = { dx: 0, dy: 0 };
    this._lastSprint = false;
    this._sendTimer = 0;
    this._displayBeam = null; // 客户端预测的光束位置，消除 10Hz 快照跳变
    this._spectator = false;
    this._dashKeyHeld = false;
    this._hintEl = document.getElementById('hiderHint');
    this._defaultHint = this._hintEl?.textContent ?? '';
    this._hintEl.classList.remove('hidden');
    this._buildToolbar();
    this._onResize = () => {
      this.baseZoom = computeFitZoom(this.canvas, this.world);
      this.viewport = computeHiderViewport(this.canvas);
      this.hiderZoom = computeHiderZoom(this.canvas, this.world);
      if (this._spectator) {
        this.cam.zoom = this.baseZoom;
        this.cam.x = this.world.w / 2;
        this.cam.y = this.world.h / 2;
        return;
      }
      this.cam.zoom = this.hiderZoom;
    };
    window.addEventListener('resize', this._onResize);
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

  /** 构建隐藏者工具栏（复用搜寻者 toolbar 样式） */
  _buildToolbar() {
    const bar = document.getElementById('toolbar');
    if (!bar || !this.toolKeys.length) return;
    bar.innerHTML = '';
    bar.classList.remove('hidden');
    this.toolEls = {};
    this.toolKeys.forEach((key, i) => {
      const def = this.world.hiderTools[key];
      const el = document.createElement('div');
      el.className = 'tool';
      el.innerHTML = `<div class="tool-tip">${def.desc || ''}</div><div class="key">[${i + 1}]</div><div class="name">${def.name}</div><div class="cd">${this.noToolCd ? '无 CD' : `CD ${def.cd}s`}</div><div class="cover hidden"></div>`;
      el.addEventListener('click', () => this._useDash());
      bar.appendChild(el);
      this.toolEls[key] = el;
    });
  }

  /** 同步工具 CD 遮罩与无 CD 模式文案 */
  _updateToolbar(snap) {
    if (!this.toolEls) return;
    if (snap.noToolCd !== undefined) this.noToolCd = !!snap.noToolCd;
    for (const key of this.toolKeys) {
      const el = this.toolEls[key];
      if (!el) continue;
      const cdEl = el.querySelector('.cd');
      const def = this.world.hiderTools[key];
      cdEl.textContent = this.noToolCd ? '无 CD' : `CD ${def.cd}s`;
      const cover = el.querySelector('.cover');
      const cdLeft = snap.hiderToolCooldownLeft?.[key] ?? 0;
      const blocked = !this.noToolCd && cdLeft > 0;
      if (blocked) {
        cover.classList.remove('hidden');
        cover.textContent = cdLeft.toFixed(0);
      } else {
        cover.classList.add('hidden');
      }
    }
  }

  /** 生命归零后切换为搜寻者同款全图缩放观战 */
  _enterSpectator() {
    if (this._spectator) return;
    this._spectator = true;
    this.cam.zoom = this.baseZoom;
    this.cam.x = this.world.w / 2;
    this.cam.y = this.world.h / 2;
    this._hintEl.textContent = '你已淘汰，全屏观战中，等待对局结束';
    document.getElementById('toolbar')?.classList.add('hidden');
    this.net.send({ type: 'move', dx: 0, dy: 0 });
    this.net.send({ type: 'sprint', active: false });
  }

  /** 新对局或复活后退出观战：恢复 4:3 视口、工具栏与默认提示 */
  _exitSpectator() {
    if (!this._spectator) return;
    this._spectator = false;
    this.cam.zoom = this.hiderZoom;
    if (this._hintEl) this._hintEl.textContent = this._defaultHint;
    document.getElementById('toolbar')?.classList.remove('hidden');
  }

  /** 销毁控制器，移除窗口监听，避免多局叠加 */
  destroy() {
    window.removeEventListener('resize', this._onResize);
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

  /** 限制镜头中心，避免 4:3 视口露出地图外空白 */
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

    // 上一局残留快照可能误触观战；新局存活时需恢复 4:3 视口与工具栏
    if (this._spectator) this._exitSpectator();

    this._handleDashKey();
    this._updateToolbar(snap);

    // 镜头跟随自身蚂蚁
    if (self) {
      this.cam.x += (self.x - this.cam.x) * 0.15;
      this.cam.y += (self.y - this.cam.y) * 0.15;
      this._clampCam();
    }

    // 移动向量：按住左键，朝鼠标方向移动
    const { dx, dy } = self
      ? this.input.hiderMoveVector(self.x, self.y, this.cam, this.viewport)
      : { dx: 0, dy: 0 };
    // 冲刺：按住空格触发加速倍率
    const sprint = !!this.input.keys['Space'];

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
