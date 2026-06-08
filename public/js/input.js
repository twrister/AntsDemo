// 底层输入：键盘状态 + 鼠标事件订阅。
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.mouse = { x: 0, y: 0, down: false, leftDown: false };
    this._mouseHandlers = { down: [], up: [], move: [], click: [] };

    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouse.leftDown = true;
      this.mouse.down = true; this._set(e); this._emit('down', e);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.leftDown = false;
      this.mouse.down = false; this._emit('up', e);
    });
    canvas.addEventListener('mousemove', (e) => { this._set(e); this._emit('move', e); });
    canvas.addEventListener('click', (e) => { this._set(e); this._emit('click', e); });
  }

  _set(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;
  }
  _emit(type, e) { for (const h of this._mouseHandlers[type]) h(e, this.mouse); }
  on(type, cb) { this._mouseHandlers[type].push(cb); }

  /**
   * 隐藏者移动方向：按住左键时，从蚂蚁位置指向鼠标（世界坐标）。
   * @param {number} antX 蚂蚁世界 X
   * @param {number} antY 蚂蚁世界 Y
   * @param {{ x: number, y: number, zoom?: number }} cam 镜头
   * @param {{ width: number, height: number, offsetX: number, offsetY: number }|null} viewport 4:3 视口
   */
  hiderMoveVector(antX, antY, cam, viewport = null) {
    if (!this.mouse.leftDown) return { dx: 0, dy: 0 };
    const zoom = cam.zoom || 1;
    const cx = viewport ? viewport.offsetX + viewport.width / 2 : this.canvas.width / 2;
    const cy = viewport ? viewport.offsetY + viewport.height / 2 : this.canvas.height / 2;
    const wx = cam.x + (this.mouse.x - cx) / zoom;
    const wy = cam.y + (this.mouse.y - cy) / zoom;
    const dx = wx - antX;
    const dy = wy - antY;
    // 鼠标贴近蚂蚁时视为静止，便于拾取
    if (Math.hypot(dx, dy) < 4) return { dx: 0, dy: 0 };
    return { dx, dy };
  }
}
