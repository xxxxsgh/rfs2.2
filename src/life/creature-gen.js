import * as THREE from 'three';
import { Noise, clamp, saturate, lerp, smoothstep } from '../noise/noise.js';
import { makeName } from '../core/rng.js';
import { rgbToHsv, hsvToRgb } from '../planet/biomes.js';

/**
 * GERADOR DE CRIATURAS — montagem por combinação de peças.
 *
 * ── Por que combinatória contínua e não uma biblioteca de modelos ────────────
 * Um bestiário convincente não vem de "N modelos sorteados": vem de um pequeno
 * número de PLANOS CORPORAIS (quadrúpede, bípede, serpentino, flutuante,
 * artrópode, voador) cujos parâmetros são CONTÍNUOS. Duas criaturas do mesmo
 * arquétipo compartilham topologia e diferem em alongamento, espessura,
 * curvatura e proporção de membros — então elas parecem PARENTES, não clones
 * nem coisas aleatórias sem relação. É a mesma lógica de No Man's Sky.
 *
 * ── Por que esqueleto real ───────────────────────────────────────────────────
 * Deformar a malha por vértice (senoides no shader) sempre denuncia: os pés
 * escorregam e as juntas não dobram. Com um THREE.Skeleton de verdade dá para
 * fazer IK de duas juntas com os pés plantados no terreno, que é o sinal
 * visual nº1 de "bicho vivo" em vez de "modelo animado".
 *
 * ── Como a malha é montada ───────────────────────────────────────────────────
 *  1. `buildPlan` produz apenas as JUNTAS (posições absolutas no espaço da
 *     criatura, +Z = frente, +Y = cima) e um "rig" que diz quem é perna,
 *     pescoço, cauda, asa.
 *  2. `emitBody` varre essas juntas emitindo tubos/elipsoides/lâminas. Cada
 *     vértice carrega um `hint`: o índice da junta a que ele pertence.
 *  3. `computeSkinning` calcula os pesos por DISTÂNCIA ao segmento do osso,
 *     restrito aos vizinhos do `hint` — barato e anatomicamente sensato.
 *  4. As matrizes inversas de bind são calculadas UMA vez a partir da pose de
 *     repouso e compartilhadas por todas as instâncias da espécie.
 *
 * Nenhum asset binário: geometria, textura e paleta nascem em runtime.
 */

// ── Uniforms compartilhados do SSS ──────────────────────────────────────────
// Direção do sol em ESPAÇO DE VISTA. O módulo fauna atualiza uma única vez por
// frame; todos os materiais de criatura apontam para o mesmo objeto uniform,
// então não há custo por espécie.
export const SSS_UNIFORMS = {
  uSssDir: { value: new THREE.Vector3(0, 1, 0) },
  uSssAmount: { value: 1.0 },
};

export const ARCHETYPES = ['quadruped', 'biped', 'serpentine', 'floater', 'arthropod', 'flyer'];

const _AXIS_Y = new THREE.Vector3(0, 1, 0);

// ────────────────────────────────────────────────────────────────────────────
// Acumulador de malha
// ────────────────────────────────────────────────────────────────────────────

class MeshData {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.hint = [];
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, u, v, hint) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.hint.push(hint);
    return (this.pos.length / 3) - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, d, b, c, d); }
}

/**
 * Tubo genérico com transporte paralelo do frame.
 * É a peça que resolve 80% do bicho: corpo, pescoço, perna, cauda, chifre,
 * tentáculo — tudo é um tubo com raio variável e uma curva de controle.
 *
 * A costura de UV fica no VENTRE (u=0/1) porque é o lado que o jogador nunca
 * vê; u=0.5 cai no dorso, que é onde o gradiente dorso-ventral precisa do
 * máximo de resolução.
 */
function emitTube(md, pts, radial, capStart, capEnd, v0, v1) {
  const n = pts.length;
  if (n < 2) return;
  const rings = [];
  // Vetor de referência transportado ao longo da curva: evita a torção brusca
  // que aparece quando se recalcula a base do zero em cada anel.
  let ux = 0, uy = 1, uz = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    let tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // Gram-Schmidt do referencial anterior contra a tangente atual.
    const d = ux * tx + uy * ty + uz * tz;
    let nx = ux - tx * d, ny = uy - ty * d, nz = uz - tz * d;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) { nx = 1 - Math.abs(tx); ny = 0; nz = -tz * tx; nl = Math.hypot(nx, ny, nz) || 1; }
    nx /= nl; ny /= nl; nz /= nl;
    ux = nx; uy = ny; uz = nz;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;

    const v = lerp(v0, v1, n === 1 ? 0 : i / (n - 1));
    const rx = p.rx !== undefined ? p.rx : p.r;
    const ry = p.ry !== undefined ? p.ry : p.r;
    const ring = [];
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2 + Math.PI;   // j=0 → ventre
      const c = Math.cos(ang), s = Math.sin(ang);
      ring.push(md.vert(
        p.x + nx * c * rx + bx * s * ry,
        p.y + ny * c * rx + by * s * ry,
        p.z + nz * c * rx + bz * s * ry,
        j / radial, v, p.hint,
      ));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let j = 0; j < radial; j++) md.quad(r0[j], r0[j + 1], r1[j + 1], r1[j]);
  }
  if (capStart) {
    const p = pts[0];
    const c = md.vert(p.x, p.y, p.z, 0.5, v0, p.hint);
    for (let j = 0; j < radial; j++) md.tri(rings[0][j + 1], rings[0][j], c);
  }
  if (capEnd) {
    const p = pts[n - 1];
    const c = md.vert(p.x, p.y, p.z, 0.5, v1, p.hint);
    for (let j = 0; j < radial; j++) md.tri(rings[n - 1][j], rings[n - 1][j + 1], c);
  }
}

/** Elipsoide — cabeças bulbosas, olhos, corpos de flutuadores. */
function emitEllipsoid(md, cx, cy, cz, rx, ry, rz, segU, segV, hint, uOff, vOff, vScale) {
  const grid = [];
  for (let i = 0; i <= segV; i++) {
    const phi = (i / segV) * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const row = [];
    for (let j = 0; j <= segU; j++) {
      const th = (j / segU) * Math.PI * 2 + Math.PI;
      row.push(md.vert(
        cx + rx * sp * Math.cos(th),
        cy + ry * cp,
        cz + rz * sp * Math.sin(th),
        (uOff + j / segU) % 1, vOff + (i / segV) * vScale, hint,
      ));
    }
    grid.push(row);
  }
  for (let i = 0; i < segV; i++) {
    for (let j = 0; j < segU; j++) {
      md.quad(grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]);
    }
  }
}

/**
 * Lâmina com espessura — cristas dorsais, placas, membranas de asa, cauda em
 * leque. Duas cascas espelhadas ligadas na borda para não ficar "papel".
 */
function emitBlade(md, origin, span, chord, normal, spanLen, chordAt, thickAt, hintAt, segS, segC, uv0) {
  const front = [], back = [];
  for (let i = 0; i <= segS; i++) {
    const s = i / segS;
    const cw = chordAt(s);
    const th = thickAt(s);
    const hint = hintAt(s);
    const fr = [], bk = [];
    for (let j = 0; j <= segC; j++) {
      const c = (j / segC - 0.5) * 2;               // -1 .. 1 ao longo da corda
      const bulge = Math.sqrt(Math.max(0, 1 - c * c));
      const px = origin.x + span.x * spanLen * s + chord.x * cw * c;
      const py = origin.y + span.y * spanLen * s + chord.y * cw * c;
      const pz = origin.z + span.z * spanLen * s + chord.z * cw * c;
      const o = th * bulge;
      fr.push(md.vert(px + normal.x * o, py + normal.y * o, pz + normal.z * o, uv0 + s * 0.2, 0.5 + c * 0.25, hint));
      bk.push(md.vert(px - normal.x * o, py - normal.y * o, pz - normal.z * o, uv0 + s * 0.2, 0.5 - c * 0.25, hint));
    }
    front.push(fr); back.push(bk);
  }
  for (let i = 0; i < segS; i++) {
    for (let j = 0; j < segC; j++) {
      md.quad(front[i][j], front[i][j + 1], front[i + 1][j + 1], front[i + 1][j]);
      md.quad(back[i][j + 1], back[i][j], back[i + 1][j], back[i + 1][j + 1]);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Planos corporais
// ────────────────────────────────────────────────────────────────────────────

function makeJointList() {
  const joints = [];
  const J = (name, parent, x, y, z) => {
    joints.push({ name, parent, x, y, z, children: [], dx: 0, dy: -1, dz: 0, len: 0.05 });
    return joints.length - 1;
  };
  return { joints, J };
}

/** Fecha o grafo: filhos, direção principal e comprimento de cada osso. */
function finalizeJoints(joints) {
  for (let i = 0; i < joints.length; i++) {
    const p = joints[i].parent;
    if (p >= 0) joints[p].children.push(i);
  }
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    const c = j.children.length ? joints[j.children[0]] : null;
    if (c) {
      const dx = c.x - j.x, dy = c.y - j.y, dz = c.z - j.z;
      const l = Math.hypot(dx, dy, dz) || 1e-4;
      j.dx = dx / l; j.dy = dy / l; j.dz = dz / l; j.len = l;
    } else if (j.parent >= 0) {
      const p = joints[j.parent];
      j.dx = p.dx; j.dy = p.dy; j.dz = p.dz;
      j.len = p.len * 0.35;
    }
  }
}

/** Deriva o vetor-polo (para onde o joelho aponta) direto da pose de repouso. */
function poleFrom(hip, knee, ankle) {
  const ax = ankle.x - hip.x, ay = ankle.y - hip.y, az = ankle.z - hip.z;
  const al = Math.hypot(ax, ay, az) || 1e-4;
  const ux = ax / al, uy = ay / al, uz = az / al;
  const kx = knee.x - hip.x, ky = knee.y - hip.y, kz = knee.z - hip.z;
  const d = kx * ux + ky * uy + kz * uz;
  let px = kx - ux * d, py = ky - uy * d, pz = kz - uz * d;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-5) { px = 0; py = 0; pz = 1; pl = 1; }   // degenerado: joelho pra frente
  return { x: px / pl, y: py / pl, z: pz / pl };
}

function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

/**
 * Garante FLEXÃO de repouso no membro.
 *
 * Se, parado, a perna já está praticamente reta (soma dos segmentos ≈ distância
 * quadril→tornozelo), a IK não tem para onde esticar: qualquer passada à frente
 * cai fora do alcance e o membro vira um arame. Empurramos o joelho ao longo do
 * próprio vetor-polo até sobrar ~14% de folga — é a mesma razão pela qual
 * nenhum animal fica com a perna travada em pé.
 */
function ensureFlex(def, minRatio = 1.14) {
  const rest = dist3(def.hip, def.ankle) || 1e-4;
  const pole = poleFrom(def.hip, def.knee, def.ankle);
  for (let i = 0; i < 24; i++) {
    if (dist3(def.hip, def.knee) + dist3(def.knee, def.ankle) >= rest * minRatio) break;
    def.knee.x += pole.x * rest * 0.035;
    def.knee.y += pole.y * rest * 0.035;
    def.knee.z += pole.z * rest * 0.035;
  }
}

function addLeg(joints, J, rig, parentIdx, def) {
  ensureFlex(def);
  const hip = J(def.name + '_hip', parentIdx, def.hip.x, def.hip.y, def.hip.z);
  const knee = J(def.name + '_knee', hip, def.knee.x, def.knee.y, def.knee.z);
  const ankle = J(def.name + '_ankle', knee, def.ankle.x, def.ankle.y, def.ankle.z);
  const toe = J(def.name + '_toe', ankle, def.toe.x, def.toe.y, def.toe.z);
  const upperLen = Math.hypot(def.knee.x - def.hip.x, def.knee.y - def.hip.y, def.knee.z - def.hip.z);
  const lowerLen = Math.hypot(def.ankle.x - def.knee.x, def.ankle.y - def.knee.y, def.ankle.z - def.knee.z);
  rig.legs.push({
    hip, knee, ankle, toe,
    side: def.side, pair: def.pair,
    upperLen, lowerLen,
    reach: (upperLen + lowerLen) * 0.985,
    pole: poleFrom(def.hip, def.knee, def.ankle),
    hipLocal: { x: def.hip.x, y: def.hip.y, z: def.hip.z },
    restFoot: { x: def.ankle.x, y: def.ankle.y, z: def.ankle.z },
    phase: def.phase,
    toeLen: Math.hypot(def.toe.x - def.ankle.x, def.toe.y - def.ankle.y, def.toe.z - def.ankle.z),
  });
  return { hip, knee, ankle, toe };
}

/**
 * Constrói as juntas de um arquétipo. Tudo em metros, no espaço da criatura:
 * origem no CHÃO sob o centro do bicho, +Y para cima, +Z para a frente.
 */
function buildPlan(arch, p) {
  const { joints, J } = makeJointList();
  const rig = {
    root: 0, body: -1, head: -1, spine: [], neck: [], tail: [], legs: [], wings: [], tentacles: [],
    hipHeight: 0, bodyLen: p.bodyLen, gait: 'trot', legPole: 1,
  };
  const L = p.bodyLen;

  if (arch === 'serpentine') {
    const segs = p.segCount;
    const root = J('root', -1, 0, p.bodyR * 1.15, 0);
    rig.hipHeight = p.bodyR * 1.15;
    let prev = root;
    rig.body = J('body', root, 0, p.bodyR * 1.15, -L * 0.5);
    prev = rig.body;
    // Cadeia longa da cauda para a cabeça: a onda de locomoção percorre isso.
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const idx = J('spine' + i, prev, 0, p.bodyR * 1.15 + Math.sin(t * Math.PI) * p.arch * L * 0.05, -L * 0.5 + t * L);
      rig.spine.push(idx);
      prev = idx;
    }
    rig.head = J('head', prev, 0, p.bodyR * 1.35, L * 0.5 + p.headLen * 0.55);
    J('headTip', rig.head, 0, p.bodyR * 1.35 - p.headLen * 0.1, L * 0.5 + p.headLen * 1.15);
    rig.gait = 'undulate';
    finalizeJoints(joints);
    return { joints, rig };
  }

  if (arch === 'floater') {
    const root = J('root', -1, 0, p.hoverHeight, 0);
    rig.hipHeight = p.hoverHeight;
    rig.body = J('body', root, 0, p.hoverHeight, 0);
    rig.spine.push(rig.body);
    rig.head = J('head', rig.body, 0, p.hoverHeight + p.bodyR * 0.35, L * 0.34);
    J('headTip', rig.head, 0, p.hoverHeight + p.bodyR * 0.2, L * 0.34 + p.headLen * 0.7);
    // Tentáculos pendurados — 3 a 6, distribuídos em círculo.
    for (let t = 0; t < p.tentacleCount; t++) {
      const a = (t / p.tentacleCount) * Math.PI * 2;
      const rx = Math.cos(a) * p.bodyR * 0.55, rz = Math.sin(a) * p.bodyR * 0.55;
      const chain = [];
      let prev = rig.body;
      for (let s = 1; s <= 3; s++) {
        const idx = J(`tent${t}_${s}`, prev, rx * (1 + s * 0.12), p.hoverHeight - (p.tentacleLen * s) / 3, rz * (1 + s * 0.12));
        chain.push(idx);
        prev = idx;
      }
      rig.tentacles.push({ chain, angle: a });
    }
    rig.gait = 'hover';
    finalizeJoints(joints);
    return { joints, rig };
  }

  // ── Planos com coluna + membros (quadrúpede, bípede, artrópode, voador) ────
  const upright = arch === 'biped' ? 1 : 0;
  const hipY = p.legLen + p.bodyR * (arch === 'arthropod' ? 0.55 : 0.9);
  rig.hipHeight = hipY;

  const root = J('root', -1, 0, hipY, 0);
  const pelvisZ = -L * (upright ? 0.10 : 0.30);
  rig.body = J('body', root, 0, hipY, pelvisZ);
  const rise = p.chestRise * L;

  const sp1 = J('spine1', rig.body, 0, hipY + rise * 0.35 * (1 - upright) + upright * L * 0.22, pelvisZ + L * 0.24 * (1 - upright * 0.7));
  const sp2 = J('spine2', sp1, 0, hipY + rise * (1 - upright) + upright * L * 0.45, pelvisZ + L * 0.50 * (1 - upright * 0.7));
  rig.spine.push(rig.body, sp1, sp2);

  const neckBaseY = joints[sp2].y;
  const neckBaseZ = joints[sp2].z;
  const nDir = { x: 0, y: upright ? 0.72 : p.neckPitch, z: upright ? 0.42 : 1 };
  const nl = Math.hypot(nDir.x, nDir.y, nDir.z);
  nDir.x /= nl; nDir.y /= nl; nDir.z /= nl;
  const nk1 = J('neck1', sp2, 0, neckBaseY + nDir.y * p.neckLen * 0.5, neckBaseZ + nDir.z * p.neckLen * 0.5);
  const nk2 = J('neck2', nk1, 0, neckBaseY + nDir.y * p.neckLen, neckBaseZ + nDir.z * p.neckLen);
  rig.neck.push(nk1, nk2);
  rig.head = J('head', nk2, 0, joints[nk2].y + p.headSize * 0.25, joints[nk2].z + p.headLen * 0.4);
  J('headTip', rig.head, 0, joints[rig.head].y - p.headDroop * p.headLen, joints[rig.head].z + p.headLen);

  // Cauda: contrapeso do bípede, leme do quadrúpede.
  if (p.tailKind !== 'none') {
    let prev = rig.body;
    const segs = p.tailKind === 'fan' ? 3 : 5;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const idx = J('tail' + i, prev, 0,
        hipY + (upright ? L * 0.05 : 0) - t * p.tailDroop * p.tailLen,
        pelvisZ - t * p.tailLen);
      rig.tail.push(idx);
      prev = idx;
    }
  }

  // ── Pernas ────────────────────────────────────────────────────────────────
  const legPairs = arch === 'arthropod' ? 3 : (arch === 'biped' || arch === 'flyer') ? 1 : 2;
  // Padrões de fase: trote/galope (quadrúpede), alternado (bípede), trípode.
  const phases = {
    trot: [0, 0.5, 0.5, 0],
    gallop: [0, 0.08, 0.52, 0.60],
    alternate: [0, 0.5],
    tripod: [0, 0.5, 0.5, 0, 0, 0.5],
  };
  let gait = 'trot';
  if (arch === 'biped') gait = 'alternate';
  else if (arch === 'flyer') gait = 'flap';
  else if (arch === 'arthropod') gait = 'tripod';
  else gait = p.gallop ? 'gallop' : 'trot';
  rig.gait = gait;
  const phaseTable = phases[gait === 'gallop' ? 'gallop' : gait === 'alternate' || gait === 'flap' ? 'alternate' : gait === 'tripod' ? 'tripod' : 'trot'];

  const splay = arch === 'arthropod' ? 1 : 0;
  for (let pair = 0; pair < legPairs; pair++) {
    const front = legPairs === 1 ? 0 : pair / (legPairs - 1);   // 0 = traseiro, 1 = dianteiro
    const attach = legPairs === 1 ? rig.body : front > 0.66 ? sp2 : front > 0.33 ? sp1 : rig.body;
    const az = joints[attach].z;
    const ay = joints[attach].y;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const hx = side * (p.hipWidth + splay * p.bodyR * 0.5);
      // Joelho: à frente nos membros traseiros, atrás nos dianteiros (o padrão
      // tetrápode real); nos artrópodes ele sobe e sai para fora.
      const poleZ = front > 0.5 ? -1 : 1;
      const hip = { x: hx, y: ay, z: az };
      const knee = splay
        ? { x: hx + side * p.legLen * 0.62, y: ay + p.legLen * 0.30, z: az + poleZ * p.legLen * 0.10 }
        : { x: hx * 0.98, y: ay - p.legLen * 0.48, z: az + poleZ * p.legLen * 0.16 };
      const ankleY = p.ankleLift;
      const ankle = splay
        ? { x: hx + side * p.legLen * 0.95, y: ankleY, z: az + poleZ * p.legLen * 0.05 }
        : { x: hx * 0.95, y: ankleY, z: az + p.footFwd };
      const toe = splay
        ? { x: hx + side * (p.legLen * 1.02), y: 0.004 * L, z: az + poleZ * p.legLen * 0.05 }
        : { x: hx * 0.95, y: 0.004 * L, z: az + p.footFwd + p.toeLen };
      const legIndex = rig.legs.length;
      addLeg(joints, J, rig, attach, {
        name: `leg${pair}${s}`, side, pair, hip, knee, ankle, toe,
        phase: phaseTable[legIndex % phaseTable.length],
      });
    }
  }

  // ── Asas ──────────────────────────────────────────────────────────────────
  if (arch === 'flyer' || p.wings) {
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const sx = side * p.bodyR * 0.85;
      const sh = J(`wing${s}_sh`, sp2, sx, joints[sp2].y + p.bodyR * 0.3, joints[sp2].z);
      const el = J(`wing${s}_el`, sh, sx + side * p.wingSpan * 0.42, joints[sp2].y + p.bodyR * 0.3 + p.wingSpan * 0.10, joints[sp2].z - p.wingSpan * 0.06);
      const tp = J(`wing${s}_tp`, el, sx + side * p.wingSpan, joints[sp2].y + p.bodyR * 0.3 + p.wingSpan * 0.04, joints[sp2].z - p.wingSpan * 0.20);
      rig.wings.push({ shoulder: sh, elbow: el, tip: tp, side });
    }
  }

  finalizeJoints(joints);
  return { joints, rig };
}

// ────────────────────────────────────────────────────────────────────────────
// Emissão da malha a partir do plano
// ────────────────────────────────────────────────────────────────────────────

function chain(joints, indices) {
  return indices.map((i) => joints[i]);
}

function emitBody(md, arch, p, joints, rig, q) {
  const R = q.radial;
  const L = p.bodyLen;

  // ── Tronco ────────────────────────────────────────────────────────────────
  if (arch === 'serpentine') {
    const pts = [];
    const all = [rig.body, ...rig.spine];
    for (let i = 0; i < all.length; i++) {
      const j = joints[all[i]];
      const t = i / (all.length - 1);
      // Perfil: fino na cauda, grosso no terço dianteiro.
      const prof = Math.pow(Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.85), 0.55);
      pts.push({ x: j.x, y: j.y, z: j.z, rx: p.bodyR * (0.25 + prof * 0.9), ry: p.bodyR * (0.25 + prof * 0.9) * p.flatten, hint: all[i] });
    }
    emitTube(md, pts, R, true, false, 0, 0.82);
  } else if (arch === 'floater') {
    emitEllipsoid(md, 0, p.hoverHeight, 0, p.bodyR, p.bodyR * p.balloon, p.bodyR, R, Math.max(5, R - 2), rig.body, 0, 0, 0.8);
    for (let t = 0; t < rig.tentacles.length; t++) {
      const tt = rig.tentacles[t];
      const pts = [];
      const body = joints[rig.body];
      const first = joints[tt.chain[0]];
      pts.push({ x: first.x * 0.6, y: body.y - p.bodyR * 0.5, z: first.z * 0.6, r: p.tentacleR * 1.1, hint: rig.body });
      for (let s = 0; s < tt.chain.length; s++) {
        const j = joints[tt.chain[s]];
        pts.push({ x: j.x, y: j.y, z: j.z, r: p.tentacleR * (1 - s * 0.28), hint: tt.chain[s] });
      }
      emitTube(md, pts, Math.max(4, R - 3), false, true, 0.1, 0.9);
    }
  } else {
    const spineIdx = [...rig.tail].reverse().concat(rig.spine);
    const pts = [];
    const n = spineIdx.length;
    for (let i = 0; i < n; i++) {
      const j = joints[spineIdx[i]];
      const t = i / (n - 1);
      // Silhueta: cauda fina → ancas → barriga → peito. Um único perfil
      // contínuo faz o bicho parecer UM animal, não peças coladas.
      const isTail = rig.tail.indexOf(spineIdx[i]) >= 0;
      let r;
      if (isTail) {
        const tt = rig.tail.indexOf(spineIdx[i]) / Math.max(1, rig.tail.length - 1);
        r = p.bodyR * lerp(0.12, 0.42, 1 - tt) * (p.tailKind === 'sting' ? 0.7 : 1);
      } else {
        const bt = (i - rig.tail.length) / Math.max(1, rig.spine.length - 1);
        r = p.bodyR * (0.72 + Math.sin(bt * Math.PI) * 0.42 + bt * p.chestBias);
      }
      pts.push({ x: j.x, y: j.y, z: j.z, rx: r, ry: r * p.flatten, hint: spineIdx[i] });
    }
    emitTube(md, pts, R, true, true, 0.05, 0.75);

    // Cauda em leque / ferrão como peça própria.
    if (p.tailKind === 'fan' && rig.tail.length) {
      const tip = joints[rig.tail[rig.tail.length - 1]];
      const hint = rig.tail[rig.tail.length - 1];
      emitBlade(md,
        { x: tip.x, y: tip.y, z: tip.z },
        { x: 0, y: -0.25, z: -0.97 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
        p.tailLen * 0.55,
        (s) => p.tailLen * 0.42 * Math.sin(s * Math.PI * 0.75 + 0.2),
        () => p.bodyR * 0.05,
        () => hint, 3, 4, 0.55);
    } else if (p.tailKind === 'sting' && rig.tail.length) {
      const tip = joints[rig.tail[rig.tail.length - 1]];
      const hint = rig.tail[rig.tail.length - 1];
      emitTube(md, [
        { x: tip.x, y: tip.y, z: tip.z, r: p.bodyR * 0.16, hint },
        { x: tip.x, y: tip.y + p.tailLen * 0.18, z: tip.z - p.tailLen * 0.10, r: p.bodyR * 0.10, hint },
        { x: tip.x, y: tip.y + p.tailLen * 0.26, z: tip.z - p.tailLen * 0.02, r: 0.001, hint },
      ], Math.max(4, R - 3), false, false, 0.6, 0.72);
    }
  }

  // ── Pescoço ───────────────────────────────────────────────────────────────
  if (rig.neck.length) {
    const nIdx = [rig.spine[rig.spine.length - 1], ...rig.neck, rig.head];
    const pts = chain(joints, nIdx).map((j, i) => ({
      x: j.x, y: j.y, z: j.z,
      r: p.bodyR * lerp(p.neckR0, p.neckR1, i / (nIdx.length - 1)),
      hint: nIdx[i],
    }));
    emitTube(md, pts, R, false, false, 0.75, 0.9);
  }

  // ── Cabeça ────────────────────────────────────────────────────────────────
  emitHead(md, p, joints, rig, q);

  // ── Pernas ────────────────────────────────────────────────────────────────
  const legR = Math.max(4, R - 3);
  for (let i = 0; i < rig.legs.length; i++) {
    const lg = rig.legs[i];
    const h = joints[lg.hip], k = joints[lg.knee], a = joints[lg.ankle], t = joints[lg.toe];
    emitTube(md, [
      { x: h.x, y: h.y, z: h.z, r: p.legR * 1.5, hint: lg.hip },
      { x: lerp(h.x, k.x, 0.5), y: lerp(h.y, k.y, 0.5), z: lerp(h.z, k.z, 0.5), r: p.legR * 1.25, hint: lg.hip },
      { x: k.x, y: k.y, z: k.z, r: p.legR * 0.85, hint: lg.knee },
      { x: lerp(k.x, a.x, 0.55), y: lerp(k.y, a.y, 0.55), z: lerp(k.z, a.z, 0.55), r: p.legR * 0.7, hint: lg.knee },
      { x: a.x, y: a.y, z: a.z, r: p.legR * 0.6, hint: lg.ankle },
      { x: t.x, y: t.y, z: t.z, r: p.legR * 0.5, hint: lg.toe },
    ], legR, true, true, 0.2, 0.45);
  }

  // ── Asas ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < rig.wings.length; i++) {
    const w = rig.wings[i];
    const sh = joints[w.shoulder], tp = joints[w.tip];
    const dx = tp.x - sh.x, dy = tp.y - sh.y, dz = tp.z - sh.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    emitBlade(md,
      { x: sh.x, y: sh.y, z: sh.z },
      { x: dx / dl, y: dy / dl, z: dz / dl },
      { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 },
      dl,
      (s) => p.wingChord * (0.35 + Math.sin((1 - s) * Math.PI * 0.6) * 0.9),
      (s) => p.bodyR * 0.045 * (1 - s * 0.7),
      (s) => (s < 0.33 ? w.shoulder : s < 0.72 ? w.elbow : w.tip),
      5, 4, 0.3);
  }

  // ── Adereços dorsais: crista / placas ─────────────────────────────────────
  if (p.crest > 0.02 && rig.spine.length >= 2) {
    const list = rig.spine.concat(rig.neck);
    for (let i = 0; i < list.length - 1; i++) {
      const j = joints[list[i]];
      const t = i / Math.max(1, list.length - 2);
      const h = p.crest * p.bodyR * (0.6 + Math.sin(t * Math.PI) * 1.6);
      if (p.plates) {
        emitBlade(md, { x: j.x, y: j.y + p.bodyR * p.flatten * 0.85, z: j.z },
          { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
          h, (s) => p.bodyR * 0.55 * (1 - s * 0.7), () => p.bodyR * 0.09, () => list[i], 2, 3, 0.15);
      } else {
        emitBlade(md, { x: j.x, y: j.y + p.bodyR * p.flatten * 0.8, z: j.z },
          { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
          h, (s) => p.bodyR * 0.35 * (1 - s * 0.55), () => p.bodyR * 0.03, () => list[i], 2, 3, 0.15);
      }
    }
  }
}

function emitHead(md, p, joints, rig, q) {
  const R = Math.max(5, q.radial - 1);
  const hIdx = rig.head;
  const h = joints[hIdx];
  const kind = p.headKind;
  const s = p.headSize;

  if (kind === 'none') {
    // "Sem cabeça definida": o tronco simplesmente afina e ganha um bulbo
    // sensorial. Corpos assim são o que dá o susto de "isso não é da Terra".
    emitEllipsoid(md, h.x, h.y, h.z + s * 0.1, s * 0.55, s * 0.55, s * 0.75, R, R - 1, hIdx, 0, 0.86, 0.12);
  } else if (kind === 'flat') {
    // Herbívoro: crânio baixo e largo, focinho achatado — leitura de "pasta".
    emitEllipsoid(md, h.x, h.y, h.z, s * 0.62, s * 0.46, s * 0.85, R, R - 1, hIdx, 0, 0.86, 0.12);
    emitTube(md, [
      { x: h.x, y: h.y - s * 0.06, z: h.z + s * 0.55, rx: s * 0.42, ry: s * 0.34, hint: hIdx },
      { x: h.x, y: h.y - s * 0.12, z: h.z + p.headLen * 0.95, rx: s * 0.34, ry: s * 0.30, hint: hIdx },
    ], R, false, true, 0.88, 0.95);
  } else if (kind === 'long') {
    // Predador: crânio estreito e alongado, mandíbula projetada.
    emitEllipsoid(md, h.x, h.y, h.z, s * 0.44, s * 0.5, s * 0.9, R, R - 1, hIdx, 0, 0.86, 0.12);
    emitTube(md, [
      { x: h.x, y: h.y, z: h.z + s * 0.6, rx: s * 0.34, ry: s * 0.40, hint: hIdx },
      { x: h.x, y: h.y - s * 0.10, z: h.z + p.headLen * 1.05, rx: s * 0.20, ry: s * 0.22, hint: hIdx },
      { x: h.x, y: h.y - s * 0.16, z: h.z + p.headLen * 1.35, rx: s * 0.05, ry: s * 0.06, hint: hIdx },
    ], R, false, true, 0.88, 0.97);
  } else {
    // Bulbosa: crânio esférico enorme, olhos gigantes. Lê como "curioso".
    emitEllipsoid(md, h.x, h.y + s * 0.12, h.z + s * 0.1, s * 0.78, s * 0.8, s * 0.78, R, R - 1, hIdx, 0, 0.86, 0.12);
  }

  // ── Chifres ───────────────────────────────────────────────────────────────
  if (p.hornSize > 0.02) {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const bx = h.x + side * s * 0.42, by = h.y + s * 0.35, bz = h.z - s * 0.05;
      const len = p.hornSize * p.headSize * 3.2;
      const pts = [];
      const segs = 5;
      for (let k2 = 0; k2 <= segs; k2++) {
        const t = k2 / segs;
        // Curvatura contínua: o mesmo parâmetro varre de "espeto reto" a
        // "chifre de carneiro", sem trocar de peça.
        const bend = p.hornCurve * t * t;
        pts.push({
          x: bx + side * (Math.sin(bend * 2.2) * len * 0.45 + t * len * 0.12),
          y: by + Math.cos(bend * 1.6) * len * t,
          z: bz - Math.sin(bend * 1.9) * len * t * 0.5,
          r: p.headSize * 0.12 * (1 - t * 0.92) + 0.002,
          hint: hIdx,
        });
      }
      emitTube(md, pts, 5, false, false, 0.9, 0.99);
    }
  }

  // ── Olhos (número variável — compostos quando muitos) ─────────────────────
  const eyes = p.eyeCount;
  const eyeR = s * (eyes > 4 ? 0.09 : eyes > 2 ? 0.13 : 0.18);
  for (let i = 0; i < eyes; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const spread = 1 + row * 0.42;
    const ex = h.x + side * s * 0.46 * spread * 0.85;
    const ey = h.y + s * (0.20 - row * 0.16);
    const ez = h.z + s * (0.42 - row * 0.20);
    emitEllipsoid(md, ex, ey, ez, eyeR, eyeR, eyeR * 0.9, 6, 5, hIdx, 0.5, 0.995, 0.004);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Skinning
// ────────────────────────────────────────────────────────────────────────────

function buildCandidates(joints) {
  const out = [];
  for (let j = 0; j < joints.length; j++) {
    const s = new Set();
    s.add(j);
    const p = joints[j].parent;
    if (p >= 0) {
      s.add(p);
      if (joints[p].parent >= 0) s.add(joints[p].parent);
      for (const c of joints[p].children) s.add(c);
    }
    for (const c of joints[j].children) {
      s.add(c);
      for (const cc of joints[c].children) s.add(cc);
    }
    out.push(Array.from(s));
  }
  return out;
}

function distToBone(px, py, pz, j) {
  const ax = j.x, ay = j.y, az = j.z;
  const bx = j.x + j.dx * j.len, by = j.y + j.dy * j.len, bz = j.z + j.dz * j.len;
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const l2 = ex * ex + ey * ey + ez * ez;
  let t = l2 > 1e-9 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t), dy = py - (ay + ey * t), dz = pz - (az + ez * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Pesos por distância ao SEGMENTO do osso, restritos aos vizinhos do `hint`.
 * Restringir é o que evita o artefato clássico do peso global: a barriga
 * grudar no pé porque estão geometricamente próximos.
 */
function computeSkinning(md, joints, scaleRef) {
  const n = md.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const cands = buildCandidates(joints);
  const eps = (scaleRef * 0.035) ** 2;
  const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
  for (let v = 0; v < n; v++) {
    const px = md.pos[v * 3], py = md.pos[v * 3 + 1], pz = md.pos[v * 3 + 2];
    const hint = md.hint[v] | 0;
    const list = cands[hint] || [hint];
    bi[0] = bi[1] = bi[2] = bi[3] = hint;
    bw[0] = bw[1] = bw[2] = bw[3] = 0;
    for (let c = 0; c < list.length; c++) {
      const jIdx = list[c];
      const d = distToBone(px, py, pz, joints[jIdx]);
      let w = 1 / (d * d + eps);
      if (jIdx === hint) w *= 3.0;    // âncora anatômica: a peça pertence ao seu osso
      // inserção ordenada nos 4 melhores
      for (let s = 0; s < 4; s++) {
        if (w > bw[s]) {
          for (let t = 3; t > s; t--) { bw[t] = bw[t - 1]; bi[t] = bi[t - 1]; }
          bw[s] = w; bi[s] = jIdx;
          break;
        }
      }
    }
    const sum = bw[0] + bw[1] + bw[2] + bw[3] || 1;
    for (let s = 0; s < 4; s++) { si[v * 4 + s] = bi[s]; sw[v * 4 + s] = bw[s] / sum; }
  }
  return { si, sw };
}

/** Solda as normais em posições coincidentes: mata a costura de UV do ventre. */
function weldNormals(geo, eps) {
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const n = pos.length / 3;
  const q = 1 / eps;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] * q)},${Math.round(pos[i * 3 + 1] * q)},${Math.round(pos[i * 3 + 2] * q)}`;
    let e = map.get(key);
    if (!e) { e = [0, 0, 0, []]; map.set(key, e); }
    e[0] += nrm[i * 3]; e[1] += nrm[i * 3 + 1]; e[2] += nrm[i * 3 + 2];
    e[3].push(i);
  }
  for (const e of map.values()) {
    if (e[3].length < 2) continue;
    const l = Math.hypot(e[0], e[1], e[2]) || 1;
    const x = e[0] / l, y = e[1] / l, z = e[2] / l;
    for (const i of e[3]) { nrm[i * 3] = x; nrm[i * 3 + 1] = y; nrm[i * 3 + 2] = z; }
  }
  geo.attributes.normal.needsUpdate = true;
}

function toGeometry(md, skin) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(md.pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(md.uv, 2));
  geo.setIndex(md.idx);
  geo.computeVertexNormals();
  if (skin) {
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.sw, 4));
  }
  geo.computeBoundingSphere();
  return geo;
}

// ────────────────────────────────────────────────────────────────────────────
// Ossos
// ────────────────────────────────────────────────────────────────────────────

/**
 * Converte juntas absolutas em transformadas LOCAIS de osso, na convenção
 * "osso aponta ao longo do próprio +Y". A convenção única é o que permite que
 * a IK use `setFromUnitVectors(+Y, direção)` sem tabela de correção por osso.
 */
function buildRestBones(joints) {
  const worldQ = [];
  const rest = [];
  const qTmp = new THREE.Quaternion();
  const vTmp = new THREE.Vector3();
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    vTmp.set(j.dx, j.dy, j.dz).normalize();
    const wq = new THREE.Quaternion().setFromUnitVectors(_AXIS_Y, vTmp);
    worldQ.push(wq);
    const p = j.parent;
    let px = j.x, py = j.y, pz = j.z;
    let lq;
    if (p >= 0) {
      const pj = joints[p];
      vTmp.set(j.x - pj.x, j.y - pj.y, j.z - pj.z);
      qTmp.copy(worldQ[p]).invert();
      vTmp.applyQuaternion(qTmp);
      px = vTmp.x; py = vTmp.y; pz = vTmp.z;
      lq = qTmp.clone().multiply(wq);
    } else {
      lq = wq.clone();
    }
    // `wq`/`iwq` (rotação de repouso em espaço da CRIATURA) existem para que a
    // animação possa dizer "gire este osso em torno do eixo Y da criatura" sem
    // precisar reconstruir a cadeia: basta levar o eixo ao referencial do pai.
    rest.push({ name: j.name, parent: p, px, py, pz, q: lq, wq, iwq: wq.clone().invert() });
  }
  return rest;
}

/** Constrói a árvore de ossos concreta de UMA instância. */
export function createRig(species) {
  const rest = species.restBones;
  const bones = new Array(rest.length);
  for (let i = 0; i < rest.length; i++) {
    const b = new THREE.Bone();
    b.name = rest[i].name;
    b.position.set(rest[i].px, rest[i].py, rest[i].pz);
    b.quaternion.copy(rest[i].q);
    bones[i] = b;
  }
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i].parent;
    if (p >= 0) bones[p].add(bones[i]);
  }
  const skeleton = new THREE.Skeleton(bones, species.boneInverses);
  return { root: bones[0], bones, skeleton };
}

/** Matrizes inversas de bind da pose de repouso — idênticas para toda instância. */
function computeBoneInverses(restBones) {
  const objs = [];
  for (let i = 0; i < restBones.length; i++) {
    const o = new THREE.Object3D();
    o.position.set(restBones[i].px, restBones[i].py, restBones[i].pz);
    o.quaternion.copy(restBones[i].q);
    objs.push(o);
  }
  for (let i = 0; i < restBones.length; i++) {
    const p = restBones[i].parent;
    if (p >= 0) objs[p].add(objs[i]);
  }
  objs[0].updateMatrixWorld(true);
  const inv = [];
  for (let i = 0; i < objs.length; i++) inv.push(objs[i].matrixWorld.clone().invert());
  return inv;
}

// ────────────────────────────────────────────────────────────────────────────
// Textura procedural
// ────────────────────────────────────────────────────────────────────────────

function hexToRgb01(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function shiftColor(rgb, dHue, mSat, mVal) {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return hsvToRgb((h + dHue + 1) % 1, saturate(s * mSat), saturate(v * mVal));
}

function makeDataTexture(data, w, h, srgb) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Pele: padrão + paleta derivadas do BIOMA e da seed da espécie.
 * A regra cromática do jogo (chão saturado / céu complementar) também vale
 * aqui: a criatura precisa ler contra o chão do seu bioma sem sumir nele, por
 * isso a cor base sai da paleta e o padrão sai do `accent`, que é justamente
 * o matiz de contraste do bioma.
 *
 * Eixo U = ao redor do corpo (0 = ventre, 0.5 = dorso) → gradiente
 * dorso-ventral de graça, que é o padrão de contra-sombreamento de todo animal.
 * Eixo V = ao longo do corpo → listras transversais.
 */
function* makeSkinTextures(rng, biome, traits, p) {
  const W = 48, H = 96;
  const BAND = 12;    // linhas por fatia — mantém cada pedaço abaixo de ~1 ms
  const noise = new Noise(rng.int(0x7fffffff));
  const pal = (biome && biome.palette) || {};
  const bases = [pal.lowland, pal.midland, pal.highland, pal.cliff, pal.peak].filter((c) => typeof c === 'number');
  const baseHex = bases.length ? rng.pick(bases) : 0x8a7a5a;
  const accentHex = typeof pal.accent === 'number' ? pal.accent : 0xffcc33;

  const dHue = rng.range(-0.18, 0.18);
  const dorsal = shiftColor(hexToRgb01(baseHex), dHue, rng.range(0.75, 1.25), rng.range(0.55, 0.9));
  const ventral = shiftColor(dorsal, rng.range(-0.05, 0.05), rng.range(0.35, 0.7), rng.range(1.25, 1.8));
  const pattern = shiftColor(hexToRgb01(accentHex), rng.range(-0.12, 0.12), rng.range(0.8, 1.2), rng.range(0.6, 1.1));
  const glow = shiftColor(pattern, 0.12, 1.2, 1.4);

  const kind = p.patternKind;
  const stripes = p.patternScale;
  const data = new Uint8Array(W * H * 4);
  const emis = traits.biolum > 0.02 ? new Uint8Array(W * H * 4) : null;

  for (let y = 0; y < H; y++) {
    if (y > 0 && y % BAND === 0) yield 'skin-tex';
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const back = 1 - Math.abs(u - 0.5) * 2;          // 1 no dorso, 0 no ventre
      const shade = smoothstep(0.15, 0.85, back);

      let mask = 0;
      if (kind === 'stripes') {
        const wobble = noise.fbm(u * 2.0, v * 3.0, 0, 3) * 0.35;
        mask = Math.pow(saturate(Math.abs(Math.sin((v * stripes + wobble) * Math.PI))), 6);
      } else if (kind === 'spots') {
        const c = noise.worley(u * 6.0, v * stripes * 1.6, 0.5, 0.95);
        mask = 1 - smoothstep(0.18, 0.42, c.f1);
      } else if (kind === 'reticulate') {
        const c = noise.worley(u * 5.0, v * stripes * 1.2, 0.5, 1.0);
        mask = 1 - smoothstep(0.02, 0.16, c.f2 - c.f1);
      } else {
        // gradiente puro + grão fino: peles lisas, anfíbias.
        mask = saturate(noise.fbm(u * 5, v * 9, 0, 4) * 0.5 + 0.5) * 0.35;
      }
      // O padrão só existe no dorso e nos flancos — barriga sempre lisa.
      mask *= smoothstep(0.05, 0.6, back) * p.patternStrength;

      const grain = noise.fbm(u * 14, v * 26, 3.7, 3) * 0.08;
      const i = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const base = lerp(ventral[ch], dorsal[ch], shade);
        const col = saturate(lerp(base, pattern[ch], mask) + grain);
        data[i + ch] = Math.round(col * 255);
      }
      data[i + 3] = 255;

      if (emis) {
        const e = mask * traits.biolum * (0.35 + 0.65 * back);
        emis[i] = Math.round(saturate(glow[0] * e) * 255);
        emis[i + 1] = Math.round(saturate(glow[1] * e) * 255);
        emis[i + 2] = Math.round(saturate(glow[2] * e) * 255);
        emis[i + 3] = 255;
      }
    }
  }

  return {
    map: makeDataTexture(data, W, H, true),
    emissiveMap: emis ? makeDataTexture(emis, W, H, true) : null,
    dorsal, ventral, pattern, glow,
  };
}

let _blobTexture = null;
/** Silhueta suave compartilhada por todos os imposters. */
function blobTexture() {
  if (_blobTexture) return _blobTexture;
  const S = 32;
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5;
      // Elipse achatada: à distância, um bicho lê como um borrão mais largo
      // que alto. Um círculo perfeito denuncia "sprite".
      const r = Math.sqrt(dx * dx * 1.0 + dy * dy * 2.6) * 2;
      const a = 1 - smoothstep(0.55, 1.0, r);
      const i = (y * S + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(saturate(a) * 255);
    }
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _blobTexture = t;
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Material
// ────────────────────────────────────────────────────────────────────────────

/**
 * SSS aproximado. Pele viva não é um Lambert: parte da luz entra, espalha e sai
 * pelo outro lado — orelhas, membranas e barbatanas acendem em contraluz. O
 * truque barato é somar dois termos em ESPAÇO DE VISTA:
 *   - "wrap": difusa deslocada, que empurra o terminador para além dos 90°;
 *   - "back": transmissão traseira, quando a câmera olha contra a luz.
 * Custa duas linhas e é a diferença entre plástico e carne.
 */
function makeCreatureMaterial(tex, traits, p) {
  const sss = new THREE.Color(tex.dorsal[0], tex.dorsal[1], tex.dorsal[2]);
  sss.offsetHSL(0.02, 0.25, 0.08);

  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    color: 0xffffff,
    roughness: clamp(p.roughness, 0.25, 0.95),
    metalness: 0.02,
    emissive: tex.emissiveMap ? new THREE.Color(1, 1, 1) : new THREE.Color(0, 0, 0),
    emissiveMap: tex.emissiveMap,
    emissiveIntensity: tex.emissiveMap ? 1.6 : 0,
    fog: true,
  });
  mat.name = 'creature';
  const uSssColor = { value: sss };
  const uSssStrength = { value: traits.sssStrength };
  mat.userData.uSssColor = uSssColor;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSssDir = SSS_UNIFORMS.uSssDir;
    shader.uniforms.uSssAmount = SSS_UNIFORMS.uSssAmount;
    shader.uniforms.uSssColor = uSssColor;
    shader.uniforms.uSssStrength = uSssStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSssDir;
uniform vec3 uSssColor;
uniform float uSssAmount;
uniform float uSssStrength;`)
      .replace('#include <opaque_fragment>', `
{
  vec3 sssV = normalize( vViewPosition );
  float wrapT = clamp( ( dot( normal, uSssDir ) + 0.55 ) / 1.55, 0.0, 1.0 );
  float backT = pow( clamp( dot( sssV, -uSssDir ), 0.0, 1.0 ), 3.0 );
  outgoingLight += uSssColor * diffuseColor.rgb * ( wrapT * 0.16 + backT * 0.62 ) * uSssStrength * uSssAmount;
}
#include <opaque_fragment>`);
  };
  // Sem chave própria os materiais de espécies diferentes colidiriam no cache
  // de programas do three e um herdaria os uniforms do outro.
  mat.customProgramCacheKey = () => 'aether-fauna-sss';
  return mat;
}

// ────────────────────────────────────────────────────────────────────────────
// Traços e parâmetros
// ────────────────────────────────────────────────────────────────────────────

function rollParams(rng, arch, sizeM, biome) {
  const thick = rng.range(0.085, 0.20);
  const p = {
    bodyLen: sizeM,
    bodyR: sizeM * thick,
    flatten: rng.range(0.78, 1.18),              // achatamento dorso-ventral
    chestBias: rng.range(-0.12, 0.30),
    chestRise: rng.range(0.02, 0.10),
    legLen: sizeM * rng.range(0.20, 0.62),
    legR: sizeM * rng.range(0.022, 0.055),
    hipWidth: sizeM * rng.range(0.055, 0.12),
    ankleLift: 0,
    footFwd: sizeM * rng.range(0.0, 0.05),
    toeLen: sizeM * rng.range(0.03, 0.08),
    neckLen: sizeM * rng.range(0.08, 0.42),
    neckPitch: rng.range(0.1, 0.9),
    neckR0: rng.range(0.55, 0.8),
    neckR1: rng.range(0.28, 0.5),
    headSize: sizeM * rng.range(0.09, 0.20),
    headLen: sizeM * rng.range(0.10, 0.24),
    headDroop: rng.range(0.0, 0.28),
    headKind: 'flat',
    hornSize: 0,
    hornCurve: rng.range(0.1, 1.5),
    crest: 0,
    plates: false,
    eyeCount: 2,
    tailKind: 'long',
    tailLen: sizeM * rng.range(0.15, 0.65),
    tailDroop: rng.range(0.1, 0.6),
    wings: false,
    wingSpan: sizeM * rng.range(0.5, 1.1),
    wingChord: sizeM * rng.range(0.16, 0.34),
    segCount: 10,
    arch: rng.range(0.2, 1.0),
    hoverHeight: sizeM * rng.range(0.5, 1.2),
    balloon: rng.range(0.7, 1.4),
    tentacleCount: rng.intRange(3, 6),
    tentacleLen: sizeM * rng.range(0.4, 1.1),
    tentacleR: sizeM * rng.range(0.015, 0.04),
    gallop: rng.chance(0.4),
    roughness: rng.range(0.42, 0.9),
    patternKind: rng.pickWeighted(['stripes', 'spots', 'reticulate', 'smooth'], [3, 3, 1.5, 2]),
    patternScale: rng.range(4, 16),
    patternStrength: rng.range(0.35, 1.0),
  };

  // Digitígrado ⇄ plantígrado é contínuo: o tornozelo sobe do chão.
  const digit = rng.float();
  p.digitigrade = digit;
  p.ankleLift = p.legLen * digit * 0.30;
  p.footFwd += p.legLen * digit * 0.06;

  // Cabeça e adereços por sorteio ponderado — mas sempre coerentes com o corpo.
  p.headKind = rng.pickWeighted(['flat', 'long', 'bulb', 'none'], [3, 2.5, 2, 0.8]);
  if (rng.chance(0.42)) p.hornSize = rng.range(0.15, 0.9);
  if (rng.chance(0.45)) { p.crest = rng.range(0.15, 1.0); p.plates = rng.chance(0.4); }
  p.eyeCount = rng.pickWeighted([2, 2, 4, 6, 8, 1], [5, 5, 2, 1.2, 0.6, 0.5]);
  p.tailKind = rng.pickWeighted(['long', 'fan', 'sting', 'none'], [4, 1.6, 1.2, 1.5]);

  if (arch === 'serpentine') {
    p.segCount = rng.intRange(8, 14);
    p.bodyR = sizeM * rng.range(0.035, 0.075);
    p.tailKind = 'none';
    p.headSize = sizeM * rng.range(0.05, 0.10);
    p.headLen = sizeM * rng.range(0.06, 0.13);
  }
  if (arch === 'arthropod') {
    p.legLen = sizeM * rng.range(0.28, 0.7);
    p.flatten = rng.range(0.5, 0.85);
    p.plates = true;
    p.crest = Math.max(p.crest, 0.25);
    p.neckLen = sizeM * rng.range(0.03, 0.10);
    p.eyeCount = rng.pickWeighted([4, 6, 8], [2, 2, 1]);
  }
  if (arch === 'biped') {
    p.legLen = sizeM * rng.range(0.34, 0.62);
    p.tailKind = p.tailKind === 'none' ? 'long' : p.tailKind;
    p.tailLen = sizeM * rng.range(0.35, 0.8);
    p.neckLen = sizeM * rng.range(0.10, 0.35);
  }
  if (arch === 'flyer') {
    p.wings = true;
    p.legLen = sizeM * rng.range(0.14, 0.30);
    p.bodyR = sizeM * rng.range(0.09, 0.15);
    p.wingSpan = sizeM * rng.range(0.9, 1.9);
    p.wingChord = sizeM * rng.range(0.22, 0.45);
    p.tailKind = rng.chance(0.6) ? 'fan' : 'long';
  }
  if (arch === 'floater') {
    p.bodyR = sizeM * rng.range(0.22, 0.42);
    p.headKind = rng.chance(0.6) ? 'none' : 'bulb';
    p.tailKind = 'none';
  }

  // Bioluminescência é assinatura de bioma: pântano tóxico e exótico brilham.
  const floraEmissive = (biome && biome.flora && biome.flora.emissive) || 0;
  p.biolum = saturate(floraEmissive * rng.range(0.5, 1.4) + (rng.chance(0.18) ? rng.range(0.2, 0.6) : 0));

  return p;
}

function rollTraits(rng, arch, sizeM, p, biome) {
  const bTemp = (biome && biome.fauna && biome.fauna.temperament) || 0.2;
  // Temperamento do bioma enviesa, mas cada espécie ainda tem personalidade.
  const aggression = saturate(bTemp * rng.range(0.6, 1.6) + (arch === 'arthropod' ? 0.12 : 0));
  const predator = aggression > 0.45 || (p.headKind === 'long' && aggression > 0.3);
  const diet = predator ? (rng.chance(0.25) ? 'omnivore' : 'carnivore') : (rng.chance(0.15) ? 'omnivore' : 'herbivore');
  const flying = arch === 'flyer' || (arch === 'floater' && rng.chance(0.8));

  // Bichos pequenos são rápidos em comprimentos por segundo, mas lentos em m/s.
  const bodyPerSec = rng.range(1.4, 3.2) * (predator ? 1.25 : 1.0);
  const speed = clamp(sizeM * bodyPerSec * 0.55, 0.8, 26);

  return {
    archetype: arch,
    diet,
    temperament: aggression > 0.55 ? 'aggressive' : aggression > 0.28 ? 'skittish' : 'docile',
    aggression,
    sizeM,
    heightM: p.legLen + p.bodyR * 2,
    mass: Math.round(18 * Math.pow(sizeM, 2.6)),
    speed,
    sprint: speed * rng.range(1.6, 2.6),
    turnRate: clamp(3.2 / Math.sqrt(sizeM), 0.5, 3.4),
    gaitType: 'trot',
    flying,
    legCount: 0,
    eyeCount: p.eyeCount,
    biolum: p.biolum,
    sssStrength: rng.range(0.5, 1.4) * (1 + p.biolum * 0.6),
    alertRadius: clamp(sizeM * rng.range(4, 9), 14, 90),
    attackRange: sizeM * rng.range(0.9, 1.6),
    damage: predator ? Math.round(4 + sizeM * rng.range(2, 6)) : 0,
    health: Math.round(24 + sizeM * rng.range(10, 34)),
    herdSize: predator ? rng.intRange(2, 4) : rng.intRange(3, 9),
    // Voz: bichos grandes rosnam grave, pequenos guincham. Alimenta o sintetizador.
    vocalPitch: clamp(720 / Math.pow(Math.max(0.2, sizeM), 0.75), 45, 1500),
    vocalRough: saturate(aggression * 0.7 + rng.range(0, 0.3)),
    strideLen: 0,
    dutyFactor: 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Geração da espécie (em etapas, para caber no orçamento de frame)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gerador em etapas. Cada `yield` é um ponto seguro para devolver o controle ao
 * loop: nenhuma etapa isolada passa de ~2 ms, então o frame nunca engasga.
 * Use `generateSpecies()` quando o custo não importa (testes, pré-aquecimento).
 */
export function* speciesSteps(rng, biome, opts = {}) {
  const range = (biome && biome.fauna && biome.fauna.sizeRange) || [0.5, 4];
  // `sizeT` estratificado pelo chamador garante que o planeta tenha bichos de
  // 0,5 m E de 8 m ao mesmo tempo — é o que dá a leitura de escala.
  const t = opts.sizeT !== undefined ? clamp(opts.sizeT, 0, 1) : rng.float();
  const sizeM = lerp(range[0], range[1], Math.pow(t, 1.25)) * rng.range(0.85, 1.18);

  const archWeights = {
    quadruped: 5, biped: 2.4, serpentine: 1.6, floater: 1.2, arthropod: 2.2, flyer: 2.0,
  };
  // Bichos muito grandes raramente voam; muito pequenos raramente são bípedes.
  if (sizeM > 5) { archWeights.flyer *= 0.25; archWeights.floater *= 0.6; }
  if (sizeM < 1) { archWeights.biped *= 0.5; archWeights.arthropod *= 1.8; }
  const arch = opts.archetype || rng.pickWeighted(ARCHETYPES, ARCHETYPES.map((a) => archWeights[a]));

  const p = rollParams(rng, arch, sizeM, biome);
  const traits = rollTraits(rng, arch, sizeM, p, biome);
  yield 'params';

  const { joints, rig } = buildPlan(arch, p);
  traits.gaitType = rig.gait;
  traits.legCount = rig.legs.length;
  // A passada NÃO é um número solto: ela é limitada pela geometria da perna.
  // Se meia passada mais a altura do quadril passar do alcance do membro, a IK
  // nunca chega no pé e a perna vira um arame esticado. Aqui o passo máximo sai
  // de Pitágoras sobre o próprio esqueleto.
  if (rig.legs.length) {
    const L0 = rig.legs[0];
    const reach = L0.upperLen + L0.lowerLen;
    const hipH = Math.max(0.01, L0.hipLocal.y - L0.restFoot.y);
    const lat = Math.abs(L0.hipLocal.x - L0.restFoot.x);
    const maxHalf = Math.sqrt(Math.max(1e-4, reach * reach * 0.90 - hipH * hipH - lat * lat));
    traits.strideLen = clamp(p.legLen * lerp(0.9, 1.5, p.digitigrade || 0.5), 0.1, maxHalf * 1.8);
  } else {
    traits.strideLen = Math.max(0.15, p.bodyLen * 0.35);
  }
  traits.dutyFactor = rig.gait === 'gallop' ? 0.42 : rig.gait === 'tripod' ? 0.62 : 0.58;
  if (traits.flying) traits.gaitType = arch === 'floater' ? 'hover' : 'flap';
  yield 'plan';

  const md = new MeshData();
  emitBody(md, arch, p, joints, rig, { radial: 8 });
  yield 'mesh';

  const skin = computeSkinning(md, joints, sizeM);
  yield 'skin';

  const geometry = toGeometry(md, skin);
  weldNormals(geometry, Math.max(1e-4, sizeM * 0.0008));
  yield 'geo';

  // LOD1: mesma silhueta, metade dos anéis radiais e sem atributos de skin.
  const mdLod = new MeshData();
  emitBody(mdLod, arch, p, joints, rig, { radial: 5 });
  yield 'lod-mesh';

  const geometryLod = toGeometry(mdLod, null);
  weldNormals(geometryLod, Math.max(1e-4, sizeM * 0.0015));
  yield 'lod';

  const restBones = buildRestBones(joints);
  yield 'rest';

  const boneInverses = computeBoneInverses(restBones);
  yield 'bones';

  const tex = yield* makeSkinTextures(rng, biome, traits, p);
  const material = makeCreatureMaterial(tex, traits, p);
  const imposterMaterial = new THREE.SpriteMaterial({
    map: blobTexture(),
    color: new THREE.Color(tex.dorsal[0], tex.dorsal[1], tex.dorsal[2]),
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  yield 'material';

  const species = {
    id: opts.id || ('sp-' + rng.int(0xffffff).toString(16)),
    name: makeName(rng, { minSyl: 2, maxSyl: 3 }),
    geometry,
    geometryLod,
    material,
    imposterMaterial,
    textures: tex,
    restBones,
    boneInverses,
    skeleton: null,       // preenchido abaixo com um exemplar de referência
    rig,
    joints,
    params: p,
    traits,
    /** Cria a árvore de ossos + Skeleton de uma nova instância. */
    createRig() { return createRig(this); },
    dispose() { disposeSpecies(this); },
  };
  // Exemplar de referência: o contrato pede `skeleton` no objeto de espécie.
  species.skeleton = createRig(species).skeleton;
  return species;
}

/** Versão síncrona — roda todas as etapas de uma vez. */
export function generateSpecies(rng, biome, opts = {}) {
  const it = speciesSteps(rng, biome, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** Monta a SkinnedMesh pronta para a cena (ossos já pendurados na malha). */
export function createSkinnedMesh(species) {
  const { root, bones, skeleton } = createRig(species);
  const mesh = new THREE.SkinnedMesh(species.geometry, species.material);
  mesh.add(root);
  // Bind com matriz identidade: os ossos são filhos da malha, então o
  // `bindMatrixInverse` recalculado a cada frame (AttachedBindMode) já cancela
  // a transformada de mundo — passar a matriz da malha aqui duplicaria.
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;   // a pose deforma além da bounding sphere de bind
  return { mesh, bones, skeleton, root };
}

export function disposeSpecies(species) {
  species.geometry?.dispose?.();
  species.geometryLod?.dispose?.();
  species.material?.dispose?.();
  species.imposterMaterial?.dispose?.();
  species.textures?.map?.dispose?.();
  species.textures?.emissiveMap?.dispose?.();
}
