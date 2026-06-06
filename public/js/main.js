// 入口：大厅流程、对局渲染循环、结算。
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
let controller = null;
let world = null;
let running = false;
let showPheromone = true;  // 信息素可视化开关

// ---- DOM ----
const $ = (id) => document.getElementById(id);

$('joinBtn').addEventListener('click', join);
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('soloSeekerBtn').addEventListener('click', () => startSolo(ROLE.SEEKER));
$('soloHiderBtn').addEventListener('click', () => startSolo(ROLE.HIDER));
$('readyBtn').addEventListener('click', () => net.send({ type: 'ready' }));
$('restartBtn').addEventListener('click', () => {
  net.send({ type: 'restart' });
  resetGameUi();
  showScreen('lobby');
});

// ---- 开发者工具 ----

// 默认 AI 参数值（与 config.js 保持一致）
const DEV_DEFAULTS = {
  AI_SPEED_BASE: 60,
  AI_TURN_SMOOTH: 0.3,
  AI_SOCIAL_CHANCE: 0.05,
  AI_SPEED: { wander: 0.6, forage: 1.0, carry: 0.8, flee: 1.4 },
};

/** 读取所有滑块当前值，构造 dev_config 消息并发送给服务器 */
function sendDevConfig() {
  if (!running) return;
  net.send({
    type: 'dev_config',
    AI_SPEED_BASE: parseFloat($('devSpeedBase').value),
    AI_TURN_SMOOTH: parseFloat($('devTurnSmooth').value),
    AI_SOCIAL_CHANCE: parseFloat($('devSocialChance').value),
    AI_SPEED: {
      wander: parseFloat($('devSpeedWander').value),
      forage: parseFloat($('devSpeedForage').value),
      carry: parseFloat($('devSpeedCarry').value),
      flee: parseFloat($('devSpeedFlee').value),
    },
  });
}

/** 绑定单个滑块：实时更新显示值并节流发送 */
function bindSlider(id, valId, decimals) {
  const input = $(id);
  const valEl = $(valId);
  let timer = null;
  input.addEventListener('input', () => {
    valEl.textContent = parseFloat(input.value).toFixed(decimals);
    clearTimeout(timer);
    timer = setTimeout(sendDevConfig, 80);
  });
}

bindSlider('devSpeedBase', 'devSpeedBaseVal', 0);
bindSlider('devTurnSmooth', 'devTurnSmoothVal', 2);
bindSlider('devSocialChance', 'devSocialChanceVal', 3);
bindSlider('devSpeedWander', 'devSpeedWanderVal', 2);
bindSlider('devSpeedForage', 'devSpeedForageVal', 2);
bindSlider('devSpeedCarry', 'devSpeedCarryVal', 2);
bindSlider('devSpeedFlee', 'devSpeedFleeVal', 2);

/** 恢复所有滑块到默认值并同步服务器 */
$('devReset').addEventListener('click', () => {
  $('devSpeedBase').value = DEV_DEFAULTS.AI_SPEED_BASE;
  $('devSpeedBaseVal').textContent = DEV_DEFAULTS.AI_SPEED_BASE;
  $('devTurnSmooth').value = DEV_DEFAULTS.AI_TURN_SMOOTH;
  $('devTurnSmoothVal').textContent = DEV_DEFAULTS.AI_TURN_SMOOTH.toFixed(2);
  $('devSocialChance').value = DEV_DEFAULTS.AI_SOCIAL_CHANCE;
  $('devSocialChanceVal').textContent = DEV_DEFAULTS.AI_SOCIAL_CHANCE.toFixed(3);
  $('devSpeedWander').value = DEV_DEFAULTS.AI_SPEED.wander;
  $('devSpeedWanderVal').textContent = DEV_DEFAULTS.AI_SPEED.wander.toFixed(2);
  $('devSpeedForage').value = DEV_DEFAULTS.AI_SPEED.forage;
  $('devSpeedForageVal').textContent = DEV_DEFAULTS.AI_SPEED.forage.toFixed(2);
  $('devSpeedCarry').value = DEV_DEFAULTS.AI_SPEED.carry;
  $('devSpeedCarryVal').textContent = DEV_DEFAULTS.AI_SPEED.carry.toFixed(2);
  $('devSpeedFlee').value = DEV_DEFAULTS.AI_SPEED.flee;
  $('devSpeedFleeVal').textContent = DEV_DEFAULTS.AI_SPEED.flee.toFixed(2);
  sendDevConfig();
});

/** 开发者面板内的信息素复选框联动 HUD 按钮 */
$('devPheroCheck').addEventListener('change', () => {
  setPheroVisible($('devPheroCheck').checked);
});

/** 统一设置信息素可见状态，同步 HUD 按钮与面板复选框 */
function setPheroVisible(visible) {
  showPheromone = visible;
  $('devPheroCheck').checked = visible;
  const btn = $('pheroToggleBtn');
  btn.textContent = visible ? '信息素' : '信息素(关)';
  btn.classList.toggle('phero-on', visible);
  btn.classList.toggle('phero-off', !visible);
}

/** HUD 信息素按钮 */
$('pheroToggleBtn').addEventListener('click', () => setPheroVisible(!showPheromone));

/** DEV 按钮 / 反引号键 切换面板 */
function toggleDevPanel() {
  $('devPanel').classList.toggle('hidden');
}
$('devPanelBtn').addEventListener('click', toggleDevPanel);
$('devClose').addEventListener('click', () => $('devPanel').classList.add('hidden'));
window.addEventListener('keydown', (e) => {
  if (e.key === '`' || e.key === '~') { e.preventDefault(); toggleDevPanel(); }
});

// 确保 WebSocket 已连接
async function ensureConnected() {
  if (!net.ws) await net.connect();
}

function setLobbyLocked(locked) {
  $('joinBtn').disabled = locked;
  $('nameInput').disabled = locked;
  $('soloSeekerBtn').disabled = locked;
  $('soloHiderBtn').disabled = locked;
}

async function join() {
  await ensureConnected();
  if ($('joinBtn').disabled) return;
  const name = $('nameInput').value.trim() || '玩家';
  net.send({ type: 'join', name });
  setLobbyLocked(true);
  $('lobbyInfo').classList.remove('hidden');
}

// 单机调试：选角色后立即开局
async function startSolo(soloRole) {
  await ensureConnected();
  if ($('soloSeekerBtn').disabled) return;
  const name = $('nameInput').value.trim() || '调试';
  net.send({ type: 'join', name });
  net.send({ type: 'solo_start', role: soloRole });
  setLobbyLocked(true);
}

function resetGameUi() {
  setLobbyLocked(false);
  running = false;
  controller = null;
  $('lobbyInfo').classList.add('hidden');
  $('toolbar').classList.add('hidden');
  $('seekerHint').classList.add('hidden');
  $('hiderHint').classList.add('hidden');
}

net.on('welcome', (m) => {
  role = m.role;
  $('roleLine').innerHTML = role === ROLE.SEEKER
    ? '你的角色：<span class="role-seeker">搜寻者</span>（上帝视角，找出混入的隐藏者）'
    : '你的角色：<span class="role-hider">隐藏者</span>（伪装成蚂蚁，收集标记食物）';
});

net.on('lobby', (m) => {
  const list = $('playerList');
  list.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const r = p.role === ROLE.SEEKER ? '搜寻者' : '隐藏者';
    li.innerHTML = `<span>${escapeHtml(p.name)} · ${r}</span><span>${p.ready ? '✓ 已准备' : '…'}</span>`;
    list.appendChild(li);
  }
});

net.on('start', (m) => {
  role = m.role;
  world = m.world;
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
    renderer.draw(snap, opts.cam, { ...opts, role, world, time: now, showPheromone });
    updateHud(snap);
  }
  requestAnimationFrame(loop);
}

function updateHud(snap) {
  const m = Math.floor(snap.timeLeft / 60), s = snap.timeLeft % 60;
  $('timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  if (role === ROLE.SEEKER) $('scoreTag').textContent = `已逃逸食物 ${snap.score}/${snap.quota}`;
  else $('scoreTag').textContent = `食物 ${snap.score}/${snap.quota}`;
}

// ---- 事件提示 ----
function handleEvent(e) {
  switch (e.t) {
    case 'mark_hit': toast('标记命中！隐藏者被淘汰', 'good'); break;
    case 'mark_miss': toast('误标记！工具锁死中', 'bad'); break;
    case 'food_pickup': if (role === ROLE.HIDER) toast('拿到标记食物，送回巢穴', 'good'); break;
    case 'score': toast(`食物已送达 (${e.score})`, 'good'); break;
    case 'tool': if (role === ROLE.SEEKER) toast(`使用了工具`, ''); break;
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

function showScreen(name) {
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('game').classList.toggle('hidden', name !== 'game');
  $('endScreen').classList.toggle('hidden', name !== 'end');
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
