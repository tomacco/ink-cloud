import * as THREE from 'three';
import type { Params } from '../params';
import type { ParticleSim } from '../sim/ParticleSim';

// Ink-on-paper rendering in two passes:
//   1. accumulate: every particle adds "ink density" into a single-channel float
//      target with additive blending (optionally on top of a decayed copy of
//      the previous frame = trails).
//   2. composite: density -> darkness with 1 - exp(-density * k), multiplied
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

const POINTS_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
in float pid;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform float uTexSize;
uniform float uStrandSize;
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
uniform float uRibbonLines;
uniform float uDofLod;
out float vAlpha;
${HASH_GLSL}

void main() {
  float px = mod(pid, uTexSize);
  float py = floor(pid / uTexSize);
  vec2 uv = (vec2(px, py) + 0.5) / uTexSize;
  vec4 pos = texture(tPos, uv);
  vec4 vel = texture(tVel, uv);
  float strand = floor(pid / uStrandSize);
  float group = floor(strand / uRibbonLines);
  vec3 hs = hash31(group * 5.31 + 77.0 + uSeed);

  float life = max(vel.w, 1e-3);
  float u = clamp((uTime - pos.w) / life, 0.0, 1.0);
  float fade = smoothstep(0.0, 0.02, u) * (1.0 - smoothstep(0.55, 1.0, u));
  float visible = 1.0;

  vec3 p = pos.xyz;
  float r = length(p);
  p *= 1.0 - uBeatEnv * uBeatSqueeze * (r / (r + 0.6));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float viewZ = -mv.z;
  gl_Position = projectionMatrix * mv;

  float soft = step(hs.x, uSoftFraction);
  float base = mix(uPointSize, uSoftSize, soft);
  float coc = clamp(abs(viewZ - (uCamDist + uDofFocal)) * uDofBlur, 0.0, uDofMax);
  float size = (base + coc) * uPixelRatio * (uCamDist / max(viewZ, 0.1));
  size = clamp(size, 1.0, 96.0 * uPixelRatio);
  gl_PointSize = size;

  // Ink is conserved: a bigger sprite spreads the same ink over more pixels.
  float ref = uPointSize * uPixelRatio;
  float weight = (ref * ref) / (size * size);

  // Level of detail for blurred sprites: keep 1 in N, give it N times the ink.
  // Fill rate per particle stays bounded; the soft haze looks the same.
  if (uDofLod > 0.0) {
    float lodRef = uDofLod * uPixelRatio;
    float area = (size * size) / (lodRef * lodRef);
    if (area > 1.0) {
      float keep = 1.0 / area;
      float hp = hash31(pid * 0.6180339 + uSeed).z;
      if (hp > keep) visible = 0.0;
      weight *= area;
    }
  }

  vAlpha = fade * weight * mix(1.0, 0.55, soft);
  if (visible < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const POINTS_FRAG = /* glsl */ `
precision highp float;
in float vAlpha;
layout(location = 0) out vec4 oDensity;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float falloff = exp(-d2 * 5.0) * step(d2, 1.0);
  oDensity = vec4(vAlpha * falloff, 0.0, 0.0, 1.0);
}
`;

const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
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

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D tDensity;
uniform float uInk;
uniform float uGrain;
uniform float uVignette;
uniform float uWarmth;
uniform float uTime;
uniform vec2 uResolution;
layout(location = 0) out vec4 oColor;
${HASH_GLSL}
void main() {
  float d = texture(tDensity, vUv).r;
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
  private pointsScene = new THREE.Scene();
  private points!: THREE.Points;
  private pointsMat: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private decayMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private floatBlend: boolean;
  private seed = Math.random() * 100;
  private hadTrails = false;

  constructor(renderer: THREE.WebGLRenderer, sim: ParticleSim) {
    this.renderer = renderer;
    this.floatBlend = renderer.extensions.has('EXT_float_blend');
    if (this.floatBlend) renderer.extensions.get('EXT_float_blend');

    this.pointsMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        uTexSize: { value: 1 },
        uStrandSize: { value: 8 },
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
        uRibbonLines: { value: 4 },
        uDofLod: { value: 0 },
      },
    });
    this.buildPoints(sim.count);

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
        uInk: { value: 1 },
        uGrain: { value: 0.04 },
        uVignette: { value: 0.5 },
        uWarmth: { value: 0.01 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Rebuild the index geometry when the particle count changes. */
  buildPoints(count: number): void {
    if (this.points) {
      this.pointsScene.remove(this.points);
      this.points.geometry.dispose();
    }
    const pid = new Float32Array(count);
    for (let i = 0; i < count; i++) pid[i] = i;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('pid', new THREE.BufferAttribute(pid, 1));
    geo.setDrawRange(0, count);
    this.points = new THREE.Points(geo, this.pointsMat);
    this.points.frustumCulled = false;
    this.pointsScene.add(this.points);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.pixelRatio = pixelRatio;
    this.accumA?.dispose();
    this.accumB?.dispose();
    const opts: THREE.RenderTargetOptions = {
      type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.accumA = new THREE.WebGLRenderTarget(this.width, this.height, opts);
    this.accumB = new THREE.WebGLRenderTarget(this.width, this.height, opts);
    this.compositeMat.uniforms.uResolution.value.set(this.width, this.height);
  }

  render(p: Params, sim: ParticleSim, camera: THREE.PerspectiveCamera, camDist: number, beatEnv: number, time: number): void {
    const r = this.renderer;
    const u = this.pointsMat.uniforms;
    u.tPos.value = sim.positionTexture;
    u.tVel.value = sim.velocityTexture;
    u.uTexSize.value = sim.texSize;
    u.uStrandSize.value = p.strandSize;
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
    u.uRibbonLines.value = p.ribbonLines;
    u.uDofLod.value = p.dofLod;

    // 1. accumulate
    r.setRenderTarget(this.accumA);
    if (p.trails && this.hadTrails) {
      this.decayMat.uniforms.tPrev.value = this.accumB.texture;
      this.decayMat.uniforms.uDecay.value = p.trailDecay;
      this.quad.material = this.decayMat;
      r.render(this.quadScene, this.quadCam);
    } else {
      r.setClearColor(0x000000, 1);
      r.clear(true, false, false);
    }
    this.hadTrails = p.trails;
    r.render(this.pointsScene, camera);

    // 2. composite
    const c = this.compositeMat.uniforms;
    c.tDensity.value = this.accumA.texture;
    // k is normalised so darkness does not change with particle count.
    c.uInk.value = p.inkDensity * 0.35 * (1048576 / sim.count);
    c.uGrain.value = p.grain;
    c.uVignette.value = p.vignette;
    c.uWarmth.value = p.paperWarmth;
    c.uTime.value = time;
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);

    const t = this.accumA;
    this.accumA = this.accumB;
    this.accumB = t;
  }
}
