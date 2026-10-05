// Heightfield sand + shallow-water simulation. No Three.js dependency, so it
// could be moved into a Web Worker later without changes.
//
// Performance notes:
//  - rowWet[j]   : row j holds water. Water / sediment passes skip dry rows.
//  - rowActive[j]: frames left in which row j's sand is considered "moving".
//                  Thermal slumping and terrain mesh uploads only touch active rows.
import { N, NN, CELL, HALF, FLOOR, G, LAYOUTS, ITEMS, FINDABLE, xOf, zOf } from './config.js';
import { clamp, lerp, hash2, mulberry32 } from './util.js';
import { ocean } from './ocean.js';

export const S = new Float32Array(NN);   // sand height
export const S0 = new Float32Array(NN);  // original sand height
export const W = new Float32Array(NN);   // water depth
export const P = new Float32Array(NN);   // packing 0..1
export const M = new Float32Array(NN);   // wetness (visual) 0..1
export const SED = new Float32Array(NN);
const SED2 = new Float32Array(NN);
const FL = new Float32Array(NN), FR = new Float32Array(NN), FT = new Float32Array(NN), FB = new Float32Array(NN);
export const VX = new Float32Array(NN), VZ = new Float32Array(NN);
export const TINT = new Float32Array(NN);

export const rowWet = new Uint8Array(N);
export const rowActive = new Uint8Array(N);
const rowNext = new Uint8Array(N);
const rowSed = new Uint8Array(N);
const tgtRow = new Float32Array(N);
let oceanEdge = new Int32Array(0);

const ACTIVE_FRAMES = 40;
export function touchRows(j0, j1) {
  j0 = Math.max(0, j0); j1 = Math.min(N - 1, j1);
  for (let j = j0; j <= j1; j++) rowActive[j] = ACTIVE_FRAMES;
}
export function touchAll() { rowActive.fill(ACTIVE_FRAMES); }
export function decayRows() { for (let j = 0; j < N; j++) if (rowActive[j]) rowActive[j]--; }

// ---------------------------------------------------------------- generation
export function generate(layoutKey, seed) {
  const L = LAYOUTS[layoutKey];
  const rnd = mulberry32(seed);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    S[k] = S0[k] = Math.max(FLOOR + 0.05, L.gen(xOf(i), zOf(j), seed));
  }
  initTint();
  P.fill(0);
  resetWater();
  for (let k = 0; k < NN; k++) M[k] = S[k] < 0.15 ? 1 : 0;
  computeOceanEdges();
  touchAll();

  // buried treasures
  const buried = [];
  const types = FINDABLE.filter(t => ITEMS[t].weight > 0);
  const total = types.reduce((s, t) => s + ITEMS[t].weight, 0);
  const pick = () => { let r = rnd() * total; for (const t of types) { r -= ITEMS[t].weight; if (r <= 0) return t; } return types[0]; };
  let tries = 0;
  while (buried.length < 34 && tries++ < 4000) {
    const x = (rnd() * 2 - 1) * (HALF - 1), z = (rnd() * 2 - 1) * (HALF - 1);
    const h = heightAt(x, z);
    if (h < -0.2) continue;
    buried.push({ type: pick(), x, z, y: h - (0.12 + rnd() * 0.45) });
  }
  tries = 0; let coins = 0;
  while (coins < 2 && tries++ < 4000) {
    const x = (rnd() * 2 - 1) * (HALF - 2), z = (rnd() * 2 - 1) * (HALF - 2);
    const h = heightAt(x, z);
    if (h < 0.25) continue;
    buried.push({ type: 'coin', x, z, y: h - (0.7 + rnd() * 0.25) });
    coins++;
  }
  return buried;
}

export function initTint() {
  for (let k = 0; k < NN; k++) TINT[k] = hash2(k % N, (k / N) | 0, 99);
}

// Open-sea boundary cells: perimeter cells that started below sea level.
export function computeOceanEdges() {
  const e = [];
  const add = k => { if (S0[k] < 0.1) e.push(k); };
  for (let i = 0; i < N; i++) { add(i); add((N - 1) * N + i); }
  for (let j = 1; j < N - 1; j++) { add(j * N); add(j * N + N - 1); }
  oceanEdge = Int32Array.from(e);
}

export function resetWater() {
  const lvl = ocean.seaLevel();
  SED.fill(0); FL.fill(0); FR.fill(0); FT.fill(0); FB.fill(0); VX.fill(0); VZ.fill(0);
  rowWet.fill(0);
  for (let k = 0; k < NN; k++) {
    W[k] = S[k] < lvl ? lvl - S[k] : 0;
    if (W[k] > 0) rowWet[(k / N) | 0] = 1;
  }
}

// ---------------------------------------------------------------- sampling
export function heightAt(x, z, arr = S) {
  const fx = clamp((x + HALF) / CELL, 0, N - 1.001), fz = clamp((z + HALF) / CELL, 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const k = j * N + i;
  return lerp(lerp(arr[k], arr[k + 1], u), lerp(arr[k + N], arr[k + N + 1], u), v);
}
export function cellOf(x, z) {
  const i = clamp(Math.round((x + HALF) / CELL), 0, N - 1), j = clamp(Math.round((z + HALF) / CELL), 0, N - 1);
  return j * N + i;
}

// ---------------------------------------------------------------- water (virtual pipes)
const VMAX = 8;
export function waterStep(dt) {
  ocean.beginStep();
  const A = dt * CELL * G, area = CELL * CELL;

  // pass 1: outflow fluxes (dry cells have none)
  for (let j = 0; j < N; j++) {
    if (!rowWet[j]) continue;
    const row = j * N;
    for (let i = 0; i < N; i++) {
      const k = row + i, w = W[k];
      if (w <= 0) { FL[k] = FR[k] = FT[k] = FB[k] = 0; continue; }
      const h = S[k] + w;
      const damp = 1 / (1 + dt * (0.12 + 0.006 / (w + 0.006)));
      let fl = 0, fr = 0, ft = 0, fb = 0;
      if (i > 0)     { fl = (FL[k] + A * (h - S[k - 1] - W[k - 1])) * damp; if (fl < 0) fl = 0; }
      if (i < N - 1) { fr = (FR[k] + A * (h - S[k + 1] - W[k + 1])) * damp; if (fr < 0) fr = 0; }
      if (j > 0)     { ft = (FT[k] + A * (h - S[k - N] - W[k - N])) * damp; if (ft < 0) ft = 0; }
      if (j < N - 1) { fb = (FB[k] + A * (h - S[k + N] - W[k + N])) * damp; if (fb < 0) fb = 0; }
      const sum = fl + fr + ft + fb;
      if (sum > 0) {
        const K = Math.min(1, w * area / (sum * dt));
        fl *= K; fr *= K; ft *= K; fb *= K;
      }
      FL[k] = fl; FR[k] = fr; FT[k] = ft; FB[k] = fb;
    }
  }

  // pass 2: apply fluxes, derive velocity
  rowNext.fill(0);
  for (let j = 0; j < N; j++) {
    if (!(rowWet[j] || (j > 0 && rowWet[j - 1]) || (j < N - 1 && rowWet[j + 1]))) continue;
    const row = j * N;
    let wet = 0;
    for (let i = 0; i < N; i++) {
      const k = row + i;
      const inL = i > 0 && rowWet[j] ? FR[k - 1] : 0, inR = i < N - 1 && rowWet[j] ? FL[k + 1] : 0;
      const inT = j > 0 && rowWet[j - 1] ? FB[k - N] : 0, inB = j < N - 1 && rowWet[j + 1] ? FT[k + N] : 0;
      const w0 = W[k];
      const inflow = inL + inR + inT + inB;
      if (w0 === 0 && inflow === 0) { VX[k] = 0; VZ[k] = 0; continue; }
      const outL = rowWet[j] ? FL[k] : 0, outR = rowWet[j] ? FR[k] : 0;
      const outT = rowWet[j] ? FT[k] : 0, outB = rowWet[j] ? FB[k] : 0;
      let w1 = w0 + dt * (inflow - outL - outR - outT - outB) / area;
      if (w1 < 0) w1 = 0;
      W[k] = w1;
      if (w1 > 0) wet = 1;
      const d = (w0 + w1) * 0.5;
      if (d > 0.003) {
        let vx = (inL - outL + outR - inR) * 0.5 / (CELL * d);
        let vz = (inT - outT + outB - inB) * 0.5 / (CELL * d);
        const sp = Math.hypot(vx, vz);
        if (sp > VMAX) { vx *= VMAX / sp; vz *= VMAX / sp; }
        VX[k] = vx; VZ[k] = vz;
      } else { VX[k] = 0; VZ[k] = 0; }
    }
    rowNext[j] = wet;
  }

  // ocean boundary (open sea: can both fill and drain)
  for (let j = 0; j < N; j++) tgtRow[j] = ocean.target(zOf(j));
  for (let e = 0; e < oceanEdge.length; e++) {
    const k = oceanEdge[e], j = (k / N) | 0;
    const w = tgtRow[j] - S[k];
    W[k] = w > 0 ? w : 0;
    if (w > 0) rowNext[j] = 1;
  }

  // rows that just dried out: clear their stale fluxes
  for (let j = 0; j < N; j++) {
    if (rowWet[j] && !rowNext[j]) {
      const a = j * N, b = a + N;
      FL.fill(0, a, b); FR.fill(0, a, b); FT.fill(0, a, b); FB.fill(0, a, b);
    }
  }
  rowWet.set(rowNext);
}

export function groundwater(dt) {
  const wt = ocean.seaLevel() - 0.02;
  const seep = Math.min(1, 0.06 * dt), drain = 0.006 * dt;
  for (let j = 0; j < N; j++) {
    const row = j * N;
    let wet = rowWet[j];
    for (let i = 0; i < N; i++) {
      const k = row + i, s = S[k], w = W[k];
      if (w === 0 && s >= wt) continue;
      const h = s + w;
      if (h < wt) { W[k] = w + (wt - h) * seep; wet = 1; }
      else if (w > 0 && s > wt) W[k] = w > drain ? w - drain : 0;
    }
    rowWet[j] = wet;
  }
}

// ---------------------------------------------------------------- sand transport
const KC = 0.05, KS = 1.6, KD = 1.2, KL = 0.5, CAP_MAX = 0.35;
export function sedimentStep(dt) {
  for (let j = 0; j < N; j++) {
    if (!rowWet[j] && !rowSed[j]) continue;
    const row = j * N;
    let changed = false, sedLeft = 0;
    for (let i = 0; i < N; i++) {
      const k = row + i, w = W[k];
      if (w > 0.004) {
        const sp = Math.hypot(VX[k], VZ[k]);
        const cap = Math.min(CAP_MAX, KC * sp * Math.min(1, w * 8));
        const sd = SED[k];
        if (sd < cap) {
          let amt = KS * (1 - 0.7 * P[k]) * (cap - sd) * dt;
          amt = Math.min(amt, S[k] - FLOOR);
          S[k] -= amt; SED[k] = sd + amt;
          if (amt > 2e-4) changed = true;
        } else {
          const amt = KD * (sd - cap) * dt;
          S[k] += amt; SED[k] = sd - amt;
          if (amt > 2e-4) changed = true;
        }
        if (P[k] > 0) P[k] = Math.max(0, P[k] - dt * (0.012 + 0.16 * sp));
        if (sp > 0.08 && undercut(k, i, sp, w, dt)) changed = true;
        sedLeft = 1;
      } else if (SED[k] > 0) { S[k] += SED[k]; SED[k] = 0; changed = true; }
    }
    rowSed[j] = sedLeft;
    if (changed) touchRows(j - 1, j + 1);
  }
  // semi-Lagrangian advection of suspended sand
  const s = dt / CELL;
  for (let j = 0; j < N; j++) {
    if (!rowSed[j]) continue;
    const row = j * N;
    for (let i = 0; i < N; i++) {
      const k = row + i;
      if (W[k] <= 0.004) { SED2[k] = 0; continue; }
      const fx = clamp(i - VX[k] * s, 0, N - 1.001), fz = clamp(j - VZ[k] * s, 0, N - 1.001);
      const ii = fx | 0, jj = fz | 0, u = fx - ii, v = fz - jj, q = jj * N + ii;
      SED2[k] = lerp(lerp(SED[q], SED[q + 1], u), lerp(SED[q + N], SED[q + N + 1], u), v);
    }
  }
  for (let j = 0; j < N; j++) {
    if (!rowSed[j]) continue;
    const a = j * N;
    for (let k = a; k < a + N; k++) SED[k] = SED2[k];
  }
}

// Moving water erodes neighbouring walls that stick out above it.
function undercut(k, i, sp, w, dt) {
  const top = S[k] + w;
  let hit = false;
  for (let d = 0; d < 4; d++) {
    const n = d === 0 ? (i > 0 ? k - 1 : -1) : d === 1 ? (i < N - 1 ? k + 1 : -1) : d === 2 ? k - N : k + N;
    if (n < 0 || n >= NN || S[n] <= top || W[n] > 0.02) continue;
    const pn = P[n];
    P[n] = Math.max(0, pn - dt * 0.35 * sp);
    const amt = Math.min(KL * sp * Math.min(w, 0.3) * (1 - 0.75 * pn) * dt, S[n] - top);
    S[n] -= amt; SED[k] += amt;
    hit = true;
  }
  return hit;
}

function talus(k) {
  const p = P[k];
  return W[k] > 0.02 ? lerp(0.45, 5.5, p * p) : lerp(0.75, 8, p);
}
let slumped = false;
function slump(a, b) {
  const d = S[a] - S[b];
  if (d > 0) {
    const t = talus(a) * CELL;
    if (d > t) { const m = (d - t) * 0.35; S[a] -= m; S[b] += m; if (m > 0.01) P[b] *= 0.97; if (m > 1e-4) slumped = true; }
  } else {
    const t = talus(b) * CELL;
    if (-d > t) { const m = (-d - t) * 0.35; S[b] -= m; S[a] += m; if (m > 0.01) P[a] *= 0.97; if (m > 1e-4) slumped = true; }
  }
}
// Angle-of-repose relaxation, only over rows whose sand recently moved.
export function thermalStep() {
  for (let j = 0; j < N; j++) {
    const act = rowActive[j] > 0, actNext = j < N - 1 && rowActive[j + 1] > 0;
    if (!act && !actNext) continue;
    const row = j * N;
    slumped = false;
    if (act) for (let i = 0; i < N - 1; i++) slump(row + i, row + i + 1);
    if (j < N - 1) for (let i = 0; i < N; i++) slump(row + i, row + i + N);
    if (slumped) touchRows(j - 1, j + 2);
  }
}

export function moistureStep(dt) {
  const wt = ocean.seaLevel();
  for (let k = 0; k < NN; k++) {
    if (W[k] > 0.008) { M[k] = 1; continue; }
    const ground = clamp(1 - (S[k] - wt) / 0.45, 0, 0.9);
    const m = M[k] - dt / 150;
    M[k] = m > ground ? m : ground;
  }
}

export function computeStats() {
  let mx = -9, moat = 0;
  for (let k = 0; k < NN; k++) {
    if (S[k] > mx) mx = S[k];
    if (S0[k] > 0.45 && W[k] > 0.04) moat++;
  }
  return { maxHeight: Math.max(0, mx), moatCells: moat };
}
