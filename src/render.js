// Three.js scene: terrain / water / diorama meshes, camera, lighting.
// Mesh updates are incremental: only rows flagged active (terrain) or wet
// (water) are rebuilt, and only that row range is uploaded to the GPU.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { N, NN, CELL, HALF, SIZE, BASE, xOf, zOf } from './config.js';
import { S, W, M, VX, VZ, TINT, rowWet, rowActive } from './sim.js';
import { clamp, lerp, smooth } from './util.js';

export const canvas = document.getElementById('c');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
const MAX_DPR = Math.min(window.devicePixelRatio || 1, 2);
let dpr = MAX_DPR;
renderer.setPixelRatio(dpr);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
const HOME = new THREE.Vector3(0, 21, 27);
camera.position.copy(HOME);

export const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 75;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = 1.38;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
export let cameraMoved = true;
controls.addEventListener('change', () => { cameraMoved = true; });
export function consumeCameraMoved() { const m = cameraMoved; cameraMoved = false; return m; }

// Hold Space / Alt (or toggle the hand button) to rotate with the left mouse button.
export function setNavMode(on) {
  controls.mouseButtons.LEFT = on ? THREE.MOUSE.ROTATE : null;
  controls.touches.ONE = on ? THREE.TOUCH.ROTATE : null;
  canvas.style.cursor = on ? 'grab' : '';
}

// ---------------------------------------------------------------- lights
const hemi = new THREE.HemisphereLight(0xcfeeff, 0xb89a70, 0.75);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d0, 2.1);
sun.position.set(12, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// 0 = sunny, 1 = storm (doom mode)
let storm = 0, stormTarget = 0;
export function setStorm(v) { stormTarget = v; }

// ---------------------------------------------------------------- grid meshes
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
function uploadRows(geo, names, j0, j1) {
  for (const name of names) {
    const a = geo.attributes[name];
    a.clearUpdateRanges();
    a.addUpdateRange(j0 * N * a.itemSize, (j1 - j0 + 1) * N * a.itemSize);
    a.needsUpdate = true;
  }
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

// ---------------------------------------------------------------- diorama skirts
const SIDES = (() => {
  const a = [], b = [], c = [], d = [];
  for (let i = 0; i < N; i++) { a.push(i); c.push((N - 1) * N + (N - 1 - i)); }
  for (let j = 0; j < N; j++) { b.push(j * N + N - 1); d.push((N - 1 - j) * N); }
  return [{ cells: a, n: [0, 0, -1] }, { cells: b, n: [1, 0, 0] }, { cells: c, n: [0, 0, 1] }, { cells: d, n: [-1, 0, 0] }];
})();
const SKIRT_CELLS = Int32Array.from(SIDES.flatMap(s => s.cells));
function makeSkirt(colorSize) {
  const g = new THREE.BufferGeometry();
  const verts = SKIRT_CELLS.length * 2;
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3);
  const idx = [];
  SIDES.forEach((side, s) => side.cells.forEach((k, c) => {
    const v = (s * N + c) * 2;
    for (const o of [0, 1]) {
      pos[(v + o) * 3] = xOf(k % N); pos[(v + o) * 3 + 2] = zOf((k / N) | 0);
      nrm[(v + o) * 3] = side.n[0]; nrm[(v + o) * 3 + 2] = side.n[2];
    }
    if (c < N - 1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
  }));
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * colorSize), colorSize).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), HALF * 1.6);
  return g;
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

// ---------------------------------------------------------------- brush ring
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

export function updateRing(pos, radius, color, heightAt) {
  ring.visible = ringDot.visible = !!pos;
  if (!pos) return;
  ring.material.color.setHex(color);
  const a = ringGeo.attributes.position.array;
  for (let s = 0; s <= RING_SEG; s++) {
    const ang = s / RING_SEG * Math.PI * 2;
    const x = pos.x + Math.cos(ang) * radius, z = pos.z + Math.sin(ang) * radius;
    a[s * 3] = x; a[s * 3 + 1] = heightAt(x, z) + 0.03; a[s * 3 + 2] = z;
  }
  ringGeo.attributes.position.needsUpdate = true;
  ringDot.position.copy(pos);
}

// ---------------------------------------------------------------- mesh updates
const DRY = [0.93, 0.79, 0.55], WET = [0.68, 0.53, 0.35], SIDE_BOT = [0.5, 0.37, 0.25];

function terrainRows(j0, j1, withGeom) {
  const pos = terrainGeo.attributes.position.array, nrm = terrainGeo.attributes.normal.array, col = terrainGeo.attributes.color.array;
  for (let j = j0; j <= j1; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, s = S[k];
    if (withGeom) {
      pos[k * 3 + 1] = s;
      const nx = S[i > 0 ? k - 1 : k] - S[i < N - 1 ? k + 1 : k];
      const nz = S[j > 0 ? k - N : k] - S[j < N - 1 ? k + N : k];
      const ny = 2 * CELL;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nrm[k * 3] = nx * inv; nrm[k * 3 + 1] = ny * inv; nrm[k * 3 + 2] = nz * inv;
    }
    const m = M[k], t = 0.93 + 0.12 * TINT[k], deep = smooth(-0.1, -1.2, s) * 0.18;
    col[k * 3] = lerp(DRY[0], WET[0], m) * t * (1 - deep);
    col[k * 3 + 1] = lerp(DRY[1], WET[1], m) * t * (1 - deep * 0.6);
    col[k * 3 + 2] = lerp(DRY[2], WET[2], m) * t * (1 - deep * 0.2);
  }
}

let colorTimer = 0;
// Returns true when terrain geometry changed (shadow map needs refresh).
export function updateTerrainMesh(dt, force) {
  let j0 = N, j1 = -1;
  for (let j = 0; j < N; j++) if (rowActive[j] || force) { if (j < j0) j0 = j; j1 = j; }
  colorTimer -= dt;
  const fullColor = colorTimer <= 0;
  if (fullColor) colorTimer = 0.5;
  if (j1 >= 0) {
    j0 = Math.max(0, j0 - 1); j1 = Math.min(N - 1, j1 + 1);   // normals depend on neighbours
    terrainRows(j0, j1, true);
  }
  if (fullColor) {
    // slow drying: refresh colours across the whole grid twice a second
    if (j1 >= 0) { if (j0 > 0) terrainRows(0, j0 - 1, false); if (j1 < N - 1) terrainRows(j1 + 1, N - 1, false); }
    else terrainRows(0, N - 1, false);
    uploadRows(terrainGeo, ['color'], 0, N - 1);
    if (j1 >= 0) uploadRows(terrainGeo, ['position', 'normal'], j0, j1);
  } else if (j1 >= 0) {
    uploadRows(terrainGeo, ['position', 'normal', 'color'], j0, j1);
  }
  return j1 >= 0;
}

const WY = new Float32Array(NN);
const rowWasWet = new Uint8Array(N);
export function updateWaterMesh() {
  let j0 = N, j1 = -1;
  for (let j = 0; j < N; j++) if (rowWet[j] || rowWasWet[j]) { if (j < j0) j0 = j; j1 = j; }
  rowWasWet.set(rowWet);
  if (j1 < 0) return;
  const pos = waterGeo.attributes.position.array, nrm = waterGeo.attributes.normal.array, col = waterGeo.attributes.color.array;
  const a0 = Math.max(0, j0 - 1), a1 = Math.min(N - 1, j1 + 1);
  for (let k = a0 * N; k < (a1 + 1) * N; k++) {
    const w = W[k];
    WY[k] = w > 0.004 ? S[k] + w : S[k] - 0.04;
  }
  for (let j = j0; j <= j1; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, w = W[k];
    pos[k * 3 + 1] = WY[k];
    const nx = WY[i > 0 ? k - 1 : k] - WY[i < N - 1 ? k + 1 : k];
    const nz = WY[j > 0 ? k - N : k] - WY[j < N - 1 ? k + N : k];
    const ny = 2 * CELL;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    const nyn = ny * inv;
    nrm[k * 3] = nx * inv; nrm[k * 3 + 1] = nyn; nrm[k * 3 + 2] = nz * inv;
    const c = k * 4;
    if (w <= 0.004) { col[c + 3] = 0; continue; }
    const d = smooth(0, 1.3, w);
    let r = lerp(0.42, 0.06, d), g = lerp(0.9, 0.42, d), b = lerp(0.86, 0.66, d), al = lerp(0.32, 0.9, d);
    if (storm > 0) { r = lerp(r, r * 0.7 + 0.08, storm); g = lerp(g, g * 0.75, storm); b = lerp(b, b * 0.8, storm); }
    const sp = Math.hypot(VX[k], VZ[k]);
    let foam = clamp(sp * 0.45 - 0.3, 0, 1) * (1 - smooth(0.05, 1.2, w));
    foam = Math.max(foam, (1 - smooth(0.004, 0.035, w)) * 0.55);       // swash edge
    foam = Math.max(foam, clamp((0.93 - nyn) * 6, 0, 0.9));               // steep wave fronts
    foam *= 0.85 + 0.3 * TINT[k];
    r = lerp(r, 1, foam); g = lerp(g, 1, foam); b = lerp(b, 1, foam);
    al = Math.max(al * smooth(0.004, 0.03, w), foam * 0.85);
    col[c] = r; col[c + 1] = g; col[c + 2] = b; col[c + 3] = al;
  }
  uploadRows(waterGeo, ['position', 'normal', 'color'], j0, j1);
}

export function updateSkirts() {
  const p = skirtGeo.attributes.position.array, c = skirtGeo.attributes.color.array;
  const wp = wskirtGeo.attributes.position.array, wc = wskirtGeo.attributes.color.array;
  const tcol = terrainGeo.attributes.color.array;
  for (let n = 0; n < SKIRT_CELLS.length; n++) {
    const k = SKIRT_CELLS[n], v = n * 2;
    p[v * 3 + 1] = S[k]; p[(v + 1) * 3 + 1] = BASE;
    c[v * 3] = tcol[k * 3] * 0.9; c[v * 3 + 1] = tcol[k * 3 + 1] * 0.9; c[v * 3 + 2] = tcol[k * 3 + 2] * 0.9;
    c[(v + 1) * 3] = SIDE_BOT[0]; c[(v + 1) * 3 + 1] = SIDE_BOT[1]; c[(v + 1) * 3 + 2] = SIDE_BOT[2];
    const w = W[k];
    wp[v * 3 + 1] = w > 0.004 ? S[k] + w : S[k]; wp[(v + 1) * 3 + 1] = S[k];
    const d = smooth(0, 1.3, w);
    for (let o = 0; o < 2; o++) {
      const q = (v + o) * 4;
      wc[q] = lerp(0.35, 0.05, d); wc[q + 1] = lerp(0.8, 0.38, d); wc[q + 2] = lerp(0.85, 0.62, d);
      wc[q + 3] = w > 0.004 ? (o ? 0.85 : 0.55) : 0;
    }
  }
  skirtGeo.attributes.position.needsUpdate = true; skirtGeo.attributes.color.needsUpdate = true;
  wskirtGeo.attributes.position.needsUpdate = true; wskirtGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- camera helpers
let orbitLeft = 0, zoomLeft = 0;
export function orbitBy(angle) { orbitLeft += angle; }
export function zoomBy(factor) { zoomLeft += Math.log(factor); }
export function resetView() {
  orbitLeft = 0; zoomLeft = 0;
  controls.target.set(0, 0, 0);
  camera.position.copy(HOME).multiplyScalar(fitFactor());
}
function fitFactor() { return clamp(0.8 / camera.aspect, 1, 2); }
const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function animateCamera(dt) {
  if (Math.abs(orbitLeft) > 1e-4) {
    const step = Math.sign(orbitLeft) * Math.min(Math.abs(orbitLeft), dt * 4);
    orbitLeft -= step;
    _v.copy(camera.position).sub(controls.target).applyAxisAngle(_up, step);
    camera.position.copy(controls.target).add(_v);
  }
  if (Math.abs(zoomLeft) > 1e-4) {
    const step = Math.sign(zoomLeft) * Math.min(Math.abs(zoomLeft), dt * 3);
    zoomLeft -= step;
    _v.copy(camera.position).sub(controls.target);
    const len = clamp(_v.length() * Math.exp(step), controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(_v.setLength(len));
  }
}

let lastFit = 0;
export function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 50 : 40;
  camera.updateProjectionMatrix();
  // pull the camera back on narrow screens so the whole diorama fits
  const fit = fitFactor();
  if (Math.abs(fit - lastFit) > 0.05) {
    _v.copy(camera.position).sub(controls.target).setLength(HOME.length() * fit);
    camera.position.copy(controls.target).add(_v);
    lastFit = fit;
  }
}

// ---------------------------------------------------------------- frame
const SKY_SUN = new THREE.Color(0xcfeeff), SKY_STORM = new THREE.Color(0x8d97a6);
const SUN_SUN = new THREE.Color(0xfff0d0), SUN_STORM = new THREE.Color(0xc9b7a3);
let shadowAge = 0, slowFrames = 0, fastFrames = 0;
const _shake = new THREE.Vector3();
export const perf = { dpr };

export function render(dt, { terrainChanged, itemsMoved, shake }) {
  animateCamera(dt);
  controls.update();

  if (Math.abs(storm - stormTarget) > 1e-3) {
    storm += clamp(stormTarget - storm, -dt * 0.5, dt * 0.5);
    hemi.color.lerpColors(SKY_SUN, SKY_STORM, storm);
    hemi.intensity = lerp(0.75, 0.6, storm);
    sun.color.lerpColors(SUN_SUN, SUN_STORM, storm);
    sun.intensity = lerp(2.1, 1.1, storm);
  }

  // shadows: refresh when the scene changed, at most every other frame
  shadowAge++;
  if ((terrainChanged || itemsMoved) && shadowAge >= 2) { renderer.shadowMap.needsUpdate = true; shadowAge = 0; }

  if (shake > 0) {
    _shake.set((Math.random() - 0.5), (Math.random() - 0.5) * 0.6, (Math.random() - 0.5)).multiplyScalar(shake * 0.35);
    camera.position.add(_shake);
  }
  renderer.render(scene, camera);
  if (shake > 0) camera.position.sub(_shake);
}

// Adaptive resolution: drop pixel ratio when frames are slow, raise it back when fast.
export function adaptResolution(frameMs) {
  if (frameMs > 24) { slowFrames++; fastFrames = 0; } else if (frameMs < 13) { fastFrames++; slowFrames = 0; } else { slowFrames = fastFrames = 0; }
  if (slowFrames > 45 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); slowFrames = 0; renderer.setPixelRatio(dpr); resize(); }
  if (fastFrames > 240 && dpr < MAX_DPR) { dpr = Math.min(MAX_DPR, dpr + 0.25); fastFrames = 0; renderer.setPixelRatio(dpr); resize(); }
  perf.dpr = dpr;
}
