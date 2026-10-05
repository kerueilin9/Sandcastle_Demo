// localStorage persistence. Every access is guarded: storage can be missing
// (private mode, blocked site data) and the game must still run.
import { NN, SAVE_KEY } from './config.js';
import { S, S0, P, M, W, initTint, resetWater, computeOceanEdges, touchAll } from './sim.js';
import { spawnItem } from './items.js';
import { ocean } from './ocean.js';
import { game, freshState } from './state.js';

function toB64(arr) {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str, Type) {
  const s = atob(str), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Type(u8.buffer);
}

export function save() {
  try {
    const pq = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) pq[k] = Math.round(P[k] * 255);
    game.st.time = ocean.time;
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1, st: game.st, S: toB64(S), S0: toB64(S0), P: toB64(pq), buried: game.buried,
      items: game.items.map(i => ({ type: i.type, x: i.x, z: i.z, state: i.state, yaw: i.yaw })),
    }));
  } catch { /* storage unavailable */ }
}

export function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (d.v !== 1) return false;
    game.st = Object.assign(freshState(), d.st);
    S.set(fromB64(d.S, Float32Array)); S0.set(fromB64(d.S0, Float32Array));
    const pq = fromB64(d.P, Uint8Array);
    for (let k = 0; k < NN; k++) P[k] = pq[k] / 255;
    initTint();
    game.buried = d.buried || [];
    ocean.time = game.st.time || 0;
    ocean.resetSchedule();
    resetWater();
    computeOceanEdges();
    for (let k = 0; k < NN; k++) M[k] = W[k] > 0 || P[k] > 0.5 ? 1 : 0;
    for (const i of d.items || []) { const it = spawnItem(i.type, i.x, i.z, i.state); it.yaw = i.yaw; it.mesh.rotation.y = i.yaw; it.vy = 0; }
    touchAll();
    return true;
  } catch { return false; }
}
