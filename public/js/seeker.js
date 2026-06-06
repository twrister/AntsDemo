// 搜寻者控制器：镜头平移、视野半径、点击标记、工具使用与全局冷却。
const GLOBAL_TOOLS = ['freeze', 'thermal', 'magnify'];      // 立即生效(全局)
const AIMED_TOOLS = ['panic', 'bait', 'track'];             // 需选点

export class SeekerController {
  constructor({ canvas, input, net, world }) {
    this.canvas = canvas;
    this.input = input;
    this.net = net;
    this.world = world;
    this.cam = { x: world.w / 2, y: world.h / 2, zoom: 1 };
    this.armedTool = null;        // 已选中待施放的瞄准类工具
    this.toolKeys = Object.keys(world.tools); // 工具顺序
    this.lastSnap = null;

    this._setupDrag();
    this._buildToolbar();
    this._setupClick();
    this._setupHotkeys();
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

  _clampCam() {
    this.cam.x = Math.max(0, Math.min(this.world.w, this.cam.x));
    this.cam.y = Math.max(0, Math.min(this.world.h, this.cam.y));
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
    // 放大镜：临时放大到约 2.4 倍
    const targetZoom = snap.magnify ? 2.4 : 1;
    this.cam.zoom += (targetZoom - this.cam.zoom) * 0.15;

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
