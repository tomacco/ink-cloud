import type * as THREE from 'three';

// Per-pass GPU timing through EXT_disjoint_timer_query_webgl2. Results arrive a
// few frames late; we keep a ring of queries per section and average whatever
// has resolved. Only used in bench mode: queries cost a little themselves.

interface Section {
  queries: WebGLQuery[];
  pending: WebGLQuery[];
  sumMs: number;
  samples: number;
}

export class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number } | null;
  private sections = new Map<string, Section>();
  private active: string | null = null;
  readonly supported: boolean;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = this.ext !== null;
  }

  begin(name: string): void {
    if (!this.ext || this.active) return;
    let s = this.sections.get(name);
    if (!s) {
      s = { queries: [], pending: [], sumMs: 0, samples: 0 };
      this.sections.set(name, s);
    }
    const q = s.queries.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    s.pending.push(q);
    this.active = name;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
  }

  /** Collect resolved queries. Call once per frame, outside any begin/end. */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter((this.ext as unknown as { GPU_DISJOINT_EXT: number }).GPU_DISJOINT_EXT);
    for (const s of this.sections.values()) {
      const still: WebGLQuery[] = [];
      for (const q of s.pending) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          if (!disjoint) {
            s.sumMs += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            s.samples++;
          }
          s.queries.push(q);
        } else still.push(q);
      }
      s.pending = still;
    }
  }

  report(): string {
    if (!this.ext) return 'GPU_TIMES unsupported';
    const parts: string[] = [];
    let total = 0;
    for (const [name, s] of this.sections) {
      const avg = s.samples ? s.sumMs / s.samples : 0;
      total += avg;
      parts.push(`${name}=${avg.toFixed(2)}ms(n${s.samples})`);
    }
    return `GPU_TIMES ${parts.join(' ')} total=${total.toFixed(2)}ms`;
  }

  reset(): void {
    for (const s of this.sections.values()) {
      s.sumMs = 0;
      s.samples = 0;
    }
  }
}
