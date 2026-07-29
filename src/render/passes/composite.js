import * as THREE from 'three';
import {
  makeMaterial, GLSL_ACES, GLSL_SRGB, GLSL_LUMA, GLSL_NOISE,
} from './common.js';

/**
 * Composição final: junta tudo, comprime o HDR e entrega LDR em sRGB.
 *
 * Ordem deliberada (mexer nela muda a imagem inteira):
 *   aberração cromática → AO → bloom + godrays → exposição → vinheta →
 *   ACES → cor → grão → sRGB
 *
 * A vinheta vem ANTES do tone map porque ela representa a lente perdendo luz,
 * não uma máscara cinza. Escurecer a cena em HDR faz o rolloff das bordas
 * passar pela mesma curva que o resto; escurecer depois do ACES produz aquele
 * disco escuro chapado de filtro de app de foto.
 *
 * O grão vem DEPOIS do tone map porque grão de filme vive no negativo revelado,
 * em espaço de exibição — em HDR ele seria invisível na sombra e absurdo no
 * realce. Ele também serve de dither: sem ele, um céu com gradiente suave
 * mostra bandas de 8 bits.
 *
 * Este material tem UMA permutação só. Bloom/AO/godrays desligados apontam para
 * texturas neutras 1x1 e recebem intensidade zero, então o módulo `perf` pode
 * ligar e desligar efeitos a 60 Hz sem disparar recompilação de shader.
 */

const FRAG = /* glsl */`
varying vec2 vUv;
${GLSL_ACES}
${GLSL_SRGB}
${GLSL_LUMA}
${GLSL_NOISE}

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tGodrays;
uniform sampler2D tAO;

uniform vec2  uTexel;       // 1/resolução — a AC precisa medir em PIXELS
uniform float uExposure;
uniform float uBloom;
uniform float uGodrays;
uniform float uAO;
uniform vec2  uAOCut;       // faixa de luminância onde a AO deixa de agir
uniform float uCA;          // deslocamento máximo em PIXELS (na borda)
uniform vec2  uVignette;    // (intensidade, início do rolloff)
uniform vec2  uGrain;       // (intensidade, reforço na sombra)
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  // r² normalizado: 0 no centro, 1 no canto.
  float rn = clamp(dot(c, c) * 2.0, 0.0, 1.0);

  // ── Aberração cromática ────────────────────────────────────────────────────
  // Cresce com r² e some no centro. Uma lente real separa canais na periferia;
  // no centro qualquer separação é só sujeira que borra o alvo do jogador.
  // A direção é normalizada em PIXELS: normalizada em UV, uma tela 16:9 daria
  // quase o dobro de deslocamento na horizontal.
  vec2 cpx = c / uTexel;
  vec2 dir = cpx * inversesqrt(max(dot(cpx, cpx), 1e-6));
  vec2 off = dir * (uCA * rn) * uTexel;
  vec3 col;
  col.r = texture2D(tScene, uv + off).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - off).b;

  // ── Oclusão de ambiente ────────────────────────────────────────────────────
  // Não temos G-buffer separando luz direta de indireta, então usamos a
  // luminância como proxy: um pixel muito claro está recebendo sol direto e a
  // AO não pode escurecê-lo (senão o terreno ganha sujeira preta no sol a
  // pino). Onde está escuro, é ambiente/rebote — e é lá que a AO pertence.
  float ao = texture2D(tAO, uv).r;
  float l0 = luma(col);
  float indirect = 1.0 - smoothstep(uAOCut.x, uAOCut.y, l0);
  col *= mix(1.0, mix(1.0, ao, uAO), indirect);

  // ── Somas aditivas ─────────────────────────────────────────────────────────
  col += texture2D(tBloom, uv).rgb * uBloom;
  col += texture2D(tGodrays, uv).rgb * uGodrays;

  col *= uExposure;

  float vig = 1.0 - uVignette.x * smoothstep(uVignette.y, 1.0, rn);
  col *= vig;

  col = acesFitted(col);

  float l = luma(col);
  col = mix(vec3(l), col, uSaturation);
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);

  col = linearToSRGB(col);

  // ── Grão ancorado na luminância ────────────────────────────────────────────
  // DEPOIS do sRGB, de propósito: em espaço linear uma amplitude fixa vira um
  // ruído violento na sombra (a curva sRGB amplifica muito os valores baixos) e
  // some no realce. Em espaço de exibição a amplitude é a que se vê, e o grão
  // ainda faz as vezes de dither contra o banding de 8 bits no gradiente do céu.
  float ld = luma(col);
  float g = triNoise(gl_FragCoord.xy, uTime);
  float shadowW = mix(1.0, uGrain.y, 1.0 - smoothstep(0.0, 0.5, ld));
  col = clamp(col + g * (uGrain.x * shadowW), 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class CompositePass {
  constructor(neutralWhite, neutralBlack) {
    this.mat = makeMaterial(FRAG, {
      tScene: { value: null },
      tBloom: { value: neutralBlack },
      tGodrays: { value: neutralBlack },
      tAO: { value: neutralWhite },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uExposure: { value: 1 },
      uBloom: { value: 0 },
      uGodrays: { value: 0 },
      uAO: { value: 0 },
      uAOCut: { value: new THREE.Vector2(0.9, 3.0) },
      uCA: { value: 0 },
      uVignette: { value: new THREE.Vector2(0.42, 0.55) },
      uGrain: { value: new THREE.Vector2(0.02, 2.5) },
      uTime: { value: 0 },
      uSaturation: { value: 1.06 },
      uContrast: { value: 1.0 },
    }, { name: 'postfx/composite' });
  }

  setSize(w, h) {
    this.mat.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  render(renderer, quad, target) {
    quad.render(renderer, this.mat, target);
  }

  materials() { return [{ key: 'composite', material: this.mat }]; }

  dispose() { this.mat.dispose(); }
}
