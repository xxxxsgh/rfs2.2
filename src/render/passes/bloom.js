import * as THREE from 'three';
import { createTarget, resizeTarget, makeMaterial, GLSL_LUMA } from './common.js';

/**
 * Bloom seletivo — pirâmide dual-filter no estilo Call of Duty: Advanced
 * Warfare (Jimenez, SIGGRAPH 2014).
 *
 * Por que não um gaussiano de dois eixos: um gaussiano tem UMA escala. O que
 * faz o bloom parecer caro é ter várias escalas somadas — um halo apertado e
 * quente colado no realce e um véu larguíssimo e fraco cobrindo meia tela. A
 * pirâmide dá isso de graça: 5 downsamples de 13 taps, depois 5 upsamples com
 * filtro de tenda somados de volta na pirâmide.
 *
 * O limiar é aplicado em HDR (≈1.1), não em LDR. Cortar em LDR significa cortar
 * DEPOIS que o tone map já achatou tudo acima de 1 — aí não sobra informação
 * para distinguir um céu claro de um sol, e o bloom vira um borrão branco.
 */

const PREFILTER_FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_LUMA}
uniform sampler2D tSrc;
uniform vec2  uTexel;       // texel da FONTE
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

vec3 fetch(vec2 uv) {
  vec3 c = texture2D(tSrc, uv).rgb;
  // Trava anti-vagalume: um specular de 5000 nits num pixel isolado vira uma
  // estrela pulsante depois do downsample. Cortar o topo custa nada visualmente.
  float m = max(c.r, max(c.g, c.b));
  if (m > uClamp) c *= uClamp / m;
  return max(c, vec3(0.0));
}

/** Joelho suave (curva quadrática) — corte duro pisca em bordas em movimento. */
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float soft = br - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contrib;
}

/** Média de Karis nos 5 grupos: pondera pelo inverso da luminância. */
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  vec3 g = (a + b + c + d) * 0.25;
  return g / (1.0 + luma(g));
}

void main() {
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = fetch(uv + t * vec2(-2.0,  2.0));
  vec3 b = fetch(uv + t * vec2( 0.0,  2.0));
  vec3 c = fetch(uv + t * vec2( 2.0,  2.0));
  vec3 d = fetch(uv + t * vec2(-2.0,  0.0));
  vec3 e = fetch(uv);
  vec3 f = fetch(uv + t * vec2( 2.0,  0.0));
  vec3 g = fetch(uv + t * vec2(-2.0, -2.0));
  vec3 h = fetch(uv + t * vec2( 0.0, -2.0));
  vec3 i = fetch(uv + t * vec2( 2.0, -2.0));
  vec3 j = fetch(uv + t * vec2(-1.0,  1.0));
  vec3 k = fetch(uv + t * vec2( 1.0,  1.0));
  vec3 l = fetch(uv + t * vec2(-1.0, -1.0));
  vec3 m = fetch(uv + t * vec2( 1.0, -1.0));

  vec3 sum  = karis(j, k, l, m) * 0.5;
  sum += karis(a, b, d, e) * 0.125;
  sum += karis(b, c, e, f) * 0.125;
  sum += karis(d, e, g, h) * 0.125;
  sum += karis(e, f, h, i) * 0.125;

  gl_FragColor = vec4(prefilter(sum), 1.0);
}
`;

const DOWNSAMPLE_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

void main() {
  vec2 uv = vUv;
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, uv + t * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture2D(tSrc, uv + t * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture2D(tSrc, uv + t * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture2D(tSrc, uv + t * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture2D(tSrc, uv).rgb;
  vec3 f = texture2D(tSrc, uv + t * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture2D(tSrc, uv + t * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture2D(tSrc, uv + t * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(tSrc, uv + t * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture2D(tSrc, uv + t * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture2D(tSrc, uv + t * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture2D(tSrc, uv + t * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture2D(tSrc, uv + t * vec2( 1.0, -1.0)).rgb;

  // Pesos do 13-tap: o quadrado central pesa metade, os quatro cantos
  // compartilham a outra metade. É um kernel de suporte largo com 13 amostras.
  vec3 sum = e * 0.125;
  sum += (a + c + g + i) * 0.03125;
  sum += (b + d + f + h) * 0.0625;
  sum += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const UPSAMPLE_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2  uTexel;     // texel da FONTE (nível menor)
uniform float uRadius;
uniform float uWeight;

void main() {
  vec2 uv = vUv;
  vec2 t = uTexel * uRadius;
  // Filtro de tenda 3x3 — o upsample bilinear puro deixa degraus de bloco
  // visíveis nos níveis mais baixos.
  vec3 s = texture2D(tSrc, uv + vec2(-t.x,  t.y)).rgb;
  s += texture2D(tSrc, uv + vec2( 0.0,  t.y)).rgb * 2.0;
  s += texture2D(tSrc, uv + vec2( t.x,  t.y)).rgb;
  s += texture2D(tSrc, uv + vec2(-t.x,  0.0)).rgb * 2.0;
  s += texture2D(tSrc, uv).rgb * 4.0;
  s += texture2D(tSrc, uv + vec2( t.x,  0.0)).rgb * 2.0;
  s += texture2D(tSrc, uv + vec2(-t.x, -t.y)).rgb;
  s += texture2D(tSrc, uv + vec2( 0.0, -t.y)).rgb * 2.0;
  s += texture2D(tSrc, uv + vec2( t.x, -t.y)).rgb;
  gl_FragColor = vec4(s * (0.0625 * uWeight), 1.0);
}
`;

export class BloomPass {
  constructor(hdrType) {
    this.levels = 5;
    this.mips = [];
    for (let i = 0; i < this.levels; i++) {
      this.mips.push(createTarget(1, 1, { type: hdrType, name: `postfx/bloom${i}` }));
    }

    this.prefilterMat = makeMaterial(PREFILTER_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.1 },
      uKnee: { value: 0.6 },
      uClamp: { value: 24 },
    }, { name: 'postfx/bloomPrefilter' });

    this.downMat = makeMaterial(DOWNSAMPLE_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, { name: 'postfx/bloomDown' });

    // Aditivo: o upsample soma direto no nível maior, sem ler-modificar-gravar
    // (o que exigiria um alvo extra por nível).
    this.upMat = makeMaterial(UPSAMPLE_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.4 },
      uWeight: { value: 1 },
    }, { name: 'postfx/bloomUp', blending: THREE.AdditiveBlending });

    this._srcTexel = new THREE.Vector2();
  }

  setSize(fullW, fullH) {
    let w = fullW, h = fullH;
    for (let i = 0; i < this.levels; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      resizeTarget(this.mips[i], w, h);
    }
    this.fullW = fullW; this.fullH = fullH;
  }

  render(renderer, quad, sceneTexture, p) {
    const mips = this.mips;
    const levels = Math.max(2, Math.min(this.levels, p.levels | 0));

    // Prefiltro + primeiro downsample numa passada só.
    const pu = this.prefilterMat.uniforms;
    pu.tSrc.value = sceneTexture;
    pu.uTexel.value.set(1 / this.fullW, 1 / this.fullH);
    pu.uThreshold.value = p.threshold;
    pu.uKnee.value = Math.max(1e-3, p.knee);
    pu.uClamp.value = p.clamp;
    quad.render(renderer, this.prefilterMat, mips[0]);

    const du = this.downMat.uniforms;
    for (let i = 1; i < levels; i++) {
      du.tSrc.value = mips[i - 1].texture;
      du.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      quad.render(renderer, this.downMat, mips[i]);
    }

    const uu = this.upMat.uniforms;
    uu.uRadius.value = p.radius;
    uu.uWeight.value = 1;
    for (let i = levels - 1; i > 0; i--) {
      uu.tSrc.value = mips[i].texture;
      uu.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      quad.render(renderer, this.upMat, mips[i - 1]);
    }

    return mips[0].texture;
  }

  materials() {
    return [
      { key: 'prefilter', material: this.prefilterMat },
      { key: 'down', material: this.downMat },
      { key: 'up', material: this.upMat },
    ];
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
  }
}
