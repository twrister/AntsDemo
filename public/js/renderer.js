// Canvas 2D 渲染器：绘制蚁群、食物、信息素轨迹、工具效果。
// 蚂蚁按 5 个特征维度绘制差异 (GDD 3.1)，使搜寻者能用肉眼识别破绽。
import { ROLE } from './const.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._cachedPhero = null;  // 信息素快照缓存（服务器每 2 tick 才更新一次）
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * 渲染一帧。
   * @param snap 插值后的世界快照
   * @param cam  镜头 { x, y, zoom } —— 世界坐标中心点
   * @param opts { role, world, time, viewRadius, frozen, lightBeam }
   */
  draw(snap, cam, opts) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 更新信息素缓存（服务器不发时复用上一帧）
    if (snap.phero) this._cachedPhero = snap.phero;

    const zoom = cam.zoom || 1;
    ctx.save();
    // 世界 -> 屏幕变换：以 cam 为中心
    ctx.translate(W / 2, H / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-cam.x, -cam.y);

    this._drawGround(ctx, opts.world);
    // 信息素轨迹绘制在地面之上、蚂蚁之下，呈现搬运通道
    if (this._cachedPhero && opts.showPheromone !== false) this._drawPheromone(ctx, this._cachedPhero);
    this._drawNest(ctx, snap.nest);
    this._drawNormalFood(ctx, snap.normalFood);
    if (snap.bait) this._drawBait(ctx, snap.bait, opts.time);
    if (opts.lightBeam) this._drawLightBeam(ctx, opts.lightBeam, opts.time);

    for (const ant of snap.ants) {
      this._drawAnt(ctx, ant, opts);
    }

    ctx.restore();

    // 屏幕空间叠层
    if (opts.role === ROLE.SEEKER && opts.viewRadius) {
      this._drawVignette(ctx, W, H, opts.viewRadius);
      // 强光照射可穿透暗角，照亮四角阴暗处
      if (opts.lightBeam) this._drawLightVignetteRelief(ctx, opts.lightBeam, cam, W, H, opts.time);
    }
    // 光束内蚂蚁二次绘制：叠在暗角之上，提升阴暗处辨识度
    if (opts.lightBeam && opts.role === ROLE.SEEKER) {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-cam.x, -cam.y);
      for (const ant of snap.ants) {
        const illum = this._beamIllumination(ant, opts.lightBeam);
        if (illum > 0.06) this._drawAnt(ctx, ant, opts, illum);
      }
      ctx.restore();
    }
    if (opts.frozen) this._tint(ctx, W, H, 'rgba(120,180,255,0.14)');
  }

  /** 计算蚂蚁在强光束内的照明强度（0-1，中心最强） */
  _beamIllumination(ant, beam) {
    const r = beam.radius || 120;
    const d = Math.hypot(ant.x - beam.x, ant.y - beam.y);
    if (d >= r) return 0;
    const t = 1 - d / r;
    return t * t;
  }

  _drawGround(ctx, world) {
    if (!world) return;
    ctx.fillStyle = '#33291b';
    ctx.fillRect(0, 0, world.w, world.h);
    // 土壤网格纹理
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= world.w; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.h); ctx.stroke(); }
    for (let y = 0; y <= world.h; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.w, y); ctx.stroke(); }
    ctx.strokeStyle = '#4a3d28';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, world.w, world.h);
  }

  _drawNest(ctx, nest) {
    if (!nest) return;
    ctx.beginPath();
    ctx.arc(nest.x, nest.y, 40, 0, Math.PI * 2);
    ctx.fillStyle = '#5a3d1f'; ctx.fill();
    ctx.strokeStyle = '#e0a93b'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#e0a93b'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('巢穴', nest.x, nest.y + 5);
  }

  /**
   * 绘制信息素场（地面层）。
   * toFood（青色）：引导搜寻者前往食物的轨迹。
   * toHome（品红）：引导搬运者回巢的轨迹。
   * 两层叠加后呈现出蚁群真实走廊的双向颜色。
   */
  _drawPheromone(ctx, phero) {
    const { cols, rows, cell, toFood, toHome } = phero;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const f = toFood[i];   // 0-255
        const h = toHome[i];   // 0-255
        if (f < 4 && h < 4) continue; // 跳过空格（性能优化）
        const x = c * cell, y = r * cell;
        // toFood 青色：rgba(80, 220, 200, alpha)
        if (f >= 4) {
          ctx.fillStyle = `rgba(80,220,200,${(f / 255 * 0.45).toFixed(3)})`;
          ctx.fillRect(x, y, cell, cell);
        }
        // toHome 品红：rgba(230, 80, 200, alpha)，与棕褐地面和青色 toFood 均易区分
        if (h >= 4) {
          ctx.fillStyle = `rgba(230,80,200,${(h / 255 * 0.42).toFixed(3)})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
  }

  /** 绘制可枯竭食物堆：按剩余量/容量比例决定圆点大小与颜色深浅，并标注剩余数量 */
  _drawNormalFood(ctx, food) {
    if (!food) return;
    for (const f of food) {
      if (f.amount <= 0) continue;
      const ratio = (f.capacity > 0) ? f.amount / f.capacity : 0;
      const r = 4 + ratio * 8;         // 半径 4-12px，满堆最大
      const alpha = 0.4 + ratio * 0.6; // 枯竭时变淡
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(143,179,107,${alpha.toFixed(2)})`;
      ctx.fill();
      // 外圈轮廓（帮助搜寻者注意到食物堆）
      ctx.strokeStyle = `rgba(200,230,160,${(alpha * 0.6).toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 剩余数量文字（带描边提升可读性）
      const label = String(f.amount);
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,16,10,0.85)';
      ctx.strokeText(label, f.x, f.y);
      ctx.fillStyle = '#e8f4d0';
      ctx.fillText(label, f.x, f.y);
    }
  }

  _drawBait(ctx, bait, time) {
    const pulse = 0.5 + 0.5 * Math.sin(time / 150);
    ctx.beginPath();
    ctx.arc(bait.x, bait.y, 60, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(224,169,59,${0.2 + pulse * 0.3})`; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(bait.x, bait.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#e0a93b'; ctx.fill();
  }

  /** 绘制强光照射：鼠标位置的径向光晕 */
  _drawLightBeam(ctx, beam, time) {
    const pulse = 0.85 + 0.15 * Math.sin(time / 80);
    const r = beam.radius || 120;
    const grad = ctx.createRadialGradient(beam.x, beam.y, 0, beam.x, beam.y, r);
    grad.addColorStop(0, `rgba(255,248,200,${(0.55 * pulse).toFixed(3)})`);
    grad.addColorStop(0.35, `rgba(255,230,120,${(0.28 * pulse).toFixed(3)})`);
    grad.addColorStop(0.7, `rgba(255,200,80,${(0.08 * pulse).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, r, 0, Math.PI * 2);
    ctx.fill();
    // 光芯
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,220,${(0.75 * pulse).toFixed(3)})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,240,180,${(0.35 * pulse).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 核心：按特征绘制一只蚂蚁；illum>0 时在强光下提亮并加轮廓光
  _drawAnt(ctx, ant, opts, illum = 0) {
    const tr = ant.traits;
    ctx.save();
    if (illum > 0.1) {
      ctx.shadowColor = `rgba(255,248,210,${(0.45 + illum * 0.45).toFixed(2)})`;
      ctx.shadowBlur = 2 + illum * 9;
    }
    ctx.translate(ant.x, ant.y);

    // 步态摇摆 (gait)：身体左右摆动幅度
    const gaitAmp = [0, 2, 5, 8][tr.gait] || 0;
    const sway = tr.gait === 3
      ? Math.sin(opts.time / 90 + ant.id) * gaitAmp * (0.6 + 0.4 * Math.sin(opts.time / 37 + ant.id)) // 不规则
      : Math.sin(opts.time / 120 + ant.id) * gaitAmp;
    ctx.rotate(ant.angle + Math.PI / 2 + sway * 0.01);

    // 头身比例 (ratio)
    const ratioTbl = [
      { head: 4, body: 6 },   // 小
      { head: 5, body: 8 },   // 正常
      { head: 7, body: 11 },  // 大
      { head: 6, body: 9, square: true }, // 方正
    ];
    const r = ratioTbl[tr.ratio] || ratioTbl[1];

    // 胸甲色调 (tint)：基准棕 ± 等级；强光下额外提亮
    const baseHue = 28;
    const lightBoost = illum * 24;
    const satBoost = illum * 8;
    const light = Math.min(72, 22 + tr.tint * 6 + lightBoost);
    const sat = Math.min(58, 45 + satBoost);
    let body = `hsl(${baseHue}, ${sat}%, ${light}%)`;
    if (ant.marked) body = illum > 0.2 ? '#777' : '#555';
    if (ant.isSelf) body = '#6fc36f';
    // 腿
    const legLight = Math.max(12, light - 8 + illum * 6);
    ctx.strokeStyle = ant.marked ? '#444' : `hsl(${baseHue},${sat - 5}%,${legLight}%)`;
    ctx.lineWidth = 1.4 + illum * 0.8;
    for (const s of [-1, 1]) {
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * 3);
        ctx.lineTo(s * (r.body * 0.9), i * 4 + sway * s * 0.3);
        ctx.stroke();
      }
    }

    // 强光下先画浅色描边，拉开与地面的对比
    if (illum > 0.12) {
      ctx.strokeStyle = `rgba(255,240,200,${(0.35 + illum * 0.4).toFixed(2)})`;
      ctx.lineWidth = 1.6 + illum;
      this._strokeAntBody(ctx, r);
    }

    // 腹部
    ctx.fillStyle = body;
    if (r.square) { ctx.fillRect(-r.body * 0.6, 1, r.body * 1.2, r.body * 1.3); }
    else { ctx.beginPath(); ctx.ellipse(0, r.body * 0.6, r.body * 0.7, r.body, 0, 0, Math.PI * 2); ctx.fill(); }

    // 腹部条纹 (stripe)
    this._drawStripe(ctx, tr.stripe, r, body, illum);

    // 胸
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, -r.head * 0.2, r.head * 0.6, r.head * 0.8, 0, 0, Math.PI * 2); ctx.fill();

    // 头
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, -r.head - 1, r.head * 0.8, 0, Math.PI * 2); ctx.fill();

    // 搬运时在头部前方显示食物
    if (ant.carrying) {
      ctx.beginPath();
      ctx.arc(0, -r.head - 8, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#8fb36b';
      ctx.fill();
      ctx.strokeStyle = '#c8e6a0';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 触角 (antenna)
    this._drawAntennae(ctx, tr.antenna, r, illum);

    ctx.restore();

    // 可疑标记 (诱饵)
    if (ant.suspicious && opts.role === ROLE.SEEKER) {
      ctx.fillStyle = '#d6543c'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('?', ant.x, ant.y - 20);
    }
    // 被标记淘汰
    if (ant.marked) {
      ctx.strokeStyle = '#d6543c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ant.x - 8, ant.y - 8); ctx.lineTo(ant.x + 8, ant.y + 8);
      ctx.moveTo(ant.x + 8, ant.y - 8); ctx.lineTo(ant.x - 8, ant.y + 8); ctx.stroke();
    }
    // 隐藏者自身取/放食物进度环
    const actionTime = opts.foodActionTime || 1;
    if (ant.isSelf && ant.pickup > 0) {
      ctx.beginPath();
      ctx.arc(ant.x, ant.y, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (ant.pickup / actionTime));
      ctx.strokeStyle = '#8fb36b'; ctx.lineWidth = 3; ctx.stroke();
    }
    if (ant.isSelf && ant.deposit > 0) {
      ctx.beginPath();
      ctx.arc(ant.x, ant.y, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (ant.deposit / actionTime));
      ctx.strokeStyle = '#e0a93b'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  /** 蚂蚁躯干轮廓（强光描边用） */
  _strokeAntBody(ctx, r) {
    if (r.square) {
      ctx.strokeRect(-r.body * 0.6, 1, r.body * 1.2, r.body * 1.3);
      ctx.beginPath();
      ctx.ellipse(0, -r.head * 0.2, r.head * 0.6, r.head * 0.8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -r.head - 1, r.head * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.ellipse(0, r.body * 0.6, r.body * 0.7, r.body, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -r.head * 0.2, r.head * 0.6, r.head * 0.8, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -r.head - 1, r.head * 0.8, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawStripe(ctx, stripe, r, body, illum = 0) {
    ctx.save();
    const w = r.body * 0.6, cy = r.body * 0.6;
    const stripeAlpha = 0.7 - illum * 0.25;
    ctx.strokeStyle = `rgba(10,8,4,${stripeAlpha.toFixed(2)})`;
    ctx.fillStyle = `rgba(10,8,4,${stripeAlpha.toFixed(2)})`;
    ctx.lineWidth = 1.4 + illum * 0.4;
    switch (stripe) {
      case 0: break; // 无
      case 1: // 单条居中
        ctx.beginPath(); ctx.moveTo(-w, cy); ctx.lineTo(w, cy); ctx.stroke(); break;
      case 2: // 双条
        ctx.beginPath(); ctx.moveTo(-w, cy - 3); ctx.lineTo(w, cy - 3);
        ctx.moveTo(-w, cy + 3); ctx.lineTo(w, cy + 3); ctx.stroke(); break;
      case 3: // 锯齿
        ctx.beginPath(); ctx.moveTo(-w, cy - 2);
        ctx.lineTo(-w / 2, cy + 2); ctx.lineTo(0, cy - 2); ctx.lineTo(w / 2, cy + 2); ctx.lineTo(w, cy - 2);
        ctx.stroke(); break;
      case 4: // 斑点
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(i * 4, cy, 1.6, 0, Math.PI * 2); ctx.fill(); }
        break;
    }
    ctx.restore();
  }

  _drawAntennae(ctx, kind, r, illum = 0) {
    const antLight = Math.min(42, 12 + illum * 28);
    ctx.strokeStyle = illum > 0.1 ? `hsl(28,35%,${antLight}%)` : '#1a140c';
    ctx.lineWidth = 1.3 + illum * 0.5;
    const baseY = -r.head - 2;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 2, baseY);
      switch (kind) {
        case 0: ctx.lineTo(s * 3, baseY - 9); break;                      // 直
        case 1: ctx.quadraticCurveTo(s * 0, baseY - 6, s * -1, baseY - 10); break; // 微内弯
        case 2: ctx.quadraticCurveTo(s * 6, baseY - 6, s * 8, baseY - 9); break;   // 微外弯
        case 3: ctx.quadraticCurveTo(s * 7, baseY - 7, s * 3, baseY - 11); break;  // 钩状
      }
      ctx.stroke();
    }
  }

  // 搜寻者视野半径：外圈渐暗 (GDD 屏幕 60%)
  _drawVignette(ctx, W, H, radiusPx) {
    const cx = W / 2, cy = H / 2;
    const g = ctx.createRadialGradient(cx, cy, radiusPx * 0.6, cx, cy, radiusPx * 1.25);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(8,6,3,0.92)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  /**
   * 强光穿透暗角：用提亮叠层抵消 vignette，避免擦除导致蚂蚁发虚。
   */
  _drawLightVignetteRelief(ctx, beam, cam, W, H, time) {
    const zoom = cam.zoom || 1;
    const sx = W / 2 + (beam.x - cam.x) * zoom;
    const sy = H / 2 + (beam.y - cam.y) * zoom;
    const sr = (beam.radius || 120) * zoom * 1.2;
    const pulse = 0.85 + 0.15 * Math.sin(time / 80);

    // 抵消暗角压暗
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const lift = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    lift.addColorStop(0, `rgba(255,248,215,${(0.78 * pulse).toFixed(3)})`);
    lift.addColorStop(0.35, `rgba(255,235,170,${(0.52 * pulse).toFixed(3)})`);
    lift.addColorStop(0.7, `rgba(255,220,130,${(0.22 * pulse).toFixed(3)})`);
    lift.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = lift;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // 暖色光晕，强化被照亮区域
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 0.85);
    glow.addColorStop(0, `rgba(255,240,180,${(0.55 * pulse).toFixed(3)})`);
    glow.addColorStop(0.5, `rgba(255,220,140,${(0.28 * pulse).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  _tint(ctx, W, H, color) { ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); }
}
