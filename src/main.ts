import * as THREE from 'three';
import { params, TEX_SIZES, type TexSize } from './params';
import { ParticleSim } from './sim/ParticleSim';
import { InkRenderer } from './render/InkRenderer';
import { AudioEngine, type SourceKind } from './audio/AudioEngine';
import { BeatClock, BeatDetector, BeatEnvelope } from './audio/BeatDetector';
import { Overlay } from './controls/Overlay';
import { createDebugPanel } from './controls/DebugPanel';

// ---------------------------------------------------------------------------
// Query flags (used for headless checks): ?autostart=1 skips the gate with the
// silent source, ?tex=512 sets the particle texture side, ?bpm=120 enables the
// manual clock, ?panel=0 hides the settings panel, ?bench=1 prints frame stats.
const query = new URLSearchParams(location.search);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: query.has('bench'),
});
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);
const maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(maxPixelRatio);
renderer.info.autoReset = false;

if (query.has('tex')) {
  const t = Number(query.get('tex')) as TexSize;
  if ((TEX_SIZES as readonly number[]).includes(t)) params.texSize = t;
}
// Any tunable can be preset from the URL: ?p.noiseScale=2&p.trails=true
for (const [k, v] of query) {
  if (!k.startsWith('p.')) continue;
  const name = k.slice(2) as keyof typeof params;
  if (!(name in params) || name === 'texSize') continue;
  const cur = params[name];
  (params as Record<string, unknown>)[name] = typeof cur === 'boolean' ? v === 'true' || v === '1' : Number(v);
}
if (query.has('bpm')) {
  params.manualBpm = true;
  params.bpm = Number(query.get('bpm')) || params.bpm;
}

const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
const sim = new ParticleSim(renderer, params.texSize);
const ink = new InkRenderer(renderer, sim);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  ink.setSize(w, h, maxPixelRatio);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Audio
const audio = new AudioEngine();
const detector = new BeatDetector();
const clock = new BeatClock();
const envelope = new BeatEnvelope();
let lastBeatAt = -1;

const stats = { fps: 0, particles: sim.count, flux: 0, threshold: 0, env: 0, source: 'silent' };

const overlay = new Overlay({
  onStart: async (kind: SourceKind, extra) => {
    await audio.resume();
    switch (kind) {
      case 'stream':
        if (!extra.url) throw new Error('Enter a stream URL.');
        await audio.useStream(extra.url);
        break;
      case 'file':
        if (!extra.file) throw new Error('Pick a file first.');
        await audio.useFile(extra.file);
        break;
      case 'tab':
        await audio.useTab();
        break;
      case 'mic':
        await audio.useMic();
        break;
      case 'none':
        audio.stop();
        break;
    }
    detector.reset();
    clock.sync(elapsed);
    overlay.setPlaying(audio);
    stats.source = audio.kind;
  },
  onTogglePlay: () => {
    audio.togglePlay();
    overlay.setPlaying(audio);
  },
  onToggleSettings: () => {
    panelOpen = !panelOpen;
    overlay.setPanelOpen(panelOpen);
  },
  onToggleHidden: () => {
    /* nothing extra: the HUD animates itself */
  },
});
audio.onStateChange = () => overlay.setPlaying(audio);
audio.media.addEventListener('error', () => {
  const e = audio.media.error;
  console.warn('audio element error', e?.code, e?.message);
});

// ---------------------------------------------------------------------------
// Debug panel
let panelOpen = query.get('panel') !== '0';
overlay.setPanelOpen(panelOpen);

function rebuildParticles(size: number): void {
  params.texSize = size as TexSize;
  sim.allocate(size);
  ink.buildPoints(sim.count);
  sim.warmup(params, 300, 1 / 15);
  stats.particles = sim.count;
}

createDebugPanel(overlay.panel, {
  onTexSize: (size) => rebuildParticles(size),
  onReset: () => rebuildParticles(sim.texSize),
  stats,
});

// ---------------------------------------------------------------------------
// Adaptive particle count: step down one texture size when the smoothed FPS
// stays below 42 for two seconds, step back up above 57 for six seconds.
let smoothedFps = 60;
let slowFor = 0;
let fastFor = 0;
let pinnedWarned = false;

function adapt(dt: number): void {
  if (!params.adaptiveCount) return;
  const idx = TEX_SIZES.indexOf(params.texSize);
  if (smoothedFps < 42) {
    slowFor += dt;
    fastFor = 0;
    if (slowFor > 2) {
      slowFor = 0;
      if (idx > 0) rebuildParticles(TEX_SIZES[idx - 1]);
      else if (!pinnedWarned) {
        pinnedWarned = true;
        console.warn('Ink cloud: already at the smallest particle count and still below target FPS.');
      }
    }
  } else if (smoothedFps > 57) {
    fastFor += dt;
    slowFor = 0;
    if (fastFor > 6 && idx < TEX_SIZES.length - 2) {
      fastFor = 0;
      rebuildParticles(TEX_SIZES[idx + 1]);
    }
  } else {
    slowFor = 0;
    fastFor = 0;
  }
}

// ---------------------------------------------------------------------------
// Camera: slow orbit with gentle drift, always looking at the core.
const camPos = new THREE.Vector3();
function updateCamera(t: number): number {
  const az = t * params.orbitSpeed;
  const el = 0.25 * Math.sin(t * 0.071) * (0.4 + params.camDrift);
  const dist = params.camDistance + params.camDrift * 0.5 * Math.sin(t * 0.043);
  camPos.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(dist);
  camera.position.copy(camPos);
  camera.lookAt(0, 0, 0);
  return dist;
}

// ---------------------------------------------------------------------------
// Main loop
sim.warmup(params, 300, 1 / 15);

if (query.has('debug')) {
  const gl = renderer.getContext();
  const s = sim.samplePositions(64);
  let nan = 0;
  let sumR = 0;
  let maxR = 0;
  const n = s.length / 4;
  for (let i = 0; i < n; i++) {
    const x = s[i * 4];
    const y = s[i * 4 + 1];
    const z = s[i * 4 + 2];
    const r = Math.hypot(x, y, z);
    if (!Number.isFinite(r)) nan++;
    else {
      sumR += r;
      if (r > maxR) maxR = r;
    }
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  report(
    `DEBUG_SIM gpu="${gpu}" webgl2=${renderer.capabilities.isWebGL2} floatBlend=${renderer.extensions.has('EXT_float_blend')} ` +
      `maxPointSize=${gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)} samples=${n} nan=${nan} meanR=${(sumR / Math.max(1, n - nan)).toFixed(3)} maxR=${maxR.toFixed(3)} simTime=${sim.time.toFixed(2)}`
  );
}

/** Console + dev-server sink (vite.config.ts) so a real Chrome window can report back. */
function report(line: string): void {
  console.log(line);
  if (import.meta.env.DEV) void fetch('/__bench', { method: 'POST', body: JSON.stringify({ line }) }).catch(() => {});
}
function reportShot(name: string): void {
  if (!import.meta.env.DEV) return;
  const png = canvas.toDataURL('image/png');
  void fetch('/__bench', { method: 'POST', body: JSON.stringify({ png, name }) }).catch(() => {});
}

let last = performance.now();
let elapsed = 0;
let frames = 0;
let fpsAccum = 0;
const bench = query.has('bench');
let benchFrames = 0;
let benchStart = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  elapsed += dt;

  // --- audio analysis -> beat -> envelope
  const a = audio.update();
  let hit = false;
  if (params.manualBpm) {
    // Wall-clock timebase: the AudioContext stays at 0 while suspended (silent mode).
    const b = clock.update(elapsed, params);
    if (b) {
      envelope.trigger(b.strength);
      hit = true;
    }
  } else if (audio.kind !== 'none') {
    const b = detector.update(a, params);
    if (b) {
      envelope.trigger(b.strength);
      hit = true;
    }
  }
  if (hit) lastBeatAt = elapsed;
  const env = envelope.update(dt, params);
  stats.flux = detector.flux;
  stats.threshold = detector.threshold;
  stats.env = env;

  // Continuous energy modulates turbulence and core detail (restored each frame).
  const baseNoise = params.noiseStrength;
  const baseDetail = params.detailStrength;
  params.noiseStrength = baseNoise * (1 + params.audioTurbulence * a.loudness);
  params.detailStrength = baseDetail * (1 + params.audioDetail * a.high);

  // --- simulate + render
  renderer.info.reset();
  sim.step(params, dt, env);
  const dist = updateCamera(elapsed);
  if (!query.has('norender')) ink.render(params, sim, camera, dist, env, elapsed);

  params.noiseStrength = baseNoise;
  params.detailStrength = baseDetail;

  // --- stats
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    const fps = frames / fpsAccum;
    smoothedFps = smoothedFps * 0.5 + fps * 0.5;
    stats.fps = Math.round(fps);
    overlay.setFps(fps, fps < 45);
    frames = 0;
    fpsAccum = 0;
  }
  overlay.setBeat(env, elapsed - lastBeatAt < 0.08);
  adapt(dt);

  if (bench) {
    if (benchFrames === 0) benchStart = now;
    benchFrames++;
    if (benchFrames === 180) {
      const ms = (now - benchStart) / benchFrames;
      report(
        `BENCH_DONE particles=${sim.count} ${window.innerWidth}x${window.innerHeight}@${maxPixelRatio} frame=${ms.toFixed(2)}ms fps=${(1000 / ms).toFixed(1)} calls=${renderer.info.render.calls}`
      );
      reportShot(query.get('bench') || 'shot');
    }
  }
}
requestAnimationFrame(frame);

// Headless / demo start without a click.
if (query.get('autostart') === '1') {
  overlay.gate.hidden = true;
  overlay.hud.hidden = false;
  audio.stop();
  if (params.manualBpm) clock.sync(elapsed);
  overlay.setPlaying(audio);
}
