// 技能 UI 抽象：桌面为底部工具栏，触屏为右下扇形轮盘 + 中心主按钮。
// 两套实现共享同一份数据（键名 / 名称 / 说明 / CD），控制器只调用 setActive / setCooldown。
//
// 轮盘布局：n 项沿 170°→305° 的弧线均匀分布，半径由 CSS 变量 --wheel-r 控制，
// 因此不同屏幕尺寸下只改半径，不需要 JS 参与定位。

/** 长按多久弹出说明气泡（ms） */
const TIP_HOLD_MS = 400;
/** 冷却文本刷新节流（ms） */
const CD_REFRESH_MS = 100;

export class ToolUI {
  /**
   * @param {{
   *   host: HTMLElement,         工具栏 / 轮盘挂载点
   *   touch: boolean,            是否触屏布局
   *   items: Array<{ key:string, name:string, desc?:string, glyph?:string }>,
   *   center?: { label:string, action:string, glyph?:string, hotkey?:string }|null,
   *   onActivate: (key:string) => void,
   *   onCenter: (action:string) => void,
   * }} opts
   */
  constructor({ host, touch, items, center = null, onActivate, onCenter }) {
    this.host = host;
    this.touch = touch;
    this.items = items;
    this.center = center;
    this.onActivate = onActivate;
    this.onCenter = onCenter;
    this.root = null;
    this.els = new Map();
    this.activeKey = null;
    this._lastCd = new Map();
    this._lastCdAt = 0;
    this._tipTimer = 0;
    this._tipEl = null;
    this._build();
  }

  _build() {
    const host = this.host;
    if (!host) return;
    host.innerHTML = '';
    // 轮盘容器常驻（可能只有中心主按钮），避免被误隐藏
    host.classList.toggle('hidden', false);
    host.classList.toggle('is-wheel', this.touch);
    host.classList.toggle('is-bar', !this.touch);
    this.els.clear();

    const frag = document.createDocumentFragment();
    const n = this.items.length;
    this.items.forEach((item, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = this.touch ? 'wheel-sector' : 'tool';
      el.dataset.key = item.key;
      // 触屏用 CSS 自定义属性定位到弧线上；桌面保持横排
      if (this.touch) {
        const angle = n <= 1 ? 210 : 170 + (135 * i) / Math.max(1, n - 1);
        el.style.setProperty('--a', `${angle}deg`);
      }
      el.innerHTML = this.touch
        ? `<span class="wheel-glyph">${item.glyph || '◈'}</span>`
          + `<span class="wheel-name">${item.name}</span>`
          + `<span class="cd-ring" aria-hidden="true"></span>`
          + `<span class="cd-text"></span>`
        : `<div class="tool-tip">${item.desc || ''}</div>`
          + `<div class="key">[${i + 1}]</div>`
          + `<div class="name">${item.name}</div>`
          + `<div class="cd">CD</div>`
          + `<div class="cover hidden"></div>`;

      el.addEventListener('click', (e) => {
        // 触屏模式不用 click：pointerdown 的 preventDefault 会抑制合成 click
        if (this.touch) return;
        e.preventDefault();
        e.stopPropagation();
        this.onActivate(item.key);
      });
      // 触屏：短按激活，长按展示说明（不依赖 hover）。
      // 注意不要在 pointerdown 里 preventDefault，否则合成 click 被吞掉。
      if (this.touch) {
        let downAt = 0;
        let longPressed = false;
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          downAt = performance.now();
          longPressed = false;
          clearTimeout(this._tipTimer);
          this._tipTimer = setTimeout(() => {
            longPressed = true;
            if (item.desc) this._showTip(el, item.desc);
          }, TIP_HOLD_MS);
        });
        el.addEventListener('pointerup', (e) => {
          e.stopPropagation();
          clearTimeout(this._tipTimer);
          this._hideTip();
          const quick = performance.now() - downAt < TIP_HOLD_MS;
          if (!longPressed && quick) this.onActivate(item.key);
        });
        el.addEventListener('pointercancel', () => {
          clearTimeout(this._tipTimer);
          this._hideTip();
        });
        el.addEventListener('pointerleave', () => {
          clearTimeout(this._tipTimer);
          this._hideTip();
        });
      }
      el.addEventListener('contextmenu', (e) => e.preventDefault());

      this.els.set(item.key, el);
      frag.appendChild(el);
    });

    if (this.touch && this.center) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'wheel-center';
      c.dataset.action = this.center.action;
      c.innerHTML = `<span class="center-glyph">${this.center.glyph || '◎'}</span>`
        + `<span class="center-label">${this.center.label}</span>`
        + `<span class="cd-ring" aria-hidden="true"></span>`
        + `<span class="cd-text"></span>`;
      c.addEventListener('click', (e) => {
        // 触屏同样不用 click（见扇区注释）
        if (this.touch) return;
        e.preventDefault();
        e.stopPropagation();
        this.onCenter(this.center.action);
      });
      if (this.touch) {
        c.addEventListener('pointerdown', (e) => e.stopPropagation());
        c.addEventListener('pointerup', (e) => {
          e.stopPropagation();
          if (!c.disabled) this.onCenter(this.center.action);
        });
      }
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      this.centerEl = c;
      frag.appendChild(c);
    }

    host.appendChild(frag);
    this.root = host;
  }

  /** 高亮当前待施放工具；null 表示无 */
  setActive(key) {
    if (this.activeKey === key) return;
    this.activeKey = key;
    for (const [k, el] of this.els) el.classList.toggle('active', k === key);
  }

  /**
   * 同步冷却（节流到 CD_REFRESH_MS，避免每帧写 DOM）。
   * @param {Record<string, number>} cdLeft 工具键 -> 剩余秒
   * @param {boolean} noCd 是否无 CD 模式
   * @param {number} now performance.now()
   */
  setCooldown(cdLeft, noCd, now = performance.now()) {
    if (now - this._lastCdAt < CD_REFRESH_MS) return;
    this._lastCdAt = now;
    for (const [key, el] of this.els) {
      const left = Math.max(0, cdLeft?.[key] ?? 0);
      if (this._lastCd.get(key) === left) continue;
      this._lastCd.set(key, left);
      if (this.touch) {
        const ring = el.querySelector('.cd-ring');
        const text = el.querySelector('.cd-text');
        const active = left > 0;
        ring.classList.toggle('show', active);
        text.textContent = active ? String(Math.ceil(left)) : '';
        // --cd: 1 → 0 的剩余比例，供 conic-gradient 画倒计时环
        el.style.setProperty('--cd', String(active ? Math.min(1, left / Math.max(1, this._cdTotal(key))) : 0));
        el.classList.toggle('cooling', active);
      } else {
        const cover = el.querySelector('.cover');
        const cdEl = el.querySelector('.cd');
        if (cdEl) cdEl.textContent = noCd ? '无 CD' : `CD ${this._cdTotal(key)}s`;
        if (left > 0) {
          cover.classList.remove('hidden');
          cover.textContent = left.toFixed(0);
        } else {
          cover.classList.add('hidden');
        }
      }
    }
  }

  /**
   * 中心按钮状态：隐藏者的突进按钮显示 CD 与可用态。
   * @param {number} cdLeft 剩余秒
   * @param {number} total 总 CD（秒）
   */
  setCenterCooldown(cdLeft, total) {
    const el = this.centerEl;
    if (!el) return;
    const left = Math.max(0, cdLeft);
    const ring = el.querySelector('.cd-ring');
    const text = el.querySelector('.cd-text');
    ring.classList.toggle('show', left > 0);
    text.textContent = left > 0 ? String(Math.ceil(left)) : '';
    el.style.setProperty('--cd', String(left > 0 ? Math.min(1, left / Math.max(1, total)) : 0));
    el.classList.toggle('cooling', left > 0);
  }

  /** 中心按钮文案 / 可用性（搜寻者据此在「标记」「取消」间切换） */
  setCenterLabel(label, glyph, disabled = false) {
    const el = this.centerEl;
    if (!el) return;
    const labelEl = el.querySelector('.center-label');
    const glyphEl = el.querySelector('.center-glyph');
    if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    if (glyphEl && glyph && glyphEl.textContent !== glyph) glyphEl.textContent = glyph;
    el.disabled = !!disabled;
  }

  /** 设置工具总 CD（用于环比例与桌面文案） */
  setCdTotals(totals) {
    this._cdTotals = { ...(this._cdTotals || {}), ...totals };
  }

  _cdTotal(key) {
    return this._cdTotals?.[key] ?? 30;
  }

  _showTip(anchor, desc) {
    this._hideTip();
    const tip = document.createElement('div');
    tip.className = 'wheel-tip';
    tip.textContent = desc;
    this.root.appendChild(tip);
    const hostRect = this.root.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    const x = aRect.left - hostRect.left + aRect.width / 2;
    const y = aRect.top - hostRect.top;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    this._tipEl = tip;
    navigator.vibrate?.(8);
  }

  _hideTip() {
    this._tipEl?.remove();
    this._tipEl = null;
  }

  /** 隐藏整套 UI（观战 / 结算时） */
  hide() {
    this._hideTip();
    if (this.root) this.root.classList.add('hidden');
    this._hidden = true;
  }

  /** 恢复显示（复活 / 新对局） */
  show() {
    if (!this.root) return;
    this.root.classList.remove('hidden');
    this._hidden = false;
  }

  destroy() {
    clearTimeout(this._tipTimer);
    this._hideTip();
    this.els.clear();
    if (this.root) this.root.innerHTML = '';
  }
}

/** 工具字形：轮盘上不与文字挤在一起的小图标 */
const TOOL_GLYPHS = {
  panic: '☀',
  sniff: '◎',
  fakeFood: '◍',
  pathEcho: '〰',
  dash: '⇥',
};

/**
 * 构建控制器需要的工具 UI。
 * @param {{
 *   touch: boolean,
 *   barHost?: HTMLElement,
 *   wheelHost?: HTMLElement,
 *   tools: Record<string, { name: string, desc?: string, cd?: number }>,
 *   center?: { label:string, action:string, glyph?:string }|null,
 *   onActivate: (key:string) => void,
 *   onCenter: (action:string) => void,
 * }} opts
 */
export function createToolUI({ touch, barHost, wheelHost, tools, center = null, onActivate, onCenter }) {
  const entries = Object.entries(tools || {});
  const items = entries.map(([key, def]) => ({
    key,
    name: def?.name || key,
    desc: def?.desc || '',
    glyph: TOOL_GLYPHS[key] || '◈',
  }));
  const totals = Object.fromEntries(entries.map(([key, def]) => [key, def?.cd ?? 0]));
  const host = touch ? wheelHost : barHost;
  const ui = new ToolUI({ host, touch, items, center, onActivate, onCenter });
  ui.setCdTotals(totals);
  // 触屏时隐藏桌面工具栏，反之亦然；轮盘即使没有扇区，只要有中心主按钮也要保留
  const hasSectors = items.length > 0;
  barHost?.classList.toggle('hidden', touch || !hasSectors);
  wheelHost?.classList.toggle('hidden', !touch || (!hasSectors && !center));
  return ui;
}
