// DOM UI: toolbar, tray, HUD, objectives, settings, overlays.
import { BUCKET_VOL, SAND_MAX, ITEMS, FINDABLE, TOOLS, TOOL_ICONS, LAYOUTS, WAVE_MODES } from './config.js';
import { game } from './state.js';
import { ocean } from './ocean.js';
import { clamp } from './util.js';
import { sfx, setSoundEnabled, audioInit } from './audio.js';
import { orbitBy, zoomBy, resetView, perf } from './render.js';

const $ = id => document.getElementById(id);

export const OBJECTIVES = [
  { id: 'dig', title: '初試身手', desc: '用鏟子挖起 25 桶沙', target: 25, prog: () => game.st.digTotal / BUCKET_VOL, reward: '解鎖工具：沙桶' },
  { id: 'tower', title: '第一座高塔', desc: '把沙堆到海平面以上 1.6 公尺', target: 1.6, unit: 'm', prog: () => game.maxHeight, reward: '解鎖工具：雕刻刀' },
  { id: 'collect', title: '海灘拾荒者', desc: '撿起 6 件海灘寶物', target: 6, prog: () => game.st.totalCollected, reward: '獲得 3 支小旗子' },
  { id: 'decor', title: '裝飾師', desc: '在沙上擺放 8 件裝飾', target: 8, prog: () => game.items.reduce((n, it) => n + (it.state === 'placed' ? 1 : 0), 0) },
  { id: 'moat', title: '護城河', desc: '讓海水流進 80 格原本乾燥的沙地', target: 80, prog: () => game.moatCells },
  { id: 'survive', title: '屹立不搖', desc: '大浪過後城堡仍高於 1.2 公尺（3 次）', target: 3, prog: () => game.st.survived },
  { id: 'coin', title: '寶藏獵人', desc: '挖出深埋在沙裡的古金幣', target: 1, prog: () => game.st.collected.coin || 0 },
  { id: 'all', title: '收藏家', desc: '找齊 7 種海灘寶物', target: 7, prog: () => FINDABLE.filter(t => game.st.collected[t]).length },
  { id: 'doom', title: '末日倖存者', desc: '末日模式：海嘯過後城堡仍高於 1 公尺', target: 1, prog: () => game.st.tsunamiSurvived },
];
export const isUnlocked = tool => { const t = TOOLS.find(x => x.id === tool); return !t.lock || game.st.done[t.lock]; };

// ---------------------------------------------------------------- toasts
export function toast(msg, big) {
  const el = document.createElement('div');
  el.className = 'toast' + (big ? ' big' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, big ? 3800 : 2600);
}

// In-page confirm dialog (window.confirm is unavailable in some embeds).
export function askConfirm(message, okLabel = '確定') {
  return new Promise(resolve => {
    $('confirmMsg').textContent = message;
    $('confirmOk').textContent = okLabel;
    $('confirm').classList.remove('hidden');
    const done = v => { $('confirm').classList.add('hidden'); $('confirmOk').onclick = $('confirmCancel').onclick = null; resolve(v); };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    $('confirmOk').focus();
  });
}

// ---------------------------------------------------------------- toolbar / tray
export function renderTools() {
  $('tools').innerHTML = TOOLS.map((t, i) => {
    const locked = !isUnlocked(t.id);
    const lockObj = t.lock && OBJECTIVES.find(o => o.id === t.lock);
    const title = locked ? `${t.name}（完成「${lockObj.title}」解鎖）` : `${t.name}：${t.hint}`;
    return `<button class="tool${game.st.tool === t.id ? ' on' : ''}${locked ? ' locked' : ''}" data-tool="${t.id}" title="${title}"><kbd>${i + 1}</kbd>${TOOL_ICONS[t.id]}<span>${t.name}</span></button>`;
  }).join('');
}
export function selectTool(id) {
  if (!isUnlocked(id)) {
    const t = TOOLS.find(x => x.id === id), o = OBJECTIVES.find(x => x.id === t.lock);
    toast(`🔒 完成「${o.title}」來解鎖${t.name}`);
    return;
  }
  game.st.tool = id;
  renderTools();
  $('tray').classList.toggle('hidden', id !== 'decor');
  document.body.classList.toggle('tray-open', id === 'decor');
  renderTray();
}
export function renderTray() {
  const st = game.st;
  $('tray').innerHTML = Object.keys(ITEMS).map(t => {
    const n = st.inventory[t] || 0, known = st.collected[t] || n > 0 || t === 'flag';
    const cls = ['item-btn', st.item === t ? 'on' : '', !known ? 'unknown' : n === 0 ? 'empty' : ''].join(' ');
    return `<button class="${cls}" data-item="${t}" title="${known ? ITEMS[t].name : '尚未發現'}">${ITEMS[t].icon}<b>${n}</b></button>`;
  }).join('');
}

// ---------------------------------------------------------------- HUD
export function renderHud() {
  const st = game.st;
  $('sandTxt').textContent = Math.floor(st.sand / BUCKET_VOL);
  $('sandBar').style.width = `${clamp(st.sand / SAND_MAX, 0, 1) * 100}%`;
  $('hTxt').textContent = game.maxHeight.toFixed(2);
  const lvl = ocean.seaLevel();
  $('tideTxt').textContent = st.waves === 'calm' ? '平穩' : `${ocean.tideRising() ? '漲潮' : '退潮'} ${lvl >= 0 ? '+' : ''}${(lvl * 100).toFixed(0)}cm`;
  $('colTxt').textContent = st.totalCollected;

  // tsunami banner
  const warn = ocean.tsunamiWarning(), tau = ocean.tsunamiTau();
  const banner = $('alert');
  if (warn > 0) { banner.textContent = `⚠ 海嘯警報　${Math.ceil(warn)} 秒後海水將退去`; banner.className = 'alert'; }
  else if (ocean.tsunamiActive() && tau < 10) { banner.textContent = '⚠ 海水正在退去……海嘯要來了！'; banner.className = 'alert'; }
  else if (ocean.tsunamiActive() && tau < 18) { banner.textContent = '🌊 海嘯來襲！'; banner.className = 'alert hit'; }
  else banner.className = 'alert hidden';
  const nextTs = ocean.nextTsunami - ocean.time;
  $('doomInfo').textContent = st.waves !== 'doom' ? '' : ocean.tsunamiActive() ? '海嘯進行中' : `下一波海嘯：${Math.max(0, Math.ceil(nextTs))} 秒`;
}

// ---------------------------------------------------------------- objectives
export function renderObjectives() {
  const st = game.st;
  const done = OBJECTIVES.filter(o => st.done[o.id]).length;
  $('objCount').textContent = `${done}/${OBJECTIVES.length}`;
  $('objList').innerHTML = OBJECTIVES.map(o => {
    const v = st.done[o.id] ? o.target : Math.min(o.target, o.prog());
    const txt = o.unit ? `${v.toFixed(2)}/${o.target}${o.unit}` : `${Math.floor(v)}/${o.target}`;
    return `<li class="${st.done[o.id] ? 'done' : ''}">
      <div class="o-title"><span>${o.title}</span><span>${st.done[o.id] ? '' : txt}</span></div>
      <div class="o-desc">${o.desc}</div>
      <div class="o-bar"><i style="width:${(v / o.target) * 100}%"></i></div>
      ${o.reward && !st.done[o.id] ? `<div class="o-reward">🎁 ${o.reward}</div>` : ''}
    </li>`;
  }).join('');
}
export function checkObjectives(onChange) {
  const st = game.st;
  let changed = false;
  for (const o of OBJECTIVES) {
    if (st.done[o.id] || o.prog() < o.target) continue;
    st.done[o.id] = true; changed = true;
    toast(`✔ 完成任務「${o.title}」${o.reward ? '　' + o.reward : ''}`, true);
    sfx('done');
    if (o.id === 'collect') { st.inventory.flag = (st.inventory.flag || 0) + 3; renderTray(); }
    const doneCount = Object.keys(st.done).length;
    for (const L of Object.values(LAYOUTS)) if (L.need === doneCount && L.need > 0) toast(`🗺️ 新海灘解鎖：${L.name}`, true);
  }
  if (changed) { renderTools(); onChange(); }
  renderObjectives();
}

// ---------------------------------------------------------------- settings
export function setBrush(v) {
  game.st.brush = clamp(v, 0.3, 2.5);
  $('brush').value = game.st.brush;
}
export function renderWaves() {
  const st = game.st;
  for (const b of $('waveSeg').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === st.waves);
    b.setAttribute('aria-checked', String(b.dataset.v === st.waves));
  }
  $('waveScale').value = st.waveScale;
  $('waveScaleTxt').textContent = `×${st.waveScale.toFixed(1)}`;
  $('doomRow').classList.toggle('hidden', st.waves !== 'doom');
  document.body.classList.toggle('doom', st.waves === 'doom');
}
function renderSound() { $('btnSound').textContent = game.st.sound ? '🔊' : '🔇'; setSoundEnabled(game.st.sound); }

function renderLayouts() {
  const st = game.st, doneCount = Object.keys(st.done).length;
  $('layoutList').innerHTML = Object.entries(LAYOUTS).map(([key, L]) => {
    const locked = doneCount < L.need;
    return `<button data-layout="${key}" class="${st.layout === key ? 'on' : ''}" ${locked ? 'disabled' : ''}>
      <b>${locked ? '🔒 ' : ''}${L.name}</b><small>${locked ? `完成 ${L.need} 個任務解鎖` : L.desc}</small></button>`;
  }).join('') + `<button data-layout="${st.layout}" data-reset="1"><b>🔄 重新開始</b><small>重置目前的海灘</small></button>
    <button data-wipe="1"><b>🗑️ 清除存檔</b><small>所有任務與收藏歸零</small></button>`;
}

let perfOn = /[?&]debug\b/.test(location.search);
export function renderPerf(p) {
  const el = $('perf');
  el.classList.toggle('hidden', !perfOn);
  if (!perfOn) return;
  el.textContent = `FPS ${p.fps.toFixed(0)}  幀 ${p.frame.toFixed(1)}ms\n模擬 ${p.sim.toFixed(2)}ms  網格 ${p.mesh.toFixed(2)}ms\n渲染 ${p.render.toFixed(2)}ms  DPR ${perf.dpr.toFixed(2)}\n有水列 ${p.wetRows}  活動列 ${p.activeRows}`;
}

// actions: { undo, newBeach(key), wipe(), toggleNav(), triggerTsunami(), wavesChanged() }
export function initUI(actions) {
  $('tools').addEventListener('click', e => { const b = e.target.closest('.tool'); if (b) selectTool(b.dataset.tool); });
  $('tray').addEventListener('click', e => {
    const b = e.target.closest('.item-btn');
    if (!b) return;
    game.st.item = b.dataset.item;
    renderTray();
  });
  $('objToggle').addEventListener('click', () => {
    const c = $('obj').classList.toggle('collapsed');
    $('objToggle').setAttribute('aria-expanded', String(!c));
  });
  $('brush').addEventListener('input', e => { game.st.brush = parseFloat(e.target.value); });
  $('waveSeg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    game.st.waves = b.dataset.v;
    actions.wavesChanged();
    renderWaves();
    if (b.dataset.v === 'doom') toast('☠️ 末日模式：狂風巨浪，還會有海嘯！', true);
  });
  $('waveScale').addEventListener('input', e => { game.st.waveScale = parseFloat(e.target.value); renderWaves(); });
  $('btnTsunami').addEventListener('click', () => { audioInit(); actions.triggerTsunami(); });
  $('btnUndo').addEventListener('click', actions.undo);
  $('btnSound').addEventListener('click', () => { game.st.sound = !game.st.sound; audioInit(); renderSound(); });
  $('btnHelp').addEventListener('click', () => { $('btnStart').textContent = '繼續'; $('intro').classList.remove('hidden'); });
  $('btnStart').addEventListener('click', () => { $('intro').classList.add('hidden'); audioInit(); });

  $('btnNav').addEventListener('click', actions.toggleNav);
  $('btnRotL').addEventListener('click', () => orbitBy(-Math.PI / 6));
  $('btnRotR').addEventListener('click', () => orbitBy(Math.PI / 6));
  $('btnZoomIn').addEventListener('click', () => zoomBy(0.75));
  $('btnZoomOut').addEventListener('click', () => zoomBy(1.33));
  $('btnHome').addEventListener('click', resetView);

  $('btnLayout').addEventListener('click', () => { renderLayouts(); $('layouts').classList.remove('hidden'); });
  $('btnLayoutClose').addEventListener('click', () => $('layouts').classList.add('hidden'));
  $('layoutList').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.wipe) {
      if (!await askConfirm('清除所有進度？任務、收藏與地形都會重置。', '清除存檔')) return;
      actions.wipe();
      $('layouts').classList.add('hidden');
      return;
    }
    const key = b.dataset.layout;
    if (key === game.st.layout && !b.dataset.reset) { $('layouts').classList.add('hidden'); return; }
    if (!await askConfirm('重置地形？已擺放的裝飾會收回背包。', '重置地形')) return;
    actions.newBeach(key);
    $('layouts').classList.add('hidden');
  });
  window.addEventListener('keydown', e => { if (e.key === 'F3' || (e.key === '`' && !e.repeat)) { e.preventDefault(); perfOn = !perfOn; } });

  if (window.innerWidth < 760) $('obj').classList.add('collapsed');
}

export function renderAll() {
  setBrush(game.st.brush);
  selectTool(isUnlocked(game.st.tool) ? game.st.tool : 'shovel');
  renderWaves(); renderSound(); renderObjectives(); renderHud();
}
