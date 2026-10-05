// Treasures and decorations: meshes, drifting with the water, buried reveal.
import * as THREE from 'three';
import { N, HALF, ITEMS, FINDABLE, xOf, zOf } from './config.js';
import { S, W, VX, VZ, heightAt, cellOf } from './sim.js';
import { ocean } from './ocean.js';
import { scene } from './render.js';
import { game } from './state.js';

const ITEM_SCALE = 1.5;
const matCache = {};
const mat = (color, opts = {}) => {
  const key = color + JSON.stringify(opts);
  return matCache[key] || (matCache[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...opts }));
};
// Geometries are shared per type and never disposed.
const geoCache = {};
const geo = (key, make) => geoCache[key] || (geoCache[key] = make());

function makeItemMesh(type) {
  const g = new THREE.Group();
  const add = (gm, m, f) => { const mesh = new THREE.Mesh(gm, m); mesh.castShadow = true; mesh.receiveShadow = true; f && f(mesh); g.add(mesh); return mesh; };
  switch (type) {
    case 'shell':
      add(geo('shell', () => new THREE.ConeGeometry(0.12, 0.07, 11, 1, true)), mat(0xf7a99c, { side: THREE.DoubleSide, flatShading: true }), m => { m.scale.set(1, 1, 1.15); m.position.y = 0.035; });
      add(geo('shellTip', () => new THREE.SphereGeometry(0.03, 8, 6)), mat(0xffd9cf), m => { m.position.set(0, 0.02, 0.13); });
      break;
    case 'starfish':
      add(geo('star', () => {
        const sh = new THREE.Shape();
        for (let i = 0; i < 10; i++) {
          const a = i / 10 * Math.PI * 2, r = i % 2 ? 0.055 : 0.15;
          i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        return new THREE.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2 });
      }), mat(0xf26b4a), m => { m.rotation.x = -Math.PI / 2; m.position.y = 0.02; });
      break;
    case 'pebble': {
      const c = [0x9aa3a8, 0x7f8a94, 0xb7aea1, 0x6d7a80][Math.floor(Math.random() * 4)];
      add(geo('pebble', () => new THREE.IcosahedronGeometry(0.1, 1)), mat(c, { roughness: 0.5, flatShading: true }), m => { m.scale.set(1, 0.55, 0.8); m.position.y = 0.04; });
      break;
    }
    case 'seaweed':
      for (let i = 0; i < 5; i++) add(geo('weed', () => new THREE.ConeGeometry(0.025, 0.32, 4)), mat(0x3f8f4a, { flatShading: true }), m => {
        m.position.set((Math.random() - 0.5) * 0.12, 0.13, (Math.random() - 0.5) * 0.12);
        m.rotation.set((Math.random() - 0.5) * 0.9, 0, (Math.random() - 0.5) * 0.9);
      });
      break;
    case 'driftwood':
      add(geo('wood', () => new THREE.CylinderGeometry(0.035, 0.05, 0.62, 6)), mat(0xa48a6c, { flatShading: true }), m => { m.rotation.z = Math.PI / 2; m.position.y = 0.04; });
      add(geo('twig', () => new THREE.CylinderGeometry(0.018, 0.025, 0.22, 5)), mat(0xa48a6c, { flatShading: true }), m => { m.rotation.set(0, 0, Math.PI / 3); m.position.set(0.12, 0.08, 0.04); });
      break;
    case 'bottle': {
      const glass = mat(0x6fbf8f, { transparent: true, opacity: 0.6, roughness: 0.1 });
      add(geo('bottle', () => new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12)), glass, m => { m.rotation.z = Math.PI / 2; m.position.y = 0.05; });
      add(geo('neck', () => new THREE.CylinderGeometry(0.018, 0.03, 0.08, 10)), glass, m => { m.rotation.z = Math.PI / 2; m.position.set(0.12, 0.05, 0); });
      add(geo('scroll', () => new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8)), mat(0xf3e5c0), m => { m.rotation.z = Math.PI / 2; m.position.y = 0.05; });
      break;
    }
    case 'coin':
      add(geo('coin', () => new THREE.CylinderGeometry(0.09, 0.09, 0.022, 20)), mat(0xf2c14e, { metalness: 0.9, roughness: 0.25 }), m => { m.position.y = 0.02; });
      add(geo('coinRim', () => new THREE.TorusGeometry(0.065, 0.008, 6, 20)), mat(0xd9a12d, { metalness: 0.9, roughness: 0.3 }), m => { m.rotation.x = Math.PI / 2; m.position.y = 0.032; });
      break;
    case 'flag':
      add(geo('pole', () => new THREE.CylinderGeometry(0.012, 0.012, 0.75, 6)), mat(0xeadbc2), m => { m.position.y = 0.3; });
      add(geo('cloth', () => new THREE.PlaneGeometry(0.3, 0.18, 6, 1).translate(0.15, 0, 0)), mat(0xe8483b, { side: THREE.DoubleSide }), m => { m.position.y = 0.58; m.name = 'cloth'; });
      break;
  }
  g.scale.setScalar(ITEM_SCALE);
  return g;
}

const sparkleGeo = new THREE.RingGeometry(0.16, 0.2, 24).rotateX(-Math.PI / 2);
const sparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false });

export function spawnItem(type, x, z, state) {
  const mesh = makeItemMesh(type);
  const it = { type, x, z, y: heightAt(x, z), state, mesh, yaw: Math.random() * Math.PI * 2, t: Math.random() * 10, vy: state === 'loose' ? 2.5 : 0 };
  mesh.rotation.y = it.yaw;
  mesh.userData.item = it;
  it.cloth = mesh.getObjectByName('cloth') || null;
  if (state === 'loose') {
    it.sparkle = new THREE.Mesh(sparkleGeo, sparkleMat.clone());
    it.sparkle.renderOrder = 4;
    mesh.add(it.sparkle);
  }
  scene.add(mesh);
  game.items.push(it);
  return it;
}

export function removeItem(it) {
  scene.remove(it.mesh);
  if (it.sparkle) it.sparkle.material.dispose();
  const i = game.items.indexOf(it);
  if (i >= 0) game.items.splice(i, 1);
}

export function clearItems() {
  for (let i = game.items.length - 1; i >= 0; i--) removeItem(game.items[i]);
}

// Returns true if any item visibly moved (for shadow refresh).
export function updateItems(dt, onLost) {
  let moved = false;
  const items = game.items;
  for (let n = items.length - 1; n >= 0; n--) {
    const it = items[n];
    const k = cellOf(it.x, it.z);
    const def = ITEMS[it.type];
    const w = W[k];
    let drift = def.drift * (it.state === 'placed' ? 0.5 : 1);
    if (it.type === 'flag' && w < 0.25) drift = 0;
    if (w > 0.06 && drift > 0) {
      it.x += VX[k] * dt * drift; it.z += VZ[k] * dt * drift;
      moved = true;
    }
    if (Math.abs(it.x) > HALF - 0.05 || Math.abs(it.z) > HALF - 0.05) {
      if (it.state === 'placed') onLost(it);
      removeItem(it);
      continue;
    }
    const s = heightAt(it.x, it.z);
    const target = def.float && w > 0.1 ? s + w - 0.02 : s;
    if (it.vy > 0 || it.y > target + 0.02) {     // pop-out / falling
      it.vy -= 12 * dt;
      it.y += it.vy * dt;
      if (it.y < target) { it.y = target; it.vy = 0; }
      moved = true;
    } else {
      const dy = (target - it.y) * Math.min(1, dt * 12);
      if (Math.abs(dy) > 1e-3) moved = true;
      it.y += dy;
    }
    it.t += dt;
    it.mesh.position.set(it.x, it.y, it.z);
    if (it.sparkle) {
      it.mesh.rotation.y = it.yaw + Math.sin(it.t * 1.5) * 0.3;
      it.sparkle.scale.setScalar(1 + 0.25 * Math.sin(it.t * 4));
      it.sparkle.material.opacity = 0.45 + 0.4 * Math.sin(it.t * 4 + 1);
      it.sparkle.position.y = 0.01;
    }
    if (it.cloth) it.cloth.rotation.y = Math.sin(it.t * 3.1) * 0.35 - it.mesh.rotation.y + 0.6;
  }
  return moved;
}

let revealTimer = 0, ashoreTimer = 18;
export function updateTreasures(dt, onReveal) {
  revealTimer -= dt;
  if (revealTimer <= 0) {
    revealTimer = 0.2;
    const buried = game.buried;
    for (let n = buried.length - 1; n >= 0; n--) {
      const b = buried[n];
      if (heightAt(b.x, b.z) < b.y + 0.03) {
        buried.splice(n, 1);
        spawnItem(b.type, b.x, b.z, 'loose');
        onReveal(b);
      }
    }
  }
  ashoreTimer -= dt;
  if (ashoreTimer <= 0) {
    ashoreTimer = 22 + Math.random() * 25;
    if (game.items.filter(i => i.state === 'loose').length >= 6) return;
    const types = FINDABLE.filter(t => ITEMS[t].weight > 0);
    const total = types.reduce((s, t) => s + ITEMS[t].weight, 0);
    let r = Math.random() * total, type = types[0];
    for (const t of types) { r -= ITEMS[t].weight; if (r <= 0) { type = t; break; } }
    const sea = ocean.seaLevel();
    for (let tries = 0; tries < 600; tries++) {
      const i = 4 + Math.floor(Math.random() * (N - 8)), j = 4 + Math.floor(Math.random() * (N - 8));
      const k = j * N + i;
      if (W[k] > 0.004 && W[k] < 0.05 && S[k] > sea - 0.05) {
        spawnItem(type, xOf(i), zOf(j), 'loose').vy = 0;
        break;
      }
    }
  }
}
