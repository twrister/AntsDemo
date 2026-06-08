// 隐藏者控制器：移动输入、拾取引导、镜头跟随自身蚂蚁；淘汰后切全屏观战。
import { computeFitZoom, computeHiderViewport, computeHiderZoom } from './const.js';

export class HiderController {
  constructor({ canvas, input, net, world, antId }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.antId = antId;
    this.baseZoom = computeFitZoom(canvas, world);
    this.viewport = computeHiderViewport(canvas);
    this.hiderZoom = computeHiderZoom(canvas, world);
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: this.hiderZoom };
    this._lastMove = { dx: 0, dy: 0 };
    this._lastSprint = false;
    this._sendTimer = 0;
    this._displayBeam = null; // 客户端预测的光束位置，消除 10Hz 快照跳变
    this._spectator = false;
    this._hintEl = document.getElementById('hiderHint');
    this._hintEl.classList.remove('hidden');
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

  /** 生命归零后切换为搜寻者同款全图缩放观战 */
  _enterSpectator() {
    if (this._spectator) return;
    this._spectator = true;
    this.cam.zoom = this.baseZoom;
    this.cam.x = this.world.w / 2;
    this.cam.y = this.world.h / 2;
    this._hintEl.textContent = '你已淘汰，全屏观战中，等待对局结束';
    this.net.send({ type: 'move', dx: 0, dy: 0 });
    this.net.send({ type: 'sprint', active: false });
  }

  /** 与服务器同速追向目标点，每帧平滑渲染强光 */
  _smoothLightBeam(snap, dt) {
    const server = snap.lightBeam;
    if (!server) {
      this._displayBeam = null;
      return null;
    }
    const speed = this.world.tools.panic.beamSpeed ?? 280;
    const target = {
      x: server.targetX ?? server.x,
      y: server.targetY ?? server.y,
    };
    if (!this._displayBeam) {
      this._displayBeam = { x: server.x, y: server.y };
    }
    this._moveToward(this._displayBeam, target, speed * dt);
    // 与权威位置偏差过大时软校正，避免长期漂移
    const drift = Math.hypot(this._displayBeam.x - server.x, this._displayBeam.y - server.y);
    if (drift > 40) {
      this._displayBeam.x += (server.x - this._displayBeam.x) * 0.35;
      this._displayBeam.y += (server.y - this._displayBeam.y) * 0.35;
    }
    return { x: this._displayBeam.x, y: this._displayBeam.y, radius: server.radius };
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

  update(snap, dt) {
    const self = snap.ants.find(a => a.isSelf) || snap.ants.find(a => a.id === this.antId);

    // 淘汰后固定全图观战（与搜寻者默认缩放一致），不再接收操作
    if (snap.selfEliminated) {
      this._enterSpectator();
      return { cam: this.cam, lightBeam: this._smoothLightBeam(snap, dt), spectator: true, viewport: null };
    }

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
      lightBeam: this._smoothLightBeam(snap, dt),
      viewport: this.viewport,
    };
  }
}
