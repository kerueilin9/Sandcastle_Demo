// Entry point: boot, fixed-step simulation loop, game events.
import { N, WATER_DT, ITEMS } from './src/config.js';
import { game, freshState } from './src/state.js';
import { ocean } from './src/ocean.js';
import * as sim from './src/sim.js';
import { render, resize, adaptResolution, updateTerrainMesh, updateWaterMesh, updateSkirts, setStorm, camera } from './src/render.js';
import { updateItems, updateTreasures, clearItems } from './src/items.js';
import { initInput, updateTools, undo, clearUndo, toggleNavLock, isDrawing } from './src/tools.js';
import { updateAudio, sfx } from './src/audio.js';
import { initUI, renderAll, renderHud, renderTray, renderPerf, checkObjectives, toast } from './src/ui.js';
import { save, load } from './src/save.js';

// ---------------------------------------------------------------- game actions
function newBeach(key) {
  const st = game.st;
  for (const it of game.items) if (it.state === 'placed') st.inventory[it.type] = (st.inventory[it.type] || 0) + 1;
  clearItems();
  st.layout = key;
  st.seed = (Math.random() * 1e9) | 0;
  clearUndo();
  game.buried = sim.generate(key, st.seed);
  renderTray();
  save();
}
function wipe() {
  clearItems();
  game.st = freshState();
  newBeach('beach');
  wavesChanged();
  renderAll();
}
function wavesChanged() {
  ocean.resetSchedule();
  setStorm(game.st.waves === 'doom' ? 1 : 0);
}
function triggerTsunami() {
  if (!ocean.trigger()) toast('海嘯已經在路上了！');
}

// ---------------------------------------------------------------- ocean events
function onOceanEvent(ev) {
  const st = game.st;
  if (ev === 'setStart') toast('🌊 大浪來了！');
  else if (ev === 'setEnd') {
    if (ocean.mode().setEvery !== Infinity && game.maxHeight >= 1.2) { st.survived++; toast('🏰 城堡撐過了這波大浪！'); }
  } else if (ev === 'tsunamiWarn') toast('⚠ 海嘯警報！快把城堡加高！', true);
  else if (ev === 'tsunamiEnd') {
    Object.assign(game, sim.computeStats());
    if (game.maxHeight >= 1) { st.tsunamiSurvived++; toast(`🏰 城堡在海嘯中倖存！（${game.maxHeight.toFixed(2)} m）`, true); }
    else toast('海嘯把一切都捲走了……再蓋一座吧', true);
    save();
  }
}

// ---------------------------------------------------------------- loop
const prof = { fps: 60, frame: 16, sim: 0, mesh: 0, render: 0, wetRows: 0, activeRows: 0 };
const ema = (k, v) => { prof[k] += (v - prof[k]) * 0.05; };
let last = performance.now(), acc = 0, statTimer = 0, uiTimer = 0, moistTimer = 0;
let terrainForce = true;

function tick(dt) {
  const t0 = performance.now();
  updateTools(dt);

  // fixed-step water, decoupled from frame rate (max 8 sub-steps per frame)
  acc = Math.min(acc + dt, WATER_DT * 8);
  while (acc >= WATER_DT) { ocean.time += WATER_DT; sim.waterStep(WATER_DT); acc -= WATER_DT; }
  ocean.update(onOceanEvent);
  sim.groundwater(dt);
  sim.sedimentStep(dt);
  sim.thermalStep();
  moistTimer += dt;
  if (moistTimer > 0.1) { sim.moistureStep(moistTimer); moistTimer = 0; }
  updateTreasures(dt, () => sfx('reveal'));
  const itemsMoved = updateItems(dt, it => toast(`${ITEMS[it.type].icon} ${ITEMS[it.type].name}被海浪捲走了…`));
  const t1 = performance.now();

  statTimer -= dt;
  if (statTimer <= 0) {
    statTimer = 0.5;
    Object.assign(game, sim.computeStats());
    checkObjectives(save);
  }
  uiTimer -= dt;
  if (uiTimer <= 0) { uiTimer = 0.15; renderHud(); }

  const terrainChanged = updateTerrainMesh(dt, terrainForce);
  terrainForce = false;
  updateWaterMesh();
  updateSkirts();
  sim.decayRows();
  const t2 = performance.now();

  const shake = ocean.shake();
  render(dt, { terrainChanged, itemsMoved, shake });
  const t3 = performance.now();

  const m = ocean.mode();
  updateAudio({
    level: Math.min(0.5, 0.05 + 0.4 * m.amp * game.st.waveScale + 0.25 * ocean.setEnvelope()),
    digging: isDrawing() && ['shovel', 'pile', 'smooth', 'carve'].includes(game.st.tool),
    rumble: Math.max(shake, ocean.tsunamiActive() && ocean.tsunamiTau() > 0 ? 0.3 : 0),
    warning: ocean.tsunamiWarning() > 0,
    time: ocean.time,
  });

  ema('sim', t1 - t0); ema('mesh', t2 - t1); ema('render', t3 - t2);
  let wet = 0, act = 0;
  for (let j = 0; j < N; j++) { wet += sim.rowWet[j]; act += sim.rowActive[j] ? 1 : 0; }
  prof.wetRows = wet; prof.activeRows = act;
}

function frame(now) {
  requestAnimationFrame(frame);
  const raw = now - last;
  last = now;
  tick(Math.min(0.05, raw / 1000));
  ema('frame', raw); prof.fps = 1000 / prof.frame;
  adaptResolution(raw);
  renderPerf(prof);
}

// ---------------------------------------------------------------- boot
if (!load()) { game.buried = sim.generate(game.st.layout, game.st.seed); ocean.resetSchedule(); }
setStorm(game.st.waves === 'doom' ? 1 : 0);
initUI({ undo, newBeach, wipe, toggleNav: toggleNavLock, triggerTsunami, wavesChanged });
initInput();
resize();
window.addEventListener('resize', resize);
renderAll();
Object.assign(game, sim.computeStats());
// pre-settle water a bit so the first frame looks calm
for (let s = 0; s < 60; s++) { ocean.time += WATER_DT; sim.waterStep(WATER_DT); }
setInterval(save, 15000);
window.addEventListener('beforeunload', save);
requestAnimationFrame(frame);

// debug hook: step the game manually (e.g. when the tab is hidden)
window.__sc = { tick, game, ocean, sim, prof, triggerTsunami, camera };
