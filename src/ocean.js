// Ocean forcing: tide, regular swell, wave sets and doom-mode tsunamis.
// Pure logic, no rendering. `ocean.target(z)` is the water surface height the
// simulation imposes on open-sea boundary cells.
import { HALF, WAVE_MODES, SET_LEN, TSUNAMI_WARN, TSUNAMI_LEN } from './config.js';
import { game } from './state.js';
import { smooth, sech2 } from './util.js';

const OMEGA = 2 * Math.PI / 6.5, KWAVE = 2 * Math.PI / 16;
const TSUNAMI_SPEED = 3.8;            // m/s along the side edges (≈ shallow-water wave speed)
const TSUNAMI_CREST = 10;             // s after drawdown start that the crest leaves the back edge

export const ocean = {
  time: 0,
  setStart: -1,
  nextSet: 25,
  tsStart: -1,                        // time the tsunami warning began, -1 when idle
  nextTsunami: Infinity,
  // per-frame cached values (refreshed by beginStep)
  _sea: 0, _amp: 0, _ts: false,

  mode() { return WAVE_MODES[game.st.waves]; },
  scale() { return game.st.waveScale; },
  seaLevel() { return this.mode().tide * Math.sin(this.time * 2 * Math.PI / 200); },
  tideRising() { return Math.cos(this.time * 2 * Math.PI / 200) > 0; },

  setEnvelope() {
    if (this.setStart < 0) return 0;
    const t = (this.time - this.setStart) / SET_LEN;
    return t >= 0 && t <= 1 ? Math.sin(Math.PI * t) : 0;
  },

  // Seconds since the drawdown started at the back edge (negative during warning).
  tsunamiTau() { return this.tsStart < 0 ? -Infinity : this.time - this.tsStart - TSUNAMI_WARN; },
  tsunamiWarning() { const t = this.tsunamiTau(); return t > -Infinity && t < 0 ? -t : 0; },
  tsunamiActive() { return this.tsStart >= 0; },
  tsunamiHeight() { return Math.min(4.2, 2.2 * (0.6 + 0.4 * this.scale())); },

  tsunamiOffset(tau) {
    if (tau < 0) return 0;
    const draw = -0.9 * smooth(0, 7, tau) * (1 - smooth(8.5, 11.5, tau));
    return draw + this.tsunamiHeight() * sech2((tau - TSUNAMI_CREST) / 1.9);
  },
  // 0..1 shake intensity while the crest is crossing the beach
  shake() {
    const tau = this.tsunamiTau();
    if (tau < 8 || tau > 22) return 0;
    return sech2((tau - 12.5) / 2.2);
  },

  // Called once per water sub-step before target() lookups.
  beginStep() {
    const m = this.mode();
    this._sea = this.seaLevel();
    this._amp = m.amp * this.scale() * (1 + (m.setAmp - 1) * this.setEnvelope());
    this._ts = this.tsStart >= 0;
    this._tau0 = this.tsunamiTau();
  },
  target(z) {
    const ph = OMEGA * this.time - KWAVE * (z + HALF);
    let h = this._sea + this._amp * (Math.sin(ph) + 0.25 * Math.sin(2 * ph - 0.6));
    if (this._ts) h += this.tsunamiOffset(this._tau0 - (z + HALF) / TSUNAMI_SPEED);
    return h;
  },

  trigger() {
    if (this.tsStart >= 0) return false;
    this.tsStart = this.time;
    return true;
  },

  resetSchedule() {
    const m = this.mode();
    this.setStart = -1;
    this.nextSet = this.time + 20;
    this.tsStart = -1;
    this.nextTsunami = m.tsunamiEvery ? this.time + 35 : Infinity;
  },

  // Per-frame scheduling. `on` receives event names:
  // setStart, setEnd, tsunamiWarn, tsunamiHit, tsunamiEnd
  update(on) {
    const m = this.mode();
    if (this.setStart >= 0 && this.time - this.setStart > SET_LEN) {
      this.setStart = -1;
      this.nextSet = this.time + m.setEvery;
      on('setEnd');
    }
    if (m.setEvery === Infinity) this.nextSet = this.time + 30;
    else if (this.setStart < 0 && this.time >= this.nextSet && !this.tsunamiActive()) {
      this.setStart = this.time;
      on('setStart');
    }

    if (m.tsunamiEvery && !this.tsunamiActive() && this.time >= this.nextTsunami) {
      this.trigger();
    }
    if (this.tsunamiActive()) {
      const tau = this.tsunamiTau();
      if (!this._warned) { this._warned = true; on('tsunamiWarn'); }
      if (tau >= TSUNAMI_CREST + 1 && !this._hit) { this._hit = true; on('tsunamiHit'); }
      if (tau > TSUNAMI_LEN) {
        this.tsStart = -1; this._warned = false; this._hit = false;
        this.nextTsunami = m.tsunamiEvery ? this.time + m.tsunamiEvery : Infinity;
        on('tsunamiEnd');
      }
    }
  },
};
