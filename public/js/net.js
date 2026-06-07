// WebSocket 客户端：连接、收发、快照缓冲与帧间插值 (GDD 7 节)。
const INTERP_DELAY = 120; // ms，渲染落后于最新快照以平滑插值

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};       // type -> callback
    this.buffer = [];         // 快照缓冲 [{ t, snap }]
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'snapshot') {
        this.buffer.push({ t: performance.now(), snap: msg.snap });
        if (this.buffer.length > 30) this.buffer.shift();
        if (msg.events && msg.events.length && this.handlers.events) this.handlers.events(msg.events);
      }
      const h = this.handlers[msg.type];
      if (h) h(msg);
    };
    return new Promise((res) => { this.ws.onopen = res; });
  }

  on(type, cb) { this.handlers[type] = cb; }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  /** 最新快照（无插值延迟，用于标记冷却等即时判定） */
  latestSnap() {
    if (this.buffer.length === 0) return null;
    return this.buffer[this.buffer.length - 1].snap;
  }

  // 取出用于渲染的插值快照
  interpolated() {
    if (this.buffer.length === 0) return null;
    const renderTime = performance.now() - INTERP_DELAY;
    // 找到包含 renderTime 的两帧
    let a = null, b = null;
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].t <= renderTime && this.buffer[i + 1].t >= renderTime) {
        a = this.buffer[i]; b = this.buffer[i + 1]; break;
      }
    }
    if (!a) { return this.buffer[this.buffer.length - 1].snap; }
    const f = (renderTime - a.t) / (b.t - a.t || 1);
    return this._lerpSnap(a.snap, b.snap, f);
  }

  _lerpSnap(s0, s1, f) {
    const map1 = new Map(s1.ants.map(a => [a.id, a]));
    const ants = s0.ants.map(a0 => {
      const a1 = map1.get(a0.id) || a0;
      return {
        ...a1,
        x: a0.x + (a1.x - a0.x) * f,
        y: a0.y + (a1.y - a0.y) * f,
        angle: a0.angle + angleDiff(a0.angle, a1.angle) * f,
      };
    });
    const lightBeam = this._lerpBeam(s0.lightBeam, s1.lightBeam, f);
    const sniffBeam = this._lerpSniffBeam(s0.sniffBeam, s1.sniffBeam, f);
    const seekerCursor = this._lerpPoint(s0.seekerCursor, s1.seekerCursor, f);
    return { ...s1, ants, lightBeam, sniffBeam, seekerCursor };
  }

  /** 插值二维坐标点 */
  _lerpPoint(p0, p1, f) {
    if (p0 && p1) {
      return {
        x: p0.x + (p1.x - p0.x) * f,
        y: p0.y + (p1.y - p0.y) * f,
      };
    }
    return p1 || p0 || null;
  }

  /** 插值光束位置（强光照射 / 嗅探圈） */
  _lerpBeam(b0, b1, f) {
    if (b0 && b1) {
      return {
        x: b0.x + (b1.x - b0.x) * f,
        y: b0.y + (b1.y - b0.y) * f,
        targetX: (b0.targetX ?? b0.x) + ((b1.targetX ?? b1.x) - (b0.targetX ?? b0.x)) * f,
        targetY: (b0.targetY ?? b0.y) + ((b1.targetY ?? b1.y) - (b0.targetY ?? b0.y)) * f,
        radius: b1.radius,
      };
    }
    return b1 || null;
  }

  /** 插值嗅探圈位置，警告状态取最新帧 */
  _lerpSniffBeam(b0, b1, f) {
    const beam = this._lerpBeam(b0, b1, f);
    if (!beam) return null;
    // 相邻快照任一为 true 即保持红色，避免插值帧闪烁
    return { ...beam, hiderDetected: !!(b0?.hiderDetected || b1?.hiderDetected) };
  }
}

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
