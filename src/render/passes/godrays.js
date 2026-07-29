import * as THREE from 'three';
import {
  createTarget, resizeTarget, makeMaterial, setDefine,
  GLSL_DEPTH, GLSL_NOISE,
} from './common.js';

/**
 * Godrays (light shafts) em meia resolução.
 *
 * Duas etapas:
 *  1. Máscara de oclusão — só o que é céu E brilhante entra. A profundidade é
 *     quem decide: onde há terreno, a fonte vale zero. É daí que sai a sombra
 *     volumétrica atrás de uma montanha, e é a diferença entre "raios de sol" e
 *     "borrão radial colado por cima".
 *  2. Borrão radial a partir da posição projetada do sol, com decaimento
 *     exponencial (Mitchell, GPU Gems 3).
 *
 * O disco sintético existe porque o módulo `sky` pode desenhar o sol com
 * intensidade modesta; sem ele os raios sumiriam justo no enquadramento de
 * contra-luz, que é onde o efeito importa.
 */

const OCCLUSION_FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_DEPTH}
uniform sampler2D tScene;
uniform vec2  uSunUV;
uniform vec3  uSunColor;
uniform float uThreshold;
uniform float uDiskSize;
uniform float uDiskGain;
uniform float uAspect;
uniform float uFarCut;

void main() {
  vec2 uv = vUv;
  // 1 no céu, 0 onde existe geometria. O depth foi limpo entre o pass distante
  // e o próximo, então "sem geometria próxima" == far.
  float sky = step(uFarCut, eyeDepthAt(uv));

  vec3 c = texture2D(tScene, uv).rgb;
  // Subtrair o limiar em vez de cortar: nuvem cinza não vira fonte de luz.
  vec3 src = max(c - uThreshold, vec3(0.0));

  vec2 d = (uv - uSunUV) * vec2(uAspect, 1.0);
  float g = exp(-dot(d, d) / max(2.0 * uDiskSize * uDiskSize, 1e-6));
  src += uSunColor * (g * uDiskGain);

  gl_FragColor = vec4(src * sky, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_NOISE}
uniform sampler2D tOcclusion;
uniform vec2  uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uExposure;
uniform float uEdgeFade;

void main() {
  vec2 uv = vUv;
  vec2 delta = (uv - uSunUV) * (uDensity / float(GODRAY_SAMPLES));
  // Jitter por pixel: sem ele o passo fixo desenha anéis concêntricos visíveis.
  float jitter = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float illum = uExposure;
  vec2 pos = uv - delta * jitter;

  for (int i = 0; i < GODRAY_SAMPLES; i++) {
    pos -= delta;
    acc += texture2D(tOcclusion, clamp(pos, vec2(0.0), vec2(1.0))).rgb * illum * uWeight;
    illum *= uDecay;
  }

  gl_FragColor = vec4(acc * uEdgeFade, 1.0);
}
`;

export class GodraysPass {
  constructor(sharedDepthUniforms, hdrType) {
    const opts = { type: hdrType || THREE.HalfFloatType, name: 'postfx/godrays' };
    this.occTarget = createTarget(1, 1, opts);
    this.blurTarget = createTarget(1, 1, opts);

    const D = sharedDepthUniforms;
    this.occMat = makeMaterial(OCCLUSION_FRAG, {
      tDepth: D.tDepth, uLogFC: D.uLogFC, uNearFar: D.uNearFar, uProjRay: D.uProjRay,
      tScene: { value: null },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uThreshold: { value: 0.9 },
      uDiskSize: { value: 0.035 },
      uDiskGain: { value: 3 },
      uAspect: { value: 1 },
      uFarCut: D.uFarCut,
    }, { name: 'postfx/godraysOcc' });

    this.blurMat = makeMaterial(BLUR_FRAG, {
      tOcclusion: { value: null },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.92 },
      uDecay: { value: 0.955 },
      uWeight: { value: 0.42 },
      uExposure: { value: 0.22 },
      uEdgeFade: { value: 1 },
    }, { name: 'postfx/godraysBlur', defines: { GODRAY_SAMPLES: 32 } });
  }

  setSize(fullW, fullH) {
    const w = Math.max(1, Math.ceil(fullW * 0.5));
    const h = Math.max(1, Math.ceil(fullH * 0.5));
    resizeTarget(this.occTarget, w, h);
    resizeTarget(this.blurTarget, w, h);
    this.occMat.uniforms.uAspect.value = fullW / Math.max(1, fullH);
  }

  /**
   * @param {THREE.Vector2} sunUV posição do sol em UV (pode estar fora de [0,1])
   * @param {number} edgeFade 0..1 — some quando o sol sai do quadro
   */
  render(renderer, quad, sceneTexture, sunUV, sunColor, edgeFade, p) {
    const ou = this.occMat.uniforms;
    ou.tScene.value = sceneTexture;
    ou.uSunUV.value.copy(sunUV);
    ou.uSunColor.value.copy(sunColor);
    ou.uThreshold.value = p.threshold;
    ou.uDiskSize.value = p.diskSize;
    ou.uDiskGain.value = p.diskGain;
    quad.render(renderer, this.occMat, this.occTarget);

    setDefine(this.blurMat, 'GODRAY_SAMPLES', p.samples | 0);
    const bu = this.blurMat.uniforms;
    bu.tOcclusion.value = this.occTarget.texture;
    bu.uSunUV.value.copy(sunUV);
    bu.uDensity.value = p.density;
    bu.uDecay.value = p.decay;
    bu.uWeight.value = p.weight;
    bu.uExposure.value = p.exposure;
    bu.uEdgeFade.value = edgeFade;
    quad.render(renderer, this.blurMat, this.blurTarget);

    return this.blurTarget.texture;
  }

  materials() {
    return [{ key: 'occ', material: this.occMat }, { key: 'blur', material: this.blurMat }];
  }

  dispose() {
    this.occTarget.dispose();
    this.blurTarget.dispose();
    this.occMat.dispose();
    this.blurMat.dispose();
  }
}
