// Single source of truth for every tunable. The debug panel binds to this object
// and the simulation / renderer read from it every frame.

export const TEX_SIZES = [256, 512, 1024, 1448, 2048] as const;
export type TexSize = (typeof TEX_SIZES)[number];

export const params = {
  // --- particles --------------------------------------------------------
  texSize: 1024 as TexSize, // particles = texSize^2 (1024 -> 1,048,576)
  adaptiveCount: true, // scale texSize down when FPS cannot be held
  strandSize: 256, // particles per streakline (one emitter)
  ribbonLines: 4, // emitters per group: a ribbon of parallel lines
  ribbonFraction: 0.5, // share of groups that spread into a ribbon (others collapse into one thick line)
  coreFraction: 0.25, // share of groups that stay short-lived inside the core (the crackly detail)
  strandSpread: 0.014, // lateral spacing between ribbon lines
  lifeMin: 3,
  lifeMax: 12,
  coreLife: 2.5, // life of core groups (s)
  coreRadius: 0.1, // emitter ball radius
  emitterDrift: 0.05, // slow wandering of the emitters

  // --- motion -----------------------------------------------------------
  noiseScale: 0.9,
  noiseSpeed: 0.03,
  noiseStrength: 0.2,
  detailScale: 14.0, // high-frequency octave for the core (keep its strength tiny: it stretches lines)
  detailStrength: 0.05,
  detailRadius: 0.45, // where the detail octave fades out
  outwardSpeed: 0.1, // per-group drift away from the core
  outwardGain: 0.5, // drift grows with radius: lines thin out as they leave
  follow: 4, // how fast velocity relaxes onto the flow field (1/s)

  // --- beat response ----------------------------------------------------
  attractorStrength: 0.4, // velocity pull toward the core on a beat
  beatSqueeze: 0.12, // render-space radial compression on a beat (0 = off)
  beatAttack: 0.05, // seconds
  beatRelease: 0.45, // seconds
  audioTurbulence: 0.5, // loudness -> noise strength modulation
  audioDetail: 0.6, // high band -> detail octave modulation

  // --- look -------------------------------------------------------------
  inkDensity: 1.0, // k in 1 - exp(-density * k)
  pointSize: 1.2, // base sprite size in px at 1x DPR
  softFraction: 0.3, // share of groups that are wide, faint smears
  softSize: 12.0, // base size of the smear strands
  dofFocal: 0.0, // focal plane offset along the view axis (0 = core)
  dofBlur: 16.0, // px of blur per unit of distance from the focal plane
  dofMax: 32.0, // px clamp
  maxGap: 0.3, // segments longer than this (world units) are jumps, not strokes
  wideThreshold: 12.0, // strokes wider than this (px) go to the low-res blur buffer (keep >= 12: that pass visits every 4th particle)
  renderScale: 1.0, // internal resolution of the ink buffer (adaptive mode lowers this first)
  trails: false,
  trailDecay: 0.86,
  grain: 0.045,
  vignette: 0.55,
  paperWarmth: 0.012,

  // --- camera -----------------------------------------------------------
  orbitSpeed: 0.035, // rad/s
  camDistance: 3.6,
  camDrift: 0.25,

  // --- beat detection ---------------------------------------------------
  beatSensitivity: 1.3, // threshold = mean + sensitivity * std
  beatRefractory: 0.16, // seconds
  beatLowHz: 40,
  beatHighHz: 150,
  manualBpm: false,
  bpm: 124,
  bpmOffset: 0, // ms

  // --- misc -------------------------------------------------------------
  showFps: true,
};

export type Params = typeof params;
