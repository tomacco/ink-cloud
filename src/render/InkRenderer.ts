import * as THREE from 'three';
import type { Params } from '../params';
import type { ParticleSim } from '../sim/ParticleSim';
import type { GpuTimer } from './GpuTimer';

// Ink-on-paper rendering in three passes:
//   1. stroke pre-pass: one fragment per particle computes the screen-space
//      segment from the particle to an older neighbour on its streakline:
//      endpoints, width (depth of field), ink weight. Doing this once per
//      particle instead of once per quad vertex is what keeps 1M strokes cheap.
//   2. accumulate: instanced capsules add "ink density" into single-channel
//      float targets with additive blending. Thin strokes go to a full-res
//      buffer, wide (blurred) strokes to a small one where fill is cheap.
//      Optionally on top of a decayed copy of the previous frame (trails).
//   3. composite: density -> darkness with 1 - exp(-density * k), multiplied
//      onto a warm paper tone with a vignette and film grain.

const HASH_GLSL = /* glsl */ `
vec3 hash31(float n) {
  return fract(sin(vec3(n * 127.1 + 311.7, n * 269.5 + 183.3, n * 419.2 + 371.9)) * 43758.5453123);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 1: per-particle stroke data (MRT)
//   o0 = (sA.xy, sB.xy) screen px at full resolution
//   o1 = (width px, ink weight, length px, state) state: 0 hidden, 1 thin, 2 wide
const PREPASS_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform float uTexSize;
uniform float uStrandSize;
uniform float uRibbonLines;
uniform float uTime;
uniform float uSeed;
uniform float uPointSize;
uniform float uSoftFraction;
uniform float uSoftSize;
uniform float uDofFocal;
uniform float uDofBlur;
uniform float uDofMax;
uniform float uPixelRatio;
uniform float uCamDist;
uniform float uBeatEnv;
uniform float uBeatSqueeze;
uniform float uMaxGap;
uniform float uWideThreshold;
uniform float uMode;
uniform vec2 uResolution;
${HASH_GLSL}

vec2 texel(float id) {
  float px = mod(id, uTexSize);
  float py = floor(id / uTexSize);
  return (vec2(px, py) + 0.5) / uTexSize;
}

vec3 squeeze(vec3 p, float vary) {
  float r = length(p);
  return p * (1.0 - uBeatEnv * uBeatSqueeze * vary * (r / (r + 0.6)));
}

void main() {
  float px = floor(vUv.x * uTexSize);
  float py = floor(vUv.y * uTexSize);
  float pid = px + py * uTexSize;
  float strand = floor(pid / uStrandSize);
  float member = pid - strand * uStrandSize;
  float group = floor(strand / uRibbonLines);
  vec3 hs = hash31(group * 5.31 + 77.0 + uSeed);
  float vary = 0.5 + hs.z; // each ribbon inhales by its own amount

  vec4 posA = texture(tPos, vUv);
  vec4 velA = texture(tVel, vUv);
  float life = max(velA.w, 1e-3);
  float u = clamp((uTime - posA.w) / life, 0.0, 1.0);
  float fade = smoothstep(0.0, 0.02, u) * (1.0 - smoothstep(0.55, 1.0, u));
  fade = mix(fade, 1.0, uMode); // strings do not taper

  vec4 mvA = uModelView * vec4(squeeze(posA.xyz, vary), 1.0);
  float viewZ = -mvA.z;
  float soft = step(hs.x, uSoftFraction);
  float base = mix(uPointSize, uSoftSize, soft);
  float coc = clamp(abs(viewZ - (uCamDist + uDofFocal)) * uDofBlur, 0.0, uDofMax);
  float width = (base + coc) * uPixelRatio * (uCamDist / max(viewZ, 0.1));
  width = clamp(width, 1.0, 96.0 * uPixelRatio);
  float wide = step(uWideThreshold * uPixelRatio, width);

  // Wide (blurred) strokes need fewer, longer segments: every k-th particle
  // draws one segment spanning k particles. Same ink, k times less fill.
  float k = clamp(floor(width / (3.0 * uPixelRatio)), 1.0, 32.0);
  // Wide strokes are drawn by a pass that visits every 4th particle only.
  k = mix(k, 4.0 * floor(k / 4.0), wide);
  float visible = 1.0 - step(0.5, mod(member, k));
  float nid = strand * uStrandSize + mod(member + k, uStrandSize);
  vec4 posB = texture(tPos, texel(nid));
  // The neighbour must be older; if it is younger the line wraps here.
  visible *= step(posB.w, posA.w - 1e-4);
  if (distance(posA.xyz, posB.xyz) > uMaxGap) visible = 0.0; // a jump, not a stroke

  vec4 mvB = uModelView * vec4(squeeze(posB.xyz, vary), 1.0);
  vec4 cA = uProjection * mvA;
  vec4 cB = uProjection * mvB;
  if (cA.w <= 0.01 || cB.w <= 0.01) visible = 0.0;
  vec2 sA = (cA.xy / max(cA.w, 0.01) * 0.5 + 0.5) * uResolution;
  vec2 sB = (cB.xy / max(cB.w, 0.01) * 0.5 + 0.5) * uResolution;
  float len = distance(sA, sB);

  // Ink is conserved across the width; a wide stroke is a faint one.
  float ref = uPointSize * uPixelRatio;
  float weight = ref / width;
  // A stretched stroke is diluted ink: fade segments that span more than a few pixels.
  weight *= min(1.0, (5.0 * uPixelRatio * k) / max(len, 1.0));
  float alpha = fade * weight * mix(1.0, 0.55, soft);

  o0 = vec4(sA, sB);
  o1 = vec4(width, alpha, len, visible * (1.0 + wide));
}
`;

// ---------------------------------------------------------------------------
// Pass 2: instanced capsules, reading the pre-pass
const SEG_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 corner;      // x: 0 = this particle, 1 = older neighbour; y: -1..1 across
in float pid;        // instanced
uniform sampler2D tStroke0;
uniform sampler2D tStroke1;
uniform float uTexSize;
uniform float uPass;   // 0 = thin strokes (full res), 1 = wide strokes (low res)
uniform float uScale;  // this target's resolution relative to full
uniform float uStride; // instance i draws particle i * uStride
uniform vec2 uResolution;
out float vAlpha;
out float vAcross;
out float vAlong;
out float vLen;
out float vWidth;

void main() {
  float id = pid * uStride;
  float px = mod(id, uTexSize);
  float py = floor(id / uTexSize);
  vec2 uv = (vec2(px, py) + 0.5) / uTexSize;
  vec4 s0 = texture(tStroke0, uv);
  vec4 s1 = texture(tStroke1, uv);
  if (s1.w < 0.5 || abs((s1.w - 1.0) - uPass) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vAcross = 0.0; vAlong = 0.0; vLen = 1.0; vWidth = 1.0;
    return;
  }
  vec2 sA = s0.xy * uScale;
  vec2 sB = s0.zw * uScale;
  float width = max(1.0, s1.x * uScale);
  float len = s1.z * uScale;
  vec2 d = sB - sA;
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Capsule: extend both ends by half the width; the fragment shader rounds them.
  vec2 pos = mix(sA, sB, corner.x) + dir * (corner.x * 2.0 - 1.0) * width * 0.5 + nrm * corner.y * width * 0.5;
  vAlong = mix(-0.5 * width, len + 0.5 * width, corner.x);
  vLen = len;
  vWidth = width;
  vAlpha = s1.y;
  vAcross = corner.y;
  vec2 ndc = pos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const SEG_FRAG = /* glsl */ `
precision highp float;
in float vAlpha;
in float vAcross;
in float vAlong;
in float vLen;
in float vWidth;
layout(location = 0) out vec4 oDensity;
void main() {
  // Distance to the segment axis, normalised so 1 = the capsule edge.
  float endGap = max(0.0, max(-vAlong, vAlong - vLen)) / (0.5 * vWidth);
  float q2 = vAcross * vAcross + endGap * endGap;
  float falloff = exp(-q2 * 4.0);
  oDensity = vec4(vAlpha * falloff, 0.0, 0.0, 1.0);
}
`;

const DECAY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D tPrev;
uniform float uDecay;
layout(location = 0) out vec4 oDensity;
void main() {
  oDensity = vec4(texture(tPrev, vUv).r * uDecay, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 3: paper
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D tDensity;
uniform sampler2D tWide;
uniform float uInk;
uniform float uGrain;
uniform float uVignette;
uniform float uWarmth;
uniform float uTime;
uniform float uInvert; // 0 = ink on paper, 1 = paper on ink (eased on the CPU)
uniform vec2 uResolution;
layout(location = 0) out vec4 oColor;
${HASH_GLSL}
void main() {
  float d = texture(tDensity, vUv).r + texture(tWide, vUv).r;
  float ink = 1.0 - exp(-d * uInk);

  vec2 c = vUv - 0.5;
  c.x *= uResolution.x / uResolution.y;
  float vig = smoothstep(0.3, 1.05, length(c)) * uVignette;
  vec3 paper = vec3(0.988, 0.984, 0.976);
  vec3 edge = vec3(0.885 + uWarmth, 0.875 + uWarmth * 0.5, 0.86);
  paper = mix(paper, edge, vig);

  vec3 col = paper * (1.0 - ink);
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 977.0) - 0.5;
  col += g * uGrain;
  col = mix(col, 1.0 - col, uInvert);
  oColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export class InkRenderer {
  private renderer: THREE.WebGLRenderer;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private accumA!: THREE.WebGLRenderTarget;
  private accumB!: THREE.WebGLRenderTarget;
  private wideA!: THREE.WebGLRenderTarget;
  private wideB!: THREE.WebGLRenderTarget;
  private wideScale = 0.35;
  private wideW = 1;
  private wideH = 1;
  private strokeData!: THREE.WebGLRenderTarget;
  private prepassMat: THREE.ShaderMaterial;
  private prepassScene = new THREE.Scene();
  private strokeScene = new THREE.Scene();
  private strokes!: THREE.Mesh;
  private strokeMat: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private decayMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private floatBlend: boolean;
  private seed = Math.random() * 100;
  private hadTrails = false;
  private count = 0;

  constructor(renderer: THREE.WebGLRenderer, sim: ParticleSim) {
    this.renderer = renderer;
    this.floatBlend = renderer.extensions.has('EXT_float_blend');
    if (this.floatBlend) renderer.extensions.get('EXT_float_blend');

    this.prepassMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: PREPASS_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        uModelView: { value: new THREE.Matrix4() },
        uProjection: { value: new THREE.Matrix4() },
        uTexSize: { value: 1 },
        uStrandSize: { value: 256 },
        uRibbonLines: { value: 4 },
        uTime: { value: 0 },
        uSeed: { value: this.seed },
        uPointSize: { value: 1.4 },
        uSoftFraction: { value: 0.3 },
        uSoftSize: { value: 9 },
        uDofFocal: { value: 0 },
        uDofBlur: { value: 14 },
        uDofMax: { value: 40 },
        uPixelRatio: { value: 1 },
        uCamDist: { value: 3.3 },
        uBeatEnv: { value: 0 },
        uBeatSqueeze: { value: 0 },
        uMaxGap: { value: 0.12 },
        uWideThreshold: { value: 5 },
        uMode: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    const prepassQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.prepassMat);
    prepassQuad.frustumCulled = false;
    this.prepassScene.add(prepassQuad);

    this.strokeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SEG_VERT,
      fragmentShader: SEG_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        tStroke0: { value: null },
        tStroke1: { value: null },
        uTexSize: { value: 1 },
        uPass: { value: 0 },
        uScale: { value: 1 },
        uStride: { value: 1 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.buildStrokes(sim.count);

    this.decayMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: DECAY_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { tPrev: { value: null }, uDecay: { value: 0.9 } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDensity: { value: null },
        tWide: { value: null },
        uInk: { value: 1 },
        uGrain: { value: 0.04 },
        uVignette: { value: 0.5 },
        uWarmth: { value: 0.01 },
        uTime: { value: 0 },
        uInvert: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** One instanced quad per particle plus the stroke-data target; rebuilt when the count changes. */
  buildStrokes(count: number): void {
    this.count = count;
    if (this.strokes) {
      this.strokeScene.remove(this.strokes);
      this.strokes.geometry.dispose();
    }
    const geo = new THREE.InstancedBufferGeometry();
    const corner = new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]);
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    // Three needs a position attribute to count vertices; corners double as it.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const pid = new Float32Array(count);
    for (let i = 0; i < count; i++) pid[i] = i;
    geo.setAttribute('pid', new THREE.InstancedBufferAttribute(pid, 1));
    geo.instanceCount = count;
    this.strokes = new THREE.Mesh(geo, this.strokeMat);
    this.strokes.frustumCulled = false;
    this.strokeScene.add(this.strokes);

    const size = Math.round(Math.sqrt(count));
    this.strokeData?.dispose();
    this.strokeData = new THREE.WebGLRenderTarget(size, size, {
      count: 2,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of this.strokeData.textures) t.generateMipmaps = false;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.pixelRatio = pixelRatio;
    this.accumA?.dispose();
    this.accumB?.dispose();
    this.wideA?.dispose();
    this.wideB?.dispose();
    const opts: THREE.RenderTargetOptions = {
      type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.accumA = new THREE.WebGLRenderTarget(this.width, this.height, opts);
    this.accumB = new THREE.WebGLRenderTarget(this.width, this.height, opts);
    this.wideW = Math.max(1, Math.floor(this.width * this.wideScale));
    this.wideH = Math.max(1, Math.floor(this.height * this.wideScale));
    this.wideA = new THREE.WebGLRenderTarget(this.wideW, this.wideH, opts);
    this.wideB = new THREE.WebGLRenderTarget(this.wideW, this.wideH, opts);
    this.compositeMat.uniforms.uResolution.value.set(this.width, this.height);
    this.prepassMat.uniforms.uResolution.value.set(this.width, this.height);
  }

  render(
    p: Params,
    sim: ParticleSim,
    camera: THREE.PerspectiveCamera,
    camDist: number,
    beatEnv: number,
    time: number,
    timer: GpuTimer | null = null,
    invert = 0
  ): void {
    const r = this.renderer;

    // 1. per-particle stroke data
    timer?.begin('prepass');
    const u = this.prepassMat.uniforms;
    u.tPos.value = sim.positionTexture;
    u.tVel.value = sim.velocityTexture;
    camera.updateMatrixWorld();
    (u.uModelView.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    u.uTexSize.value = sim.texSize;
    u.uStrandSize.value = p.strandSize;
    u.uRibbonLines.value = p.ribbonLines;
    u.uTime.value = sim.time;
    u.uPointSize.value = p.pointSize;
    u.uSoftFraction.value = p.softFraction;
    u.uSoftSize.value = p.softSize;
    u.uDofFocal.value = p.dofFocal;
    u.uDofBlur.value = p.dofBlur;
    u.uDofMax.value = p.dofMax;
    u.uPixelRatio.value = this.pixelRatio;
    u.uCamDist.value = camDist;
    u.uBeatEnv.value = beatEnv;
    u.uBeatSqueeze.value = p.beatSqueeze;
    u.uMaxGap.value = p.maxGap;
    u.uWideThreshold.value = p.wideThreshold;
    u.uMode.value = p.mode;
    r.setRenderTarget(this.strokeData);
    r.render(this.prepassScene, this.quadCam);
    timer?.end();

    // 2. accumulate: thin strokes at full resolution, wide (blurred) strokes
    // into a small buffer where their fill cost is a fraction.
    timer?.begin('strokes');
    const s = this.strokeMat.uniforms;
    s.tStroke0.value = this.strokeData.textures[0];
    s.tStroke1.value = this.strokeData.textures[1];
    s.uTexSize.value = sim.texSize;
    this.accumulate(this.accumA, this.accumB, 0, this.width, this.height, 1, p);
    this.accumulate(this.wideA, this.wideB, 1, this.wideW, this.wideH, this.wideScale, p);
    this.hadTrails = p.trails;
    timer?.end();

    // 3. composite
    timer?.begin('composite');
    const c = this.compositeMat.uniforms;
    c.tDensity.value = this.accumA.texture;
    c.tWide.value = this.wideA.texture;
    // k is normalised so darkness does not change with particle count.
    c.uInk.value = p.inkDensity * 0.2 * (1048576 / sim.count);
    c.uGrain.value = p.grain;
    c.uVignette.value = p.vignette;
    c.uWarmth.value = p.paperWarmth;
    c.uTime.value = time;
    c.uInvert.value = invert;
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
    timer?.end();

    const t = this.accumA;
    this.accumA = this.accumB;
    this.accumB = t;
    const w = this.wideA;
    this.wideA = this.wideB;
    this.wideB = w;
  }

  private accumulate(
    target: THREE.WebGLRenderTarget,
    prev: THREE.WebGLRenderTarget,
    pass: number,
    width: number,
    height: number,
    scale: number,
    p: Params
  ): void {
    const r = this.renderer;
    const s = this.strokeMat.uniforms;
    s.uPass.value = pass;
    s.uScale.value = scale;
    const stride = pass === 1 ? 4 : 1;
    s.uStride.value = stride;
    (this.strokes.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.floor(this.count / stride);
    s.uResolution.value.set(width, height);
    r.setRenderTarget(target);
    if (p.trails && this.hadTrails) {
      this.decayMat.uniforms.tPrev.value = prev.texture;
      this.decayMat.uniforms.uDecay.value = p.trailDecay;
      this.quad.material = this.decayMat;
      r.render(this.quadScene, this.quadCam);
    } else {
      r.setClearColor(0x000000, 1);
      r.clear(true, false, false);
    }
    r.render(this.strokeScene, this.quadCam);
  }
}
