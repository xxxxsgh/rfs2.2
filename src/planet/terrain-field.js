/**
 * Campo de altura planetário — a FUNÇÃO, não a malha.
 *
 * PURO: sem `three`, sem DOM. É importado pelo Web Worker (para gerar a malha)
 * E pela thread principal (raycast, física, colocação de flora, screenshots).
 * As duas precisam concordar até o último centímetro, então existe um único
 * lugar onde o relevo é definido: aqui.
 *
 * ── A composição (a ordem importa) ───────────────────────────────────────────
 *  1. CONTINENTES  fBm de baixa frequência com domain warping de 2ª ordem.
 *     O warping é o que impede a costa de parecer uma mancha de Perlin: gera
 *     penínsulas, baías e istmos em vez de blobs.
 *  2. CORDILHEIRAS ridged modulado por um campo de "placas" (Worley F2−F1).
 *     Sem o campo de placas as montanhas viram manchas espalhadas; com ele
 *     elas se alinham em CADEIAS ao longo das fronteiras, como na Terra.
 *  3. EROSÃO       `erode()` com o gradiente numérico do próprio campo.
 *     É o passo que produz vales em V, cristas desgastadas e leques aluviais.
 *  4. TERRAÇOS / PLATÔS quando o bioma pede (badlands, mesas).
 *  5. CÂNIONS      ridged fino e afiado, SUBTRATIVO, mascarado por altitude —
 *     fenda estreita de paredes verticais, não uma depressão suave.
 *  6. ARCOS        campo 3D (a altitude entra como 3ª dimensão do ruído) que
 *     remove material sob a superfície. Assinatura visual de No Man's Sky.
 *  7. DETALHE      oitavas de alta frequência com LIMITE DE BANDA pelo tamanho
 *     da célula do LOD — nunca geramos frequência que a malha não representa.
 *
 * Tudo devolvido em METROS relativos ao datum. O datum É o nível do mar: o
 * campo já subtrai `terrain.seaLevel`, então `seaLevelRadius === body.radius`.
 */

import {
  Noise, saturate, lerp, smoothstep, clamp, smin, smax,
  erode, terrace as terraceCurve, plateau as plateauCurve,
} from '../noise/noise.js';
import { hashString, hashInt, mix as hmix } from '../core/rng.js';
import { directionToFaceUV } from './quadsphere.js';

/** Espelha TERRAIN_DEFAULT de biomes.js — o campo nunca deve receber undefined. */
const FALLBACK = {
  amplitude: 2400, continentFreq: 1.6, ridgeWeight: 0.55, ridgeSharpness: 1.35,
  warp: 0.7, terraces: 0, seaLevel: 0.32, caves: 0.5, arches: 0.35,
  plateau: 0.0, detailAmp: 14, cliffSlope: 0.62,
};

const DETAIL_OCTAVES = 9;
const DETAIL_BASE_LAMBDA = 1400;   // maior comprimento de onda do detalhe (m)
const DETAIL_GAIN = 0.52;

function seedOf(seed, tag) {
  const base = typeof seed === 'number' ? hashInt(seed) : hashString(String(seed));
  return hmix(base, hashString(tag));
}

/**
 * @param {string|number} seed
 * @param {object} terrainParams  `biome.terrain`
 * @param {{radius?:number}} [opts]
 */
export function createField(seed, terrainParams, opts = {}) {
  const T = Object.assign({}, FALLBACK, terrainParams || {});
  const RADIUS = opts.radius || 150000;
  const AMP = Math.max(60, T.amplitude);
  const SEA = clamp(T.seaLevel, 0, 0.9);
  const CF = Math.max(0.2, T.continentFreq);
  const WARP = Math.max(0, T.warp);

  const nCont = new Noise(seedOf(seed, 'continent'));
  const nRidge = new Noise(seedOf(seed, 'ridge'));
  const nPlate = new Noise(seedOf(seed, 'plates'));
  const nCanyon = new Noise(seedOf(seed, 'canyon'));
  const nArch = new Noise(seedOf(seed, 'arch'));
  const nDetail = new Noise(seedOf(seed, 'detail'));
  const nClim = new Noise(seedOf(seed, 'climate'));
  const nRock = new Noise(seedOf(seed, 'rock'));

  // Normalização fixa do detalhe: se dependesse das oitavas efetivamente
  // somadas, a amplitude cresceria ao diminuir o LOD e o terreno "respiraria".
  let detailNorm = 0;
  { let a = 1; for (let k = 0; k < DETAIL_OCTAVES; k++) { detailNorm += a; a *= DETAIL_GAIN; } }

  // Canais laterais do macro-campo: evitam alocar um objeto por amostra.
  let _land = 0, _plateEdge = 0, _cont = 0, _ridge = 0;

  const editMap = createEditMap(RADIUS);

  /** Continentes + cordilheiras, normalizado [0,1]. Escreve os canais laterais. */
  function macroE(x, y, z) {
    // ── 1. continentes ──────────────────────────────────────────────────────
    const cont = nCont.warped2(x * CF, y * CF, z * CF, 5, 0.55 + WARP * 0.75);
    const land = smoothstep(-0.09, 0.20, cont);
    const shelf = smoothstep(-0.42, -0.06, cont);

    const oceanFloor = SEA * 0.12;
    const coastLevel = SEA * 1.02;
    const inland = SEA + 0.26 * (1 - SEA);
    let e = lerp(oceanFloor, coastLevel, shelf);
    e = lerp(e, inland, land);

    // Ondulação continental ampla: impede que o interior vire um platô morto.
    e += nCont.fbm(x * CF * 3.1 + 7.3, y * CF * 3.1 - 2.1, z * CF * 3.1 + 4.9, 5) *
         0.055 * (0.35 + 0.65 * land);

    // ── 2. cordilheiras alinhadas às "placas" ───────────────────────────────
    const w = nPlate.worley(x * CF * 2.4 + 13.1, y * CF * 2.4 - 5.7, z * CF * 2.4 + 2.3, 1.0);
    const edge = 1 - smoothstep(0.0, 0.30, w.f2 - w.f1);
    const chain = 0.14 + 0.86 * edge * edge;

    const wq = nRidge.fbm(x * CF * 1.7, y * CF * 1.7, z * CF * 1.7, 3) * WARP * 0.35;
    const rf = CF * 4.2;
    const ridge = nRidge.ridged(
      x * rf + wq * 3.0, y * rf - wq * 2.1, z * rf + wq * 1.4,
      7, 2.03, 0.5, T.ridgeSharpness,
    );
    // Expoente >1 afina os cumes (o ridged cru deixa cristas gordas demais) sem
    // roubar altura: o fator 1.55 existe para o relevo OCUPAR a amplitude do
    // bioma. Serra que só usa 30% do orçamento vertical lê como colina.
    e += Math.pow(ridge, 1.55) * T.ridgeWeight * chain * (0.25 + 0.75 * land) * 1.55;

    // Contrafortes: uma banda intermediária amarra o pé da serra ao planalto.
    e += nRidge.ridged(x * rf * 2.6 + 4.1, y * rf * 2.6 - 9.7, z * rf * 2.6 + 1.9, 4, 2.1, 0.5, 1.1) *
         T.ridgeWeight * land * chain * 0.14;

    // Teto e piso SUAVES. Um clamp duro criaria mesas planas nos cumes dos
    // biomas de ridgeWeight alto — a assinatura mais óbvia de campo estourado.
    e = smin(e, 1.0, 0.17);
    e = smax(e, 0.004, 0.05);

    _land = land; _plateEdge = edge; _cont = cont; _ridge = ridge;
    return e;
  }

  /** Proxy barato do relevo — só para o gradiente da erosão (6 avaliações). */
  function proxyE(x, y, z) {
    const c = nCont.fbm(x * CF, y * CF, z * CF, 3);
    const rf = CF * 4.2;
    const r = nRidge.ridged(x * rf, y * rf, z * rf, 4, 2.03, 0.5, T.ridgeSharpness);
    return c * 0.30 + r * r * T.ridgeWeight * 0.62;
  }

  const GRAD_EPS = 0.0016;
  const GRAD_SCALE = 1 / (6 + CF * 4);

  /** Campo 3D dos arcos: a altitude entra como deslocamento real do domínio. */
  function archVoid(x, y, z, q, af) {
    const a = nArch.noise3(x * af, y * af + q, z * af);
    const b = nArch.noise3(x * af * 1.43 + 21.7, y * af * 1.43 - q * 0.8, z * af * 1.43 + 9.1);
    // Interseção de duas superfícies de nível = TUBO. Um tubo horizontal logo
    // abaixo da crista é exatamente o vão de um arco natural.
    const tube = (1 - Math.abs(a)) * (1 - Math.abs(b));
    return smoothstep(0.72, 0.93, tube);
  }

  /**
   * Altura do terreno em metros acima do datum.
   * @param {number} nx,ny,nz direção UNITÁRIA na esfera
   * @param {number} [cell] espaçamento das amostras em metros (limite de banda)
   */
  function height(nx, ny, nz, cell) {
    const c = cell > 0 ? cell : 1;

    let e = macroE(nx, ny, nz);
    const land = _land;

    // ── 3. erosão ───────────────────────────────────────────────────────────
    // Diferenças ADIANTE (4 amostras em vez de 6): a erosão só usa a magnitude
    // do gradiente, e o viés de meia célula é indistinguível no resultado.
    const p0 = proxyE(nx, ny, nz);
    const gx = (proxyE(nx + GRAD_EPS, ny, nz) - p0) / GRAD_EPS * GRAD_SCALE;
    const gy = (proxyE(nx, ny + GRAD_EPS, nz) - p0) / GRAD_EPS * GRAD_SCALE;
    const gz = (proxyE(nx, ny, nz + GRAD_EPS) - p0) / GRAD_EPS * GRAD_SCALE;
    e = erode(nCanyon, e, gx, gy, gz, nx * CF * 7, ny * CF * 7, nz * CF * 7, 0.55 + land * 0.85);

    // ── 4. terraços e platôs ────────────────────────────────────────────────
    if (T.terraces > 0) {
      const above = smoothstep(0.0, 0.22, saturate((e - SEA) / Math.max(0.05, 1 - SEA)));
      e = lerp(e, terraceCurve(saturate(e), T.terraces, 0.35), 0.72 * land * above);
    }
    if (T.plateau > 0) {
      const lvl = SEA + 0.34 * (1 - SEA);
      e = lerp(e, plateauCurve(e, lvl, 5.5), saturate(T.plateau) * land);
    }

    // ── 5. cânions ──────────────────────────────────────────────────────────
    const cw = nCanyon.fbm(nx * CF * 2.2 + 3.7, ny * CF * 2.2, nz * CF * 2.2 - 6.1, 3) * WARP * 0.5;
    const cnf = CF * 9.5;
    const cn = nCanyon.ridged(nx * cnf + cw, ny * cnf - cw * 0.7, nz * cnf + cw * 1.3, 5, 2.11, 0.5, 2.6);
    // Só o topo do ridged vira linha: dá uma fenda ESTREITA, não um vale largo.
    const line = smoothstep(0.80, 0.965, cn);
    const wall = line * line * line;         // perfil quase vertical nas bordas
    const altOk = smoothstep(SEA + 0.02, SEA + 0.16, e) * (1 - smoothstep(0.72, 0.94, e));
    e -= wall * altOk * land * 0.21;

    // ── conversão para metros ───────────────────────────────────────────────
    let h = (e - SEA) * AMP;

    // ── 6. arcos e pontes naturais ──────────────────────────────────────────
    // Só existem acima do mar e desaparecem suavemente quando a célula do LOD
    // é grande demais para representá-los (fade, nunca corte seco → sem pop).
    if (T.arches > 0.001) {
      // Banda de fade LARGA de propósito. O LOD dobra `c` de um nível para o
      // outro; com uma banda estreita a diferença de altura entre dois chunks
      // vizinhos de níveis diferentes chegaria a metros e apareceria como um
      // degrau na silhueta. Espalhando o fade por uma década, o degrau em
      // qualquer junta fica abaixo do meio metro.
      const lodFade = 1 - smoothstep(25, 260, c);
      if (lodFade > 0.001) {
        const above = saturate(h / (AMP * 0.08 + 30));
        const gate = T.arches * land * above * lodFade;
        if (gate > 0.002) {
          const af = RADIUS / 240;             // padrão de ~240 m: vãos legíveis a pé
          const depth = 70 + 110 * saturate(T.arches);
          const steps = 6;
          const step = depth / steps;
          let open = 1, cut = 0;
          for (let k = 0; k < steps; k++) {
            const v = archVoid(nx, ny, nz, (h - k * step) / 380, af);
            cut += open * v * step;
            open *= (1 - v);
            if (open < 0.02) break;
          }
          h -= cut * gate;
        }
      }
    }

    // ── 7. detalhe com limite de banda ──────────────────────────────────────
    let lam = DETAIL_BASE_LAMBDA, amp = 1, sum = 0;
    for (let k = 0; k < DETAIL_OCTAVES; k++) {
      if (lam < c * 1.4) break;
      const fade = smoothstep(c * 1.6, c * 3.2, lam);
      const f = RADIUS / lam;
      sum += amp * fade * nDetail.noise3(nx * f + k * 7.31, ny * f - k * 3.17, nz * f + k * 11.3);
      amp *= DETAIL_GAIN;
      lam *= 0.5;
    }
    h += (sum / detailNorm) * T.detailAmp * (0.45 + 0.55 * land) * (0.8 + 0.6 * _ridge);

    h += editMap.sample(nx, ny, nz);
    return clamp(h, -AMP, AMP);
  }

  // ── Classificação de superfície ───────────────────────────────────────────
  const _mix = new Float32Array(4);
  const _cls = { rockiness: 0, moisture: 0, temperature: 0 };

  /**
   * Materiais e clima de um ponto. `outMix` recebe [solo, rocha, areia, neve].
   * Separado de `surface()` porque o worker já conhece h e slope da grade e
   * pagar de novo por eles seria 5x o custo do chunk.
   */
  function classify(nx, ny, nz, h, slope01, outMix) {
    const out = outMix || _mix;
    const rel = h / AMP;
    const lat = Math.abs(ny);

    const climate = nClim.fbm(nx * CF * 1.9 - 11.3, ny * CF * 1.9 + 6.7, nz * CF * 1.9 + 2.9, 5);
    // Lapso adiabático: o topo é frio mesmo no equador — cumes nevados.
    const temperature = saturate(1.06 - 1.42 * lat * lat - saturate(rel) * 0.62 + climate * 0.14);
    const moisture = saturate(0.5 + 0.55 * climate - saturate(rel) * 0.28 +
                              (1 - saturate(h / 40 + 0.5)) * 0.25);

    const rockN = nRock.fbm(nx * CF * 26, ny * CF * 26, nz * CF * 26, 4);
    const rockiness = saturate(smoothstep(T.cliffSlope - 0.20, T.cliffSlope + 0.10,
                                          slope01 + rockN * 0.13));

    let snow = smoothstep(0.36, 0.13, temperature) * (1 - rockiness * 0.65);
    let sand = smoothstep(0.44, 0.12, moisture) * (1 - rockiness) * (1 - snow);
    if (SEA > 0) {
      // Praia: faixa estreita em volta do nível do mar, só em terreno macio.
      const beach = smoothstep(34, 3, Math.abs(h)) * (1 - rockiness) * (1 - snow);
      if (beach > sand) sand = beach;
    }
    const rock = rockiness;
    let soil = 1 - rock;
    sand *= (1 - rock);
    snow *= (1 - rock);
    soil -= sand + snow;
    if (soil < 0) soil = 0;

    let s = soil + rock + sand + snow;
    if (s < 1e-5) { soil = 1; s = 1; }
    out[0] = soil / s; out[1] = rock / s; out[2] = sand / s; out[3] = snow / s;

    _cls.rockiness = rockiness;
    _cls.moisture = moisture;
    _cls.temperature = temperature;
    return _cls;
  }

  // Base tangente reutilizada — zero alocação no caminho quente.
  const _t1 = { x: 0, y: 0, z: 0 }, _t2 = { x: 0, y: 0, z: 0 };
  function tangents(nx, ny, nz) {
    // Referência trocada perto dos polos para o produto vetorial não degenerar.
    const rx = Math.abs(ny) > 0.9 ? 1 : 0, ry = Math.abs(ny) > 0.9 ? 0 : 1, rz = 0;
    let ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= al; ay /= al; az /= al;
    _t1.x = ax; _t1.y = ay; _t1.z = az;
    _t2.x = ny * az - nz * ay;
    _t2.y = nz * ax - nx * az;
    _t2.z = nx * ay - ny * ax;
  }

  /**
   * Amostra completa. Aloca um objeto — é chamada por consumidores externos
   * (flora, física, ferramentas), não por vértice.
   */
  function surface(nx, ny, nz, cell) {
    const c = cell > 0 ? cell : 1.0;
    const h = height(nx, ny, nz, c);
    const land = _land;
    tangents(nx, ny, nz);
    const ds = Math.max(0.35, c * 1.5);
    const d = ds / RADIUS;

    const hA = height(nx + _t1.x * d, ny + _t1.y * d, nz + _t1.z * d, c);
    const hB = height(nx - _t1.x * d, ny - _t1.y * d, nz - _t1.z * d, c);
    const hC = height(nx + _t2.x * d, ny + _t2.y * d, nz + _t2.z * d, c);
    const hD = height(nx - _t2.x * d, ny - _t2.y * d, nz - _t2.z * d, c);
    const g1 = (hA - hB) / (2 * ds);
    const g2 = (hC - hD) / (2 * ds);
    const g = Math.sqrt(g1 * g1 + g2 * g2);
    const slope01 = g / Math.sqrt(1 + g * g);

    let nrmX = nx - _t1.x * g1 - _t2.x * g2;
    let nrmY = ny - _t1.y * g1 - _t2.y * g2;
    let nrmZ = nz - _t1.z * g1 - _t2.z * g2;
    const nl = Math.sqrt(nrmX * nrmX + nrmY * nrmY + nrmZ * nrmZ) || 1;
    nrmX /= nl; nrmY /= nl; nrmZ /= nl;

    const mixOut = new Float32Array(4);
    const cls = classify(nx, ny, nz, h, slope01, mixOut);
    return {
      height: h,
      slope: slope01,
      rockiness: cls.rockiness,
      moisture: cls.moisture,
      temperature: cls.temperature,
      land,
      biomeMix: mixOut,
      biomeWeights: mixOut,
      normal: { x: nrmX, y: nrmY, z: nrmZ },
    };
  }

  return {
    radius: RADIUS,
    amplitude: AMP,
    seaLevel: SEA,
    params: T,
    editMap,
    height,
    surface,
    classify,
    /** Exposto para o worker reaproveitar a base tangente já calculada. */
    _tangents: tangents,
    _t1, _t2,
  };
}

// ── Mapa esparso de edições ─────────────────────────────────────────────────

/**
 * Chave = célula de grade em coordenadas de FACE. O pincel é registrado em
 * TODAS as células que ele toca, então a amostragem só precisa olhar uma.
 * 256 células por face ≈ 920 m por célula num planeta de 150 km.
 */
export const EDIT_CELLS = 256;

export function editCellKey(face, cx, cy) {
  return (face * EDIT_CELLS + cy) * EDIT_CELLS + cx;
}

export function createEditMap(planetRadius = 150000) {
  const cells = new Map();
  const brushes = [];
  const _fu = { face: 0, u: 0, v: 0 };

  function register(b) {
    directionToFaceUV(b.x, b.y, b.z, _fu);
    // Margem generosa: a projeção ingênua distorce até ~1.5x perto dos cantos.
    const du = b.ang * 1.5 + 1 / EDIT_CELLS;
    const i0 = Math.max(0, Math.floor((_fu.u - du) * EDIT_CELLS));
    const i1 = Math.min(EDIT_CELLS - 1, Math.floor((_fu.u + du) * EDIT_CELLS));
    const j0 = Math.max(0, Math.floor((_fu.v - du) * EDIT_CELLS));
    const j1 = Math.min(EDIT_CELLS - 1, Math.floor((_fu.v + du) * EDIT_CELLS));
    const keys = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = editCellKey(_fu.face, i, j);
        let list = cells.get(k);
        if (!list) { list = []; cells.set(k, list); }
        list.push(b);
        keys.push(k);
      }
    }
    b.cells = keys;
    brushes.push(b);
    return b;
  }

  return {
    cells,
    brushes,
    version: 0,

    /** Cria e registra um pincel. `radiusM` e `delta` em metros. */
    add(dx, dy, dz, radiusM, delta) {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const b = {
        x: dx / l, y: dy / l, z: dz / l,
        ang: Math.max(1e-6, radiusM / planetRadius),
        r: radiusM,
        delta,
      };
      register(b);
      this.version++;
      return b;
    },

    /** Reinsere um pincel já serializado (worker recebendo do main thread). */
    addRaw(b) {
      register(b);
      this.version++;
      return b;
    },

    clear() { cells.clear(); brushes.length = 0; this.version++; },

    /** Deslocamento acumulado em metros na direção dada. */
    sample(x, y, z) {
      if (brushes.length === 0) return 0;
      directionToFaceUV(x, y, z, _fu);
      const i = Math.min(EDIT_CELLS - 1, Math.max(0, (_fu.u * EDIT_CELLS) | 0));
      const j = Math.min(EDIT_CELLS - 1, Math.max(0, (_fu.v * EDIT_CELLS) | 0));
      const list = cells.get(editCellKey(_fu.face, i, j));
      if (!list) return 0;
      let sum = 0;
      for (let k = 0; k < list.length; k++) {
        const b = list[k];
        const dot = x * b.x + y * b.y + z * b.z;
        const chord = Math.sqrt(Math.max(0, 2 - 2 * dot));
        const t = chord / b.ang;
        if (t >= 1) continue;
        const f = 1 - t * t;
        sum += b.delta * f * f;
      }
      return sum;
    },
  };
}

// ── Paleta / coloração de vértice ───────────────────────────────────────────

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexLin(hex, out, o) {
  out[o] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[o + 1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[o + 2] = srgbToLinear((hex & 255) / 255);
}

const PAL_KEYS = ['lowland', 'midland', 'highland', 'peak', 'cliff', 'cliffAlt',
  'sand', 'beach', 'deep', 'water', 'accent'];

/** Converte a paleta hex do bioma em floats lineares (o material é linear). */
export function createPalette(paletteHex) {
  const p = paletteHex || {};
  const arr = new Float32Array(PAL_KEYS.length * 3);
  for (let i = 0; i < PAL_KEYS.length; i++) {
    hexLin(p[PAL_KEYS[i]] !== undefined ? p[PAL_KEYS[i]] : 0x808080, arr, i * 3);
  }
  const idx = {};
  for (let i = 0; i < PAL_KEYS.length; i++) idx[PAL_KEYS[i]] = i * 3;
  return { arr, idx };
}

function mixInto(out, pal, a, b, t) {
  const A = pal.idx[a], B = pal.idx[b], p = pal.arr;
  out[0] = p[A] + (p[B] - p[A]) * t;
  out[1] = p[A + 1] + (p[B + 1] - p[A + 1]) * t;
  out[2] = p[A + 2] + (p[B + 2] - p[A + 2]) * t;
}

const _base = new Float32Array(3);
const _lay = new Float32Array(3);

/**
 * Cor final do vértice em espaço LINEAR.
 * O material só aplica variação multiplicativa em cima disso — a identidade
 * cromática do bioma (§8 do ARCHITECTURE) é decidida aqui, uma vez por vértice.
 *
 * @param {Float32Array} out destino
 * @param {number} o offset em `out`
 * @param {number} hNorm altura relativa à amplitude, [-1,1]
 * @param {Float32Array} mix [solo, rocha, areia, neve]
 * @param {number} varN ruído [-1,1] para quebrar a uniformidade das faixas
 */
export function shadeVertex(out, o, pal, hNorm, mix, varN, moisture) {
  // Faixas altitudinais do solo: baixada → meia encosta → alta → cume.
  const t = saturate(hNorm * 1.9 + 0.18 + varN * 0.10);
  if (t < 0.34) mixInto(_base, pal, 'lowland', 'midland', t / 0.34);
  else if (t < 0.68) mixInto(_base, pal, 'midland', 'highland', (t - 0.34) / 0.34);
  else mixInto(_base, pal, 'highland', 'peak', (t - 0.68) / 0.32);

  // Fundo submerso puxa para `deep` — a água do módulo `water` cobre isso, mas
  // o leito precisa ler como leito mesmo quando visto de fora d'água.
  if (hNorm < 0) {
    const d = saturate(-hNorm * 3.2);
    const D = pal.idx.deep, p = pal.arr;
    _base[0] = lerp(_base[0], p[D], d);
    _base[1] = lerp(_base[1], p[D + 1], d);
    _base[2] = lerp(_base[2], p[D + 2], d);
  }
  // Aridez desbota a vegetação sem mudar o matiz do bioma.
  if (moisture !== undefined) {
    const dry = saturate(0.45 - moisture) * 0.9;
    mixInto(_lay, pal, 'sand', 'beach', 0.35);
    _base[0] = lerp(_base[0], _lay[0], dry);
    _base[1] = lerp(_base[1], _lay[1], dry);
    _base[2] = lerp(_base[2], _lay[2], dry);
  }

  let r = _base[0] * mix[0], g = _base[1] * mix[0], b = _base[2] * mix[0];

  mixInto(_lay, pal, 'cliff', 'cliffAlt', saturate(varN * 0.5 + 0.5));
  r += _lay[0] * mix[1]; g += _lay[1] * mix[1]; b += _lay[2] * mix[1];

  mixInto(_lay, pal, 'sand', 'beach', saturate(varN * 0.5 + 0.5));
  r += _lay[0] * mix[2]; g += _lay[1] * mix[2]; b += _lay[2] * mix[2];

  const P = pal.idx.peak, p = pal.arr;
  r += p[P] * mix[3]; g += p[P + 1] * mix[3]; b += p[P + 2] * mix[3];

  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

export { PAL_KEYS };
