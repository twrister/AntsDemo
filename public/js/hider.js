// 隐藏者控制器：移动输入、拾取引导、镜头跟随自身蚂蚁。
export class HiderController {
  constructor({ canvas, input, net, world, antId }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.antId = antId;
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: 1.5 };
    this._lastMove = { dx: 0, dy: 0 };
    this._lastSprint = false;
    this._sendTimer = 0;
    this._displayBeam = null; // 客户端预测的光束位置，消除 10Hz 快照跳变
    document.getElementById('hiderHint').classList.remove('hidden');
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
    // 镜头跟随自身蚂蚁
    const self = snap.ants.find(a => a.isSelf) || snap.ants.find(a => a.id === this.antId);
    if (self) {
      this.cam.x += (self.x - this.cam.x) * 0.15;
      this.cam.y += (self.y - this.cam.y) * 0.15;
    }

    // 移动向量：按住左键，朝鼠标方向移动
    const { dx, dy } = self
      ? this.input.hiderMoveVector(self.x, self.y, this.cam)
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

    return { cam: this.cam, frozen: snap.frozen, lightBeam: this._smoothLightBeam(snap, dt) };
  }
}
