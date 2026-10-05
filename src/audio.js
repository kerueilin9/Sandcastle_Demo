// Procedural audio: ocean bed, digging hiss, UI blips, tsunami rumble + siren.
let actx = null, master = null, oceanGain = null, digGain = null, rumbleGain = null, sirenGain = null, siren = null;
let enabled = true;

function noiseBuffer(sec, brown) {
  const len = actx.sampleRate * sec, buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}
function loop(buf, filterType, freq, q) {
  const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
  const f = actx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; if (q) f.Q.value = q;
  const g = actx.createGain(); g.gain.value = 0;
  src.connect(f).connect(g).connect(master); src.start();
  return g;
}

export function audioInit() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = enabled ? 0.8 : 0; master.connect(actx.destination);
    const brown = noiseBuffer(6, true);
    oceanGain = loop(brown, 'lowpass', 700);
    rumbleGain = loop(brown, 'lowpass', 140);
    digGain = loop(noiseBuffer(2, false), 'bandpass', 2200, 0.7);
    siren = actx.createOscillator(); siren.type = 'sawtooth'; siren.frequency.value = 600;
    const sf = actx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 1800;
    sirenGain = actx.createGain(); sirenGain.gain.value = 0;
    siren.connect(sf).connect(sirenGain).connect(master); siren.start();
  } catch { actx = null; }
}

export function setSoundEnabled(on) {
  enabled = on;
  if (master) master.gain.value = on ? 0.8 : 0;
}

export function sfx(kind) {
  if (!actx || !enabled) return;
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

// level: ocean loudness 0..1, digging: bool, rumble: 0..1, warning: bool
export function updateAudio({ level, digging, rumble, warning, time }) {
  if (!actx) return;
  const t = actx.currentTime;
  oceanGain.gain.setTargetAtTime(level, t, 0.3);
  digGain.gain.setTargetAtTime(digging ? 0.05 : 0, t, 0.05);
  rumbleGain.gain.setTargetAtTime(rumble * 0.9, t, 0.4);
  sirenGain.gain.setTargetAtTime(warning ? 0.035 : 0, t, 0.2);
  if (warning) siren.frequency.setTargetAtTime(600 + 300 * (0.5 + 0.5 * Math.sin(time * 2.4)), t, 0.05);
}
