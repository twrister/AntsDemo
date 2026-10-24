// 草甸蚁巢场景：把参考场景（AntsScene_GPT 微观蚁巢）的地形与道具以俯视 2D 手绘风格烘焙到离屏画布。
//
// 设计要点：
// - 纯视觉层：不参与任何判定，巢穴 / 躲藏点 / 食物位置全部来自服务端。
// - 种子由躲藏点坐标哈希得到，同局所有客户端看到的装饰完全一致；角色只影响躲藏点外观。
// - 静态内容每局只烘焙一次，渲染时按镜头裁剪 drawImage；每帧动画（涟漪、水滴闪光）极轻量。
// - 可读性优先：地面对比度克制，大型道具远离巢穴与躲藏点，避免干扰对蚂蚁特征的辨认。
import { ROLE, GROUND_FILL_DEFAULT } from './const.js';

/** 世界边缘外留白（世界像素），用于绘制「盆景切面」侧壁与投影 */
export const SCENE_MARGIN = 32;
/** 侧壁厚度（世界像素） */
const WALL = 12;
/** 占用掩码格元边长（世界像素） */
const MASK_CELL = 10;
/** 缓存画布最大边长（物理像素），防止移动端显存爆掉 */
const MAX_CACHE_SIDE = 4096;

/** 掩码位：用于草叶 / 道具避让 */
const M_TRAIL = 1, M_NEST = 2, M_POND = 4, M_PATCH = 8, M_SPOT = 16, M_PROP = 32, M_KEEP = 64;

/** 参考场景调色板（terrain.ts / props.ts） */
const PAL = {
  greens: ['#91af66', '#98b56e', '#9db973', '#a1ba78', '#95b16b'],
  soil: '#c7aa76',
  gravel: '#b4b499',
  rock: '#a8ac99',
  leafFloor: '#aaad65',
  pondFloor: '#8fada0',
  water: '#80beb3',
  wall: '#b8a074',
  wallDark: '#a28b65',
  leaf: '#6d9b3d',
  leafLight: '#8cb94d',
  vein: '#bbcf6b',
  stem: '#719448',
  cream: '#ece1b8',
  seed: '#faf5df',
  red: '#c97f54',
  berry: '#b95e52',
  gold: '#c4a04f',
  brown: '#9a7548',
  sand: '#c6a06b',
  grain: '#d5b77f',
  grainDark: '#a48356',
  hole: '#302b1b',
  throat: '#654b30',
};

/** 画布文字字体（与 UI 一致） */
export const UI_FONT = '"Noto Sans SC", "Microsoft YaHei", sans-serif';

/** 参考场景同款 mulberry32 种子随机数 */
export function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由躲藏点坐标得到本局种子（FNV-1a） */
function seedFromWorld(world) {
  let h = 2166136261;
  const feed = (v) => { h = Math.imul(h ^ (Math.round(v) & 0xffff), 16777619); };
  feed(world.w); feed(world.h);
  for (const s of world.hidingSpots ?? []) { feed(s.x); feed(s.y); feed(s.radius ?? 0); }
  return h >>> 0;
}

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [148, 177, 105];
}
function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function rgba(c, a = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

/** Catmull-Rom 折线 → 三次贝塞尔路径；同时返回采样点供掩码使用 */
function catmullPath(path, pts, samples) {
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    if (samples) {
      const n = Math.max(4, Math.ceil(dist(p1[0], p1[1], p2[0], p2[1]) / 8));
      for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        samples.push([
          u * u * u * p1[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2[0],
          u * u * u * p1[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2[1],
        ]);
      }
    }
  }
}

/** 参考场景三叶草心形小叶（叶尖沿 +y，长度约 0.83） */
function heartLeaf(ctx, s) {
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-0.12 * s, 0.16 * s, -0.49 * s, 0.32 * s, -0.39 * s, 0.61 * s);
  ctx.bezierCurveTo(-0.31 * s, 0.83 * s, -0.05 * s, 0.78 * s, 0, 0.62 * s);
  ctx.bezierCurveTo(0.06 * s, 0.79 * s, 0.32 * s, 0.83 * s, 0.39 * s, 0.61 * s);
  ctx.bezierCurveTo(0.49 * s, 0.32 * s, 0.12 * s, 0.16 * s, 0, 0);
}

/** 柳叶形叶片（中心在原点，沿 y 轴，长 len 宽 wid） */
function leafShape(ctx, len, wid) {
  ctx.moveTo(0, -len / 2);
  ctx.bezierCurveTo(wid * 0.7, -len * 0.25, wid * 0.6, len * 0.25, 0, len / 2);
  ctx.bezierCurveTo(-wid * 0.6, len * 0.25, -wid * 0.7, -len * 0.25, 0, -len / 2);
}

/** 世界坐标占用掩码 */
class Mask {
  constructor(w, h) {
    this.cols = Math.ceil(w / MASK_CELL);
    this.rows = Math.ceil(h / MASK_CELL);
    this.bits = new Uint8Array(this.cols * this.rows);
  }
  at(x, y) {
    const c = Math.floor(x / MASK_CELL), r = Math.floor(y / MASK_CELL);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 0xff;
    return this.bits[r * this.cols + c];
  }
  circle(x, y, rad, bit, sy = 1) {
    const c0 = Math.max(0, Math.floor((x - rad) / MASK_CELL)), c1 = Math.min(this.cols - 1, Math.floor((x + rad) / MASK_CELL));
    const ry = rad * sy;
    const r0 = Math.max(0, Math.floor((y - ry) / MASK_CELL)), r1 = Math.min(this.rows - 1, Math.floor((y + ry) / MASK_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = (c + 0.5) * MASK_CELL - x, dy = ((r + 0.5) * MASK_CELL - y) / sy;
        if (dx * dx + dy * dy <= rad * rad) this.bits[r * this.cols + c] |= bit;
      }
    }
  }
  polyline(pts, rad, bit) {
    for (const p of pts) this.circle(p[0], p[1], rad, bit);
  }
}

/**
 * 草甸场景：每局 build 一次，渲染器按镜头裁剪贴图。
 */
export class MeadowScene {
  constructor() {
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    this.scale = 1;
    this.margin = SCENE_MARGIN;
    this.world = null;
    this.ready = false;
    this._key = '';
    this._opts = null;
    this._nest = null;
    this._nestSprites = new Map();
    this._pond = null;
    this._droplets = [];
  }

  /** 巢穴位置估计：开局 world 不含巢穴，与服务端 CONFIG.NEST 默认值一致，快照到达后再校正 */
  static defaultNest(world) {
    return { x: world.w * 0.5, y: world.h * 0.12 + 50, radius: 80 };
  }

  /**
   * 烘焙静态地面。参数不变时直接复用缓存（可安全地被频繁调用）。
   * @param world 开局 world（需含 w / h / hidingSpots）
   * @param opts { role, baseColor, quality, dpr, zoom, nest?, seed? }
   */
  build(world, opts = {}) {
    if (!world?.w || !world?.h) return;
    const low = opts.quality === 'low';
    const cap = low ? 1.25 : 2;
    let scale = clamp((opts.dpr || 1) * (opts.zoom || 1), opts.minScale ?? 1, cap);
    const side = Math.max(world.w, world.h) + SCENE_MARGIN * 2;
    scale = Math.min(scale, MAX_CACHE_SIDE / side);
    scale = Math.round(scale * 20) / 20;
    const nest = opts.nest ?? this._nest ?? MeadowScene.defaultNest(world);
    const seed = opts.seed ?? seedFromWorld(world);
    const baseColor = opts.baseColor || GROUND_FILL_DEFAULT;
    const key = [seed, world.w, world.h, opts.role, baseColor, scale, low ? 'l' : 'h',
      Math.round(nest.x), Math.round(nest.y), Math.round(nest.radius ?? 80)].join('|');
    if (key === this._key && this.canvas) return;

    this._key = key;
    this._opts = { ...opts, baseColor };
    this.world = world;
    this.scale = scale;
    this._nest = { x: nest.x, y: nest.y, radius: nest.radius ?? 80 };
    this._nestSprites.clear();

    const cw = Math.ceil((world.w + SCENE_MARGIN * 2) * scale);
    const ch = Math.ceil((world.h + SCENE_MARGIN * 2) * scale);
    const canvas = this.canvas ?? document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, SCENE_MARGIN * scale, SCENE_MARGIN * scale);
    this._bake(ctx, world, seed, { ...opts, baseColor, low });
    this.canvas = canvas;
    this.ready = true;
  }

  /** 快照中的真实巢穴位置与估计不同（例如服务端改了配置）时重建 */
  syncNest(nest) {
    if (!nest || !this.world || !this._nest) return;
    if (Math.abs(nest.x - this._nest.x) <= 2 && Math.abs(nest.y - this._nest.y) <= 2) return;
    this.build(this.world, { ...this._opts, nest: { x: nest.x, y: nest.y, radius: this._nest.radius } });
  }

  /**
   * 在世界坐标系中贴出当前可见区域（ctx 已应用镜头变换）。
   * @param view { left, top, right, bottom } 可见世界矩形
   */
  drawGround(ctx, view) {
    if (!this.canvas) return false;
    const m = this.margin, s = this.scale, w = this.world;
    const l = Math.max(-m, view.left), t = Math.max(-m, view.top);
    const r = Math.min(w.w + m, view.right), b = Math.min(w.h + m, view.bottom);
    if (r <= l || b <= t) return true;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, (l + m) * s, (t + m) * s, (r - l) * s, (b - t) * s, l, t, r - l, b - t);
    ctx.imageSmoothingEnabled = prevSmooth;
    return true;
  }

  /** 每帧轻量动画：水洼涟漪 + 水滴闪光（低画质跳过） */
  drawAnimated(ctx, time, quality) {
    if (!this.ready || quality === 'low') return;
    const t = time / 1000;
    const pond = this._pond;
    if (pond) {
      ctx.save();
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        const phase = (t * 0.17 + i / 3) % 1;
        const k = 0.18 + phase * 0.62;
        ctx.beginPath();
        ctx.ellipse(pond.rx0, pond.ry0, pond.rx * k, pond.ry * k, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(228,242,213,${((1 - phase) * 0.4).toFixed(3)})`;
        ctx.stroke();
      }
      ctx.restore();
    }
    if (this._droplets.length) {
      ctx.save();
      this._droplets.forEach((d, i) => {
        const a = 0.35 + 0.45 * Math.sin(t * 1.5 + i * 2);
        if (a <= 0.05) return;
        ctx.beginPath();
        ctx.arc(d.x - d.r * 0.3, d.y - d.r * 0.35, Math.max(0.8, d.r * 0.28), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(249,255,233,${a.toFixed(3)})`;
        ctx.fill();
      });
      ctx.restore();
    }
  }

  /**
   * 蚁丘贴图（按半径 + 角色缓存，NEST_RADIUS 可在局中热改）。
   * 搜寻者版为完全不透明的沙丘，遮住巢内一切；隐藏者版露出暗色巢室。
   * @returns {{ canvas: HTMLCanvasElement, half: number }}
   */
  nestSprite(radius, role) {
    const r = Math.max(10, radius || 80);
    const kind = role === ROLE.SEEKER ? 'seeker' : role === ROLE.HIDER ? 'hider' : 'deco';
    const key = `${kind}|${Math.round(r)}`;
    const hit = this._nestSprites.get(key);
    if (hit) return hit;
    const half = r * 1.45;
    const s = this.scale || 1;
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(2, Math.ceil(half * 2 * s));
    const ctx = c.getContext('2d');
    ctx.setTransform(s, 0, 0, s, half * s, half * s);
    drawMound(ctx, r, kind, random(Math.round(r) * 7919 + 13));
    const sprite = { canvas: c, half };
    this._nestSprites.set(key, sprite);
    return sprite;
  }

  // ---------------------------------------------------------------------------
  // 烘焙
  // ---------------------------------------------------------------------------

  _bake(ctx, world, seed, opts) {
    const W = world.w, H = world.h;
    // 每层独立随机流：低画质减少草叶 / 色斑数量时，不影响小径与道具布局，跨端一致
    const stream = (k) => random((seed + Math.imul(k, 0x9e3779b1)) >>> 0);
    const nest = this._nest;
    const spots = (world.hidingSpots ?? []).map((s) => ({ x: s.x, y: s.y, r: s.radius || 45 }));
    const base = hexToRgb(opts.baseColor);
    const mask = new Mask(W, H);
    const low = opts.low;
    this._pond = null;
    this._droplets = [];

    // 预留区域：巢穴、躲藏点
    mask.circle(nest.x, nest.y, nest.radius * 1.55, M_NEST);
    mask.circle(nest.x, nest.y, nest.radius + 60, M_KEEP);
    for (const s of spots) {
      mask.circle(s.x, s.y, s.r * 1.05, M_SPOT);
      mask.circle(s.x, s.y, s.r + 30, M_KEEP);
    }

    // 1. 世界外：投影 + 盆景侧壁
    this._drawEdge(ctx, W, H, stream(1));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    // 2. 草地底色 + 色斑
    let rng = stream(2);
    ctx.fillStyle = rgba(mixRgb(base, hexToRgb(PAL.greens[1]), 0.35));
    ctx.fillRect(0, 0, W, H);
    const blobs = low ? 110 : 170;
    for (let i = 0; i < blobs; i++) {
      const x = rng() * W, y = rng() * H, r = 50 + rng() * 110;
      const g = mixRgb(hexToRgb(PAL.greens[(rng() * PAL.greens.length) | 0]), base, 0.45);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(g, 0.5));
      grad.addColorStop(1, rgba(g, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 低频明暗：阳光斑与草荫
    for (let i = 0; i < 14; i++) {
      const x = rng() * W, y = rng() * H, r = 160 + rng() * 220;
      const light = i % 2 === 0;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, light ? 'rgba(255,248,214,0.10)' : 'rgba(64,88,40,0.08)');
      grad.addColorStop(1, light ? 'rgba(255,248,214,0)' : 'rgba(64,88,40,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // 3. 泥土小径：巢穴 → 各躲藏点 + 地图边缘
    rng = stream(3);
    const trails = this._layoutTrails(W, H, nest, spots, rng);
    this._drawTrails(ctx, trails, mask, rng);

    // 4. 巢周沙土空地
    {
      const r = nest.radius * 2.1;
      const grad = ctx.createRadialGradient(nest.x, nest.y, nest.radius * 0.6, nest.x, nest.y, r);
      grad.addColorStop(0, rgba(hexToRgb(PAL.soil), 0.95));
      grad.addColorStop(0.55, rgba(hexToRgb(PAL.soil), 0.6));
      grad.addColorStop(1, rgba(hexToRgb(PAL.soil), 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nest.x, nest.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. 水洼、碎石区、落叶区（地面层）
    rng = stream(5);
    const pond = this._layoutPond(W, H, nest, spots);
    if (pond) {
      this._drawPond(ctx, pond, rng);
      mask.circle(pond.rx0, pond.ry0, pond.rx * 1.2, M_POND, pond.ry / pond.rx);
    }
    const patches = this._layoutPatches(W, H, nest, spots, pond, rng);
    for (const p of patches) {
      this._drawPatchFloor(ctx, p, rng);
      mask.circle(p.x, p.y, p.r * 0.9, M_PATCH);
    }

    // 6. 草叶簇（按颜色分桶批量描边）
    this._drawGrass(ctx, W, H, mask, stream(6), low);

    // 7. 碎石与落叶细节
    rng = stream(7);
    for (const p of patches) this._drawPatchDetail(ctx, p, rng);
    rng = stream(8);

    // 8. 道具
    this._drawProps(ctx, W, H, mask, rng, pond);

    // 9. 躲藏点（按角色）
    for (const s of spots) this._drawSpot(ctx, s, opts.role, rng);

    // 边缘内侧细线：顶面与侧壁交界
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,250,224,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, 0); ctx.lineTo(W, 0);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(96,82,48,0.45)';
    ctx.beginPath();
    ctx.moveTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(0, H);
    ctx.stroke();
  }

  /** 世界外投影 + 底部 / 右侧土层侧壁（参考场景的「切面盆景」） */
  _drawEdge(ctx, W, H, rng) {
    const s = this.scale;
    ctx.save();
    ctx.shadowColor = 'rgba(70,84,52,0.32)';
    ctx.shadowBlur = 18 * s;
    ctx.shadowOffsetY = 9 * s;
    ctx.fillStyle = PAL.wallDark;
    ctx.fillRect(0, 0, W + 3, H + WALL);
    ctx.restore();
    const g = ctx.createLinearGradient(0, H, 0, H + WALL);
    g.addColorStop(0, PAL.wall);
    g.addColorStop(1, PAL.wallDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, H, W + 3, WALL);
    ctx.fillStyle = '#a99062';
    ctx.fillRect(W, 0, 3, H + WALL);
    // 侧壁里的砂砾
    ctx.fillStyle = 'rgba(212,189,139,0.8)';
    ctx.beginPath();
    for (let i = 0; i < 160; i++) {
      const x = rng() * W, y = H + 2 + rng() * (WALL - 3), r = 0.6 + rng() * 1.3;
      ctx.moveTo(x + r, y);
      ctx.ellipse(x, y, r, r * 0.65, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(120,96,60,0.35)';
    ctx.fillRect(0, H + WALL - 1.5, W + 3, 1.5);
  }

  _layoutTrails(W, H, nest, spots, rng) {
    const targets = spots.map((s) => [s.x, s.y]);
    // 边缘出口：左下、右下、正下方（略伸出世界边缘，保证小径接到边上）
    targets.push([W * (0.06 + rng() * 0.12), H + 30]);
    targets.push([W * (0.82 + rng() * 0.12), H + 30]);
    targets.push([-30, H * (0.3 + rng() * 0.2)]);
    targets.push([W + 30, H * (0.28 + rng() * 0.2)]);
    if (!spots.length) targets.push([W * (0.45 + rng() * 0.1), H + 30]);
    return targets.map(([tx, ty]) => {
      const ang = Math.atan2(ty - nest.y, tx - nest.x);
      const sx = nest.x + Math.cos(ang) * nest.radius * 0.9;
      const sy = nest.y + Math.sin(ang) * nest.radius * 0.9;
      const d = dist(sx, sy, tx, ty);
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      const pts = [[sx, sy]];
      for (const t of [0.33, 0.66]) {
        const off = (rng() - 0.5) * 0.3 * d;
        pts.push([sx + (tx - sx) * t + nx * off, sy + (ty - sy) * t + ny * off]);
      }
      pts.push([tx, ty]);
      return pts;
    });
  }

  _drawTrails(ctx, trails, mask, rng) {
    const path = new Path2D();
    const samples = [];
    for (const pts of trails) catmullPath(path, pts, samples);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 接触暗边：让浅浅的小径凹陷可读
    ctx.strokeStyle = 'rgba(78,94,46,0.10)';
    ctx.lineWidth = 40;
    ctx.stroke(path);
    const soil = hexToRgb(PAL.soil);
    for (const [w, a] of [[32, 0.28], [24, 0.42], [16, 0.55]]) {
      ctx.strokeStyle = rgba(soil, a);
      ctx.lineWidth = w;
      ctx.stroke(path);
    }
    ctx.restore();
    // 小径上的砂粒
    ctx.fillStyle = 'rgba(212,189,139,0.7)';
    ctx.beginPath();
    for (let i = 0; i < samples.length; i += 2) {
      const [x, y] = samples[i];
      const ox = x + (rng() - 0.5) * 22, oy = y + (rng() - 0.5) * 22, r = 0.7 + rng() * 1.2;
      ctx.moveTo(ox + r, oy);
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(150,120,80,0.35)';
    ctx.beginPath();
    for (let i = 1; i < samples.length; i += 3) {
      const [x, y] = samples[i];
      const ox = x + (rng() - 0.5) * 18, oy = y + (rng() - 0.5) * 18, r = 0.6 + rng() * 0.9;
      ctx.moveTo(ox + r, oy);
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    mask.polyline(samples, 22, M_TRAIL);
  }

  /** 水洼放在离巢穴与躲藏点最远的角落 */
  _layoutPond(W, H, nest, spots) {
    const cands = [[W * 0.87, H * 0.2], [W * 0.13, H * 0.2], [W * 0.87, H * 0.85], [W * 0.13, H * 0.85]];
    let best = null, bestD = -1;
    for (const [x, y] of cands) {
      let d = dist(x, y, nest.x, nest.y) - nest.radius;
      for (const s of spots) d = Math.min(d, dist(x, y, s.x, s.y) - s.r);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    if (!best || bestD < 150) return null;
    return { rx0: best[0], ry0: best[1], rx: 82, ry: 54 };
  }

  _drawPond(ctx, p, rng) {
    const wobble = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      wobble.push(1 + 0.05 * Math.sin(a * 5 + rng()) + 0.04 * Math.cos(a * 3));
    }
    const shape = (k) => {
      ctx.beginPath();
      wobble.forEach((w, i) => {
        const a = (i / 48) * Math.PI * 2;
        const x = p.rx0 + Math.cos(a) * p.rx * w * k, y = p.ry0 + Math.sin(a) * p.ry * w * k;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };
    // 湿润泥岸 → 浅水
    shape(1.22);
    ctx.fillStyle = rgba(hexToRgb(PAL.pondFloor), 0.45);
    ctx.fill();
    shape(1.0);
    const grad = ctx.createRadialGradient(p.rx0, p.ry0, 0, p.rx0, p.ry0, p.rx);
    grad.addColorStop(0, 'rgba(116,178,168,0.82)');
    grad.addColorStop(1, rgba(hexToRgb(PAL.water), 0.7));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,240,214,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 天空倒影高光
    ctx.beginPath();
    ctx.ellipse(p.rx0, p.ry0, p.rx * 0.74, p.ry * 0.62, 0, 0.2, 1.6);
    ctx.strokeStyle = 'rgba(222,238,210,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    this._pond = p;
  }

  _layoutPatches(W, H, nest, spots, pond, rng) {
    const kinds = ['leaves', 'gravel', 'leaves', 'gravel'];
    const out = [];
    for (const kind of kinds) {
      for (let tries = 0; tries < 60; tries++) {
        const r = 60 + rng() * 34;
        const x = 120 + rng() * (W - 240), y = 120 + rng() * (H - 240);
        if (dist(x, y, nest.x, nest.y) < nest.radius + r + 140) continue;
        if (spots.some((s) => dist(x, y, s.x, s.y) < s.r + r + 50)) continue;
        if (pond && dist(x, y, pond.rx0, pond.ry0) < pond.rx + r + 60) continue;
        if (out.some((o) => dist(x, y, o.x, o.y) < o.r + r + 120)) continue;
        out.push({ kind, x, y, r });
        break;
      }
    }
    return out;
  }

  _drawPatchFloor(ctx, p) {
    const c = hexToRgb(p.kind === 'leaves' ? PAL.leafFloor : PAL.gravel);
    const grad = ctx.createRadialGradient(p.x, p.y, p.r * 0.2, p.x, p.y, p.r * 1.15);
    grad.addColorStop(0, rgba(c, 0.62));
    grad.addColorStop(0.7, rgba(c, 0.4));
    grad.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 1.15, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawPatchDetail(ctx, p, rng) {
    if (p.kind === 'gravel') {
      const n = 26 + ((rng() * 12) | 0);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * p.r;
        drawPebble(ctx, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 2.5 + rng() * 5, rng);
      }
      return;
    }
    const n = 14 + ((rng() * 6) | 0);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * p.r * 0.95;
      drawFallenLeaf(ctx, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 16 + rng() * 14, rng() * Math.PI * 2, rng);
    }
  }

  _drawGrass(ctx, W, H, mask, rng, low) {
    const tufts = low ? 1500 : 2600;
    const colors = [];
    for (let i = 0; i < 6; i++) {
      colors.push(`hsla(${85 + i * 2.4}, ${30 + (i % 3) * 5}%, ${38 + i * 2.8}%, 0.6)`);
    }
    const paths = colors.map(() => new Path2D());
    const blocked = M_TRAIL | M_NEST | M_POND | M_SPOT | M_PATCH;
    let placed = 0;
    for (let attempt = 0; attempt < tufts * 3 && placed < tufts; attempt++) {
      const x = rng() * W, y = rng() * H;
      if (mask.at(x, y) & blocked) continue;
      const density = Math.sin(x * 0.013) * Math.cos(y * 0.014);
      if (rng() > 0.46 + density * 0.34) continue;
      placed++;
      const path = paths[(rng() * paths.length) | 0];
      const blades = 2 + ((rng() * 2) | 0);
      const dir = -Math.PI / 2 + (rng() - 0.5) * 1.2;
      for (let b = 0; b < blades; b++) {
        const a = dir + (b - (blades - 1) / 2) * 0.5 + (rng() - 0.5) * 0.3;
        const len = 5 + rng() * 6;
        const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
        const bend = (rng() - 0.5) * 4;
        path.moveTo(x, y);
        path.quadraticCurveTo(x + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, y + Math.sin(a) * len * 0.5 + Math.cos(a) * bend, ex, ey);
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.3;
    paths.forEach((p, i) => { ctx.strokeStyle = colors[i]; ctx.stroke(p); });
    ctx.restore();
  }

  _drawProps(ctx, W, H, mask, rng, pond) {
    const blocked = M_TRAIL | M_NEST | M_POND | M_SPOT | M_PATCH | M_PROP | M_KEEP;
    const place = (minR, edge = 60) => {
      for (let tries = 0; tries < 40; tries++) {
        const x = edge + rng() * (W - edge * 2), y = edge + rng() * (H - edge * 2);
        let ok = true;
        for (const [dx, dy] of [[0, 0], [minR, 0], [-minR, 0], [0, minR], [0, -minR]]) {
          if (mask.at(x + dx, y + dy) & blocked) { ok = false; break; }
        }
        if (!ok) continue;
        mask.circle(x, y, minR + 12, M_PROP);
        return [x, y];
      }
      return null;
    };
    const put = (n, minR, fn) => {
      for (let i = 0; i < n; i++) {
        const p = place(minR);
        if (p) fn(p[0], p[1]);
      }
    };
    put(11, 26, (x, y) => drawClover(ctx, x, y, 13 + rng() * 7, rng() * Math.PI * 2));
    put(5, 30, (x, y) => drawDandelion(ctx, x, y, 0.85 + rng() * 0.35, rng));
    put(3, 22, (x, y) => {
      const n = 2 + ((rng() * 2) | 0);
      for (let i = 0; i < n; i++) {
        drawMushroom(ctx, x + (rng() - 0.5) * 22, y + (rng() - 0.5) * 18, 6 + rng() * 6, rng);
      }
    });
    put(3, 16, (x, y) => drawBerries(ctx, x, y, rng));
    put(4, 18, (x, y) => drawRoot(ctx, x, y, rng));
    put(5, 20, (x, y) => drawStem(ctx, x, y, rng() * Math.PI * 2));
    put(14, 8, (x, y) => drawPebble(ctx, x, y, 3 + rng() * 4, rng));
    this._droplets = [];
    put(6, 8, (x, y) => {
      const r = 3.5 + rng() * 2.5;
      drawDroplet(ctx, x, y, r);
      this._droplets.push({ x, y, r });
    });
    if (pond) {
      // 水洼边缘多放几颗水滴与石子，呼应参考场景
      for (let i = 0; i < 6; i++) {
        const a = rng() * Math.PI * 2;
        const x = pond.rx0 + Math.cos(a) * pond.rx * 1.3, y = pond.ry0 + Math.sin(a) * pond.ry * 1.35;
        if (mask.at(x, y) & (M_TRAIL | M_NEST | M_SPOT | M_KEEP)) continue;
        if (i % 2) drawPebble(ctx, x, y, 3 + rng() * 3, rng);
        else { const r = 3 + rng() * 2; drawDroplet(ctx, x, y, r); this._droplets.push({ x, y, r }); }
      }
    }
  }

  /** 躲藏点：隐藏者见落叶堆 + 标签；搜寻者见浓密暗色叶冠 */
  _drawSpot(ctx, s, role, rng) {
    const { x, y, r } = s;
    if (role === ROLE.SEEKER) {
      // 与旧版遮蔽同等暗度：仍能看见蚂蚁影子，但看不清外观特征
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,28,14,0.74)';
      ctx.fill();
      const darks = ['#24321b', '#2b3b20', '#33452a', '#1f2b17'];
      const n = 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng() * 0.3;
        const d = r * (0.78 + rng() * 0.2);
        ctx.save();
        ctx.translate(x + Math.cos(a) * d, y + Math.sin(a) * d);
        ctx.rotate(a + Math.PI / 2 + (rng() - 0.5) * 0.5);
        ctx.beginPath();
        leafShape(ctx, r * (0.5 + rng() * 0.18), r * 0.34);
        ctx.fillStyle = darks[i % darks.length];
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,150,80,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.22);
        ctx.lineTo(0, r * 0.22);
        ctx.stroke();
        ctx.restore();
      }
      // 叶缝：几条暗线暗示缝隙
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 1.5;
      for (let i = -r; i < r; i += 14) {
        ctx.beginPath();
        ctx.moveTo(x + i, y - r);
        ctx.lineTo(x + i + r * 0.6, y + r);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    // 隐藏者 / 装饰：中心通透，叶片围成一圈
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52,76,36,0.34)';
    ctx.fill();
    const golds = [PAL.gold, '#bba05e', '#a8874a', '#b39552'];
    const n = 13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.35;
      const d = r * (0.88 + rng() * 0.12);
      drawFallenLeaf(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.38 + rng() * 0.14),
        a + Math.PI / 2 + (rng() - 0.5) * 0.7, rng, golds[i % golds.length]);
    }
    if (role === ROLE.HIDER) {
      ctx.save();
      ctx.font = `600 12px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(248,248,237,0.85)';
      ctx.strokeText('躲藏', x, y - r * 0.55);
      ctx.fillStyle = '#304a36';
      ctx.fillText('躲藏', x, y - r * 0.55);
      ctx.restore();
    }
  }
}

// -----------------------------------------------------------------------------
// 道具（俯视剪影）
// -----------------------------------------------------------------------------

function propShadow(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 3, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(46,62,30,0.16)';
  ctx.fill();
}

function drawClover(ctx, x, y, size, rot) {
  propShadow(ctx, x, y, size * 0.95, size * 0.85);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI * 2) / 3);
    ctx.beginPath();
    heartLeaf(ctx, size);
    ctx.fillStyle = i === 1 ? PAL.leafLight : PAL.leaf;
    ctx.fill();
    // 叶脉 + 白色 V 形斑
    ctx.strokeStyle = PAL.vein;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(0, size * 0.05);
    ctx.lineTo(0, size * 0.6);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(232,240,200,0.45)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-size * 0.2, size * 0.48);
    ctx.lineTo(0, size * 0.34);
    ctx.lineTo(size * 0.2, size * 0.48);
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = PAL.stem;
  ctx.fill();
  ctx.restore();
}

function drawDandelion(ctx, x, y, k, rng) {
  propShadow(ctx, x, y, 22 * k, 18 * k);
  ctx.save();
  ctx.translate(x, y);
  // 莲座叶
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate(i * 1.05 + rng() * 0.3);
    ctx.translate(0, -12 * k);
    ctx.beginPath();
    leafShape(ctx, 24 * k, 7 * k);
    ctx.fillStyle = i % 2 ? PAL.leaf : '#7aa648';
    ctx.fill();
    ctx.strokeStyle = 'rgba(187,207,107,0.6)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -10 * k);
    ctx.lineTo(0, 10 * k);
    ctx.stroke();
    ctx.restore();
  }
  // 种球：放射冠毛 + 白色绒球
  const R = 11 * k;
  ctx.beginPath();
  ctx.arc(2 * k, -2 * k, R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(250,245,223,0.55)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(236,225,184,0.9)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    ctx.moveTo(2 * k, -2 * k);
    ctx.lineTo(2 * k + Math.cos(a) * R, -2 * k + Math.sin(a) * R);
  }
  ctx.stroke();
  ctx.fillStyle = PAL.seed;
  ctx.beginPath();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const px = 2 * k + Math.cos(a) * R, py = -2 * k + Math.sin(a) * R;
    ctx.moveTo(px + 1.2, py);
    ctx.arc(px, py, 1.2, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.beginPath();
  ctx.arc(2 * k, -2 * k, 2.4 * k, 0, Math.PI * 2);
  ctx.fillStyle = PAL.gold;
  ctx.fill();
  ctx.restore();
}

function drawMushroom(ctx, x, y, r, rng) {
  propShadow(ctx, x, y, r * 1.05, r * 0.9);
  const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  grad.addColorStop(0, '#dc9a72');
  grad.addColorStop(0.7, PAL.red);
  grad.addColorStop(1, '#a8633f');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = PAL.cream;
  ctx.beginPath();
  const n = 5 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r * 0.72, dr = r * (0.1 + rng() * 0.09);
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    ctx.moveTo(px + dr, py);
    ctx.ellipse(px, py, dr, dr * 0.8, a, 0, Math.PI * 2);
  }
  ctx.fill();
}

function drawFallenLeaf(ctx, x, y, len, rot, rng, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  leafShape(ctx, len, len * 0.42);
  ctx.fillStyle = color || [PAL.gold, '#bba05e', '#b8924a'][(rng() * 3) | 0];
  ctx.fill();
  ctx.strokeStyle = 'rgba(154,117,72,0.85)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.5);
  ctx.lineTo(0, len * 0.55);
  for (let i = 1; i <= 3; i++) {
    const yy = -len * 0.3 + i * len * 0.17;
    ctx.moveTo(0, yy);
    ctx.lineTo(len * 0.15, yy - len * 0.1);
    ctx.moveTo(0, yy);
    ctx.lineTo(-len * 0.15, yy - len * 0.1);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPebble(ctx, x, y, r, rng) {
  const n = 7;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 0.78 + rng() * 0.3;
    pts.push([x + Math.cos(a) * r * k, y + Math.sin(a) * r * k * 0.82]);
  }
  ctx.beginPath();
  ctx.ellipse(x + 1, y + 1.6, r, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(60,66,44,0.18)';
  ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  const tone = 0.9 + rng() * 0.2;
  const c = hexToRgb(PAL.rock).map((v) => clamp(v * tone, 0, 255));
  ctx.fillStyle = rgba(c);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x - r * 0.28, y - r * 0.3, r * 0.38, r * 0.24, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(236,236,220,0.45)';
  ctx.fill();
}

function drawBerries(ctx, x, y, rng) {
  propShadow(ctx, x, y, 12, 10);
  const offs = [[0, 0], [8, 3], [3, 8]];
  for (const [dx, dy] of offs) {
    const bx = x + dx + (rng() - 0.5) * 2, by = y + dy + (rng() - 0.5) * 2, r = 5 + rng() * 1.5;
    const grad = ctx.createRadialGradient(bx - r * 0.35, by - r * 0.35, 0.5, bx, by, r);
    grad.addColorStop(0, '#e08a7a');
    grad.addColorStop(0.5, PAL.berry);
    grad.addColorStop(1, '#8e4038');
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.save();
  ctx.translate(x + 2, y - 4);
  for (let i = 0; i < 3; i++) {
    ctx.rotate(2.1);
    ctx.beginPath();
    leafShape(ctx, 9, 4);
    ctx.fillStyle = PAL.leaf;
    ctx.fill();
  }
  ctx.restore();
}

function drawRoot(ctx, x, y, rng) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = PAL.brown;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = i * 1.5 + rng() * 0.4;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.4) * 9, y + Math.sin(a + 0.4) * 9, x + Math.cos(a) * 20, y + Math.sin(a) * 20);
  }
  ctx.stroke();
  ctx.strokeStyle = PAL.stem;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = i * 1.25;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10);
  }
  ctx.stroke();
  ctx.restore();
}

function drawStem(ctx, x, y, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(46,62,30,0.16)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-20, 3);
  ctx.quadraticCurveTo(2, 1, 24, -1);
  ctx.stroke();
  ctx.strokeStyle = PAL.cream;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-22, 0);
  ctx.quadraticCurveTo(0, -2, 22, -4);
  ctx.stroke();
  ctx.strokeStyle = PAL.stem;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(6, -2);
  ctx.quadraticCurveTo(10, 6, 20, 9);
  ctx.stroke();
  ctx.restore();
}

function drawDroplet(ctx, x, y, r) {
  ctx.beginPath();
  ctx.ellipse(x + 1, y + 1.5, r, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(60,90,70,0.14)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(191,223,207,0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,245,0.55)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,240,0.85)';
  ctx.fill();
}

/**
 * 沙质蚁丘（局部坐标，原点为巢心）。
 * kind: 'seeker' 完全不透明；'hider' 露出暗色巢室；'deco' 大厅装饰
 */
function drawMound(ctx, r, kind, rng) {
  // 外圈散沙
  const apron = ctx.createRadialGradient(0, 0, r * 0.9, 0, 0, r * 1.42);
  apron.addColorStop(0, 'rgba(198,160,107,0.85)');
  apron.addColorStop(1, 'rgba(198,160,107,0)');
  ctx.fillStyle = apron;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.42, 0, Math.PI * 2);
  ctx.fill();
  // 丘体
  const body = ctx.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.05, 0, 0, r);
  body.addColorStop(0, '#e2c592');
  body.addColorStop(0.55, PAL.sand);
  body.addColorStop(1, '#a88452');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  const interior = kind === 'hider' ? r * 0.8 : 0;
  // 沙粒
  const n = Math.round(r * 2.6);
  for (const [color, from, to] of [[PAL.grain, 0, n * 0.75], [PAL.grainDark, n * 0.75, n]]) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.max(interior + 2, r * 0.38 + Math.pow(rng(), 0.65) * r * 0.95);
      const gx = Math.cos(a) * d, gy = Math.sin(a) * d;
      const gr = 0.8 + rng() * 1.7;
      ctx.moveTo(gx + gr, gy);
      ctx.ellipse(gx, gy, gr, gr * 0.7, rng() * 3, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // 细纹：沙丘层理
  ctx.strokeStyle = 'rgba(140,105,60,0.18)';
  ctx.lineWidth = 1.2;
  for (const k of [0.62, 0.82]) {
    if (k * r <= interior) continue;
    ctx.beginPath();
    ctx.arc(0, 0, r * k, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (kind === 'hider') {
    // 巢室：暗色内腔，中心稍亮便于看清蚂蚁
    const cave = ctx.createRadialGradient(0, 0, 0, 0, 0, interior);
    cave.addColorStop(0, '#4d3922');
    cave.addColorStop(0.8, '#3a2a17');
    cave.addColorStop(1, '#2a1d0f');
    ctx.fillStyle = cave;
    ctx.beginPath();
    ctx.arc(0, 0, interior, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,150,96,0.14)';
    ctx.lineWidth = 1;
    for (const k of [0.35, 0.6]) {
      ctx.beginPath();
      ctx.arc(0, 0, interior * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(240,220,170,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, interior + 1, Math.PI * 1.05, Math.PI * 1.7);
    ctx.stroke();
    return;
  }

  // 入口：火山口 + 深色洞口
  ctx.strokeStyle = 'rgba(120,90,50,0.3)';
  ctx.lineWidth = r * 0.07;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  const hole = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.3);
  hole.addColorStop(0, '#1d190f');
  hole.addColorStop(0.6, PAL.hole);
  hole.addColorStop(1, PAL.throat);
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(240,222,176,0.55)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.32, Math.PI * 1.0, Math.PI * 1.6);
  ctx.stroke();
}

// -----------------------------------------------------------------------------
// 大厅背景：静态草甸，cover 铺满
// -----------------------------------------------------------------------------

const LOBBY_WORLD = {
  w: 1600,
  h: 1200,
  hidingSpots: [
    { x: 430, y: 760, radius: 46 },
    { x: 1190, y: 690, radius: 50 },
    { x: 820, y: 1000, radius: 42 },
  ],
};
let lobbyScene = null;

/**
 * 把草甸画到大厅背景画布上（cover 适配）。
 * @param {HTMLCanvasElement} canvas
 * @param {{ w: number, h: number, dpr: number, baseColor?: string, quality?: string }} view
 */
export function paintMeadowBackdrop(canvas, view) {
  if (!canvas || !view?.w || !view?.h) return;
  const dpr = view.dpr || 1;
  const fit = Math.max(view.w / LOBBY_WORLD.w, view.h / LOBBY_WORLD.h);
  lobbyScene ??= new MeadowScene();
  // 背景有薄雾模糊，分辨率够用即可；移动端走低画质档省显存
  lobbyScene.build(LOBBY_WORLD, {
    role: 'lobby', baseColor: view.baseColor, quality: view.quality ?? 'high',
    dpr, zoom: Math.min(fit, 0.75), minScale: 0.5, seed: 843721,
  });
  const bw = Math.round(view.w * dpr), bh = Math.round(view.h * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#e9eddf';
  ctx.fillRect(0, 0, bw, bh);
  const s = fit * dpr;
  ctx.setTransform(s, 0, 0, s, (bw - LOBBY_WORLD.w * s) / 2, (bh - LOBBY_WORLD.h * s) / 2);
  lobbyScene.drawGround(ctx, { left: 0, top: 0, right: LOBBY_WORLD.w, bottom: LOBBY_WORLD.h });
  const nest = MeadowScene.defaultNest(LOBBY_WORLD);
  const sprite = lobbyScene.nestSprite(nest.radius, 'lobby');
  ctx.drawImage(sprite.canvas, nest.x - sprite.half, nest.y - sprite.half, sprite.half * 2, sprite.half * 2);
}
