import * as THREE from 'three';

/**
 * ESPALHAMENTO ATMOSFÉRICO — modelo Bruneton simplificado / Hillaire.
 *
 * ── Por que LUT e não integral direta ───────────────────────────────────────
 * A transmitância T(r, mu) só depende da altitude e do cosseno do ângulo com o
 * zênite: é uma função 2D. Pré-computá-la uma vez por atmosfera transforma o
 * termo mais caro do raymarch (uma integral aninhada) em uma leitura de textura.
 * O mesmo vale para o multi-espalhamento (Hillaire 2020): a energia que sofreu
 * 2+ ricochetes é quase isotrópica e varia devagar, então cabe numa LUT 32x32.
 * Sem esse termo o céu ao crepúsculo fica PRETO em vez de violeta — é ele que
 * carrega a luz para dentro da sombra do planeta.
 *
 * ── Por que unidades de raio planetário no shader ───────────────────────────
 * Um planeta de 150 km em float32 tem `dot(p,p) ≈ 2.25e10`, cujo ULP é ~2 km.
 * Calcular `|p|² - R²` nessa escala destrói completamente a altitude. Todo o
 * shader trabalha então em unidades de RAIO (r ≈ 1.0), onde o ULP é ~1e-7, ou
 * seja ~1,5 cm de resolução em altitude. As densidades continuam sendo função
 * da altura em METROS (h = (r - 1) * R) porque as alturas de escala são
 * grandezas físicas.
 *
 * ── Por que a atmosfera não usa as alturas de escala da Terra ───────────────
 * A Terra tem R = 6371 km e topo de atmosfera em ~60 km: a casca é 0,94% do
 * raio. Aqui o raio é 80–220 km e o contrato manda topo = raio * 0.06, ou seja
 * 6% do raio — uma casca proporcionalmente ~6x mais espessa, para que ela
 * continue LEGÍVEL da órbita. As alturas de escala acompanham a ESPESSURA
 * (razão H/espessura da Terra preservada: 8/60 e 1,2/60), não o raio, senão a
 * atmosfera colapsaria numa linha de 190 m grudada no chão.
 *
 * Este arquivo não conhece o jogo: recebe um bioma e um raio, devolve
 * parâmetros, LUTs e o GLSL para amostrá-las.
 */

// ── Constantes de referência (Terra) ────────────────────────────────────────
/** Razão altura de escala / espessura da atmosfera, medida na Terra. */
const H_RAYLEIGH_RATIO = 8 / 60;
const H_MIE_RATIO = 1.2 / 60;

/**
 * Espectro de absorção do ozônio, normalizado no verde.
 * É ELE, e não o Rayleigh, que faz o crepúsculo virar magenta e depois violeta:
 * na luz rasante o ozônio come o amarelo/vermelho da banda de Chappuis e sobra
 * azul-violeta por cima do laranja do horizonte. Sem ozônio o pôr do sol é
 * apenas um marrom que escurece — exatamente o defeito que reprova a captura.
 */
const OZONE_SPECTRUM = [0.345, 1.0, 0.045];

/** Profundidade óptica vertical alvo (densidade 1.0). */
const OD_RAYLEIGH = 0.34;
/** Multiplicador que traduz `biome.sky.mie` em profundidade óptica de aerossol. */
const OD_MIE_SCALE = 20.0;
/** Profundidade óptica vertical de ozônio (no pico do espectro). */
const OD_OZONE = 0.095;

/** O Mie absorve ~10% do que espalha (fuligem/poeira). */
const MIE_ABSORPTION = 0.11;

/**
 * Monta os coeficientes de uma atmosfera a partir do bioma e do raio do corpo.
 * Determinístico: mesma entrada → mesma saída (nenhum RNG aqui).
 *
 * @param {object} biome  bioma do corpo (src/planet/biomes.js)
 * @param {number} radius raio do planeta em metros
 */
export function makeAtmosphereParams(biome, radius, opts = {}) {
  const sky = (biome && biome.sky) || {};
  const R = Math.max(1000, radius || 150000);
  const thickness = R * 0.06;                 // contrato §7
  const top = R + thickness;

  const density = Math.max(0.02, sky.density === undefined ? 1 : sky.density);
  const hR = thickness * H_RAYLEIGH_RATIO;
  const hM = thickness * H_MIE_RATIO;

  // Rayleigh: o bioma dá apenas a RAZÃO espectral; a magnitude vem da
  // profundidade óptica alvo, senão biomas com números pequenos ficariam sem céu.
  const rel = sky.rayleigh || [0.32, 0.55, 1.0];
  const relMax = Math.max(rel[0], rel[1], rel[2], 1e-4);
  const odR = OD_RAYLEIGH * density;
  const betaR = [
    (rel[0] / relMax) * odR / hR,
    (rel[1] / relMax) * odR / hR,
    (rel[2] / relMax) * odR / hR,
  ];

  const odM = Math.max(1e-4, (sky.mie === undefined ? 0.005 : sky.mie) * OD_MIE_SCALE * density);
  const betaMScat = odM / hM;
  const betaMExt = betaMScat * (1 + MIE_ABSORPTION);

  // Camada de ozônio: tenda centrada no meio-alto da atmosfera. A integral de
  // uma tenda de meia-largura w vale exatamente w, então beta = OD / w.
  const ozoneCenter = thickness * 0.42;
  const ozoneWidth = thickness * 0.30;
  const odO = OD_OZONE * density;
  const betaO = [
    OZONE_SPECTRUM[0] * odO / ozoneWidth,
    OZONE_SPECTRUM[1] * odO / ozoneWidth,
    OZONE_SPECTRUM[2] * odO / ozoneWidth,
  ];

  const albedo = opts.groundAlbedo || [0.18, 0.18, 0.18];

  // Esfera de "solo" usada para cortar o raymarch: propositalmente ABAIXO do
  // vale mais fundo. Se ela ficasse no datum, uma bacia oceânica escavada
  // abaixo do datum receberia céu preto (o raio "bate no chão" onde não há
  // geometria desenhada). Abaixo do relevo, o pior caso vira uma faixa que o
  // terreno sempre cobre.
  const relief = (biome && biome.terrain && biome.terrain.amplitude) || 2400;
  const groundR = 1 - Math.min(0.035, Math.max(0.004, (relief + 600) / R));

  const p = {
    radius: R,
    thickness,
    top,
    nTop: top / R,
    groundR,
    hR, hM,
    ozoneCenter, ozoneWidth,
    mieG: Math.min(0.92, Math.max(0, sky.mieG === undefined ? 0.78 : sky.mieG)),
    density,
    groundAlbedo: albedo,

    // Betas por METRO (uso em CPU/documentação)
    betaR, betaMScat, betaMExt, betaO,

    // Betas por unidade de RAIO (uso no shader e nas integrais normalizadas)
    nBetaR: [betaR[0] * R, betaR[1] * R, betaR[2] * R],
    nBetaMS: betaMScat * R,
    nBetaME: betaMExt * R,
    nBetaO: [betaO[0] * R, betaO[1] * R, betaO[2] * R],
  };

  // Chave de invalidação das LUTs: só a geometria e os coeficientes contam.
  // A irradiância da estrela é aplicada FORA da LUT, então mudar de estrela
  // não obriga a recomputar nada.
  p.key = [
    Math.round(R), Math.round(hR), Math.round(hM),
    p.nBetaR[0].toFixed(4), p.nBetaR[1].toFixed(4), p.nBetaR[2].toFixed(4),
    p.nBetaMS.toFixed(4), p.nBetaO[1].toFixed(4), p.mieG.toFixed(3), groundR.toFixed(5),
    albedo[0].toFixed(3), albedo[1].toFixed(3), albedo[2].toFixed(3),
  ].join('|');

  return p;
}

// ────────────────────────────────────────────────────────────────────────────
// GLSL compartilhado
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bloco GLSL com as funções de atmosfera. Registrado como `ShaderChunk` para
 * que terreno e água possam fazer `#include <aether_scattering>` e obter
 * perspectiva aérea IDÊNTICA à do céu — se cada um integrar do seu jeito, a
 * montanha distante e o céu atrás dela não fecham na mesma cor e a ilusão morre.
 *
 * Consumidor precisa: declarar nada, apenas mesclar `createAtmoUniforms()` nos
 * seus uniforms e opcionalmente `#define AETHER_SKY_STEPS n` antes do include.
 */
export const SCATTERING_CHUNK = /* glsl */`
#ifndef AETHER_SCATTERING_INCLUDED
#define AETHER_SCATTERING_INCLUDED

#ifndef AETHER_SKY_STEPS
  #define AETHER_SKY_STEPS 24
#endif
#ifndef AETHER_AERIAL_STEPS
  #define AETHER_AERIAL_STEPS 8
#endif

uniform sampler2D uAtmoTrans;    // LUT de transmitância  (256x64)
uniform sampler2D uAtmoMulti;    // LUT de multi-espalhamento (32x32)
uniform vec4  uAtmoGeom;         // x=1.0(R)  y=topo/R  z=hR(m)  w=hM(m)
uniform float uAtmoRadius;       // raio do planeta em metros
uniform vec3  uAtmoBetaR;        // Rayleigh, por unidade de raio
uniform vec2  uAtmoBetaM;        // x=espalhamento Mie  y=extinção Mie
uniform vec3  uAtmoBetaO;        // absorção do ozônio
uniform vec3  uAtmoOzone;        // x=centro(m) y=meia-largura(m) z=raio do solo
uniform float uAtmoMieG;
uniform vec3  uAtmoSunDir;       // direção do sol (mundo, unitária)
uniform vec3  uAtmoSunIrr;       // irradiância espectral no topo da atmosfera
uniform vec3  uAtmoSunDir2;      // segundo sol (sistemas binários)
uniform vec3  uAtmoSunIrr2;      // zero quando não há segundo sol

const float AETHER_PI = 3.141592653589793;

/** Densidades relativas: x=Rayleigh, y=Mie, z=ozônio. h em METROS. */
vec3 aetherDensity(float h) {
  return vec3(
    exp(-max(h, 0.0) / uAtmoGeom.z),
    exp(-max(h, 0.0) / uAtmoGeom.w),
    max(0.0, 1.0 - abs(h - uAtmoOzone.x) / uAtmoOzone.y)
  );
}

/** Raízes da interseção raio/esfera centrada na origem. z<0 → sem interseção. */
vec3 aetherSphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return vec3(0.0, 0.0, -1.0);
  float s = sqrt(d);
  return vec3(-b - s, -b + s, 1.0);
}

/**
 * Distância até o solo. Usa uma esfera ligeiramente MENOR que o datum
 * (uAtmoOzone.z) para nunca cortar o céu onde há relevo negativo desenhado.
 * -1 quando o raio não a atinge.
 */
float aetherGroundHit(vec3 ro, vec3 rd) {
  vec3 h = aetherSphere(ro, rd, uAtmoOzone.z);
  if (h.z < 0.0 || h.y < 0.0) return -1.0;
  return h.x > 0.0 ? h.x : -1.0;
}

/** Fase de Rayleigh: 3/(16pi) * (1 + cos^2). */
float aetherPhaseR(float c) { return 0.0596831 * (1.0 + c * c); }

/** Cornette-Shanks — Henyey-Greenstein corrigido, mantém o halo solar crível. */
float aetherPhaseM(float c, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + c * c);
  float den = (2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
  return 0.1193662 * num / den;   // 3/(8pi)
}

/** Parametrização de Bruneton/Hillaire: (r, mu) → uv na LUT de transmitância. */
vec2 aetherTransUv(float r, float mu) {
  float R = uAtmoGeom.x;
  float Rt = uAtmoGeom.y;
  float H = sqrt(max((Rt - R) * (Rt + R), 1e-8));
  float rho = sqrt(max((r - R) * (r + R), 0.0));
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = Rt - r;
  float dMax = rho + H;
  float u = (d - dMin) / max(dMax - dMin, 1e-8);
  return vec2(clamp(u, 0.0, 1.0), clamp(rho / H, 0.0, 1.0));
}

/** Inversa da parametrização — usada para PREENCHER a LUT. */
void aetherTransParams(vec2 uv, out float r, out float mu) {
  float R = uAtmoGeom.x;
  float Rt = uAtmoGeom.y;
  float H = sqrt(max((Rt - R) * (Rt + R), 1e-8));
  float rho = H * uv.y;
  r = sqrt(rho * rho + R * R);
  float dMin = Rt - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
}

vec3 aetherTransmittance(float r, float mu) {
  return texture2D(uAtmoTrans, aetherTransUv(r, mu)).rgb;
}

/**
 * Sombra do planeta com borda suave. Sem isso o terminador vira uma linha
 * serrilhada e o crepúsculo perde a cunha de sombra que dá realismo.
 */
float aetherPlanetShadow(float r, float muS) {
  float R = uAtmoGeom.x;
  float cosHorizon = -sqrt(max(0.0, 1.0 - (R * R) / max(r * r, 1e-8)));
  return smoothstep(cosHorizon - 0.006, cosHorizon + 0.006, muS);
}

/** Luz solar que chega a um ponto (transmitância + sombra do próprio planeta). */
vec3 aetherSunLight(float r, float muS) {
  return aetherTransmittance(r, muS) * aetherPlanetShadow(r, muS);
}

/** Multi-espalhamento pré-integrado (já isotrópico, já com a série geométrica). */
vec3 aetherMulti(float r, float muS) {
  float R = uAtmoGeom.x;
  float v = clamp((r - R) / max(uAtmoGeom.y - R, 1e-8), 0.0, 1.0);
  return texture2D(uAtmoMulti, vec2(clamp(muS * 0.5 + 0.5, 0.0, 1.0), v)).rgb;
}

/** Coeficiente de extinção total num ponto de altura h. */
vec3 aetherExtinction(vec3 d) {
  return uAtmoBetaR * d.x + vec3(uAtmoBetaM.y * d.y) + uAtmoBetaO * d.z;
}

/**
 * Integra o espalhamento ao longo de [0, tMax] (unidades de raio planetário).
 * "ro" já deve estar dentro da atmosfera.
 */
vec3 aetherIntegrate(vec3 ro, vec3 rd, float tMax, const int steps, out vec3 transmittance) {
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);

  float c1 = dot(rd, uAtmoSunDir);
  float pR1 = aetherPhaseR(c1);
  float pM1 = aetherPhaseM(c1, uAtmoMieG);

  bool two = (uAtmoSunIrr2.r + uAtmoSunIrr2.g + uAtmoSunIrr2.b) > 1e-4;
  float c2 = dot(rd, uAtmoSunDir2);
  float pR2 = aetherPhaseR(c2);
  float pM2 = aetherPhaseM(c2, uAtmoMieG);

  float dt = tMax / float(steps);
  float t = dt * 0.5;

  for (int i = 0; i < steps; i++) {
    vec3 p = ro + rd * t;
    float r = max(length(p), uAtmoGeom.x);
    float h = (r - uAtmoGeom.x) * uAtmoRadius;
    vec3 d = aetherDensity(h);

    vec3 sR = uAtmoBetaR * d.x;
    float sM = uAtmoBetaM.x * d.y;
    vec3 sigmaE = max(aetherExtinction(d), vec3(1e-9));
    vec3 stepT = exp(-sigmaE * dt);

    float muS1 = dot(p, uAtmoSunDir) / r;
    vec3 sun1 = aetherSunLight(r, muS1);
    vec3 S = (sR * pR1 + sM * pM1) * sun1 * uAtmoSunIrr;
    // Multi-espalhamento: fase isotrópica, já contida na LUT.
    S += (sR + sM) * aetherMulti(r, muS1) * uAtmoSunIrr;

    if (two) {
      float muS2 = dot(p, uAtmoSunDir2) / r;
      vec3 sun2 = aetherSunLight(r, muS2);
      S += (sR * pR2 + sM * pM2) * sun2 * uAtmoSunIrr2;
      S += (sR + sM) * aetherMulti(r, muS2) * uAtmoSunIrr2;
    }

    // Integração analítica do segmento (Hillaire): energia exata para sigma
    // constante no passo — permite passos grandes sem banding.
    L += T * (S - S * stepT) / sigmaE;
    T *= stepT;
    t += dt;
  }

  transmittance = T;
  return L;
}

/**
 * Céu completo visto de "roR" (unidades de raio, centrado no planeta).
 * Recorta o segmento útil contra o topo da atmosfera e contra o solo.
 * Devolve false quando o raio nem toca a atmosfera.
 */
bool aetherSky(vec3 roR, vec3 rd, out vec3 inscatter, out vec3 transmittance) {
  inscatter = vec3(0.0);
  transmittance = vec3(1.0);

  vec3 a = aetherSphere(roR, rd, uAtmoGeom.y);
  if (a.z < 0.0 || a.y <= 0.0) return false;

  float tNear = max(a.x, 0.0);
  float tFar = a.y;
  float tg = aetherGroundHit(roR, rd);
  if (tg > 0.0) tFar = min(tFar, tg);
  if (tFar <= tNear) return false;

  vec3 start = roR + rd * tNear;
  inscatter = aetherIntegrate(start, rd, tFar - tNear, AETHER_SKY_STEPS, transmittance);
  if (tg > 0.0) transmittance = vec3(0.0);   // o planeta bloqueia o fundo
  return true;
}

/**
 * Perspectiva aérea para geometria opaca: quanto de céu se acumula entre a
 * câmera e um ponto a "distMeters", e quanto da cor original sobrevive.
 * "roMeters" e o resultado ficam em METROS relativos ao centro do planeta.
 */
vec3 aetherAerial(vec3 roMeters, vec3 rd, float distMeters, out vec3 transmittance) {
  vec3 roR = roMeters / uAtmoRadius;
  float tMax = distMeters / uAtmoRadius;
  vec3 a = aetherSphere(roR, rd, uAtmoGeom.y);
  transmittance = vec3(1.0);
  if (a.z < 0.0 || a.y <= 0.0) return vec3(0.0);
  float tNear = max(a.x, 0.0);
  float tFar = min(a.y, tMax);
  if (tFar <= tNear) return vec3(0.0);
  vec3 start = roR + rd * tNear;
  return aetherIntegrate(start, rd, tFar - tNear, AETHER_AERIAL_STEPS, transmittance);
}

#endif
`;

/** Registra o chunk no three para permitir `#include <aether_scattering>`. */
export function registerScatteringChunk() {
  THREE.ShaderChunk['aether_scattering'] = SCATTERING_CHUNK;
  return SCATTERING_CHUNK;
}

/** Devolve o GLSL cru (para quem prefere concatenar em vez de incluir). */
export function getScatteringChunk() { return SCATTERING_CHUNK; }

/** Cria o conjunto de uniforms que o chunk espera. */
export function createAtmoUniforms() {
  return {
    uAtmoTrans: { value: null },
    uAtmoMulti: { value: null },
    uAtmoGeom: { value: new THREE.Vector4(1, 1.06, 1200, 180) },
    uAtmoRadius: { value: 150000 },
    uAtmoBetaR: { value: new THREE.Vector3(1, 1, 1) },
    uAtmoBetaM: { value: new THREE.Vector2(1, 1.1) },
    uAtmoBetaO: { value: new THREE.Vector3(0, 0, 0) },
    uAtmoOzone: { value: new THREE.Vector3(3800, 2700, 0.98) },
    uAtmoMieG: { value: 0.78 },
    uAtmoSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uAtmoSunIrr: { value: new THREE.Vector3(14, 14, 14) },
    uAtmoSunDir2: { value: new THREE.Vector3(0, -1, 0) },
    uAtmoSunIrr2: { value: new THREE.Vector3(0, 0, 0) },
  };
}

/** Escreve os parâmetros num conjunto de uniforms (sem alocar). */
export function applyAtmoUniforms(u, p) {
  if (!u || !p) return;
  u.uAtmoGeom.value.set(1, p.nTop, p.hR, p.hM);
  u.uAtmoRadius.value = p.radius;
  u.uAtmoBetaR.value.set(p.nBetaR[0], p.nBetaR[1], p.nBetaR[2]);
  u.uAtmoBetaM.value.set(p.nBetaMS, p.nBetaME);
  u.uAtmoBetaO.value.set(p.nBetaO[0], p.nBetaO[1], p.nBetaO[2]);
  u.uAtmoOzone.value.set(p.ozoneCenter, p.ozoneWidth, p.groundR);
  u.uAtmoMieG.value = p.mieG;
}

// ────────────────────────────────────────────────────────────────────────────
// LUTs em GPU
// ────────────────────────────────────────────────────────────────────────────

const LUT_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const TRANS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${SCATTERING_CHUNK}
#define TRANS_STEPS 40
void main() {
  float r, mu;
  aetherTransParams(vUv, r, mu);
  // Caminho até o topo da atmosfera.
  float Rt = uAtmoGeom.y;
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float tMax = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  vec3 od = vec3(0.0);
  float dt = tMax / float(TRANS_STEPS);
  for (int i = 0; i < TRANS_STEPS; i++) {
    float t = (float(i) + 0.5) * dt;
    float ri = sqrt(max(r * r + t * t + 2.0 * r * mu * t, 1e-12));
    float h = (ri - uAtmoGeom.x) * uAtmoRadius;
    od += aetherExtinction(aetherDensity(h)) * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

/**
 * Multi-espalhamento à la Hillaire: para cada (altitude, elevação do sol),
 * integra o espalhamento de 2ª ordem sobre a esfera de direções e fecha a
 * série geométrica das ordens seguintes com 1/(1-f).
 */
const MULTI_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
${SCATTERING_CHUNK}
#define MS_DIRS 4
#define MS_STEPS 16
uniform vec3 uAtmoAlbedo;

void main() {
  float R = uAtmoGeom.x;
  float Rt = uAtmoGeom.y;
  float muS = clamp(vUv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = mix(R, Rt, clamp(vUv.y, 0.0, 1.0));
  r = clamp(r, R + 1e-5, Rt - 1e-5);

  vec3 pos = vec3(0.0, r, 0.0);
  vec3 sunDir = normalize(vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0));

  vec3 lumTotal = vec3(0.0);
  vec3 fmsTotal = vec3(0.0);
  const float NDIR = float(MS_DIRS) * float(MS_DIRS);

  for (int a = 0; a < MS_DIRS; a++) {
    for (int b = 0; b < MS_DIRS; b++) {
      // Amostragem uniforme da esfera (área igual por célula).
      float ua = (float(a) + 0.5) / float(MS_DIRS);
      float ub = (float(b) + 0.5) / float(MS_DIRS);
      float theta = 2.0 * AETHER_PI * ua;
      float cosPhi = 2.0 * ub - 1.0;
      float sinPhi = sqrt(max(0.0, 1.0 - cosPhi * cosPhi));
      vec3 rd = vec3(sinPhi * cos(theta), cosPhi, sinPhi * sin(theta));

      vec3 hit = aetherSphere(pos, rd, Rt);
      float tMax = hit.y;
      float tg = aetherGroundHit(pos, rd);
      bool ground = tg > 0.0;
      if (ground) tMax = min(tMax, tg);
      if (tMax <= 0.0) continue;

      vec3 L = vec3(0.0);
      vec3 fms = vec3(0.0);
      vec3 T = vec3(1.0);
      float dt = tMax / float(MS_STEPS);
      float t = dt * 0.5;
      for (int i = 0; i < MS_STEPS; i++) {
        vec3 p = pos + rd * t;
        float ri = max(length(p), R);
        float h = (ri - R) * uAtmoRadius;
        vec3 d = aetherDensity(h);
        vec3 sS = uAtmoBetaR * d.x + vec3(uAtmoBetaM.x * d.y);
        vec3 sigmaE = max(aetherExtinction(d), vec3(1e-9));
        vec3 stepT = exp(-sigmaE * dt);

        float muSi = dot(p, sunDir) / ri;
        vec3 sun = aetherSunLight(ri, muSi);

        // Fase isotrópica: 1/(4pi).
        vec3 S = sS * sun * 0.0795774715;
        L += T * (S - S * stepT) / sigmaE;
        fms += T * (sS - sS * stepT) / sigmaE;
        T *= stepT;
        t += dt;
      }

      if (ground) {
        // Rebote difuso do solo: é o que dá cor de terra ao céu baixo.
        vec3 g = pos + rd * tg;
        float muSg = dot(normalize(g), sunDir);
        L += T * uAtmoAlbedo * max(muSg, 0.0) * aetherSunLight(R, muSg) / AETHER_PI;
      }

      lumTotal += L / NDIR;
      fmsTotal += fms / NDIR;
    }
  }

  vec3 psi = lumTotal / max(vec3(1.0) - fmsTotal, vec3(1e-3));
  gl_FragColor = vec4(min(psi, vec3(8.0)), 1.0);
}
`;

/**
 * Gerenciador das duas LUTs. Só recalcula quando `params.key` muda — trocar de
 * planeta custa dois draws minúsculos, e ficar no mesmo planeta custa zero.
 */
export class ScatteringLUTs {
  constructor(renderer) {
    this.renderer = renderer;
    this.key = null;
    this.lastCostMs = 0;

    const type = this._pickType();
    this.transTarget = this._makeTarget(256, 64, type);
    this.multiTarget = this._makeTarget(32, 32, type);

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geom = new THREE.PlaneGeometry(2, 2);

    this.transMat = new THREE.ShaderMaterial({
      uniforms: createAtmoUniforms(),
      vertexShader: LUT_VERT,
      fragmentShader: TRANS_FRAG,
      depthTest: false, depthWrite: false,
    });
    const multiUniforms = createAtmoUniforms();
    multiUniforms.uAtmoAlbedo = { value: new THREE.Vector3(0.18, 0.18, 0.18) };
    this.multiMat = new THREE.ShaderMaterial({
      uniforms: multiUniforms,
      vertexShader: LUT_VERT,
      fragmentShader: MULTI_FRAG,
      depthTest: false, depthWrite: false,
    });

    this._quad = new THREE.Mesh(this._geom, this.transMat);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
  }

  _pickType() {
    const ext = this.renderer.extensions;
    // Meia precisão basta: transmitância vive em [0,1] e psi em [0,8].
    if (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')) {
      return THREE.HalfFloatType;
    }
    return THREE.UnsignedByteType;
  }

  _makeTarget(w, h, type) {
    return new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  get transmittance() { return this.transTarget.texture; }
  get multiScatter() { return this.multiTarget.texture; }

  /**
   * Recomputa as LUTs se necessário.
   * @returns {boolean} true se houve recomputação neste chamado
   */
  update(params, force = false) {
    if (!force && params.key === this.key) return false;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

    applyAtmoUniforms(this.transMat.uniforms, params);
    applyAtmoUniforms(this.multiMat.uniforms, params);
    this.multiMat.uniforms.uAtmoTrans.value = this.transTarget.texture;
    this.multiMat.uniforms.uAtmoAlbedo.value.set(
      params.groundAlbedo[0], params.groundAlbedo[1], params.groundAlbedo[2],
    );

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    this._quad.material = this.transMat;
    r.setRenderTarget(this.transTarget);
    r.render(this._scene, this._camera);

    this._quad.material = this.multiMat;
    r.setRenderTarget(this.multiTarget);
    r.render(this._scene, this._camera);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;

    this.key = params.key;
    this.lastCostMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    return true;
  }

  dispose() {
    this.transTarget.dispose();
    this.multiTarget.dispose();
    this.transMat.dispose();
    this.multiMat.dispose();
    this._geom.dispose();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Versão CPU — barata, para cor de luz, névoa e ambiente
// ────────────────────────────────────────────────────────────────────────────
//
// Ler a LUT de volta da GPU custaria um stall de pipeline por frame. Como a
// iluminação precisa de pouquíssimas amostras (zênite, horizonte, direção do
// sol), refazemos a mesma integral em float64 na CPU: ~1200 iterações/frame,
// custo desprezível e sem sincronização.

const _od = [0, 0, 0];

function densities(p, h, out) {
  out[0] = Math.exp(-Math.max(h, 0) / p.hR);
  out[1] = Math.exp(-Math.max(h, 0) / p.hM);
  out[2] = Math.max(0, 1 - Math.abs(h - p.ozoneCenter) / p.ozoneWidth);
  return out;
}

const _dens = [0, 0, 0];

/** Profundidade óptica de (r, mu) até o topo. Devolve Infinity se bate no solo. */
export function cpuOpticalDepth(p, r, mu, out = _od, steps = 14) {
  const Rt = p.nTop;
  const gr = p.groundR;
  const discGround = r * r * (mu * mu - 1) + gr * gr;
  if (mu < 0 && discGround >= 0) { out[0] = out[1] = out[2] = Infinity; return out; }

  const discTop = r * r * (mu * mu - 1) + Rt * Rt;
  const tMax = Math.max(0, -r * mu + Math.sqrt(Math.max(discTop, 0)));
  out[0] = out[1] = out[2] = 0;
  if (tMax <= 0) return out;

  const dt = tMax / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(Math.max(r * r + t * t + 2 * r * mu * t, 1e-12));
    densities(p, (ri - 1) * p.radius, _dens);
    out[0] += (p.nBetaR[0] * _dens[0] + p.nBetaME * _dens[1] + p.nBetaO[0] * _dens[2]) * dt;
    out[1] += (p.nBetaR[1] * _dens[0] + p.nBetaME * _dens[1] + p.nBetaO[1] * _dens[2]) * dt;
    out[2] += (p.nBetaR[2] * _dens[0] + p.nBetaME * _dens[1] + p.nBetaO[2] * _dens[2]) * dt;
  }
  return out;
}

/** Transmitância (r, mu) → topo da atmosfera. */
export function cpuTransmittance(p, r, mu, out = [0, 0, 0]) {
  cpuOpticalDepth(p, r, mu, _od);
  out[0] = Math.exp(-_od[0]);
  out[1] = Math.exp(-_od[1]);
  out[2] = Math.exp(-_od[2]);
  return out;
}

const _tsun = [0, 0, 0];
const _tview = [0, 0, 0];

function phaseR(c) { return 0.0596831 * (1 + c * c); }
function phaseM(c, g) {
  const g2 = g * g;
  const num = (1 - g2) * (1 + c * c);
  const den = (2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5);
  return 0.1193662 * num / den;
}

/**
 * Radiância do céu numa direção, em unidades de irradiância solar.
 * @param {number} r   raio normalizado do observador
 * @param {number} mu  cos(ângulo da direção de visada com o zênite local)
 * @param {number} muS cos(ângulo do sol com o zênite local)
 * @param {number} nu  cos(ângulo entre visada e sol)
 */
export function cpuSkyRadiance(p, r, mu, muS, nu, out = [0, 0, 0], steps = 14) {
  out[0] = out[1] = out[2] = 0;
  const Rt = p.nTop;
  const discTop = r * r * (mu * mu - 1) + Rt * Rt;
  if (discTop < 0) return out;
  let tMax = Math.max(0, -r * mu + Math.sqrt(discTop));
  const gr = p.groundR;
  const discGround = r * r * (mu * mu - 1) + gr * gr;
  if (mu < 0 && discGround >= 0) {
    tMax = Math.min(tMax, Math.max(0, -r * mu - Math.sqrt(discGround)));
  }
  if (tMax <= 0) return out;

  const pR = phaseR(nu);
  const pM = phaseM(nu, p.mieG);
  const dt = tMax / steps;
  let tr = 1, tg = 1, tb = 1;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(Math.max(r * r + t * t + 2 * r * mu * t, 1e-12));
    const muSi = (r * muS + t * nu) / ri;
    densities(p, (ri - 1) * p.radius, _dens);
    // Copia local: cpuTransmittance() reutiliza o mesmo buffer de densidades.
    const dR = _dens[0], dM = _dens[1], dO = _dens[2];

    const eR = p.nBetaR[0] * dR + p.nBetaME * dM + p.nBetaO[0] * dO;
    const eG = p.nBetaR[1] * dR + p.nBetaME * dM + p.nBetaO[1] * dO;
    const eB = p.nBetaR[2] * dR + p.nBetaME * dM + p.nBetaO[2] * dO;

    // Sombra do próprio planeta: aqui o corte é no DATUM, porque é ele que
    // define o terminador — é o que dá a cunha de sombra do crepúsculo.
    const cosHorizon = -Math.sqrt(Math.max(0, 1 - 1 / (ri * ri)));
    if (muSi > cosHorizon) cpuTransmittance(p, ri, muSi, _tsun);
    else { _tsun[0] = _tsun[1] = _tsun[2] = 0; }

    // Aproximação de multi-espalhamento: fração isotrópica proporcional à
    // luz que sobra depois de uma passagem. Mantém o zênite azul-violeta no
    // crepúsculo em vez de preto.
    // Calibrado contra a LUT de multi-espalhamento da GPU: sem este ganho a
    // versão CPU devolve um céu ~2,5x mais escuro que o renderizado, e a
    // névoa do terreno deixaria de fechar com o horizonte.
    const ms = 0.62 * Math.exp(-(ri - 1) * p.radius / (p.hR * 2.5));

    const sR = p.nBetaR[0] * dR, sG = p.nBetaR[1] * dR, sB = p.nBetaR[2] * dR;
    const sM = p.nBetaMS * dM;

    const contribR = (sR * pR + sM * pM) * _tsun[0] + (sR + sM) * ms * _tsun[0];
    const contribG = (sG * pR + sM * pM) * _tsun[1] + (sG + sM) * ms * _tsun[1];
    const contribB = (sB * pR + sM * pM) * _tsun[2] + (sB + sM) * ms * _tsun[2];

    const sR2 = Math.exp(-eR * dt), sG2 = Math.exp(-eG * dt), sB2 = Math.exp(-eB * dt);
    out[0] += tr * contribR * (1 - sR2) / Math.max(eR, 1e-9);
    out[1] += tg * contribG * (1 - sG2) / Math.max(eG, 1e-9);
    out[2] += tb * contribB * (1 - sB2) / Math.max(eB, 1e-9);
    tr *= sR2; tg *= sG2; tb *= sB2;
  }

  _tview[0] = tr; _tview[1] = tg; _tview[2] = tb;
  return out;
}

/** Transmitância acumulada da última chamada de cpuSkyRadiance. */
export function cpuLastViewTransmittance() { return _tview; }
