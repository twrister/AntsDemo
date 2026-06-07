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
let showPheromone = true;

// ---- DOM helpers ----
const $ = (id) => document.getElementById(id);

// ---- 开发者工具 ----

const AI_ANT_COUNT_MIN = 10;
const AI_ANT_COUNT_MAX = 200;

const DEV_DEFAULTS = {
  AI_ANT_COUNT: 30,
  AI_SPEED_BASE: 60,
  AI_TURN_SMOOTH: 0.3,
  AI_SOCIAL_CHANCE: 0.05,
  AI_SPEED: { sprint: 1.5, carry: 0.8 },
  FOOD_COUNT: 5,
  FOOD_CAPACITY: 60,
  BEAM_SPEED: 280,
};

const DEV_STORAGE_KEY = 'antsDemo_devCfg';

function persistDevConfig() {
  const cfg = {
    AI_ANT_COUNT: parseInt($('devAntCount').value, 10),
    AI_SPEED_BASE: parseFloat($('devSpeedBase').value),
    AI_TURN_SMOOTH: parseFloat($('devTurnSmooth').value),
    AI_SOCIAL_CHANCE: parseFloat($('devSocialChance').value),
    AI_SPEED: {
      sprint: parseFloat($('devSpeedSprint').value),
      carry: parseFloat($('devSpeedCarry').value),
    },
    FOOD_COUNT: parseInt($('devFoodCount').value, 10),
    FOOD_CAPACITY: parseInt($('devFoodCapacity').value, 10),
    BEAM_SPEED: parseInt($('devBeamSpeed').value, 10),
  };
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(cfg));
}

function applyBeamSpeedToWorld(beamSpeed) {
  if (world?.tools?.panic) world.tools.panic.beamSpeed = beamSpeed;
}

function restoreDevConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(DEV_STORAGE_KEY) || '{}'); } catch (_) {}
  const c = { ...DEV_DEFAULTS, ...saved, AI_SPEED: { ...DEV_DEFAULTS.AI_SPEED, ...(saved.AI_SPEED || {}) } };
  const antCount = Math.max(AI_ANT_COUNT_MIN, Math.min(AI_ANT_COUNT_MAX, c.AI_ANT_COUNT));

  $('devAntCount').min = AI_ANT_COUNT_MIN;
  $('devAntCount').max = AI_ANT_COUNT_MAX;
  $('devAntCount').value = antCount;
  $('devAntCountVal').textContent = antCount;
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
  $('devFoodCount').value = c.FOOD_COUNT;
  $('devFoodCountVal').textContent = c.FOOD_COUNT;
  $('devFoodCapacity').value = c.FOOD_CAPACITY;
  $('devFoodCapacityVal').textContent = c.FOOD_CAPACITY;
  $('devBeamSpeed').value = c.BEAM_SPEED;
  $('devBeamSpeedVal').textContent = c.BEAM_SPEED;
  applyBeamSpeedToWorld(c.BEAM_SPEED);
}

restoreDevConfig();

function sendDevConfig() {
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
    },
    FOOD_COUNT: parseInt($('devFoodCount').value, 10),
    FOOD_CAPACITY: parseInt($('devFoodCapacity').value, 10),
    BEAM_SPEED: parseInt($('devBeamSpeed').value, 10),
  });
  applyBeamSpeedToWorld(parseInt($('devBeamSpeed').value, 10));
}

function bindSlider(id, valId, decimals) {
  const inp = $(id);
  const valEl = $(valId);
  let timer = null;
  inp.addEventListener('input', () => {
    const n = parseFloat(inp.value);
    valEl.textContent = decimals === 0 ? String(Math.round(n)) : n.toFixed(decimals);
    clearTimeout(timer);
    timer = setTimeout(sendDevConfig, 16);
  });
}

bindSlider('devAntCount', 'devAntCountVal', 0);
bindSlider('devSpeedBase', 'devSpeedBaseVal', 0);
bindSlider('devTurnSmooth', 'devTurnSmoothVal', 2);
bindSlider('devSocialChance', 'devSocialChanceVal', 3);
bindSlider('devSpeedSprint', 'devSpeedSprintVal', 2);
bindSlider('devSpeedCarry', 'devSpeedCarryVal', 2);
bindSlider('devFoodCount', 'devFoodCountVal', 0);
bindSlider('devFoodCapacity', 'devFoodCapacityVal', 0);
bindSlider('devBeamSpeed', 'devBeamSpeedVal', 0);

$('devReset').addEventListener('click', () => {
  localStorage.removeItem(DEV_STORAGE_KEY);
  $('devAntCount').value = DEV_DEFAULTS.AI_ANT_COUNT;
  $('devAntCountVal').textContent = DEV_DEFAULTS.AI_ANT_COUNT;
  $('devSpeedBase').value = DEV_DEFAULTS.AI_SPEED_BASE;
  $('devSpeedBaseVal').textContent = DEV_DEFAULTS.AI_SPEED_BASE;
  $('devTurnSmooth').value = DEV_DEFAULTS.AI_TURN_SMOOTH;
  $('devTurnSmoothVal').textContent = DEV_DEFAULTS.AI_TURN_SMOOTH.toFixed(2);
  $('devSocialChance').value = DEV_DEFAULTS.AI_SOCIAL_CHANCE;
  $('devSocialChanceVal').textContent = DEV_DEFAULTS.AI_SOCIAL_CHANCE.toFixed(3);
  $('devSpeedSprint').value = DEV_DEFAULTS.AI_SPEED.sprint;
  $('devSpeedSprintVal').textContent = DEV_DEFAULTS.AI_SPEED.sprint.toFixed(2);
  $('devSpeedCarry').value = DEV_DEFAULTS.AI_SPEED.carry;
  $('devSpeedCarryVal').textContent = DEV_DEFAULTS.AI_SPEED.carry.toFixed(2);
  $('devFoodCount').value = DEV_DEFAULTS.FOOD_COUNT;
  $('devFoodCountVal').textContent = DEV_DEFAULTS.FOOD_COUNT;
  $('devFoodCapacity').value = DEV_DEFAULTS.FOOD_CAPACITY;
  $('devFoodCapacityVal').textContent = DEV_DEFAULTS.FOOD_CAPACITY;
  $('devBeamSpeed').value = DEV_DEFAULTS.BEAM_SPEED;
  $('devBeamSpeedVal').textContent = DEV_DEFAULTS.BEAM_SPEED;
  sendDevConfig();
});

$('devPheroCheck').addEventListener('change', () => {
  setPheroVisible($('devPheroCheck').checked);
});

function setPheroVisible(visible) {
  showPheromone = visible;
  $('devPheroCheck').checked = visible;
  const btn = $('pheroToggleBtn');
  btn.textContent = visible ? '信息素' : '信息素(关)';
  btn.classList.toggle('phero-on', visible);
  btn.classList.toggle('phero-off', !visible);
}

$('pheroToggleBtn').addEventListener('click', () => setPheroVisible(!showPheromone));

function toggleDevPanel() { $('devPanel').classList.toggle('hidden'); }
$('devPanelBtn').addEventListener('click', toggleDevPanel);
$('devClose').addEventListener('click', () => $('devPanel').classList.add('hidden'));
window.addEventListener('keydown', (e) => {
  if (e.key === '`' || e.key === '~') { e.preventDefault(); toggleDevPanel(); }
});

// ---- 连接 ----

async function ensureConnected() {
  if (!net.ws) await net.connect();
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
    item.innerHTML = `
      <span class="room-item-name col-name">${escapeHtml(r.name)}</span>
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

// ---- 单机调试 ----

$('soloSeekerBtn').addEventListener('click', () => startSolo(ROLE.SEEKER));
$('soloHiderBtn').addEventListener('click', () => startSolo(ROLE.HIDER));

async function startSolo(soloRole) {
  await ensureConnected();
  const name = $('nameInput').value.trim() || '调试';
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
});

net.on('start', (m) => {
  role = m.role;
  world = m.world;
  restoreDevConfig();
  showScreen('game');
  $('roleTag').textContent = role === ROLE.SEEKER ? '搜寻者' : '隐藏者';
  $('roleTag').className = 'hud-item ' + (role === ROLE.SEEKER ? 'role-seeker' : 'role-hider');
  if (role === ROLE.SEEKER) {
    controller = new SeekerController({ canvas, input, net, world });
    $('scoreTag').classList.remove('hidden');
  } else {
    controller = new HiderController({ canvas, input, net, world, antId: m.antId });
    $('toolbar').classList.add('hidden');
  }
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
  $('endScore').textContent = `食物进度：${m.score} / ${m.quota}`;
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
  if (role === ROLE.SEEKER) $('scoreTag').textContent = `已逃逸食物 ${snap.score}/${snap.quota}`;
  else $('scoreTag').textContent = `食物 ${snap.score}/${snap.quota}`;
  updateDevAntStats(snap);
}

function updateDevAntStats(snap) {
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
    case 'mark_hit':   toast('标记命中！隐藏者被淘汰', 'good'); break;
    case 'mark_miss':  toast('误标记！工具锁死中', 'bad'); break;
    case 'food_pickup': if (role === ROLE.HIDER) toast('拿到食物，送回巢穴', 'good'); break;
    case 'score':      toast(`食物已送达 (${e.score})`, 'good'); break;
    case 'tool':       if (role === ROLE.SEEKER) toast('使用了工具', ''); break;
  }
}

function toast(text, kind) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = 'toast-msg ' + (kind || '');
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
  updateDevAntStats(null);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- 初始化：建立 WS 连接，接收初始房间列表 ----
ensureConnected();
