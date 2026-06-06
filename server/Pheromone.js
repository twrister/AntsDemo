// 双层信息素场：toFood（引导搜寻者找食物）与 toHome（引导搬运者回巢）。
// 基于离散网格（格元约 20px），支持三传感器采样、蒸发（负反馈）、封顶（正反馈饱和）。
import { CONFIG } from './config.js';

export class PheromoneField {
  constructor() {
    const { cell, worldW, worldH } = CONFIG.PHEROMONE;
    this.cell = cell;
    this.cols = Math.ceil(worldW / cell);
    this.rows = Math.ceil(worldH / cell);
    const size = this.cols * this.rows;
    // 两个通道：0=toFood 1=toHome
    this.data = [new Float32Array(size), new Float32Array(size)];
  }

  /** 在世界坐标 (x,y) 处向 channel(0/1) 累加 amount，封顶 FIELD_MAX */
  deposit(x, y, channel, amount) {
    const idx = this._idx(x, y);
    if (idx < 0) return;
    const max = CONFIG.PHEROMONE.FIELD_MAX;
    this.data[channel][idx] = Math.min(this.data[channel][idx] + amount, max);
  }

  /**
   * 在 (x,y) 前方 sensorAngle 偏转处、距离 dist 处采样 channel 的格值。
   * 用于三触角传感器（左偏、正前、右偏）。
   */
  sense(x, y, facing, sensorAngle, dist, channel) {
    const sx = x + Math.cos(facing + sensorAngle) * dist;
    const sy = y + Math.sin(facing + sensorAngle) * dist;
    const idx = this._idx(sx, sy);
    if (idx < 0) return 0;
    return this.data[channel][idx];
  }

  /**
   * 每帧蒸发：全场乘 (1 - evap*dt)，低于阈值归零（负反馈）。
   * 两通道蒸发率可分别调节（toFood 蒸发快 = 旧食源轨迹消散快）。
   */
  evaporate(dt) {
    const { evapToFood, evapToHome, EVAP_MIN } = CONFIG.PHEROMONE;
    const rates = [evapToFood, evapToHome];
    for (let ch = 0; ch < 2; ch++) {
      const arr = this.data[ch];
      const keep = 1 - rates[ch] * dt;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i] * keep;
        arr[i] = v < EVAP_MIN ? 0 : v;
      }
    }
  }

  /**
   * 生成低分辨率快照供网络下发，返回 { cols, rows, toFood, toHome }。
   * 降采样 factor 倍后量化到 0-255，减小带宽。
   */
  coarse() {
    const factor = CONFIG.PHEROMONE.coarseFactor;
    const cc = Math.ceil(this.cols / factor);
    const cr = Math.ceil(this.rows / factor);
    const size = cc * cr;
    const max = CONFIG.PHEROMONE.FIELD_MAX;
    const toFood = new Uint8Array(size);
    const toHome = new Uint8Array(size);
    for (let r = 0; r < cr; r++) {
      for (let c = 0; c < cc; c++) {
        let sumF = 0, sumH = 0, n = 0;
        for (let dr = 0; dr < factor; dr++) {
          for (let dc = 0; dc < factor; dc++) {
            const sr = r * factor + dr, sc = c * factor + dc;
            if (sr >= this.rows || sc >= this.cols) continue;
            const idx = sr * this.cols + sc;
            sumF += this.data[0][idx];
            sumH += this.data[1][idx];
            n++;
          }
        }
        const out = r * cc + c;
        toFood[out] = Math.min(255, Math.round((sumF / n / max) * 255));
        toHome[out] = Math.min(255, Math.round((sumH / n / max) * 255));
      }
    }
    return { cols: cc, rows: cr, cell: this.cell * factor, toFood, toHome };
  }

  _idx(x, y) {
    const c = Math.floor(x / this.cell);
    const r = Math.floor(y / this.cell);
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return -1;
    return r * this.cols + c;
  }
}
