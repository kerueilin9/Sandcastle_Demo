// Mutable game state shared between modules. `game.st` is the persisted part.
import { BUCKET_VOL } from './config.js';

export function freshState() {
  return {
    layout: 'beach', seed: (Math.random() * 1e9) | 0,
    sand: 60 * BUCKET_VOL, digTotal: 0, totalCollected: 0, survived: 0, tsunamiSurvived: 0,
    collected: {}, inventory: { flag: 2, shell: 1 }, done: {},
    tool: 'shovel', item: 'flag', brush: 0.9, waves: 'normal', waveScale: 1, sound: true, time: 0,
  };
}

export const game = {
  st: freshState(),
  items: [],        // {type, x, z, y, state:'loose'|'placed', mesh, yaw, t, vy, cloth, sparkle}
  buried: [],       // {type, x, z, y}
  maxHeight: 0,
  moatCells: 0,
};
