import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl';
import type { Params } from '../params';

// GPGPU particle state in two float textures, updated in one MRT fragment pass.
//   position texture: xyz = world position, w = birth time
//   velocity texture: xyz = velocity,       w = life (seconds)
//
// Particle i belongs to emitter floor(i / strandSize). An emitter sits in the
// core and releases its particles one after another (phase = member / size),
// each living `life` seconds, so the particles trace a continuous streakline
// through the flow. Emitters come in groups of `ribbonLines` with lateral
// offsets: a group is a ribbon of parallel lines, or, when collapsed, one
// thicker line.

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const UPDATE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uTime;
uniform float uDt;
uniform float uTexSize;
uniform float uStrandSize;
uniform float uRibbonLines;
uniform float uRibbonFraction;
uniform float uCoreFraction;
uniform float uNoiseScale;
uniform float uNoiseSpeed;
uniform float uNoiseStrength;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform float uDetailRadius;
uniform float uOutwardSpeed;
uniform float uOutwardGain;
uniform float uFollow;
uniform float uLifeMin;
uniform float uLifeMax;
uniform float uCoreLife;
uniform float uCoreRadius;
uniform float uStrandSpread;
uniform float uEmitterDrift;
uniform float uBeatEnv;
uniform float uAttractor;
uniform float uMode;        // 0 = ink (free emitters), 1 = strings (ruled surfaces)
uniform float uStringSpeed;
uniform float uStringDrift;
uniform float uStringSpring;
uniform float uLinesPerSurface;
uniform vec4 uTouch;        // xyz = finger in world space, w = hold strength 0..1
uniform float uTouchStrength;
uniform float uSeed;

${NOISE_GLSL}

vec3 gaussian3(vec3 u) {
  float r1 = sqrt(-2.0 * log(max(u.x, 1e-6)));
  float a1 = 6.2831853 * u.y;
  float r2 = sqrt(-2.0 * log(max(u.z, 1e-6)));
  return vec3(r1 * cos(a1), r1 * sin(a1), r2 * cos(a1 * 1.7 + u.z * 9.0));
}

// ---- strings mode: ruled surfaces between base curves ---------------------
// Base vertices sit on a jittered cube. A curve is a quadratic Bezier through
// three vertices, or a single vertex (then every string of that surface meets
// there: a fan). A surface pairs two curves; a string joins the points at the
// same parameter u on both. Two point-curves make all strings coincide: a dark
// base edge, like the string-art cover.
vec3 baseVertex(float i) {
  float c = mod(i, 8.0);
  vec3 corner = vec3(mod(c, 2.0), mod(floor(c / 2.0), 2.0), floor(c / 4.0)) * 2.0 - 1.0;
  vec3 j = hash31(i * 2.71 + 41.0 + uSeed) - 0.5;
  return corner * 0.7 + j * 0.5;
}
vec3 baseCurve(float c, float u) {
  vec3 h = hash31(c * 1.93 + 23.0 + uSeed);
  vec3 p0 = baseVertex(floor(h.x * 8.0));
  vec3 p1 = baseVertex(floor(h.y * 8.0));
  vec3 p2 = baseVertex(floor(h.z * 8.0));
  float isPoint = step(hash11(c * 5.17 + 3.0 + uSeed), 0.3);
  p1 = mix(p1, p0, isPoint);
  p2 = mix(p2, p0, isPoint);
  float w = 1.0 - u;
  return p0 * w * w + p1 * 2.0 * w * u + p2 * u * u;
}
vec3 stringTarget(float group, float gm, float member) {
  float s = floor(group / uLinesPerSurface);
  float l = group - s * uLinesPerSurface;
  float u = fract((l + 0.5 + gm / uRibbonLines) / uLinesPerSurface + uTime * uStringSpeed * (0.5 + hash11(s * 7.3 + uSeed)));
  float f = (member + 0.5) / uStrandSize;
  vec3 a = baseCurve(s * 2.0, u);
  vec3 b = baseCurve(s * 2.0 + 1.0, u);
  vec3 t = mix(a, b, f);
  return t + curlNoise(t * 1.3 + vec3(uTime * 0.05)) * uStringDrift;
}

void main() {
  vec4 pos = texture(tPos, vUv);
  vec4 vel = texture(tVel, vUv);

  float px = floor(vUv.x * uTexSize);
  float py = floor(vUv.y * uTexSize);
  float id = px + py * uTexSize;
  float strand = floor(id / uStrandSize);
  float member = id - strand * uStrandSize;
  float phase = (member + 0.5) / uStrandSize;
  float group = floor(strand / uRibbonLines);
  float gm = strand - group * uRibbonLines;

  vec3 hg = hash31(group * 1.37 + 5.0 + uSeed);
  vec3 hg2 = hash31(group * 2.13 + 9.0 + uSeed);
  vec3 hg3 = hash31(group * 7.77 + 3.0 + uSeed);
  float isCore = step(hg3.z, uCoreFraction);

  vec3 dir = normalize(gaussian3(hg));
  vec3 core = gaussian3(hg2) * uCoreRadius * 0.5;
  vec3 side = normalize(cross(dir, hg3 - 0.5));
  float ribbon = step(hg.x, uRibbonFraction);
  // Ribbons spread into parallel lines; the rest stay nearly coincident (one soft, thicker line).
  float lateral = (gm - 0.5 * (uRibbonLines - 1.0)) * uStrandSpread * mix(0.12, 0.4 + hg.y, ribbon);
  vec3 emitter = core + side * lateral;
  emitter += curlNoise(core * 2.0 + vec3(uTime * 0.05)) * uEmitterDrift;
  vec3 target = emitter;
  if (uMode > 0.5) target = stringTarget(group, gm, member);

  float life = vel.w;
  if (life <= 0.0) {
    // First step: stagger births so the streakline is complete from the start.
    life = mix(mix(uLifeMin, uLifeMax, hg2.z * hg2.z), uCoreLife * (0.5 + hg2.z), isCore);
    pos.w = uTime - phase * life;
    pos.xyz = target;
    vel.xyz = dir * uOutwardSpeed * 0.5;
  }
  if (uTime - pos.w >= life) {
    // Re-emit exactly one life later: keeps the spacing along the line even.
    pos.w += life * floor((uTime - pos.w) / life);
    pos.xyz = target;
    vel.xyz = dir * uOutwardSpeed * 0.5;
  }

  vec3 p = pos.xyz;
  float r = length(p);

  // Flow field: large curl + per-group drift + core detail octave.
  vec3 q = p * uNoiseScale + vec3(0.0, uTime * uNoiseSpeed, uTime * uNoiseSpeed * 0.37);
  vec3 flow = curlNoise(q) * uNoiseStrength;
  float coreW = exp(-(r * r) / (uDetailRadius * uDetailRadius));
  flow += curlNoise(p * uDetailScale + vec3(uTime * uNoiseSpeed * 2.3)) * uDetailStrength * coreW;
  // Core groups: a finer, jagged octave that makes the crackly dendritic detail.
  flow += curlNoise(p * uDetailScale * 3.0 + vec3(7.0, uTime * uNoiseSpeed, 0.0)) * uDetailStrength * 4.0 * isCore;
  float speedVar = (0.5 + hg.z) * (1.0 - 0.75 * isCore);
  flow += dir * uOutwardSpeed * speedVar * (1.0 + uOutwardGain * r);

  // Velocity relaxes onto the flow; the beat adds a pull toward the core.
  vec3 v = vel.xyz;
  v += (flow - v) * min(1.0, uFollow * uDt);
  if (r > 1e-4) {
    float pull = uBeatEnv * uAttractor * min(r, 1.0) * (0.6 + 0.4 * hg.x);
    v -= (p / r) * pull * uDt;
  }

  // Press and hold: ink gathers around the finger (pull + extra drag nearby).
  if (uTouch.w > 0.001) {
    vec3 td = uTouch.xyz - p;
    float tl = max(length(td), 1e-3);
    v += (td / tl) * uTouch.w * uTouchStrength * (tl / (tl + 0.25)) * uDt;
    v *= 1.0 - min(0.9, uTouch.w * 4.0 * uDt * exp(-tl * tl * 12.0));
  }

  p += v * uDt;
  // Strings: spring back onto the ruled surface, so beats and touch displace, then release.
  if (uMode > 0.5) {
    p = mix(p, target, min(1.0, uStringSpring * uDt));
    v *= 1.0 - min(1.0, uStringSpring * uDt);
  }

  oPos = vec4(p, pos.w);
  oVel = vec4(v, life);
}
`;

export class ParticleSim {
  readonly renderer: THREE.WebGLRenderer;
  texSize: number;
  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private seed = Math.random() * 100;
  time = 0;

  constructor(renderer: THREE.WebGLRenderer, texSize: number) {
    this.renderer = renderer;
    this.texSize = texSize;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: UPDATE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uTexSize: { value: texSize },
        uStrandSize: { value: 256 },
        uRibbonLines: { value: 4 },
        uRibbonFraction: { value: 0.5 },
        uCoreFraction: { value: 0.3 },
        uNoiseScale: { value: 1 },
        uNoiseSpeed: { value: 0.1 },
        uNoiseStrength: { value: 0.4 },
        uDetailScale: { value: 7 },
        uDetailStrength: { value: 0.2 },
        uDetailRadius: { value: 0.4 },
        uOutwardSpeed: { value: 0.15 },
        uOutwardGain: { value: 0.5 },
        uFollow: { value: 2.5 },
        uLifeMin: { value: 3 },
        uLifeMax: { value: 14 },
        uCoreLife: { value: 2 },
        uCoreRadius: { value: 0.12 },
        uStrandSpread: { value: 0.012 },
        uEmitterDrift: { value: 0.05 },
        uBeatEnv: { value: 0 },
        uAttractor: { value: 2 },
        uMode: { value: 0 },
        uStringSpeed: { value: 0.02 },
        uStringDrift: { value: 0.08 },
        uStringSpring: { value: 4 },
        uLinesPerSurface: { value: 32 },
        uTouch: { value: new THREE.Vector4(0, 0, 0, 0) },
        uTouchStrength: { value: 3 },
        uSeed: { value: this.seed },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.allocate(texSize);
  }

  get positionTexture(): THREE.Texture {
    return this.rtA.textures[0];
  }
  get velocityTexture(): THREE.Texture {
    return this.rtA.textures[1];
  }
  get count(): number {
    return this.texSize * this.texSize;
  }

  private makeTarget(size: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      count: 2,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of rt.textures) t.generateMipmaps = false;
    return rt;
  }

  /** (Re)allocate state textures. Life = 0 makes every particle initialise on the first step. */
  allocate(size: number): void {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.texSize = size;
    this.material.uniforms.uTexSize.value = size;
    this.rtA = this.makeTarget(size);
    this.rtB = this.makeTarget(size);
    const n = size * size;
    const texP = new THREE.DataTexture(new Float32Array(n * 4), size, size, THREE.RGBAFormat, THREE.FloatType);
    const texV = new THREE.DataTexture(new Float32Array(n * 4), size, size, THREE.RGBAFormat, THREE.FloatType);
    texP.needsUpdate = texV.needsUpdate = true;
    const u = this.material.uniforms;
    u.tPos.value = texP;
    u.tVel.value = texV;
    u.uTime.value = 0;
    u.uDt.value = 0;
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    texP.dispose();
    texV.dispose();
    this.time = 0;
  }

  /** Run the simulation forward quickly so the streaklines exist before the first frame. */
  warmup(p: Params, steps: number, dt = 1 / 30): void {
    for (let i = 0; i < steps; i++) this.step(p, dt, 0);
  }

  step(p: Params, dt: number, beatEnv: number, touch: THREE.Vector4 | null = null): void {
    const u = this.material.uniforms;
    if (touch) (u.uTouch.value as THREE.Vector4).copy(touch);
    else (u.uTouch.value as THREE.Vector4).set(0, 0, 0, 0);
    u.uTouchStrength.value = p.touchStrength;
    u.uMode.value = p.mode;
    u.uStringSpeed.value = p.stringSpeed;
    u.uStringDrift.value = p.stringDrift;
    u.uStringSpring.value = p.stringSpring;
    u.uLinesPerSurface.value = p.linesPerSurface;
    this.time += dt;
    u.uTime.value = this.time;
    u.uDt.value = dt;
    u.uStrandSize.value = p.strandSize;
    u.uRibbonLines.value = p.ribbonLines;
    u.uRibbonFraction.value = p.ribbonFraction;
    u.uCoreFraction.value = p.coreFraction;
    u.uNoiseScale.value = p.noiseScale;
    u.uNoiseSpeed.value = p.noiseSpeed;
    u.uNoiseStrength.value = p.noiseStrength;
    u.uDetailScale.value = p.detailScale;
    u.uDetailStrength.value = p.detailStrength;
    u.uDetailRadius.value = p.detailRadius;
    u.uOutwardSpeed.value = p.outwardSpeed;
    u.uOutwardGain.value = p.outwardGain;
    u.uFollow.value = p.follow;
    u.uLifeMin.value = p.lifeMin;
    u.uLifeMax.value = p.lifeMax;
    u.uCoreLife.value = p.coreLife;
    u.uCoreRadius.value = p.coreRadius;
    u.uStrandSpread.value = p.strandSpread;
    u.uEmitterDrift.value = p.emitterDrift;
    u.uBeatEnv.value = beatEnv;
    u.uAttractor.value = p.attractorStrength;
    u.tPos.value = this.rtA.textures[0];
    u.tVel.value = this.rtA.textures[1];
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    const t = this.rtA;
    this.rtA = this.rtB;
    this.rtB = t;
  }

  /** Read back a square block of particle positions (debugging / tests). */
  samplePositions(size = 64): Float32Array {
    const out = new Float32Array(size * size * 4);
    this.renderer.readRenderTargetPixels(this.rtA, 0, 0, size, size, out);
    return out;
  }

  sampleVelocities(size = 64): Float32Array {
    const out = new Float32Array(size * size * 4);
    this.renderer.readRenderTargetPixels(this.rtA, 0, 0, size, size, out, undefined, 1);
    return out;
  }

  /** Read `rows` rows of 64 consecutive particles spread over the whole texture (debugging). */
  sampleRows(rows = 32, width = 64): { pos: Float32Array; vel: Float32Array } {
    const pos = new Float32Array(rows * width * 4);
    const vel = new Float32Array(rows * width * 4);
    const rowBuf = new Float32Array(width * 4);
    for (let i = 0; i < rows; i++) {
      const y = Math.floor(((i + 0.5) / rows) * this.texSize);
      this.renderer.readRenderTargetPixels(this.rtA, 0, y, width, 1, rowBuf);
      pos.set(rowBuf, i * width * 4);
      this.renderer.readRenderTargetPixels(this.rtA, 0, y, width, 1, rowBuf, undefined, 1);
      vel.set(rowBuf, i * width * 4);
    }
    return { pos, vel };
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.material.dispose();
  }
}
