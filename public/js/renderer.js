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
   * @param opts { role, world, time, viewRadius, lightBeam, sniffBeam, toolPreview }
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
    if (this._cachedPhero && opts.showPheromone !== false) {
      this._drawPheromone(ctx, this._cachedPhero, snap.nest, opts);
    }
    this._drawNest(ctx, snap.nest, opts);
    this._drawHidingSpots(ctx, snap.hidingSpots ?? opts.world?.hidingSpots, opts);
    this._drawNormalFood(ctx, snap.normalFood);
    this._drawFakeFood(ctx, snap.fakeFood, opts);
    if (opts.toolPreview) this._drawToolRangePreview(ctx, opts.toolPreview, opts.time);
    if (opts.lightBeam) this._drawLightBeam(ctx, opts.lightBeam, opts.time);
    if (opts.sniffBeam) this._drawSniffBeam(ctx, opts.sniffBeam, opts.time);

    for (const ant of snap.ants) {
      if (this._shouldHideAntInNest(ant, snap.nest, opts)) continue;
      if (ant.hiding && opts.role === ROLE.SEEKER) {
        this._drawAntShadow(ctx, ant, opts);
      } else {
        this._drawAnt(ctx, ant, opts);
      }
    }
    // 隐藏者可见搜寻者鼠标位置（大手）
    if (opts.role === ROLE.HIDER && snap.seekerCursor) {
      this._drawSeekerHand(ctx, snap.seekerCursor, opts.time);
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
        if (this._shouldHideAntInNest(ant, snap.nest, opts)) continue;
        const illum = this._beamIllumination(ant, opts.lightBeam);
        if (illum <= 0.06) continue;
        if (ant.hiding) this._drawAntShadow(ctx, ant, opts, illum);
        else this._drawAnt(ctx, ant, opts, illum);
      }
      ctx.restore();
    }
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

  /** 搜寻者不可见巢穴内的蚂蚁（遮蔽视野） */
  _shouldHideAntInNest(ant, nest, opts) {
    if (opts.role !== ROLE.SEEKER || !nest?.radius) return false;
    const dx = ant.x - nest.x, dy = ant.y - nest.y;
    return dx * dx + dy * dy < nest.radius * nest.radius;
  }

  /** 点是否在巢穴区域内（用于遮蔽内部细节） */
  _isPointInNest(x, y, nest) {
    if (!nest?.radius) return false;
    const dx = x - nest.x, dy = y - nest.y;
    return dx * dx + dy * dy < nest.radius * nest.radius;
  }

  /** 绘制躲藏点区域：隐藏者见完整提示，搜寻者见暗色遮蔽区 */
  _drawHidingSpots(ctx, spots, opts) {
    if (!spots?.length) return;
    const isSeeker = opts?.role === ROLE.SEEKER;
    for (const spot of spots) {
      const r = spot.radius || 45;
      ctx.beginPath();
      ctx.arc(spot.x, spot.y, r, 0, Math.PI * 2);
      if (isSeeker) {
        ctx.fillStyle = 'rgba(18,14,8,0.72)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,48,32,0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // 遮蔽纹理：几条斜线暗示缝隙
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1.5;
        for (let i = -r; i < r; i += 14) {
          ctx.beginPath();
          ctx.moveTo(spot.x + i, spot.y - r);
          ctx.lineTo(spot.x + i + r * 0.6, spot.y + r);
          ctx.stroke();
        }
        ctx.restore();
      } else {
        const pulse = 0.92 + 0.08 * Math.sin(opts.time / 900 + spot.x);
        ctx.fillStyle = `rgba(35,50,28,${(0.55 * pulse).toFixed(3)})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(100,140,80,${(0.65 * pulse).toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = '#9bc48a';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('躲藏', spot.x, spot.y - r * 0.55);
      }
    }
  }

  /**
   * 搜寻者视角：躲藏点内蚂蚁的影子（无外观特征，仅轮廓）
   * @param illum 强光照明强度 0-1，提亮影子便于辨认
   */
  _drawAntShadow(ctx, ant, opts, illum = 0) {
    const flicker = 0.55 + 0.12 * Math.sin(opts.time / 220 + ant.id * 1.7);
    const alpha = Math.min(0.85, flicker + illum * 0.35);
    ctx.save();
    ctx.translate(ant.x, ant.y);
    ctx.rotate(ant.angle + Math.PI / 2);
    if (illum > 0.1) {
      ctx.shadowColor = `rgba(255,240,200,${(0.3 + illum * 0.4).toFixed(2)})`;
      ctx.shadowBlur = 3 + illum * 8;
    }
    ctx.fillStyle = `rgba(8,6,4,${alpha.toFixed(3)})`;
    // 简化蚁形剪影：头 + 腹
    ctx.beginPath();
    ctx.ellipse(0, 7, 5.5, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -7, 4.5, 0, Math.PI * 2);
    ctx.fill();
    // 腿影
    ctx.strokeStyle = `rgba(6,4,2,${(alpha * 0.9).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(s * 9, s * 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawNest(ctx, nest, opts) {
    if (!nest) return;
    const r = nest.radius || 40;
    const isSeeker = opts?.role === ROLE.SEEKER;
    ctx.beginPath();
    ctx.arc(nest.x, nest.y, r, 0, Math.PI * 2);
    if (isSeeker) {
      // 搜寻者只见不透光外壳，巢内结构（堆放点等）不可见
      ctx.fillStyle = '#241709';
      ctx.fill();
      ctx.strokeStyle = '#c89830';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#e0a93b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('巢穴', nest.x, nest.y - r * 0.55);
      return;
    }
    ctx.fillStyle = 'rgba(45,28,12,0.92)';
    ctx.fill();
    ctx.strokeStyle = '#e0a93b';
    ctx.lineWidth = 3;
    ctx.stroke();
    // 巢内食物堆放点（仅隐藏者可见）
    const dep = nest.deposit;
    if (dep) {
      ctx.beginPath();
      ctx.arc(dep.x, dep.y, dep.radius || 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(90,61,31,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(143,179,107,0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(dep.x, dep.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#8fb36b';
      ctx.fill();
    }
    ctx.fillStyle = '#e0a93b';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('巢穴', nest.x, nest.y - r * 0.35);
  }

  /**
   * 绘制信息素场（地面层）。
   * toFood（青色）：引导搜寻者前往食物的轨迹。
   * toHome（品红）：引导搬运者回巢的轨迹。
   * 两层叠加后呈现出蚁群真实走廊的双向颜色。
   */
  _drawPheromone(ctx, phero, nest, opts) {
    const { cols, rows, cell, toFood, toHome } = phero;
    const maskNest = opts?.role === ROLE.SEEKER;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const f = toFood[i];   // 0-255
        const h = toHome[i];   // 0-255
        if (f < 4 && h < 4) continue; // 跳过空格（性能优化）
        const x = c * cell, y = r * cell;
        // 搜寻者不可见巢内信息素轨迹
        if (maskNest && this._isPointInNest(x + cell * 0.5, y + cell * 0.5, nest)) continue;
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

  /**
   * 绘制假食物：本体与真食物相同；仅搜寻者叠加剩余时长圆环。
   */
  _drawFakeFood(ctx, food, opts) {
    if (!food?.length) return;
    const isSeeker = opts.role === ROLE.SEEKER && !opts.spectator;
    const lifetime = opts.world?.tools?.fakeFood?.lifetime ?? 40;
    for (const f of food) {
      this._drawFoodPile(ctx, f);
      if (!isSeeker) continue;
      const ratio = (f.capacity > 0) ? f.amount / f.capacity : 0;
      const r = 4 + ratio * 8;
      const lifeLeft = f.lifeLeft ?? lifetime;
      const lifeRatio = lifetime > 0 ? Math.max(0, Math.min(1, lifeLeft / lifetime)) : 0;
      if (lifeRatio <= 0) continue;
      const ringR = r + 12;
      ctx.beginPath();
      ctx.arc(f.x, f.y, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * lifeRatio);
      ctx.strokeStyle = '#8fb36b';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  /** 绘制单个食物堆：按剩余量/容量比例决定圆点大小与颜色深浅 */
  _drawFoodPile(ctx, f, type = f.type || 'normal') {
    if (f.amount <= 0) return;
    const isRich = type === 'rich';
    const ratio = (f.capacity > 0) ? f.amount / f.capacity : 0;
    const r = isRich ? 6 + ratio * 10 : 4 + ratio * 8;
    const alpha = 0.4 + ratio * 0.6;
    const fill = isRich ? `rgba(224,169,59,${alpha.toFixed(2)})` : `rgba(143,179,107,${alpha.toFixed(2)})`;
    const stroke = isRich ? `rgba(255,220,120,${(alpha * 0.7).toFixed(2)})` : `rgba(200,230,160,${(alpha * 0.6).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = isRich ? 2 : 1.5;
    ctx.stroke();
    if (isRich) {
      const label = `×${f.score || 3}`;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,16,10,0.85)';
      ctx.strokeText(label, f.x, f.y);
      ctx.fillStyle = '#fff4d0';
      ctx.fillText(label, f.x, f.y);
    }
  }

  /** 绘制可枯竭食物堆 */
  _drawNormalFood(ctx, food) {
    if (!food) return;
    for (const f of food) this._drawFoodPile(ctx, f);
  }

  /** 绘制光束工具瞄准预览：选中待施放时跟随鼠标显示生效范围 */
  _drawToolRangePreview(ctx, preview, time) {
    const { tool, x, y } = preview;
    const r = preview.radius || (tool === 'sniff' ? 100 : 120);
    const pulse = 0.75 + 0.25 * Math.sin(time / 100);
    const isSniff = tool === 'sniff';

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isSniff
      ? `rgba(80,200,220,${(0.07 * pulse).toFixed(3)})`
      : `rgba(255,220,100,${(0.09 * pulse).toFixed(3)})`;
    ctx.fill();

    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = isSniff
      ? `rgba(100,210,230,${(0.55 * pulse).toFixed(3)})`
      : `rgba(255,230,150,${(0.6 * pulse).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = isSniff
      ? `rgba(120,220,240,${(0.75 * pulse).toFixed(3)})`
      : `rgba(255,240,180,${(0.8 * pulse).toFixed(3)})`;
    ctx.fill();
  }

  /** 绘制气息嗅探圈：发现目标时变为红色警告色 */
  _drawSniffBeam(ctx, beam, time) {
    const warn = !!beam.hiderDetected;
    const pulse = warn
      ? 0.7 + 0.3 * Math.sin(time / 60)
      : 0.85 + 0.15 * Math.sin(time / 120);
    const r = beam.radius || 100;
    const grad = ctx.createRadialGradient(beam.x, beam.y, r * 0.2, beam.x, beam.y, r);
    if (warn) {
      grad.addColorStop(0, `rgba(255,90,60,${(0.35 * pulse).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(255,50,40,${(0.18 * pulse).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(255,40,30,0)');
    } else {
      grad.addColorStop(0, `rgba(80,200,220,${(0.22 * pulse).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(60,170,200,${(0.1 * pulse).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(40,150,180,0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = warn
      ? `rgba(255,80,50,${(0.65 * pulse).toFixed(3)})`
      : `rgba(100,210,230,${(0.4 * pulse).toFixed(3)})`;
    ctx.lineWidth = warn ? 3 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(beam.x, beam.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = warn ? `rgba(255,120,80,${pulse.toFixed(3)})` : `rgba(120,220,240,${pulse.toFixed(3)})`;
    ctx.fill();
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
    // 隐藏者方：己方与同队隐藏者显示标识色；搜寻者仅对已获证隐藏者显示真色
    if (ant.hiderColor && (opts.role === ROLE.HIDER || ant.verified)) body = ant.hiderColor;
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

    // 搬运时在头部前方显示食物（珍稀食物为金色且更大）
    if (ant.carrying) {
      const isRich = ant.carryingType === 'rich';
      ctx.beginPath();
      ctx.arc(0, -r.head - 8, isRich ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isRich ? '#e0a93b' : '#8fb36b';
      ctx.fill();
      ctx.strokeStyle = isRich ? '#ffe080' : '#c8e6a0';
      ctx.lineWidth = isRich ? 1.6 : 1.2;
      ctx.stroke();
    }

    // 触角 (antenna)
    this._drawAntennae(ctx, tr.antenna, r, illum);

    ctx.restore();

    // 被标记冻结 + 复活倒计时
    if (ant.marked) {
      ctx.strokeStyle = '#d6543c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ant.x - 8, ant.y - 8); ctx.lineTo(ant.x + 8, ant.y + 8);
      ctx.moveTo(ant.x + 8, ant.y - 8); ctx.lineTo(ant.x - 8, ant.y + 8); ctx.stroke();
      const left = Math.ceil(ant.markedLeft ?? 0);
      if (left > 0) {
        const canRespawn = (ant.lives ?? 0) > 0 && !ant.eliminated;
        ctx.fillStyle = '#d6543c';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(canRespawn ? `复活 ${left}s` : `冻结 ${left}s`, ant.x, ant.y - 22);
      }
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

  /** 隐藏者视角：绘制搜寻者鼠标位置（俯视大手） */
  _drawSeekerHand(ctx, cursor, time) {
    const pulse = 0.94 + 0.06 * Math.sin(time / 140);
    ctx.save();
    ctx.translate(cursor.x, cursor.y);
    ctx.scale(pulse, pulse);

    // 投影
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(3, 5, 24, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // 掌心
    ctx.fillStyle = '#f2c49a';
    ctx.strokeStyle = '#b8845c';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.ellipse(0, 4, 20, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 四指（指向地图上方）
    const fingerW = 7;
    const fingerH = 22;
    const fingerY = -14;
    for (let i = 0; i < 4; i++) {
      const fx = -10.5 + i * 7;
      ctx.beginPath();
      ctx.ellipse(fx, fingerY - fingerH / 2, fingerW / 2, fingerH / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 拇指（侧向伸出）
    ctx.save();
    ctx.translate(-18, 2);
    ctx.rotate(-0.55);
    ctx.beginPath();
    ctx.ellipse(0, -8, fingerW / 2, fingerH / 2 - 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }
}
