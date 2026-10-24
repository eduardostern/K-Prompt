/**
 * Rewind: a snapshot of the machine every second, the last 30 kept, so a
 * player can step back a few seconds after a fall. Snapshots are .z80
 * bytes (about 48K for a 48K, 128K for a 128K), kept in memory only.
 */
import type { Spectrum } from './machine';
import { loadSnapshot, saveZ80 } from './snapshot';

export class Rewind {
  private readonly ring: Uint8Array[] = [];
  private frames = 0;

  /** `capacity` snapshots, one every `every` frames. */
  constructor(readonly capacity = 30, readonly every = 50) {}

  /** Called after every frame: takes a snapshot when one is due. */
  tick(zx: Spectrum): void {
    if (++this.frames < this.every) return;
    this.frames = 0;
    this.ring.push(saveZ80(zx));
    if (this.ring.length > this.capacity) this.ring.shift();
  }

  /** How many snapshots are kept. */
  get length(): number {
    return this.ring.length;
  }

  /**
   * Goes back `steps` snapshots (about that many seconds), dropping the
   * newer ones, and loads it into `zx`. False when there is nothing to go back to.
   */
  back(zx: Spectrum, steps = 5): boolean {
    if (!this.ring.length) return false;
    const keep = Math.max(1, this.ring.length - steps + 1);
    this.ring.length = keep;
    loadSnapshot(zx, 'rewind.z80', this.ring[keep - 1]);
    this.frames = 0;
    return true;
  }

  /** Forgets everything (reset, another machine). */
  clear(): void {
    this.ring.length = 0;
    this.frames = 0;
  }
}
