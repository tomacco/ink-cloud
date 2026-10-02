import * as THREE from 'three';
import { params, TEX_SIZES, type TexSize } from './params';
import { ParticleSim } from './sim/ParticleSim';
import { InkRenderer } from './render/InkRenderer';
import { AudioEngine, type SourceKind } from './audio/AudioEngine';
import { BeatClock, BeatDetector, BeatEnvelope } from './audio/BeatDetector';
import { Overlay, DEFAULT_STREAM } from './controls/Overlay';
import { createDebugPanel } from './controls/DebugPanel';
import { GpuTimer } from './render/GpuTimer';

// ---------------------------------------------------------------------------
// The page starts immediately in silent mode. A long press gathers ink around
// the finger and, after `touchHold` seconds, reveals the controls.
//
// Query flags (for tests and deep links): ?autostart=stream plays the default
// stream (needs an autoplay-permitted browser), ?hud=1 shows the controls at
// once, ?panel=1 opens settings, ?tex=512 sets the particle texture side,
// ?bpm=120 enables the manual clock, ?p.<param>=<value> presets any tunable,
// ?touch=0.3,0.5 holds a virtual finger at that screen fraction,
// ?bench=<name>&debug=1 prints GPU pass times and beat stats.
const query = new URLSearchParams(location.search);
const isMobile = navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) <= 900;

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
const maxPixelRatio = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
renderer.setPixelRatio(maxPixelRatio);
renderer.info.autoReset = false;

if (isMobile) params.texSize = 512; // phones start at 262k and adapt from there
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
if (query.get('mode') === 'strings') params.mode = 1;
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
  ink.setSize(w, h, maxPixelRatio * params.renderScale);
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
let beatCount = 0;
const beatTimes: number[] = [];
let steadyStart = 0;

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
  onToggleMode: () => {
    params.mode = params.mode > 0.5 ? 0 : 1;
  },
});
audio.onStateChange = () => overlay.setPlaying(audio);
audio.media.addEventListener('error', () => {
  const e = audio.media.error;
  console.warn('audio element error', e?.code, e?.message);
});
overlay.setPlaying(audio);

// ---------------------------------------------------------------------------
// Debug panel
let panelOpen = query.get('panel') === '1';
overlay.setPanelOpen(panelOpen);

function rebuildParticles(size: number): void {
  params.texSize = size as TexSize;
  sim.allocate(size);
  ink.buildStrokes(sim.count);
  sim.warmup(params, 200, 1 / 20);
  stats.particles = sim.count;
  slowFor = 0;
  fastFor = 0;
  smoothedFps = 60;
}

createDebugPanel(overlay.panel, {
  onTexSize: (size) => rebuildParticles(size),
  onReset: () => rebuildParticles(sim.texSize),
  onResize: () => resize(),
  stats,
});

// ---------------------------------------------------------------------------
// Adaptive quality: when the smoothed FPS stays below 42 for two seconds, lower
// the internal render scale first, then the particle count; step the count back
// up after six seconds above 57.
let smoothedFps = 60;
let slowFor = 0;
let fastFor = 0;
let pinnedWarned = false;

function adapt(dt: number): void {
  if (!params.adaptiveCount || elapsed < 4) return; // startup jank is not a GPU limit
  const idx = TEX_SIZES.indexOf(params.texSize);
  if (smoothedFps < 42) {
    slowFor += dt;
    fastFor = 0;
    if (slowFor > 2) {
      slowFor = 0;
      if (params.renderScale > 0.7) {
        params.renderScale = Math.max(0.7, params.renderScale - 0.15);
        resize();
      } else if (idx > 0) rebuildParticles(TEX_SIZES[idx - 1]);
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
// The user's own orbit and zoom sit on top of the automatic drift. Gestures
// write targets; the camera eases toward them so it feels connected but calm.
// The mapping from pixels to angle is constant: it never changes with zoom.
const ORBIT_RAD_PER_PX = 0.006;
const ZOOM_MIN = 1.6;
const ZOOM_MAX = 8;
let userAz = 0;
let userEl = 0;
let targetAz = 0;
let targetEl = 0;
let zoom = params.camDistance;

function updateCamera(t: number, dt: number): number {
  const k = Math.min(1, dt * 10);
  userAz += (targetAz - userAz) * k;
  userEl += (targetEl - userEl) * k;
  zoom += (params.camDistance - zoom) * k;
  const az = t * params.orbitSpeed + userAz;
  const el = 0.25 * Math.sin(t * 0.071) * (0.4 + params.camDrift) + userEl;
  const dist = zoom + params.camDrift * 0.5 * Math.sin(t * 0.043);
  camPos.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(dist);
  camera.position.copy(camPos);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return dist;
}

function orbitBy(dxPx: number, dyPx: number): void {
  targetAz += dxPx * ORBIT_RAD_PER_PX;
  targetEl = Math.max(-1.3, Math.min(1.3, targetEl - dyPx * ORBIT_RAD_PER_PX));
}

function zoomBy(factor: number): void {
  params.camDistance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, params.camDistance * factor));
}

// ---------------------------------------------------------------------------
// Gestures. One finger: the ink follows it (press and hold; the controls
// appear after `touchHold` seconds). Two fingers: pinch zooms, dragging both
// orbits. Mouse: wheel or trackpad scroll zooms, horizontal scroll orbits,
// right-drag orbits. The first gesture also starts the prepared stream.
const touch = new THREE.Vector4(0, 0, 0, 0);
const raycaster = new THREE.Raycaster();
const touchPlane = new THREE.Plane();
const ndc = new THREE.Vector2();
const viewDir = new THREE.Vector3();
const hitPoint = new THREE.Vector3();
let pressing = false;
let pressStart = 0;
let pressX = 0;
let pressY = 0;
let pressId = -1; // the pointer that owns the press
const pointers = new Map<number, { x: number; y: number }>();
let gesture: 'none' | 'pinch' | 'orbit' = 'none';
let pinchDist = 0;
let pinchCx = 0;
let pinchCy = 0;
let orbitLastX = 0;
let orbitLastY = 0;
let armedStream = false;
let bufferingFor = 0;
let flowingFor = 0;

function projectTouch(): void {
  ndc.set((pressX / window.innerWidth) * 2 - 1, -(pressY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  camera.getWorldDirection(viewDir);
  touchPlane.setFromNormalAndCoplanarPoint(viewDir, new THREE.Vector3(0, 0, 0));
  if (raycaster.ray.intersectPlane(touchPlane, hitPoint)) touch.set(hitPoint.x, hitPoint.y, hitPoint.z, touch.w);
}

function firstTwo(): [{ x: number; y: number }, { x: number; y: number }] | null {
  if (pointers.size < 2) return null;
  const it = pointers.values();
  return [it.next().value!, it.next().value!];
}

function beginPinch(): void {
  const pair = firstTwo();
  if (!pair) return;
  pressing = false; // the second finger turns the press into a camera gesture
  pressId = -1;
  gesture = 'pinch';
  pinchDist = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
  pinchCx = (pair[0].x + pair[1].x) / 2;
  pinchCy = (pair[0].y + pair[1].y) / 2;
}

canvas.addEventListener('pointerdown', (e) => {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic pointer in tests */
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (armedStream) {
    armedStream = false;
    audio.startPrepared(); // inside the gesture: browsers allow it here
    overlay.setHint('press and hold for controls');
  } else void audio.resume();
  if (e.pointerType === 'mouse' && e.button === 2) {
    gesture = 'orbit';
    orbitLastX = e.clientX;
    orbitLastY = e.clientY;
    return;
  }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (pointers.size >= 2) {
    beginPinch();
    return;
  }
  if (gesture !== 'none' || pressing) return;
  pressId = e.pointerId;
  pressing = true;
  pressStart = elapsed;
  pressX = e.clientX;
  pressY = e.clientY;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (gesture === 'pinch') {
    const pair = firstTwo();
    if (!pair) return;
    const d = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
    const cx = (pair[0].x + pair[1].x) / 2;
    const cy = (pair[0].y + pair[1].y) / 2;
    if (pinchDist > 1 && d > 1) zoomBy(pinchDist / d);
    orbitBy(cx - pinchCx, cy - pinchCy);
    pinchDist = d;
    pinchCx = cx;
    pinchCy = cy;
    return;
  }
  if (gesture === 'orbit') {
    orbitBy(e.clientX - orbitLastX, e.clientY - orbitLastY);
    orbitLastX = e.clientX;
    orbitLastY = e.clientY;
    return;
  }
  if (pressing && e.pointerId === pressId) {
    pressX = e.clientX;
    pressY = e.clientY;
  }
});
const release = (e: PointerEvent): void => {
  pointers.delete(e.pointerId);
  if (gesture === 'pinch' && pointers.size < 2) gesture = 'none'; // the remaining finger does not become a press
  if (gesture === 'orbit' && pointers.size === 0) gesture = 'none';
  if (e.pointerId === pressId) {
    pressing = false;
    pressId = -1;
  }
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines or pages to pixels
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey) zoomBy(Math.exp(dy * 0.004)); // trackpad pinch arrives as ctrl+wheel
    else if (Math.abs(dx) > Math.abs(dy)) orbitBy(dx * 0.6, 0);
    else zoomBy(Math.exp(dy * 0.0015));
  },
  { passive: false }
);

if (query.has('tap')) {
  // Test hook: a synthetic tap after 1.5 s (needs an autoplay-permitted browser to start sound).
  setTimeout(() => {
    const ev = new PointerEvent('pointerdown', { pointerId: 99, clientX: 40, clientY: 40, button: 0, pointerType: 'mouse', bubbles: true });
    canvas.dispatchEvent(ev);
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 99, clientX: 40, clientY: 40, button: 0, pointerType: 'mouse', bubbles: true }));
  }, 1500);
}
if (query.has('touch')) {
  const [fx, fy] = (query.get('touch') || '0.5,0.5').split(',').map(Number);
  pressX = fx * window.innerWidth;
  pressY = fy * window.innerHeight;
  pressing = true;
}

function updateTouch(dt: number): void {
  const target = pressing ? 1 : 0;
  touch.w += (target - touch.w) * Math.min(1, dt * 6);
  if (pressing) {
    projectTouch();
    // Every long press brings the controls back; this is the only way on a phone.
    if (overlay.hidden && elapsed - pressStart >= params.touchHold) overlay.reveal();
  }
}

// ---------------------------------------------------------------------------
// Main loop
sim.warmup(params, 450, 1 / 30);

if (query.has('debug')) {
  const gl = renderer.getContext();
  const rows = sim.sampleRows(32, 64);
  const s = rows.pos;
  const vs = rows.vel;
  let nan = 0;
  let sumR = 0;
  let maxR = 0;
  let sumV = 0;
  let maxV = 0;
  let sumGap = 0;
  let gaps = 0;
  let maxGap = 0;
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
    const v = Math.hypot(vs[i * 4], vs[i * 4 + 1], vs[i * 4 + 2]);
    sumV += v;
    if (v > maxV) maxV = v;
    // Neighbour along the strand is the next texel in the same row (64 < strandSize).
    if (i % 64 < 63 && s[(i + 1) * 4 + 3] < s[i * 4 + 3]) {
      const g = Math.hypot(s[(i + 1) * 4] - x, s[(i + 1) * 4 + 1] - y, s[(i + 1) * 4 + 2] - z);
      sumGap += g;
      gaps++;
      if (g > maxGap) maxGap = g;
    }
  }
  report(
    `DEBUG_VEL meanV=${(sumV / n).toFixed(3)} maxV=${maxV.toFixed(3)} gaps=${gaps} meanGap=${(sumGap / Math.max(1, gaps)).toFixed(4)} maxGap=${maxGap.toFixed(3)} ` +
      `w0..3=${[s[3], s[7], s[11], s[15]].map((v) => v.toFixed(3)).join(',')} life0=${vs[3].toFixed(2)}`
  );
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  report(
    `DEBUG_SIM gpu="${gpu}" webgl2=${renderer.capabilities.isWebGL2} floatBlend=${renderer.extensions.has('EXT_float_blend')} ` +
      `mobile=${isMobile} dpr=${maxPixelRatio} samples=${n} nan=${nan} meanR=${(sumR / Math.max(1, n - nan)).toFixed(3)} maxR=${maxR.toFixed(3)} simTime=${sim.time.toFixed(2)}`
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
const gpuTimer = bench ? new GpuTimer(renderer) : null;
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
  if (hit) {
    lastBeatAt = elapsed;
    beatCount++;
    beatTimes.push(elapsed);
  }
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
  const dist = updateCamera(elapsed, dt);
  updateTouch(dt);
  renderer.info.reset();
  gpuTimer?.poll();
  gpuTimer?.begin('sim');
  sim.step(params, dt, env, touch.w > 0.001 ? touch : null);
  gpuTimer?.end();
  if (!query.has('norender')) ink.render(params, sim, camera, dist, env, elapsed, gpuTimer);

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
  // Hysteresis: show after 0.3 s of buffering, hide after 0.3 s of flow, so the edge does not flicker.
  bufferingFor = audio.buffering ? bufferingFor + dt : 0;
  flowingFor = audio.buffering ? 0 : flowingFor + dt;
  if (bufferingFor > 0.3) overlay.setLoading(true);
  else if (flowingFor > 0.3) overlay.setLoading(false);
  adapt(dt);

  if (bench) {
    if (benchFrames === 0) benchStart = now;
    benchFrames++;
    if (benchFrames === 180) {
      const ms = (now - benchStart) / benchFrames;
      report(
        `BENCH_DONE particles=${sim.count} ${window.innerWidth}x${window.innerHeight}@${maxPixelRatio} frame=${ms.toFixed(2)}ms fps=${(1000 / ms).toFixed(1)} calls=${renderer.info.render.calls}`
      );
    }
    if (benchFrames === 600) {
      steadyStart = now;
      gpuTimer?.reset();
    }
    if (benchFrames === 900) {
      const steady = (now - steadyStart) / 300;
      report(`BENCH_STEADY particles=${sim.count} frame=${steady.toFixed(2)}ms fps=${(1000 / steady).toFixed(1)}`);
      if (gpuTimer) report(gpuTimer.report());
      const iv = beatTimes.slice(-9).map((t, i, arr) => (i ? (t - arr[i - 1]).toFixed(2) : '')).filter(Boolean);
      report(`BEAT_INTERVALS ${iv.join(' ')}`);
      report(
        `BEAT_STATS beats=${beatCount} over=${elapsed.toFixed(1)}s source=${audio.kind} playing=${audio.playing} mediaTime=${audio.media.currentTime.toFixed(1)} loud=${audio.analysis.loudness.toFixed(3)} flux=${detector.flux.toFixed(4)} thr=${detector.threshold.toFixed(4)}`
      );
      reportShot(query.get('bench') || 'shot');
    }
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Deep links and test modes
if (query.get('hud') === '1' || panelOpen) overlay.reveal();
if (query.get('autostart') === 'stream') {
  // Needs an autoplay-permitted browser (Chrome --autoplay-policy=no-user-gesture-required).
  void audio.useStream(query.get('url') || DEFAULT_STREAM).then(
    () => {
      detector.reset();
      stats.source = audio.kind;
      overlay.setPlaying(audio);
      report('AUTOSTART_STREAM ok');
    },
    (err: unknown) => report(`AUTOSTART_STREAM failed: ${String(err)}`)
  );
} else if (query.get('source') !== 'silent') {
  // Default: the stream buffers from the first moment and the first tap plays it.
  audio.prepareStream(query.get('url') || DEFAULT_STREAM);
  armedStream = true;
  stats.source = audio.kind;
  overlay.setPlaying(audio);
} else {
  overlay.setHint('press and hold');
}
if (params.manualBpm) clock.sync(elapsed);
