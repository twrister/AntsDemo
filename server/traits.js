// 外观破绽系统 (GDD 3.1)：每只蚂蚁 5 个可变维度。
// 隐藏者附身宿主模板时，完美继承 4 个维度，第 5 个有「一个等级」的偏差。

// 各维度可能状态数（用索引表示，渲染端据此画出差异）
export const TRAIT_DIMS = {
  antenna: 4,   // 触角弯曲度：直/微内弯/微外弯/钩状
  stripe: 5,    // 腹部条纹：无/单条/双条/锯齿/斑点
  tint: 5,      // 胸甲色调偏移：5 个等级
  gait: 4,      // 步态摇摆：僵硬/轻微/大幅/不规则
  ratio: 4,     // 头身比例：小/正常/大/方正
};

const DIM_KEYS = Object.keys(TRAIT_DIMS);

function randInt(n) { return Math.floor(Math.random() * n); }

// 生成一组随机特征
export function randomTraits() {
  const t = {};
  for (const k of DIM_KEYS) t[k] = randInt(TRAIT_DIMS[k]);
  return t;
}

/**
 * 基于宿主模板派生隐藏者外观：复制全部特征，随机挑 1 个维度偏移一个等级。
 * 返回 { traits, devDim } —— devDim 标记产生偏差的维度（仅服务器/调试用）。
 */
export function deriveHiderTraits(host) {
  const traits = { ...host };
  const dim = DIM_KEYS[randInt(DIM_KEYS.length)];
  const max = TRAIT_DIMS[dim];
  // 朝可用方向偏移一个等级
  const dir = traits[dim] >= max - 1 ? -1 : (traits[dim] <= 0 ? 1 : (Math.random() < 0.5 ? 1 : -1));
  traits[dim] = traits[dim] + dir;
  return { traits, devDim: dim };
}
