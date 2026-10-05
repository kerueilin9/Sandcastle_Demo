// Brush tools, picking, undo and pointer / keyboard input.
import * as THREE from 'three';
import { N, NN, CELL, HALF, BASE, FLOOR, BUCKET_VOL, SAND_MAX, ITEMS, TOOLS, xOf, zOf } from './config.js';
import { S, W, P, M, heightAt, touchRows, touchAll } from './sim.js';
import { canvas, camera, consumeCameraMoved, setNavMode, orbitBy, zoomBy, resetView, updateRing } from './render.js';
import { spawnItem, removeItem } from './items.js';
import { audioInit, sfx } from './audio.js';
import { game } from './state.js';
import { lerp } from './util.js';
import { toast, renderTray, renderHud, selectTool, setBrush } from './ui.js';

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(9, 9);
let hover = null, drawing = false, carveLevel = 0, pickDirty = true;
let navHeld = false, navLocked = false;
export const isDrawing = () => drawing && !!hover;

// ---------------------------------------------------------------- picking
function pickTerrain() {
  raycaster.setFromCamera(mouse, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  let t0 = 0, t1 = 200;
  for (const [oa, da, lo, hi] of [[o.x, d.x, -HALF, HALF], [o.z, d.z, -HALF, HALF], [o.y, d.y, BASE, 6]]) {
    if (Math.abs(da) < 1e-8) { if (oa < lo || oa > hi) return null; continue; }
    let a = (lo - oa) / da, b = (hi - oa) / da;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 > t1) return null;
  const step = 0.04;
  let prev = t0;
  for (let t = t0; t <= t1; t += step) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    if (y <= heightAt(x, z)) {
      let a = prev, b = t;
      for (let n = 0; n < 10; n++) {
        const m = (a + b) / 2;
        if (o.y + d.y * m <= heightAt(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
      }
      return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
    }
    prev = t;
  }
  return null;
}
function pickItem() {
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(game.items.map(i => i.mesh), true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.item) o = o.parent;
    if (o) return o.userData.item;
  }
  // generous proximity pick for loose items
  const p = pickTerrain();
  if (!p) return null;
  let best = null, bd = 0.35;
  for (const it of game.items) {
    if (it.state !== 'loose') continue;
    const d = Math.hypot(it.x - p.x, it.z - p.z);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

// ---------------------------------------------------------------- brushes
function forCells(cx, cz, R, fn) {
  const i0 = Math.max(0, Math.floor((cx - R + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((cx + R + HALF) / CELL));
  const j0 = Math.max(0, Math.floor((cz - R + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((cz + R + HALF) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(xOf(i) - cx, zOf(j) - cz);
    if (d <= R) fn(j * N + i, d / R, i, j);
  }
  touchRows(j0 - 1, j1 + 1);
}
const falloff = q => { const t = 1 - q * q; return t * t; };

let sandWarned = 0;
function warnSand(msg) {
  const now = performance.now();
  if (now - sandWarned > 2500) { toast(msg); sandWarned = now; }
}

function applyBrush(p, dt) {
  const st = game.st, R = st.brush;
  switch (st.tool) {
    case 'shovel': {
      if (st.sand >= SAND_MAX) warnSand('沙桶裝滿了！先去堆點沙吧');
      forCells(p.x, p.z, R, (k, q) => {
        const amt = Math.min(1.1 * dt * falloff(q), S[k] - FLOOR);
        if (amt <= 0) return;
        const vol = amt * CELL * CELL;
        if (st.sand + vol > SAND_MAX) return;
        S[k] -= amt; st.sand += vol; st.digTotal += vol;
        P[k] *= 0.98;
      });
      break;
    }
    case 'pile': {
      if (st.sand <= 0.0001) { warnSand('沒有濕沙了，用鏟子挖一些吧'); break; }
      forCells(p.x, p.z, R, (k, q) => {
        const f = falloff(q), amt = 0.8 * dt * f, vol = amt * CELL * CELL;
        if (vol > st.sand) return;
        S[k] += amt; st.sand -= vol;
        P[k] = Math.max(P[k], lerp(P[k], 1, Math.min(1, f * 1.5)));
        M[k] = 1;
      });
      break;
    }
    case 'smooth': {
      const tmp = [];
      forCells(p.x, p.z, R, (k, q, i, j) => {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          s += S[jj * N + ii]; n++;
        }
        tmp.push(k, s / n, falloff(q));
      });
      for (let t = 0; t < tmp.length; t += 3) {
        const k = tmp[t], avg = tmp[t + 1], f = tmp[t + 2];
        S[k] += (avg - S[k]) * Math.min(1, 7 * dt * f);
        P[k] += (1 - P[k]) * Math.min(1, 2.5 * dt * f);
      }
      break;
    }
    case 'carve': {
      forCells(p.x, p.z, carveRadius(), k => {
        if (S[k] > carveLevel) S[k] = Math.max(carveLevel, S[k] - 5 * dt);
      });
      break;
    }
  }
}
const carveRadius = () => Math.max(CELL * 1.1, game.st.brush * 0.3);
const bucketRadius = () => Math.max(0.3, game.st.brush * 0.6);

function stampBucket(p) {
  const st = game.st, r = bucketRadius(), height = 0.6, rTop = r * 0.82;
  let base = -9;
  forCells(p.x, p.z, r, k => { if (S[k] > base) base = S[k]; });
  const top = base + height;
  let need = 0;
  const targets = [];
  forCells(p.x, p.z, r, (k, q) => {
    const d = q * r;
    const tg = d <= rTop ? top : top - (d - rTop) / (r - rTop) * height * 1.1;
    if (tg > S[k]) { need += (tg - S[k]) * CELL * CELL; targets.push(k, tg); }
  });
  if (need > st.sand) { toast(`濕沙不足（需要 ${Math.ceil(need / BUCKET_VOL)} 桶）`); return; }
  pushUndo();
  for (let t = 0; t < targets.length; t += 2) { const k = targets[t]; S[k] = targets[t + 1]; P[k] = 1; M[k] = 1; }
  st.sand -= need;
  sfx('thud');
}

function placeDecor(p) {
  const st = game.st, type = st.item;
  if (!(st.inventory[type] > 0)) { toast(`沒有${ITEMS[type].name}了`); return; }
  st.inventory[type]--;
  spawnItem(type, p.x, p.z, 'placed').y = p.y;
  sfx('place');
  renderTray();
}

export function collect(it) {
  const st = game.st, def = ITEMS[it.type];
  st.inventory[it.type] = (st.inventory[it.type] || 0) + 1;
  const first = !st.collected[it.type];
  st.collected[it.type] = (st.collected[it.type] || 0) + 1;
  st.totalCollected++;
  removeItem(it);
  sfx('pop');
  toast(`${def.icon} 撿到${def.name}${first ? '（新發現！）' : ''}`);
  renderTray(); renderHud();
}

// ---------------------------------------------------------------- undo
let undoStack = [];
function pushUndo() {
  undoStack.push({ S: S.slice(), P: P.slice(), sand: game.st.sand });
  if (undoStack.length > 15) undoStack.shift();
}
export function undo() {
  const u = undoStack.pop();
  if (!u) { toast('沒有可以復原的動作'); return; }
  S.set(u.S); P.set(u.P); game.st.sand = u.sand;
  touchAll();
}
export function clearUndo() { undoStack = []; }

// ---------------------------------------------------------------- per frame
const RING_COLORS = { shovel: 0xffffff, pile: 0xffe08a, smooth: 0xcfe8ff, bucket: 0x7fd3ff, carve: 0xffb38a, decor: 0xffa060 };
export function updateTools(dt) {
  const camMoved = consumeCameraMoved();
  // re-pick only when the pointer or camera moved, so a held brush stays put
  if (mouse.x > 2 || navActive()) hover = null;
  else if (pickDirty || camMoved || !hover) { hover = pickTerrain(); pickDirty = false; }
  else hover.y = heightAt(hover.x, hover.z);
  if (drawing && hover) applyBrush(hover, dt);

  const tool = game.st.tool;
  const R = tool === 'bucket' ? bucketRadius() : tool === 'carve' ? carveRadius() : tool === 'decor' ? 0.2 : game.st.brush;
  updateRing(hover, R, RING_COLORS[tool], heightAt);
}

// ---------------------------------------------------------------- input
const navActive = () => navHeld || navLocked;
function refreshNav() {
  setNavMode(navActive());
  if (navActive()) drawing = false;
  document.getElementById('btnNav')?.classList.toggle('on', navLocked);
}
export function toggleNavLock() { navLocked = !navLocked; refreshNav(); }

const activeTouches = new Set();
function setMouse(e) {
  pickDirty = true;
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

export function initInput() {
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') {
      activeTouches.add(e.pointerId);
      if (activeTouches.size > 1) { drawing = false; return; }
    }
    if (e.button !== 0 || navActive()) return;
    setMouse(e);
    audioInit();
    const it = pickItem();
    if (it && it.state === 'loose') { collect(it); return; }
    const st = game.st;
    if (it && it.state === 'placed' && st.tool === 'decor') {
      st.inventory[it.type] = (st.inventory[it.type] || 0) + 1;
      removeItem(it); sfx('pop'); renderTray();
      return;
    }
    const p = pickTerrain();
    if (!p) return;
    if (st.tool === 'bucket') { stampBucket(p); return; }
    if (st.tool === 'decor') { placeDecor(p); return; }
    pushUndo();
    if (st.tool === 'carve') carveLevel = p.y - 0.22;
    drawing = true;
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' && activeTouches.size > 1) return;
    setMouse(e);
  });
  const endPointer = e => { activeTouches.delete(e.pointerId); drawing = false; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { drawing = false; mouse.x = 9; } });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.code === 'Space' || e.key === 'Alt') && !navHeld) { e.preventDefault(); navHeld = true; refreshNav(); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= TOOLS.length) selectTool(TOOLS[n - 1].id);
    const key = e.key.toLowerCase();
    if (key === '[') setBrush(game.st.brush - 0.15);
    if (key === ']') setBrush(game.st.brush + 0.15);
    if (key === 'q') orbitBy(-Math.PI / 8);
    if (key === 'e') orbitBy(Math.PI / 8);
    if (key === 'r') resetView();
    if (key === '=' || key === '+') zoomBy(0.8);
    if (key === '-') zoomBy(1.25);
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' || e.key === 'Alt') { navHeld = false; refreshNav(); }
  });
  window.addEventListener('blur', () => { navHeld = false; refreshNav(); drawing = false; });
}
