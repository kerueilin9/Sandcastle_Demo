import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================================================
// World constants
// ============================================================================
const N = 160;                 // grid resolution
const CELL = 0.15;             // meters per cell
const SIZE = (N - 1) * CELL;
const HALF = SIZE / 2;
const NN = N * N;
const FLOOR = -1.6;            // hard bottom, can't dig below
const BASE = -2.3;             // diorama base
const G = 9.81;
const BUCKET_VOL = 0.05;       // m³ per "bucket" of sand
const SAND_MAX = 300 * BUCKET_VOL;
const SAVE_KEY = 'sandcastle-web-v1';

// Simulation fields
const S = new Float32Array(NN);   // sand height
const S0 = new Float32Array(NN);  // original sand height
const W = new Float32Array(NN);   // water depth
const P = new Float32Array(NN);   // packing 0..1
const M = new Float32Array(NN);   // wetness (visual) 0..1
const SED = new Float32Array(NN), SED2 = new Float32Array(NN);
const FL = new Float32Array(NN), FR = new Float32Array(NN), FT = new Float32Array(NN), FB = new Float32Array(NN);
const VX = new Float32Array(NN), VZ = new Float32Array(NN);
const TINT = new Float32Array(NN);

const xOf = i => -HALF + i * CELL;
const zOf = j => -HALF + j * CELL;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ============================================================================
// Noise / RNG
// ============================================================================
function hash2(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}
function fbm(x, y, seed) {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { s += a * vnoise(x * f, y * f, seed + o * 17); a *= 0.5; f *= 2.03; }
  return s;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Content definitions
// ============================================================================
const LAYOUTS = {
  beach: {
    name: '晴朗海灘', desc: '平緩的沙灘，海浪從遠方湧來', need: 0,
    gen(x, z, sd) {
      const t = (z + HALF) / SIZE;
      let h = lerp(-1.15, 0.85, smooth(0.04, 0.8, t));
      h += 0.16 * Math.max(0, 1 - Math.abs(t - 0.42) * 10);          // berm
      h += 0.12 * fbm(x * 0.18, z * 0.18, sd) + 0.03 * fbm(x * 0.9, z * 0.9, sd + 5);
      return h;
    },
  },
  island: {
    name: '小小海島', desc: '四面環海的圓形小島', need: 2,
    gen(x, z, sd) {
      const ang = Math.atan2(z, x);
      const R = HALF * (0.55 + 0.08 * vnoise(Math.cos(ang) * 2 + 3, Math.sin(ang) * 2 + 3, sd));
      const r = Math.hypot(x, z) / R;
      let h = 0.9 - 1.85 * r * r;
      h = Math.max(h, -1.3 + 0.1 * r);
      h += 0.1 * fbm(x * 0.2, z * 0.2, sd) + 0.03 * fbm(x, z, sd + 9);
      return h;
    },
  },
  lagoon: {
    name: '藍色潟湖', desc: '環狀沙洲圍住平靜的潟湖', need: 4,
    gen(x, z, sd) {
      const r = Math.hypot(x, z) / (HALF * 0.95);
      const ring = Math.exp(-(((r - 0.62) / 0.17) ** 2));
      let h = -1.25 + 2.0 * ring + 0.12 * fbm(x * 0.2, z * 0.2, sd);
      if (z < 0 && Math.abs(x + 0.6 * Math.sin(z * 0.4)) < 1.1) h = Math.min(h, -0.35);
      if (r > 0.8) h = Math.min(h, -1.2 + (1 - r) * 0.5);
      return h;
    },
  },
  sandbar: {
    name: '細長沙洲', desc: '低矮的沙洲，大浪會越過頂端', need: 6,
    gen(x, z, sd) {
      const zc = 1.2 * Math.sin(x * 0.28 + 1);
      let h = -1.2 + 1.6 * Math.exp(-(((z - zc) / 2.6) ** 2));
      h += 0.25 * Math.exp(-((x - 2.5) ** 2 + (z - zc) ** 2) / 6);
      h += 0.08 * fbm(x * 0.25, z * 0.25, sd);
      return h;
    },
  },
};

const ITEMS = {
  shell:     { name: '貝殼',   icon: '🐚', weight: 30, drift: 0.45, float: false },
  pebble:    { name: '鵝卵石', icon: '🪨', weight: 24, drift: 0.08, float: false },
  starfish:  { name: '海星',   icon: '⭐', weight: 15, drift: 0.4,  float: false },
  seaweed:   { name: '海藻',   icon: '🌿', weight: 15, drift: 1.0,  float: true },
  driftwood: { name: '漂流木', icon: '🪵', weight: 10, drift: 0.9,  float: true },
  bottle:    { name: '瓶中信', icon: '🍾', weight: 5,  drift: 1.0,  float: true },
  coin:      { name: '古金幣', icon: '🪙', weight: 0,  drift: 0.0,  float: false },
  flag:      { name: '小旗子', icon: '🚩', weight: 0,  drift: 0.25, float: false },
};
const FINDABLE = ['shell', 'pebble', 'starfish', 'seaweed', 'driftwood', 'bottle', 'coin'];

const TOOLS = [
  { id: 'shovel', name: '鏟子', hint: '挖沙，沙會收進沙桶庫存' },
  { id: 'pile',   name: '堆沙', hint: '倒出濕沙並壓實' },
  { id: 'smooth', name: '抹平', hint: '拍平、壓實沙面' },
  { id: 'bucket', name: '沙桶', hint: '點一下倒扣出圓塔', lock: 'dig' },
  { id: 'carve',  name: '雕刻刀', hint: '在牆頂刻出城垛與凹槽', lock: 'tower' },
  { id: 'decor',  name: '裝飾', hint: '擺放寶物；點擊已擺放的可收回' },
];
const TOOL_ICONS = {
  shovel: '<svg viewBox="0 0 32 32"><path d="M16 3v15" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round"/><path d="M12 3h8" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round"/><path d="M10 18h12v4a6 6 0 0 1-12 0z" fill="#e85d4a"/></svg>',
  pile: '<svg viewBox="0 0 32 32"><path d="M3 26c4-10 8-15 13-15s9 5 13 15z" fill="#e7b866"/><path d="M8 20c2-2 4-3 6-3" stroke="#fff6" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 4v5M13 7l3 3 3-3" stroke="#3a7fb0" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
  smooth: '<svg viewBox="0 0 32 32"><path d="M5 22h22l-3 4H8z" fill="#9aa7b4"/><path d="M16 22V10" stroke="#8a5a2b" stroke-width="3"/><rect x="12" y="5" width="8" height="7" rx="2.5" fill="#e85d4a"/></svg>',
  bucket: '<svg viewBox="0 0 32 32"><path d="M7 10h18l-2.3 16H9.3z" fill="#3ea7d8"/><path d="M6 10h20" stroke="#1f6e96" stroke-width="2.5" stroke-linecap="round"/><path d="M10 10a6 6 0 0 1 12 0" stroke="#1f6e96" stroke-width="2" fill="none"/></svg>',
  carve: '<svg viewBox="0 0 32 32"><path d="M6 26l12-12 4 4-12 12z" fill="#8a5a2b"/><path d="M18 14l7-9 2 2-5 11z" fill="#c9d3dc"/><path d="M4 9h3v3h3V9h3v3h3V9h3v6H4z" fill="#e7b866" opacity=".9"/></svg>',
  decor: '<svg viewBox="0 0 32 32"><path d="M16 4l3.4 7 7.6 1-5.5 5.3 1.3 7.6L16 21.3 9.2 24.9l1.3-7.6L5 12l7.6-1z" fill="#f28a4a"/><circle cx="16" cy="15" r="2" fill="#ffd2a8"/></svg>',
};

const OBJECTIVES = [
  { id: 'dig', title: '初試身手', desc: '用鏟子挖起 25 桶沙', target: 25, prog: () => st.digTotal / BUCKET_VOL, reward: '解鎖工具：沙桶' },
  { id: 'tower', title: '第一座高塔', desc: '把沙堆到海平面以上 1.6 公尺', target: 1.6, unit: 'm', prog: () => maxHeight, reward: '解鎖工具：雕刻刀' },
  { id: 'collect', title: '海灘拾荒者', desc: '撿起 6 件海灘寶物', target: 6, prog: () => st.totalCollected, reward: '獲得 3 支小旗子' },
  { id: 'decor', title: '裝飾師', desc: '在沙上擺放 8 件裝飾', target: 8, prog: () => placedCount() },
  { id: 'moat', title: '護城河', desc: '讓海水流進 80 格原本乾燥的沙地', target: 80, prog: () => moatCells },
  { id: 'survive', title: '屹立不搖', desc: '大浪過後城堡仍高於 1.2 公尺（3 次）', target: 3, prog: () => st.survived },
  { id: 'coin', title: '寶藏獵人', desc: '挖出深埋在沙裡的古金幣', target: 1, prog: () => st.collected.coin || 0 },
  { id: 'all', title: '收藏家', desc: '找齊 7 種海灘寶物', target: 7, prog: () => FINDABLE.filter(t => st.collected[t]).length },
];

const WAVE_MODES = {
  calm:   { amp: 0.02, tide: 0.05, setEvery: Infinity, setAmp: 1 },
  normal: { amp: 0.08, tide: 0.18, setEvery: 55, setAmp: 3.5 },
  rough:  { amp: 0.13, tide: 0.22, setEvery: 32, setAmp: 3.6 },
};
const SET_LEN = 16;

// ============================================================================
// Game state
// ============================================================================
let st = freshState();
function freshState() {
  return {
    layout: 'beach', seed: (Math.random() * 1e9) | 0,
    sand: 60 * BUCKET_VOL, digTotal: 0, totalCollected: 0, survived: 0,
    collected: {}, inventory: { flag: 2, shell: 1 }, done: {},
    tool: 'shovel', item: 'flag', brush: 0.9, waves: 'normal', sound: true, time: 0,
  };
}
let items = [];     // {type, x, z, y, state:'loose'|'placed', mesh, yaw, t}
let buried = [];    // {type, x, z, y}
let maxHeight = 0, moatCells = 0;
let undoStack = [];
const placedCount = () => items.reduce((n, it) => n + (it.state === 'placed' ? 1 : 0), 0);
const isUnlocked = tool => { const t = TOOLS.find(x => x.id === tool); return !t.lock || st.done[t.lock]; };

// ============================================================================
// Terrain generation
// ============================================================================
function generate(layoutKey, seed) {
  const L = LAYOUTS[layoutKey];
  const rnd = mulberry32(seed);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const h = Math.max(FLOOR + 0.05, L.gen(xOf(i), zOf(j), seed));
    S[k] = S0[k] = h;
    TINT[k] = hash2(i, j, 99);
  }
  P.fill(0); SED.fill(0); FL.fill(0); FR.fill(0); FT.fill(0); FB.fill(0); VX.fill(0); VZ.fill(0);
  initWater();
  for (let k = 0; k < NN; k++) M[k] = S[k] < 0.15 ? 1 : 0;

  // buried treasures
  buried = [];
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
}
function initWater() {
  const lvl = seaLevel();
  for (let k = 0; k < NN; k++) W[k] = S[k] < lvl ? lvl - S[k] : 0;
}

function heightAt(x, z, arr = S) {
  const fx = clamp((x + HALF) / CELL, 0, N - 1.001), fz = clamp((z + HALF) / CELL, 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const k = j * N + i;
  return lerp(lerp(arr[k], arr[k + 1], u), lerp(arr[k + N], arr[k + N + 1], u), v);
}
function cellOf(x, z) {
  const i = clamp(Math.round((x + HALF) / CELL), 0, N - 1), j = clamp(Math.round((z + HALF) / CELL), 0, N - 1);
  return j * N + i;
}

// ============================================================================
// Ocean forcing
// ============================================================================
let simTime = 0, setStart = -1, nextSet = 25;
function waveMode() { return WAVE_MODES[st.waves]; }
function seaLevel() { return waveMode().tide * Math.sin(simTime * 2 * Math.PI / 200); }
function setEnvelope() {
  if (setStart < 0) return 0;
  const t = (simTime - setStart) / SET_LEN;
  return t >= 0 && t <= 1 ? Math.sin(Math.PI * t) : 0;
}
const OMEGA = 2 * Math.PI / 6.5, KWAVE = 2 * Math.PI / 16;
function boundaryTarget(z) {
  const m = waveMode();
  const amp = m.amp * (1 + (m.setAmp - 1) * setEnvelope());
  const ph = OMEGA * simTime - KWAVE * (z + HALF);
  // slightly peaky waveform
  const s = Math.sin(ph);
  return seaLevel() + amp * (s + 0.25 * Math.sin(2 * ph - 0.6));
}
const EDGE = [];
for (let i = 0; i < N; i++) { EDGE.push(i, (N - 1) * N + i); }
for (let j = 1; j < N - 1; j++) { EDGE.push(j * N, j * N + N - 1); }

function updateWaveSets(dt) {
  const m = waveMode();
  if (setStart >= 0 && simTime - setStart > SET_LEN) {
    setStart = -1;
    if (m.setEvery !== Infinity) {
      if (maxHeight >= 1.2) {
        st.survived++;
        toast('🏰 城堡撐過了這波大浪！');
      }
    }
    nextSet = simTime + m.setEvery;
  }
  if (setStart < 0 && simTime >= nextSet && m.setEvery !== Infinity) {
    setStart = simTime;
    toast('🌊 大浪來了！', false);
  }
  if (m.setEvery === Infinity) nextSet = simTime + 30;
}

// ============================================================================
// Simulation
// ============================================================================
function waterStep(dt) {
  const A = dt * CELL * G, area = CELL * CELL;
  for (let j = 0; j < N; j++) {
    const row = j * N;
    for (let i = 0; i < N; i++) {
      const k = row + i, w = W[k], h = S[k] + w;
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
  for (let j = 0; j < N; j++) {
    const row = j * N;
    for (let i = 0; i < N; i++) {
      const k = row + i;
      const inL = i > 0 ? FR[k - 1] : 0, inR = i < N - 1 ? FL[k + 1] : 0;
      const inT = j > 0 ? FB[k - N] : 0, inB = j < N - 1 ? FT[k + N] : 0;
      const out = FL[k] + FR[k] + FT[k] + FB[k];
      const w0 = W[k];
      let w1 = w0 + dt * (inL + inR + inT + inB - out) / area;
      if (w1 < 0) w1 = 0;
      W[k] = w1;
      const d = (w0 + w1) * 0.5;
      if (d > 0.003) {
        let vx = (inL - FL[k] + FR[k] - inR) * 0.5 / (CELL * d);
        let vz = (inT - FT[k] + FB[k] - inB) * 0.5 / (CELL * d);
        const sp = Math.hypot(vx, vz);
        if (sp > 4) { vx *= 4 / sp; vz *= 4 / sp; }
        VX[k] = vx; VZ[k] = vz;
      } else { VX[k] = 0; VZ[k] = 0; }
    }
  }
  // ocean boundary
  for (let e = 0; e < EDGE.length; e++) {
    const k = EDGE[e];
    const tgt = boundaryTarget(zOf((k / N) | 0));
    if (S[k] < tgt) W[k] = tgt - S[k];
  }
}

function groundwater(dt) {
  const wt = seaLevel() - 0.02;
  for (let k = 0; k < NN; k++) {
    const s = S[k], w = W[k], h = s + w;
    if (h < wt) W[k] = w + (wt - h) * Math.min(1, 0.06 * dt);       // seep into holes below water table
    else if (w > 0 && s > wt) W[k] = Math.max(0, w - 0.006 * dt);   // drain into dry sand
  }
}

const KC = 0.05, KS = 1.6, KD = 1.2;
function sedimentStep(dt) {
  for (let k = 0; k < NN; k++) {
    const w = W[k];
    if (w > 0.004) {
      const sp = Math.hypot(VX[k], VZ[k]);
      const cap = KC * sp * Math.min(1, w * 8);
      const sd = SED[k];
      if (sd < cap) {
        let amt = KS * (1 - 0.7 * P[k]) * (cap - sd) * dt;
        amt = Math.min(amt, S[k] - FLOOR);
        S[k] -= amt; SED[k] = sd + amt;
      } else {
        const amt = KD * (sd - cap) * dt;
        S[k] += amt; SED[k] = sd - amt;
      }
      // soaking loosens packed sand
      if (P[k] > 0) P[k] = Math.max(0, P[k] - dt * (0.012 + 0.16 * sp));
      // moving water undercuts neighbouring walls that stick out above it
      if (sp > 0.08) undercut(k, sp, w, dt);
    } else if (SED[k] > 0) { S[k] += SED[k]; SED[k] = 0; }
  }
  // semi-Lagrangian advection
  const s = dt / CELL;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (W[k] <= 0.004) { SED2[k] = 0; continue; }
    const fx = clamp(i - VX[k] * s, 0, N - 1.001), fz = clamp(j - VZ[k] * s, 0, N - 1.001);
    const ii = fx | 0, jj = fz | 0, u = fx - ii, v = fz - jj, q = jj * N + ii;
    SED2[k] = lerp(lerp(SED[q], SED[q + 1], u), lerp(SED[q + N], SED[q + N + 1], u), v);
  }
  // conserve mass loosely: deposit any sediment lost onto dry cells
  for (let k = 0; k < NN; k++) {
    if (W[k] <= 0.004) { SED[k] = 0; } else SED[k] = SED2[k];
  }
}

const KL = 0.5;
function undercut(k, sp, w, dt) {
  const i = k % N, top = S[k] + w;
  for (let d = 0; d < 4; d++) {
    const n = d === 0 ? (i > 0 ? k - 1 : -1) : d === 1 ? (i < N - 1 ? k + 1 : -1) : d === 2 ? k - N : k + N;
    if (n < 0 || n >= NN || S[n] <= top || W[n] > 0.02) continue;
    const pn = P[n];
    P[n] = Math.max(0, pn - dt * 0.35 * sp);
    const amt = Math.min(KL * sp * Math.min(w, 0.3) * (1 - 0.75 * pn) * dt, S[n] - top);
    S[n] -= amt; SED[k] += amt;
  }
}

function talus(k) {
  const p = P[k];
  return W[k] > 0.02 ? lerp(0.45, 5.5, p * p) : lerp(0.75, 8, p);
}
function thermalStep() {
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i < N - 1) slump(k, k + 1);
      if (j < N - 1) slump(k, k + N);
    }
  }
}
function slump(a, b) {
  const d = S[a] - S[b];
  if (d > 0) {
    const t = talus(a) * CELL;
    if (d > t) { const m = (d - t) * 0.35; S[a] -= m; S[b] += m; if (m > 0.01) P[b] *= 0.97; }
  } else {
    const t = talus(b) * CELL;
    if (-d > t) { const m = (-d - t) * 0.35; S[b] -= m; S[a] += m; if (m > 0.01) P[a] *= 0.97; }
  }
}

function moistureStep(dt) {
  const wt = seaLevel();
  for (let k = 0; k < NN; k++) {
    if (W[k] > 0.008) { M[k] = 1; continue; }
    const ground = clamp(1 - (S[k] - wt) / 0.45, 0, 0.9);
    M[k] = Math.max(ground, M[k] - dt / 150);
  }
}

function computeStats() {
  let mx = -9, moat = 0;
  for (let k = 0; k < NN; k++) {
    if (S[k] > mx) mx = S[k];
    if (S0[k] > 0.45 && W[k] > 0.04) moat++;
  }
  maxHeight = Math.max(0, mx);
  moatCells = moat;
}

// ============================================================================
// Three.js setup
// ============================================================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
camera.position.set(0, 21, 27);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 75;
controls.maxPolarAngle = 1.38;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.addEventListener('change', () => { pickDirty = true; });

scene.add(new THREE.HemisphereLight(0xcfeeff, 0xb89a70, 0.75));
const sun = new THREE.DirectionalLight(0xfff0d0, 2.1);
sun.position.set(12, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// shared grid index
const gridIndex = (() => {
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let p = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b;
    idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  return new THREE.BufferAttribute(idx, 1);
})();

function makeGrid(colorSize) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(NN * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    pos[k * 3] = xOf(i); pos[k * 3 + 2] = zOf(j);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(NN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NN * colorSize), colorSize).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(gridIndex);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), HALF * 1.5);
  return g;
}

const terrainGeo = makeGrid(3);
const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
terrain.castShadow = terrain.receiveShadow = true;
scene.add(terrain);

const waterGeo = makeGrid(4);
const water = new THREE.Mesh(waterGeo, new THREE.MeshPhysicalMaterial({
  vertexColors: true, transparent: true, roughness: 0.08, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15,
  specularIntensity: 1, depthWrite: false,
}));
water.receiveShadow = true;
water.renderOrder = 2;
scene.add(water);

// Diorama skirts (edges of the sand block and water)
function makeSkirt(colorSize) {
  const g = new THREE.BufferGeometry();
  const verts = 4 * N * 2;
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  const idx = [];
  const sides = skirtSides();
  sides.forEach((side, s) => {
    side.cells.forEach((k, c) => {
      const v = (s * N + c) * 2;
      const i = k % N, j = (k / N) | 0;
      for (const o of [0, 1]) {
        pos[(v + o) * 3] = xOf(i); pos[(v + o) * 3 + 2] = zOf(j);
        nrm[(v + o) * 3] = side.n[0]; nrm[(v + o) * 3 + 2] = side.n[2];
      }
      if (c < N - 1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    });
  });
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * colorSize), colorSize).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), HALF * 1.6);
  return g;
}
let _sides;
function skirtSides() {
  if (_sides) return _sides;
  const a = [], b = [], c = [], d = [];
  for (let i = 0; i < N; i++) { a.push(i); c.push((N - 1) * N + (N - 1 - i)); }
  for (let j = 0; j < N; j++) { b.push(j * N + N - 1); d.push((N - 1 - j) * N); }
  _sides = [{ cells: a, n: [0, 0, -1] }, { cells: b, n: [1, 0, 0] }, { cells: c, n: [0, 0, 1] }, { cells: d, n: [-1, 0, 0] }];
  return _sides;
}
const skirtGeo = makeSkirt(3);
const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
skirt.castShadow = skirt.receiveShadow = true;
scene.add(skirt);
const wskirtGeo = makeSkirt(4);
const wskirt = new THREE.Mesh(wskirtGeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false }));
wskirt.renderOrder = 3;
scene.add(wskirt);
const bottom = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8c6b4a }));
bottom.position.y = BASE;
scene.add(bottom);
const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.12 }));
ground.position.y = BASE - 0.4;
ground.receiveShadow = true;
scene.add(ground);

// Brush ring
const RING_SEG = 72;
const ringGeo = new THREE.BufferGeometry();
ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEG + 1) * 3), 3));
const ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
ring.renderOrder = 10;
ring.frustumCulled = false;
scene.add(ring);
const ringDot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
ringDot.renderOrder = 10;
scene.add(ringDot);

// ============================================================================
// Rendering updates
// ============================================================================
const DRY = [0.93, 0.79, 0.55], WET = [0.68, 0.53, 0.35], SIDE_BOT = [0.5, 0.37, 0.25];
function updateTerrainMesh() {
  const pos = terrainGeo.attributes.position.array, nrm = terrainGeo.attributes.normal.array, col = terrainGeo.attributes.color.array;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, s = S[k];
    pos[k * 3 + 1] = s;
    const hl = S[i > 0 ? k - 1 : k], hr = S[i < N - 1 ? k + 1 : k];
    const ht = S[j > 0 ? k - N : k], hb = S[j < N - 1 ? k + N : k];
    let nx = hl - hr, ny = 2 * CELL, nz = ht - hb;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nrm[k * 3] = nx * inv; nrm[k * 3 + 1] = ny * inv; nrm[k * 3 + 2] = nz * inv;
    const m = M[k], t = 0.93 + 0.12 * TINT[k], deep = smooth(-0.1, -1.2, s) * 0.18;
    col[k * 3] = lerp(DRY[0], WET[0], m) * t * (1 - deep);
    col[k * 3 + 1] = lerp(DRY[1], WET[1], m) * t * (1 - deep * 0.6);
    col[k * 3 + 2] = lerp(DRY[2], WET[2], m) * t * (1 - deep * 0.2);
  }
  terrainGeo.attributes.position.needsUpdate = true;
  terrainGeo.attributes.normal.needsUpdate = true;
  terrainGeo.attributes.color.needsUpdate = true;
}

const WY = new Float32Array(NN);
function updateWaterMesh() {
  const pos = waterGeo.attributes.position.array, nrm = waterGeo.attributes.normal.array, col = waterGeo.attributes.color.array;
  for (let k = 0; k < NN; k++) {
    const w = W[k];
    WY[k] = w > 0.004 ? S[k] + w : S[k] - 0.04;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, w = W[k];
    pos[k * 3 + 1] = WY[k];
    const hl = WY[i > 0 ? k - 1 : k], hr = WY[i < N - 1 ? k + 1 : k];
    const ht = WY[j > 0 ? k - N : k], hb = WY[j < N - 1 ? k + N : k];
    let nx = hl - hr, ny = 2 * CELL, nz = ht - hb;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nrm[k * 3] = nx * inv; nrm[k * 3 + 1] = ny * inv; nrm[k * 3 + 2] = nz * inv;
    const c = k * 4;
    if (w <= 0.004) { col[c + 3] = 0; continue; }
    const d = smooth(0, 1.3, w);
    let r = lerp(0.42, 0.06, d), g = lerp(0.9, 0.42, d), b = lerp(0.86, 0.66, d), a = lerp(0.32, 0.9, d);
    const sp = Math.hypot(VX[k], VZ[k]);
    let foam = clamp(sp * 0.55 - 0.25, 0, 1) * (1 - smooth(0.05, 0.7, w));
    foam = Math.max(foam, (1 - smooth(0.004, 0.035, w)) * 0.55);
    foam *= 0.85 + 0.3 * TINT[k];
    r = lerp(r, 1, foam); g = lerp(g, 1, foam); b = lerp(b, 1, foam);
    a = Math.max(a * smooth(0.004, 0.03, w), foam * 0.85);
    col[c] = r; col[c + 1] = g; col[c + 2] = b; col[c + 3] = a;
  }
  waterGeo.attributes.position.needsUpdate = true;
  waterGeo.attributes.normal.needsUpdate = true;
  waterGeo.attributes.color.needsUpdate = true;
}

function updateSkirts() {
  const sides = skirtSides();
  const p = skirtGeo.attributes.position.array, c = skirtGeo.attributes.color.array;
  const wp = wskirtGeo.attributes.position.array, wc = wskirtGeo.attributes.color.array;
  const tcol = terrainGeo.attributes.color.array;
  sides.forEach((side, s) => side.cells.forEach((k, ci) => {
    const v = (s * N + ci) * 2;
    p[v * 3 + 1] = S[k]; p[(v + 1) * 3 + 1] = BASE;
    c[v * 3] = tcol[k * 3] * 0.9; c[v * 3 + 1] = tcol[k * 3 + 1] * 0.9; c[v * 3 + 2] = tcol[k * 3 + 2] * 0.9;
    c[(v + 1) * 3] = SIDE_BOT[0]; c[(v + 1) * 3 + 1] = SIDE_BOT[1]; c[(v + 1) * 3 + 2] = SIDE_BOT[2];
    const w = W[k];
    wp[v * 3 + 1] = w > 0.004 ? S[k] + w : S[k]; wp[(v + 1) * 3 + 1] = S[k];
    const d = smooth(0, 1.3, w);
    for (const o of [0, 1]) {
      const q = (v + o) * 4;
      wc[q] = lerp(0.35, 0.05, d); wc[q + 1] = lerp(0.8, 0.38, d); wc[q + 2] = lerp(0.85, 0.62, d);
      wc[q + 3] = w > 0.004 ? (o ? 0.85 : 0.55) : 0;
    }
  }));
  skirtGeo.attributes.position.needsUpdate = true; skirtGeo.attributes.color.needsUpdate = true;
  wskirtGeo.attributes.position.needsUpdate = true; wskirtGeo.attributes.color.needsUpdate = true;
}

// ============================================================================
// Items (treasures & decorations)
// ============================================================================
const ITEM_SCALE = 1.5;
const matCache = {};
const mat = (color, opts = {}) => {
  const key = color + JSON.stringify(opts);
  return matCache[key] || (matCache[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts }));
};
function makeItemMesh(type) {
  const g = new THREE.Group();
  const add = (geo, m, f) => { const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; mesh.receiveShadow = true; f && f(mesh); g.add(mesh); return mesh; };
  switch (type) {
    case 'shell': {
      add(new THREE.ConeGeometry(0.12, 0.07, 11, 1, true), mat(0xf7a99c, { side: THREE.DoubleSide, flatShading: true }), m => { m.scale.set(1, 1, 1.15); m.position.y = 0.035; });
      add(new THREE.SphereGeometry(0.03, 8, 6), mat(0xffd9cf), m => { m.position.set(0, 0.02, 0.13); });
      break;
    }
    case 'starfish': {
      const sh = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2, r = i % 2 ? 0.055 : 0.15;
        i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2 });
      add(geo, mat(0xf26b4a), m => { m.rotation.x = -Math.PI / 2; m.position.y = 0.02; });
      break;
    }
    case 'pebble': {
      const c = [0x9aa3a8, 0x7f8a94, 0xb7aea1, 0x6d7a80][Math.floor(Math.random() * 4)];
      add(new THREE.IcosahedronGeometry(0.1, 1), mat(c, { roughness: 0.5, flatShading: true }), m => { m.scale.set(1, 0.55, 0.8); m.position.y = 0.04; });
      break;
    }
    case 'seaweed': {
      for (let i = 0; i < 5; i++) add(new THREE.ConeGeometry(0.025, 0.32, 4), mat(0x3f8f4a, { flatShading: true }), m => {
        m.position.set((Math.random() - 0.5) * 0.12, 0.13, (Math.random() - 0.5) * 0.12);
        m.rotation.set((Math.random() - 0.5) * 0.9, 0, (Math.random() - 0.5) * 0.9);
      });
      break;
    }
    case 'driftwood': {
      add(new THREE.CylinderGeometry(0.035, 0.05, 0.62, 6), mat(0xa48a6c, { flatShading: true }), m => { m.rotation.z = Math.PI / 2; m.position.y = 0.04; });
      add(new THREE.CylinderGeometry(0.018, 0.025, 0.22, 5), mat(0xa48a6c, { flatShading: true }), m => { m.rotation.set(0, 0, Math.PI / 3); m.position.set(0.12, 0.08, 0.04); });
      break;
    }
    case 'bottle': {
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12), mat(0x6fbf8f, { transparent: true, opacity: 0.6, roughness: 0.1 }), m => { m.rotation.z = Math.PI / 2; m.position.y = 0.05; });
      add(new THREE.CylinderGeometry(0.018, 0.03, 0.08, 10), mat(0x6fbf8f, { transparent: true, opacity: 0.6, roughness: 0.1 }), m => { m.rotation.z = Math.PI / 2; m.position.set(0.12, 0.05, 0); });
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), mat(0xf3e5c0), m => { m.rotation.z = Math.PI / 2; m.position.y = 0.05; });
      break;
    }
    case 'coin': {
      add(new THREE.CylinderGeometry(0.09, 0.09, 0.022, 20), mat(0xf2c14e, { metalness: 0.9, roughness: 0.25 }), m => { m.position.y = 0.02; });
      add(new THREE.TorusGeometry(0.065, 0.008, 6, 20), mat(0xd9a12d, { metalness: 0.9, roughness: 0.3 }), m => { m.rotation.x = Math.PI / 2; m.position.y = 0.032; });
      break;
    }
    case 'flag': {
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.75, 6), mat(0xeadbc2), m => { m.position.y = 0.3; });
      const geo = new THREE.PlaneGeometry(0.3, 0.18, 6, 1); geo.translate(0.15, 0, 0);
      add(geo, mat(0xe8483b, { side: THREE.DoubleSide }), m => { m.position.y = 0.58; m.name = 'cloth'; });
      break;
    }
  }
  g.scale.setScalar(ITEM_SCALE);
  return g;
}
const sparkleGeo = new THREE.RingGeometry(0.16, 0.2, 24).rotateX(-Math.PI / 2);
const sparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false });

function spawnItem(type, x, z, state) {
  const mesh = makeItemMesh(type);
  const it = { type, x, z, y: heightAt(x, z), state, mesh, yaw: Math.random() * Math.PI * 2, t: Math.random() * 10, vy: state === 'loose' ? 2.5 : 0 };
  mesh.rotation.y = it.yaw;
  mesh.userData.item = it;
  if (state === 'loose') {
    const sp = new THREE.Mesh(sparkleGeo, sparkleMat.clone());
    sp.name = 'sparkle'; sp.renderOrder = 4;
    mesh.add(sp);
  }
  scene.add(mesh);
  items.push(it);
  return it;
}
function removeItem(it) {
  scene.remove(it.mesh);
  it.mesh.traverse(o => { if (o.geometry && o.geometry !== sparkleGeo) o.geometry.dispose(); });
  items = items.filter(x => x !== it);
}

function updateItems(dt) {
  for (const it of [...items]) {
    const k = cellOf(it.x, it.z);
    const def = ITEMS[it.type];
    const w = W[k];
    let drift = def.drift * (it.state === 'placed' ? 0.5 : 1);
    if (it.type === 'flag' && w < 0.25) drift = 0;
    if (w > 0.06 && drift > 0) {
      it.x += VX[k] * dt * drift; it.z += VZ[k] * dt * drift;
    }
    if (Math.abs(it.x) > HALF - 0.05 || Math.abs(it.z) > HALF - 0.05) {
      if (it.state === 'placed') toast(`${def.icon} ${def.name}被海浪捲走了…`);
      removeItem(it);
      continue;
    }
    const s = heightAt(it.x, it.z);
    const target = def.float && w > 0.1 ? s + w - 0.02 : s;
    if (it.vy > 0 || it.y > target + 0.02) {     // pop-out / falling
      it.vy -= 12 * dt;
      it.y += it.vy * dt;
      if (it.y < target) { it.y = target; it.vy = 0; }
    } else it.y += (target - it.y) * Math.min(1, dt * 12);
    it.t += dt;
    it.mesh.position.set(it.x, it.y, it.z);
    if (it.state === 'loose') {
      it.mesh.rotation.y = it.yaw + Math.sin(it.t * 1.5) * 0.3;
      const sp = it.mesh.getObjectByName('sparkle');
      if (sp) { const p = 1 + 0.25 * Math.sin(it.t * 4); sp.scale.setScalar(p); sp.material.opacity = 0.45 + 0.4 * Math.sin(it.t * 4 + 1); sp.position.y = 0.01; }
    }
    if (it.type === 'flag') {
      const cloth = it.mesh.getObjectByName('cloth');
      if (cloth) cloth.rotation.y = Math.sin(it.t * 3.1) * 0.35 - it.mesh.rotation.y + 0.6;
    }
  }
}

let revealTimer = 0, ashoreTimer = 18;
function updateTreasures(dt) {
  revealTimer -= dt;
  if (revealTimer <= 0) {
    revealTimer = 0.2;
    for (const b of [...buried]) {
      if (heightAt(b.x, b.z) < b.y + 0.03) {
        buried = buried.filter(x => x !== b);
        spawnItem(b.type, b.x, b.z, 'loose');
        sfx('reveal');
      }
    }
  }
  ashoreTimer -= dt;
  if (ashoreTimer <= 0) {
    ashoreTimer = 22 + Math.random() * 25;
    if (items.filter(i => i.state === 'loose').length >= 6) return;
    const types = FINDABLE.filter(t => ITEMS[t].weight > 0);
    const total = types.reduce((s, t) => s + ITEMS[t].weight, 0);
    let r = Math.random() * total, type = types[0];
    for (const t of types) { r -= ITEMS[t].weight; if (r <= 0) { type = t; break; } }
    for (let tries = 0; tries < 600; tries++) {
      const i = 4 + Math.floor(Math.random() * (N - 8)), j = 4 + Math.floor(Math.random() * (N - 8));
      const k = j * N + i;
      if (W[k] > 0.004 && W[k] < 0.05 && S[k] > seaLevel() - 0.05) {
        spawnItem(type, xOf(i), zOf(j), 'loose').vy = 0;
        break;
      }
    }
  }
}

function collect(it) {
  const def = ITEMS[it.type];
  st.inventory[it.type] = (st.inventory[it.type] || 0) + 1;
  const first = !st.collected[it.type];
  st.collected[it.type] = (st.collected[it.type] || 0) + 1;
  st.totalCollected++;
  removeItem(it);
  sfx('pop');
  toast(`${def.icon} 撿到${def.name}${first ? '（新發現！）' : ''}`);
  renderTray(); renderHud();
}

// ============================================================================
// Tools
// ============================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hover = null, drawing = false, carveLevel = 0, pickDirty = true;

function pickTerrain() {
  raycaster.setFromCamera(mouse, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  // intersect with grid bounding box to get range
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
        const yy = o.y + d.y * m;
        if (yy <= heightAt(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
      }
      return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
    }
    prev = t;
  }
  return null;
}
function pickItem() {
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(items.map(i => i.mesh), true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.item) o = o.parent;
    if (o) return o.userData.item;
  }
  // generous proximity pick for loose items
  const p = pickTerrain();
  if (p) {
    let best = null, bd = 0.35;
    for (const it of items) {
      if (it.state !== 'loose') continue;
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }
  return null;
}

function forCells(cx, cz, R, fn) {
  const i0 = Math.max(0, Math.floor((cx - R + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((cx + R + HALF) / CELL));
  const j0 = Math.max(0, Math.floor((cz - R + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((cz + R + HALF) / CELL));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const d = Math.hypot(xOf(i) - cx, zOf(j) - cz);
    if (d <= R) fn(j * N + i, d / R, i, j);
  }
}
const falloff = q => { const t = 1 - q * q; return t * t; };

let sandWarned = 0;
function applyBrush(p, dt) {
  const R = st.brush;
  switch (st.tool) {
    case 'shovel': {
      if (st.sand >= SAND_MAX) { warnSand('沙桶裝滿了！先去堆點沙吧'); }
      forCells(p.x, p.z, R, (k, q) => {
        let amt = Math.min(1.1 * dt * falloff(q), S[k] - FLOOR);
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
        const f = falloff(q);
        let amt = 0.8 * dt * f;
        const vol = amt * CELL * CELL;
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
      const r = Math.max(CELL * 1.1, R * 0.3);
      forCells(p.x, p.z, r, (k) => {
        if (S[k] > carveLevel) S[k] = Math.max(carveLevel, S[k] - 2.5 * dt * 2);
      });
      break;
    }
  }
}
function warnSand(msg) {
  const now = performance.now();
  if (now - sandWarned > 2500) { toast(msg); sandWarned = now; }
}

function stampBucket(p) {
  const r = Math.max(0.3, st.brush * 0.6), height = 0.6;
  const rTop = r * 0.82;
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
  const type = st.item;
  if (!(st.inventory[type] > 0)) { toast(`沒有${ITEMS[type].name}了`); return; }
  st.inventory[type]--;
  const it = spawnItem(type, p.x, p.z, 'placed');
  it.y = p.y;
  sfx('place');
  renderTray();
}

function pushUndo() {
  undoStack.push({ S: S.slice(), P: P.slice(), sand: st.sand });
  if (undoStack.length > 15) undoStack.shift();
}
function undo() {
  const u = undoStack.pop();
  if (!u) { toast('沒有可以復原的動作'); return; }
  S.set(u.S); P.set(u.P); st.sand = u.sand;
  for (let k = 0; k < NN; k++) if (S[k] + W[k] < S[k]) W[k] = 0;
}

// ---------------------------------------------------------------- pointer input
const activeTouches = new Set();
function setMouse(e) {
  pickDirty = true;
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') {
    activeTouches.add(e.pointerId);
    if (activeTouches.size > 1) { drawing = false; return; }
  }
  if (e.button !== 0) return;
  setMouse(e);
  audioInit();
  const it = pickItem();
  if (it && it.state === 'loose') { collect(it); return; }
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
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= TOOLS.length) selectTool(TOOLS[n - 1].id);
  if (e.key === '[') setBrush(st.brush - 0.15);
  if (e.key === ']') setBrush(st.brush + 0.15);
});

function updateRing() {
  const show = hover && st.tool !== 'decor' || (hover && st.tool === 'decor');
  ring.visible = ringDot.visible = !!show;
  if (!show) return;
  let R = st.brush;
  if (st.tool === 'bucket') R = Math.max(0.3, st.brush * 0.6);
  if (st.tool === 'carve') R = Math.max(CELL * 1.1, st.brush * 0.3);
  if (st.tool === 'decor') R = 0.2;
  const colors = { shovel: 0xffffff, pile: 0xffe08a, smooth: 0xcfe8ff, bucket: 0x7fd3ff, carve: 0xffb38a, decor: 0xffa060 };
  ring.material.color.setHex(colors[st.tool]);
  const a = ringGeo.attributes.position.array;
  for (let s = 0; s <= RING_SEG; s++) {
    const ang = s / RING_SEG * Math.PI * 2;
    const x = hover.x + Math.cos(ang) * R, z = hover.z + Math.sin(ang) * R;
    a[s * 3] = x; a[s * 3 + 1] = heightAt(x, z) + 0.03; a[s * 3 + 2] = z;
  }
  ringGeo.attributes.position.needsUpdate = true;
  ringDot.position.copy(hover);
}

// ============================================================================
// Audio (procedural)
// ============================================================================
let actx = null, oceanGain = null, digGain = null, master = null;
function noiseBuffer(sec, brown) {
  const len = actx.sampleRate * sec, buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}
function audioInit() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = st.sound ? 0.8 : 0; master.connect(actx.destination);
    const src = actx.createBufferSource(); src.buffer = noiseBuffer(6, true); src.loop = true;
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    oceanGain = actx.createGain(); oceanGain.gain.value = 0;
    src.connect(lp).connect(oceanGain).connect(master); src.start();
    const s2 = actx.createBufferSource(); s2.buffer = noiseBuffer(2, false); s2.loop = true;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.7;
    digGain = actx.createGain(); digGain.gain.value = 0;
    s2.connect(bp).connect(digGain).connect(master); s2.start();
  } catch { actx = null; }
}
function sfx(kind) {
  if (!actx || !st.sound) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.connect(g).connect(master);
  const env = (a, d, v) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  if (kind === 'pop') { o.type = 'sine'; o.frequency.setValueAtTime(600, t); o.frequency.exponentialRampToValueAtTime(1300, t + 0.12); env(0.01, 0.25, 0.25); }
  else if (kind === 'reveal') { o.type = 'triangle'; o.frequency.setValueAtTime(1200, t); o.frequency.setValueAtTime(1600, t + 0.08); env(0.01, 0.3, 0.12); }
  else if (kind === 'thud') { o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.2); env(0.005, 0.25, 0.5); }
  else if (kind === 'place') { o.type = 'sine'; o.frequency.setValueAtTime(420, t); env(0.005, 0.12, 0.2); }
  else if (kind === 'done') {
    [523, 659, 784, 1046].forEach((f, i) => {
      const oo = actx.createOscillator(), gg = actx.createGain(); oo.type = 'triangle'; oo.frequency.value = f;
      oo.connect(gg).connect(master);
      gg.gain.setValueAtTime(0, t + i * 0.09); gg.gain.linearRampToValueAtTime(0.15, t + i * 0.09 + 0.01); gg.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.5);
      oo.start(t + i * 0.09); oo.stop(t + i * 0.09 + 0.55);
    });
    return;
  }
  o.start(t); o.stop(t + 0.6);
}
function updateAudio() {
  if (!actx) return;
  const ph = Math.sin(OMEGA * simTime - KWAVE * HALF);
  const m = waveMode();
  const level = (0.05 + 0.5 * m.amp + 0.25 * setEnvelope()) * (0.6 + 0.4 * Math.max(0, ph));
  oceanGain.gain.setTargetAtTime(level, actx.currentTime, 0.3);
  const digging = drawing && hover && ['shovel', 'pile', 'smooth', 'carve'].includes(st.tool);
  digGain.gain.setTargetAtTime(digging ? 0.05 : 0, actx.currentTime, 0.05);
}

// ============================================================================
// UI
// ============================================================================
const $ = id => document.getElementById(id);
function toast(msg, big) {
  const el = document.createElement('div');
  el.className = 'toast' + (big ? ' big' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, big ? 3800 : 2600);
}

function renderTools() {
  $('tools').innerHTML = TOOLS.map((t, i) => {
    const locked = !isUnlocked(t.id);
    const lockObj = t.lock && OBJECTIVES.find(o => o.id === t.lock);
    const title = locked ? `${t.name}（完成「${lockObj.title}」解鎖）` : `${t.name}：${t.hint}`;
    return `<button class="tool${st.tool === t.id ? ' on' : ''}${locked ? ' locked' : ''}" data-tool="${t.id}" title="${title}"><kbd>${i + 1}</kbd>${TOOL_ICONS[t.id]}<span>${t.name}</span></button>`;
  }).join('');
}
$('tools').addEventListener('click', e => {
  const b = e.target.closest('.tool');
  if (b) selectTool(b.dataset.tool);
});
function selectTool(id) {
  if (!isUnlocked(id)) {
    const t = TOOLS.find(x => x.id === id), o = OBJECTIVES.find(x => x.id === t.lock);
    toast(`🔒 完成「${o.title}」來解鎖${t.name}`);
    return;
  }
  st.tool = id;
  renderTools();
  $('tray').classList.toggle('hidden', id !== 'decor');
  renderTray();
}
function renderTray() {
  const types = Object.keys(ITEMS);
  $('tray').innerHTML = types.map(t => {
    const n = st.inventory[t] || 0, known = st.collected[t] || n > 0 || t === 'flag';
    const cls = ['item-btn', st.item === t ? 'on' : '', !known ? 'unknown' : n === 0 ? 'empty' : ''].join(' ');
    return `<button class="${cls}" data-item="${t}" title="${known ? ITEMS[t].name : '尚未發現'}">${ITEMS[t].icon}<b>${n}</b></button>`;
  }).join('');
}
$('tray').addEventListener('click', e => {
  const b = e.target.closest('.item-btn');
  if (!b) return;
  st.item = b.dataset.item;
  renderTray();
});

function renderHud() {
  const buckets = st.sand / BUCKET_VOL;
  $('sandTxt').textContent = Math.floor(buckets);
  $('sandBar').style.width = `${clamp(st.sand / SAND_MAX, 0, 1) * 100}%`;
  $('hTxt').textContent = maxHeight.toFixed(2);
  const lvl = seaLevel(), rising = Math.cos(simTime * 2 * Math.PI / 200) > 0;
  $('tideTxt').textContent = st.waves === 'calm' ? '平穩' : `${rising ? '漲潮' : '退潮'} ${lvl >= 0 ? '+' : ''}${(lvl * 100).toFixed(0)}cm`;
  $('colTxt').textContent = st.totalCollected;
}

function renderObjectives() {
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
$('objToggle').addEventListener('click', () => {
  const c = $('obj').classList.toggle('collapsed');
  $('objToggle').setAttribute('aria-expanded', String(!c));
});

function checkObjectives() {
  let changed = false;
  for (const o of OBJECTIVES) {
    if (st.done[o.id]) continue;
    if (o.prog() >= o.target) {
      st.done[o.id] = true; changed = true;
      toast(`✔ 完成任務「${o.title}」${o.reward ? '　' + o.reward : ''}`, true);
      sfx('done');
      if (o.id === 'collect') { st.inventory.flag = (st.inventory.flag || 0) + 3; renderTray(); }
      const doneCount = Object.keys(st.done).length;
      for (const [key, L] of Object.entries(LAYOUTS)) if (L.need === doneCount && L.need > 0) toast(`🗺️ 新海灘解鎖：${L.name}`, true);
    }
  }
  if (changed) { renderTools(); save(); }
  renderObjectives();
}

function setBrush(v) {
  st.brush = clamp(v, 0.3, 2.5);
  $('brush').value = st.brush;
}
$('brush').addEventListener('input', e => { st.brush = parseFloat(e.target.value); });

function renderWaveSeg() {
  for (const b of $('waveSeg').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === st.waves);
    b.setAttribute('aria-checked', String(b.dataset.v === st.waves));
  }
}
$('waveSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  st.waves = b.dataset.v;
  setStart = -1; nextSet = simTime + 20;
  renderWaveSeg();
});
$('btnUndo').addEventListener('click', undo);
function renderSound() {
  $('btnSound').textContent = st.sound ? '🔊' : '🔇';
  if (master) master.gain.value = st.sound ? 0.8 : 0;
}
$('btnSound').addEventListener('click', () => { st.sound = !st.sound; audioInit(); renderSound(); });
$('btnHelp').addEventListener('click', () => { $('btnStart').textContent = '繼續'; $('intro').classList.remove('hidden'); });
$('btnStart').addEventListener('click', () => { $('intro').classList.add('hidden'); audioInit(); });

function renderLayouts() {
  const doneCount = Object.keys(st.done).length;
  $('layoutList').innerHTML = Object.entries(LAYOUTS).map(([key, L]) => {
    const locked = doneCount < L.need;
    return `<button data-layout="${key}" class="${st.layout === key ? 'on' : ''}" ${locked ? 'disabled' : ''}>
      <b>${locked ? '🔒 ' : ''}${L.name}</b><small>${locked ? `完成 ${L.need} 個任務解鎖` : L.desc}</small></button>`;
  }).join('') + `<button data-layout="${st.layout}" data-reset="1"><b>🔄 重新開始</b><small>重置目前的海灘</small></button>
    <button data-wipe="1"><b>🗑️ 清除存檔</b><small>所有任務與收藏歸零</small></button>`;
}
$('btnLayout').addEventListener('click', () => { renderLayouts(); $('layouts').classList.remove('hidden'); });
$('btnLayoutClose').addEventListener('click', () => $('layouts').classList.add('hidden'));
$('layoutList').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.wipe) {
    if (!confirm('確定清除所有進度？任務、收藏與地形都會重置。')) return;
    for (const it of [...items]) removeItem(it);
    st = freshState();
    newBeach('beach');
    renderTools(); selectTool('shovel'); renderWaveSeg(); renderSound(); setBrush(st.brush);
    $('layouts').classList.add('hidden');
    return;
  }
  const key = b.dataset.layout;
  if (key === st.layout && !b.dataset.reset) { $('layouts').classList.add('hidden'); return; }
  if (!confirm('重置地形？已擺放的裝飾會收回背包。')) return;
  newBeach(key);
  $('layouts').classList.add('hidden');
});

function newBeach(key) {
  for (const it of [...items]) {
    if (it.state === 'placed') st.inventory[it.type] = (st.inventory[it.type] || 0) + 1;
    removeItem(it);
  }
  st.layout = key;
  st.seed = (Math.random() * 1e9) | 0;
  undoStack = [];
  generate(key, st.seed);
  renderTray();
  save();
}

// ============================================================================
// Save / load
// ============================================================================
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
function save() {
  try {
    const pq = new Uint8Array(NN);
    for (let k = 0; k < NN; k++) pq[k] = Math.round(P[k] * 255);
    st.time = simTime;
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1, st, S: toB64(S), S0: toB64(S0), P: toB64(pq), buried,
      items: items.map(i => ({ type: i.type, x: i.x, z: i.z, state: i.state, yaw: i.yaw })),
    }));
  } catch { /* storage unavailable */ }
}
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (d.v !== 1) return false;
    st = Object.assign(freshState(), d.st);
    S.set(fromB64(d.S, Float32Array)); S0.set(fromB64(d.S0, Float32Array));
    const pq = fromB64(d.P, Uint8Array);
    for (let k = 0; k < NN; k++) { P[k] = pq[k] / 255; TINT[k] = hash2(k % N, (k / N) | 0, 99); }
    buried = d.buried || [];
    simTime = st.time || 0; nextSet = simTime + 25;
    initWater();
    for (let k = 0; k < NN; k++) M[k] = W[k] > 0 || P[k] > 0.5 ? 1 : 0;
    for (const i of d.items || []) { const it = spawnItem(i.type, i.x, i.z, i.state); it.yaw = i.yaw; it.mesh.rotation.y = i.yaw; it.vy = 0; }
    return true;
  } catch { return false; }
}
setInterval(save, 15000);
window.addEventListener('beforeunload', save);

// ============================================================================
// Main loop
// ============================================================================
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 50 : 40;
  camera.updateProjectionMatrix();
  // pull the camera back on narrow screens so the whole diorama fits
  const fit = clamp(0.8 / camera.aspect, 1, 2);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!resize.done || Math.abs(fit - resize.fit) > 0.05) {
    camera.position.copy(controls.target).addScaledVector(dir, 34.2 * fit);
    resize.fit = fit; resize.done = true;
  }
}
window.addEventListener('resize', resize);

let last = performance.now(), statTimer = 0, uiTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
}
function tick(dt) {

  // tools
  // re-pick only when the pointer or camera moved, so a held brush stays put
  if (mouse.x > 2) hover = null;
  else if (pickDirty || !hover) { hover = pickTerrain(); pickDirty = false; }
  else hover.y = heightAt(hover.x, hover.z);
  if (drawing && hover) applyBrush(hover, dt);

  // simulation
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) { simTime += h; waterStep(h); }
  updateWaveSets(dt);
  groundwater(dt);
  sedimentStep(dt);
  thermalStep(); thermalStep();
  moistureStep(dt);
  updateTreasures(dt);
  updateItems(dt);

  statTimer -= dt;
  if (statTimer <= 0) { statTimer = 0.5; computeStats(); checkObjectives(); }
  uiTimer -= dt;
  if (uiTimer <= 0) { uiTimer = 0.15; renderHud(); }

  updateTerrainMesh();
  updateWaterMesh();
  updateSkirts();
  updateRing();
  updateAudio();
  controls.update();
  renderer.render(scene, camera);
}

// ============================================================================
// Boot
// ============================================================================
if (!load()) generate(st.layout, st.seed);
if (window.innerWidth < 760) $('obj').classList.add('collapsed');
resize();
setBrush(st.brush);
renderTools(); selectTool(isUnlocked(st.tool) ? st.tool : 'shovel');
renderWaveSeg(); renderSound();
computeStats(); renderObjectives(); renderHud();
// pre-settle water a bit so the first frame looks calm
for (let s = 0; s < 60; s++) { simTime += 1 / 120; waterStep(1 / 120); }
requestAnimationFrame(frame);
// debug hook: step the game manually (e.g. when the tab is hidden)
window.__sc = { tick, get buried() { return buried; }, get st() { return st; }, S, W, P, items: () => items, get maxHeight() { return maxHeight; }, get drawing() { return drawing; }, get hover() { return hover; }, heightAt };
