/**
 * Material do terreno.
 *
 * MeshStandardMaterial + onBeforeCompile: herda de graça o PBR, as sombras em
 * cascata do módulo `lighting` e o log depth do engine. Reescrever tudo como
 * ShaderMaterial custaria a integração com sombras — não vale.
 *
 * O que este material resolve, e por quê:
 *
 *  • TRIPLANAR — uma UV planar num quadsphere estica horrores nas encostas
 *    íngremes, e encosta íngreme é justamente onde a rocha aparece. Projeção
 *    triplanar em espaço do PLANETA (não do chunk) elimina o esticamento e
 *    ainda garante continuidade da textura através das juntas de LOD.
 *  • HEIGHT BLENDING — mistura linear entre solo/rocha/areia/neve dá uma
 *    transição em degradê que grita "terreno procedural". Misturando pelas
 *    ALTURAS das camadas a borda vira irregular e granulada, como no real.
 *  • MACRO-VARIAÇÃO — uma oitava de frequência muito baixa multiplicando a
 *    cor. Terreno tileado é o sinal nº 1 de protótipo (ARCHITECTURE §8).
 *  • PERSPECTIVA AÉREA — as montanhas distantes precisam ser lavadas na cor do
 *    céu com SATURAÇÃO caindo e MATIZ preservado. Desbotar para cinza é o erro
 *    clássico; aqui o distante assume o matiz da névoa, nunca o cinza.
 *
 * Os uniforms de névoa são publicados em `ctx.planet.fogUniforms` para o
 * módulo `sky` sobrescrever com o resultado real do espalhamento.
 */

import * as THREE from 'three';
import { hash2f } from '../core/rng.js';
import { hexToLinear } from './biomes.js';

// ── Ruído periódico (textura tileável sem assets) ───────────────────────────

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Value noise 2D exatamente periódico em `period` — tileia sem costura. */
function pnoise(x, y, period, salt) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
  const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
  const a = hash2f(x0, y0, salt), b = hash2f(x1, y0, salt);
  const c = hash2f(x0, y1, salt), d = hash2f(x1, y1, salt);
  const u = fade(xf), v = fade(yf);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

function pfbm(x, y, period, octaves, salt, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, p = period, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * pnoise(x * f, y * f, p * f, salt + i * 131);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Textura procedural única com quatro campos empacotados:
 *   R = altura da ROCHA (ridged, contraste alto)
 *   G = grão do SOLO
 *   B = marcas de AREIA (ondulação direcional)
 *   A = manchas MACRO (baixa frequência dentro do tile)
 * Um único sample triplanar alimenta as quatro camadas — economiza 3 leituras.
 */
function makeSurfaceTexture(seedSalt, size = 256) {
  const data = new Uint8Array(size * size * 4);
  const P = 8;              // período em células de ruído
  const inv = P / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const rock = Math.abs(pfbm(u * 2.0, v * 2.0, P * 2, 5, seedSalt + 11) * 2 - 1);
      const rockH = 1 - Math.pow(rock, 0.55);
      const soil = pfbm(u * 3.0, v * 3.0, P * 3, 5, seedSalt + 57);
      const ripple = 0.5 + 0.5 * Math.sin((u * 9.0 + pfbm(u, v, P, 3, seedSalt + 91) * 2.4) * Math.PI * 2);
      const sand = ripple * 0.65 + soil * 0.35;
      const macro = pfbm(u * 0.5, v * 0.5, Math.max(2, P >> 1), 3, seedSalt + 173);
      const o = (y * size + x) * 4;
      data[o] = Math.max(0, Math.min(255, (rockH * 255) | 0));
      data[o + 1] = Math.max(0, Math.min(255, (soil * 255) | 0));
      data[o + 2] = Math.max(0, Math.min(255, (sand * 255) | 0));
      data[o + 3] = Math.max(0, Math.min(255, (macro * 255) | 0));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;     // são campos escalares, não cor
  tex.needsUpdate = true;
  return tex;
}

// ── Injeções GLSL ───────────────────────────────────────────────────────────

const COMMON_FS = /* glsl */`
varying vec4 vMatmix;
varying vec3 vTriPos;
varying vec3 vViewW;
varying float vViewDist;
varying vec3 vNrmW;

uniform sampler2D uSurfTex;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uPlanetRadius;
uniform float uDetailScale;
uniform float uMacroScale;
uniform float uSnowLine;
uniform float uSnowBlend;
uniform float uSnowAmount;
uniform vec3  uSnowColor;
uniform float uSandLine;
uniform float uSandAmount;
uniform vec3  uSandColor;
uniform float uBumpScale;
uniform float uAerial;
uniform float uFogSat;
uniform float uFogGain;
uniform float uStrataFreq;
uniform float uStrataAmount;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 triWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  return w / max(w.x + w.y + w.z, 1e-4);
}
vec4 triSample(sampler2D t, vec3 p, vec3 w, float s) {
  return texture2D(t, p.yz * s) * w.x
       + texture2D(t, p.zx * s) * w.y
       + texture2D(t, p.xy * s) * w.z;
}
`;

const MAP_FS = /* glsl */`
vec3  tpW    = triWeights(vNrmW);
vec4  sFine  = triSample(uSurfTex, vTriPos, tpW, uDetailScale);
vec4  sMid   = triSample(uSurfTex, vTriPos, tpW, uDetailScale * 0.19);
vec4  sMacro = triSample(uSurfTex, vTriPos, tpW, uMacroScale);
vec4  sMacro2= triSample(uSurfTex, vTriPos, tpW, uMacroScale * 0.27);

// Alturas por camada, alinhadas com matmix = (solo, rocha, areia, neve).
vec4 layH = vec4(
  mix(sMid.g, sFine.g, 0.60),
  mix(sMid.r, sFine.r, 0.70),
  mix(sMid.b, sFine.b, 0.50),
  mix(sMid.a, sFine.g, 0.35)
);

// Height blending: quem tem mais "relevo" toma a borda, e a borda fica
// irregular em vez de um degradê linear.
vec4 pres = vMatmix;
vec4 bw   = pres + layH * 0.62;
float mxw = max(max(bw.x, bw.y), max(bw.z, bw.w));
vec4 blendW = max(bw - (mxw - 0.20), 0.0) * step(0.004, pres);
blendW /= max(blendW.x + blendW.y + blendW.z + blendW.w, 1e-4);

float macroV = sMacro.a * 0.62 + sMacro2.r * 0.38;
float grain  = dot(blendW, vec4(sFine.g, sFine.r, sFine.b, sFine.a));
float bumpH  = dot(blendW, layH);

// A macro-variação é a diferença entre "terreno" e "textura repetida".
diffuseColor.rgb *= mix(0.72, 1.30, macroV) * mix(0.82, 1.16, grain);

// ── Estratificação sedimentar ─────────────────────────────────────────────
// Bandas constantes em ALTITUDE (não em espaço de textura) são o que dá escala
// legível a um paredão: sem elas a rocha vira uma mancha uniforme e a falésia
// perde a altura — o item 6 do §8 do ARCHITECTURE. A frequência é quebrada pelo
// campo macro para não sair uma régua perfeita, e o efeito some com a distância
// porque uma banda de 20 m aliasa muito antes de chegar ao horizonte.
float stratAlt = length(vTriPos) - uPlanetRadius;
float stratFade = uStrataAmount * (1.0 - smoothstep(280.0, 2200.0, vViewDist));
float strat = 0.0;
if (stratFade > 0.001) {
  float band = sin((stratAlt * uStrataFreq + macroV * 2.6 + sMid.r * 1.7) * 6.2831853);
  strat = band * 0.5 + 0.5;
  strat *= strat * (3.0 - 2.0 * strat);
  // Só a rocha e a areia estratificam; solo e neve não têm camadas expostas.
  float layerW = blendW.y + blendW.z * 0.45;
  diffuseColor.rgb *= mix(1.0, mix(0.74, 1.20, strat), layerW * stratFade);
  // Entra também no relevo: é a saliência que faz a luz rasante desenhar as
  // camadas em vez de apenas mudar a cor.
  bumpH += (strat - 0.5) * 0.55 * layerW * stratFade;
}
`;

/**
 * Neve e areia entram DEPOIS de `<color_fragment>`: se entrassem antes, a cor
 * de vértice do bioma multiplicaria a neve e ela sairia verde/ocre em vez de
 * branca. Elas se ACUMULAM, não são pintadas — por isso dependem de altitude e
 * de inclinação, com a borda quebrada por ruído macro.
 */
const SNOW_FS = /* glsl */`
float altM   = length(vTriPos) - uPlanetRadius;
float upness = dot(normalize(vTriPos), vNrmW);
float edgeN  = (macroV - 0.5) * 2.0;

float snowF = smoothstep(uSnowLine, uSnowLine + uSnowBlend, altM + edgeN * uSnowBlend * 0.85)
            * smoothstep(0.50, 0.82, upness) * uSnowAmount;
float sandF = smoothstep(uSandLine + uSnowBlend * 0.4, uSandLine, altM + edgeN * 40.0)
            * smoothstep(0.72, 0.94, upness) * uSandAmount;
diffuseColor.rgb = mix(diffuseColor.rgb, uSandColor, clamp(sandF, 0.0, 1.0));
diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, clamp(snowF, 0.0, 1.0));
`;

const NORMAL_FS = /* glsl */`
{
  // Bump derivado da altura misturada (Mikkelsen, superfície não parametrizada):
  // dá relevo de centímetros sem custo de geometria nem de mapa de normais.
  vec3 sx = dFdx(vTriPos);
  vec3 sy = dFdy(vTriPos);
  float hx = dFdx(bumpH);
  float hy = dFdy(bumpH);
  vec3 sg = hx * cross(normal, sy) - hy * cross(normal, sx);
  normal = normalize(normal - sg * uBumpScale);
}
`;

const AERIAL_FS = /* glsl */`
{
  // ── Perspectiva aérea (ARCHITECTURE §8.2) ────────────────────────────────
  // Queda exponencial com a distância. Teto em 0,94: a montanha mais distante
  // ainda precisa se destacar do céu por uma sombra de contraste, senão o
  // horizonte vira uma parede de cor chapada e some a leitura de profundidade.
  float fogF = 1.0 - exp(-uFogDensity * vViewDist);
  fogF = clamp(fogF * uAerial, 0.0, 0.94);

  float mu = max(dot(-vViewW, uSunDir), 0.0);
  // Halo de Mie MODERADO. O ganho anterior chegava a 3,7x e ainda multiplicava
  // por uSunColor — mas o modulo sky ja entrega a radiância do horizonte com o sol
  // integrado, então o produto estourava para branco puro exatamente no
  // enquadramento das capturas do solo (câmera na direção do sol).
  vec3 fogCol = uFogColor * uFogGain * (0.90 + 0.60 * pow(mu, 6.0) + 0.16 * mu);

  // A névoa NUNCA pode ler como cinza nem como branco: reinjeta croma em torno
  // da própria luminância. É o MATIZ do céu que tem de sobreviver à distância.
  float fl = dot(fogCol, LUMA);
  fogCol = max(mix(vec3(fl), fogCol, uFogSat), vec3(0.0));

  // O terreno perde a SATURAÇÃO PRÓPRIA — puxar para a própria luminância baixa
  // o croma sem mexer no matiz — e só então recebe o matiz do céu pelo
  // espalhamento. Desbotar para um cinza neutro seria o erro clássico.
  float lum = dot(gl_FragColor.rgb, LUMA);
  vec3 desat = mix(gl_FragColor.rgb, vec3(lum), fogF * 0.50);
  gl_FragColor.rgb = mix(desat, fogCol, fogF);
}
`;

function inject(src, token, code, altToken) {
  if (src.indexOf(token) >= 0) return src.replace(token, token + '\n' + code);
  if (altToken && src.indexOf(altToken) >= 0) return src.replace(altToken, altToken + '\n' + code);
  return src;
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} biome  bioma já variado do corpo
 * @param {number} radius raio do datum
 */
export function createTerrainMaterial(ctx, biome, radius) {
  const sky = biome?.sky || {};
  const pal = biome?.palette || {};
  const terr = biome?.terrain || {};

  const tex = makeSurfaceTexture(((biome?.variantId || biome?.id || 'x').length * 7919) & 0xffff);
  const maxAniso = ctx?.engine?.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  tex.anisotropy = Math.min(8, maxAniso);

  const fogLin = hexToLinear(sky.fogColor !== undefined ? sky.fogColor : 0x9fb4d0);
  const snowLin = hexToLinear(pal.peak !== undefined ? pal.peak : 0xffffff);
  const sandLin = hexToLinear(pal.sand !== undefined ? pal.sand : 0xd8c69a);
  const amp = terr.amplitude || 2400;
  const cls = biome?.class;

  const uniforms = {
    uSurfTex: { value: tex },
    uPlanetOrigin: { value: new THREE.Vector3() },
    uPlanetRadius: { value: radius },
    // 1/2,4 m por repetição no detalhe fino; a escala macro fecha em ~5 km.
    uDetailScale: { value: 1 / 2.4 },
    uMacroScale: { value: 1 / 5200 },
    uFogColor: { value: new THREE.Color(fogLin[0], fogLin[1], fogLin[2]) },
    uFogDensity: { value: sky.fogDensity !== undefined ? sky.fogDensity : 5e-5 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.55).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
    uAerial: { value: 1 },
    uSnowLine: { value: cls === 'frozen' ? -amp * 0.4 : amp * 0.46 },
    uSnowBlend: { value: Math.max(60, amp * 0.16) },
    uSnowAmount: { value: cls === 'frozen' ? 0.95 : cls === 'lush' || cls === 'ocean' ? 0.55 : 0.25 },
    uSnowColor: { value: new THREE.Color(snowLin[0], snowLin[1], snowLin[2]) },
    uSandLine: { value: cls === 'barren' || cls === 'scorched' ? amp * 0.3 : 26 },
    uSandAmount: { value: (terr.seaLevel || 0) > 0.02 ? 0.7 : 0.35 },
    uSandColor: { value: new THREE.Color(sandLin[0], sandLin[1], sandLin[2]) },
    uBumpScale: { value: 0.85 },
    /** >1 empurra a névoa para longe do cinza sem mudar o matiz. */
    uFogSat: { value: 1.30 },
    /** Escala da radiância que `sky` publica; existe para poder domar um céu HDR. */
    uFogGain: { value: 1.0 },
    /** Uma camada sedimentar a cada ~19 m — escala de leitura humana. */
    uStrataFreq: { value: 1 / 19 },
    uStrataAmount: { value: cls === 'lush' || cls === 'ocean' ? 0.55 : 0.9 },
  };

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
    flatShading: false,
  });
  material.name = 'terrain';

  material.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 matmix;
varying vec4 vMatmix;
varying vec3 vTriPos;
varying vec3 vViewW;
varying float vViewDist;
varying vec3 vNrmW;
uniform vec3 uPlanetOrigin;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vNrmW = normalize(mat3(modelMatrix) * objectNormal);`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vMatmix = matmix;
vec3 wpT = (modelMatrix * vec4(transformed, 1.0)).xyz;
// Coordenada estável para o triplanar: espaço do PLANETA, imune ao rebase da
// origem flutuante — sem isso a textura escorrega a cada 2 km percorridos.
vTriPos = wpT - uPlanetOrigin;
vec3 toCamT = cameraPosition - wpT;
vViewDist = length(toCamT);
vViewW = toCamT / max(vViewDist, 1e-4);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON_FS);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <map_fragment>', MAP_FS);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', SNOW_FS);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <normal_fragment_maps>', NORMAL_FS, '#include <normal_fragment_begin>');
    shader.fragmentShader = inject(shader.fragmentShader, '#include <roughnessmap_fragment>', `
roughnessFactor = clamp(roughnessFactor * (0.88 + 0.26 * blendW.y - 0.30 * blendW.w) * (1.0 - 0.35 * snowF), 0.05, 1.0);`);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', AERIAL_FS, '#include <output_fragment>');

    material.userData.shader = shader;
  };

  // Chave de cache: garante que o programa não seja compartilhado com outro
  // MeshStandardMaterial comum do jogo (que não tem as nossas injeções).
  material.customProgramCacheKey = () => 'aether-terrain-v1';

  return {
    material,
    uniforms,
    texture: tex,
    /** Contrato com o módulo `sky` (ARCHITECTURE §6). */
    fogUniforms: {
      uFogColor: uniforms.uFogColor,
      uFogDensity: uniforms.uFogDensity,
      uSunDir: uniforms.uSunDir,
      uSunColor: uniforms.uSunColor,
      uAerial: uniforms.uAerial,
    },
    dispose() {
      tex.dispose();
      material.dispose();
    },
  };
}
