// 入口：大厅流程（多房间）、对局渲染循环、结算。
import { Net } from './net.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { SeekerController } from './seeker.js';
import { HiderController } from './hider.js';
import { ROLE } from './const.js';

const net = new Net();
const canvas = document.getElementById('canvas');
const renderer = new Renderer(canvas);
const input = new Input(canvas);

let role = null;
let myPlayerId = null;
let myHostId = null;
let controller = null;
let world = null;
let running = false;
let showPheromone = false;

// ---- DOM helpers ----
const $ = (id) => document.getElementById(id);

/** 调试端口页面标记（debug.html 上 data-debug="true"） */
const DEBUG_MODE = document.body.dataset.debug === 'true';

const MATCH_DURATION_MIN = 1;
const MATCH_DURATION_MAX = 10;
const MATCH_DURATION_DEFAULT = 5;

const HIDER_FOOD_QUOTA_MIN = 1;
const HIDER_FOOD_QUOTA_MAX = 30;
const HIDER_FOOD_QUOTA_DEFAULT = 10;

// ---- 开发者工具（仅调试端口） ----

const AI_ANT_COUNT_MIN = 10;
const AI_ANT_COUNT_MAX = 200;

/** 各工具 CD 调试滑条元数据（与 server/config.js TOOLS 键名一致） */
const TOOL_CD_META = {
  panic: { label: '强光照射 CD', min: 0, max: 30, default: 30 },
  sniff: { label: '气息嗅探 CD', min: 0, max: 30, default: 20 },
  fakeFood: { label: '假食物 CD', min: 0, max: 60, default: 25 },
};

const MARK_COOLDOWN_MIN = 0;
const MARK_COOLDOWN_MAX = 5;
const MARK_COOLDOWN_DEFAULT = 3;

const BEAM_SPEED_MIN = 100;
const BEAM_SPEED_MAX = 1200;
const BEAM_SPEED_DEFAULT = 280;

const DEV_DEFAULTS = {
  AI_ANT_COUNT: 30,
  AI_SPEED_BASE: 60,
  AI_TURN_SMOOTH: 0.3,
  AI_SOCIAL_CHANCE: 0.05,
  AI_SPEED: { sprint: 1.5, carry: 0.8, carryRich: 0.5 },
  FOOD_COUNT: 5,
  FOOD_CAPACITY: 60,
  BEAM_SPEED: BEAM_SPEED_DEFAULT,
  SNIFF_RADIUS: 100,
  MARK_COOLDOWN: MARK_COOLDOWN_DEFAULT,
  TOOL_CD: Object.fromEntries(
    Object.entries(TOOL_CD_META).map(([k, m]) => [k, m.default]),
  ),
  DEBUG_NO_CD: false,
};

const DEV_STORAGE_KEY = 'antsDemo_devCfg';

/** 服务端保存的自定义默认值（所有版本/端口共用） */
let userDevDefaults = {};

function readToolCdFromDom() {
  const toolCd = {};
  for (const key of Object.keys(TOOL_CD_META)) {
    const inp = $(`devToolCd_${key}`);
    if (inp) toolCd[key] = parseInt(inp.value, 10);
  }
  return toolCd;
}

/** 归一化光束跟随速度（强光/嗅探共用） */
function normalizeBeamSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return BEAM_SPEED_DEFAULT;
  return Math.max(BEAM_SPEED_MIN, Math.min(BEAM_SPEED_MAX, Math.round(n)));
}

/** 归一化误标冷却（兼容旧版 min/max 区间配置） */
function normalizeMarkCooldown(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.max(MARK_COOLDOWN_MIN, Math.min(MARK_COOLDOWN_MAX, Math.round(v)));
  }
  if (v && typeof v === 'object') {
    const n = v.min ?? v.max ?? MARK_COOLDOWN_DEFAULT;
    return Math.max(MARK_COOLDOWN_MIN, Math.min(MARK_COOLDOWN_MAX, Math.round(+n)));
  }
  return MARK_COOLDOWN_DEFAULT;
}

function readMarkCooldownFromDom() {
  return normalizeMarkCooldown(parseInt($('devMarkCd')?.value ?? MARK_COOLDOWN_DEFAULT, 10));
}

function applyMarkCooldownToWorld(markCooldown) {
  if (world) world.markCooldown = normalizeMarkCooldown(markCooldown);
}

/** 合并内置与用户自定义默认值 */
function getEffectiveDevDefaults() {
  return {
    ...DEV_DEFAULTS,
    ...userDevDefaults,
    AI_SPEED: { ...DEV_DEFAULTS.AI_SPEED, ...(userDevDefaults.AI_SPEED || {}) },
    TOOL_CD: { ...DEV_DEFAULTS.TOOL_CD, ...(userDevDefaults.TOOL_CD || {}) },
    MARK_COOLDOWN: normalizeMarkCooldown(
      userDevDefaults.MARK_COOLDOWN ?? DEV_DEFAULTS.MARK_COOLDOWN,
    ),
    BEAM_SPEED: normalizeBeamSpeed(userDevDefaults.BEAM_SPEED ?? DEV_DEFAULTS.BEAM_SPEED),
  };
}

/** 归一化调参对象（含范围钳制） */
function normalizeDevConfig(raw) {
  const base = getEffectiveDevDefaults();
  const c = {
    ...base,
    ...raw,
    AI_SPEED: { ...base.AI_SPEED, ...(raw.AI_SPEED || {}) },
    TOOL_CD: { ...base.TOOL_CD, ...(raw.TOOL_CD || {}) },
    MARK_COOLDOWN: normalizeMarkCooldown(raw.MARK_COOLDOWN ?? base.MARK_COOLDOWN),
    BEAM_SPEED: normalizeBeamSpeed(raw.BEAM_SPEED ?? base.BEAM_SPEED),
  };
  c.AI_ANT_COUNT = Math.max(AI_ANT_COUNT_MIN, Math.min(AI_ANT_COUNT_MAX, c.AI_ANT_COUNT));
  return c;
}

/** 从 DOM 读取当前调参 */
function readDevConfigFromDom() {
  return {
    AI_ANT_COUNT: parseInt($('devAntCount').value, 10),
    AI_SPEED_BASE: parseFloat($('devSpeedBase').value),
    AI_TURN_SMOOTH: parseFloat($('devTurnSmooth').value),
    AI_SOCIAL_CHANCE: parseFloat($('devSocialChance').value),
    AI_SPEED: {
      sprint: parseFloat($('devSpeedSprint').value),
      carry: parseFloat($('devSpeedCarry').value),
      carryRich: parseFloat($('devSpeedCarryRich').value),
    },
    FOOD_COUNT: parseInt($('devFoodCount').value, 10),
    FOOD_CAPACITY: parseInt($('devFoodCapacity').value, 10),
    BEAM_SPEED: normalizeBeamSpeed(parseInt($('devBeamSpeed').value, 10)),
    SNIFF_RADIUS: parseInt($('devSniffRadius').value, 10),
    TOOL_CD: readToolCdFromDom(),
    MARK_COOLDOWN: readMarkCooldownFromDom(),
    DEBUG_NO_CD: $('devNoCdCheck').checked,
  };
}

function persistDevConfig() {
  if (!DEBUG_MODE) return;
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(readDevConfigFromDom()));
}

function applyBeamSpeedToWorld(beamSpeed) {
  if (world?.tools?.panic) world.tools.panic.beamSpeed = beamSpeed;
  if (world?.tools?.sniff) world.tools.sniff.beamSpeed = beamSpeed;
}

/** 将嗅探圈半径同步到客户端 world 配置 */
function applySniffRadiusToWorld(radius) {
  if (world?.tools?.sniff) world.tools.sniff.radius = radius;
}

/** 将各工具 CD 同步到客户端 world 配置 */
function applyToolCdToWorld(toolCd) {
  if (!world?.tools || !toolCd) return;
  for (const [key, cd] of Object.entries(toolCd)) {
    if (world.tools[key]) world.tools[key].cd = cd;
  }
}

/** 服务器全局调参推送：同步 3000 联机端的工具展示与光束参数 */
function applyDevToolsFromServer(m) {
  if (!world) return;
  if (m.tools) {
    world.tools = world.tools || {};
    for (const [key, def] of Object.entries(m.tools)) {
      world.tools[key] = { ...world.tools[key], ...def };
    }
  }
  if (m.noToolCd !== undefined) {
    world.noToolCd = !!m.noToolCd;
    if (controller?.noToolCd !== undefined) controller.noToolCd = !!m.noToolCd;
  }
  if (m.markCooldown !== undefined) applyMarkCooldownToWorld(m.markCooldown);
}

/** 将调参写入开发者面板 DOM 并同步到本地 world */
function applyDevConfigToDom(c) {
  $('devAntCount').min = AI_ANT_COUNT_MIN;
  $('devAntCount').max = AI_ANT_COUNT_MAX;
  $('devAntCount').value = c.AI_ANT_COUNT;
  $('devAntCountVal').textContent = c.AI_ANT_COUNT;
  $('devSpeedBase').value = c.AI_SPEED_BASE;
  $('devSpeedBaseVal').textContent = c.AI_SPEED_BASE;
  $('devTurnSmooth').value = c.AI_TURN_SMOOTH;
  $('devTurnSmoothVal').textContent = c.AI_TURN_SMOOTH.toFixed(2);
  $('devSocialChance').value = c.AI_SOCIAL_CHANCE;
  $('devSocialChanceVal').textContent = c.AI_SOCIAL_CHANCE.toFixed(3);
  $('devSpeedSprint').value = c.AI_SPEED.sprint;
  $('devSpeedSprintVal').textContent = c.AI_SPEED.sprint.toFixed(2);
  $('devSpeedCarry').value = c.AI_SPEED.carry;
  $('devSpeedCarryVal').textContent = c.AI_SPEED.carry.toFixed(2);
  $('devSpeedCarryRich').value = c.AI_SPEED.carryRich;
  $('devSpeedCarryRichVal').textContent = c.AI_SPEED.carryRich.toFixed(2);
  $('devFoodCount').value = c.FOOD_COUNT;
  $('devFoodCountVal').textContent = c.FOOD_COUNT;
  $('devFoodCapacity').value = c.FOOD_CAPACITY;
  $('devFoodCapacityVal').textContent = c.FOOD_CAPACITY;
  $('devBeamSpeed').value = c.BEAM_SPEED;
  $('devBeamSpeedVal').textContent = c.BEAM_SPEED;
  $('devSniffRadius').value = c.SNIFF_RADIUS;
  $('devSniffRadiusVal').textContent = c.SNIFF_RADIUS;
  for (const [key, meta] of Object.entries(TOOL_CD_META)) {
    const inp = $(`devToolCd_${key}`);
    const valEl = $(`devToolCd_${key}Val`);
    if (!inp || !valEl) continue;
    const cd = Math.max(meta.min, Math.min(meta.max, c.TOOL_CD[key] ?? meta.default));
    inp.value = cd;
    valEl.textContent = cd;
  }
  $('devNoCdCheck').checked = !!c.DEBUG_NO_CD;
  if ($('devMarkCd')) {
    $('devMarkCd').value = c.MARK_COOLDOWN;
    $('devMarkCdVal').textContent = c.MARK_COOLDOWN;
  }
  applyBeamSpeedToWorld(c.BEAM_SPEED);
  applySniffRadiusToWorld(c.SNIFF_RADIUS);
  applyToolCdToWorld(c.TOOL_CD);
  applyMarkCooldownToWorld(c.MARK_COOLDOWN);
}

function restoreDevConfig() {
  if (!DEBUG_MODE) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(DEV_STORAGE_KEY) || '{}'); } catch (_) {}
  applyDevConfigToDom(normalizeDevConfig(saved));
}

/** 从服务端拉取共用默认值 */
async function fetchUserDevDefaults() {
  try {
    const res = await fetch('/api/dev-defaults');
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data === 'object') userDevDefaults = data;
  } catch (_) {}
}

/** 将当前调参保存为服务端共用默认值 */
async function saveUserDevDefaults() {
  const cfg = readDevConfigFromDom();
  try {
    const res = await fetch('/api/dev-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error('save failed');
    userDevDefaults = await res.json();
    toast('已保存为默认值', 'good');
  } catch {
    toast('保存默认值失败', 'bad');
  }
}

function sendDevConfig() {
  if (!DEBUG_MODE) return;
  persistDevConfig();
  net.send({
    type: 'dev_config',
    AI_SPEED_BASE: parseFloat($('devSpeedBase').value),
    AI_TURN_SMOOTH: parseFloat($('devTurnSmooth').value),
    AI_SOCIAL_CHANCE: parseFloat($('devSocialChance').value),
    AI_ANT_COUNT: parseInt($('devAntCount').value, 10),
    AI_SPEED: {
      sprint: parseFloat($('devSpeedSprint').value),
      carry: parseFloat($('devSpeedCarry').value),
      carryRich: parseFloat($('devSpeedCarryRich').value),
    },
    FOOD_COUNT: parseInt($('devFoodCount').value, 10),
    FOOD_CAPACITY: parseInt($('devFoodCapacity').value, 10),
    BEAM_SPEED: normalizeBeamSpeed(parseInt($('devBeamSpeed').value, 10)),
    SNIFF_RADIUS: parseInt($('devSniffRadius').value, 10),
    TOOL_CD: readToolCdFromDom(),
    MARK_COOLDOWN: readMarkCooldownFromDom(),
    DEBUG_NO_CD: $('devNoCdCheck').checked,
  });
  applyBeamSpeedToWorld(normalizeBeamSpeed(parseInt($('devBeamSpeed').value, 10)));
  applySniffRadiusToWorld(parseInt($('devSniffRadius').value, 10));
  applyToolCdToWorld(readToolCdFromDom());
  applyMarkCooldownToWorld(readMarkCooldownFromDom());
}

function bindSlider(id, valId, decimals) {
  const inp = $(id);
  const valEl = $(valId);
  if (!inp || !valEl) return;
  let timer = null;
  inp.addEventListener('input', () => {
    const n = parseFloat(inp.value);
    valEl.textContent = decimals === 0 ? String(Math.round(n)) : n.toFixed(decimals);
    clearTimeout(timer);
    timer = setTimeout(sendDevConfig, 16);
  });
}

/** 动态生成各工具 CD 调试滑条 */
function buildDevToolCdSliders() {
  const host = $('devToolCdRows');
  if (!host) return;
  host.innerHTML = '';
  for (const [key, meta] of Object.entries(TOOL_CD_META)) {
    const row = document.createElement('div');
    row.className = 'dev-row';
    row.innerHTML = `
      <span class="dev-label">${meta.label}<span class="dev-range-hint">${meta.min} – ${meta.max} s</span></span>
      <input type="range" id="devToolCd_${key}" min="${meta.min}" max="${meta.max}" step="1" value="${meta.default}" />
      <span class="dev-val" id="devToolCd_${key}Val">${meta.default}</span>
    `;
    host.appendChild(row);
    bindSlider(`devToolCd_${key}`, `devToolCd_${key}Val`, 0);
  }
}

if (DEBUG_MODE) {
  buildDevToolCdSliders();
  fetchUserDevDefaults().then(() => restoreDevConfig());
  bindSlider('devAntCount', 'devAntCountVal', 0);
  bindSlider('devSpeedBase', 'devSpeedBaseVal', 0);
  bindSlider('devTurnSmooth', 'devTurnSmoothVal', 2);
  bindSlider('devSocialChance', 'devSocialChanceVal', 3);
  bindSlider('devSpeedSprint', 'devSpeedSprintVal', 2);
  bindSlider('devSpeedCarry', 'devSpeedCarryVal', 2);
  bindSlider('devSpeedCarryRich', 'devSpeedCarryRichVal', 2);
  bindSlider('devFoodCount', 'devFoodCountVal', 0);
  bindSlider('devFoodCapacity', 'devFoodCapacityVal', 0);
  bindSlider('devBeamSpeed', 'devBeamSpeedVal', 0);
  bindSlider('devSniffRadius', 'devSniffRadiusVal', 0);
  bindSlider('devMarkCd', 'devMarkCdVal', 0);

  $('devSaveDefaults').addEventListener('click', () => saveUserDevDefaults());
  $('devReset').addEventListener('click', () => {
    localStorage.removeItem(DEV_STORAGE_KEY);
    applyDevConfigToDom(getEffectiveDevDefaults());
    sendDevConfig();
  });

  $('devPheroCheck').addEventListener('change', () => {
    setPheroVisible($('devPheroCheck').checked);
  });

  $('devNoCdCheck').addEventListener('change', sendDevConfig);

  function toggleDevPanel() { $('devPanel').classList.toggle('hidden'); }
  $('devPanelBtn').addEventListener('click', toggleDevPanel);
  $('devClose').addEventListener('click', () => $('devPanel').classList.add('hidden'));
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') { e.preventDefault(); toggleDevPanel(); }
  });
}

/** 切换信息素可视化（仅调试模式可用） */
function setPheroVisible(visible) {
  if (!DEBUG_MODE) {
    showPheromone = false;
    return;
  }
  showPheromone = visible;
  const devCheck = $('devPheroCheck');
  if (devCheck) devCheck.checked = visible;
  const btn = $('pheroToggleBtn');
  if (!btn) return;
  btn.textContent = visible ? '信息素' : '信息素(关)';
  btn.classList.toggle('phero-on', visible);
  btn.classList.toggle('phero-off', !visible);
}

if (DEBUG_MODE) {
  const pheroBtn = $('pheroToggleBtn');
  if (pheroBtn) {
    pheroBtn.addEventListener('click', () => setPheroVisible(!showPheromone));
    setPheroVisible(showPheromone);
  }
}

// ---- 对局时长（房主可配置 1~10 分钟） ----

let syncingMatchDuration = false;

/** 初始化对局时长下拉选项 */
function initMatchDurationSelect() {
  const sel = $('matchDurationSelect');
  if (!sel || sel.options.length > 0) return;
  for (let m = MATCH_DURATION_MIN; m <= MATCH_DURATION_MAX; m++) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = `${m} 分钟`;
    sel.appendChild(opt);
  }
  sel.value = String(MATCH_DURATION_DEFAULT);
}

/** 根据大厅状态更新对局时长控件 */
function updateMatchDurationUi(minutes, isHost) {
  const sel = $('matchDurationSelect');
  if (!sel) return;
  const m = Math.max(MATCH_DURATION_MIN, Math.min(MATCH_DURATION_MAX, minutes || MATCH_DURATION_DEFAULT));
  syncingMatchDuration = true;
  sel.value = String(m);
  syncingMatchDuration = false;
  sel.disabled = !isHost;
}

initMatchDurationSelect();
$('matchDurationSelect')?.addEventListener('change', () => {
  if (syncingMatchDuration) return;
  const minutes = parseInt($('matchDurationSelect').value, 10);
  net.send({ type: 'set_match_duration', minutes });
});

// ---- 获胜食物数（房主可配置 1~30，默认 10） ----

let syncingHiderFoodQuota = false;

/** 初始化获胜食物数下拉选项 */
function initHiderFoodQuotaSelect() {
  const sel = $('hiderFoodQuotaSelect');
  if (!sel || sel.options.length > 0) return;
  for (let q = HIDER_FOOD_QUOTA_MIN; q <= HIDER_FOOD_QUOTA_MAX; q++) {
    const opt = document.createElement('option');
    opt.value = String(q);
    opt.textContent = `${q} 份`;
    sel.appendChild(opt);
  }
  sel.value = String(HIDER_FOOD_QUOTA_DEFAULT);
}

/** 根据大厅状态更新获胜食物数控件 */
function updateHiderFoodQuotaUi(quota, isHost) {
  const sel = $('hiderFoodQuotaSelect');
  if (!sel) return;
  const q = Math.max(HIDER_FOOD_QUOTA_MIN, Math.min(HIDER_FOOD_QUOTA_MAX, quota || HIDER_FOOD_QUOTA_DEFAULT));
  syncingHiderFoodQuota = true;
  sel.value = String(q);
  syncingHiderFoodQuota = false;
  sel.disabled = !isHost;
}

initHiderFoodQuotaSelect();
$('hiderFoodQuotaSelect')?.addEventListener('change', () => {
  if (syncingHiderFoodQuota) return;
  const quota = parseInt($('hiderFoodQuotaSelect').value, 10);
  net.send({ type: 'set_hider_food_quota', quota });
});

// ---- 连接 ----

async function ensureConnected() {
  if (!net.ws) {
    await net.connect();
    // 调试端口连接后立即推送本地调参，使 3000 正式服开局能读到同一份全局配置
    if (DEBUG_MODE) sendDevConfig();
  }
}

// ---- 房间浏览 ----

let roomNameCustomized = false;
let syncingRoomName = false;

/** 根据昵称生成默认房间名 */
function defaultRoomName(name) {
  return `${name || '玩家'}的房间`;
}

/** 未自定义时，将房间名同步为「昵称的房间」 */
function syncAutoRoomName() {
  if (roomNameCustomized) return;
  const name = $('nameInput').value.trim();
  syncingRoomName = true;
  $('roomNameInput').value = name ? defaultRoomName(name) : '';
  syncingRoomName = false;
}

/** 渲染房间列表（表格式） */
function renderRoomList(rooms) {
  const el = $('roomList');
  if (!rooms || rooms.length === 0) {
    el.innerHTML = '<p class="empty-hint">暂无房间，创建一个吧</p>';
    return;
  }
  el.innerHTML = '';
  for (const r of rooms) {
    const item = document.createElement('div');
    item.className = 'room-item';
    const stateText = r.state === 'playing' ? '对局中' : r.state === 'ended' ? '已结束' : '等待中';
    const stateClass = r.state === 'playing' ? 'playing' : '';
    const durTag = r.matchMinutes ? ` · ${r.matchMinutes}分` : '';
    const quotaTag = r.hiderFoodQuota ? ` · ${r.hiderFoodQuota}食` : '';
    item.innerHTML = `
      <span class="room-item-name col-name">${escapeHtml(r.name)}${durTag}${quotaTag}</span>
      <span class="col-host">${escapeHtml(r.hostName)}</span>
      <span class="col-count">${r.count}</span>
      <span class="room-item-state col-state ${stateClass}">${stateText}</span>
      <span class="col-action">
        <button class="join-btn" ${r.state === 'playing' ? 'disabled title="对局进行中"' : ''}>加入</button>
      </span>
    `;
    item.querySelector('.join-btn').addEventListener('click', () => joinRoom(r.id));
    el.appendChild(item);
  }
}

$('nameInput').addEventListener('input', syncAutoRoomName);
$('roomNameInput').addEventListener('input', () => {
  if (syncingRoomName) return;
  roomNameCustomized = true;
});
$('roomNameInput').addEventListener('blur', () => {
  if (!$('roomNameInput').value.trim()) {
    roomNameCustomized = false;
    syncAutoRoomName();
  }
});

$('createRoomBtn').addEventListener('click', createRoom);
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });

async function createRoom() {
  await ensureConnected();
  const name = $('nameInput').value.trim() || '玩家';
  const roomName = $('roomNameInput').value.trim() || `${name}的房间`;
  net.send({ type: 'create_room', name, roomName });
}

async function joinRoom(roomId) {
  await ensureConnected();
  const name = $('nameInput').value.trim() || '玩家';
  net.send({ type: 'join_room', name, roomId });
}

// ---- 单机模式（正式服与调试服均可；DEV 面板仅调试服） ----

const soloSeekerBtn = $('soloSeekerBtn');
const soloHiderBtn = $('soloHiderBtn');
if (soloSeekerBtn) soloSeekerBtn.addEventListener('click', () => startSolo(ROLE.SEEKER));
if (soloHiderBtn) soloHiderBtn.addEventListener('click', () => startSolo(ROLE.HIDER));

async function startSolo(soloRole) {
  await ensureConnected();
  const name = $('nameInput').value.trim() || (DEBUG_MODE ? '调试' : '玩家');
  net.send({ type: 'solo_start', name, role: soloRole });
}

// ---- 房间内操作 ----

$('leaveRoomBtn').addEventListener('click', () => {
  net.send({ type: 'leave_room' });
  showLobbyView('browser');
});

$('readyBtn').addEventListener('click', () => net.send({ type: 'ready' }));

$('switchSeekerBtn').addEventListener('click', () => net.send({ type: 'switch_role', role: ROLE.SEEKER }));
$('switchHiderBtn').addEventListener('click', () => net.send({ type: 'switch_role', role: ROLE.HIDER }));

$('startGameBtn').addEventListener('click', () => net.send({ type: 'start_game' }));

// ---- 结算 ----

$('restartBtn').addEventListener('click', () => {
  net.send({ type: 'restart' });
  // 结算后回大厅会收到 lobby 消息（room 还在），直接回到 room 视图
  resetGameUi();
  showScreen('lobby');
  showLobbyView('room');
});

// ---- 消息处理 ----

net.on('room_list', (m) => {
  renderRoomList(m.rooms);
});

net.on('welcome', (m) => {
  myPlayerId = m.playerId;
  myHostId = m.hostId;
  role = m.role;
  $('roomTitle').textContent = m.roomName;
  updateMyRoleLine();
  showLobbyView('room');
});

net.on('lobby', (m) => {
  myHostId = m.hostId;
  $('roomTitle').textContent = m.roomName;

  // 玩家列表
  const list = $('playerList');
  list.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const r = p.role === ROLE.SEEKER
      ? '<span class="role-seeker">搜寻者</span>'
      : '<span class="role-hider">隐藏者</span>';
    const hostTag = p.isHost ? ' 👑' : '';
    const readyTag = p.ready ? '✓ 已准备' : '…';
    li.innerHTML = `<span>${escapeHtml(p.name)}${hostTag} · ${r}</span><span>${readyTag}</span>`;
    list.appendChild(li);
  }

  // 更新自己的角色（可能被服务器变更）
  const me = m.players.find(p => p.id === myPlayerId);
  if (me) {
    role = me.role;
    updateMyRoleLine();
    // 切换角色按钮高亮当前角色
    $('switchSeekerBtn').classList.toggle('active-role', role === ROLE.SEEKER);
    $('switchHiderBtn').classList.toggle('active-role', role === ROLE.HIDER);
    // 准备按钮文字
    $('readyBtn').textContent = me.ready ? '取消准备' : '准备';
  }

  // 仅房主显示开始按钮
  const isHost = myPlayerId === m.hostId;
  $('startGameBtn').classList.toggle('hidden', !isHost);
  $('startGameBtn').disabled = !m.canStart;
  $('canStartHint').textContent = isHost && !m.canStart ? m.canStartReason : '';
  updateMatchDurationUi(m.matchDurationMin, isHost);
  updateHiderFoodQuotaUi(m.hiderFoodQuota, isHost);
});

net.on('dev_tools', applyDevToolsFromServer);

net.on('start', (m) => {
  role = m.role;
  world = m.world;
  restoreDevConfig();
  showScreen('game');
  if (world?.matchDuration) {
    const left = Math.ceil(world.matchDuration);
    $('timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  $('roleTag').textContent = role === ROLE.SEEKER ? '搜寻者' : '隐藏者';
  $('roleTag').className = 'hud-item ' + (role === ROLE.SEEKER ? 'role-seeker' : 'role-hider');
  if (role === ROLE.SEEKER) {
    controller = new SeekerController({ canvas, input, net, world });
  } else {
    controller = new HiderController({ canvas, input, net, world, antId: m.antId });
    $('toolbar').classList.add('hidden');
  }
  $('hiderScorePanel').classList.remove('hidden');
  running = true;
  sendDevConfig();
  requestAnimationFrame(loop);
});

net.on('events', (events) => {
  for (const e of events) handleEvent(e);
});

net.on('end', (m) => {
  running = false;
  controller = null;
  const won = m.winner === role;
  $('endTitle').textContent = won ? '胜利！' : '失败';
  $('endTitle').style.color = won ? 'var(--hider)' : 'var(--danger)';
  $('endReason').textContent = m.reason;
  renderEndStats(m);
  showScreen('end');
});

// ---- 渲染循环 ----

let lastT = performance.now();
function loop(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const snap = net.interpolated();
  if (snap && controller) {
    const opts = controller.update(snap, dt);
    renderer.draw(snap, opts.cam, { ...opts, role, world, time: now, showPheromone, foodActionTime: snap.foodActionTime });
    updateHud(snap);
  }
  requestAnimationFrame(loop);
}

function updateHud(snap) {
  const m = Math.floor(snap.timeLeft / 60), s = snap.timeLeft % 60;
  $('timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  updateLivesHud(snap);
  updateMarkTimer(snap);
  updateHiderScorePanel(snap);
  updateDevAntStats(snap);
}

/** 显示自身剩余生命（仅存活隐藏者） */
function updateLivesHud(snap) {
  const el = $('livesHud');
  if (!el) return;
  const self = snap.ants?.find(a => a.isSelf);
  if (role !== ROLE.HIDER || snap.selfEliminated || !self) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.textContent = `生命 ${self.lives ?? 3}`;
}

/** 被标记时显示复活倒计时（隐藏者 HUD + 搜寻者见蚂蚁头顶） */
function updateMarkTimer(snap) {
  const el = $('markTimer');
  if (!el) return;
  const self = snap.ants?.find(a => a.isSelf);
  const left = Math.ceil(self?.markedLeft ?? 0);
  const canRespawn = (self?.lives ?? 0) > 0 && !self?.eliminated;
  if (role === ROLE.HIDER && !snap.selfEliminated && self?.marked && left > 0) {
    el.classList.remove('hidden');
    el.textContent = canRespawn ? `复活 ${left}s` : `冻结 ${left}s`;
  } else {
    el.classList.add('hidden');
  }
}

/** 用 3 颗心表示剩余生命：实心 ♥ = 存活，空心 ♡ = 已失去 */
function formatLivesHearts(lives, eliminated = false, max = 3) {
  const n = eliminated ? 0 : Math.max(0, Math.min(max, lives ?? max));
  let html = '<span class="lives-hearts">';
  for (let i = 0; i < max; i++) {
    const filled = i < n;
    html += `<span class="heart ${filled ? 'filled' : 'empty'}">${filled ? '♥' : '♡'}</span>`;
  }
  return html + '</span>';
}

/** 渲染左上角各隐藏者获证进度 */
function updateHiderScorePanel(snap) {
  const panel = $('hiderScorePanel');
  if (!panel || !snap?.hiderScores?.length) {
    if (panel) panel.innerHTML = '';
    return;
  }
  const quota = snap.hiderQuota ?? snap.hiderScores[0]?.quota ?? 0;
  let html = `<div class="panel-title">隐藏者获证 ${quota > 0 ? `(目标 ${quota})` : ''}</div>`;
  for (const h of snap.hiderScores) {
    const cls = h.verified ? 'hider-score-row verified' : (h.eliminated ? 'hider-score-row eliminated' : 'hider-score-row');
    const dot = role === ROLE.HIDER && h.color
      ? `<span class="hider-color-dot" style="background:${h.color}"></span>`
      : '';
    const livesHearts = h.lives != null ? formatLivesHearts(h.lives, h.eliminated) : '';
    html += `<div class="${cls}">${dot}<span class="label">${escapeHtml(h.label)}</span>${livesHearts}<span class="progress">${h.score}/${h.quota}</span></div>`;
  }
  panel.innerHTML = html;
}

/** 渲染结算面板：搜寻者标记统计 + 各隐藏者生命/食物 */
function renderEndStats(m) {
  const el = $('endStats');
  if (!el) return;
  const quota = m.hiderQuota ?? 0;
  let html = '';

  const seekers = m.seekers ?? (m.seeker ? [m.seeker] : []);
  for (const s of seekers) {
    const miss = s.markMisses > 0
      ? `<span class="end-meta">误标 ${s.markMisses} 次</span>`
      : '';
    html += `<div class="end-section">
      <div class="end-section-title"><span class="role-seeker">搜寻者</span> ${escapeHtml(s.name)}</div>
      <div class="end-seeker-stats">
        <span class="end-stat">成功标记 <strong>${s.markHits}</strong> 次</span>${miss}
      </div>
    </div>`;
  }

  if (m.hiderScores?.length) {
    html += `<div class="end-section">
      <div class="end-section-title">隐藏者</div>
      <div class="end-hider-list">`;
    for (const h of m.hiderScores) {
      const cls = h.verified ? 'end-hider-row verified' : (h.eliminated ? 'end-hider-row eliminated' : 'end-hider-row');
      const status = h.verified ? '已获证' : (h.eliminated ? '已淘汰' : '进行中');
      const livesHearts = h.lives != null ? formatLivesHearts(h.lives, h.eliminated) : '';
      const dot = h.color
        ? `<span class="hider-color-dot" style="background:${h.color}"></span>`
        : '';
      html += `<div class="${cls}">
        ${dot}<span class="label">${escapeHtml(h.label)}</span>
        <span class="end-hider-detail">
          ${livesHearts}
          <span class="food">食物 ${h.score}/${h.quota ?? quota}</span>
          <span class="status">${status}</span>
        </span>
      </div>`;
    }
    html += '</div></div>';
  } else if (!seekers.length) {
    html = '<p class="end-empty">无对局数据</p>';
  }

  el.innerHTML = html;
}

function updateDevAntStats(snap) {
  if (!DEBUG_MODE) return;
  if (!snap?.antStats) {
    $('devStatAi').textContent = running ? '…' : '—';
    $('devStatHider').textContent = '—';
    $('devStatTotal').textContent = '—';
    return;
  }
  const { ai, hider, total } = snap.antStats;
  $('devStatAi').textContent = ai;
  $('devStatHider').textContent = hider;
  $('devStatTotal').textContent = total;
}

// ---- 工具事件 ----

function handleEvent(e) {
  switch (e.t) {
    case 'mark_hit': {
      const lives = e.lives ?? 0;
      const label = e.label || '隐藏者';
      if (role === ROLE.SEEKER) {
        toast(lives > 0 ? `标记命中！${label}剩余 ${lives} 条命` : `标记命中！${label}生命耗尽`, 'good');
      } else if (e.playerId === myPlayerId) {
        toast(lives > 0
          ? `你被标记了！剩余 ${lives} 条命，冻结 10 秒`
          : '你被标记了！生命耗尽，即将淘汰', 'bad');
      } else {
        toast(lives > 0
          ? `${label} 被标记了！剩余 ${lives} 条命`
          : `${label} 被标记！生命耗尽，即将淘汰`, 'bad');
      }
      break;
    }
    case 'hider_respawn':
      if (role === ROLE.HIDER) toast('已在巢穴复活，继续搬运食物', 'good');
      break;
    case 'hider_eliminated':
      if (role === ROLE.HIDER) toast('你已被淘汰，全屏观战至对局结束', 'bad');
      else toast(`${e.label || '隐藏者'} 已淘汰`, 'good');
      break;
    case 'mark_miss':
      if (role === ROLE.SEEKER) {
        toast('误标记！AI 逃窜中，标记冷却', 'bad');
        controller?.onMarkMiss?.();
      }
      break;
    case 'food_pickup': if (role === ROLE.HIDER) toast('拿到食物，送回巢穴', 'good'); break;
    case 'score':
      if (role === ROLE.HIDER && e.playerId === myPlayerId) toast(`食物已送达 (${e.score})`, 'good');
      break;
    case 'hider_verified':
      toast(role === ROLE.SEEKER
        ? `${e.label || '隐藏者'} 已获证，外观现出真色且不可标记`
        : `${e.label || '隐藏者'} 已获证！`, role === ROLE.SEEKER ? 'bad' : 'good');
      break;
    case 'tool':       if (role === ROLE.SEEKER) toast('使用了工具', 'good'); break;
    case 'fake_food_warn':
      if (role === ROLE.HIDER) toast('这是假食物！', 'bad');
      else if (role === ROLE.SEEKER) toast('隐藏者触碰了假食物', 'good');
      break;
  }
}

/** 局内事件弹窗：good 绿色正向，bad 红色负面 */
function toast(text, kind) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = 'toast-msg ' + (kind === 'bad' ? 'bad' : 'good');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---- UI 切换 ----

function showScreen(name) {
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('game').classList.toggle('hidden', name !== 'game');
  $('endScreen').classList.toggle('hidden', name !== 'end');
}

/** 大厅内子视图切换：'browser' | 'room' */
function showLobbyView(view) {
  $('browserView').classList.toggle('hidden', view !== 'browser');
  $('roomView').classList.toggle('hidden', view !== 'room');
}

function updateMyRoleLine() {
  $('myRoleLine').innerHTML = role === ROLE.SEEKER
    ? '你的角色：<span class="role-seeker">搜寻者</span>（上帝视角，找出混入的隐藏者）'
    : '你的角色：<span class="role-hider">隐藏者</span>（伪装成蚂蚁，搬运食物回巢）';
}

function resetGameUi() {
  running = false;
  controller = null;
  $('toolbar').classList.add('hidden');
  $('seekerHint').classList.add('hidden');
  $('hiderHint').classList.add('hidden');
  $('hiderScorePanel').classList.add('hidden');
  $('hiderScorePanel').innerHTML = '';
  $('livesHud')?.classList.add('hidden');
  $('markTimer')?.classList.add('hidden');
  updateDevAntStats(null);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- 初始化：建立 WS 连接，接收初始房间列表 ----
ensureConnected();
