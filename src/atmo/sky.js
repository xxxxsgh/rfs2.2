import * as THREE from 'three';
import { hexToLinear } from '../planet/biomes.js';
import {
  makeAtmosphereParams,
  ScatteringLUTs,
  SCATTERING_CHUNK,
  registerScatteringChunk,
  createAtmoUniforms,
  applyAtmoUniforms,
  cpuTransmittance,
  cpuSkyRadiance,
} from './scattering.js';

/**
 * CÉU E ESPALHAMENTO ATMOSFÉRICO.
 *
 * ── Onde o céu é desenhado, e por quê ───────────────────────────────────────
 * O céu NÃO é um domo pintado no `farScene`. Ele é uma casca esférica real de
 * raio `R * 1.06` (contrato §7), centrada no planeta, desenhada na `scene`
 * próxima. A razão é que uma única malha resolve os dois casos que o crítico
 * olha:
 *
 *   • DE DENTRO — a câmera está dentro da esfera, então a face traseira cobre
 *     a tela inteira e vira o céu. O teste de profundidade contra o terreno
 *     recorta sozinho a linha do horizonte, incluindo montanhas.
 *   • DE FORA (órbita) — a mesma malha ocupa só o disco do planeta mais o anel
 *     de atmosfera no limbo. O anel APARECE porque o terreno não escreve
 *     profundidade além da silhueta geométrica: exatamente o "aro" azul que
 *     denuncia um planeta com ar.
 *
 * Um domo no `farScene` não conseguiria nenhuma das duas coisas: ele é sempre
 * renderizado ANTES e com a profundidade limpa, ou seja, sempre atrás de tudo —
 * nunca poderia sobrepor o limbo do planeta. No `farScene` ficam apenas os
 * discos solares, que de fato pertencem ao infinito e devem ser ocultados pelo
 * planeta. Ambos escrevem com `depthWrite: false` e `renderOrder` explícito,
 * para nunca apagarem luas e planetas que o módulo `universe` desenha lá.
 *
 * ── Por que DOIS passes na casca ────────────────────────────────────────────
 * Compor atmosfera sobre o fundo exige `L = fundo * T + inscatter`, com T
 * espectral (o pôr do sol avermelha o disco solar porque T.b << T.r). Blending
 * alfa só sabe multiplicar por um escalar. Então:
 *   passe A — blending multiplicativo, escreve T (uma leitura de LUT, barato);
 *   passe B — blending aditivo, escreve o in-scattering (raymarch).
 * O resultado é a composição fisicamente correta, e as estrelas somem do céu
 * diurno sozinhas, sem hack.
 *
 * ── Ciclo dia/noite ─────────────────────────────────────────────────────────
 * O terreno não gira (é gerado no referencial do corpo), então quem gira é o
 * sol. A trajetória é resolvida no referencial LOCAL do jogador: nasce no leste
 * geográfico (definido pelo eixo de rotação do corpo), cruza o céu e se põe no
 * oeste. Isso mantém a hora do dia legível em qualquer latitude — necessário
 * porque as poses canônicas de captura escolhem pontos arbitrários da esfera.
 */

export const id = 'sky';
export const order = 40;

// ── Constantes de sintonia ──────────────────────────────────────────────────

/** Irradiância solar no topo da atmosfera, em unidades HDR do motor. */
const SUN_IRRADIANCE = 14.0;
/** Radiância do disco solar. Muito acima de 1 para o bloom do postfx pegar. */
const SUN_DISC_RADIANCE = 130.0;
/** Intensidade base da luz direcional entregue ao módulo `lighting`. */
const SUN_LIGHT_INTENSITY = 3.6;
/** Distância do quad solar dentro do farScene (near=1, far=1e7). */
const SUN_DISTANCE = 6.0e6;
/** Fração do quad ocupada pelo disco; o resto é espaço para o halo. */
const SUN_DISC_FRAC = 0.2;
/** Aumento artístico do tamanho angular — o sol real é pequeno demais. */
const SUN_ANGULAR_BOOST = 2.1;
/** Duração padrão de um dia, em segundos. */
const DEFAULT_DAY_LENGTH = 1200;

// ── Estado do módulo (temporários reutilizados: zero alocação por frame) ─────

const _up = new THREE.Vector3(0, 1, 0);
const _east = new THREE.Vector3(1, 0, 0);
const _north = new THREE.Vector3(0, 0, 1);
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _centerLocal = new THREE.Vector3();
const _radiance = [0, 0, 0];
const _radiance2 = [0, 0, 0];
const _trans = [0, 0, 0];
/** Transmitância do sol PRIMÁRIO — guardada à parte porque `_trans` é
 *  reaproveitado pelo cálculo do segundo sol antes do rebote do solo. */
const _transSun = [1, 1, 1];
const _starLin = [0, 0, 0];

const S = {
  ctx: null,
  luts: null,
  params: null,
  body: null,
  bodyId: null,
  axis: new THREE.Vector3(0, 1, 0),
  tilt: 0,
  binaryPhase: 0,
  binaryTilt: 0,

  dayFraction: 0.28,
  dayLength: DEFAULT_DAY_LENGTH,

  uniforms: null,
  shellGeom: null,
  shellT: null,        // passe multiplicativo (transmitância)
  shellS: null,        // passe aditivo (in-scattering)
  sunMesh: null,
  sunMesh2: null,
  sunUniforms: null,
  sunUniforms2: null,

  // Grandezas publicadas
  sunDirection: new THREE.Vector3(0, 1, 0),
  sunDirection2: new THREE.Vector3(0, -1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  sunColor2: new THREE.Color(1, 1, 1),
  sunIntensity: SUN_LIGHT_INTENSITY,
  sunIntensity2: 0,
  sunElev: 1,
  sunAngular: 0.0047 * SUN_ANGULAR_BOOST,
  sunAngular2: 0.0047 * SUN_ANGULAR_BOOST,
  sunDiscScale: SUN_DISC_RADIANCE,
  sunDiscScale2: 0,
  sunIrradiance: new THREE.Vector3(SUN_IRRADIANCE, SUN_IRRADIANCE, SUN_IRRADIANCE),
  sunIrradiance2: new THREE.Vector3(0, 0, 0),
  ambientTop: new THREE.Color(0.1, 0.14, 0.24),
  ambientBottom: new THREE.Color(0.05, 0.05, 0.05),
  fogColor: new THREE.Color(0.5, 0.6, 0.8),
  fogDensity: 0,
  starColor: new THREE.Color(1, 1, 1),
  starColor2: new THREE.Color(1, 0.7, 0.5),
  /** Cor CRUA da estrela para o disco. O avermelhamento do poente vem do passe
   *  multiplicativo da casca — aplicar a transmitância aqui também pintaria o
   *  sol duas vezes e ele ficaria marrom. */
  starDisc: new THREE.Color(1, 1, 1),
  starDisc2: new THREE.Color(1, 1, 1),

  radiusAlt: Infinity,     // altura acima do datum (m)
  inAtmosphere: false,
  hasPlanet: false,
  lutMs: 0,
};

// ────────────────────────────────────────────────────────────────────────────
// Shaders
// ────────────────────────────────────────────────────────────────────────────

const SHELL_VERT = /* glsl */`
varying vec3 vWorld;
// <common> traz isPerspectiveMatrix(), exigido por <logdepthbuf_vertex>.
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const SHELL_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
uniform vec3 uPlanetCenter;
uniform float uSkyExposure;
#include <logdepthbuf_pars_fragment>
${SCATTERING_CHUNK}

void main() {
  vec3 roR = (cameraPosition - uPlanetCenter) / uAtmoRadius;
  vec3 rd = normalize(vWorld - cameraPosition);

#ifdef AETHER_PASS_TRANSMITTANCE
  // Quanto do fundo (estrelas, sol, luas) sobrevive à travessia.
  vec3 hit = aetherSphere(roR, rd, uAtmoGeom.y);
  if (hit.z < 0.0 || hit.y <= 0.0) discard;
  vec3 Tv;
  if (aetherGroundHit(roR, rd) > 0.0) {
    Tv = vec3(0.0);                       // o corpo sólido bloqueia o fundo
  } else {
    vec3 s = roR + rd * max(hit.x, 0.0);
    float rr = max(length(s), uAtmoGeom.x);
    Tv = aetherTransmittance(rr, dot(s, rd) / rr);
  }
  gl_FragColor = vec4(Tv, 1.0);
#else
  vec3 inscat, Tv;
  if (!aetherSky(roR, rd, inscat, Tv)) discard;
  gl_FragColor = vec4(max(inscat, vec3(0.0)) * uSkyExposure, 1.0);
#endif

  #include <logdepthbuf_fragment>
}
`;

/**
 * Disco solar: escurecimento de limbo (o disco é mais escuro na borda porque
 * ali enxergamos camadas mais altas e frias da fotosfera) mais um halo curto.
 * O halo largo é trabalho do bloom; aqui só garantimos que não haja um corte
 * duro entre o disco e o céu.
 */
const SUN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SUN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uDiscFrac;
uniform float uLimb;
uniform float uHalo;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float x = d / max(uDiscFrac, 1e-4);

  float fw = max(fwidth(x), 1e-4);
  float core = 1.0 - smoothstep(1.0 - fw * 1.5, 1.0 + fw * 1.5, x);
  float mu = sqrt(max(0.0, 1.0 - min(x, 1.0) * min(x, 1.0)));
  float limb = 1.0 - uLimb * (1.0 - mu);

  // Halo de Mie próximo ao disco: decai rápido, some antes da borda do quad.
  float halo = uHalo * (0.55 / (1.0 + 12.0 * max(x - 1.0, 0.0) * max(x - 1.0, 0.0))
             + 0.10 / (1.0 + 1.6 * x * x));
  halo *= smoothstep(1.0, 0.45, d);

  vec3 col = uColor * (core * limb) + uColor * halo;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;
  registerScatteringChunk();

  const renderer = ctx.engine.renderer;
  S.luts = new ScatteringLUTs(renderer);
  S.uniforms = createAtmoUniforms();
  S.uniforms.uAtmoTrans.value = S.luts.transmittance;
  S.uniforms.uAtmoMulti.value = S.luts.multiScatter;
  S.uniforms.uPlanetCenter = { value: new THREE.Vector3() };
  S.uniforms.uSkyExposure = { value: 1.0 };

  // Passos do raymarch conforme o preset — o céu é fullscreen, é o que mais
  // custa; em `low` 10 passos ainda dão gradiente sem banding graças à
  // integração analítica por segmento.
  const preset = ctx.quality?.preset || 'high';
  const steps = preset === 'low' ? 10 : preset === 'medium' ? 16 : preset === 'ultra' ? 32 : 24;

  S.shellGeom = new THREE.SphereGeometry(1, 64, 32);

  const matT = new THREE.ShaderMaterial({
    uniforms: S.uniforms,
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    defines: { AETHER_PASS_TRANSMITTANCE: '' },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,      // dst *= T  (espectral, por canal)
    blendEquation: THREE.AddEquation,
    // Alfa intocado: o alvo HDR usa o canal para outras coisas.
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
  });

  const matS = new THREE.ShaderMaterial({
    uniforms: S.uniforms,
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    defines: { AETHER_SKY_STEPS: steps },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,           // dst += in-scattering
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
  });

  S.shellT = new THREE.Mesh(S.shellGeom, matT);
  S.shellS = new THREE.Mesh(S.shellGeom, matS);
  S.shellT.name = 'sky:extinction';
  S.shellS.name = 'sky:inscatter';
  // Depois das nuvens e de qualquer transparência de superfície: a atmosfera é
  // a última camada de ar entre a cena e a câmera.
  S.shellT.renderOrder = 1200;
  S.shellS.renderOrder = 1201;
  S.shellT.matrixAutoUpdate = true;
  S.shellS.matrixAutoUpdate = true;
  ctx.engine.scene.add(S.shellT);
  ctx.engine.scene.add(S.shellS);

  // ── Discos solares no farScene ────────────────────────────────────────────
  const sunGeom = new THREE.PlaneGeometry(1, 1);
  S.sunUniforms = makeSunUniforms();
  S.sunUniforms2 = makeSunUniforms();
  S.sunMesh = makeSunMesh(sunGeom, S.sunUniforms, 'sky:sun');
  S.sunMesh2 = makeSunMesh(sunGeom, S.sunUniforms2, 'sky:sun2');
  S.sunMesh2.visible = false;
  ctx.engine.farScene.add(S.sunMesh);
  ctx.engine.farScene.add(S.sunMesh2);

  // Já configura com o planeta ativo (o módulo `planet` inicializa antes, mas
  // pode ainda não ter corpo — nesse caso ficamos em modo espaço profundo).
  syncBody(ctx, true);

  ctx.provide(id, api);
  ctx.progress?.(0.62, 'espalhamento atmosférico…');
}

function makeSunUniforms() {
  return {
    uColor: { value: new THREE.Vector3(1, 1, 1) },
    uDiscFrac: { value: SUN_DISC_FRAC },
    uLimb: { value: 0.62 },
    uHalo: { value: 0.05 },
  };
}

function makeSunMesh(geom, uniforms, name) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SUN_VERT,
    fragmentShader: SUN_FRAG,
    transparent: true,
    depthWrite: false,      // nunca apaga luas/planetas do universe
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const m = new THREE.Mesh(geom, mat);
  m.name = name;
  m.renderOrder = 20;       // depois do campo estelar, antes de qualquer HUD 3D
  m.frustumCulled = false;
  return m;
}

// ────────────────────────────────────────────────────────────────────────────
// Update
// ────────────────────────────────────────────────────────────────────────────

export function update(dt, ctx) {
  // 1. Relógio do planeta.
  if (S.dayLength > 0) {
    S.dayFraction = (S.dayFraction + dt / S.dayLength) % 1;
    if (S.dayFraction < 0) S.dayFraction += 1;
  }
  ctx.time.dayFraction = S.dayFraction;

  // 2. Corpo ativo (troca de planeta recomputa LUTs).
  syncBody(ctx, false);

  // 3. Referencial local e direção do sol.
  updateSunGeometry(ctx);

  // 4. Cores derivadas da atmosfera (CPU, poucas amostras).
  updateRadiometry(ctx);

  // 5. Névoa do terreno e eventos de entrada/saída de atmosfera.
  writeFogUniforms(ctx);
  updateAtmoEvents(ctx);

  if (ctx.debug.enabled) {
    ctx.debug.set('sky.dia', S.dayFraction.toFixed(3));
    ctx.debug.set('sky.altitude', Number.isFinite(S.radiusAlt) ? Math.round(S.radiusAlt) + ' m' : '∞');
    ctx.debug.set('sky.elevacaoSol', (Math.asin(clamp(S.sunElev, -1, 1)) * 57.2958).toFixed(1) + '°');
    ctx.debug.set('sky.atmosfera', S.inAtmosphere ? 'dentro' : 'fora');
    ctx.debug.set('sky.lutMs', S.lutMs.toFixed(1));
  }
}

/**
 * Posicionamento acontece em lateUpdate porque a origem flutuante só se move
 * depois de todos os `update` — escrever antes provocaria um salto de 2 km.
 */
export function lateUpdate(dt, ctx) {
  const body = S.body;
  if (body) {
    ctx.frame.toLocal(body.center, _centerLocal);
    const rTop = S.params.top;
    S.shellT.position.copy(_centerLocal);
    S.shellS.position.copy(_centerLocal);
    S.shellT.scale.setScalar(rTop);
    S.shellS.scale.setScalar(rTop);
    S.uniforms.uPlanetCenter.value.copy(_centerLocal);
  }

  // Direções de sol e irradiâncias vão para os uniforms compartilhados —
  // terreno e água leem o MESMO conjunto, senão a perspectiva aérea diverge.
  S.uniforms.uAtmoSunDir.value.copy(S.sunDirection);
  S.uniforms.uAtmoSunIrr.value.copy(S.sunIrradiance);
  S.uniforms.uAtmoSunDir2.value.copy(S.sunDirection2);
  S.uniforms.uAtmoSunIrr2.value.copy(S.sunIrradiance2);

  // Discos solares: o farScene tem a câmera na origem, então basta projetar a
  // direção numa distância fixa dentro do frustum.
  placeSun(S.sunMesh, S.sunUniforms, S.sunDirection, S.starDisc, S.sunAngular, S.sunDiscScale);
  if (S.sunMesh2.visible) {
    placeSun(S.sunMesh2, S.sunUniforms2, S.sunDirection2, S.starDisc2, S.sunAngular2, S.sunDiscScale2);
  }
}

function placeSun(mesh, uniforms, dir, color, angular, discScale) {
  const half = SUN_DISTANCE * Math.tan(angular) / SUN_DISC_FRAC;
  mesh.position.copy(dir).multiplyScalar(SUN_DISTANCE);
  mesh.scale.set(half * 2, half * 2, 1);
  mesh.lookAt(0, 0, 0);
  uniforms.uColor.value.set(color.r * discScale, color.g * discScale, color.b * discScale);
}

// ────────────────────────────────────────────────────────────────────────────
// Corpo ativo e parâmetros atmosféricos
// ────────────────────────────────────────────────────────────────────────────

function syncBody(ctx, force) {
  const body = ctx.planet?.current || null;
  const bid = body ? (body.id ?? body.name ?? 'body') : null;
  if (!force && bid === S.bodyId) return;

  S.body = body;
  S.bodyId = bid;
  S.hasPlanet = !!body;

  const biome = body?.biome || null;
  const radius = body?.radius || 150000;
  const albedo = biome?.palette?.midland !== undefined
    ? hexToLinear(biome.palette.midland)
    : [0.2, 0.2, 0.2];

  S.params = makeAtmosphereParams(biome, radius, { groundAlbedo: albedo });
  applyAtmoUniforms(S.uniforms, S.params);

  try {
    if (S.luts.update(S.params)) S.lutMs = S.luts.lastCostMs;
  } catch (e) {
    // Degradação graciosa: sem LUT o céu fica plano, mas o jogo continua.
    ctx.debug.set('sky.erro', 'LUT: ' + (e && e.message ? e.message : e));
  }

  // Eixo de rotação e obliquidade: determinísticos por corpo.
  const seed = (body?.seed ?? 0) | 0;
  const rng = ctx.rng.derive('sky:body', seed);
  const t = rng.range(-0.42, 0.42);
  const az = rng.range(0, Math.PI * 2);
  S.axis.set(Math.sin(t) * Math.cos(az), Math.cos(t), Math.sin(t) * Math.sin(az)).normalize();
  S.tilt = rng.range(-0.30, 0.30);
  S.dayLength = body ? rng.range(700, 1900) : DEFAULT_DAY_LENGTH;

  const bin = ctx.rng.derive('sky:binary', seed);
  S.binaryPhase = bin.range(0.10, 0.34) * Math.PI * 2;
  S.binaryTilt = bin.range(-0.45, 0.45);

  S.shellT.visible = S.hasPlanet;
  S.shellS.visible = S.hasPlanet;

  if (S.params && ctx.debug) ctx.debug.set('sky.atmoKm', (S.params.thickness / 1000).toFixed(1));
}

// ────────────────────────────────────────────────────────────────────────────
// Geometria solar
// ────────────────────────────────────────────────────────────────────────────

function updateSunGeometry(ctx) {
  const body = S.body;
  const star = ctx.system?.star || null;
  const star2 = ctx.system?.star2 || null;

  // Vertical local. Sem planeta, usa o "para cima" declarado pelo jogador.
  if (body) {
    _up.set(
      ctx.player.position.x - body.center.x,
      ctx.player.position.y - body.center.y,
      ctx.player.position.z - body.center.z,
    );
    const r = _up.length();
    S.radiusAlt = r - body.radius;
    if (r > 1e-6) _up.multiplyScalar(1 / r); else _up.set(0, 1, 0);
  } else {
    _up.copy(ctx.player.up).normalize();
    if (_up.lengthSq() < 0.5) _up.set(0, 1, 0);
    S.radiusAlt = Infinity;
  }

  // Leste geográfico = eixo de rotação × vertical. Nos polos degenera; aí
  // qualquer tangente estável serve.
  _east.crossVectors(S.axis, _up);
  if (_east.lengthSq() < 1e-8) {
    _tmpA.set(Math.abs(_up.y) > 0.92 ? 1 : 0, Math.abs(_up.y) > 0.92 ? 0 : 1, 0);
    _east.crossVectors(_tmpA, _up);
  }
  _east.normalize();
  _north.crossVectors(_up, _east).normalize();

  // theta = 0 no nascer, PI/2 no zênite, PI no poente.
  const theta = (S.dayFraction - 0.25) * Math.PI * 2;
  sunFromLocal(S.sunDirection, Math.sin(theta), Math.cos(theta), S.tilt);
  S.sunElev = S.sunDirection.dot(_up);

  // Segundo sol: mesma mecânica, defasado — dá duas sombras e dois nasceres.
  const hasBinary = !!star2;
  S.sunMesh2.visible = hasBinary;
  if (hasBinary) {
    const t2 = theta + S.binaryPhase;
    sunFromLocal(S.sunDirection2, Math.sin(t2), Math.cos(t2), S.binaryTilt);
  } else {
    S.sunDirection2.copy(S.sunDirection).negate();
  }

  // Sem planeta, o sol é a estrela de verdade: aponta para ela.
  if (!body && star?.position) {
    _tmpA.set(
      star.position.x - ctx.player.position.x,
      star.position.y - ctx.player.position.y,
      star.position.z - ctx.player.position.z,
    );
    if (_tmpA.lengthSq() > 1e-6) S.sunDirection.copy(_tmpA).normalize();
    S.sunElev = 1;
  }

  // Tamanho angular real: raio da estrela sobre a distância.
  S.sunAngular = angularRadius(ctx, star, body) * SUN_ANGULAR_BOOST;
  S.sunAngular2 = angularRadius(ctx, star2, body) * SUN_ANGULAR_BOOST;
}

/** dir = (up*sinT + east*cosT) inclinado de `tilt` em direção ao norte local. */
function sunFromLocal(out, sinT, cosT, tilt) {
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  out.set(0, 0, 0)
    .addScaledVector(_up, sinT * ct)
    .addScaledVector(_east, cosT * ct)
    .addScaledVector(_north, st)
    .normalize();
  return out;
}

function angularRadius(ctx, star, body) {
  if (!star) return 0.0047;
  const sr = star.radius || 6.96e8;
  let d = 0;
  const from = body?.center || ctx.player.position;
  if (star.position) {
    const dx = star.position.x - from.x;
    const dy = star.position.y - from.y;
    const dz = star.position.z - from.z;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  if (!(d > sr)) return 0.0047;
  return clamp(sr / d, 0.0015, 0.055);
}

/** Fator de irradiância relativo: luminosidade sobre distância ao quadrado. */
function irradianceFactor(ctx, star, body) {
  if (!star) return 1;
  const lum = star.luminosity || 1;
  let d = 0;
  const from = body?.center || ctx.player.position;
  if (star.position) {
    const dx = star.position.x - from.x;
    const dy = star.position.y - from.y;
    const dz = star.position.z - from.z;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  if (!(d > 0)) return clamp(lum, 0.35, 3);
  const au = ctx.UNITS?.AU || 1.2e9;
  return clamp(lum / Math.max(0.02, (d / au) * (d / au)), 0.35, 3);
}

// ────────────────────────────────────────────────────────────────────────────
// Radiometria (CPU): cor do sol, do zênite, do chão e da névoa
// ────────────────────────────────────────────────────────────────────────────

function updateRadiometry(ctx) {
  const p = S.params;
  const star = ctx.system?.star || null;
  const star2 = ctx.system?.star2 || null;

  readStarColor(star, S.starColor, 1.0);
  readStarColor(star2, S.starColor2, 0.85);
  normMax(S.starColor, S.starDisc);
  normMax(S.starColor2, S.starDisc2);

  const f1 = irradianceFactor(ctx, star, S.body);
  const f2 = star2 ? irradianceFactor(ctx, star2, S.body) * 0.45 : 0;

  // Irradiância espectral: cor da estrela normalizada em luminância para que
  // uma estrela vermelha não seja também mais escura duas vezes.
  normLuminance(S.starColor, _starLin);
  S.sunIrradiance.set(
    _starLin[0] * SUN_IRRADIANCE * f1,
    _starLin[1] * SUN_IRRADIANCE * f1,
    _starLin[2] * SUN_IRRADIANCE * f1,
  );
  if (star2) {
    normLuminance(S.starColor2, _starLin);
    S.sunIrradiance2.set(
      _starLin[0] * SUN_IRRADIANCE * f2,
      _starLin[1] * SUN_IRRADIANCE * f2,
      _starLin[2] * SUN_IRRADIANCE * f2,
    );
  } else {
    S.sunIrradiance2.set(0, 0, 0);
  }

  // Raio normalizado do observador (unidades de raio planetário).
  const rNorm = S.hasPlanet
    ? clamp(1 + Math.max(0, S.radiusAlt) / p.radius, 1.0000001, p.nTop - 1e-6)
    : p.nTop - 1e-6;
  const muS = S.hasPlanet ? clamp(S.sunElev, -1, 1) : 1;

  // ── Cor do sol: transmitância até o observador ────────────────────────────
  if (S.hasPlanet && muS > -0.35) {
    cpuTransmittance(p, rNorm, muS, _trans);
  } else {
    _trans[0] = _trans[1] = _trans[2] = S.hasPlanet ? 0 : 1;
  }
  _transSun[0] = _trans[0]; _transSun[1] = _trans[1]; _transSun[2] = _trans[2];
  const tr = _trans[0] * S.starColor.r;
  const tg = _trans[1] * S.starColor.g;
  const tb = _trans[2] * S.starColor.b;
  const tmax = Math.max(tr, tg, tb, 1e-5);
  // Matiz preservado, brilho no `sunIntensity`: é assim que o módulo lighting
  // consegue um pôr do sol laranja sem precisar entender atmosfera.
  S.sunColor.setRGB(tr / tmax, tg / tmax, tb / tmax);
  const lumT = 0.2126 * _trans[0] + 0.7152 * _trans[1] + 0.0722 * _trans[2];
  S.sunIntensity = SUN_LIGHT_INTENSITY * f1 * clamp(lumT, 0, 1) * smoothFade(muS);
  S.sunDiscScale = SUN_DISC_RADIANCE * f1;

  if (star2) {
    S.sunColor2.copy(S.starColor2);
    const muS2 = S.hasPlanet ? clamp(S.sunDirection2.dot(_up), -1, 1) : 1;
    if (S.hasPlanet && muS2 > -0.35) {
      cpuTransmittance(p, rNorm, muS2, _trans);
      const l2 = 0.2126 * _trans[0] + 0.7152 * _trans[1] + 0.0722 * _trans[2];
      S.sunIntensity2 = SUN_LIGHT_INTENSITY * f2 * clamp(l2, 0, 1) * smoothFade(muS2);
      const m2 = Math.max(_trans[0] * S.starColor2.r, _trans[1] * S.starColor2.g, _trans[2] * S.starColor2.b, 1e-5);
      S.sunColor2.setRGB(
        _trans[0] * S.starColor2.r / m2,
        _trans[1] * S.starColor2.g / m2,
        _trans[2] * S.starColor2.b / m2,
      );
    } else {
      S.sunIntensity2 = S.hasPlanet ? 0 : SUN_LIGHT_INTENSITY * f2;
    }
    S.sunDiscScale2 = SUN_DISC_RADIANCE * f2;
  } else {
    S.sunIntensity2 = 0;
    S.sunDiscScale2 = 0;
  }

  if (!S.hasPlanet) {
    // Espaço profundo: sem ar não há céu; só a estrela e o rebote do vácuo.
    S.ambientTop.setRGB(0.006, 0.008, 0.014);
    S.ambientBottom.setRGB(0.004, 0.005, 0.010);
    S.fogColor.setRGB(0, 0, 0);
    S.fogDensity = 0;
    return;
  }

  // ── Céu: zênite e horizonte ───────────────────────────────────────────────
  // Zênite: visada para cima, então nu = muS.
  cpuSkyRadiance(p, rNorm, 1, muS, muS, _radiance);
  const e1 = S.sunIrradiance;
  S.ambientTop.setRGB(
    clamp(_radiance[0] * e1.x, 0, 12),
    clamp(_radiance[1] * e1.y, 0, 12),
    clamp(_radiance[2] * e1.z, 0, 12),
  );

  // Horizonte: média entre o lado do sol e o oposto. O cosseno é limitado a
  // 0.6 de propósito — apontar exatamente para o sol cairia no pico frontal do
  // Mie (a auréola), que é 20x mais brilhante que o céu médio e faria a névoa
  // do terreno estourar em branco.
  const sinS = Math.sqrt(Math.max(0, 1 - muS * muS));
  cpuSkyRadiance(p, rNorm, 0.02, muS, Math.min(sinS, 0.6), _radiance);
  cpuSkyRadiance(p, rNorm, 0.02, muS, -sinS, _radiance2);
  const mixSun = 0.6;
  const hr = _radiance[0] * mixSun + _radiance2[0] * (1 - mixSun);
  const hg = _radiance[1] * mixSun + _radiance2[1] * (1 - mixSun);
  const hb = _radiance[2] * mixSun + _radiance2[2] * (1 - mixSun);
  S.fogColor.setRGB(
    clamp(hr * e1.x + NIGHT_GLOW[0] * p.density, 0, 8),
    clamp(hg * e1.y + NIGHT_GLOW[1] * p.density, 0, 8),
    clamp(hb * e1.z + NIGHT_GLOW[2] * p.density, 0, 8),
  );

  // ── Luz de rebote do chão ─────────────────────────────────────────────────
  // Irradiância no solo = sol direto + hemisfério de céu; devolvida pela
  // albedo do bioma. É o que dá a luz colorida vinda de baixo (critério §8.7).
  const alb = p.groundAlbedo;
  const sunOnGround = Math.max(0, muS);
  const irrR = e1.x * _transSun[0] * sunOnGround + S.ambientTop.r * Math.PI * 0.6;
  const irrG = e1.y * _transSun[1] * sunOnGround + S.ambientTop.g * Math.PI * 0.6;
  const irrB = e1.z * _transSun[2] * sunOnGround + S.ambientTop.b * Math.PI * 0.6;
  S.ambientBottom.setRGB(
    clamp(alb[0] * irrR / Math.PI, 0, 8),
    clamp(alb[1] * irrG / Math.PI, 0, 8),
    clamp(alb[2] * irrB / Math.PI, 0, 8),
  );
}

/** Suaviza o mergulho do sol abaixo do horizonte — sem corte na luz direta. */
function smoothFade(mu) { return clamp((mu + 0.06) / 0.14, 0, 1); }

function readStarColor(star, out, fallbackWarm) {
  if (!star) { out.setRGB(1, fallbackWarm, fallbackWarm * 0.8); return out; }
  const c = star.color;
  if (c && c.isColor) out.copy(c);
  else if (typeof c === 'number') out.setHex(c, THREE.SRGBColorSpace);
  else if (typeof c === 'string') out.set(c);
  else out.setRGB(1, 0.97, 0.92);
  return out;
}

/** Normaliza pelo canal máximo (mantém o matiz, satura o brilho em 1). */
function normMax(c, out) {
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  return out.setRGB(c.r / m, c.g / m, c.b / m);
}

/** Normaliza a cor em luminância, preservando matiz. */
function normLuminance(c, out) {
  const l = Math.max(1e-4, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  out[0] = c.r / l; out[1] = c.g / l; out[2] = c.b / l;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Integração com o terreno e eventos
// ────────────────────────────────────────────────────────────────────────────

function writeFogUniforms(ctx) {
  const fu = ctx.planet?.fogUniforms;
  if (!fu) return;

  // Densidade decai com a altitude para que a névoa suma sozinha na subida —
  // é a metade "terreno" da transição contínua espaço↔superfície.
  const base = S.body?.biome?.sky?.fogDensity ?? 0.00005;
  const h = Number.isFinite(S.radiusAlt) ? Math.max(0, S.radiusAlt) : Infinity;
  S.fogDensity = S.hasPlanet && Number.isFinite(h)
    ? base * Math.exp(-h / Math.max(1, S.params.hR))
    : 0;

  setUniformColor(fu.uFogColor, S.fogColor);
  setUniformNumber(fu.uFogDensity, S.fogDensity);
  setUniformVec3(fu.uSunDir, S.sunDirection);
  setUniformColor(fu.uSunColor, S.sunColor);
  // Extras opcionais: só escreve se o terreno tiver declarado.
  setUniformColor(fu.uSkyAmbient, S.ambientTop);
  setUniformColor(fu.uGroundAmbient, S.ambientBottom);
  setUniformNumber(fu.uSunIntensity, S.sunIntensity);
}

function setUniformColor(u, color) {
  if (!u) return;
  const v = u.value;
  if (!v) { u.value = color.clone(); return; }
  if (v.isColor) v.copy(color);
  else if (v.isVector3) v.set(color.r, color.g, color.b);
  else if (v.isVector4) v.set(color.r, color.g, color.b, v.w);
  else if (Array.isArray(v) || ArrayBuffer.isView(v)) { v[0] = color.r; v[1] = color.g; v[2] = color.b; }
}

function setUniformVec3(u, vec) {
  if (!u) return;
  const v = u.value;
  if (!v) { u.value = vec.clone(); return; }
  if (v.isVector3) v.set(vec.x, vec.y, vec.z);
  else if (v.isColor) v.setRGB(vec.x, vec.y, vec.z);
  else if (Array.isArray(v) || ArrayBuffer.isView(v)) { v[0] = vec.x; v[1] = vec.y; v[2] = vec.z; }
}

function setUniformNumber(u, n) {
  if (!u) return;
  if (typeof u.value === 'number' || u.value === undefined || u.value === null) u.value = n;
}

function updateAtmoEvents(ctx) {
  if (!S.hasPlanet) {
    if (S.inAtmosphere) {
      S.inAtmosphere = false;
      ctx.player.inAtmosphere = false;
      ctx.events.emit('planet:leaveAtmo', { planet: null });
    }
    return;
  }
  const top = S.params.thickness;
  // Histerese: 2% de folga evita disparo repetido voando rente ao limite.
  const enterAt = top * 0.98;
  const leaveAt = top * 1.06;
  const h = S.radiusAlt;
  if (!S.inAtmosphere && h < enterAt) {
    S.inAtmosphere = true;
    ctx.player.inAtmosphere = true;
    ctx.events.emit('planet:enterAtmo', { planet: S.body });
  } else if (S.inAtmosphere && h > leaveAt) {
    S.inAtmosphere = false;
    ctx.player.inAtmosphere = false;
    ctx.events.emit('planet:leaveAtmo', { planet: S.body });
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ────────────────────────────────────────────────────────────────────────────
// API pública (contrato §6)
// ────────────────────────────────────────────────────────────────────────────

const api = {
  /** Hora do dia normalizada: 0 = meia-noite, 0.25 nascer, 0.5 zênite, 0.75 poente. */
  setTimeOfDay(frac) {
    if (!Number.isFinite(frac)) return;
    S.dayFraction = ((frac % 1) + 1) % 1;
    if (S.ctx) {
      S.ctx.time.dayFraction = S.dayFraction;
      // Recalcula na hora para que uma captura logo após o setTimeOfDay já
      // enxergue o sol no lugar certo, sem esperar o próximo frame.
      updateSunGeometry(S.ctx);
      updateRadiometry(S.ctx);
      writeFogUniforms(S.ctx);
    }
  },
  getTimeOfDay() { return S.dayFraction; },
  /** Duração do dia em segundos (0 congela o ciclo). */
  setDayLength(sec) { S.dayLength = Math.max(0, sec || 0); },

  get sunDirection() { return S.sunDirection; },
  get sunColor() { return S.sunColor; },
  get sunIntensity() { return S.sunIntensity; },
  get sunDirection2() { return S.sunDirection2; },
  get sunColor2() { return S.sunColor2; },
  get sunIntensity2() { return S.sunIntensity2; },
  get hasSecondSun() { return S.sunIntensity2 > 0; },

  /** Radiância do zênite — luz ambiente vinda de cima. */
  get ambientTop() { return S.ambientTop; },
  /** Rebote colorido do solo — luz ambiente vinda de baixo. */
  get ambientBottom() { return S.ambientBottom; },
  get fogColor() { return S.fogColor; },
  get fogDensity() { return S.fogDensity; },

  get inAtmosphere() { return S.inAtmosphere; },
  /** Altura do topo da atmosfera acima do datum, em metros. */
  get atmosphereThickness() { return S.params ? S.params.thickness : 0; },
  get params() { return S.params; },

  /** Exposição artística do céu (1 = física). */
  setExposure(v) { if (S.uniforms) S.uniforms.uSkyExposure.value = Math.max(0, v); },

  /**
   * GLSL para outros shaders (terreno, água, nuvens) amostrarem as MESMAS LUTs.
   * Uso: `material.uniforms = {...ctx.sky.getScatteringUniforms(), ...meus}` e
   * `#include <aether_scattering>` no fragment.
   */
  getScatteringChunk() { return SCATTERING_CHUNK; },
  getScatteringUniforms() { return S.uniforms; },
  get transmittanceLUT() { return S.luts ? S.luts.transmittance : null; },
  get multiScatterLUT() { return S.luts ? S.luts.multiScatter : null; },

  /**
   * Cor do céu numa direção de mundo (CPU). Útil para reflexos de água e para
   * o HUD; não use por pixel.
   */
  sampleSkyColor(dir, out) {
    const target = out || new THREE.Color();
    if (!S.params || !S.hasPlanet) return target.setRGB(0.004, 0.005, 0.01);
    const p = S.params;
    const r = clamp(1 + Math.max(0, S.radiusAlt) / p.radius, 1.0000001, p.nTop - 1e-6);
    const mu = clamp(dir.dot(_up), -1, 1);
    const muS = clamp(S.sunElev, -1, 1);
    const nu = clamp(dir.dot(S.sunDirection), -1, 1);
    cpuSkyRadiance(p, r, mu, muS, nu, _radiance);
    return target.setRGB(
      clamp(_radiance[0] * S.sunIrradiance.x, 0, 12),
      clamp(_radiance[1] * S.sunIrradiance.y, 0, 12),
      clamp(_radiance[2] * S.sunIrradiance.z, 0, 12),
    );
  },
};

export function dispose(ctx) {
  if (S.shellT) { ctx.engine.scene.remove(S.shellT); S.shellT.material.dispose(); }
  if (S.shellS) { ctx.engine.scene.remove(S.shellS); S.shellS.material.dispose(); }
  if (S.shellGeom) S.shellGeom.dispose();
  if (S.sunMesh) { ctx.engine.farScene.remove(S.sunMesh); S.sunMesh.material.dispose(); S.sunMesh.geometry.dispose(); }
  if (S.sunMesh2) { ctx.engine.farScene.remove(S.sunMesh2); S.sunMesh2.material.dispose(); }
  if (S.luts) S.luts.dispose();
  S.luts = null;
}

// TEMP-HARNESS
export function __luts() { return S.luts; }
