import * as THREE from 'three';
import { clamp, saturate, lerp, smoothstep } from '../noise/noise.js';

/**
 * plant-gen.js — geração procedural determinística de malhas de planta.
 *
 * POR QUÊ ESTE ARQUIVO EXISTE
 * ---------------------------
 * O sinal nº1 de protótipo (ARCHITECTURE.md §8.4) é vegetação esparsa, uniforme
 * e "esférica". Uma esfera verde em cima de um cilindro marrom lê como
 * placeholder à distância de um quilômetro. Aqui construímos silhuetas reais:
 * troncos em tubo cônico segmentado com ramificação recursiva, folhagem em
 * cartões cruzados com normais projetadas para fora do volume da copa (o truque
 * clássico que faz a copa ler como massa e não como papel), fitas curvas para
 * grama e prismas facetados para cristal.
 *
 * CONTRATOS QUE ESTE ARQUIVO RESPEITA
 * -----------------------------------
 *  - Determinismo: tudo vem de um Rng derivado. Nenhum Math.random().
 *  - Sem asset binário: a única textura é um atlas desenhado em canvas 2D.
 *  - Zero alocação por frame: tudo aqui roda no warm-up, nunca no caminho quente.
 *
 * LAYOUT DO ATLAS (uma textura para TODAS as plantas → 1 material por LOD)
 * -----------------------------------------------------------------------
 * Manter tudo num único atlas é o que permite uma chamada de desenho por
 * (espécie × LOD × célula) em vez de uma por material (casca + folha + talo).
 *
 *   u[0.00,0.25] v[0,1]      BARK   — fibra vertical, opaco
 *   u[0.25,0.50] v[0,1]      SOLID  — branco liso (talos, pétalas, cristais)
 *   u[0.50,1.00] v[0.5,1]    LEAF   — cartão de folhagem com recorte por alpha
 *   u[0.50,1.00] v[0,0.5]    BLADE  — lâmina/fronde opaca com nervura
 *
 * ATRIBUTOS DE VÉRTICE PRODUZIDOS
 * -------------------------------
 *   position, normal, uv, color (vec3 linear), aWindW (float), aEmis (float)
 *
 * `aWindW` é o peso do vento: 0 na base rígida, →1 nas pontas. O deslocamento
 * senoidal no vertex shader é multiplicado por ele, então o tronco fica parado e
 * a folha chicoteia — sem isso a planta inteira desliza e denuncia o truque.
 */

// ── Regiões do atlas (x, y, largura, altura) em UV ───────────────────────────
export const REGION = {
  BARK: [0.00, 0.00, 0.25, 1.00],
  SOLID: [0.25, 0.00, 0.25, 1.00],
  LEAF: [0.50, 0.50, 0.50, 0.50],
  BLADE: [0.50, 0.00, 0.50, 0.50],
};

/** Todos os tipos que os biomas podem pedir (biome.flora.types). */
export const PLANT_TYPES = [
  'tree_broad', 'tree_palm', 'pine', 'bush', 'fern', 'grass',
  'mushroom_tall', 'mushroom_cap', 'tendril', 'spore_pod',
  'crystal_shard', 'dead_tree', 'orb_tree', 'flower', 'coral',
];

/**
 * Metadados por tipo consumidos pelo espalhador (flora.js).
 *  tall       — participa da malha de copa (recebe LOD2 e imposter)
 *  hScale     — fração de biome.flora.maxHeight usada como altura nominal
 *  slope      — faixa de inclinação tolerada [min,max] (0 = plano, 1 = parede)
 *  moisture   — faixa de umidade tolerada (se o planeta expuser)
 *  temp       — faixa de temperatura tolerada
 *  alt        — faixa de altitude normalizada acima do nível do mar
 *  clumping   — quanto o campo de clustering favorece este tipo (0..1)
 *  spacing    — raio mínimo aproximado entre indivíduos, em metros
 *  wind       — multiplicador de amplitude de vento
 *  resource   — recurso devolvido por ctx.flora.harvest()
 */
export const TYPE_INFO = {
  tree_broad:    { tall: true,  hScale: 1.00, slope: [0.00, 0.42], moisture: [0.30, 1.00], temp: [0.25, 0.95], alt: [0.00, 0.62], clumping: 0.85, spacing: 7.0,  wind: 1.00, resource: 'carbono' },
  tree_palm:     { tall: true,  hScale: 0.85, slope: [0.00, 0.34], moisture: [0.35, 1.00], temp: [0.45, 1.00], alt: [0.00, 0.30], clumping: 0.70, spacing: 8.0,  wind: 1.35, resource: 'carbono' },
  pine:          { tall: true,  hScale: 0.95, slope: [0.00, 0.55], moisture: [0.18, 0.90], temp: [0.00, 0.55], alt: [0.05, 0.85], clumping: 0.90, spacing: 5.5,  wind: 0.55, resource: 'carbono' },
  bush:          { tall: false, hScale: 0.14, slope: [0.00, 0.58], moisture: [0.18, 1.00], temp: [0.10, 0.95], alt: [0.00, 0.80], clumping: 0.55, spacing: 2.2,  wind: 0.85, resource: 'carbono' },
  fern:          { tall: false, hScale: 0.10, slope: [0.00, 0.52], moisture: [0.45, 1.00], temp: [0.30, 0.95], alt: [0.00, 0.55], clumping: 0.75, spacing: 1.6,  wind: 1.10, resource: 'carbono' },
  grass:         { tall: false, hScale: 0.05, slope: [0.00, 0.62], moisture: [0.12, 1.00], temp: [0.05, 1.00], alt: [0.00, 0.90], clumping: 0.35, spacing: 0.9,  wind: 1.60, resource: 'carbono' },
  mushroom_tall: { tall: true,  hScale: 0.70, slope: [0.00, 0.40], moisture: [0.40, 1.00], temp: [0.10, 0.85], alt: [0.00, 0.60], clumping: 0.95, spacing: 6.0,  wind: 0.45, resource: 'fungal' },
  mushroom_cap:  { tall: false, hScale: 0.16, slope: [0.00, 0.55], moisture: [0.40, 1.00], temp: [0.05, 0.85], alt: [0.00, 0.70], clumping: 0.90, spacing: 1.8,  wind: 0.30, resource: 'fungal' },
  tendril:       { tall: true,  hScale: 0.45, slope: [0.00, 0.70], moisture: [0.10, 1.00], temp: [0.00, 1.00], alt: [0.00, 0.95], clumping: 0.60, spacing: 3.4,  wind: 1.80, resource: 'fungal' },
  spore_pod:     { tall: false, hScale: 0.22, slope: [0.00, 0.50], moisture: [0.25, 1.00], temp: [0.00, 1.00], alt: [0.00, 0.85], clumping: 0.80, spacing: 2.6,  wind: 0.70, resource: 'esporos' },
  crystal_shard: { tall: true,  hScale: 0.65, slope: [0.00, 0.85], moisture: [0.00, 1.00], temp: [0.00, 1.00], alt: [0.00, 1.00], clumping: 0.98, spacing: 5.0,  wind: 0.00, resource: 'silicato' },
  dead_tree:     { tall: true,  hScale: 0.80, slope: [0.00, 0.60], moisture: [0.00, 0.60], temp: [0.00, 1.00], alt: [0.00, 0.90], clumping: 0.65, spacing: 9.0,  wind: 0.40, resource: 'carbono' },
  orb_tree:      { tall: true,  hScale: 1.00, slope: [0.00, 0.45], moisture: [0.15, 1.00], temp: [0.00, 1.00], alt: [0.00, 0.80], clumping: 0.88, spacing: 10.0, wind: 0.80, resource: 'exotico' },
  flower:        { tall: false, hScale: 0.045, slope: [0.00, 0.45], moisture: [0.35, 1.00], temp: [0.25, 0.95], alt: [0.00, 0.65], clumping: 0.92, spacing: 1.1,  wind: 1.40, resource: 'pigmento' },
  coral:         { tall: false, hScale: 0.28, slope: [0.00, 0.55], moisture: [0.55, 1.00], temp: [0.35, 1.00], alt: [0.00, 0.14], clumping: 0.90, spacing: 2.4,  wind: 0.25, resource: 'calcio' },
};

/** Parâmetros por nível de LOD. O imposter é gerado à parte, por RTT. */
const LOD = [
  { radial: 7, depth: 4, cards: 1.00, seg: 4, revU: 12, revV: 6, blades: 5 },
  // cards < 0.4 aciona os ramos "reduzidos" dos geradores (metade dos caules,
  // frondes e verticilos). Sem esse degrau o LOD1 custa quase o mesmo que o
  // LOD0 e o anel de cobertura média vira o gargalo de triângulos.
  { radial: 5, depth: 3, cards: 0.38, seg: 3, revU: 8, revV: 4, blades: 3 },
  { radial: 3, depth: 2, cards: 0.16, seg: 2, revU: 5, revV: 3, blades: 2 },
];

export const LOD_COUNT = LOD.length;

// ── Vetores reutilizados dentro dos construtores (warm-up, mas ainda assim) ──
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _col = new THREE.Color();

// ═════════════════════════════════════════════════════════════════════════════
// ATLAS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Desenha o atlas único de flora num canvas 2D.
 *
 * Tudo é branco/cinza: a COR vem do atributo de vértice. Assim uma textura
 * serve para folha verde-limão de bioma exuberante e para folha violeta de
 * bioma exótico, sem duplicar memória de textura.
 *
 * @param {import('../core/rng.js').Rng} rng
 * @param {number} size lado do canvas (potência de 2)
 * @returns {THREE.CanvasTexture|null} null se não houver DOM (ex.: worker)
 */
export function makeFloraAtlas(rng, size = 512) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: false });
  g.clearRect(0, 0, size, size);

  const H = size / 2, Q = size / 4;

  // ── BARK: fibra vertical + rachaduras horizontais ─────────────────────────
  g.save();
  g.beginPath(); g.rect(0, 0, Q, size); g.clip();
  g.fillStyle = '#b9b3ab'; g.fillRect(0, 0, Q, size);
  for (let i = 0; i < 220; i++) {
    const x = rng.float() * Q;
    const w = rng.range(0.6, 4.0);
    const v = rng.range(0.35, 1.0);
    g.globalAlpha = rng.range(0.06, 0.34);
    g.fillStyle = v > 0.7 ? '#ffffff' : '#3a342c';
    g.fillRect(x, rng.float() * size, w, rng.range(size * 0.15, size));
  }
  // Rachaduras: quebram a leitura de "cilindro liso".
  for (let i = 0; i < 34; i++) {
    g.globalAlpha = rng.range(0.10, 0.30);
    g.fillStyle = '#241f19';
    g.fillRect(rng.float() * Q, rng.float() * size, rng.range(4, Q), rng.range(0.7, 2.2));
  }
  g.restore();

  // ── SOLID: branco com gradiente sutil (talo, pétala, faceta) ──────────────
  g.save();
  g.globalAlpha = 1;
  const grad = g.createLinearGradient(Q, 0, H, 0);
  grad.addColorStop(0, '#c9c9c9');
  grad.addColorStop(0.5, '#ffffff');
  grad.addColorStop(1, '#d2d2d2');
  g.fillStyle = grad; g.fillRect(Q, 0, Q, size);
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = rng.range(0.03, 0.11);
    g.fillStyle = rng.chance(0.5) ? '#ffffff' : '#8e8e8e';
    g.fillRect(Q + rng.float() * Q, rng.float() * size, rng.range(1, 6), rng.range(6, 60));
  }
  g.restore();

  // ── LEAF: cartão de folhagem recortado (metade superior do atlas) ─────────
  // Muitos folíolos com alpha 1 e fundo alpha 0. O alpha-test recorta e a
  // silhueta fica rendilhada — é a diferença entre "copa" e "bola verde".
  g.save();
  g.globalAlpha = 1;
  const lx = H, ly = 0, lw = H, lh = H;
  drawLeafCard(g, rng, lx, ly, lw, lh);
  g.restore();

  // ── BLADE: lâmina/fronde opaca com nervura central ───────────────────────
  g.save();
  g.globalAlpha = 1;
  const bgr = g.createLinearGradient(H, size, H, H);
  bgr.addColorStop(0, '#9d9d9d');
  bgr.addColorStop(0.55, '#ffffff');
  bgr.addColorStop(1, '#e2e2e2');
  g.fillStyle = bgr; g.fillRect(H, H, H, H);
  // Nervura + estriamento longitudinal (a fita fica com leitura de fibra).
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = rng.range(0.05, 0.2);
    g.fillStyle = rng.chance(0.6) ? '#5c5c5c' : '#ffffff';
    g.fillRect(H + rng.float() * H, H, rng.range(0.8, 2.6), H);
  }
  g.globalAlpha = 0.35; g.fillStyle = '#3d3d3d';
  g.fillRect(H + H * 0.49, H, H * 0.02, H);
  g.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Desenha um cacho de folíolos num retângulo do atlas, com alpha recortado. */
function drawLeafCard(g, rng, x, y, w, h) {
  const cx = x + w * 0.5;
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Distribuição em pinha: mais folíolos perto do pecíolo (base do cartão).
    const along = Math.pow(rng.float(), 0.75);
    const py = y + h * (0.94 - along * 0.86);
    const spread = Math.sin(along * Math.PI * 0.9) * 0.46 + 0.06;
    const px = cx + (rng.float() * 2 - 1) * w * spread;
    const len = h * rng.range(0.10, 0.21) * (1.15 - along * 0.4);
    const wid = len * rng.range(0.34, 0.62);
    const ang = Math.atan2(px - cx, (y + h * 0.94) - py) * rng.range(0.5, 0.95) + rng.range(-0.25, 0.25);
    const shade = 0.62 + rng.float() * 0.38;
    g.save();
    g.translate(px, py);
    g.rotate(ang);
    g.fillStyle = `rgb(${(shade * 255) | 0},${(shade * 255) | 0},${(shade * 255) | 0})`;
    g.beginPath();
    // Folíolo lanceolado: dois arcos quadráticos.
    g.moveTo(0, len * 0.5);
    g.quadraticCurveTo(wid * 0.5, 0, 0, -len * 0.5);
    g.quadraticCurveTo(-wid * 0.5, 0, 0, len * 0.5);
    g.fill();
    g.restore();
    void t;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILDER DE MALHA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Acumulador de geometria. Arrays JS comuns porque só rodam no warm-up; a
 * conversão para Float32Array acontece uma vez em `geometry()`.
 */
class Builder {
  constructor() {
    this.p = []; this.n = []; this.uv = []; this.c = []; this.w = []; this.e = []; this.i = [];
  }

  get count() { return this.p.length / 3; }

  vert(px, py, pz, nx, ny, nz, u, v, r, g, b, wind, emis) {
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.push(r, g, b);
    this.w.push(wind);
    this.e.push(emis);
    return (this.p.length / 3) - 1;
  }

  tri(a, b, c) { this.i.push(a, b, c); }
  quadIdx(a, b, c, d) { this.i.push(a, b, c, a, c, d); }

  /** Converte (u,v) locais [0,1] para as coordenadas de uma região do atlas. */
  static ru(region, u, v) {
    return [region[0] + u * region[2], region[1] + v * region[3]];
  }

  /**
   * Tubo cônico segmentado ao longo de uma polilinha, com transporte paralelo
   * do frame (evita a torção que o frame de Frenet gera em curvas fortes).
   * @param {Array<{x,y,z,r,w,e}>} nodes
   */
  addTube(nodes, radial, region, colA, colB) {
    const N = nodes.length;
    if (N < 2 || radial < 3) return;
    // Frame inicial: normal arbitrária perpendicular à primeira tangente.
    _a.set(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y, nodes[1].z - nodes[0].z).normalize();
    _b.set(0, 0, 1);
    if (Math.abs(_a.dot(_b)) > 0.9) _b.set(1, 0, 0);
    const nrm = new THREE.Vector3().crossVectors(_b, _a).normalize();
    const bin = new THREE.Vector3().crossVectors(_a, nrm).normalize();
    const tan = new THREE.Vector3();
    const prevTan = _a.clone();

    const base = this.count;
    for (let k = 0; k < N; k++) {
      const nd = nodes[k];
      if (k === 0) tan.copy(prevTan);
      else if (k === N - 1) tan.set(nd.x - nodes[k - 1].x, nd.y - nodes[k - 1].y, nd.z - nodes[k - 1].z).normalize();
      else tan.set(nodes[k + 1].x - nodes[k - 1].x, nodes[k + 1].y - nodes[k - 1].y, nodes[k + 1].z - nodes[k - 1].z).normalize();
      // Transporte paralelo: rotaciona o frame pelo mínimo arco entre tangentes.
      _c.crossVectors(prevTan, tan);
      const s = _c.length();
      if (s > 1e-6) {
        _c.multiplyScalar(1 / s);
        const ang = Math.atan2(s, prevTan.dot(tan));
        nrm.applyAxisAngle(_c, ang);
      }
      bin.crossVectors(tan, nrm).normalize();
      nrm.crossVectors(bin, tan).normalize();
      prevTan.copy(tan);

      const t = k / (N - 1);
      const cr = lerp(colA[0], colB[0], t), cg = lerp(colA[1], colB[1], t), cb = lerp(colA[2], colB[2], t);
      const em = nd.e !== undefined ? nd.e : 0;
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * Math.PI * 2;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const nx = nrm.x * cs + bin.x * sn;
        const ny = nrm.y * cs + bin.y * sn;
        const nz = nrm.z * cs + bin.z * sn;
        const uvp = Builder.ru(region, j / radial, t * 2.0 % 1.0);
        this.vert(nd.x + nx * nd.r, nd.y + ny * nd.r, nd.z + nz * nd.r,
          nx, ny, nz, uvp[0], uvp[1], cr, cg, cb, nd.w, em);
      }
    }
    const ring = radial + 1;
    for (let k = 0; k < N - 1; k++) {
      for (let j = 0; j < radial; j++) {
        const a = base + k * ring + j;
        this.quadIdx(a, a + ring, a + ring + 1, a + 1);
      }
    }
  }

  /**
   * Quad orientado. `nOut` é a normal REGISTRADA nos vértices — para folhagem
   * passamos a direção do centro da copa para fora, o que dá sombreamento de
   * volume mesmo com cartões planos.
   */
  addCard(cx, cy, cz, rx, ry, rz, ux, uy, uz, hw, hh, region, col, wind, emis, nOut) {
    const n = nOut || { x: 0, y: 1, z: 0 };
    const uv0 = Builder.ru(region, 0, 0), uv1 = Builder.ru(region, 1, 1);
    const b = this.count;
    const px = [-hw, hw, hw, -hw], py = [-hh, -hh, hh, hh];
    const uu = [uv0[0], uv1[0], uv1[0], uv0[0]], vv = [uv0[1], uv0[1], uv1[1], uv1[1]];
    for (let k = 0; k < 4; k++) {
      // O peso do vento cresce com a altura do vértice dentro do cartão.
      const wk = wind * (0.72 + 0.28 * (py[k] > 0 ? 1 : 0));
      this.vert(cx + rx * px[k] + ux * py[k], cy + ry * px[k] + uy * py[k], cz + rz * px[k] + uz * py[k],
        n.x, n.y, n.z, uu[k], vv[k], col[0], col[1], col[2], wk, emis);
    }
    this.quadIdx(b, b + 1, b + 2, b + 3);
  }

  /**
   * Sólido de revolução a partir de um perfil (r, y). Cobre domo de copa,
   * chapéu de cogumelo, orbe e cápsula de esporo com um só caminho de código.
   * @param {Array<{r:number,y:number}>} profile de baixo para cima
   */
  addRevolve(ox, oy, oz, up, right, profile, segU, region, colBot, colTop, emis, wind, scaleR, scaleY) {
    const M = profile.length;
    if (M < 2 || segU < 3) return;
    _a.copy(up).normalize();
    _b.copy(right).sub(_a.clone().multiplyScalar(_a.dot(right)));
    if (_b.lengthSq() < 1e-8) _b.set(_a.y, -_a.x, 0);
    _b.normalize();
    _c.crossVectors(_a, _b).normalize();

    const base = this.count;
    for (let k = 0; k < M; k++) {
      const pr = profile[k].r * scaleR, py = profile[k].y * scaleY;
      const t = k / (M - 1);
      // Normal no plano (r,y) a partir da tangente do perfil.
      const kp = Math.min(M - 1, k + 1), km = Math.max(0, k - 1);
      const dr = (profile[kp].r - profile[km].r) * scaleR;
      const dy = (profile[kp].y - profile[km].y) * scaleY;
      let n2x = dy, n2y = -dr;
      const nl = Math.hypot(n2x, n2y) || 1;
      n2x /= nl; n2y /= nl;
      const cr = lerp(colBot[0], colTop[0], t), cg = lerp(colBot[1], colTop[1], t), cb = lerp(colBot[2], colTop[2], t);
      for (let j = 0; j <= segU; j++) {
        const ang = (j / segU) * Math.PI * 2;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const dx = _b.x * cs + _c.x * sn, dyv = _b.y * cs + _c.y * sn, dz = _b.z * cs + _c.z * sn;
        const nx = dx * n2x + _a.x * n2y, ny = dyv * n2x + _a.y * n2y, nz = dz * n2x + _a.z * n2y;
        const uvp = Builder.ru(region, j / segU, t);
        this.vert(ox + dx * pr + _a.x * py, oy + dyv * pr + _a.y * py, oz + dz * pr + _a.z * py,
          nx, ny, nz, uvp[0], uvp[1], cr, cg, cb, wind * t, emis * (0.35 + 0.65 * t));
      }
    }
    const ring = segU + 1;
    for (let k = 0; k < M - 1; k++) {
      for (let j = 0; j < segU; j++) {
        const a = base + k * ring + j;
        this.quadIdx(a, a + 1, a + ring + 1, a + ring);
      }
    }
  }

  /**
   * Prisma facetado (cristal). Faces planas com normais duplicadas — a leitura
   * de "mineral" depende de aresta dura, não de sombreamento suave.
   */
  addPrism(ox, oy, oz, dirX, dirY, dirZ, len, r0, r1, sides, region, colBot, colTop, emis) {
    _a.set(dirX, dirY, dirZ).normalize();
    _b.set(0, 0, 1);
    if (Math.abs(_a.dot(_b)) > 0.9) _b.set(1, 0, 0);
    _c.crossVectors(_b, _a).normalize();
    _d.crossVectors(_a, _c).normalize();
    const tipX = ox + _a.x * len, tipY = oy + _a.y * len, tipZ = oz + _a.z * len;
    const shoulder = 0.82;               // o topo afunila só no último quinto
    for (let j = 0; j < sides; j++) {
      const a0 = (j / sides) * Math.PI * 2, a1 = ((j + 1) / sides) * Math.PI * 2;
      const q0x = _c.x * Math.cos(a0) + _d.x * Math.sin(a0);
      const q0y = _c.y * Math.cos(a0) + _d.y * Math.sin(a0);
      const q0z = _c.z * Math.cos(a0) + _d.z * Math.sin(a0);
      const q1x = _c.x * Math.cos(a1) + _d.x * Math.sin(a1);
      const q1y = _c.y * Math.cos(a1) + _d.y * Math.sin(a1);
      const q1z = _c.z * Math.cos(a1) + _d.z * Math.sin(a1);
      const nx = (q0x + q1x) * 0.5, ny = (q0y + q1y) * 0.5, nz = (q0z + q1z) * 0.5;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const uv00 = Builder.ru(region, 0.1, 0), uv10 = Builder.ru(region, 0.9, 0);
      const uv01 = Builder.ru(region, 0.1, 1), uv11 = Builder.ru(region, 0.9, 1);
      const b = this.count;
      const sy = len * shoulder;
      this.vert(ox + q0x * r0, oy + q0y * r0, oz + q0z * r0, nx / nl, ny / nl, nz / nl, uv00[0], uv00[1], colBot[0], colBot[1], colBot[2], 0, emis * 0.4);
      this.vert(ox + q1x * r0, oy + q1y * r0, oz + q1z * r0, nx / nl, ny / nl, nz / nl, uv10[0], uv10[1], colBot[0], colBot[1], colBot[2], 0, emis * 0.4);
      this.vert(ox + _a.x * sy + q1x * r1, oy + _a.y * sy + q1y * r1, oz + _a.z * sy + q1z * r1, nx / nl, ny / nl, nz / nl, uv11[0], uv11[1], colTop[0], colTop[1], colTop[2], 0, emis);
      this.vert(ox + _a.x * sy + q0x * r1, oy + _a.y * sy + q0y * r1, oz + _a.z * sy + q0z * r1, nx / nl, ny / nl, nz / nl, uv01[0], uv01[1], colTop[0], colTop[1], colTop[2], 0, emis);
      this.quadIdx(b, b + 1, b + 2, b + 3);
      // Faceta da ponta.
      const t0 = this.vert(ox + _a.x * sy + q0x * r1, oy + _a.y * sy + q0y * r1, oz + _a.z * sy + q0z * r1, nx / nl, ny / nl, nz / nl, uv01[0], uv01[1], colTop[0], colTop[1], colTop[2], 0, emis);
      const t1 = this.vert(ox + _a.x * sy + q1x * r1, oy + _a.y * sy + q1y * r1, oz + _a.z * sy + q1z * r1, nx / nl, ny / nl, nz / nl, uv11[0], uv11[1], colTop[0], colTop[1], colTop[2], 0, emis);
      const t2 = this.vert(tipX, tipY, tipZ, _a.x, _a.y, _a.z, uv10[0], uv10[1], colTop[0], colTop[1], colTop[2], 0, emis * 1.4);
      this.tri(t0, t1, t2);
    }
  }

  /**
   * Fita curva de largura variável (lâmina de grama, fronde, pétala alongada).
   * @param {Array<{x,y,z,hw,w,sx,sy,sz}>} nodes hw = meia-largura; s = eixo lateral
   */
  addRibbon(nodes, region, colBot, colTop, emis) {
    const N = nodes.length;
    if (N < 2) return;
    const base = this.count;
    for (let k = 0; k < N; k++) {
      const nd = nodes[k];
      const t = k / (N - 1);
      // Normal = perpendicular ao plano (tangente × lateral).
      const kp = Math.min(N - 1, k + 1), km = Math.max(0, k - 1);
      _a.set(nodes[kp].x - nodes[km].x, nodes[kp].y - nodes[km].y, nodes[kp].z - nodes[km].z).normalize();
      _b.set(nd.sx, nd.sy, nd.sz).normalize();
      _c.crossVectors(_a, _b).normalize();
      const cr = lerp(colBot[0], colTop[0], t), cg = lerp(colBot[1], colTop[1], t), cb = lerp(colBot[2], colTop[2], t);
      const uvL = Builder.ru(region, 0.06, t), uvR = Builder.ru(region, 0.94, t);
      this.vert(nd.x - _b.x * nd.hw, nd.y - _b.y * nd.hw, nd.z - _b.z * nd.hw, _c.x, _c.y, _c.z, uvL[0], uvL[1], cr, cg, cb, nd.w, emis * t);
      this.vert(nd.x + _b.x * nd.hw, nd.y + _b.y * nd.hw, nd.z + _b.z * nd.hw, _c.x, _c.y, _c.z, uvR[0], uvR[1], cr, cg, cb, nd.w, emis * t);
    }
    for (let k = 0; k < N - 1; k++) {
      const a = base + k * 2;
      this.quadIdx(a, a + 1, a + 3, a + 2);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('aWindW', new THREE.BufferAttribute(new Float32Array(this.w), 1));
    g.setAttribute('aEmis', new THREE.BufferAttribute(new Float32Array(this.e), 1));
    const idx = this.count > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Devolve [r,g,b] LINEAR a partir de HSL em sRGB.
 * O atributo `color` do three é consumido no espaço de trabalho (linear), então
 * converter aqui evita vegetação lavada.
 */
function rgbLin(h, s, l, out) {
  _col.setHSL(h, s, l, THREE.SRGBColorSpace);
  const o = out || [0, 0, 0];
  o[0] = _col.r; o[1] = _col.g; o[2] = _col.b;
  return o;
}

/** Paleta derivada do bioma para uma espécie. */
function makePalette(rng, P, kind) {
  const [h0, h1] = P.hueRange;
  const baseHue = lerp(h0, h1, rng.float());
  const sat = clamp(P.saturation * rng.range(0.82, 1.12), 0.12, 1.0);
  const emis = P.emissive || 0;

  // Casca: matiz complementar amortecido — nunca o mesmo verde da folha, senão
  // a planta lê como um único blob de cor.
  const barkHue = (baseHue + rng.range(0.42, 0.6)) % 1;
  const barkSat = sat * rng.range(0.22, 0.42);

  const pal = {
    hue: baseHue,
    sat,
    emis,
    barkBot: rgbLin(barkHue, barkSat, rng.range(0.10, 0.20)),
    barkTop: rgbLin(barkHue, barkSat * 0.8, rng.range(0.20, 0.34)),
    leafDark: rgbLin(baseHue, sat, rng.range(0.16, 0.26)),
    leafLit: rgbLin((baseHue + rng.range(0.01, 0.06)) % 1, sat * rng.range(0.85, 1.05), rng.range(0.36, 0.54)),
    accent: rgbLin((baseHue + rng.range(0.3, 0.5)) % 1, clamp(sat * 1.15, 0, 1), rng.range(0.45, 0.66)),
    glow: rgbLin((baseHue + rng.range(-0.05, 0.05) + 1) % 1, clamp(sat * 1.2, 0, 1), rng.range(0.55, 0.75)),
  };
  if (kind === 'dead') {
    pal.barkBot = rgbLin(0.09, 0.10, 0.16);
    pal.barkTop = rgbLin(0.10, 0.07, 0.34);
  }
  return pal;
}

/** Variação de matiz por ramo — copa monocromática é o cheiro de placeholder. */
function branchTint(pal, rng, out) {
  const j = rng.range(-0.035, 0.035);
  const l = rng.range(0.80, 1.22);
  return rgbLin((pal.hue + j + 1) % 1, pal.sat * rng.range(0.9, 1.08), clamp(lerp(0.18, 0.5, rng.float()) * l, 0.06, 0.72), out);
}

// ═════════════════════════════════════════════════════════════════════════════
// PRIMITIVAS DE ALTO NÍVEL
// ═════════════════════════════════════════════════════════════════════════════

/** Perfil de meia-elipsoide (domo) de baixo para cima. */
function domeProfile(segV, flat) {
  const prof = [];
  for (let k = 0; k <= segV; k++) {
    const t = k / segV;
    const ang = t * Math.PI * 0.5;
    prof.push({ r: Math.cos(ang), y: Math.sin(ang) * (flat || 1) });
  }
  return prof;
}

/** Perfil de elipsoide inteiro (orbe, cápsula). */
function orbProfile(segV) {
  const prof = [];
  for (let k = 0; k <= segV * 2; k++) {
    const t = k / (segV * 2);
    const ang = -Math.PI * 0.5 + t * Math.PI;
    prof.push({ r: Math.cos(ang), y: Math.sin(ang) });
  }
  return prof;
}

/**
 * Cacho de folhagem em cartões cruzados.
 *
 * O truque de qualidade: a normal de cada cartão aponta do CENTRO do cacho para
 * fora. Com isso a copa recebe luz como um volume (lado do sol claro, lado
 * oposto escuro) mesmo sendo um punhado de quads. Uma esfera de folhas com
 * normais planas lê como adesivo.
 */
function addFoliage(mb, rng, pal, cx, cy, cz, radius, count, windW, upX, upY, upZ, flatten) {
  const col = [0, 0, 0];
  const nOut = { x: 0, y: 1, z: 0 };
  const fl = flatten === undefined ? 0.78 : flatten;
  for (let i = 0; i < count; i++) {
    // Direção pseudo-uniforme na esfera, achatada no eixo da planta.
    const z = rng.range(-0.55, 1.0);
    const th = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(Math.max(0, 1 - z * z));
    let dx = rr * Math.cos(th), dy = z, dz = rr * Math.sin(th);
    // Reorienta para o eixo da planta.
    const ax = upX, ay = upY, az = upZ;
    // Base ortonormal em torno de (ax,ay,az)
    let bx = 0, by = 0, bz = 1;
    if (Math.abs(az) > 0.9) { bx = 1; by = 0; bz = 0; }
    const t1x = by * az - bz * ay, t1y = bz * ax - bx * az, t1z = bx * ay - by * ax;
    const l1 = Math.hypot(t1x, t1y, t1z) || 1;
    const e1x = t1x / l1, e1y = t1y / l1, e1z = t1z / l1;
    const e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
    const wx = e1x * dx + e2x * dz + ax * dy;
    const wy = e1y * dx + e2y * dz + ay * dy;
    const wz = e1z * dx + e2z * dz + az * dy;
    dx = wx; dy = wy; dz = wz;

    const dist = radius * Math.pow(rng.range(0.28, 1.0), 0.55);
    const px = cx + dx * dist, py = cy + dy * dist * fl, pz = cz + dz * dist;
    nOut.x = dx; nOut.y = dy * 0.7 + ay * 0.5; nOut.z = dz;
    const nl = Math.hypot(nOut.x, nOut.y, nOut.z) || 1;
    nOut.x /= nl; nOut.y /= nl; nOut.z /= nl;

    branchTint(pal, rng, col);
    const size = radius * rng.range(0.42, 0.82);
    // Eixo do cartão: levemente inclinado, nunca alinhado ao anterior.
    const yaw = rng.float() * Math.PI * 2;
    const ux = e1x * Math.cos(yaw) * 0.35 + ax * 0.94;
    const uy = e1y * Math.cos(yaw) * 0.35 + ay * 0.94;
    const uz = e1z * Math.cos(yaw) * 0.35 + az * 0.94;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const rxv = uy / ul * dz - uz / ul * dy;
    const ryv = uz / ul * dx - ux / ul * dz;
    const rzv = ux / ul * dy - uy / ul * dx;
    const rl = Math.hypot(rxv, ryv, rzv) || 1;
    mb.addCard(px, py, pz, rxv / rl, ryv / rl, rzv / rl, ux / ul, uy / ul, uz / ul,
      size, size * rng.range(0.7, 1.1), REGION.LEAF, col, windW, pal.emis * 0.35, nOut);
  }
}

/**
 * Ramificação recursiva (L-system numérico).
 * Ângulo e razão de comprimento saem da seed, então duas árvores da mesma
 * espécie têm a mesma "gramática" mas silhuetas diferentes.
 */
function growBranch(mb, rng, pal, S, o, dir, len, rad, depth, windBase) {
  const L = S.L;
  const segs = Math.max(2, L.seg + (depth === 0 ? 2 : 0) - depth);
  const nodes = [];
  const px = { x: o.x, y: o.y, z: o.z };
  const d = { x: dir.x, y: dir.y, z: dir.z };
  const step = len / segs;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const r = rad * Math.pow(1 - t * S.taper, 1.35) + S.minRad;
    nodes.push({ x: px.x, y: px.y, z: px.z, r, w: windBase + (1 - windBase) * Math.pow(t, 1.6) * S.windGain });
    if (k === segs) break;
    // Curvatura: gravidade + fototropismo + ruído do galho.
    d.y += S.phototropism * step * 0.06 - S.droop * step * 0.05 * depth;
    d.x += rng.range(-1, 1) * S.wobble * step * 0.05;
    d.z += rng.range(-1, 1) * S.wobble * step * 0.05;
    const dl = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= dl; d.y /= dl; d.z /= dl;
    px.x += d.x * step; px.y += d.y * step; px.z += d.z * step;
  }
  mb.addTube(nodes, Math.max(3, L.radial - depth), REGION.BARK, pal.barkBot, pal.barkTop);

  const tip = nodes[nodes.length - 1];
  const tipW = tip.w;

  if (depth >= L.depth - 1 || len < S.minLen) {
    if (S.foliage > 0) {
      const cnt = Math.max(1, Math.round(S.foliage * L.cards * rng.range(0.7, 1.3)));
      addFoliage(mb, rng, pal, tip.x, tip.y, tip.z, len * S.clusterR, cnt, tipW, d.x, d.y, d.z, S.flatten);
    }
    return;
  }

  const nChild = rng.intRange(S.childMin, S.childMax);
  const baseAz = rng.float() * Math.PI * 2;
  // Base ortonormal em torno da direção atual, para espalhar os filhos.
  _a.set(d.x, d.y, d.z).normalize();
  _b.set(0, 1, 0);
  if (Math.abs(_a.dot(_b)) > 0.92) _b.set(1, 0, 0);
  _c.crossVectors(_b, _a).normalize();
  _d.crossVectors(_a, _c).normalize();

  for (let i = 0; i < nChild; i++) {
    const az = baseAz + (i / nChild) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const ang = S.angle * rng.range(0.72, 1.28);
    const cx = Math.cos(az), sz = Math.sin(az);
    const nx = _a.x * Math.cos(ang) + (_c.x * cx + _d.x * sz) * Math.sin(ang);
    const ny = _a.y * Math.cos(ang) + (_c.y * cx + _d.y * sz) * Math.sin(ang);
    const nz = _a.z * Math.cos(ang) + (_c.z * cx + _d.z * sz) * Math.sin(ang);
    // Ponto de inserção escalonado ao longo do ramo pai: galhos não saem todos
    // do mesmo nó (isso produz a "mão de banana" típica de gerador ingênuo).
    const at = Math.min(nodes.length - 1, Math.floor(lerp(nodes.length * 0.45, nodes.length - 1, i / Math.max(1, nChild - 1) * rng.range(0.6, 1.0))));
    const an = nodes[at];
    growBranch(mb, rng, pal, S,
      { x: an.x, y: an.y, z: an.z }, { x: nx, y: ny, z: nz },
      len * S.lenRatio * rng.range(0.82, 1.18), an.r * S.radRatio, depth + 1, an.w);
  }

  // Broto dominante: continua a direção do pai, mais curto. É o que dá a
  // silhueta assimétrica de árvore real em vez do "Y" perfeito.
  if (rng.chance(S.leader)) {
    growBranch(mb, rng, pal, S, { x: tip.x, y: tip.y, z: tip.z }, d,
      len * S.lenRatio * 0.86, tip.r * S.radRatio * 1.05, depth + 1, tipW);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GERADORES POR TIPO
// ═════════════════════════════════════════════════════════════════════════════

const GEN = {};

GEN.tree_broad = (mb, rng, pal, P, L, H) => {
  const S = {
    L, taper: 0.75, minRad: H * 0.0035, angle: rng.range(0.48, 0.92), lenRatio: rng.range(0.6, 0.78),
    radRatio: rng.range(0.52, 0.68), childMin: 2, childMax: 3, leader: 0.55,
    phototropism: 0.9, droop: 0.5, wobble: 1.5, windGain: 1, minLen: H * 0.08,
    foliage: 7, clusterR: 0.95, flatten: 0.72,
  };
  growBranch(mb, rng, pal, S, { x: 0, y: 0, z: 0 }, { x: rng.range(-0.06, 0.06), y: 1, z: rng.range(-0.06, 0.06) },
    H * rng.range(0.34, 0.44), H * rng.range(0.030, 0.046), 0, 0);
  addRootFlare(mb, rng, pal, H * 0.03, H * 0.055);
};

GEN.dead_tree = (mb, rng, pal, P, L, H) => {
  const S = {
    L, taper: 0.86, minRad: H * 0.002,
    angle: rng.range(0.7, 1.25), lenRatio: rng.range(0.54, 0.7), radRatio: rng.range(0.44, 0.6),
    childMin: 2, childMax: 3, leader: 0.35, phototropism: 0.35, droop: 0.2, wobble: 5.0,
    windGain: 0.35, minLen: H * 0.05, foliage: 0, clusterR: 0.6, flatten: 1,
  };
  growBranch(mb, rng, pal, S, { x: 0, y: 0, z: 0 }, { x: rng.range(-0.16, 0.16), y: 1, z: rng.range(-0.16, 0.16) },
    H * rng.range(0.3, 0.4), H * rng.range(0.026, 0.04), 0, 0);
  addRootFlare(mb, rng, pal, H * 0.028, H * 0.05);
};

GEN.pine = (mb, rng, pal, P, L, H) => {
  // Tronco reto e contínuo: a conífera é definida pela verticalidade.
  const segs = Math.max(4, L.seg * 3);
  const nodes = [];
  const lean = rng.range(-0.02, 0.02);
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    nodes.push({ x: lean * t * t * H, y: t * H, z: lean * 0.6 * t * t * H, r: H * 0.028 * (1 - t * 0.94) + 0.02, w: Math.pow(t, 2.2) * 0.5 });
  }
  mb.addTube(nodes, L.radial, REGION.BARK, pal.barkBot, pal.barkTop);

  const whorls = Math.max(3, Math.round(7 * (L.cards > 0.4 ? 1 : 0.55)));
  const col = [0, 0, 0];
  for (let wi = 0; wi < whorls; wi++) {
    const t = 0.22 + (wi / whorls) * 0.76;
    const y = t * H;
    const radius = H * 0.30 * (1 - t) * rng.range(0.85, 1.15) + H * 0.02;
    const nb = Math.max(3, Math.round((6 - wi * 0.3) * (L.cards > 0.4 ? 1 : 0.6)));
    const az0 = rng.float() * Math.PI * 2;
    for (let b = 0; b < nb; b++) {
      const az = az0 + (b / nb) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const dx = Math.cos(az), dz = Math.sin(az);
      const droop = -rng.range(0.18, 0.42);
      const tipx = dx * radius, tipy = y + droop * radius, tipz = dz * radius;
      // Galho fino.
      mb.addTube([
        { x: 0, y, z: 0, r: H * 0.006, w: 0.05 },
        { x: tipx * 0.5, y: y + droop * radius * 0.35, z: tipz * 0.5, r: H * 0.004, w: 0.3 },
        { x: tipx, y: tipy, z: tipz, r: H * 0.0015, w: 0.75 },
      ], 3, REGION.BARK, pal.barkBot, pal.barkTop);
      // Ramalhete de acículas: cartões estreitos e alongados ao longo do galho.
      const cards = Math.max(1, Math.round(3 * L.cards + 1));
      for (let c = 0; c < cards; c++) {
        const ct = 0.35 + (c / cards) * 0.62;
        const px = tipx * ct, py = y + droop * radius * ct * ct, pz = tipz * ct;
        branchTint(pal, rng, col);
        const size = radius * rng.range(0.3, 0.5);
        mb.addCard(px, py, pz, -dz, 0, dx, dx * 0.25, 1, dz * 0.25, size * 1.5, size * 0.55,
          REGION.LEAF, col, 0.25 + ct * 0.4, pal.emis * 0.2, { x: dx * 0.5, y: 0.85, z: dz * 0.5 });
        mb.addCard(px, py, pz, dx, 0, dz, 0, 1, 0, size * 1.2, size * 0.55,
          REGION.LEAF, col, 0.25 + ct * 0.4, pal.emis * 0.2, { x: dx * 0.5, y: 0.85, z: dz * 0.5 });
      }
    }
  }
  addRootFlare(mb, rng, pal, H * 0.026, H * 0.05);
};

GEN.tree_palm = (mb, rng, pal, P, L, H) => {
  // Tronco em arco: a curva é a assinatura da palmeira.
  const segs = Math.max(4, L.seg * 3);
  const bend = rng.range(0.12, 0.34) * (rng.chance(0.5) ? 1 : -1);
  const az = rng.float() * Math.PI * 2;
  const bx = Math.cos(az) * bend, bz = Math.sin(az) * bend;
  const nodes = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    nodes.push({
      x: bx * t * t * H, y: t * H, z: bz * t * t * H,
      r: H * (0.030 - 0.012 * t) * (1 + 0.18 * Math.sin(t * 22)), // anéis de cicatriz
      w: Math.pow(t, 2.0) * 0.55,
    });
  }
  mb.addTube(nodes, L.radial, REGION.BARK, pal.barkBot, pal.barkTop);
  const top = nodes[nodes.length - 1];
  const tipDir = { x: bx * 2 / (2 + 1), y: 1, z: bz * 2 / (2 + 1) };
  const tl = Math.hypot(tipDir.x, tipDir.y, tipDir.z);
  tipDir.x /= tl; tipDir.y /= tl; tipDir.z /= tl;

  const fronds = Math.max(3, Math.round(rng.intRange(7, 11) * (0.34 + 0.66 * L.cards)));
  const fseg = Math.max(3, L.seg + 2);
  const col = [0, 0, 0];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng.range(-0.18, 0.18);
    const dx = Math.cos(a), dz = Math.sin(a);
    const len = H * rng.range(0.32, 0.48);
    const lift = rng.range(0.35, 0.95);
    branchTint(pal, rng, col);
    const rnodes = [];
    for (let k = 0; k <= fseg; k++) {
      const t = k / fseg;
      // Arco: sobe e cai — parábola invertida.
      const y = top.y + len * (lift * t - (lift + 0.55) * t * t);
      rnodes.push({
        x: top.x + dx * len * t * 0.92, y, z: top.z + dz * len * t * 0.92,
        hw: len * 0.14 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.92) + len * 0.012,
        w: 0.25 + Math.pow(t, 1.6) * 0.75,
        sx: -dz, sy: 0, sz: dx,
      });
    }
    mb.addRibbon(rnodes, REGION.BLADE, pal.leafDark, col, pal.emis * 0.25);
    // Folíolos recortados nas bordas dão silhueta de fronde, não de remo.
    if (L.cards > 0.35) {
      const nlf = Math.max(2, Math.round(5 * L.cards));
      for (let k = 1; k <= nlf; k++) {
        const t = k / (nlf + 1);
        const nd = rnodes[Math.min(rnodes.length - 1, Math.round(t * fseg))];
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          mb.addCard(nd.x + nd.sx * nd.hw * sgn, nd.y, nd.z + nd.sz * nd.hw * sgn,
            nd.sx * sgn, 0, nd.sz * sgn, dx * 0.4, -0.5, dz * 0.4,
            nd.hw * 1.1, nd.hw * 1.6, REGION.LEAF, col, nd.w, pal.emis * 0.25,
            { x: dx * 0.4, y: 0.9, z: dz * 0.4 });
        }
      }
    }
  }
  addRootFlare(mb, rng, pal, H * 0.032, H * 0.05);
};

GEN.bush = (mb, rng, pal, P, L, H) => {
  const stems = Math.max(2, Math.round(rng.intRange(5, 9) * (L.cards > 0.4 ? 1 : 0.5)));
  for (let s = 0; s < stems; s++) {
    const a = rng.float() * Math.PI * 2;
    const tilt = rng.range(0.35, 0.85);
    const dir = { x: Math.cos(a) * tilt, y: 1, z: Math.sin(a) * tilt };
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= dl; dir.y /= dl; dir.z /= dl;
    const S = {
      L: { ...L, depth: Math.min(3, L.depth) }, taper: 0.8, minRad: H * 0.006,
      angle: rng.range(0.55, 1.0), lenRatio: 0.62, radRatio: 0.6, childMin: 2, childMax: 3,
      leader: 0.3, phototropism: 1.4, droop: 0.4, wobble: 3.0, windGain: 1, minLen: H * 0.2,
      foliage: 5, clusterR: 1.1, flatten: 0.9,
    };
    growBranch(mb, rng, pal, S, { x: 0, y: 0, z: 0 }, dir, H * rng.range(0.5, 0.85), H * 0.045, 1, 0.12);
  }
};

GEN.fern = (mb, rng, pal, P, L, H) => {
  const fronds = Math.max(3, Math.round(rng.intRange(6, 10) * (L.cards > 0.4 ? 1 : 0.5)));
  const fseg = Math.max(3, L.seg + 2);
  const col = [0, 0, 0];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dx = Math.cos(a), dz = Math.sin(a);
    const len = H * rng.range(0.8, 1.25);
    branchTint(pal, rng, col);
    const rnodes = [];
    const lift = rng.range(0.9, 1.5);
    for (let k = 0; k <= fseg; k++) {
      const t = k / fseg;
      rnodes.push({
        x: dx * len * t * 0.72, y: len * (lift * t - (lift + 0.35) * t * t * 0.9), z: dz * len * t * 0.72,
        hw: len * 0.10 * Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.9) + len * 0.006,
        w: 0.15 + Math.pow(t, 1.4) * 0.85, sx: -dz, sy: 0, sz: dx,
      });
    }
    mb.addRibbon(rnodes, REGION.BLADE, pal.leafDark, col, pal.emis * 0.3);
    if (L.cards > 0.35) {
      const nlf = Math.max(2, Math.round(4 * L.cards + 1));
      for (let k = 1; k <= nlf; k++) {
        const t = k / (nlf + 1);
        const nd = rnodes[Math.min(rnodes.length - 1, Math.round(t * fseg))];
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          mb.addCard(nd.x + nd.sx * nd.hw * sgn * 1.1, nd.y, nd.z + nd.sz * nd.hw * sgn * 1.1,
            nd.sx * sgn, 0, nd.sz * sgn, dx * 0.5, 0.6, dz * 0.5,
            nd.hw * 1.4, nd.hw * 1.9, REGION.LEAF, col, nd.w, pal.emis * 0.3,
            { x: dx * 0.35, y: 0.92, z: dz * 0.35 });
        }
      }
    }
  }
};

GEN.grass = (mb, rng, pal, P, L, H) => {
  // Tufo: 3-5 lâminas curvas em fita, cada uma com gradiente da base ao topo.
  // O gradiente é o que impede o "carpete plástico" — base olivácea escura,
  // ponta clara e levemente amarelada.
  const blades = Math.max(2, Math.round(L.blades * rng.range(0.8, 1.25)));
  const bot = rgbLin((pal.hue + 0.02) % 1, clamp(pal.sat * 1.05, 0, 1), 0.11);
  for (let b = 0; b < blades; b++) {
    const a = rng.float() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const len = H * rng.range(0.65, 1.35);
    const bendAmt = rng.range(0.35, 1.0);
    const segs = Math.max(2, L.seg + 1);
    const top = rgbLin((pal.hue + rng.range(0.0, 0.09)) % 1, clamp(pal.sat * rng.range(0.7, 1.0), 0, 1), rng.range(0.36, 0.6));
    const rnodes = [];
    const ox = rng.range(-0.12, 0.12) * H, oz = rng.range(-0.12, 0.12) * H;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      rnodes.push({
        x: ox + dx * len * bendAmt * t * t * 0.75,
        y: len * (t - 0.28 * bendAmt * t * t),
        z: oz + dz * len * bendAmt * t * t * 0.75,
        hw: len * 0.055 * (1 - t * 0.94) + 0.002,
        w: Math.pow(t, 1.35),
        sx: -dz, sy: 0, sz: dx,
      });
    }
    mb.addRibbon(rnodes, REGION.BLADE, bot, top, pal.emis * 0.4);
  }
};

GEN.mushroom_tall = (mb, rng, pal, P, L, H) => {
  const stipeH = H * rng.range(0.6, 0.78);
  const lean = rng.range(-0.1, 0.1);
  const az = rng.float() * Math.PI * 2;
  const segs = Math.max(3, L.seg * 2);
  const nodes = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    // Base bulbosa e afinamento no meio: cogumelo não é cilindro.
    const r = H * (0.07 * Math.pow(1 - t, 2.2) + 0.028 + 0.012 * t * t);
    nodes.push({
      x: Math.cos(az) * lean * t * t * H, y: t * stipeH, z: Math.sin(az) * lean * t * t * H,
      r, w: Math.pow(t, 2.5) * 0.5, e: pal.emis * 0.15 * t,
    });
  }
  mb.addTube(nodes, L.radial, REGION.SOLID, pal.barkTop, pal.leafDark);
  const top = nodes[nodes.length - 1];

  const capR = H * rng.range(0.24, 0.4);
  const capH = capR * rng.range(0.55, 1.05);
  const capTop = rgbLin((pal.hue + rng.range(-0.03, 0.03) + 1) % 1, clamp(pal.sat * 1.1, 0, 1), rng.range(0.32, 0.5));
  mb.addRevolve(top.x, top.y, top.z, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
    domeProfile(L.revV, 1), L.revU, REGION.SOLID, pal.leafDark, capTop, pal.emis, 0.35, capR, capH);

  // Lamelas: cartões radiais sob o chapéu, com emissivo forte (bioluminescência).
  if (L.cards > 0.3) {
    const gills = Math.max(4, Math.round(10 * L.cards));
    for (let g = 0; g < gills; g++) {
      const a = (g / gills) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      mb.addCard(top.x + dx * capR * 0.55, top.y + capH * 0.06, top.z + dz * capR * 0.55,
        dx, 0, dz, 0, 1, 0, capR * 0.45, capH * 0.14, REGION.SOLID,
        pal.glow, 0.2, Math.max(pal.emis, 0.25) * 1.6, { x: 0, y: -1, z: 0 });
    }
    // Aro luminoso na borda.
    mb.addRevolve(top.x, top.y + capH * 0.02, top.z, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
      [{ r: 0.98, y: 0 }, { r: 1.0, y: 0.06 }], L.revU, REGION.SOLID, pal.glow, pal.glow,
      Math.max(pal.emis, 0.3) * 1.8, 0.25, capR, capH);
  }
};

GEN.mushroom_cap = (mb, rng, pal, P, L, H) => {
  const n = rng.intRange(2, 3);
  for (let i = 0; i < n; i++) {
    const s = i === 0 ? 1 : rng.range(0.4, 0.75);
    const ox = i === 0 ? 0 : rng.range(-0.6, 0.6) * H;
    const oz = i === 0 ? 0 : rng.range(-0.6, 0.6) * H;
    const stipeH = H * s * rng.range(0.42, 0.6);
    const segs = Math.max(2, L.seg);
    const nodes = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      nodes.push({ x: ox, y: t * stipeH, z: oz, r: H * s * (0.1 * Math.pow(1 - t, 1.8) + 0.055), w: t * 0.3 });
    }
    mb.addTube(nodes, Math.max(3, L.radial - 1), REGION.SOLID, pal.barkTop, pal.leafDark);
    const capR = H * s * rng.range(0.45, 0.72);
    const capH = capR * rng.range(0.3, 0.55);
    const capTop = rgbLin((pal.hue + rng.range(-0.04, 0.04) + 1) % 1, clamp(pal.sat * 1.15, 0, 1), rng.range(0.3, 0.52));
    mb.addRevolve(ox, stipeH, oz, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
      domeProfile(L.revV, 1), L.revU, REGION.SOLID, pal.accent, capTop, pal.emis * 1.2, 0.2, capR, capH);
  }
};

GEN.tendril = (mb, rng, pal, P, L, H) => {
  const n = Math.max(1, Math.round(rng.intRange(2, 4) * (0.4 + 0.6 * L.cards)));
  for (let i = 0; i < n; i++) {
    const az = rng.float() * Math.PI * 2;
    const segs = Math.max(4, L.seg * 3);
    const nodes = [];
    const coil = rng.range(1.4, 3.6);
    const rad = H * rng.range(0.06, 0.18);
    const ox = rng.range(-0.25, 0.25) * H, oz = rng.range(-0.25, 0.25) * H;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const a = az + t * coil;
      const rr = rad * Math.sin(t * Math.PI * 0.85);
      nodes.push({
        x: ox + Math.cos(a) * rr, y: t * H * rng.range(0.95, 1.0), z: oz + Math.sin(a) * rr,
        r: H * 0.022 * (1 - t * 0.9) + H * 0.002,
        w: Math.pow(t, 1.15), e: pal.emis * t * t,
      });
    }
    mb.addTube(nodes, Math.max(3, L.radial - 1), REGION.SOLID, pal.barkBot, pal.glow);
    // Folíolos pareados ao longo do caule.
    if (L.cards > 0.3) {
      const leaves = Math.max(2, Math.round(6 * L.cards));
      const col = [0, 0, 0];
      for (let k = 1; k <= leaves; k++) {
        const t = k / (leaves + 1);
        const nd = nodes[Math.min(nodes.length - 1, Math.round(t * segs))];
        branchTint(pal, rng, col);
        const a = az + t * coil + Math.PI * 0.5;
        const dx = Math.cos(a), dz = Math.sin(a);
        const sz2 = H * 0.09 * (1 - t * 0.5);
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          mb.addCard(nd.x + dx * sz2 * sgn, nd.y, nd.z + dz * sz2 * sgn, dx * sgn, 0, dz * sgn,
            0, 1, 0, sz2, sz2 * 1.3, REGION.LEAF, col, nd.w, pal.emis * 0.6,
            { x: dx * sgn * 0.5, y: 0.86, z: dz * sgn * 0.5 });
        }
      }
    }
    // Bulbo luminoso na ponta.
    const tip = nodes[nodes.length - 1];
    mb.addRevolve(tip.x, tip.y, tip.z, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
      orbProfile(Math.max(2, L.revV - 1)), Math.max(4, L.revU - 2), REGION.SOLID,
      pal.glow, pal.glow, Math.max(pal.emis, 0.2) * 2.0, 1.0, H * 0.055, H * 0.075);
  }
};

GEN.spore_pod = (mb, rng, pal, P, L, H) => {
  const stalkH = H * rng.range(0.45, 0.62);
  const segs = Math.max(2, L.seg);
  const nodes = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    nodes.push({ x: 0, y: t * stalkH, z: 0, r: H * (0.09 * Math.pow(1 - t, 1.6) + 0.045), w: t * 0.35 });
  }
  mb.addTube(nodes, Math.max(3, L.radial - 1), REGION.SOLID, pal.barkBot, pal.barkTop);
  const podR = H * rng.range(0.2, 0.32);
  const podH = podR * rng.range(1.1, 1.8);
  mb.addRevolve(0, stalkH + podH * 0.9, 0, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
    orbProfile(L.revV), L.revU, REGION.SOLID, pal.leafDark, pal.glow,
    Math.max(pal.emis, 0.15) * 1.4, 0.3, podR, podH);
  // Espinhos de deiscência no topo.
  if (L.cards > 0.3) {
    const spikes = Math.max(3, Math.round(5 * L.cards + 2));
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
      mb.addPrism(dx * podR, stalkH + podH * 1.75, dz * podR, dx, 1, dz,
        podR * rng.range(0.5, 0.9), podR * 0.13, podR * 0.02, 4, REGION.SOLID,
        pal.accent, pal.glow, Math.max(pal.emis, 0.2) * 1.6);
    }
  }
};

GEN.crystal_shard = (mb, rng, pal, P, L, H) => {
  const shards = Math.max(2, Math.round(rng.intRange(3, 6) * (L.cards > 0.4 ? 1 : 0.6)));
  const sides = L.radial >= 6 ? 6 : L.radial >= 5 ? 5 : 4;
  for (let i = 0; i < shards; i++) {
    const a = rng.float() * Math.PI * 2;
    const tilt = rng.range(0.06, 0.42) * (i === 0 ? 0.35 : 1);
    const dx = Math.cos(a) * tilt, dz = Math.sin(a) * tilt;
    const dl = Math.hypot(dx, 1, dz);
    const len = H * (i === 0 ? rng.range(0.75, 1.0) : rng.range(0.28, 0.7));
    const r0 = len * rng.range(0.09, 0.16);
    const ox = Math.cos(a) * H * rng.range(0.0, 0.22) * (i === 0 ? 0 : 1);
    const oz = Math.sin(a) * H * rng.range(0.0, 0.22) * (i === 0 ? 0 : 1);
    const hue = (pal.hue + rng.range(-0.05, 0.05) + 1) % 1;
    const cBot = rgbLin(hue, clamp(pal.sat * 1.1, 0, 1), rng.range(0.14, 0.24));
    const cTop = rgbLin(hue, clamp(pal.sat * 0.85, 0, 1), rng.range(0.5, 0.78));
    mb.addPrism(ox, -len * 0.05, oz, dx / dl, 1 / dl, dz / dl, len, r0, r0 * rng.range(0.25, 0.55),
      sides, REGION.SOLID, cBot, cTop, Math.max(pal.emis, 0.12) * rng.range(1.2, 2.2));
  }
};

GEN.orb_tree = (mb, rng, pal, P, L, H) => {
  const S = {
    L: { ...L, depth: Math.min(3, L.depth) }, taper: 0.82, minRad: H * 0.003,
    angle: rng.range(0.35, 0.62), lenRatio: 0.66, radRatio: 0.55, childMin: 2, childMax: 3,
    leader: 0.5, phototropism: 1.6, droop: 0.15, wobble: 1.0, windGain: 1,
    minLen: H * 0.12, foliage: 0, clusterR: 0.7, flatten: 1,
  };
  growBranch(mb, rng, pal, S, { x: 0, y: 0, z: 0 }, { x: rng.range(-0.04, 0.04), y: 1, z: rng.range(-0.04, 0.04) },
    H * rng.range(0.36, 0.46), H * rng.range(0.018, 0.03), 0, 0);

  // Orbes suspensos: geometria de revolução com emissivo alto — a assinatura
  // do bioma exótico. Distribuídos numa casca elíptica em torno da copa.
  const orbs = Math.max(2, Math.round(rng.intRange(5, 9) * (L.cards > 0.4 ? 1 : 0.5)));
  for (let i = 0; i < orbs; i++) {
    const a = rng.float() * Math.PI * 2;
    const rr = H * rng.range(0.1, 0.34);
    const y = H * rng.range(0.55, 0.98);
    const rad = H * rng.range(0.035, 0.085);
    const hue = (pal.hue + rng.range(-0.06, 0.06) + 1) % 1;
    const cg = rgbLin(hue, clamp(pal.sat * 1.1, 0, 1), rng.range(0.55, 0.78));
    mb.addRevolve(Math.cos(a) * rr, y, Math.sin(a) * rr, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
      orbProfile(Math.max(2, L.revV - 1)), Math.max(4, L.revU - 2), REGION.SOLID,
      cg, cg, Math.max(pal.emis, 0.35) * 2.2, 0.8, rad, rad);
  }
  // Alguns cartões translúcidos pendentes dão volume sem esfera opaca.
  if (L.cards > 0.3) {
    const cards = Math.max(2, Math.round(8 * L.cards));
    const col = [0, 0, 0];
    for (let i = 0; i < cards; i++) {
      const a = rng.float() * Math.PI * 2;
      const rr = H * rng.range(0.12, 0.36);
      const y = H * rng.range(0.5, 0.95);
      branchTint(pal, rng, col);
      const sz2 = H * rng.range(0.08, 0.16);
      mb.addCard(Math.cos(a) * rr, y, Math.sin(a) * rr, Math.cos(a + 1.57), 0, Math.sin(a + 1.57),
        0, -1, 0, sz2, sz2 * 1.6, REGION.LEAF, col, 0.8, pal.emis * 0.9,
        { x: Math.cos(a) * 0.6, y: 0.5, z: Math.sin(a) * 0.6 });
    }
  }
};

GEN.flower = (mb, rng, pal, P, L, H) => {
  const n = rng.intRange(1, 3);
  for (let i = 0; i < n; i++) {
    const ox = i === 0 ? 0 : rng.range(-0.5, 0.5) * H;
    const oz = i === 0 ? 0 : rng.range(-0.5, 0.5) * H;
    const h = H * (i === 0 ? 1 : rng.range(0.6, 0.95));
    const segs = Math.max(2, L.seg);
    const lean = rng.range(-0.15, 0.15);
    const az = rng.float() * Math.PI * 2;
    const nodes = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      nodes.push({
        x: ox + Math.cos(az) * lean * t * t * h, y: t * h * 0.82, z: oz + Math.sin(az) * lean * t * t * h,
        r: h * 0.022 * (1 - t * 0.4), w: Math.pow(t, 1.2),
      });
    }
    mb.addTube(nodes, 3, REGION.SOLID, pal.leafDark, pal.leafLit);
    const top = nodes[nodes.length - 1];
    const petals = rng.intRange(5, 8);
    const pr = h * rng.range(0.2, 0.34);
    const hue = (pal.hue + rng.range(0.28, 0.55)) % 1;
    const pc = rgbLin(hue, clamp(pal.saturation === undefined ? pal.sat * 1.3 : pal.sat * 1.3, 0, 1), rng.range(0.48, 0.7));
    for (let p = 0; p < petals; p++) {
      const a = (p / petals) * Math.PI * 2 + rng.range(-0.1, 0.1);
      const dx = Math.cos(a), dz = Math.sin(a);
      mb.addCard(top.x + dx * pr * 0.7, top.y + pr * 0.16, top.z + dz * pr * 0.7,
        -dz, 0, dx, dx * 0.55, 0.83, dz * 0.55, pr * 0.42, pr * 0.75,
        REGION.LEAF, pc, top.w, pal.emis * 0.8, { x: dx * 0.3, y: 0.94, z: dz * 0.3 });
    }
    // Disco central.
    mb.addRevolve(top.x, top.y + pr * 0.1, top.z, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 },
      domeProfile(Math.max(2, L.revV - 2), 0.5), Math.max(4, L.revU - 3), REGION.SOLID,
      pal.accent, pal.glow, Math.max(pal.emis, 0.08) * 1.5, 0.5, pr * 0.3, pr * 0.22);
  }
};

GEN.coral = (mb, rng, pal, P, L, H) => {
  const arms = Math.max(2, Math.round(rng.intRange(4, 7) * (L.cards > 0.4 ? 1 : 0.55)));
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const tilt = rng.range(0.3, 0.75);
    const dir = { x: Math.cos(a) * tilt, y: 1, z: Math.sin(a) * tilt };
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= dl; dir.y /= dl; dir.z /= dl;
    const S = {
      L: { ...L, depth: Math.min(3, L.depth) }, taper: 0.45, minRad: H * 0.02,
      angle: rng.range(0.6, 1.05), lenRatio: 0.6, radRatio: 0.72, childMin: 2, childMax: 3,
      leader: 0.25, phototropism: 1.1, droop: 0.3, wobble: 2.2, windGain: 0.2,
      minLen: H * 0.2, foliage: 0, clusterR: 0.5, flatten: 1,
    };
    growBranch(mb, rng, pal, S, { x: 0, y: 0, z: 0 }, dir, H * rng.range(0.42, 0.7), H * 0.07, 1, 0.05);
  }
  // Leques membranosos entre os braços — a leitura de coral vem daqui.
  if (L.cards > 0.3) {
    const fans = Math.max(2, Math.round(6 * L.cards));
    const col = [0, 0, 0];
    for (let i = 0; i < fans; i++) {
      const a = rng.float() * Math.PI * 2;
      const rr = H * rng.range(0.15, 0.42);
      const y = H * rng.range(0.2, 0.7);
      branchTint(pal, rng, col);
      const sz2 = H * rng.range(0.18, 0.34);
      mb.addCard(Math.cos(a) * rr, y, Math.sin(a) * rr, Math.cos(a + 1.57), 0, Math.sin(a + 1.57),
        0, 1, 0, sz2, sz2 * 0.85, REGION.LEAF, col, 0.35, pal.emis * 0.7,
        { x: Math.cos(a + 1.57), y: 0.15, z: Math.sin(a + 1.57) });
    }
  }
};

/** Alargamento da base do tronco — sem isso a árvore parece espetada no chão. */
function addRootFlare(mb, rng, pal, r, h) {
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const dx = Math.cos(a), dz = Math.sin(a);
    const ln = h * rng.range(0.8, 1.6);
    mb.addTube([
      { x: dx * ln, y: -h * 0.1, z: dz * ln, r: r * 0.22, w: 0 },
      { x: dx * ln * 0.4, y: h * 0.35, z: dz * ln * 0.4, r: r * 0.5, w: 0 },
      { x: 0, y: h * 1.1, z: 0, r: r * 0.75, w: 0 },
    ], 4, REGION.BARK, pal.barkBot, pal.barkTop);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Gera uma espécie completa: 3 níveis de LOD de uma mesma "árvore genealógica"
 * de parâmetros (mesmo rng reiniciado), de modo que os LODs são a MESMA planta
 * em resoluções diferentes — condição necessária para o cross-fade não pular.
 *
 * @param {string} type um de PLANT_TYPES
 * @param {import('../core/rng.js').Rng} rng determinístico
 * @param {object} P { hueRange, saturation, emissive, maxHeight }
 * @returns {{type,info,height,radius,lods:THREE.BufferGeometry[],palette:object}}
 */
export function generateSpecies(type, rng, P) {
  const gen = GEN[type] || GEN.bush;
  const info = TYPE_INFO[type] || TYPE_INFO.bush;
  const seedHash = rng.seed;

  const maxH = P.maxHeight || 12;
  const H = Math.max(0.12, maxH * info.hScale * (0.75 + 0.5 * fract(seedHash * 0.0000131)));

  const lods = [];
  let palette = null;
  for (let l = 0; l < LOD.length; l++) {
    // Reinicia o fluxo: os três LODs partem exatamente do mesmo estado.
    const r = rng.derive('lod', 0);
    const pal = makePalette(r.derive('pal', 0), P, type === 'dead_tree' ? 'dead' : 'live');
    if (!palette) palette = pal;
    const mb = new Builder();
    try {
      gen(mb, r, pal, P, LOD[l], H);
    } catch (e) {
      // Degradação graciosa: uma espécie quebrada não pode derrubar o bioma.
      mb.p.length = 0; mb.i.length = 0;
    }
    if (mb.count === 0) {
      // Fallback mínimo para nunca devolver geometria vazia (evita NaN no bound).
      mb.addCard(0, H * 0.5, 0, 1, 0, 0, 0, 1, 0, H * 0.2, H * 0.5, REGION.LEAF,
        pal.leafLit, 0.5, pal.emis, { x: 0, y: 1, z: 0 });
    }
    lods.push(mb.geometry());
  }

  const bs = lods[0].boundingSphere;
  return {
    type,
    info,
    height: H,
    radius: bs ? Math.max(0.05, bs.radius) : H * 0.5,
    lods,
    palette,
  };
}

function fract(x) { return x - Math.floor(x); }

export { saturate, smoothstep };
