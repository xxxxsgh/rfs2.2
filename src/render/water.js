import * as THREE from 'three';
import { hashString, hash2f } from '../core/rng.js';
import { hexToLinear } from '../planet/biomes.js';
import { saturate, clamp, lerp } from '../noise/noise.js';

/**
 * ÁGUA — oceano ESFÉRICO no nível do mar do planeta.
 *
 * ── Por que uma casca esférica e não um plano ────────────────────────────────
 * Num planeta de 80–220 km de raio a curvatura é visível já a 1 km de distância:
 * um plano infinito produziria aquele horizonte reto que denuncia protótipo
 * (ARCHITECTURE §8.1). A malha é um disco polar adaptativo no plano TANGENTE à
 * projeção do jogador na esfera do nível do mar; o vertex shader dobra esse
 * disco sobre a esfera de forma numericamente estável. O raio do disco segue a
 * distância do horizonte (sqrt((R+h)²-R²)), então do solo ele cobre ~1,5 km e da
 * órbita baixa cobre o hemisfério visível inteiro — sempre com a mesma malha.
 *
 * ── Por que o disco é centrado no jogador e não no planeta ───────────────────
 * Densidade de vértices tem de cair com a distância. Um disco polar com raios
 * distribuídos em t² dá, de graça, centímetros perto da câmera e dezenas de
 * metros no horizonte, com UMA geometria estática (só um uniform de escala).
 * Zero rebuild de buffer por frame.
 *
 * ── Por que a fase das ondas é acumulada em float64 na CPU ───────────────────
 * Se o shader recebesse a coordenada absoluta de superfície (~1e5–1e6 m) em
 * float32, as ondas curtas ficariam em quantização grosseira e "nadariam"
 * quando a origem flutuante saltasse. Em vez disso, cada onda carrega uma fase
 * escalar acumulada em double (avançada pelo deslocamento tangencial do centro
 * do patch e pelo tempo) e o shader só soma k·dot(d, offsetLocal) — offsetLocal
 * é pequeno, logo exato. Resultado: ondas ancoradas ao mundo, sem deriva.
 *
 * ── Por que existe uma grade de batimetria própria ───────────────────────────
 * A absorção por profundidade e a espuma de costa precisam saber a profundidade
 * da coluna d'água por pixel. O caminho bonito é a profundidade da cena (via
 * ctx.postfx.requestSceneCopy()), mas ela pode não existir — e mesmo existindo,
 * ler o depth do alvo em que estamos escrevendo seria feedback. Então mantemos
 * duas grades (fina/grossa) amostradas de ctx.planet.sampleHeight() de forma
 * incremental sob ctx.budget. Elas garantem praias turquesa e linha de costa
 * corretas mesmo com o postfx ausente.
 */

export const id = 'water';
export const order = 45;
export const needs = ['planet'];

/** Número de ondas de Gerstner somadas. Mantido em sync com o #define do shader. */
const WAVES = 8;
const TAU = Math.PI * 2;

/** Estado do módulo. Um único objeto para facilitar o dispose e evitar globais soltas. */
const S = {
  ctx: null,
  enabled: false,
  ready: false,
  body: null,
  biome: null,
  seaRadius: 0,
  camAltitude: 0,
  forceOff: false,
  /** Vento de reserva por planeta, calculado uma vez (sem alocação por frame). */
  fallbackWindAngle: 0,
  fallbackWindSpeed: 8,

  group: null,
  mesh: null,
  material: null,
  geometry: null,

  // Grades de batimetria
  gridFine: null,
  gridCoarse: null,

  // Texturas procedurais
  detailTex: null,
  causticTex: null,

  // Submerso
  under: null,                 // { group, shells[], rays, particles, mats[] }
  isUnderwater: false,
  camDepth: 0,

  // Ondas (estado em float64)
  wave: [],                    // { k, amp, Q, phase, omega, angle, dir3: Vector3 }
  windDir3: null,              // THREE.Vector3 tangencial (mundo)
  windSpeed: 8,

  // Base tangente do patch (mundo)
  east: null, north: null, up: null,
  centerWorld: null,           // {x,y,z} double
  prevCenterWorld: null,

  // Temporários — nada é alocado no caminho quente
  t: null,

  quality: '',
  sceneCopy: { color: null, depth: null },
};

// ─────────────────────────────────────────────────────────────────────────────
// Shaders
// ─────────────────────────────────────────────────────────────────────────────

/** Trecho comum: soma de Gerstner analítica, usada no vértice e no fragmento. */
const GERSTNER_GLSL = /* glsl */`
uniform vec4 uWaveA[WAVES];   // xy = direção 2D (base do patch), z = k (rad/m), w = amplitude (m)
uniform vec2 uWaveB[WAVES];   // x = steepness Q, y = fase acumulada (rad)
uniform vec2 uWaveFade[WAVES];// x = início do fade (m), y = fim do fade (m)

/**
 * Avalia a soma de Gerstner em coordenadas tangentes t2 (metros, base do patch).
 * outDisp: deslocamento (x,y,z) no referencial tangente.
 * outNrm : normal não normalizada.
 * Retorna o jacobiano vertical (1 = plano, <0 = crista dobrando) — é dele que
 * sai a espuma de crista, sem precisar de textura de máscara.
 */
float gerstner(vec2 t2, float dist, float shallow, out vec3 outDisp, out vec3 outNrm) {
  outDisp = vec3(0.0);
  outNrm = vec3(0.0, 1.0, 0.0);
  float jac = 1.0;
  for (int i = 0; i < WAVES; i++) {
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].z;
    // Ondas curtas somem antes das longas: abaixo de ~2 texels elas viram
    // apenas ruído de aliasing, e o normal map procedural assume o papel.
    float fade = 1.0 - smoothstep(uWaveFade[i].x, uWaveFade[i].y, dist);
    float amp = uWaveA[i].w * fade * shallow;
    float Q = uWaveB[i].x;
    float ph = k * dot(d, t2) + uWaveB[i].y;
    float sn = sin(ph);
    float cs = cos(ph);
    float wa = k * amp;
    outDisp.xz += d * (Q * amp * cs);
    outDisp.y += amp * sn;
    outNrm.xz -= d * (wa * cs);
    outNrm.y -= Q * wa * sn;
    jac -= Q * wa * sn;
  }
  return jac;
}

/** Base tangente local sobre a esfera — as ondas vivem nela, não no plano do patch. */
void localFrame(vec3 up, out vec3 T, out vec3 B) {
  vec3 ref = abs(up.z) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  T = normalize(cross(up, ref));
  B = cross(T, up);
}
`;

const HEIGHTGRID_GLSL = /* glsl */`
uniform sampler2D uHeightF;
uniform sampler2D uHeightC;
uniform mat3 uGridRotF; uniform vec3 uGridOffF; uniform float uGridSpanF;
uniform mat3 uGridRotC; uniform vec3 uGridOffC; uniform float uGridSpanC;
uniform float uHasGrid;
uniform float uDefaultBed;

/**
 * Altura do leito relativa ao nível do mar (negativo = submerso).
 * A grade fina domina onde existe; fora dela cai suavemente na grossa para não
 * criar degrau visível na cor da água.
 */
float sampleBed(vec3 p) {
  if (uHasGrid < 0.5) return uDefaultBed;
  vec3 gc = uGridRotC * p + uGridOffC;
  vec2 uvC = gc.xz / (2.0 * uGridSpanC) + 0.5;
  float bed = texture2D(uHeightC, clamp(uvC, vec2(0.002), vec2(0.998))).r;
  vec3 gf = uGridRotF * p + uGridOffF;
  vec2 uvF = gf.xz / (2.0 * uGridSpanF) + 0.5;
  vec2 e = smoothstep(vec2(0.0), vec2(0.07), uvF) * (1.0 - smoothstep(vec2(0.93), vec2(1.0), uvF));
  float w = e.x * e.y;
  if (w > 0.001) bed = mix(bed, texture2D(uHeightF, clamp(uvF, vec2(0.001), vec2(0.999))).r, w);
  return bed;
}
`;

const WATER_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uSeaRadius;
uniform float uPatchRadius;
uniform vec3 uCamLocal;
uniform float uVertexFade;

${GERSTNER_GLSL}
${HEIGHTGRID_GLSL}

varying vec3 vPos;
varying vec2 vT2;
varying float vDist;
varying float vJac;
varying float vWaveY;
varying float vBed;
varying float vViewDepth;
varying vec3 vUp;

void main() {
  // Disco unitário -> plano tangente em metros.
  vec2 t2 = position.xz * uPatchRadius;
  float rr = dot(t2, t2);
  float u = rr / (uSeaRadius * uSeaRadius);
  float q = sqrt(1.0 + u);
  float s = 1.0 / q;
  // Forma estável do "afundamento" pela curvatura: R*(1/sqrt(1+u) - 1) sofreria
  // cancelamento catastrófico em float32 (dois números ~1.0 subtraídos).
  float drop = -uSeaRadius * u / (q * (q + 1.0));
  vec3 base = vec3(t2.x * s, drop, t2.y * s);

  vec3 up = normalize(base + vec3(0.0, uSeaRadius, 0.0));
  vec3 T, B;
  localFrame(up, T, B);

  float bed = sampleBed(base);
  // Ondas morrem na rebentação: sem isso a geometria atravessa a areia.
  float shallow = clamp(-bed / 7.0, 0.0, 1.0);
  shallow = shallow * shallow * (3.0 - 2.0 * shallow);

  float dist = distance(base, uCamLocal);
  // Longe demais, o deslocamento por vértice não paga o custo — só normal map.
  float gfade = 1.0 - smoothstep(uVertexFade * 0.5, uVertexFade, dist);

  vec3 disp, nrm;
  float jac = gerstner(t2, dist, shallow * gfade, disp, nrm);

  vec3 world = base + T * disp.x + up * disp.y + B * disp.z;

  vPos = world;
  vT2 = t2;
  vDist = dist;
  vJac = jac;
  vWaveY = disp.y;
  vBed = bed;
  vUp = up;

  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  vViewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
}
`;

const WATER_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>

// O prefixo de fragmento do three só declara viewMatrix/cameraPosition. Estas
// três são uniformes de objeto que o renderer preenche SE estiverem ativas no
// programa — declará-las aqui basta para o SSR e a refração funcionarem.
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

uniform float uSeaRadius;
uniform vec3 uCamLocal;
uniform vec3 uSunDir;          // já na base do patch
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uFoamColor;
uniform vec3 uBedColor;
uniform vec3 uExtinction;
uniform float uTime;
uniform float uFoamDepth;
uniform float uRefract;
uniform float uWindAmount;
uniform vec2 uWindDir2;
uniform vec2 uInvResolution;
uniform float uHasSceneColor;
uniform float uHasSceneDepth;
uniform float uHasEnv;
uniform float uLogDepth;
uniform float uLogDepthFC;
uniform float uNear;
uniform float uFar;
uniform float uCaustics;
uniform float uUnderFactor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uDetailTex;
uniform sampler2D uCausticTex;
uniform samplerCube uEnvCube;

${GERSTNER_GLSL}

varying vec3 vPos;
varying vec2 vT2;
varying float vDist;
varying float vJac;
varying float vWaveY;
varying float vBed;
varying float vViewDepth;
varying vec3 vUp;

/** Profundidade de vista (metros) a partir do valor bruto do depth buffer. */
float viewDepthOf(float d) {
  if (uLogDepth > 0.5) {
    // gl_FragDepth = log2(1 + w) * Fc * 0.5  =>  w = 2^(2d/Fc) - 1
    return exp2(d * 2.0 / max(uLogDepthFC, 1e-6)) - 1.0;
  }
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

/** Fresnel de Schlick real (F0 da água ≈ 0,02), com correção de rugosidade. */
vec3 fresnelSchlick(float cosT, float rough) {
  vec3 F0 = vec3(0.02);
  float f = pow(1.0 - cosT, 5.0);
  return F0 + (max(vec3(1.0 - rough), F0) - F0) * f;
}

/** GGX anisotrópico — o lóbulo alongado que vira "sun glitter" em vez de ponto. */
float ggxAniso(float nh, float th, float bh, float ax, float ay) {
  float d = th * th / (ax * ax) + bh * bh / (ay * ay) + nh * nh;
  return 1.0 / (PI * ax * ay * d * d + 1e-7);
}

/**
 * Céu analítico para reflexão: gradiente horizonte→zênite do bioma + disco solar
 * com sangramento. É o fallback quando não há IBL nem cópia da cena — e a base
 * sobre a qual o SSR é misturado.
 */
vec3 skyRadiance(vec3 dir, vec3 up) {
  float h = dot(dir, up);
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(saturate(h), 0.55));
  // Abaixo do horizonte a reflexão vê terra/névoa: escurece sem virar preto.
  c = mix(uSkyHorizon * 0.45, c, smoothstep(-0.12, 0.05, h));
  float sd = saturate(dot(dir, uSunDir));
  c += uSunColor * uSunIntensity * (pow(sd, 900.0) * 5.0 + pow(sd, 26.0) * 0.10);
  return c;
}

/** Normal de detalhe procedural animada (duas camadas cruzadas, sem tiling óbvio). */
vec3 detailNormal(vec2 p, float lod) {
  vec2 f1 = p * 0.085 + uWindDir2 * (uTime * 0.035);
  vec2 f2 = p * 0.031 - uWindDir2 * (uTime * 0.019) + vec2(0.37, 0.61);
  vec2 f3 = p * 0.24 + uWindDir2 * (uTime * 0.07);
  vec3 n1 = texture2D(uDetailTex, f1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uDetailTex, f2).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D(uDetailTex, f3).xyz * 2.0 - 1.0;
  vec3 n = n1 * 1.0 + n2 * 0.75 + n3 * (0.55 * lod);
  n.xz *= uWindAmount;
  return normalize(vec3(n.x, 1.6, n.z));
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 up = normalize(vUp);
  vec3 T, B;
  localFrame(up, T, B);

  vec3 V = uCamLocal - vPos;
  float viewLen = length(V);
  V /= max(viewLen, 1e-4);

  // ── Normal: reavalia Gerstner por pixel (a malha é grossa longe da câmera) ──
  float shallow = clamp(-vBed / 7.0, 0.0, 1.0);
  shallow = shallow * shallow * (3.0 - 2.0 * shallow);
  vec3 dispF, nrmF;
  float jacF = gerstner(vT2, vDist, shallow, dispF, nrmF);
  vec3 nWave = normalize(nrmF);

  // O normal map assume o papel da onda geométrica no meio-campo, mas TEM de
  // desaparecer no fundo: um normal ruidoso a 2 km derruba o Fresnel rasante e
  // pinta uma faixa escura no horizonte (além de aliasing puro). Longe, a
  // superfície volta a ser plana e a variância vira RUGOSIDADE, não inclinação.
  float lodFar = saturate(vDist / 900.0);
  float flatFar = saturate((vDist - 400.0) / 3200.0);
  vec3 nDet = detailNormal(vT2, 1.0 - lodFar * 0.6);
  float detailMix = mix(0.95, 0.06, flatFar * flatFar) * shallow;
  vec3 nT = normalize(mix(nWave, normalize(nWave + vec3(nDet.x, 0.0, nDet.z) * 1.15), detailMix));

  vec3 N = normalize(T * nT.x + up * nT.y + B * nT.z);
  bool underside = !gl_FrontFacing;
  if (underside) N = -N;

  float ndv = saturate(dot(N, V));

  // ── Profundidade: cena (preciso) com fallback na batimetria assada ─────────
  vec2 uvs = gl_FragCoord.xy * uInvResolution;
  float depthVert = max(0.0, -vBed - vWaveY);              // coluna vertical (m)
  float cosUp = max(0.12, abs(dot(V, up)));
  float sceneD = vViewDepth + depthVert / cosUp;
  if (uHasSceneDepth > 0.5) {
    float raw = texture2D(uSceneDepth, uvs).x;
    float d = viewDepthOf(raw);
    // Céu (depth máximo) vira "fundo infinito", não uma parede colada.
    sceneD = (d > uFar * 0.9) ? vViewDepth + 4000.0 : d;
  }
  float thickness = max(0.0, sceneD - vViewDepth);
  float depthDiff = uHasSceneDepth > 0.5 ? thickness * cosUp : depthVert;

  // ── Refração ───────────────────────────────────────────────────────────────
  vec3 nView = normalize(normalMatrix * N);
  vec2 refrOff = nView.xy * uRefract * min(thickness, 40.0) / max(vViewDepth, 1.0);
  refrOff *= 1.0 - lodFar * 0.7;
  vec2 uvr = clamp(uvs + refrOff, vec2(0.002), vec2(0.998));

  float dPath = thickness;
  vec3 bottom;
  if (uHasSceneColor > 0.5) {
    float rawR = texture2D(uSceneDepth, uvr).x;
    float dR = uHasSceneDepth > 0.5 ? viewDepthOf(rawR) : sceneD;
    // Rejeita a amostra deslocada se ela está À FRENTE da água: é o artefato
    // clássico de "objeto fora d'água vazando para dentro da refração".
    if (dR < vViewDepth) { uvr = uvs; dR = sceneD; }
    bottom = texture2D(uSceneColor, uvr).rgb;
    dPath = max(0.0, dR - vViewDepth);
  } else {
    // Sem cópia da cena: sintetiza o leito a partir da paleta do bioma.
    float sandy = 1.0 - saturate(depthVert / 26.0);
    bottom = uBedColor * mix(0.45, 1.0, sandy);
    dPath = depthVert / cosUp;
  }

  // ── Cáusticas no fundo raso ───────────────────────────────────────────────
  if (uCaustics > 0.0) {
    vec2 cuv = (vT2 + nT.xz * (dPath * 0.35)) * 0.06;
    float ca = texture2D(uCausticTex, cuv + vec2(uTime * 0.013, uTime * -0.009)).r;
    float cb = texture2D(uCausticTex, cuv * 1.71 - vec2(uTime * 0.017, uTime * 0.011)).g;
    float caus = pow(saturate(ca * cb * 2.6), 2.2);
    float atten = exp(-depthVert * 0.11) * saturate(dot(uSunDir, up));
    bottom += uSunColor * uSunIntensity * caus * atten * uCaustics;
  }

  // ── Absorção exponencial: a assinatura da praia turquesa translúcida ───────
  vec3 trans = exp(-uExtinction * dPath);
  vec3 body = mix(uWaterShallow, uWaterDeep, 1.0 - exp(-dPath * 0.035));
  // Radiância retro-espalhada ≈ albedo · irradiância / π; o fator 0.32 evita que
  // o oceano estoure em branco quando sunIntensity é alto (HDR pré-tonemap).
  vec3 scattered = body * uSunIntensity * 0.5 * mix(0.35, 1.0, saturate(dot(uSunDir, up) * 1.4));
  vec3 refracted = bottom * trans + scattered * (1.0 - trans);

  // ── Reflexão: SSR barato sobre céu analítico / IBL ────────────────────────
  vec3 R = reflect(-V, N);
  vec3 reflCol = skyRadiance(R, up);
  if (uHasEnv > 0.5) {
    // O IBL do engine vive em espaço de mundo; o patch está rotacionado, mas a
    // diferença é irrelevante para um lóbulo tão largo — vale mais a coerência
    // de cor com o resto da cena.
    reflCol = mix(reflCol, textureCube(uEnvCube, R).rgb, 0.6);
  }
  if (uHasSceneColor > 0.5 && uHasSceneDepth > 0.5 && !underside) {
    // SSR: 6 passos em espaço de vista. Barato, e desvanece nas bordas da tela
    // em vez de deixar "buraco preto" — o artefato que denuncia SSR ingênuo.
    vec3 pv = (modelViewMatrix * vec4(vPos, 1.0)).xyz;
    vec3 rv = normalize(normalMatrix * R);
    float step0 = mix(0.6, 24.0, saturate(vViewDepth / 300.0));
    vec3 hitCol = vec3(0.0);
    float hitW = 0.0;
    vec3 sp = pv;
    for (int i = 0; i < 6; i++) {
      sp += rv * (step0 * float(i + 1));
      vec4 cp = projectionMatrix * vec4(sp, 1.0);
      if (cp.w <= 0.0) break;
      vec2 su = cp.xy / cp.w * 0.5 + 0.5;
      if (su.x < 0.01 || su.x > 0.99 || su.y < 0.01 || su.y > 0.99) break;
      float sd = viewDepthOf(texture2D(uSceneDepth, su).x);
      float sampleDepth = -sp.z;
      if (sd < sampleDepth && sampleDepth - sd < step0 * 6.0 && sd > vViewDepth + 0.05) {
        // Desvanece perto da borda da tela para não aparecer costura.
        vec2 edge = smoothstep(vec2(0.0), vec2(0.14), su) * (1.0 - smoothstep(vec2(0.86), vec2(1.0), su));
        hitCol = texture2D(uSceneColor, su).rgb;
        hitW = edge.x * edge.y;
        break;
      }
    }
    reflCol = mix(reflCol, hitCol, hitW * 0.85);
  }

  // ── Fresnel + glitter solar ───────────────────────────────────────────────
  float rough = mix(0.035, 0.34, saturate(vDist / 2600.0)) * mix(0.6, 1.4, uWindAmount);
  vec3 F = fresnelSchlick(ndv, rough);

  vec3 L = uSunDir;
  vec3 H = normalize(V + L);
  float nh = saturate(dot(N, H));
  // Anisotropia alinhada ao vento: a trilha do sol é uma FAIXA, não um ponto.
  vec3 aT = normalize(T * uWindDir2.x + B * uWindDir2.y);
  vec3 aB = cross(N, aT);
  float ax = max(0.004, rough * rough * 0.55);
  float ay = max(0.004, rough * rough * 2.6);
  float D = ggxAniso(nh, dot(aT, H), dot(aB, H), ax, ay);
  float ndl = saturate(dot(N, L));
  float G = 0.25 / max(0.05, ndv + ndl - ndv * ndl);
  vec3 spec = uSunColor * uSunIntensity * D * G * ndl * F * 1.6;

  // ── Sub-surface scattering: cristas translúcidas em contraluz ─────────────
  // Só a parte da onda ACIMA do nível médio espalha luz por trás — é o que dá
  // aquele verde-limão translúcido nas cristas quando o sol está do outro lado.
  float crest = saturate(vWaveY * 0.85);
  float back = pow(saturate(dot(V, -L) * 0.5 + 0.5), 5.0);
  vec3 sss = uWaterShallow * uSunColor * uSunIntensity * back * crest * 0.9 * saturate(1.0 - lodFar);

  // ── Composição ────────────────────────────────────────────────────────────
  float Fs = clamp(dot(F, vec3(0.333)), 0.0, 1.0);
  vec3 col = mix(refracted, reflCol, Fs) + spec + sss;

  // ── ESPUMA ────────────────────────────────────────────────────────────────
  // Costa: derivada da diferença de profundidade, mas quebrada por dois ruídos
  // animados com distorção pela própria normal — nunca uma linha branca lisa.
  float shore = 1.0 - saturate(depthDiff / uFoamDepth);
  vec2 fuv = vT2 * 0.055 + nT.xz * 0.85 + vec2(uTime * 0.018, uTime * -0.012);
  vec2 fuv2 = vT2 * 0.19 - nT.xz * 0.45 + vec2(uTime * -0.031, uTime * 0.024);
  float fn = texture2D(uCausticTex, fuv).b;
  float fn2 = texture2D(uDetailTex, fuv2).w;
  float breakup = (fn * 0.6 + fn2 * 0.4);
  float foamShore = smoothstep(0.34, 0.86, shore * 1.35 + (breakup - 0.5) * 0.95);
  // Recuo/avanço da espuma: a linha de costa respira com a onda longa.
  foamShore *= smoothstep(-0.25, 0.35, sin(uTime * 0.55 + vT2.x * 0.02 + vT2.y * 0.017) * 0.5 + shore);
  // Crista: onde o jacobiano de Gerstner dobra, a onda quebra.
  float foamCrest = smoothstep(0.42, 0.02, jacF) * (0.35 + 0.65 * breakup);
  float foam = saturate(max(foamShore, foamCrest * 0.9)) * saturate(1.0 - lodFar * 0.35);
  col = mix(col, uFoamColor * (0.55 + 0.65 * uSunIntensity * max(0.25, ndl)), foam);

  // ── Perspectiva aérea ─────────────────────────────────────────────────────
  // ShaderMaterial não recebe o fog da cena. Sem isto o oceano encosta no céu
  // com uma linha dura — exatamente o sinal nº 2 da lista do crítico (§8).
  float aer = 1.0 - exp(-vDist * uFogDensity);
  aer *= 1.0 - saturate(dot(V, up)) * 0.75;   // olhando para baixo quase não há
  col = mix(col, uFogColor, saturate(aer));

  // ── Alfa ──────────────────────────────────────────────────────────────────
  float alpha;
  if (uHasSceneColor > 0.5) {
    alpha = 1.0;                       // a refração já traz o fundo
  } else {
    float ab = 1.0 - exp(-dPath * 0.22);
    alpha = saturate(max(max(ab, Fs * 1.4), foam));
    alpha = max(alpha, 0.06);
  }

  // ── Visto por baixo: reflexão interna total + janela de Snell ─────────────
  if (underside) {
    float cosc = 0.6614;               // cos(48.6°) — ângulo crítico água/ar
    float w = smoothstep(cosc - 0.18, cosc + 0.06, ndv);
    vec3 inner = uWaterDeep * (0.35 + 0.65 * uSunIntensity * 0.2);
    // Fora da janela de Snell a superfície é um espelho: reflexão interna total.
    vec3 rf = refract(-V, N, 1.333);
    if (dot(rf, rf) < 1e-6) rf = reflect(-V, N);
    vec3 windowCol = skyRadiance(rf, up) * 1.15;
    col = mix(inner, windowCol, w);
    col += spec * w * 0.5;
    col = mix(col, uFoamColor * 0.7, foam * 0.5);
    alpha = mix(0.92, 0.45, w);
  }

  gl_FragColor = vec4(col, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shaders do modo submerso
// ─────────────────────────────────────────────────────────────────────────────

const FOG_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FOG_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform vec3 uUp;
uniform float uAlpha;
uniform float uSurface;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  // Mais claro na direção da superfície: dá a leitura de "para cima é onde tem luz".
  float h = dot(vDir, uUp) * 0.5 + 0.5;
  vec3 c = uColor * mix(0.35, 1.6, pow(h, 1.6)) * uSurface;
  gl_FragColor = vec4(c, uAlpha);
}
`;

const RAY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const RAY_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uTime;
uniform float uIntensity;
uniform float uHalf;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  float a = atan(vLocal.z, vLocal.x);
  // Feixes: soma de senóides incomensuráveis -> padrão não repetitivo barato.
  float s = sin(a * 7.0 + uTime * 0.21) * 0.5 + 0.5;
  s *= sin(a * 13.0 - uTime * 0.13) * 0.5 + 0.5;
  s *= sin(a * 3.0 + uTime * 0.07) * 0.5 + 0.5;
  s = pow(s, 1.7);
  // Some no topo (onde nasce) e na base (onde a água engole).
  float t = vLocal.y / uHalf * 0.5 + 0.5;
  float fade = smoothstep(0.0, 0.35, t) * (1.0 - smoothstep(0.55, 1.0, t));
  gl_FragColor = vec4(uColor * s * fade * uIntensity, 1.0);
}
`;

const MOTE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uWrap;
uniform float uBox;
uniform float uTime;
uniform float uSize;
varying float vFade;
void main() {
  // Partículas ficam presas ao MUNDO (via uWrap) e apenas se repetem em torno
  // da câmera — sem custo de CPU e sem a sensação de "neve colada na tela".
  vec3 p = mod(position - uWrap, vec3(uBox));
  p -= uBox * 0.5;
  p.y += sin(uTime * 0.35 + position.x * 0.7) * 0.25;
  p.x += cos(uTime * 0.27 + position.z * 0.6) * 0.2;
  float d = length(p);
  vFade = (1.0 - smoothstep(uBox * 0.18, uBox * 0.5, d));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(1.0, -mv.z) * 40.0;
  #include <logdepthbuf_vertex>
}
`;

const MOTE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float a = (1.0 - smoothstep(0.15, 0.5, length(c))) * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * 0.55);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Texturas procedurais (nenhum asset binário — ARCHITECTURE §2.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Value noise 2D PERIÓDICO — tileável por construção, muito mais barato que simplex. */
function pnoise(x, y, per, salt) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => ((a % b) + b) % b;
  const a = hash2f(w(xi, per), w(yi, per), salt);
  const b = hash2f(w(xi + 1, per), w(yi, per), salt);
  const c = hash2f(w(xi, per), w(yi + 1, per), salt);
  const d = hash2f(w(xi + 1, per), w(yi + 1, per), salt);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function pfbm(x, y, per, salt, oct = 4) {
  let sum = 0, amp = 1, norm = 0, p = per, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(x * f, y * f, p, salt + i * 977);
    norm += amp;
    amp *= 0.5; f *= 2; p *= 2;
  }
  return sum / norm;
}

/** Worley periódico (F1) para as cáusticas e as manchas de espuma. */
function pworley(x, y, cells, salt) {
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let f1 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx, gy = cy + dy;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = (gx + hash2f(wx, wy, salt)) / cells;
      const py = (gy + hash2f(wx, wy, salt + 31)) / cells;
      const ddx = px - x, ddy = py - y;
      const d = ddx * ddx + ddy * ddy;
      if (d < f1) f1 = d;
    }
  }
  return Math.sqrt(f1) * cells;
}

/** Normal map de ripples + máscara de espuma fina (RGB = normal, A = espuma). */
function makeDetailTexture(size, salt) {
  const data = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = pfbm(x * inv * 6, y * inv * 6, 6, salt, 4);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = (h[y * size + xp] - h[y * size + xm]) * 3.2;
      const dy = (h[yp * size + x] - h[ym * size + x]) * 3.2;
      // Normal tangente com Y para cima (convenção do shader: xz = inclinação).
      let nx = -dx, ny = 1, nz = -dy;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = Math.round(saturate(pfbm(x * inv * 11, y * inv * 11, 11, salt + 4441, 3)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Cáusticas (R,G em duas escalas), manchas de espuma (B) e ruído celular (A). */
function makeCausticTexture(size, salt) {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const w1 = pworley(u, v, 8, salt);
      const w2 = pworley(u, v, 13, salt + 101);
      // Cáustica = crista fina na fronteira das células (1 - f1)^k.
      const c1 = Math.pow(saturate(1 - w1), 5);
      const c2 = Math.pow(saturate(1 - w2), 4);
      const blot = saturate(pfbm(u * 5, v * 5, 5, salt + 777, 4) * 1.25 - 0.1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(saturate(c1) * 255);
      data[i + 1] = Math.round(saturate(c2) * 255);
      data[i + 2] = Math.round(blot * 255);
      data[i + 3] = Math.round(saturate(w2 * 0.9) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometria: disco polar adaptativo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Disco unitário em coordenadas de plano tangente. Os raios crescem com t² para
 * concentrar vértices perto da câmera; o raio real vem do uniform uPatchRadius,
 * então a mesma geometria serve do solo à órbita.
 */
function buildDisc(rings, segments) {
  const vertCount = 1 + rings * segments;
  const pos = new Float32Array(vertCount * 3);
  // Centro
  pos[0] = 0; pos[1] = 0; pos[2] = 0;
  let p = 3;
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const r = t * t;
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * TAU;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }
  const triCount = segments + (rings - 1) * segments * 2;
  const idx = vertCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let k = 0;
  // Winding escolhido para que a normal geométrica aponte para +Y (fora do
  // planeta): é disso que `gl_FrontFacing` depende para detectar "visto por
  // baixo" e ativar a reflexão interna total.
  for (let j = 0; j < segments; j++) {
    idx[k++] = 0;
    idx[k++] = 1 + ((j + 1) % segments);
    idx[k++] = 1 + j;
  }
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segments;
    const b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      idx[k++] = a0 + j; idx[k++] = b0 + j1; idx[k++] = b0 + j;
      idx[k++] = a0 + j; idx[k++] = a0 + j1; idx[k++] = b0 + j1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // O vertex shader move tudo; culling por bounding sphere seria errado.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade de batimetria incremental
// ─────────────────────────────────────────────────────────────────────────────

function makeGrid(size, span) {
  const half = new Uint16Array(size * size * 4);
  const tex = new THREE.DataTexture(half, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return {
    size, span,
    tex,
    half,
    scratch: new Float32Array(size * size),
    // Base e centro válidos para os dados JÁ publicados na textura.
    east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
    center: { x: 0, y: 0, z: 0 },
    // Base e centro do bake em andamento.
    bakeEast: new THREE.Vector3(1, 0, 0),
    bakeNorth: new THREE.Vector3(0, 0, 1),
    bakeUp: new THREE.Vector3(0, 1, 0),
    bakeCenter: { x: 0, y: 0, z: 0 },
    row: -1,            // -1 = ocioso
    valid: false,
    rot: new THREE.Matrix3(),
    off: new THREE.Vector3(),
  };
}

/** Inicia um bake da grade centrado em `center` com a base tangente atual. */
function startBake(grid, center, east, north, up, span) {
  grid.bakeCenter.x = center.x; grid.bakeCenter.y = center.y; grid.bakeCenter.z = center.z;
  grid.bakeEast.copy(east); grid.bakeNorth.copy(north); grid.bakeUp.copy(up);
  grid.span = span;
  grid.row = 0;
}

/**
 * Processa linhas da grade enquanto houver orçamento. Nunca excede o budget do
 * frame — é isto que impede o travamento ao pousar num planeta oceânico.
 */
function stepBake(grid, ctx, body, seaRadius, maxRows) {
  if (grid.row < 0) return;
  const size = grid.size;
  const span = grid.span;
  const sample = ctx.planet?.sampleHeight;
  if (typeof sample !== 'function') { grid.row = -1; return; }
  const t = S.t;
  const cx = grid.bakeCenter.x, cy = grid.bakeCenter.y, cz = grid.bakeCenter.z;
  const pc = body.center;
  let rows = 0;
  while (grid.row < size && rows < maxRows && ctx.budget.canWork()) {
    const y = grid.row;
    const fy = (y / (size - 1) - 0.5) * 2 * span;
    const base = y * size;
    for (let x = 0; x < size; x++) {
      const fx = (x / (size - 1) - 0.5) * 2 * span;
      // Ponto no plano tangente -> direção unitária a partir do centro do planeta.
      t.dir.set(
        cx - pc.x + grid.bakeEast.x * fx + grid.bakeNorth.x * fy,
        cy - pc.y + grid.bakeEast.y * fx + grid.bakeNorth.y * fy,
        cz - pc.z + grid.bakeEast.z * fx + grid.bakeNorth.z * fy,
      ).normalize();
      let h = 0;
      try { h = sample.call(ctx.planet, t.dir) || 0; } catch (e) { h = 0; }
      // Altura do leito RELATIVA ao nível do mar (negativo = submerso).
      grid.scratch[base + x] = clamp(body.radius + h - seaRadius, -3000, 3000);
    }
    grid.row++;
    rows++;
  }
  if (grid.row >= size) {
    const half = grid.half;
    for (let i = 0, n = size * size; i < n; i++) {
      half[i * 4] = THREE.DataUtils.toHalfFloat(grid.scratch[i]);
    }
    grid.tex.needsUpdate = true;
    grid.center.x = grid.bakeCenter.x; grid.center.y = grid.bakeCenter.y; grid.center.z = grid.bakeCenter.z;
    grid.east.copy(grid.bakeEast); grid.north.copy(grid.bakeNorth); grid.up.copy(grid.bakeUp);
    grid.valid = true;
    grid.row = -1;
  }
}

/**
 * Matriz que leva coordenadas locais do patch para coordenadas locais da grade.
 * Sem isso, a grade "gira" junto com a base tangente e a linha de costa desliza.
 */
function updateGridTransform(grid) {
  const t = S.t;
  t.mA.set(
    grid.east.x, grid.up.x, grid.north.x,
    grid.east.y, grid.up.y, grid.north.y,
    grid.east.z, grid.up.z, grid.north.z,
  );
  t.mA.transpose();                                   // base da grade -> mundo, invertida
  t.mB.set(
    S.east.x, S.up.x, S.north.x,
    S.east.y, S.up.y, S.north.y,
    S.east.z, S.up.z, S.north.z,
  );
  grid.rot.multiplyMatrices(t.mA, t.mB);
  t.v1.set(
    S.centerWorld.x - grid.center.x,
    S.centerWorld.y - grid.center.y,
    S.centerWorld.z - grid.center.z,
  );
  grid.off.copy(t.v1).applyMatrix3(t.mA);
}

// ─────────────────────────────────────────────────────────────────────────────
// Espectro de ondas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deriva o espectro a partir da velocidade do vento. Comprimento e amplitude
 * seguem a relação de mar totalmente desenvolvido (L ∝ v²), o que faz brisa dar
 * marolas e tempestade dar vagalhões sem nenhum parâmetro mágico extra.
 */
function buildSpectrum(ctx, seedTag) {
  const v = clamp(S.windSpeed, 0.6, 42);
  const L0 = clamp(7 + v * v * 0.62, 9, 240);
  const A0 = clamp(0.011 * v * v, 0.035, 5.2);
  S.wave.length = 0;
  for (let i = 0; i < WAVES; i++) {
    const r = ctx.rng.derive(seedTag, i);
    const L = L0 * Math.pow(0.615, i) * r.range(0.82, 1.24);
    const k = TAU / L;
    const amp = A0 * Math.pow(0.71, i) * r.range(0.75, 1.25);
    // Ondas longas vêm quase alinhadas com o vento; as curtas espalham muito.
    const spread = lerp(0.22, 1.15, i / (WAVES - 1));
    const angle = r.range(-spread, spread);
    // Gravidade "de jogo": ω = sqrt(g·k) mantém a dispersão fisicamente correta.
    const omega = Math.sqrt(9.81 * k);
    S.wave.push({
      k, amp, omega, angle,
      Q: 0,
      phase: r.range(0, TAU),
      dir3: new THREE.Vector3(1, 0, 0),
      dir2x: 1, dir2z: 0,
    });
  }
  // Normaliza a steepness total: Σ Q·k·A acima de ~1 faz as Gerstner formarem
  // laços e a malha se auto-intersectar (o artefato de "água com nó").
  const target = 0.92;
  for (let i = 0; i < WAVES; i++) {
    const w = S.wave[i];
    const ka = w.k * w.amp;
    // Cada onda contribui a mesma fatia da steepness total.
    w.Q = ka > 1e-6 ? clamp(target / (WAVES * ka), 0, 0.85) : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares de contexto (tudo opcional — CONTRATO §6 com fallback)
// ─────────────────────────────────────────────────────────────────────────────

function readWind(ctx, out) {
  const w = ctx.weather;
  if (!w) return false;
  const cand = w.wind ?? w.windVector ?? w.state?.wind ?? null;
  if (cand && typeof cand.x === 'number' && typeof cand.z === 'number') {
    out.set(cand.x, cand.y ?? 0, cand.z);
    if (out.lengthSq() > 1e-8) return true;
  }
  const dir = cand?.direction ?? w.windDirection ?? null;
  if (dir && typeof dir.x === 'number') {
    out.set(dir.x, dir.y ?? 0, dir.z);
    const sp = cand?.speed ?? w.windSpeed ?? 8;
    if (out.lengthSq() > 1e-8) { out.normalize().multiplyScalar(sp); return true; }
  }
  return false;
}

function linColor(hex, out) {
  const l = hexToLinear(hex >>> 0);
  return out.setRGB(l[0], l[1], l[2]);
}

/** Aceita qualquer formato plausível de retorno de postfx.requestSceneCopy(). */
function normalizeSceneCopy(res, ctx) {
  const out = S.sceneCopy;
  out.color = null; out.depth = null;
  if (!res) return out;
  const bad = ctx.engine.sceneTarget;
  const take = (t) => (t && t.isTexture && t !== bad.texture && t !== bad.depthTexture ? t : null);
  if (res.isTexture) { out.color = take(res); return out; }
  if (res.isWebGLRenderTarget || res.isRenderTarget) {
    out.color = take(res.texture); out.depth = take(res.depthTexture); return out;
  }
  out.color = take(res.color) || take(res.texture) || take(res.colorTexture);
  out.depth = take(res.depth) || take(res.depthTexture);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Submerso
// ─────────────────────────────────────────────────────────────────────────────

function buildUnderwater(ctx, quality) {
  const group = new THREE.Group();
  group.name = 'water:underwater';
  group.visible = false;
  group.frustumCulled = false;

  // Cascas concêntricas: N camadas transparentes aproximam névoa exponencial e,
  // ao contrário de uma cor chapada, deixam a geometria intermediária ocluir.
  const shellCount = quality === 'low' ? 4 : quality === 'medium' ? 5 : 7;
  const shells = [];
  const shellGeo = new THREE.SphereGeometry(1, 24, 14);
  for (let i = 0; i < shellCount; i++) {
    const r = 5 * Math.pow(900 / 5, i / (shellCount - 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: FOG_VERT,
      fragmentShader: FOG_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0.02, 0.13, 0.2) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uAlpha: { value: 0.2 },
        uSurface: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      blending: THREE.NormalBlending,
    });
    const m = new THREE.Mesh(shellGeo, mat);
    m.scale.setScalar(r);
    m.frustumCulled = false;
    m.renderOrder = 40 + (shellCount - i);   // de fora para dentro
    m.userData.radius = r;
    group.add(m);
    shells.push(m);
  }

  // Godrays: cilindro aberto alinhado ao sol, aditivo.
  const rayGeo = new THREE.CylinderGeometry(70, 70, 520, 28, 1, true);
  const rayMat = new THREE.ShaderMaterial({
    vertexShader: RAY_VERT,
    fragmentShader: RAY_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(0.4, 0.85, 1.0) },
      uTime: { value: 0 },
      uIntensity: { value: 0.5 },
      uHalf: { value: 260 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const rays = new THREE.Mesh(rayGeo, rayMat);
  rays.frustumCulled = false;
  rays.renderOrder = 60;
  group.add(rays);

  // Partículas em suspensão — posições determinísticas (ARCHITECTURE §2.1).
  const count = quality === 'low' ? 500 : quality === 'medium' ? 1100 : 2000;
  const box = 26;
  const pos = new Float32Array(count * 3);
  const prng = ctx.rng.derive('water-motes', 0);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = prng.float() * box;
    pos[i * 3 + 1] = prng.float() * box;
    pos[i * 3 + 2] = prng.float() * box;
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const pmat = new THREE.ShaderMaterial({
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    uniforms: {
      uWrap: { value: new THREE.Vector3() },
      uBox: { value: box },
      uTime: { value: 0 },
      uSize: { value: 1.6 },
      uColor: { value: new THREE.Color(0.8, 0.95, 1.0) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  const particles = new THREE.Points(pgeo, pmat);
  particles.frustumCulled = false;
  particles.renderOrder = 61;
  group.add(particles);

  return { group, shells, rays, particles, shellGeo, rayGeo, pgeo, box };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ─────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;
  S.quality = ctx.quality?.preset || 'high';

  S.t = {
    v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    dir: new THREE.Vector3(), sun: new THREE.Vector3(), wind: new THREE.Vector3(),
    q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
    mA: new THREE.Matrix3(), mB: new THREE.Matrix3(), m4: new THREE.Matrix4(),
    col: new THREE.Color(), white: new THREE.Color(1, 1, 1), size: new THREE.Vector2(),
    cam: { x: 0, y: 0, z: 0 },
    surf: { x: 0, y: 0, z: 0 },
  };
  S.east = new THREE.Vector3(1, 0, 0);
  S.north = new THREE.Vector3(0, 0, 1);
  S.up = new THREE.Vector3(0, 1, 0);
  S.windDir3 = new THREE.Vector3(1, 0, 0);
  S.centerWorld = { x: 0, y: 0, z: 0 };
  S.prevCenterWorld = { x: 0, y: 0, z: 0 };

  ctx.progress?.(0.0, 'gerando texturas de água…');
  const salt = hashString(String(ctx.seed) + ':water') >>> 0;
  S.detailTex = makeDetailTexture(S.quality === 'low' ? 64 : 128, salt);
  // Cede o frame: duas texturas 128² seguidas passariam de 4 ms.
  await new Promise((r) => requestAnimationFrame(r));
  S.causticTex = makeCausticTexture(S.quality === 'low' ? 64 : 128, salt ^ 0x5bf03635);

  // Geometria
  const rings = S.quality === 'ultra' ? 128 : S.quality === 'high' ? 100 : S.quality === 'medium' ? 76 : 52;
  const segs = S.quality === 'ultra' ? 192 : S.quality === 'high' ? 144 : S.quality === 'medium' ? 112 : 80;
  S.geometry = buildDisc(rings, segs);

  const gridSize = S.quality === 'low' ? 48 : 64;
  S.gridFine = makeGrid(gridSize, 500);
  S.gridCoarse = makeGrid(gridSize, 6000);

  const waveA = [];
  const waveB = [];
  const waveFade = [];
  for (let i = 0; i < WAVES; i++) {
    waveA.push(new THREE.Vector4(1, 0, 0.1, 0));
    waveB.push(new THREE.Vector2(0, 0));
    waveFade.push(new THREE.Vector2(1e9, 1e9));
  }

  S.material = new THREE.ShaderMaterial({
    name: 'AetherWater',
    defines: { WAVES: WAVES },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uSeaRadius: { value: 1e5 },
      uPatchRadius: { value: 2000 },
      uCamLocal: { value: new THREE.Vector3() },
      uVertexFade: { value: 2500 },
      uWaveA: { value: waveA },
      uWaveB: { value: waveB },
      uWaveFade: { value: waveFade },
      uHeightF: { value: S.gridFine.tex },
      uHeightC: { value: S.gridCoarse.tex },
      uGridRotF: { value: new THREE.Matrix3() },
      uGridOffF: { value: new THREE.Vector3() },
      uGridSpanF: { value: S.gridFine.span },
      uGridRotC: { value: new THREE.Matrix3() },
      uGridOffC: { value: new THREE.Vector3() },
      uGridSpanC: { value: S.gridCoarse.span },
      uHasGrid: { value: 0 },
      uDefaultBed: { value: -400 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uSunIntensity: { value: 1 },
      uSkyZenith: { value: new THREE.Color(0.1, 0.3, 0.8) },
      uSkyHorizon: { value: new THREE.Color(0.8, 0.85, 1) },
      uWaterShallow: { value: new THREE.Color(0.05, 0.5, 0.6) },
      uWaterDeep: { value: new THREE.Color(0.01, 0.08, 0.16) },
      uFoamColor: { value: new THREE.Color(1, 1, 1) },
      uBedColor: { value: new THREE.Color(0.6, 0.55, 0.4) },
      uExtinction: { value: new THREE.Vector3(0.32, 0.09, 0.045) },
      uTime: { value: 0 },
      uFoamDepth: { value: 1.5 },
      uRefract: { value: 0.5 },
      uWindAmount: { value: 1 },
      uWindDir2: { value: new THREE.Vector2(1, 0) },
      uInvResolution: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uHasSceneColor: { value: 0 },
      uHasSceneDepth: { value: 0 },
      uHasEnv: { value: 0 },
      uLogDepth: { value: ctx.engine.renderer.capabilities.logarithmicDepthBuffer ? 1 : 0 },
      uLogDepthFC: { value: 2 / (Math.log(ctx.engine.camera.far + 1) / Math.LN2) },
      uNear: { value: ctx.engine.camera.near },
      uFar: { value: ctx.engine.camera.far },
      uCaustics: { value: 1 },
      uUnderFactor: { value: 0 },
      uFogColor: { value: new THREE.Color(0.5, 0.7, 1) },
      uFogDensity: { value: 0.00005 },
      uSceneColor: { value: S.detailTex },
      uSceneDepth: { value: S.detailTex },
      uDetailTex: { value: S.detailTex },
      uCausticTex: { value: S.causticTex },
      uEnvCube: { value: null },
    },
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  S.mesh = new THREE.Mesh(S.geometry, S.material);
  S.mesh.name = 'water:ocean';
  S.mesh.frustumCulled = false;
  S.mesh.renderOrder = -1;            // antes de nuvens/partículas transparentes
  S.mesh.matrixAutoUpdate = false;

  S.group = new THREE.Group();
  S.group.name = 'water';
  S.group.add(S.mesh);
  S.group.visible = false;

  S.under = buildUnderwater(ctx, S.quality);
  S.group.add(S.under.group);

  ctx.engine.scene.add(S.group);

  // Iluminação pode querer injetar sombras/IBL no nosso material.
  try { ctx.lighting?.registerMaterial?.(S.material, { kind: 'water', id }); } catch (e) { /* opcional */ }

  buildSpectrum(ctx, 'water-waves');

  // Reposiciona imediatamente após um rebase — não esperamos o próximo frame.
  ctx.events.on('frame:rebase', onRebase);
  ctx.events.on('planet:approach', () => { S.body = null; });
  ctx.events.on('system:enter', () => { S.body = null; });

  updateResolution(ctx);
  S.ready = true;

  ctx.provide(id, {
    /** Raio absoluto do nível do mar em uso (0 se o planeta não tem oceano). */
    get seaLevelRadius() { return S.enabled ? S.seaRadius : 0; },
    /** true quando a câmera está abaixo da superfície (já com a onda somada). */
    get isUnderwater() { return S.isUnderwater; },
    /** Profundidade (m) da câmera abaixo da superfície; 0 se fora d'água. */
    get cameraDepth() { return S.camDepth; },
    get enabled() { return S.enabled; },
    get material() { return S.material; },
    /** Cor/densidade de névoa submersa — para postfx/HUD reaproveitarem. */
    get underwaterFog() { return S.material.uniforms.uWaterDeep.value; },

    /**
     * Profundidade da coluna d'água em worldPos: >0 submerso, <0 acima do mar.
     * Não inclui a onda; use surfaceOffsetAt() se precisar da superfície exata.
     */
    depthAt(worldPos) {
      if (!S.enabled || !S.body) return -Infinity;
      const c = S.body.center;
      const dx = worldPos.x - c.x, dy = worldPos.y - c.y, dz = worldPos.z - c.z;
      return S.seaRadius - Math.sqrt(dx * dx + dy * dy + dz * dz);
    },

    /** Altura (m) da onda sobre o nível médio no ponto dado. Útil para flutuação. */
    surfaceOffsetAt(worldPos) {
      if (!S.enabled || !S.body) return 0;
      return waveHeightAt(worldPos);
    },

    /** Raio da superfície (nível do mar + onda) na direção de worldPos. */
    surfaceRadiusAt(worldPos) {
      if (!S.enabled) return 0;
      return S.seaRadius + waveHeightAt(worldPos);
    },

    setEnabled(v) { S.forceOff = !v; },
  });
}

function onRebase() {
  if (S.ready && S.enabled) syncTransforms(S.ctx);
}

function updateResolution(ctx) {
  const s = ctx.engine.renderer.getDrawingBufferSize(S.t.size);
  S.material.uniforms.uInvResolution.value.set(1 / Math.max(1, s.x), 1 / Math.max(1, s.y));
}

export function resize(w, h, dpr, ctx) {
  if (!S.ready) return;
  updateResolution(ctx);
  S.material.uniforms.uLogDepthFC.value = 2 / (Math.log(ctx.engine.camera.far + 1) / Math.LN2);
  S.material.uniforms.uNear.value = ctx.engine.camera.near;
  S.material.uniforms.uFar.value = ctx.engine.camera.far;
}

/** Altura da onda (CPU) — mesma soma de Gerstner do shader, para física/HUD. */
function waveHeightAt(worldPos) {
  const c = S.body.center;
  const t = S.t;
  t.v1.set(worldPos.x - c.x, worldPos.y - c.y, worldPos.z - c.z);
  const len = t.v1.length() || 1;
  t.v1.multiplyScalar(1 / len);
  // Offset tangencial em relação ao centro do patch, projetado na base atual.
  t.v2.set(
    worldPos.x - S.centerWorld.x,
    worldPos.y - S.centerWorld.y,
    worldPos.z - S.centerWorld.z,
  );
  const x = t.v2.dot(S.east);
  const z = t.v2.dot(S.north);
  let y = 0;
  for (let i = 0; i < WAVES; i++) {
    const w = S.wave[i];
    const dx = w.dir2x, dz = w.dir2z;
    y += w.amp * Math.sin(w.k * (dx * x + dz * z) + w.phase);
  }
  return y;
}

/** Escolhe o corpo ativo e decide se há oceano. */
function resolvePlanet(ctx) {
  const body = ctx.planet?.current || null;
  if (body === S.body) return;
  S.body = body;
  S.biome = body?.biome || null;
  S.enabled = false;
  S.gridFine.valid = false; S.gridFine.row = -1;
  S.gridCoarse.valid = false; S.gridCoarse.row = -1;
  if (!body || !S.biome) return;

  // Planeta sem oceano (ex.: barren_regolith) desliga o módulo em silêncio.
  const seaFrac = S.biome.terrain?.seaLevel ?? 0;
  if (!(seaFrac > 0)) return;

  const declared = ctx.planet?.seaLevelRadius;
  if (Number.isFinite(declared) && declared > body.radius * 0.5) {
    S.seaRadius = declared;
  } else {
    // Fallback: o bioma define seaLevel como fração da amplitude medida do datum,
    // e sampleHeight varia aproximadamente em ±amplitude/2.
    const amp = S.biome.terrain?.amplitude ?? 2000;
    S.seaRadius = body.radius + (seaFrac - 0.5) * amp;
  }

  // Vento de reserva quando não existe módulo `weather`: determinístico e
  // resolvido aqui, nunca no update (§2.1 + zero alocação por frame).
  const wr = ctx.rng.derive('water-wind', hashString(String(body.id ?? body.name ?? 'x')) & 0xffff);
  S.fallbackWindAngle = wr.range(0, TAU);
  S.fallbackWindSpeed = clamp(5 + wr.float() * 10, 1, 45);
  S.windSpeed = S.fallbackWindSpeed;

  S.enabled = true;
  applyBiomeColors();
  buildSpectrum(ctx, 'water-waves-' + (body.id ?? body.name ?? '0'));
}

function applyBiomeColors() {
  const p = S.biome?.palette;
  if (!p) return;
  const u = S.material.uniforms;
  linColor(p.water ?? 0x18b6c9, u.uWaterShallow.value);
  linColor(p.waterDeep ?? 0x0a4a63, u.uWaterDeep.value);
  linColor(p.foam ?? 0xffffff, u.uFoamColor.value);
  linColor(p.sand ?? p.beach ?? 0xd8c8a0, u.uBedColor.value);

  // Extinção por canal derivada da própria cor rasa: água turquesa mata o
  // vermelho primeiro. É isso que produz o degradê areia→turquesa→azul-marinho.
  const sc = u.uWaterShallow.value;
  const base = 0.055;
  u.uExtinction.value.set(
    base * (1.9 - saturate(sc.r) * 1.5) * 5.5,
    base * (1.9 - saturate(sc.g) * 1.5) * 1.6,
    base * (1.9 - saturate(sc.b) * 1.5) * 0.85,
  );

  const sky = S.biome?.sky;
  if (sky) {
    linColor(sky.horizon ?? 0xffd0b0, u.uSkyHorizon.value);
    linColor(sky.zenith ?? 0x2f7fd8, u.uSkyZenith.value);
    linColor(sky.fogColor ?? sky.tint ?? 0x8ad4ff, u.uFogColor.value);
    // O oceano fica no chão da atmosfera, onde ela é mais densa: reforçamos a
    // densidade do bioma para que o horizonte marítimo lave de verdade.
    u.uFogDensity.value = clamp((sky.fogDensity ?? 5e-5) * 4.5, 1e-6, 4e-3);
  }

  // Névoa submersa e partículas herdam a paleta do bioma.
  const deep = u.uWaterDeep.value;
  for (const m of S.under.shells) {
    m.material.uniforms.uColor.value.copy(deep);
  }
  S.under.rays.material.uniforms.uColor.value.copy(u.uWaterShallow.value);
  S.under.particles.material.uniforms.uColor.value.copy(u.uFoamColor.value);
}

/** Base tangente determinística no ponto de superfície — evita giro aleatório. */
function updateBasis(ctx) {
  const t = S.t;
  const body = S.body;
  const cam = t.cam;

  // Câmera em coordenadas de mundo (double).
  const lc = ctx.engine.camera.position;
  const o = ctx.frame.origin;
  cam.x = lc.x + o.x; cam.y = lc.y + o.y; cam.z = lc.z + o.z;

  const pc = body.center;
  let dx = cam.x - pc.x, dy = cam.y - pc.y, dz = cam.z - pc.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= dist; dy /= dist; dz /= dist;

  S.up.set(dx, dy, dz);
  // Eixo polar fixo (Y do planeta) dá uma base contínua e reprodutível.
  const ref = Math.abs(dy) > 0.999 ? t.v3.set(1, 0, 0) : t.v3.set(0, 1, 0);
  S.east.crossVectors(ref, S.up);
  if (S.east.lengthSq() < 1e-12) S.east.set(1, 0, 0);
  S.east.normalize();
  S.north.crossVectors(S.up, S.east).normalize();

  S.prevCenterWorld.x = S.centerWorld.x;
  S.prevCenterWorld.y = S.centerWorld.y;
  S.prevCenterWorld.z = S.centerWorld.z;

  S.centerWorld.x = pc.x + dx * S.seaRadius;
  S.centerWorld.y = pc.y + dy * S.seaRadius;
  S.centerWorld.z = pc.z + dz * S.seaRadius;

  S.camAltitude = dist - S.seaRadius;
}

/** Avança fase e direção 2D de cada onda, mantendo-as ancoradas ao mundo. */
function updateWaves(ctx, dt) {
  const t = S.t;
  // Vento tangencial: projeta o vetor do módulo weather no plano do patch.
  let haveWind = readWind(ctx, t.wind);
  if (haveWind) {
    S.windSpeed = clamp(t.wind.length(), 0.5, 45);
    t.wind.addScaledVector(S.up, -t.wind.dot(S.up));
    if (t.wind.lengthSq() < 1e-8) haveWind = false;
  }
  if (!haveWind) {
    // Fallback determinístico: vento constante por planeta, resolvido uma vez
    // em resolvePlanet() — derivar o Rng por frame alocaria em caminho quente.
    const a = S.fallbackWindAngle;
    t.wind.copy(S.east).multiplyScalar(Math.cos(a)).addScaledVector(S.north, Math.sin(a));
    S.windSpeed = S.fallbackWindSpeed;
  }
  t.wind.normalize();
  S.windDir3.copy(t.wind);

  // Deslocamento tangencial do centro desde o frame anterior (double).
  const mx = S.centerWorld.x - S.prevCenterWorld.x;
  const my = S.centerWorld.y - S.prevCenterWorld.y;
  const mz = S.centerWorld.z - S.prevCenterWorld.z;
  const moved = mx * mx + my * my + mz * mz;

  const uA = S.material.uniforms.uWaveA.value;
  const uB = S.material.uniforms.uWaveB.value;
  const uF = S.material.uniforms.uWaveFade.value;

  for (let i = 0; i < WAVES; i++) {
    const w = S.wave[i];
    // Direção 3D da onda: vento girado pelo ângulo do espectro, no plano tangente.
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    t.v1.copy(S.windDir3).multiplyScalar(ca);
    t.v2.crossVectors(S.up, S.windDir3).multiplyScalar(sa);
    w.dir3.copy(t.v1).add(t.v2).normalize();

    const d2x = w.dir3.dot(S.east);
    const d2z = w.dir3.dot(S.north);
    const l = Math.hypot(d2x, d2z) || 1;
    w.dir2x = d2x / l;
    w.dir2z = d2z / l;

    // A fase absorve tanto o tempo quanto o caminhar do centro do patch: assim
    // o shader só lida com offsets pequenos e as ondas não deslizam no rebase.
    let ph = w.phase - w.omega * dt;
    if (moved > 1e-8) ph += w.k * (w.dir3.x * mx + w.dir3.y * my + w.dir3.z * mz);
    ph %= TAU;
    if (ph < 0) ph += TAU;
    w.phase = ph;

    uA[i].set(w.dir2x, w.dir2z, w.k, w.amp);
    uB[i].set(w.Q, ph);
    // Fade: uma onda deixa de valer vértices quando seu comprimento cai abaixo
    // de ~3 px. Aproximado por múltiplos do comprimento de onda.
    const L = TAU / w.k;
    uF[i].set(L * 55, L * 190);
  }
}

/** Escreve a transformação do patch (posição/rotação relativas à origem flutuante). */
function syncTransforms(ctx) {
  const t = S.t;
  const o = ctx.frame.origin;
  S.mesh.position.set(
    S.centerWorld.x - o.x,
    S.centerWorld.y - o.y,
    S.centerWorld.z - o.z,
  );
  t.m4.makeBasis(S.east, S.up, S.north);
  S.mesh.quaternion.setFromRotationMatrix(t.m4);
  S.mesh.updateMatrix();
  S.mesh.updateMatrixWorld(true);

  // Câmera em espaço local do patch.
  t.v1.set(
    t.cam.x - S.centerWorld.x,
    t.cam.y - S.centerWorld.y,
    t.cam.z - S.centerWorld.z,
  );
  const u = S.material.uniforms;
  u.uCamLocal.value.set(t.v1.dot(S.east), t.v1.dot(S.up), t.v1.dot(S.north));

  // Sol em espaço local do patch.
  const sun = ctx.sky?.sunDirection;
  if (sun && Number.isFinite(sun.x)) t.sun.copy(sun).normalize();
  else t.sun.copy(S.up);
  u.uSunDir.value.set(t.sun.dot(S.east), t.sun.dot(S.up), t.sun.dot(S.north));

  u.uWindDir2.value.set(S.windDir3.dot(S.east), S.windDir3.dot(S.north));
  if (u.uWindDir2.value.lengthSq() < 1e-8) u.uWindDir2.value.set(1, 0);
  u.uWindDir2.value.normalize();
}

export function update(dt, ctx) {
  if (!S.ready) return;

  resolvePlanet(ctx);
  const on = S.enabled && !S.forceOff;
  if (!on) {
    if (S.group.visible) S.group.visible = false;
    S.isUnderwater = false;
    S.camDepth = 0;
    if (ctx.debug.enabled) ctx.debug.set('water', S.body ? 'sem oceano' : 'sem planeta');
    return;
  }
  S.group.visible = true;

  updateBasis(ctx);
  updateWaves(ctx, dt);

  const u = S.material.uniforms;
  u.uSeaRadius.value = S.seaRadius;
  u.uTime.value = (u.uTime.value + dt) % 3600;

  // Raio do patch = horizonte visível. Do solo dá ~1,5 km; da órbita cobre o
  // hemisfério inteiro. Mesma malha, mesma contagem de triângulos.
  const alt = Math.max(1.2, S.camAltitude);
  const horizon = Math.sqrt(Math.max(0, (S.seaRadius + alt) * (S.seaRadius + alt) - S.seaRadius * S.seaRadius));
  const patchR = clamp(horizon * 1.2, 900, S.seaRadius * 6);
  u.uPatchRadius.value = patchR;
  u.uVertexFade.value = clamp(alt * 6 + 900, 900, 9000);

  // ── Batimetria incremental ────────────────────────────────────────────────
  const gf = S.gridFine, gc = S.gridCoarse;
  const fineSpan = clamp(patchR * 0.35, 260, 1400);
  const coarseSpan = clamp(patchR * 1.15, 2500, 90000);
  if (gf.row < 0) {
    const dx = S.centerWorld.x - gf.center.x, dy = S.centerWorld.y - gf.center.y, dz = S.centerWorld.z - gf.center.z;
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!gf.valid || moved > fineSpan * 0.3 || Math.abs(gf.span - fineSpan) > fineSpan * 0.4) {
      startBake(gf, S.centerWorld, S.east, S.north, S.up, fineSpan);
    }
  }
  if (gc.row < 0) {
    const dx = S.centerWorld.x - gc.center.x, dy = S.centerWorld.y - gc.center.y, dz = S.centerWorld.z - gc.center.z;
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!gc.valid || moved > coarseSpan * 0.25 || Math.abs(gc.span - coarseSpan) > coarseSpan * 0.45) {
      startBake(gc, S.centerWorld, S.east, S.north, S.up, coarseSpan);
    }
  }
  // A grade fina tem prioridade: é ela que define a linha de costa visível.
  stepBake(gf, ctx, S.body, S.seaRadius, 6);
  stepBake(gc, ctx, S.body, S.seaRadius, 4);

  if (gf.valid || gc.valid) {
    updateGridTransform(gf);
    updateGridTransform(gc);
    u.uGridRotF.value.copy(gf.rot); u.uGridOffF.value.copy(gf.off); u.uGridSpanF.value = gf.span;
    u.uGridRotC.value.copy(gc.rot); u.uGridOffC.value.copy(gc.off); u.uGridSpanC.value = gc.span;
    u.uHasGrid.value = 1;
    // Enquanto a grade grossa não existe, a fina cobre tudo (span idêntico).
    if (!gc.valid) { u.uGridRotC.value.copy(gf.rot); u.uGridOffC.value.copy(gf.off); u.uGridSpanC.value = gf.span; }
    if (!gf.valid) { u.uGridRotF.value.copy(gc.rot); u.uGridOffF.value.copy(gc.off); u.uGridSpanF.value = gc.span; }
  } else {
    u.uHasGrid.value = 0;
  }

  // ── Sol / céu ─────────────────────────────────────────────────────────────
  if (ctx.sky?.sunColor) u.uSunColor.value.copy(ctx.sky.sunColor);
  u.uSunIntensity.value = clamp(ctx.sky?.sunIntensity ?? 1, 0, 12);

  // IBL do engine, quando for um cubemap direto (PMREM exigiria os chunks do
  // three; o gradiente analítico do bioma já cobre esse caso sem risco).
  const env = ctx.engine.scene.environment;
  if (env && env.isCubeTexture) { u.uEnvCube.value = env; u.uHasEnv.value = 1; }
  else u.uHasEnv.value = 0;

  // Estado do mar afeta rugosidade, espuma e amplitude do normal map.
  const sea = saturate((S.windSpeed - 2) / 22);
  u.uWindAmount.value = lerp(0.45, 1.5, sea);
  u.uFoamDepth.value = lerp(1.1, 2.6, sea);
  u.uCaustics.value = ctx.quality?.preset === 'low' ? 0 : lerp(1.1, 0.5, sea);
  u.uRefract.value = ctx.quality?.preset === 'low' ? 0.25 : 0.55;

  // ── Submerso ──────────────────────────────────────────────────────────────
  const pc = S.body.center;
  const cdx = S.t.cam.x - pc.x, cdy = S.t.cam.y - pc.y, cdz = S.t.cam.z - pc.z;
  const camR = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);
  const surfaceR = S.seaRadius + waveHeightAt(S.t.cam);
  const depth = surfaceR - camR;
  const wasUnder = S.isUnderwater;
  // Histerese de 6 cm: sem isso o modo pisca na linha d'água.
  S.isUnderwater = wasUnder ? depth > -0.06 : depth > 0.06;
  S.camDepth = Math.max(0, depth);
  if (S.isUnderwater !== wasUnder) {
    ctx.events.emit(S.isUnderwater ? 'water:enter' : 'water:exit', { depth: S.camDepth });
    ctx.events.emit('audio:cue', { name: S.isUnderwater ? 'water_submerge' : 'water_surface', params: { depth: S.camDepth } });
  }
  u.uUnderFactor.value = S.isUnderwater ? 1 : 0;
  updateUnderwater(ctx, dt);

  // Montar strings por frame alocaria em caminho quente — só com o overlay ligado.
  if (ctx.debug.enabled) {
    ctx.debug.set('water', `${S.isUnderwater ? 'SUB ' + S.camDepth.toFixed(1) + 'm' : 'sup'} | patch ${(patchR / 1000).toFixed(1)}km | vento ${S.windSpeed.toFixed(1)}m/s`);
    ctx.debug.set('water.sea', `R=${(S.seaRadius / 1000).toFixed(2)}km alt=${S.camAltitude.toFixed(0)}m bake=${gf.row}/${gc.row}`);
  }
}

function updateUnderwater(ctx, dt) {
  const g = S.under;
  if (!S.isUnderwater) {
    if (g.group.visible) g.group.visible = false;
    return;
  }
  g.group.visible = true;
  const t = S.t;
  const o = ctx.frame.origin;
  // Tudo do modo submerso é ancorado na câmera; posição local é direta.
  const camLocal = ctx.engine.camera.position;
  g.group.position.copy(camLocal);

  // Visibilidade cai com a profundidade: raso = 45 m, fundo = 12 m.
  const vis = lerp(48, 11, saturate(S.camDepth / 120));
  const sigma = 1 / vis;
  const light = lerp(1, 0.06, saturate(S.camDepth / 160));
  const deep = S.material.uniforms.uWaterDeep.value;
  const shallow = S.material.uniforms.uWaterShallow.value;

  for (let i = 0; i < g.shells.length; i++) {
    const m = g.shells[i];
    const r = m.userData.radius;
    const prev = i === 0 ? 0 : g.shells[i - 1].userData.radius;
    const a = 1 - Math.exp(-sigma * (r - prev));
    const uu = m.material.uniforms;
    uu.uAlpha.value = clamp(a, 0.02, 0.97);
    uu.uSurface.value = light * (ctx.sky?.sunIntensity ?? 1) * 0.55;
    // Cor: mistura raso/fundo conforme a profundidade da câmera.
    uu.uColor.value.copy(shallow).lerp(deep, saturate(S.camDepth / 60));
    // "Para cima" em espaço local do grupo (o grupo não é rotacionado).
    uu.uUp.value.copy(S.up);
  }

  // Godrays alinhados ao sol.
  const rays = g.rays;
  const sun = ctx.sky?.sunDirection;
  t.v1.copy(sun && Number.isFinite(sun.x) ? sun : S.up).normalize();
  if (t.v1.dot(S.up) < 0.02) t.v1.copy(S.up);
  t.q1.setFromUnitVectors(t.v2.set(0, 1, 0), t.v1);
  rays.quaternion.copy(t.q1);
  rays.position.set(0, 0, 0);
  const rm = rays.material.uniforms;
  rm.uTime.value = (rm.uTime.value + dt) % 10000;
  rm.uIntensity.value = clamp((ctx.sky?.sunIntensity ?? 1) * 0.30 * light * (ctx.quality?.godrays === false ? 0 : 1), 0, 2.5);
  rm.uColor.value.copy(shallow).multiplyScalar(1.4);
  rays.visible = rm.uIntensity.value > 0.005;

  // Partículas: fixas no mundo, repetidas em torno da câmera via módulo.
  const pm = g.particles.material.uniforms;
  pm.uTime.value = (pm.uTime.value + dt) % 10000;
  const box = g.box;
  const wx = ((t.cam.x % box) + box) % box;
  const wy = ((t.cam.y % box) + box) % box;
  const wz = ((t.cam.z % box) + box) % box;
  pm.uWrap.value.set(wx, wy, wz);
  pm.uColor.value.copy(shallow).lerp(S.t.white, 0.5).multiplyScalar(light * 0.9 + 0.1);
}

export function lateUpdate(dt, ctx) {
  if (!S.ready || !S.enabled || S.forceOff) return;

  // Depois do frame.update(): agora as coordenadas relativas estão corretas.
  syncTransforms(ctx);

  // Cópia da cena para refração/SSR — pedida o mais tarde possível.
  const u = S.material.uniforms;
  let copy = null;
  try { copy = ctx.postfx?.requestSceneCopy?.() ?? null; } catch (e) { copy = null; }
  const nc = normalizeSceneCopy(copy, ctx);
  if (nc.color) { u.uSceneColor.value = nc.color; u.uHasSceneColor.value = 1; }
  else { u.uSceneColor.value = S.detailTex; u.uHasSceneColor.value = 0; }
  if (nc.depth) { u.uSceneDepth.value = nc.depth; u.uHasSceneDepth.value = 1; }
  else { u.uSceneDepth.value = S.detailTex; u.uHasSceneDepth.value = 0; }

  // O material fica SEMPRE transparente: alternar `transparent` em runtime
  // muda a chave de programa do three e causaria recompilação (hitch). Quando
  // há cópia da cena o shader devolve alpha = 1 e a mistura vira no-op.

  if (S.isUnderwater) {
    S.under.group.position.copy(ctx.engine.camera.position);
    S.under.group.updateMatrixWorld(true);
  }
}

export function dispose(ctx) {
  if (!S.ready) return;
  ctx.engine.scene.remove(S.group);
  S.geometry.dispose();
  S.material.dispose();
  S.detailTex.dispose();
  S.causticTex.dispose();
  S.gridFine.tex.dispose();
  S.gridCoarse.tex.dispose();
  const g = S.under;
  if (g) {
    g.shellGeo.dispose();
    g.rayGeo.dispose();
    g.pgeo.dispose();
    for (const m of g.shells) m.material.dispose();
    g.rays.material.dispose();
    g.particles.material.dispose();
  }
  S.ready = false;
  S.enabled = false;
}
