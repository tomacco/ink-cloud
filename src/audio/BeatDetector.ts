import type { Analysis } from './AudioEngine';
import type { Params } from '../params';

// Spectral-flux onset detection on the low band with an adaptive threshold
// (mean + k * std over a short history) and a refractory period.

export interface Beat {
  /** 0..1 confidence / strength of the onset. */
  strength: number;
  time: number;
}

export class BeatDetector {
  private prev: Float32Array = new Float32Array(0);
  private history: number[] = [];
  private historyLen = 43; // ~0.7 s at 60 fps
  private lastBeat = -1;
  /** Latest flux and threshold, exposed for the debug panel. */
  flux = 0;
  threshold = 0;

  update(a: Analysis, p: Params): Beat | null {
    const lo = Math.max(1, Math.floor(p.beatLowHz / a.binHz));
    const hi = Math.min(a.spectrum.length - 1, Math.ceil(p.beatHighHz / a.binHz));
    const width = hi - lo + 1;
    if (this.prev.length !== width) {
      this.prev = new Float32Array(width);
      this.history.length = 0;
    }
    let flux = 0;
    for (let i = 0; i < width; i++) {
      const m = a.spectrum[lo + i];
      const d = m - this.prev[i];
      if (d > 0) flux += d;
      this.prev[i] = m;
    }
    this.flux = flux;

    const h = this.history;
    let mean = 0;
    for (const v of h) mean += v;
    mean /= Math.max(1, h.length);
    let varSum = 0;
    for (const v of h) varSum += (v - mean) * (v - mean);
    const std = Math.sqrt(varSum / Math.max(1, h.length));
    this.threshold = mean + p.beatSensitivity * std + 1e-4;

    h.push(flux);
    if (h.length > this.historyLen) h.shift();

    if (h.length < 10) return null;
    if (a.time - this.lastBeat < p.beatRefractory) return null;
    if (flux < this.threshold) return null;
    this.lastBeat = a.time;
    const strength = Math.min(1, 0.5 + 0.5 * ((flux - this.threshold) / this.threshold));
    return { strength, time: a.time };
  }

  reset(): void {
    this.history.length = 0;
    this.prev.fill(0);
    this.lastBeat = -1;
  }
}

/** Manual fallback: beats on a fixed grid of BPM + offset, in AudioContext time. */
export class BeatClock {
  private lastIndex = -1;
  private origin = 0;

  /** Reset the grid origin (for example when playback starts). */
  sync(time: number): void {
    this.origin = time;
    this.lastIndex = -1;
  }

  update(time: number, p: Params): Beat | null {
    const period = 60 / Math.max(30, p.bpm);
    const t = time - this.origin - p.bpmOffset / 1000;
    const idx = Math.floor(t / period);
    if (idx > this.lastIndex && t >= 0) {
      this.lastIndex = idx;
      return { strength: 1, time };
    }
    return null;
  }
}

/** Fast-attack / slow-release envelope driven by beats. */
export class BeatEnvelope {
  value = 0;
  private target = 0;

  trigger(strength: number): void {
    this.target = Math.max(this.target, strength);
  }

  update(dt: number, p: Params): number {
    if (this.target > this.value) {
      const k = 1 - Math.exp(-dt / Math.max(0.001, p.beatAttack));
      this.value += (this.target - this.value) * k;
      if (this.target - this.value < 0.02) this.target = 0;
    } else {
      this.target = 0;
      this.value *= Math.exp(-dt / Math.max(0.01, p.beatRelease));
    }
    return this.value;
  }
}
