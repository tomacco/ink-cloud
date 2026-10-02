import GUI from 'lil-gui';
import { params, TEX_SIZES, type Params } from '../params';

export interface DebugHooks {
  onTexSize: (size: number) => void;
  onReset: () => void;
  onResize: () => void;
  stats: { fps: number; particles: number; flux: number; threshold: number; env: number; source: string };
}

/** lil-gui panel mounted inside a glass container (styled light in style.css). */
export function createDebugPanel(container: HTMLElement, hooks: DebugHooks): GUI {
  const gui = new GUI({ container, title: 'Ink cloud', width: 300 });
  const p: Params = params;

  const stats = gui.addFolder('Stats');
  stats.add(hooks.stats, 'fps').name('FPS').listen().disable();
  stats.add(hooks.stats, 'particles').name('particles').listen().disable();
  stats.add(hooks.stats, 'source').name('audio source').listen().disable();
  stats.add(hooks.stats, 'flux', 0, 2).name('low-band flux').listen().disable();
  stats.add(hooks.stats, 'threshold', 0, 2).name('threshold').listen().disable();
  stats.add(hooks.stats, 'env', 0, 1).name('beat envelope').listen().disable();

  const particles = gui.addFolder('Particles');
  particles
    .add(p, 'texSize', [...TEX_SIZES])
    .name('count (tex side)')
    .onChange((v: number) => hooks.onTexSize(v));
  particles.add(p, 'adaptiveCount').name('adaptive count');
  particles.add(p, 'strandSize', [64, 128, 256, 512, 1024, 2048]).name('particles / line').onChange(() => hooks.onReset());
  particles.add(p, 'ribbonLines', [1, 2, 3, 4, 5, 6, 8]).name('lines / ribbon').onChange(() => hooks.onReset());
  particles.add(p, 'ribbonFraction', 0, 1, 0.01).name('ribbon share');
  particles.add(p, 'strandSpread', 0, 0.05, 0.001).name('ribbon spacing');
  particles.add(p, 'coreFraction', 0, 1, 0.01).name('core-detail share').onChange(() => hooks.onReset());
  particles.add(p, 'lifeMin', 0.5, 30, 0.25).name('life min (s)').onChange(() => hooks.onReset());
  particles.add(p, 'lifeMax', 1, 40, 0.25).name('life max (s)').onChange(() => hooks.onReset());
  particles.add(p, 'coreLife', 0.25, 8, 0.05).name('core life (s)').onChange(() => hooks.onReset());
  particles.add(p, 'coreRadius', 0.01, 0.6, 0.005).name('core radius');
  particles.add(p, 'emitterDrift', 0, 0.4, 0.005).name('emitter drift');
  particles.add({ reset: () => hooks.onReset() }, 'reset').name('reset cloud');

  const motion = gui.addFolder('Motion');
  motion.add(p, 'noiseScale', 0.1, 5, 0.01).name('curl scale');
  motion.add(p, 'noiseSpeed', 0, 1, 0.005).name('curl speed');
  motion.add(p, 'noiseStrength', 0, 2, 0.01).name('curl strength');
  motion.add(p, 'detailScale', 1, 30, 0.1).name('core detail scale');
  motion.add(p, 'detailStrength', 0, 1.5, 0.01).name('core detail strength');
  motion.add(p, 'detailRadius', 0.05, 2, 0.01).name('core detail radius');
  motion.add(p, 'outwardSpeed', 0, 0.8, 0.005).name('outward speed');
  motion.add(p, 'outwardGain', 0, 3, 0.05).name('outward gain (r)');
  motion.add(p, 'follow', 0.1, 20, 0.1).name('flow follow');

  const beat = gui.addFolder('Beat response');
  beat.add(p, 'attractorStrength', 0, 10, 0.05).name('attractor strength');
  beat.add(p, 'beatSqueeze', 0, 0.5, 0.005).name('render squeeze');
  beat.add(p, 'beatAttack', 0.005, 0.3, 0.005).name('attack (s)');
  beat.add(p, 'beatRelease', 0.05, 2, 0.01).name('release (s)');
  beat.add(p, 'audioTurbulence', 0, 2, 0.01).name('loudness -> turbulence');
  beat.add(p, 'audioDetail', 0, 2, 0.01).name('highs -> detail');

  const det = gui.addFolder('Beat detection');
  det.add(p, 'beatSensitivity', 0.2, 5, 0.05).name('threshold (k·std)');
  det.add(p, 'beatRefractory', 0.05, 0.6, 0.01).name('refractory (s)');
  det.add(p, 'beatLowHz', 20, 120, 1).name('low Hz');
  det.add(p, 'beatHighHz', 80, 400, 1).name('high Hz');
  det.add(p, 'manualBpm').name('manual BPM');
  det.add(p, 'bpm', 40, 220, 0.5).name('BPM');
  det.add(p, 'bpmOffset', -1000, 1000, 1).name('offset (ms)');

  const look = gui.addFolder('Look');
  look.add(p, 'inkDensity', 0.05, 6, 0.01).name('ink density k');
  look.add(p, 'pointSize', 0.5, 6, 0.05).name('point size (px)');
  look.add(p, 'softFraction', 0, 1, 0.01).name('soft smear share');
  look.add(p, 'softSize', 1, 40, 0.5).name('soft smear size');
  look.add(p, 'dofFocal', -2, 2, 0.01).name('DOF focal offset');
  look.add(p, 'dofBlur', 0, 60, 0.5).name('DOF blur');
  look.add(p, 'dofMax', 1, 96, 1).name('DOF max px');
  look.add(p, 'maxGap', 0.01, 0.5, 0.005).name('max stroke gap');
  look.add(p, 'wideThreshold', 12, 40, 0.5).name('wide stroke px');
  look.add(p, 'renderScale', 0.4, 1, 0.05).name('render scale').onChange(() => hooks.onResize());
  look.add(p, 'trails').name('trails');
  look.add(p, 'trailDecay', 0.5, 0.99, 0.005).name('trail decay');
  look.add(p, 'grain', 0, 0.2, 0.001).name('grain');
  look.add(p, 'vignette', 0, 1, 0.01).name('vignette');
  look.add(p, 'paperWarmth', -0.05, 0.08, 0.001).name('paper warmth');

  const mode = gui.addFolder('Mode');
  mode.add(p, 'mode', { ink: 0, strings: 1 }).name('mode').listen();
  mode.add(p, 'stringSpeed', 0, 0.2, 0.001).name('string sweep');
  mode.add(p, 'stringDrift', 0, 0.5, 0.005).name('surface drift');
  mode.add(p, 'stringSpring', 0.5, 20, 0.1).name('spring');
  mode.add(p, 'linesPerSurface', [8, 16, 32, 64, 128]).name('lines / surface');

  const touch = gui.addFolder('Touch');
  touch.add(p, 'touchStrength', 0, 10, 0.1).name('finger pull');
  touch.add(p, 'touchHold', 0.5, 5, 0.1).name('hold to reveal (s)');

  const cam = gui.addFolder('Camera');
  cam.add(p, 'orbitSpeed', -0.3, 0.3, 0.005).name('orbit speed');
  cam.add(p, 'camDistance', 1.6, 8, 0.05).name('distance');
  cam.add(p, 'camDrift', 0, 1, 0.01).name('drift');

  for (const f of [particles, motion, beat, det, look, mode, touch, cam]) f.close();
  return gui;
}
