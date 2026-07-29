import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { makeName } from '../core/rng.js';
import { Noise, clamp, saturate, lerp, smoothstep } from '../noise/noise.js';
import { pickBiome, variateBiome, BIOME_BY_ID, hsvToRgb } from '../planet/biomes.js';
import {
  makeStar, starLabel, zoneOfAU, STAR_CLASSES, blackbodyRGBFast,
} from './starclass.js';

/**
 * UNIVERSO PROCEDURAL — a galáxia, os sistemas e as órbitas.
 *
 * ── Como a escala funciona aqui ──────────────────────────────────────────────
 * O jogo é um universo COMPRIMIDO (ARCHITECTURE §7): planetas de 80–220 km,
 * separações de 1e8–4e9 m. Aplicar a física real sem tradução colocaria a zona
 * habitável de uma estrela O a 5e10 m — fora do orçamento. A solução é manter
 * TODA a física em unidades naturais (UA, massas e raios solares, luminosidade
 * solar) e aplicar UM único fator de compressão por sistema, `auToM`, calculado
 * para que o sistema inteiro caiba em 4e9 m. Assim as RAZÕES entre as órbitas —
 * que é o que o jogador percebe — continuam corretas, e a classificação de zona
 * ('hot'/'habitable'/'cold') é feita em UA, onde ela é fisicamente exata.
 *
 * ── Precisão ─────────────────────────────────────────────────────────────────
 * A estrela do sistema ATUAL fica sempre na origem do mundo (0,0,0). Quando o
 * jogador salta, o referencial inteiro é trocado. Isso mantém as coordenadas de
 * mundo abaixo de ~4e9 m: float64 ali ainda tem resolução sub-micrométrica.
 * A posição galáctica de cada estrela vive em `galaxy.stars[i].position`, em
 * anos-luz, e serve só ao mapa galáctico.
 *
 * ── Ordem de trabalho por frame ──────────────────────────────────────────────
 * `update`     avança as órbitas (Kepler de verdade) e fatia a geração de
 *              texturas dentro de ctx.budget.
 * `lateUpdate` escreve as posições relativas — depois do rebase da origem.
 */

export const id = 'universe';
export const order = 10;

// ── Constantes de escala ────────────────────────────────────────────────────

/** Unidade astronômica comprimida (igual a UNITS.AU de context.js). */
const AU = 1.2e9;

/**
 * Parâmetro gravitacional de 1 massa solar em unidades do jogo, calibrado para
 * que uma órbita de 1 UA comprimida (1,2e9 m) dure exatamente 1 ano sideral.
 * GM = 4π²a³/T², com a = 1,2e9 m e T = 3,156e7 s.
 */
const GM_SOLAR = 6.849e13;
const YEAR = 3.15576e7;

/** Raio de "1 raio solar" no espaço do jogo. Escolhido para que uma G na zona
 *  habitável ocupe ~1,4° do céu — o dobro do Sol real, que é o que dá o peso
 *  visual de No Man's Sky sem virar caricatura. */
const SOLAR_RADIUS = 1.2e7;

/** Limites de um sistema (ARCHITECTURE §7: distância entre planetas 1e8–4e9 m). */
const SYSTEM_OUTER = 4.0e9;
const PLANET_MIN_SEP = 1.1e8;

/** Além disto um corpo vai para a farScene com distância comprimida. */
const NEAR_HANDOFF = 5.0e6;
/**
 * Raio de compressão da farScene. O padrão de toLocalCompressed (5e7) devolve
 * distâncias de ~2e8 para um planeta a 1e9 m — muito além do far=1e7 da
 * farCamera. 2,5e5 mapeia 1e8…1e13 m para 1,5e6…4e6 unidades locais.
 */
const FAR_COMPRESS = 2.5e5;

const STAR_COUNT = 2000;
/** Raio do setor galáctico, em anos-luz. */
const GALAXY_RADIUS = 4200;
const GALAXY_ARMS = 4;
const GALAXY_WINDINGS = 2.35;

/**
 * Nenhuma órbita pode se completar em menos que isto de tempo REAL. Kepler
 * continua exato; só limitamos a taxa de reprodução por corpo. Sem isto, uma lua
 * interna de um gigante gasoso (período ~8 h) giraria como um ponteiro de
 * segundos a 2000×, o que destrói a leitura de escala.
 */
const MIN_REAL_PERIOD = 300;

// ── Temporários de módulo (zero alocação por frame) ─────────────────────────
const _local = { x: 0, y: 0, z: 0 };
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rgb = { r: 0, g: 0, b: 0 };
const _nearest = { body: null, distance: Infinity, surface: Infinity };

let _ctx = null;
let galaxy = null;
let current = null;
const systems = new Map();

// Geometrias compartilhadas — um sistema inteiro custa 4 buffers de vértices.
let GEO_PLANET = null;
let GEO_MOON = null;
let GEO_STAR = null;

// ════════════════════════════════════════════════════════════════════════════
// 1. Mecânica orbital
// ════════════════════════════════════════════════════════════════════════════

/**
 * Anomalia média → anomalia excêntrica, por Newton-Raphson.
 * Com e < 0,1 converge em 2 iterações; usamos 4 por segurança numérica quando
 * o gerador sorteia uma excentricidade alta para um cometa/cinturão.
 */
function solveKepler(M, e) {
  // Normaliza para [-π,π]: melhora muito o chute inicial.
  let m = M % (Math.PI * 2);
  if (m > Math.PI) m -= Math.PI * 2;
  else if (m < -Math.PI) m += Math.PI * 2;
  let E = m + e * Math.sin(m) * (1 + e * Math.cos(m));
  for (let i = 0; i < 4; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    E -= f / fp;
  }
  return E;
}

/**
 * Pré-calcula os dois vetores de base do plano orbital (P aponta ao periastro,
 * Q está 90° adiante). Fazendo isto uma vez na construção, o avanço por frame
 * vira duas multiplicações-acumulação — sem trigonometria de rotação.
 *
 * Convenção: o normal orbital de referência é +Y (a eclíptica é o plano XZ),
 * então os componentes Y e Z da formulação padrão (Z-up) trocam de lugar.
 */
function buildOrbitBasis(o) {
  const cw = Math.cos(o.argPeri), sw = Math.sin(o.argPeri);
  const cO = Math.cos(o.node), sO = Math.sin(o.node);
  const ci = Math.cos(o.inclination), si = Math.sin(o.inclination);
  o.px = cO * cw - sO * sw * ci;
  o.py = sw * si;
  o.pz = sO * cw + cO * sw * ci;
  o.qx = -cO * sw - sO * cw * ci;
  o.qy = cw * si;
  o.qz = -sO * sw + cO * cw * ci;
}

/** Escreve `body.center` a partir de `body.orbit.M` e do centro do pai. */
function evaluateOrbit(body) {
  const o = body.orbit;
  const parent = o.parentBody;
  const cx = parent ? parent.center.x : 0;
  const cy = parent ? parent.center.y : 0;
  const cz = parent ? parent.center.z : 0;
  if (!o.a) { body.center.set(cx, cy, cz); return; }

  const E = solveKepler(o.M, o.e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const xv = o.a * (cosE - o.e);
  const yv = o.a * Math.sqrt(1 - o.e * o.e) * sinE;

  body.center.x = cx + o.px * xv + o.qx * yv;
  body.center.y = cy + o.py * xv + o.qy * yv;
  body.center.z = cz + o.pz * xv + o.qz * yv;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Galáxia
// ════════════════════════════════════════════════════════════════════════════

function cheapFrame() {
  return new Promise((r) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => r())
    : setTimeout(r, 0)));
}

/**
 * Espiral logarítmica de 4 braços com bojo central e disco fino.
 * Só metadados: posição, classe, nome, seed. Construir planetas aqui custaria
 * ~2000 × 7 corpos — a razão pela qual `getSystem` é preguiçoso.
 */
async function buildGalaxy(ctx, count) {
  const stars = new Array(count);
  const rootRng = ctx.rng;
  let t0 = performance.now();

  for (let i = 0; i < count; i++) {
    const rng = rootRng.derive('star', i);

    // O sistema 0 é a porta de entrada e o alvo das capturas canônicas:
    // forçamos uma estrela de sequência principal amarela/laranja para garantir
    // uma zona habitável larga e planetas com bioma exuberante.
    const forceClass = i === 0 ? rng.pick(['G', 'G', 'K', 'F']) : undefined;
    const phys = makeStar(rng, { forceClass, allowBinary: i !== 0 });

    // ── Posição ─────────────────────────────────────────────────────────────
    let x, y, z;
    if (i === 0) {
      // O jogador começa a meio caminho de um braço, não no meio do nada.
      x = GALAXY_RADIUS * 0.42; y = 0; z = 0;
    } else if (rng.chance(0.16)) {
      // Bojo: esferoide achatado, densidade caindo com r².
      const rad = GALAXY_RADIUS * 0.17 * Math.pow(rng.float(), 0.55);
      const s = rng.onSphere();
      x = s.x * rad; y = s.y * rad * 0.55; z = s.z * rad;
    } else {
      // Disco: braço + dispersão que se alarga com o raio.
      const t = Math.pow(rng.float(), 0.62);
      const rad = GALAXY_RADIUS * (0.07 + 0.93 * t);
      const arm = rng.int(GALAXY_ARMS);
      const spread = 0.13 + 0.22 * (1 - t);
      const theta = arm * (Math.PI * 2 / GALAXY_ARMS)
        + t * GALAXY_WINDINGS * Math.PI * 2
        + rng.normal(0, spread);
      const rr = rad * (1 + rng.normal(0, 0.05));
      x = Math.cos(theta) * rr;
      z = Math.sin(theta) * rr;
      // Disco fino: altura de escala ~1,2% do raio, mais espesso no interior.
      y = rng.normal(0, GALAXY_RADIUS * 0.012) * (0.5 + 0.9 * (1 - t));
    }

    blackbodyRGBFast(phys.temp, _rgb);
    stars[i] = {
      index: i,
      name: makeName(rng, { minSyl: 2, maxSyl: 3, suffix: rng.chance(0.35) }),
      seed: rng.seed,
      position: new Vec3d(x, y, z),
      class: phys.cls,
      spectral: phys.spectral,
      label: starLabel(phys),
      temp: phys.temp,
      luminosity: phys.luminosity,
      binary: !!phys.binary,
      colorHex: phys.hex,
      color: new THREE.Color().setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.LinearSRGBColorSpace),
      /** A física completa fica guardada: getSystem não re-sorteia a estrela. */
      phys,
    };

    // Fatiamento: 2000 estrelas custam ~3 ms, mas em máquina fraca pode dobrar.
    // Cada cessão custa um frame inteiro no navegador — só cedemos se preciso.
    if ((i & 511) === 511 && performance.now() - t0 > 5) {
      ctx.progress?.(0.02 + 0.03 * (i / count), 'semeando a galáxia…');
      await cheapFrame();
      t0 = performance.now();
    }
  }

  // O raio nominal é o do gerador; a dispersão radial extrapola um pouco. O
  // mapa galáctico normaliza por este valor, então precisa do extremo REAL.
  let extent = GALAXY_RADIUS;
  for (let i = 0; i < count; i++) {
    const p = stars[i].position;
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    if (r > extent) extent = r;
  }

  return { stars, radius: extent, nominalRadius: GALAXY_RADIUS, arms: GALAXY_ARMS, count };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Sistemas
// ════════════════════════════════════════════════════════════════════════════

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

/** Paleta de bandas de um gigante gasoso, coerente em matiz. */
function makeGasPalette(rng, zone) {
  let hue;
  if (zone === 'cold') hue = rng.chance(0.55) ? rng.range(0.50, 0.63) : rng.range(0.06, 0.12);
  else if (zone === 'hot') hue = rng.range(0.01, 0.09);
  else hue = rng.chance(0.32) ? rng.range(0.72, 0.86) : rng.range(0.05, 0.14);

  const sat = rng.range(0.42, 0.86);
  const nb = rng.intRange(7, 13);
  const bands = new Array(nb);
  for (let i = 0; i < nb; i++) {
    // O matiz oscila pouco; o VALOR oscila muito — é isso que lê como "faixa".
    const h = (hue + rng.range(-0.045, 0.045) + 1) % 1;
    const s = clamp(sat * rng.range(0.55, 1.3), 0, 1);
    const v = clamp(rng.range(0.34, 1.0), 0, 1);
    const c = hsvToRgb(h, s, v);
    bands[i] = [c[0], c[1], c[2]];
  }
  const spotC = hsvToRgb((hue + rng.range(0.42, 0.58)) % 1, clamp(sat * 1.25, 0, 1), rng.range(0.55, 1.0));
  return {
    hue,
    bands,
    bandFreq: rng.range(4.5, 11),
    turbulence: rng.range(0.35, 1.0),
    /** A grande mancha ovalada — a assinatura de Júpiter. */
    spot: {
      lat: rng.range(-0.5, 0.5),
      lon: rng.range(0, Math.PI * 2),
      rx: rng.range(0.18, 0.40),
      ry: rng.range(0.05, 0.12),
      color: spotC,
      swirl: rng.range(1.5, 4.0),
    },
  };
}

/** Cria um corpo (planeta, gigante ou lua). */
function makeBody(rng, opts) {
  const {
    systemName, indexLabel, type, radius, aMeters, e, inclination,
    parentBody, star, zone, gmParent,
  } = opts;

  const orbit = {
    parent: parentBody ? parentBody.id : star.id,
    parentBody: parentBody || null,
    a: aMeters,
    e,
    inclination,
    node: rng.range(0, Math.PI * 2),
    argPeri: rng.range(0, Math.PI * 2),
    phase: rng.range(0, Math.PI * 2),
    M: 0,
    period: 0,
    px: 1, py: 0, pz: 0, qx: 0, qy: 0, qz: 1,
  };
  orbit.M = orbit.phase;
  orbit.period = aMeters > 0 ? 2 * Math.PI * Math.sqrt((aMeters * aMeters * aMeters) / gmParent) : 0;
  // Taxa limitada: ver MIN_REAL_PERIOD.
  orbit.maxScale = orbit.period > 0 ? orbit.period / MIN_REAL_PERIOD : 1;
  orbit.n = orbit.period > 0 ? (Math.PI * 2) / orbit.period : 0;
  buildOrbitBasis(orbit);

  const body = {
    id: `${systemName}-${indexLabel}`,
    name: `${makeName(rng, { minSyl: 2, maxSyl: 3 })} ${indexLabel}`,
    type,
    radius,
    center: new Vec3d(0, 0, 0),
    orbit,
    seed: rng.seed,
    biome: null,
    hasRings: false,
    rings: null,
    moons: [],
    zone,
    /** Rotação própria: o módulo `sky` pode usar para o ciclo dia/noite. */
    day: rng.range(4, 42) * 3600,
    axialTilt: rng.normal(0, 0.32),
    spin: rng.range(0, Math.PI * 2),
    /** Gravidade de superfície — o módulo de voo/andar consome. */
    gravity: 0,
    mass: 0,
    gm: 0,
    gas: null,
    /** Cores expostas para o mapa/HUD sem precisar abrir o bioma. */
    tint: 0x808080,
    _gfx: null,
  };

  // Gravidade "de jogo": os planetas são pequenos demais para a densidade real
  // produzir 1 g. Fixamos g diretamente na faixa jogável e derivamos GM daí.
  body.gravity = type === 'gas' ? rng.range(14, 26) : rng.range(6.4, 12.5);
  body.gm = body.gravity * radius * radius;
  body.mass = body.gm / 6.674e-11;

  return body;
}

/** Constrói (ou devolve do cache) o sistema estelar de índice `index`. */
function getSystem(index) {
  const n = galaxy.stars.length;
  const idx = ((index % n) + n) % n;
  const cached = systems.get(idx);
  if (cached) return cached;

  const entry = galaxy.stars[idx];
  const rng = _ctx.rng.derive('system', idx);
  const phys = entry.phys;
  const zones = phys.zonesAU;

  // ── Layout orbital, em UA ────────────────────────────────────────────────
  // Titius-Bode perturbada, mas ANCORADA na zona habitável: uma das vagas cai
  // sempre entre os limites de água líquida. Sem essa âncora, dois terços dos
  // saltos levariam a um sistema inteiramente estéril e o jogo perderia o
  // motivo de explorar.
  const count = rng.intRange(2, 7);
  const ratio = rng.range(1.42, 1.80);
  const habSlot = rng.int(Math.min(count, 4));
  const habMidAU = Math.sqrt(zones.hotOuter * zones.coldInner);
  const anchorAU = habMidAU * rng.range(0.90, 1.12);
  const auList = new Array(count);
  for (let i = 0; i < count; i++) {
    auList[i] = anchorAU * Math.pow(ratio, i - habSlot) * (1 + rng.range(-0.06, 0.06));
  }
  // Monotonicidade com folga: órbitas quase coincidentes destroem a leitura de
  // profundidade e seriam instáveis de verdade.
  for (let i = 1; i < count; i++) auList[i] = Math.max(auList[i], auList[i - 1] * 1.24);

  // ── Compressão do sistema ────────────────────────────────────────────────
  // Reescalamos o sistema inteiro por UM fator para caber em SYSTEM_OUTER. Como
  // a classificação de zona é feita em UA, ela NÃO muda com a compressão: o que
  // o jogador lê — as razões entre as órbitas — fica intacto.
  // O teto em AU é deliberado: sistemas fisicamente minúsculos (anãs vermelhas,
  // anãs brancas) NÃO são esticados sem motivo para preencher os 4e9 m —
  // esticá-los afastaria os planetas da estrela e transformaria o sol vermelho
  // gigante, a imagem mais bonita que uma anã M oferece, num pontinho.
  let auToM = Math.min(AU, (SYSTEM_OUTER * rng.range(0.62, 0.95)) / auList[count - 1]);
  // Piso: a menor separação entre órbitas respeita ARCHITECTURE §7 (1e8 m).
  let minSepAU = auList[0];
  for (let i = 1; i < count; i++) minSepAU = Math.min(minSepAU, auList[i] - auList[i - 1]);
  auToM = Math.max(auToM, PLANET_MIN_SEP / Math.max(1e-9, minSepAU));
  // Teto duro: o sistema inteiro tem de caber no orçamento. Vence o piso.
  auToM = Math.min(auToM, SYSTEM_OUTER / auList[count - 1]);
  const compress = auToM / AU;
  const aMinM = auList[0] * auToM;

  // Raio da estrela: comprimido pela RAIZ (comprimir linearmente apagaria a
  // gigante vermelha) e depois preso entre 0,25° e 16° de diâmetro angular
  // visto da órbita mais interna — abaixo disso a estrela some, acima vira
  // parede. É este intervalo que produz tanto a anã branca-alfinete quanto o
  // sol gigante que ocupa um sexto do céu.
  const starRadius = clamp(
    SOLAR_RADIUS * phys.radiusSolar * Math.sqrt(Math.min(1, compress)),
    aMinM / 450, aMinM / 7,
  );
  const gmStar = GM_SOLAR * phys.massSolar;

  blackbodyRGBFast(phys.temp, _rgb);
  const star = {
    id: `${entry.name}-A`,
    class: phys.cls,
    spectral: phys.spectral,
    label: starLabel(phys),
    className: phys.className,
    color: new THREE.Color().setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.LinearSRGBColorSpace),
    colorHex: phys.hex,
    radius: starRadius,
    temp: phys.temp,
    luminosity: phys.luminosity,
    mass: phys.massSolar,
    gm: gmStar,
    /** A estrela do sistema ativo é sempre a origem do mundo — ver cabeçalho. */
    position: new Vec3d(0, 0, 0),
    galaxyPosition: entry.position,
    zonesAU: zones,
    auToM,
    binary: null,
  };

  if (phys.binary) {
    const b = phys.binary;
    blackbodyRGBFast(b.temp, _rgb);
    // Par FECHADO, bem dentro da órbita mais interna. É a única configuração
    // estável para planetas circumbinários — e também a mais bonita: os dois
    // sóis aparecem juntos no céu de todos os mundos, com sombras duplas.
    const separation = Math.min(b.separationAU * auToM, aMinM * 0.35);
    star.binary = {
      class: b.cls,
      className: b.className,
      temp: b.temp,
      luminosity: b.luminosity,
      color: new THREE.Color().setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.LinearSRGBColorSpace),
      // Mesma escala visual do primário: preserva a razão de raios reais e
      // herda os limites angulares já aplicados a `starRadius`.
      radius: Math.min(starRadius * (b.radiusSolar / phys.radiusSolar), aMinM / 5),
      separation,
      period: 2 * Math.PI * Math.sqrt(Math.pow(separation, 3) / (gmStar * (1 + b.massSolar / phys.massSolar))),
      phase: b.phase,
      inclination: b.inclination,
      /** Posição de mundo, atualizada em update(). */
      position: new Vec3d(0, 0, 0),
    };
  }

  // ── Planetas ─────────────────────────────────────────────────────────────
  const bodies = [];
  for (let i = 0; i < count; i++) {
    const bRng = rng.derive('body', i);
    const auHere = auList[i];
    const aM = auHere * auToM;
    const zone = zoneOfAU(auHere, zones);

    // Gigantes gasosos são criaturas do frio; o último planeta quase sempre é um.
    let pGas = zone === 'cold' ? 0.55 : zone === 'habitable' ? 0.13 : 0.03;
    if (i === count - 1 && zone === 'cold') pGas = 0.72;
    let type = bRng.chance(pGas) ? 'gas' : 'planet';
    // Todo sistema precisa de ao menos um mundo pisável — o jogo depende disso.
    if (i === count - 1 && !bodies.some((b) => b.type === 'planet')) type = 'planet';
    // Sistema inicial: a vaga habitável é obrigatoriamente um mundo pisável.
    if (idx === 0 && i === habSlot) type = 'planet';

    // ARCHITECTURE §7 fixa 80–220 km para mundos pisáveis. O gigante precisa ser
    // muito maior: é ele que enche 15° do céu visto de uma lua interna.
    const radius = type === 'gas'
      ? bRng.range(380e3, 1.30e6)
      : bRng.range(80e3, 220e3);

    const body = makeBody(bRng, {
      systemName: entry.name,
      indexLabel: ROMAN[i] || String(i + 1),
      type,
      radius,
      aMeters: aM,
      e: Math.abs(bRng.normal(0, 0.022)) + bRng.range(0, 0.018),
      inclination: bRng.normal(0, 0.021),
      parentBody: null,
      star,
      zone,
      gmParent: gmStar,
    });

    if (type === 'gas') {
      body.gas = makeGasPalette(bRng, zone);
      const c = body.gas.bands[Math.floor(body.gas.bands.length / 2)];
      body.tint = rgbHex(c);
    } else {
      let base = pickBiome(bRng, { starClass: phys.spectral, orbitZone: zone });
      // Sistema 0: garantimos um mundo exuberante na vaga habitável. O arnês de
      // capturas (src/core/shots.js) enquadra 'biome_sunset' num bioma 'lush' e,
      // sem isto, a captura canônica dependeria de sorte.
      if (idx === 0 && i === habSlot) {
        base = bRng.chance(0.5) ? BIOME_BY_ID.get('lush_verdant') : BIOME_BY_ID.get('lush_paradise');
      }
      body.biome = variateBiome(base, bRng);
      body.tint = body.biome.palette.midland;
    }

    body.hasRings = bRng.chance(type === 'gas' ? 0.55 : 0.07);
    if (body.hasRings) {
      body.rings = {
        inner: bRng.range(1.32, 1.55),
        outer: bRng.range(1.95, 2.6),
        tilt: bRng.normal(0, 0.12),
        opacity: bRng.range(0.45, 0.92),
        hue: bRng.range(0, 1),
        sat: bRng.range(0.05, 0.35),
        seed: bRng.seed,
      };
      if (body.rings.outer < body.rings.inner + 0.35) body.rings.outer = body.rings.inner + 0.35;
    }

    // ── Luas ────────────────────────────────────────────────────────────────
    const moonCount = bRng.intRange(0, type === 'gas' ? 3 : 2);
    let moonA = radius * bRng.range(5.5, 9.0);
    if (body.hasRings) moonA = Math.max(moonA, radius * body.rings.outer * 1.6);
    for (let m = 0; m < moonCount; m++) {
      const mRng = bRng.derive('moon', m);
      // 20–60% do primário (regra do briefing), mas presa à faixa pisável: uma
      // lua de 700 km quebraria o gerador de terreno do módulo `planet`.
      const mr = clamp(radius * mRng.range(0.20, 0.60), 25e3, 220e3);
      const moon = makeBody(mRng, {
        systemName: entry.name,
        indexLabel: `${ROMAN[i] || i + 1}${String.fromCharCode(97 + m)}`,
        type: 'moon',
        radius: mr,
        aMeters: moonA,
        e: Math.abs(mRng.normal(0, 0.012)),
        inclination: mRng.normal(0, 0.05),
        parentBody: body,
        star,
        zone,
        gmParent: body.gm,
      });
      // Luas pequenas raramente seguram atmosfera: puxamos o resultado para
      // regolito morto quase metade das vezes, o que também dá contraste ao
      // planeta-mãe colorido.
      const mBase = mRng.chance(0.45)
        ? BIOME_BY_ID.get(zone === 'cold' ? 'frozen_tundra' : 'barren_regolith')
        : pickBiome(mRng, { starClass: phys.spectral, orbitZone: zone });
      moon.biome = variateBiome(mBase, mRng);
      moon.tint = moon.biome.palette.midland;
      body.moons.push(moon);
      moonA *= mRng.range(1.6, 2.6);
    }

    bodies.push(body);
  }

  // ── Cinturões de asteroides ──────────────────────────────────────────────
  const belts = [];
  const beltCount = rng.intRange(0, 2);
  for (let i = 0; i < beltCount; i++) {
    const beltRng = rng.derive('belt', i);
    // Prefere a lacuna entre dois planetas — é onde a ressonância os limparia.
    let inner, outer;
    if (bodies.length >= 2) {
      const g = beltRng.int(bodies.length - 1);
      const a0 = bodies[g].orbit.a, a1 = bodies[g + 1].orbit.a;
      inner = lerp(a0, a1, 0.32);
      outer = lerp(a0, a1, 0.72);
    } else {
      inner = bodies[0].orbit.a * 1.5;
      outer = inner * 1.4;
    }
    if (outer - inner < inner * 0.06) outer = inner * 1.08;
    belts.push({
      id: `${entry.name}-belt-${i}`,
      name: `Cinturão ${entry.name} ${i + 1}`,
      inner, outer,
      thickness: (outer - inner) * beltRng.range(0.05, 0.16),
      density: beltRng.range(0.35, 1.0),
      tilt: beltRng.normal(0, 0.06),
      node: beltRng.range(0, Math.PI * 2),
      seed: beltRng.seed,
      /** Sorteia um ponto de mundo dentro do cinturão (usado pelo combate). */
      samplePoint(r, out) {
        const o = out || new Vec3d();
        const rad = Math.sqrt(lerp(inner * inner, outer * outer, r.float()));
        const th = r.range(0, Math.PI * 2);
        const y = r.normal(0, this.thickness * 0.5);
        o.set(Math.cos(th) * rad, y, Math.sin(th) * rad);
        // Inclina o plano do cinturão.
        const ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
        const ny = o.y * ct - o.z * st;
        const nz = o.y * st + o.z * ct;
        o.y = ny; o.z = nz;
        return o;
      },
      _gfx: null,
      playerInside: false,
    });
  }

  const sys = {
    id: `sys-${idx}`,
    index: idx,
    name: entry.name,
    star,
    bodies,
    asteroidBelts: belts,
    galaxyPosition: entry.position,
    /** Lista plana (planetas + luas) para varreduras rápidas. */
    allBodies: [],
    auToM,
    seed: rng.seed,
    _mounted: false,
  };
  for (const b of bodies) {
    sys.allBodies.push(b);
    for (const m of b.moons) sys.allBodies.push(m);
  }

  // Posiciona tudo em t=0 para que quem consultar antes do primeiro update
  // (o arnês de capturas, o módulo de voo) já leia centros válidos.
  advanceOrbits(sys, 0);

  systems.set(idx, sys);
  return sys;
}

function rgbHex(c) {
  return (Math.round(clamp(c[0], 0, 1) * 255) << 16)
    | (Math.round(clamp(c[1], 0, 1) * 255) << 8)
    | Math.round(clamp(c[2], 0, 1) * 255);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Texturas procedurais (fatiadas no orçamento do frame)
// ════════════════════════════════════════════════════════════════════════════

const _texJobs = [];

function makeDataTexture(w, h, fillR, fillG, fillB) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fillR; data[i * 4 + 1] = fillG; data[i * 4 + 2] = fillB; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Enfileira a geração; a textura já nasce com a cor média certa. */
function queueTexture(job) {
  job.y = 0;
  _texJobs.push(job);
}

function runTextureJobs(ctx) {
  if (_texJobs.length === 0) return;
  const t0 = performance.now();
  // Sempre UMA fatia por frame, no mínimo: se dependêssemos só de canWork() um
  // frame cronicamente cheio deixaria os planetas com a cor média para sempre.
  // A fatia é pequena de propósito (4–5 linhas ≈ 0,5 ms) para caber em qualquer
  // sobra de orçamento.
  do {
    const j = _texJobs[0];
    const end = Math.min(j.h, j.y + j.rows);
    for (; j.y < end; j.y++) j.fill(j, j.y);
    j.texture.needsUpdate = true;
    if (j.y >= j.h) _texJobs.shift();
    // Além disto o orçamento é dos outros módulos.
  } while (_texJobs.length && performance.now() - t0 < 1.2 && ctx.budget.canWork());
  if (ctx.debug.enabled) ctx.debug.set('universe.texJobs', _texJobs.length);
}

const _hexRgb = [0, 0, 0];
function hexToRgb(hex, out) {
  const o = out || _hexRgb;
  o[0] = ((hex >> 16) & 255) / 255;
  o[1] = ((hex >> 8) & 255) / 255;
  o[2] = (hex & 255) / 255;
  return o;
}
const _cA = [0, 0, 0], _cB = [0, 0, 0];

function mixInto(a, b, t, data, o) {
  data[o] = Math.round(clamp(a[0] + (b[0] - a[0]) * t, 0, 1) * 255);
  data[o + 1] = Math.round(clamp(a[1] + (b[1] - a[1]) * t, 0, 1) * 255);
  data[o + 2] = Math.round(clamp(a[2] + (b[2] - a[2]) * t, 0, 1) * 255);
  data[o + 3] = 255;
}

/**
 * Mapa equiretangular de um mundo rochoso: continentes por fBm em 3D (sem
 * costura nos polos, porque amostramos a DIREÇÃO e não a UV), oceano no nível
 * do bioma, calotas polares e uma faixa de praia.
 */
function fillRockyRow(job, y) {
  const { w, h, data, noise, pal, sea, iceAmount } = job;
  const v = (y + 0.5) / h;
  const lat = (0.5 - v) * Math.PI;
  const cl = Math.cos(lat), sl = Math.sin(lat);
  const polar = Math.abs(sl);
  for (let x = 0; x < w; x++) {
    const lon = ((x + 0.5) / w) * Math.PI * 2;
    const dx = cl * Math.cos(lon), dy = sl, dz = cl * Math.sin(lon);
    // 3+2 oitavas: este mapa é o planeta VISTO DE LONGE. Perto, quem manda é o
    // terreno real do módulo `planet` — gastar oitavas aqui é desperdício.
    const f = 2.05;
    let n = noise.fbm(dx * f, dy * f, dz * f, 3, 2.15, 0.52);
    n += noise.fbm(dx * 6.1 + 11.3, dy * 6.1 - 2.7, dz * 6.1 + 5.9, 2, 2.0, 0.5) * 0.30;
    const hgt = saturate(n * 0.58 + 0.5);

    const o = (y * w + x) * 4;
    if (hgt < sea) {
      const t = sea > 0 ? hgt / sea : 0;
      hexToRgb(pal.waterDeep, _cA); hexToRgb(pal.water, _cB);
      mixInto(_cA, _cB, t * t, data, o);
    } else {
      const t = saturate((hgt - sea) / Math.max(0.08, 1 - sea));
      if (t < 0.06 && sea > 0.02) {
        hexToRgb(pal.beach, _cA); hexToRgb(pal.sand, _cB);
        mixInto(_cA, _cB, t / 0.06, data, o);
      } else if (t < 0.42) {
        hexToRgb(pal.lowland, _cA); hexToRgb(pal.midland, _cB);
        mixInto(_cA, _cB, smoothstep(0.06, 0.42, t), data, o);
      } else if (t < 0.78) {
        hexToRgb(pal.midland, _cA); hexToRgb(pal.highland, _cB);
        mixInto(_cA, _cB, smoothstep(0.42, 0.78, t), data, o);
      } else {
        hexToRgb(pal.highland, _cA); hexToRgb(pal.peak, _cB);
        mixInto(_cA, _cB, smoothstep(0.78, 1.0, t), data, o);
      }
    }

    // Calota polar: a borda ondula com o mesmo ruído, senão vira um chapéu.
    // Só amostramos ruído onde a calota pode existir — 60% das linhas saem grátis.
    if (iceAmount > 0 && polar > 0.55) {
      const wobble = noise.noise3(dx * 3.3, dy * 3.3, dz * 3.3) * 0.09;
      const ice = smoothstep(0.74 - iceAmount * 0.3, 0.94 - iceAmount * 0.2, polar + wobble) * iceAmount;
      if (ice > 0.001) {
        data[o] = Math.round(lerp(data[o], 246, ice));
        data[o + 1] = Math.round(lerp(data[o + 1], 250, ice));
        data[o + 2] = Math.round(lerp(data[o + 2], 255, ice));
      }
    }
  }
}

/**
 * Gigante gasoso. A imagem-assinatura de No Man's Sky é um gigante ocupando
 * 15° do céu — e o que denuncia um gigante falso é a banda reta. Aqui o perfil
 * de bandas em latitude é DESLOCADO por um fBm esticado (frequência alta em
 * latitude, baixa em longitude), o que produz os dedos e as ondas de Kelvin-
 * Helmholtz. Por cima vai a grande mancha ovalada, com o vórtice enrolado.
 */
function fillGasRow(job, y) {
  const { w, h, data, noise, gas } = job;
  const bands = gas.bands, nb = bands.length;
  const v = (y + 0.5) / h;
  const lat = (0.5 - v) * Math.PI;
  const sl = Math.sin(lat), cl = Math.cos(lat);

  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    const lon = u * Math.PI * 2;
    const dx = cl * Math.cos(lon), dy = sl, dz = cl * Math.sin(lon);

    // Esticado: 0,85 em X/Z contra 6,5 em Y — o fluxo é zonal, não isotrópico.
    const warp = noise.fbm(dx * 0.85, dy * 6.5, dz * 0.85, 3, 2.1, 0.55);
    const fine = noise.noise3(dx * 2.4 + 7.1, dy * 17.0, dz * 2.4 - 3.3);

    let p = (sl * 0.5 + 0.5) * (nb - 1);
    p += warp * 0.9 * gas.turbulence;
    p += Math.sin(lat * gas.bandFreq * 2.0) * 0.42;
    p = clamp(p, 0, nb - 1);
    const i0 = Math.floor(p), i1 = Math.min(nb - 1, i0 + 1);
    const t = smoothstep(0, 1, p - i0);
    const a = bands[i0], b = bands[i1];
    let r = a[0] + (b[0] - a[0]) * t;
    let g = a[1] + (b[1] - a[1]) * t;
    let bl = a[2] + (b[2] - a[2]) * t;

    // Turbulência de valor: mantém o matiz, mexe no brilho.
    const k = 1 + fine * 0.14 * gas.turbulence;
    r *= k; g *= k; bl *= k;

    // ── Grande mancha ovalada ──────────────────────────────────────────────
    const sp = gas.spot;
    let dlon = lon - sp.lon;
    while (dlon > Math.PI) dlon -= Math.PI * 2;
    while (dlon < -Math.PI) dlon += Math.PI * 2;
    const dlat = sl - sp.lat;
    // Corrige a convergência dos meridianos, senão a mancha estica nos polos.
    const ex = (dlon * Math.max(0.15, cl)) / sp.rx;
    const ey = dlat / sp.ry;
    const d2 = ex * ex + ey * ey;
    if (d2 < 2.2) {
      const ang = Math.atan2(ey, ex);
      const swirl = noise.noise3(
        Math.cos(ang + Math.sqrt(d2) * sp.swirl) * 2.0,
        Math.sin(ang + Math.sqrt(d2) * sp.swirl) * 2.0,
        d2 * 1.7,
      );
      const m = saturate(1 - Math.sqrt(d2 / 1.0)) * (0.72 + swirl * 0.28);
      if (m > 0) {
        r = lerp(r, sp.color[0], m);
        g = lerp(g, sp.color[1], m);
        bl = lerp(bl, sp.color[2], m);
      }
    }

    // Escurecimento polar: os gigantes reais têm capuzes escuros.
    const pol = 1 - 0.22 * Math.pow(Math.abs(sl), 3.2);
    const o = (y * w + x) * 4;
    data[o] = Math.round(clamp(r * pol, 0, 1) * 255);
    data[o + 1] = Math.round(clamp(g * pol, 0, 1) * 255);
    data[o + 2] = Math.round(clamp(bl * pol, 0, 1) * 255);
    data[o + 3] = 255;
  }
}

/** Perfil radial de um anel: faixas finas, divisões tipo Cassini, alfa variável. */
function makeRingTexture(rings) {
  const w = 256;
  const data = new Uint8Array(w * 4);
  const noise = new Noise(rings.seed ^ 0x51ab);
  const base = hsvToRgb(rings.hue, rings.sat, 0.92);
  for (let i = 0; i < w; i++) {
    const t = (i + 0.5) / w;
    // Multi-frequência: o olho lê "muitas partículas" quando há escalas mistas.
    let d = 0.5
      + 0.30 * Math.sin(t * 61 + noise.noise3(t * 8, 0.5, 1.5) * 3)
      + 0.20 * Math.sin(t * 173 + 1.7)
      + 0.25 * noise.fbm(t * 14, 3.1, 0.7, 4, 2.0, 0.55);
    d = saturate(d);
    // Divisões largas: duas lacunas fixas na proporção de Cassini/Encke.
    const gap1 = smoothstep(0.02, 0.06, Math.abs(t - 0.42));
    const gap2 = smoothstep(0.008, 0.028, Math.abs(t - 0.73));
    // Bordas suaves para não recortar o anel com uma linha dura.
    const edge = smoothstep(0, 0.06, t) * smoothstep(0, 0.10, 1 - t);
    const alpha = saturate(d * gap1 * gap2 * edge) * rings.opacity;
    const shade = 0.62 + 0.38 * d;
    data[i * 4] = Math.round(clamp(base[0] * shade, 0, 1) * 255);
    data[i * 4 + 1] = Math.round(clamp(base[1] * shade, 0, 1) * 255);
    data[i * 4 + 2] = Math.round(clamp(base[2] * shade, 0, 1) * 255);
    data[i * 4 + 3] = Math.round(alpha * 255);
  }
  const tex = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Halo da estrela: gradiente radial em canvas (barato e sem asset). */
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // Núcleo saturado + cauda longa: é a cauda que vira "sangramento" no bloom.
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.30)');
  grad.addColorStop(0.50, 'rgba(255,255,255,0.07)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Materiais
// ════════════════════════════════════════════════════════════════════════════

// NOTA: o renderer roda com logarithmicDepthBuffer. O three só injeta os
// chunks de log-depth automaticamente nos materiais embutidos — um
// ShaderMaterial precisa incluí-los à mão, senão o corpo escreve profundidade
// numa escala diferente do resto da cena e a oclusão sai errada.
const BODY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const BODY_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uSun;        // direção do corpo para a estrela (mundo, normalizada)
uniform vec3 uSunColor;   // cor HDR da estrela
uniform vec3 uRimColor;
uniform float uRim;
uniform float uAmbient;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>

  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = dot(N, uSun);

  // FASE: o lado escuro tem de ficar escuro. O terminador é ligeiramente suave
  // porque a atmosfera espalha luz alguns graus além do limite geométrico.
  float lit = smoothstep(-0.10, 0.16, ndl);
  float diff = max(ndl, 0.0);
  // Achatamento tipo Oren-Nayar: superfície rugosa não cai como cosseno puro.
  float wrap = lit * (0.26 + 0.74 * pow(diff, 0.72));

  vec3 albedo = texture2D(uMap, vUv).rgb;
  vec3 col = albedo * uSunColor * wrap;
  col += albedo * uAmbient;

  // Halo atmosférico: só no lado iluminado, concentrado no limbo.
  float limb = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uRimColor * (limb * uRim * lit * (0.30 + 0.70 * diff));

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const RING_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uInner;
uniform float uOuter;
varying float vR;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  // A geometria já nasce deitada no plano XZ (equador local do corpo), então
  // 'position' está no MESMO espaço em que uSunLocal chega — é isso que faz a
  // sombra do planeta sobre o anel ficar no lugar certo.
  vLocal = position;
  vR = clamp((length(position.xz) - uInner) / max(0.001, uOuter - uInner), 0.0, 1.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const RING_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uRingMap;
uniform vec3 uSunLocal;   // direção para a estrela no espaço LOCAL do corpo
uniform vec3 uSunWorld;   // a MESMA direção em espaço de mundo
uniform vec3 uSunColor;
varying float vR;
varying vec3 vLocal;
varying vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uRingMap, vec2(vR, 0.5));
  if (t.a < 0.004) discard;

  // A sombra do planeta cortando o anel é o detalhe que vende o realismo.
  float along = dot(vLocal, uSunLocal);
  vec3 perp = vLocal - uSunLocal * along;
  float pl = length(perp);
  float shadow = (along < 0.0) ? smoothstep(0.88, 1.12, pl) : 1.0;

  vec3 V = normalize(cameraPosition - vWorld);
  // Gelo em contraluz espalha para frente: o anel acende quando o sol está atrás.
  // Este termo é geométrico entre olho e estrela, então tem de usar a direção
  // em MUNDO — misturar com uSunLocal (espaço do corpo) daria um brilho girando
  // junto com a inclinação axial.
  float fwd = pow(max(0.0, dot(-V, uSunWorld)), 5.0);
  float lightness = 0.34 + 0.66 * shadow + fwd * 0.9;

  vec3 col = t.rgb * uSunColor * lightness;
  gl_FragColor = vec4(col, t.a * (0.35 + 0.65 * shadow + fwd * 0.4));
  #include <colorspace_fragment>
}`;

function makeBodyMaterial(texture, biome, gas) {
  const rim = new THREE.Color(0x8fb8ff);
  let rimPower = 0.0;
  if (gas) {
    // O gigante é atmosfera pura: o halo é o efeito mais forte que ele tem.
    // O matiz vem do complemento das bandas, o que separa o disco do fundo.
    const c = hsvToRgb((gas.hue + 0.08) % 1, 0.55, 1.0);
    rim.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    rimPower = 1.35;
  } else if (biome?.sky) {
    rim.setHex(biome.sky.tint, THREE.SRGBColorSpace);
    // Atmosfera densa = halo forte. Um mundo de vácuo não pode ter halo nenhum.
    rimPower = clamp((biome.sky.density || 0) * 0.55, 0, 1.2);
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uRimColor: { value: rim },
      uRim: { value: rimPower },
      uAmbient: { value: 0.018 },
    },
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Montagem / desmontagem da cena
// ════════════════════════════════════════════════════════════════════════════

function ensureGeometries() {
  if (GEO_PLANET) return;
  GEO_PLANET = new THREE.SphereGeometry(1, 64, 40);
  GEO_MOON = new THREE.SphereGeometry(1, 32, 20);
  GEO_STAR = new THREE.SphereGeometry(1, 40, 24);
}

function buildBodyGraphics(ctx, body) {
  ensureGeometries();
  const group = new THREE.Group();
  group.name = body.id;
  group.matrixAutoUpdate = true;

  // Inclinação axial no grupo: a esfera gira em torno do Y local e o anel fica
  // no plano equatorial local sem precisar de matemática extra. O desvio do
  // anel entra como segunda rotação do MESMO grupo — assim o eixo de rotação e
  // o plano dos anéis continuam solidários, como na natureza.
  group.quaternion.setFromAxisAngle(_v3.set(0, 0, 1), body.axialTilt);
  if (body.rings) {
    _q.setFromAxisAngle(_v3.set(1, 0, 0), body.rings.tilt);
    group.quaternion.multiply(_q);
  }

  let tex;
  const noise = new Noise(body.seed ^ 0x2f1a);
  if (body.type === 'gas') {
    const mid = body.gas.bands[Math.floor(body.gas.bands.length / 2)];
    tex = makeDataTexture(256, 128,
      Math.round(mid[0] * 255), Math.round(mid[1] * 255), Math.round(mid[2] * 255));
    queueTexture({
      texture: tex, data: tex.image.data, w: 256, h: 128, rows: 4,
      noise, gas: body.gas, fill: fillGasRow,
    });
  } else {
    const pal = body.biome.palette;
    // Luas ficam pequenas na tela quase sempre: metade da resolução, mesma leitura.
    const tw = body.type === 'moon' ? 96 : 128;
    const th = tw >> 1;
    tex = makeDataTexture(tw, th,
      (pal.midland >> 16) & 255, (pal.midland >> 8) & 255, pal.midland & 255);
    const cls = body.biome.class;
    const ice = cls === 'frozen' ? 1.0 : cls === 'scorched' ? 0.0 : cls === 'barren' ? 0.12 : 0.45;
    queueTexture({
      texture: tex, data: tex.image.data, w: tw, h: th, rows: 6,
      noise, pal, sea: clamp(body.biome.terrain.seaLevel, 0, 0.9), iceAmount: ice,
      fill: fillRockyRow,
    });
  }

  const mat = makeBodyMaterial(tex, body.biome, body.gas);
  const mesh = new THREE.Mesh(body.type === 'moon' ? GEO_MOON : GEO_PLANET, mat);
  mesh.frustumCulled = false;   // a escala varia por frame; o culling erra.
  group.add(mesh);

  let ringMesh = null, ringMat = null, ringTex = null;
  if (body.hasRings) {
    ringTex = makeRingTexture(body.rings);
    const geo = new THREE.RingGeometry(body.rings.inner, body.rings.outer, 160, 1);
    // Deita o anel no plano XZ de uma vez, na própria geometria: o mesh fica com
    // transformação identidade e `position` no shader vale como espaço do grupo.
    geo.rotateX(-Math.PI / 2);
    ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uRingMap: { value: ringTex },
        uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
        uSunWorld: { value: new THREE.Vector3(1, 0, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uInner: { value: body.rings.inner },
        uOuter: { value: body.rings.outer },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    ringMesh = new THREE.Mesh(geo, ringMat);
    ringMesh.frustumCulled = false;
    group.add(ringMesh);
  }

  body._gfx = { group, mesh, mat, tex, ringMesh, ringMat, ringTex, inNear: false };
  return body._gfx;
}

function buildStarGraphics(ctx, star) {
  ensureGeometries();
  const group = new THREE.Group();
  const c = star.color;

  // Disco: valores HDR bem acima de 1 para o bloom do postfx sangrar de verdade.
  const discMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  discMat.color.setRGB(c.r * 14, c.g * 14, c.b * 14);
  const disc = new THREE.Mesh(GEO_STAR, discMat);
  disc.frustumCulled = false;
  group.add(disc);

  const gtex = glowTexture();
  const inner = new THREE.Sprite(new THREE.SpriteMaterial({
    map: gtex, blending: THREE.AdditiveBlending, depthWrite: false,
    depthTest: false, transparent: true, toneMapped: false,
  }));
  inner.material.color.setRGB(c.r * 3.2, c.g * 3.2, c.b * 3.2);
  group.add(inner);

  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: gtex, blending: THREE.AdditiveBlending, depthWrite: false,
    depthTest: false, transparent: true, toneMapped: false,
  }));
  corona.material.color.setRGB(c.r * 0.55, c.g * 0.6, c.b * 0.75);
  group.add(corona);

  return { group, disc, discMat, inner, corona, inNear: false };
}

function buildBeltGraphics(ctx, belt) {
  const rng = _ctx.rng.derive('beltpts', belt.seed | 0);
  const n = Math.round(1400 * (0.5 + belt.density * 0.5));
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const inv = 1 / belt.outer;
  const tmp = new Vec3d();
  for (let i = 0; i < n; i++) {
    belt.samplePoint(rng, tmp);
    // Normalizado pelo raio externo: o objeto é escalado por frame.
    pos[i * 3] = tmp.x * inv;
    pos[i * 3 + 1] = tmp.y * inv;
    pos[i * 3 + 2] = tmp.z * inv;
    const g = 0.45 + rng.float() * 0.55;
    col[i * 3] = g * 0.85; col[i * 3 + 1] = g * 0.78; col[i * 3 + 2] = g * 0.68;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,   // pontos de 1–2 px: é assim que um cinturão lê de longe
    vertexColors: true,
    transparent: true,
    opacity: 0.55 + belt.density * 0.35,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  // Sem rotação no grupo: `samplePoint` já devolve o ponto no plano inclinado
  // do cinturão — é a mesma função que o combate usa para nascer asteroides
  // reais, então as duas representações têm de coincidir exatamente.
  const group = new THREE.Group();
  group.add(points);
  belt._gfx = { group, points, geo, mat, inNear: false };
  return belt._gfx;
}

function mountSystem(ctx, sys) {
  if (!sys || sys._mounted) return;
  sys._starGfx = buildStarGraphics(ctx, sys.star);
  ctx.engine.farScene.add(sys._starGfx.group);
  if (sys.star.binary) {
    sys._binaryGfx = buildStarGraphics(ctx, { color: sys.star.binary.color });
    ctx.engine.farScene.add(sys._binaryGfx.group);
  }
  for (const b of sys.allBodies) {
    const g = buildBodyGraphics(ctx, b);
    ctx.engine.farScene.add(g.group);
  }
  for (const belt of sys.asteroidBelts) {
    const g = buildBeltGraphics(ctx, belt);
    ctx.engine.farScene.add(g.group);
  }
  sys._mounted = true;
}

function disposeObject(obj) {
  obj.traverse?.((o) => {
    if (o.geometry && o.geometry !== GEO_PLANET && o.geometry !== GEO_MOON && o.geometry !== GEO_STAR) {
      o.geometry.dispose();
    }
    const m = o.material;
    if (m) {
      const list = Array.isArray(m) ? m : [m];
      for (const mm of list) {
        for (const k of ['map', 'uMap']) {
          const t = mm[k] || mm.uniforms?.[k]?.value;
          if (t && t !== _glowTex && t.dispose) t.dispose();
        }
        const rt = mm.uniforms?.uRingMap?.value;
        if (rt && rt.dispose) rt.dispose();
        mm.dispose();
      }
    }
  });
  obj.parent?.remove(obj);
}

function unmountSystem(sys) {
  if (!sys || !sys._mounted) return;
  // Cancela texturas pendentes do sistema que está saindo.
  for (let i = _texJobs.length - 1; i >= 0; i--) {
    if (sys.allBodies.some((b) => b._gfx && b._gfx.tex === _texJobs[i].texture)) _texJobs.splice(i, 1);
  }
  for (const b of sys.allBodies) {
    if (b._gfx) { disposeObject(b._gfx.group); b._gfx = null; }
  }
  for (const belt of sys.asteroidBelts) {
    if (belt._gfx) { disposeObject(belt._gfx.group); belt._gfx = null; }
  }
  if (sys._starGfx) { disposeObject(sys._starGfx.group); sys._starGfx = null; }
  if (sys._binaryGfx) { disposeObject(sys._binaryGfx.group); sys._binaryGfx = null; }
  sys._mounted = false;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Posicionamento por frame
// ════════════════════════════════════════════════════════════════════════════

/**
 * Coloca um grupo no espaço de renderização e devolve a escala a aplicar.
 * Perto da câmera usamos a `scene` (coordenadas reais, log-depth resolve o
 * z-fight); longe vamos para a `farScene` com compressão logarítmica. A troca de
 * cena é o que evita uma lua PASSANDO NA FRENTE do planeta ativo ser desenhada
 * atrás dele — a farScene tem o depth limpo antes do pass principal.
 */
function placeGroup(ctx, group, world, gfx, forceFar) {
  const fo = ctx.frame.origin;
  const dx = world.x - fo.x, dy = world.y - fo.y, dz = world.z - fo.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let scale = 1;
  if (!forceFar && d < NEAR_HANDOFF) {
    group.position.set(dx, dy, dz);
    if (!gfx || !gfx.inNear) { ctx.engine.scene.add(group); if (gfx) gfx.inNear = true; }
  } else {
    const r = ctx.frame.toLocalCompressed(world, _local, FAR_COMPRESS);
    group.position.set(_local.x, _local.y, _local.z);
    scale = r.scale;
    if (!gfx || gfx.inNear) { ctx.engine.farScene.add(group); if (gfx) gfx.inNear = false; }
  }
  return scale;
}

const _starWorld = new Vec3d(0, 0, 0);

function updateBodyGraphics(ctx, sys, body, dt) {
  const gfx = body._gfx;
  if (!gfx) return;
  const g = gfx.group;

  const scale = placeGroup(ctx, g, body.center, gfx);
  g.scale.setScalar(body.radius * scale);

  // Rotação própria — visível nas bandas do gigante gasoso. Mesma limitação de
  // taxa das órbitas: um dia de 6 h a 2000× viraria um liquidificador.
  const spinScale = Math.min(api.timeScale, body.day / MIN_REAL_PERIOD);
  body.spin = wrapAngle(body.spin + (TWO_PI / body.day) * dt * spinScale);
  gfx.mesh.rotation.y = body.spin;

  // Direção para a estrela, em MUNDO: constante sobre o corpo (a estrela está
  // ordens de grandeza mais longe que o raio do planeta).
  const sx = -body.center.x, sy = -body.center.y, sz = -body.center.z;
  const inv = 1 / Math.max(1e-6, Math.sqrt(sx * sx + sy * sy + sz * sz));
  _v3.set(sx * inv, sy * inv, sz * inv);
  gfx.mat.uniforms.uSun.value.copy(_v3);
  gfx.mat.uniforms.uSunColor.value.copy(sys.star.color).multiplyScalar(2.1);

  // O planeta ativo é desenhado (com terreno) pelo módulo `planet`; aqui só o
  // escondemos, mas mantemos anéis e luas, que o outro módulo não conhece.
  const isActive = ctx.planet?.current === body;
  gfx.mesh.visible = !isActive;

  if (gfx.ringMat) {
    _q.copy(g.quaternion).invert();
    _v3b.copy(_v3).applyQuaternion(_q);
    gfx.ringMat.uniforms.uSunLocal.value.copy(_v3b);
    gfx.ringMat.uniforms.uSunWorld.value.copy(_v3);
    gfx.ringMat.uniforms.uSunColor.value.copy(sys.star.color).multiplyScalar(1.5);
  }
}

function updateStarGraphics(ctx, sys) {
  const gfx = sys._starGfx;
  if (!gfx) return;
  // A estrela e os cinturões NUNCA migram para a cena próxima: seus raios
  // (1e6–1e8 m) estouram o far=8e6 dela e, estando a origem do mundo sobre a
  // estrela, a distância zero enganaria o teste de proximidade.
  const k = placeGroup(ctx, gfx.group, _starWorld, gfx, true);
  const r = sys.star.radius * k;
  gfx.disc.scale.setScalar(r);
  gfx.inner.scale.set(r * 7.5, r * 7.5, 1);
  gfx.corona.scale.set(r * 26, r * 26, 1);

  if (sys.star.binary && sys._binaryGfx) {
    const k2 = placeGroup(ctx, sys._binaryGfx.group, sys.star.binary.position, sys._binaryGfx, true);
    const r2 = sys.star.binary.radius * k2;
    sys._binaryGfx.disc.scale.setScalar(r2);
    sys._binaryGfx.inner.scale.set(r2 * 7.5, r2 * 7.5, 1);
    sys._binaryGfx.corona.scale.set(r2 * 22, r2 * 22, 1);
  }
}

function updateBeltGraphics(ctx, sys) {
  const p = ctx.player.position;
  const rho = Math.sqrt(p.x * p.x + p.z * p.z);
  for (const belt of sys.asteroidBelts) {
    if (!belt._gfx) continue;
    // Dentro do cinturão, quem manda são os asteroides reais do módulo de
    // combate: o campo de pontos comprimido só existe como sinal à distância.
    belt.playerInside = rho > belt.inner * 0.85 && rho < belt.outer * 1.15
      && Math.abs(p.y) < belt.thickness * 4;
    belt._gfx.group.visible = !belt.playerInside;
    if (belt.playerInside) continue;
    const k = placeGroup(ctx, belt._gfx.group, _starWorld, belt._gfx, true);
    belt._gfx.group.scale.setScalar(belt.outer * k);
  }
}

/** Fator de reprodução efetivo de uma órbita (ver MIN_REAL_PERIOD). */
function effectiveScale(orbit) {
  const ts = api.timeScale;
  return orbit.maxScale > 0 ? Math.min(ts, orbit.maxScale) : ts;
}

function advanceOrbits(sys, dt) {
  const st = sys.star;
  if (st.binary) {
    const b = st.binary;
    b.phase = wrapAngle(b.phase
      + (Math.PI * 2 / Math.max(1, b.period)) * dt * Math.min(api.timeScale, b.period / MIN_REAL_PERIOD));
    const ci = Math.cos(b.inclination), si = Math.sin(b.inclination);
    const c = Math.cos(b.phase), s = Math.sin(b.phase);
    b.position.set(c * b.separation, s * b.separation * si, s * b.separation * ci);
  }
  // Planetas primeiro: as luas dependem do centro já atualizado do primário.
  for (let i = 0; i < sys.bodies.length; i++) {
    const b = sys.bodies[i];
    b.orbit.M = wrapAngle(b.orbit.M + b.orbit.n * dt * effectiveScale(b.orbit));
    evaluateOrbit(b);
  }
  for (let i = 0; i < sys.bodies.length; i++) {
    const ms = sys.bodies[i].moons;
    for (let j = 0; j < ms.length; j++) {
      const m = ms[j];
      m.orbit.M = wrapAngle(m.orbit.M + m.orbit.n * dt * effectiveScale(m.orbit));
      evaluateOrbit(m);
    }
  }
}

const TWO_PI = Math.PI * 2;
/** Mantém os ângulos acumulados pequenos: numa sessão longa, um M de 1e9 rad
 *  perderia dígitos significativos e a órbita começaria a tremer. */
function wrapAngle(a) {
  return a >= TWO_PI || a <= -TWO_PI ? a % TWO_PI : a;
}

// ════════════════════════════════════════════════════════════════════════════
// 8. API pública
// ════════════════════════════════════════════════════════════════════════════

/** Primeiro mundo pisável do sistema — preferindo a zona habitável. */
function firstRocky(sys) {
  const rocky = sys.bodies.filter((b) => b.type === 'planet');
  if (rocky.length === 0) {
    const moons = sys.allBodies.filter((b) => b.type === 'moon');
    return moons[0] || sys.bodies[0] || null;
  }
  return rocky.find((b) => b.zone === 'habitable') || rocky[0];
}

function findNearestBody(worldPos) {
  _nearest.body = null;
  _nearest.distance = Infinity;
  _nearest.surface = Infinity;
  if (!current) return null;
  const list = current.allBodies;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const d = worldPos.distanceTo(b.center);
    const s = d - b.radius;
    if (s < _nearest.surface) {
      _nearest.body = b; _nearest.distance = d; _nearest.surface = s;
    }
  }
  return _nearest.body;
}

/** Direção unitária de um ponto de mundo para a estrela do sistema atual. */
function directionToStar(worldPos, out) {
  const o = out || new THREE.Vector3();
  const l = Math.max(1e-6, Math.sqrt(worldPos.x * worldPos.x + worldPos.y * worldPos.y + worldPos.z * worldPos.z));
  o.set(-worldPos.x / l, -worldPos.y / l, -worldPos.z / l);
  return o;
}

/** Coloca o jogador numa órbita de aproximação de `body`. */
function parkPlayerAt(ctx, body) {
  if (!body) return;
  const d = body.radius * 3.4;
  // Direção deterministicamente derivada do corpo: a mesma seed, o mesmo pouso.
  const r = ctx.rng.derive('arrive', body.seed | 0);
  const s = r.onSphere();
  const pos = new Vec3d(
    body.center.x + s.x * d,
    body.center.y + s.y * d,
    body.center.z + s.z * d,
  );
  if (ctx.flight?.teleport) ctx.flight.teleport(pos, null);
  else { ctx.player.position.copy(pos); ctx.player.velocity.set(0, 0, 0); }
  ctx.frame.rebaseTo(pos);
}

let _warpChain = Promise.resolve();

function warpTo(index) {
  // Serializa: dois saltos simultâneos deixariam duas cenas montadas.
  _warpChain = _warpChain.then(() => doWarp(index)).catch(() => {});
  return _warpChain;
}

async function doWarp(index) {
  const ctx = _ctx;
  const to = getSystem(index);
  if (to === current) return;
  const from = current;

  ctx.events.emit('warp:begin', { from, to });
  await cheapFrame();

  if (from) {
    ctx.events.emit('system:leave', { system: from });
    unmountSystem(from);
  }

  current = to;
  ctx.system = to;
  api.current = to;
  api.belts = to.asteroidBelts;
  mountSystem(ctx, to);
  advanceOrbits(to, 0);

  const target = firstRocky(to);
  parkPlayerAt(ctx, target);
  ctx.planet?.setActive?.(target);

  ctx.events.emit('system:enter', { system: to });
  // Dois frames para o streaming do planeta pegar o ritmo antes do fade-in.
  await cheapFrame();
  await cheapFrame();
  ctx.events.emit('warp:end', { system: to });
}

const api = {
  galaxy: null,
  current: null,
  getSystem,
  warpTo,
  belts: [],
  /** 1 s real = 2000 s simulados: as órbitas viram movimento perceptível sem
   *  transformar o sistema numa engrenagem. Ver MIN_REAL_PERIOD. */
  timeScale: 2000,
  /** Tempo simulado acumulado, em segundos. */
  time: 0,
  findNearestBody,
  directionToStar,
  nearest: _nearest,
  firstRocky,
  AU,
  SOLAR_RADIUS,
  STAR_CLASSES,
  starLabel,
  /** Utilidade para o mapa galáctico: distância em anos-luz entre dois índices. */
  distanceLy(a, b) {
    const A = galaxy.stars[a], B = galaxy.stars[b];
    return A && B ? A.position.distanceTo(B.position) : Infinity;
  },
};

// ════════════════════════════════════════════════════════════════════════════
// 9. Ciclo de vida do módulo
// ════════════════════════════════════════════════════════════════════════════

export async function init(ctx) {
  _ctx = ctx;
  ctx.progress?.(0.02, 'semeando a galáxia…');
  galaxy = await buildGalaxy(ctx, STAR_COUNT);
  api.galaxy = galaxy;

  ctx.events.emit('universe:seed', { seed: ctx.seed });

  current = getSystem(0);
  api.current = current;
  api.belts = current.asteroidBelts;
  ctx.system = current;
  mountSystem(ctx, current);

  ctx.provide(id, api);

  // O módulo `planet` carrega DEPOIS de nós (order 30). Esperamos o boot para
  // entregar o primeiro mundo — e só então posicionamos o jogador, caso o
  // módulo de voo não tenha feito isso.
  ctx.events.once('boot:ready', () => {
    ctx.system = current;
    const target = firstRocky(current);
    if (!target) return;
    const p = ctx.player.position;
    if (p.x === 0 && p.y === 0 && p.z === 0) parkPlayerAt(ctx, target);
    ctx.planet?.setActive?.(target);
    ctx.events.emit('system:enter', { system: current });
  });
}

export function update(dt, ctx) {
  if (!current) return;

  api.time += dt * api.timeScale;
  advanceOrbits(current, dt);
  api.belts = current.asteroidBelts;

  runTextureJobs(ctx);

  // O corpo mais próximo é consumido por voo/HUD/combate: sempre calculado
  // (é livre de alocação). Já as linhas de telemetria montam strings, então só
  // rodam com o overlay ligado — caminho quente não aloca.
  const near = findNearestBody(ctx.player.position);
  if (!ctx.debug.enabled) return;
  ctx.debug.set('sistema', `${current.name} · ${current.star.label}`);
  ctx.debug.set('corpos', `${current.bodies.length}p / ${current.allBodies.length - current.bodies.length}l / ${current.asteroidBelts.length}c`);
  if (near) ctx.debug.set('mais próximo', `${near.name} (${(_nearest.surface / 1000).toFixed(0)} km)`);
  ctx.debug.set('t universo', `${(api.time / 86400).toFixed(1)} d ×${api.timeScale}`);
}

export function lateUpdate(dt, ctx) {
  if (!current) return;
  updateStarGraphics(ctx, current);
  const list = current.allBodies;
  for (let i = 0; i < list.length; i++) updateBodyGraphics(ctx, current, list[i], dt);
  updateBeltGraphics(ctx, current);
}

export function dispose(ctx) {
  unmountSystem(current);
  _texJobs.length = 0;
  for (const g of [GEO_PLANET, GEO_MOON, GEO_STAR]) g?.dispose();
  GEO_PLANET = GEO_MOON = GEO_STAR = null;
  if (_glowTex) { _glowTex.dispose(); _glowTex = null; }
  systems.clear();
}
