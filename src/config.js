// World constants and static content definitions.
import { lerp, smooth, vnoise, fbm } from './util.js';

export const N = 160;                 // grid resolution
export const CELL = 0.15;             // meters per cell
export const SIZE = (N - 1) * CELL;
export const HALF = SIZE / 2;
export const NN = N * N;
export const FLOOR = -1.6;            // hard bottom, can't dig below
export const BASE = -2.3;             // diorama base
export const G = 9.81;
export const BUCKET_VOL = 0.05;       // m³ per "bucket" of sand
export const SAND_MAX = 300 * BUCKET_VOL;
export const SAVE_KEY = 'sandcastle-web-v1';
export const WATER_DT = 1 / 120;      // fixed water sub-step

export const xOf = i => -HALF + i * CELL;
export const zOf = j => -HALF + j * CELL;

export const LAYOUTS = {
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

export const ITEMS = {
  shell:     { name: '貝殼',   icon: '🐚', weight: 30, drift: 0.45, float: false },
  pebble:    { name: '鵝卵石', icon: '🪨', weight: 24, drift: 0.08, float: false },
  starfish:  { name: '海星',   icon: '⭐', weight: 15, drift: 0.4,  float: false },
  seaweed:   { name: '海藻',   icon: '🌿', weight: 15, drift: 1.0,  float: true },
  driftwood: { name: '漂流木', icon: '🪵', weight: 10, drift: 0.9,  float: true },
  bottle:    { name: '瓶中信', icon: '🍾', weight: 5,  drift: 1.0,  float: true },
  coin:      { name: '古金幣', icon: '🪙', weight: 0,  drift: 0.0,  float: false },
  flag:      { name: '小旗子', icon: '🚩', weight: 0,  drift: 0.25, float: false },
};
export const FINDABLE = ['shell', 'pebble', 'starfish', 'seaweed', 'driftwood', 'bottle', 'coin'];

export const TOOLS = [
  { id: 'shovel', name: '鏟子', hint: '挖沙，沙會收進沙桶庫存' },
  { id: 'pile',   name: '堆沙', hint: '倒出濕沙並壓實' },
  { id: 'smooth', name: '抹平', hint: '拍平、壓實沙面' },
  { id: 'bucket', name: '沙桶', hint: '點一下倒扣出圓塔', lock: 'dig' },
  { id: 'carve',  name: '雕刻刀', hint: '在牆頂刻出城垛與凹槽', lock: 'tower' },
  { id: 'decor',  name: '裝飾', hint: '擺放寶物；點擊已擺放的可收回' },
];

export const TOOL_ICONS = {
  shovel: '<svg viewBox="0 0 32 32"><path d="M16 3v15" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round"/><path d="M12 3h8" stroke="#8a5a2b" stroke-width="3" stroke-linecap="round"/><path d="M10 18h12v4a6 6 0 0 1-12 0z" fill="#e85d4a"/></svg>',
  pile: '<svg viewBox="0 0 32 32"><path d="M3 26c4-10 8-15 13-15s9 5 13 15z" fill="#e7b866"/><path d="M8 20c2-2 4-3 6-3" stroke="#fff6" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 4v5M13 7l3 3 3-3" stroke="#3a7fb0" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
  smooth: '<svg viewBox="0 0 32 32"><path d="M5 22h22l-3 4H8z" fill="#9aa7b4"/><path d="M16 22V10" stroke="#8a5a2b" stroke-width="3"/><rect x="12" y="5" width="8" height="7" rx="2.5" fill="#e85d4a"/></svg>',
  bucket: '<svg viewBox="0 0 32 32"><path d="M7 10h18l-2.3 16H9.3z" fill="#3ea7d8"/><path d="M6 10h20" stroke="#1f6e96" stroke-width="2.5" stroke-linecap="round"/><path d="M10 10a6 6 0 0 1 12 0" stroke="#1f6e96" stroke-width="2" fill="none"/></svg>',
  carve: '<svg viewBox="0 0 32 32"><path d="M6 26l12-12 4 4-12 12z" fill="#8a5a2b"/><path d="M18 14l7-9 2 2-5 11z" fill="#c9d3dc"/><path d="M4 9h3v3h3V9h3v3h3V9h3v6H4z" fill="#e7b866" opacity=".9"/></svg>',
  decor: '<svg viewBox="0 0 32 32"><path d="M16 4l3.4 7 7.6 1-5.5 5.3 1.3 7.6L16 21.3 9.2 24.9l1.3-7.6L5 12l7.6-1z" fill="#f28a4a"/><circle cx="16" cy="15" r="2" fill="#ffd2a8"/></svg>',
};

// amp: base wave amplitude (m); setAmp: multiplier at the peak of a wave set.
// tsunamiEvery: seconds between tsunamis (doom mode only).
export const WAVE_MODES = {
  calm:   { name: '平靜', amp: 0.03, tide: 0.05, setEvery: Infinity, setAmp: 1 },
  normal: { name: '正常', amp: 0.10, tide: 0.18, setEvery: 50, setAmp: 4.0 },
  rough:  { name: '洶湧', amp: 0.16, tide: 0.22, setEvery: 30, setAmp: 4.2 },
  doom:   { name: '末日', amp: 0.18, tide: 0.20, setEvery: 24, setAmp: 4.2, tsunamiEvery: 75 },
};
export const SET_LEN = 16;
export const TSUNAMI_WARN = 8;        // seconds of warning before the sea recedes
export const TSUNAMI_LEN = 32;        // seconds from drawdown start to end
