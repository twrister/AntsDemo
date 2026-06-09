// 开发者工具自定义默认值：落盘存储，所有客户端/端口共用。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(__dirname, 'data', 'devDefaults.json');

/** @type {Record<string, unknown>|null} */
let saved = null;

/** 启动时从磁盘加载已保存的默认值 */
export function loadDevDefaultsFromDisk() {
  try {
    if (fs.existsSync(DEFAULTS_PATH)) {
      saved = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[devDefaults] 读取失败:', e.message);
    saved = null;
  }
  return saved;
}

/** 读取当前已保存的默认值（可能为 null） */
export function getDevDefaults() {
  return saved;
}

/**
 * 保存并落盘开发者工具默认值。
 * @param {Record<string, unknown>} cfg
 */
export function setDevDefaults(cfg) {
  const normalized = normalizeDevDefaults(cfg);
  fs.mkdirSync(path.dirname(DEFAULTS_PATH), { recursive: true });
  fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(normalized, null, 2), 'utf8');
  saved = normalized;
  return saved;
}

/** 去掉无关字段，仅保留调参键 */
function normalizeDevDefaults(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const { type, ...rest } = cfg;
  const out = { ...rest };
  if (rest.AI_SPEED && typeof rest.AI_SPEED === 'object') {
    out.AI_SPEED = { ...rest.AI_SPEED };
  }
  if (rest.TOOL_CD && typeof rest.TOOL_CD === 'object') {
    out.TOOL_CD = { ...rest.TOOL_CD };
  }
  return out;
}
