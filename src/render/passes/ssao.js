import * as THREE from 'three';
import {
  createTarget, resizeTarget, makeMaterial, setDefine,
  GLSL_DEPTH, GLSL_NORMAL, GLSL_NOISE,
} from './common.js';

/**
 * HBAO em meia resolução, com raio em espaço de MUNDO.
 *
 * Por que raio em metros e não em pixels: um AO com raio fixo em pixels muda de
 * significado conforme a distância — de perto ele oclui a pedra inteira, de
 * longe ele vira uma linha de contorno. Convertendo 1,2 m para UV pela projeção
 * (raioUV = 0.5*R / (tan(fov/2) * z)) a oclusão de contato tem sempre o mesmo
 * tamanho físico, que é o que faz uma rocha "assentar" no chão.
 *
 * Por que HBAO e não um SSAO de esfera: com a normal reconstruída do depth, o
 * SSAO clássico produz um halo cinza uniforme. O HBAO guarda o horizonte MÁXIMO
 * por direção, então uma fenda estreita ocluí de verdade e uma superfície plana
 * não oclui nada.
 */

const AO_FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_DEPTH}
${GLSL_NORMAL}
${GLSL_NOISE}

uniform vec2  uTexelFull;    // 1/resolução da fonte (depth em resolução cheia)
uniform float uRadius;       // metros
uniform float uNegInvR2;     // -1/R²
uniform float uIntensity;
uniform float uBias;
uniform float uMaxRadiusUV;
uniform float uFarCut;

void main() {
  vec2 uv = vUv;
  float eyeD = eyeDepthAt(uv);

  // Céu: o depth foi limpo antes do pass próximo, logo vale exatamente far.
  if (eyeD >= uFarCut) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPosAt(uv, eyeD);
  vec3 N = viewNormalAt(uv, P, uTexelFull);

  // Raio de mundo → raio em UV. uProjRay já carrega o aspecto no componente x.
  vec2 radUV = (0.5 * uRadius / eyeD) / uProjRay;
  // Teto: sem ele, um pixel a 30 cm da câmera varreria a tela inteira e
  // destruiria a cache de textura.
  float m = max(radUV.x, radUV.y);
  if (m > uMaxRadiusUV) radUV *= uMaxRadiusUV / m;
  // Menor que um texel da fonte: nada a integrar, só ruído.
  if (max(radUV.x, radUV.y) < uTexelFull.y) { gl_FragColor = vec4(1.0); return; }

  float noise = ign(gl_FragCoord.xy);
  float occ = 0.0;
  const float DIR_STEP = 6.2831853 / float(SSAO_DIRS);

  for (int d = 0; d < SSAO_DIRS; d++) {
    float ang = (float(d) + noise) * DIR_STEP;
    vec2 dir = vec2(cos(ang), sin(ang));
    // Horizonte: o MAIOR bloqueio encontrado ao longo do raio, não a soma.
    float horizon = 0.0;
    for (int s = 0; s < SSAO_STEPS; s++) {
      float t = (float(s) + 0.5 + noise * 0.5) / float(SSAO_STEPS);
      vec2 suv = uv + dir * radUV * t;
      float sd = eyeDepthAt(suv);
      if (sd >= uFarCut) continue;
      vec3 V = viewPosAt(suv, sd) - P;
      float vv = dot(V, V);
      float nv = dot(N, V) * inversesqrt(max(vv, 1e-10));
      float falloff = clamp(vv * uNegInvR2 + 1.0, 0.0, 1.0);
      horizon = max(horizon, clamp(nv - uBias, 0.0, 1.0) * falloff);
    }
    occ += horizon;
  }

  float ao = 1.0 - (occ / float(SSAO_DIRS)) * uIntensity;
  gl_FragColor = vec4(clamp(ao, 0.0, 1.0));
}
`;

/**
 * Blur bilateral separável guiado por profundidade.
 * O peso usa a diferença RELATIVA de profundidade (|Δz|/z) porque a mesma cena
 * é vista a 2 m e a 400 km: um limiar absoluto em metros ou borra tudo ou não
 * borra nada.
 */
const BLUR_FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_DEPTH}
uniform sampler2D tAO;
uniform vec2 uDir;        // (texel.x,0) ou (0,texel.y) no alvo de meia resolução
uniform float uSharp;
uniform float uFarCut;

void main() {
  float d0 = eyeDepthAt(vUv);
  float sum = texture2D(tAO, vUv).r;
  float wsum = 1.0;
  for (int i = 1; i <= 4; i++) {
    float fi = float(i);
    float g = exp(-fi * fi * 0.18);
    vec2 o = uDir * fi;

    vec2 u1 = vUv + o;
    float d1 = eyeDepthAt(u1);
    float w1 = g * exp(-abs(d1 - d0) / max(d0, 1e-3) * uSharp);
    sum += texture2D(tAO, u1).r * w1; wsum += w1;

    vec2 u2 = vUv - o;
    float d2 = eyeDepthAt(u2);
    float w2 = g * exp(-abs(d2 - d0) / max(d0, 1e-3) * uSharp);
    sum += texture2D(tAO, u2).r * w2; wsum += w2;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4));
}
`;

export class SsaoPass {
  constructor(sharedDepthUniforms) {
    // Meia resolução, canal único: 1 byte por pixel em vez de 8. A AO passa por
    // um blur bilateral logo em seguida, 8 bits não são o gargalo de qualidade.
    const opts = { type: THREE.UnsignedByteType, format: THREE.RedFormat, name: 'postfx/ao' };
    this.targetA = createTarget(1, 1, opts);
    this.targetB = createTarget(1, 1, opts);

    const D = sharedDepthUniforms;
    this.aoMat = makeMaterial(AO_FRAG, {
      tDepth: D.tDepth, uLogFC: D.uLogFC, uNearFar: D.uNearFar, uProjRay: D.uProjRay,
      uTexelFull: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 1.2 },
      uNegInvR2: { value: -1 / 1.44 },
      uIntensity: { value: 1 },
      uBias: { value: 0.12 },
      uMaxRadiusUV: { value: 0.09 },
      uFarCut: D.uFarCut,
    }, { name: 'postfx/ssao', defines: { SSAO_DIRS: 4, SSAO_STEPS: 4 } });

    this.blurMat = makeMaterial(BLUR_FRAG, {
      tDepth: D.tDepth, uLogFC: D.uLogFC, uNearFar: D.uNearFar, uProjRay: D.uProjRay,
      tAO: { value: null },
      uDir: { value: new THREE.Vector2() },
      uSharp: { value: 45 },
      uFarCut: D.uFarCut,
    }, { name: 'postfx/ssaoBlur' });

    this.width = 1; this.height = 1;
  }

  setSize(fullW, fullH) {
    const w = Math.max(1, Math.ceil(fullW * 0.5));
    const h = Math.max(1, Math.ceil(fullH * 0.5));
    resizeTarget(this.targetA, w, h);
    resizeTarget(this.targetB, w, h);
    this.width = w; this.height = h;
    this.aoMat.uniforms.uTexelFull.value.set(1 / fullW, 1 / fullH);
  }

  /** @returns {THREE.Texture} mapa de oclusão já borrado. */
  render(renderer, quad, p) {
    setDefine(this.aoMat, 'SSAO_DIRS', p.dirs | 0);
    setDefine(this.aoMat, 'SSAO_STEPS', p.steps | 0);
    const u = this.aoMat.uniforms;
    u.uRadius.value = p.radius;
    u.uNegInvR2.value = -1 / Math.max(1e-4, p.radius * p.radius);
    u.uIntensity.value = p.intensity;
    u.uBias.value = p.bias;
    u.uMaxRadiusUV.value = p.maxRadiusUV;

    quad.render(renderer, this.aoMat, this.targetA);

    if (p.blur) {
      const bu = this.blurMat.uniforms;
      bu.uSharp.value = p.blurSharpness;
      bu.tAO.value = this.targetA.texture;
      bu.uDir.value.set(1 / this.width, 0);
      quad.render(renderer, this.blurMat, this.targetB);
      bu.tAO.value = this.targetB.texture;
      bu.uDir.value.set(0, 1 / this.height);
      quad.render(renderer, this.blurMat, this.targetA);
    }
    return this.targetA.texture;
  }

  materials() {
    return [{ key: 'ao', material: this.aoMat }, { key: 'blur', material: this.blurMat }];
  }

  dispose() {
    this.targetA.dispose();
    this.targetB.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
  }
}
