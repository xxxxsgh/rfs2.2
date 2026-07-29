import * as THREE from 'three';
import { makeMaterial } from './common.js';

/**
 * FXAA 3.11, caminho de qualidade (equivalente ao PRESET 39: 12 iterações de
 * busca de borda, com passos 1,1,1,1,1,1.5,2,2,2,2,4,8).
 *
 * Roda por ÚLTIMO e em espaço sRGB — a heurística de luma do FXAA foi calibrada
 * para valores perceptuais. Aplicá-lo em HDR linear faz o filtro ignorar
 * degraus escuros e exagerar nos claros.
 *
 * Escolhemos FXAA e não SMAA porque o SMAA exige duas texturas de lookup
 * (area/search) que só existem como binário embutido — e o repositório não
 * carrega asset binário. O caminho de busca de borda do FXAA de qualidade
 * chega perto o suficiente e custa menos de 0,4 ms em 1080p.
 */

const FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uSubpixel;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;

#define FXAA_ITERATIONS 12

// sqrt() aproxima a resposta perceptual do olho melhor que a luma linear e é o
// que a referência da NVIDIA usa quando a entrada já está em gama.
float rgb2luma(vec3 rgb) { return sqrt(dot(rgb, vec3(0.299, 0.587, 0.114))); }

float qualityStep(int i) {
  if (i < 5) return 1.0;
  if (i == 5) return 1.5;
  if (i < 10) return 2.0;
  if (i == 10) return 4.0;
  return 8.0;
}

void main() {
  vec2 uv = vUv;
  vec3 colorCenter = texture2D(tDiffuse, uv).rgb;

  float lumaCenter = rgb2luma(colorCenter);
  float lumaDown  = rgb2luma(texture2D(tDiffuse, uv + vec2(0.0, -uTexel.y)).rgb);
  float lumaUp    = rgb2luma(texture2D(tDiffuse, uv + vec2(0.0,  uTexel.y)).rgb);
  float lumaLeft  = rgb2luma(texture2D(tDiffuse, uv + vec2(-uTexel.x, 0.0)).rgb);
  float lumaRight = rgb2luma(texture2D(tDiffuse, uv + vec2( uTexel.x, 0.0)).rgb);

  float lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
  float lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));
  float lumaRange = lumaMax - lumaMin;

  // Área lisa: sai cedo. É o que mantém o custo do FXAA baixo.
  if (lumaRange < max(uEdgeThresholdMin, lumaMax * uEdgeThreshold)) {
    gl_FragColor = vec4(colorCenter, 1.0);
    return;
  }

  float lumaDownLeft  = rgb2luma(texture2D(tDiffuse, uv + vec2(-uTexel.x, -uTexel.y)).rgb);
  float lumaUpRight   = rgb2luma(texture2D(tDiffuse, uv + vec2( uTexel.x,  uTexel.y)).rgb);
  float lumaUpLeft    = rgb2luma(texture2D(tDiffuse, uv + vec2(-uTexel.x,  uTexel.y)).rgb);
  float lumaDownRight = rgb2luma(texture2D(tDiffuse, uv + vec2( uTexel.x, -uTexel.y)).rgb);

  float lumaDownUp    = lumaDown + lumaUp;
  float lumaLeftRight = lumaLeft + lumaRight;
  float lumaLeftCorners  = lumaDownLeft + lumaUpLeft;
  float lumaDownCorners  = lumaDownLeft + lumaDownRight;
  float lumaRightCorners = lumaDownRight + lumaUpRight;
  float lumaUpCorners    = lumaUpRight + lumaUpLeft;

  float edgeHorizontal = abs(-2.0 * lumaLeft + lumaLeftCorners)
                       + abs(-2.0 * lumaCenter + lumaDownUp) * 2.0
                       + abs(-2.0 * lumaRight + lumaRightCorners);
  float edgeVertical   = abs(-2.0 * lumaUp + lumaUpCorners)
                       + abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0
                       + abs(-2.0 * lumaDown + lumaDownCorners);
  bool isHorizontal = (edgeHorizontal >= edgeVertical);

  float luma1 = isHorizontal ? lumaDown : lumaLeft;
  float luma2 = isHorizontal ? lumaUp : lumaRight;
  float gradient1 = luma1 - lumaCenter;
  float gradient2 = luma2 - lumaCenter;
  bool is1Steepest = abs(gradient1) >= abs(gradient2);
  float gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

  float stepLength = isHorizontal ? uTexel.y : uTexel.x;
  float lumaLocalAverage = 0.0;
  if (is1Steepest) {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
  } else {
    lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
  }

  vec2 currentUv = uv;
  if (isHorizontal) currentUv.y += stepLength * 0.5;
  else              currentUv.x += stepLength * 0.5;

  vec2 offset = isHorizontal ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;

  float lumaEnd1 = rgb2luma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAverage;
  float lumaEnd2 = rgb2luma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAverage;
  bool reached1 = abs(lumaEnd1) >= gradientScaled;
  bool reached2 = abs(lumaEnd2) >= gradientScaled;
  bool reachedBoth = reached1 && reached2;
  if (!reached1) uv1 -= offset;
  if (!reached2) uv2 += offset;

  if (!reachedBoth) {
    for (int i = 2; i < FXAA_ITERATIONS; i++) {
      float q = qualityStep(i);
      if (!reached1) {
        lumaEnd1 = rgb2luma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAverage;
        reached1 = abs(lumaEnd1) >= gradientScaled;
      }
      if (!reached2) {
        lumaEnd2 = rgb2luma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAverage;
        reached2 = abs(lumaEnd2) >= gradientScaled;
      }
      if (!reached1) uv1 -= offset * q;
      if (!reached2) uv2 += offset * q;
      if (reached1 && reached2) break;
    }
  }

  float distance1 = isHorizontal ? (uv.x - uv1.x) : (uv.y - uv1.y);
  float distance2 = isHorizontal ? (uv2.x - uv.x) : (uv2.y - uv.y);
  bool isDirection1 = distance1 < distance2;
  float distanceFinal = min(distance1, distance2);
  float edgeThickness = distance1 + distance2;
  float pixelOffset = -distanceFinal / max(edgeThickness, 1e-8) + 0.5;

  bool isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  bool correctVariation = ((isDirection1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaCenterSmaller;
  float finalOffset = correctVariation ? pixelOffset : 0.0;

  // Componente de subpixel: recupera o detalhe fino que o deslocamento de borda
  // sozinho deixaria cintilando (folhagem, cabos, estrelas).
  float lumaAverage = (1.0 / 12.0) * (2.0 * (lumaDownUp + lumaLeftRight)
                    + lumaLeftCorners + lumaRightCorners);
  float sub1 = clamp(abs(lumaAverage - lumaCenter) / max(lumaRange, 1e-8), 0.0, 1.0);
  float sub2 = (-2.0 * sub1 + 3.0) * sub1 * sub1;
  float subFinal = sub2 * sub2 * uSubpixel;
  finalOffset = max(finalOffset, subFinal);

  vec2 finalUv = uv;
  if (isHorizontal) finalUv.y += finalOffset * stepLength;
  else              finalUv.x += finalOffset * stepLength;

  gl_FragColor = vec4(texture2D(tDiffuse, finalUv).rgb, 1.0);
}
`;

export class FxaaPass {
  constructor() {
    this.mat = makeMaterial(FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uSubpixel: { value: 0.75 },
      uEdgeThreshold: { value: 0.125 },
      uEdgeThresholdMin: { value: 0.0312 },
    }, { name: 'postfx/fxaa' });
  }

  setSize(w, h) { this.mat.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h)); }

  render(renderer, quad, texture, target, p) {
    const u = this.mat.uniforms;
    u.tDiffuse.value = texture;
    u.uSubpixel.value = p.subpixel;
    u.uEdgeThreshold.value = p.edgeThreshold;
    u.uEdgeThresholdMin.value = p.edgeThresholdMin;
    quad.render(renderer, this.mat, target || null);
  }

  materials() { return [{ key: 'fxaa', material: this.mat }]; }

  dispose() { this.mat.dispose(); }
}
