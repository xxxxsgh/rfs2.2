/**
 * Quadsphere — quadtree em cubo esferificado.
 *
 * PURO: sem `three`, sem DOM, sem `performance`. É importado tanto pela thread
 * principal (seleção de LOD, consultas de altura) quanto pelo Web Worker de
 * terreno (para reconstruir a direção de cada vértice a partir de face/u/v).
 *
 * ── Por que cubo esferificado e não normalização ingênua ─────────────────────
 * `normalize(cubePoint)` concentra área nos centros das faces e estica os
 * cantos: a mesma malha 33x33 gera triângulos com até ~1.7x de diferença de
 * tamanho entre o centro e o canto da face. Isso aparece como densidade de
 * detalhe irregular e como uma "cruz" fantasma nas juntas das faces quando o
 * shader de detalhe é triplanar. A correção de Philip Rideout distribui os
 * pontos quase uniformemente com uma única raiz quadrada por eixo — custo
 * irrelevante, ganho visível.
 *
 * ── Por que a árvore é persistente ──────────────────────────────────────────
 * Reconstruir o quadtree a cada frame descartaria os limites de altura reais
 * (hMin/hMax) que o worker devolve, e sem eles o culling de horizonte fica
 * conservador demais. Os nós vivem entre frames e são podados por idade.
 */

const HALF_PI = Math.PI / 2;

/** Base de cada face do cubo. U x V = N (normal para fora) — garante winding. */
const FACE_N = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
const FACE_U = [0, 0, -1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0];
const FACE_V = [0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0, 1, 0, 0, 1, 0];

export const FACE_COUNT = 6;
export { HALF_PI };

/**
 * Cubo [-1,1]³ → esfera unitária com distribuição corrigida (Rideout).
 * @param {{x:number,y:number,z:number}} out
 */
export function cubeToSphere(x, y, z, out) {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out.x = x * Math.sqrt(Math.max(0, 1 - (y2 + z2) * 0.5 + (y2 * z2) / 3));
  out.y = y * Math.sqrt(Math.max(0, 1 - (z2 + x2) * 0.5 + (z2 * x2) / 3));
  out.z = z * Math.sqrt(Math.max(0, 1 - (x2 + y2) * 0.5 + (x2 * y2) / 3));
  return out;
}

/** (face, u∈[0,1], v∈[0,1]) → direção unitária na esfera. */
export function faceUVToDirection(face, u, v, out) {
  const b = face * 3;
  const a = u * 2 - 1, c = v * 2 - 1;
  const cx = FACE_N[b] + FACE_U[b] * a + FACE_V[b] * c;
  const cy = FACE_N[b + 1] + FACE_U[b + 1] * a + FACE_V[b + 1] * c;
  const cz = FACE_N[b + 2] + FACE_U[b + 2] * a + FACE_V[b + 2] * c;
  cubeToSphere(cx, cy, cz, out);
  // A esferificação já devolve norma ~1; renormaliza só para matar deriva.
  const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z) || 1;
  out.x /= l; out.y /= l; out.z /= l;
  return out;
}

/**
 * Direção → (face, u, v) pela projeção INGÊNUA no cubo.
 *
 * Deliberadamente NÃO é a inversa exata de `cubeToSphere`: só é usada para
 * indexar o mapa esparso de edições de terreno, onde o único requisito é que
 * gravação e leitura usem a mesma função. Inverter Rideout exigiria Newton por
 * amostra sem ganho nenhum aqui.
 */
export function directionToFaceUV(x, y, z, out) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face, m;
  if (ax >= ay && ax >= az) { face = x >= 0 ? 0 : 1; m = ax; }
  else if (ay >= az) { face = y >= 0 ? 2 : 3; m = ay; }
  else { face = z >= 0 ? 4 : 5; m = az; }
  if (m < 1e-12) m = 1e-12;
  const px = x / m, py = y / m, pz = z / m;
  const b = face * 3;
  const a = px * FACE_U[b] + py * FACE_U[b + 1] + pz * FACE_U[b + 2];
  const c = px * FACE_V[b] + py * FACE_V[b + 1] + pz * FACE_V[b + 2];
  out.face = face;
  out.u = (a + 1) * 0.5;
  out.v = (c + 1) * 0.5;
  return out;
}

/** Chave numérica única e estável de um nó (cabe em float64 exato). */
export function nodeId(face, level, i, j) {
  return ((face * 15 + level) * 16384 + i) * 16384 + j;
}

const _d = { x: 0, y: 0, z: 0 };
const _c = { x: 0, y: 0, z: 0 };

export class QuadSphere {
  /**
   * @param {object} o
   * @param {number} o.radius      raio do datum (m)
   * @param {number} o.amplitude   relevo máximo (m) — usado nos bounds iniciais
   * @param {number} o.maxLevel    profundidade máxima (14 ≈ 0,5 m/triângulo)
   * @param {number} o.splitFactor k do critério de split (≈2.2)
   * @param {number} o.gridRes     vértices por lado da malha de um nó
   */
  constructor({ radius = 150000, amplitude = 3000, maxLevel = 14, splitFactor = 2.2, gridRes = 33 } = {}) {
    this.radius = radius;
    this.amplitude = amplitude;
    this.maxLevel = maxLevel;
    this.splitFactor = splitFactor;
    this.gridRes = gridRes;
    this.frame = 0;
    this.nodeCount = 0;
    /** Menor raio garantidamente sólido — usado no culling de horizonte. */
    this.solidRadius = radius - amplitude;
    this.roots = [];
    for (let f = 0; f < 6; f++) this.roots.push(this._makeNode(f, 0, 0, 0, null));
  }

  _makeNode(face, level, i, j, parent) {
    const size = 1 / (1 << level);
    const u0 = i * size, v0 = j * size;
    faceUVToDirection(face, u0 + size * 0.5, v0 + size * 0.5, _d);
    const node = {
      id: nodeId(face, level, i, j),
      face, level, i, j, size, u0, v0,
      parent,
      children: null,
      dir: { x: _d.x, y: _d.y, z: _d.z },
      // Comprimento aproximado do lado do nó sobre a superfície (m).
      arc: size * HALF_PI * this.radius,
      // Raio usado SÓ no critério de LOD: metade da diagonal tangencial do nó.
      // Deliberadamente ignora a faixa de altura — usar `boundR` aqui faria um
      // nó de 14 m com ±1,9 km de relevo possível medir distância zero a 2 km
      // de raio, e a árvore explodiria para dezenas de milhares de folhas.
      lodR: size * HALF_PI * this.radius * 0.72,
      hMin: -this.amplitude,
      hMax: this.amplitude,
      cx: 0, cy: 0, cz: 0,
      boundR: 0,
      lastSeen: this.frame,
      _split: false,
      _culled: false,
      _dist: Infinity,
      _readyFrame: -1,
      _ready: false,
      _renderFrame: -1,
    };
    this._refreshBounds(node);
    this.nodeCount++;
    return node;
  }

  /** Recalcula centro e esfera envolvente a partir da faixa de altura conhecida. */
  _refreshBounds(node) {
    const rMid = this.radius + (node.hMin + node.hMax) * 0.5;
    node.cx = node.dir.x * rMid;
    node.cy = node.dir.y * rMid;
    node.cz = node.dir.z * rMid;
    let maxSq = 0;
    const rLo = this.radius + node.hMin, rHi = this.radius + node.hMax;
    for (let k = 0; k < 4; k++) {
      const u = node.u0 + (k & 1) * node.size;
      const v = node.v0 + (k >> 1) * node.size;
      faceUVToDirection(node.face, u, v, _c);
      for (let s = 0; s < 2; s++) {
        const r = s === 0 ? rLo : rHi;
        const dx = _c.x * r - node.cx, dy = _c.y * r - node.cy, dz = _c.z * r - node.cz;
        const q = dx * dx + dy * dy + dz * dz;
        if (q > maxSq) maxSq = q;
      }
    }
    node.boundR = Math.sqrt(maxSq) * 1.02;
  }

  /** O worker devolveu a altura real do nó: aperta o bound (ganha culling). */
  setHeightRange(node, hMin, hMax) {
    if (!Number.isFinite(hMin) || !Number.isFinite(hMax)) return;
    node.hMin = hMin - 1;
    node.hMax = hMax + 1;
    this._refreshBounds(node);
  }

  subdivide(node) {
    if (node.children) return node.children;
    const l = node.level + 1;
    const i2 = node.i * 2, j2 = node.j * 2;
    node.children = [
      this._makeNode(node.face, l, i2, j2, node),
      this._makeNode(node.face, l, i2 + 1, j2, node),
      this._makeNode(node.face, l, i2, j2 + 1, node),
      this._makeNode(node.face, l, i2 + 1, j2 + 1, node),
    ];
    return node.children;
  }

  /**
   * Oclusão pelo horizonte: o segmento câmera→centro do nó atravessa a esfera
   * sólida? Teste exato de segmento×esfera, com folga do bound do nó para nunca
   * apagar um pico que ainda assoma além do limbo.
   */
  _occluded(cam, node) {
    const r = this.solidRadius;
    if (r <= 0) return false;
    const camSq = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z;
    if (camSq <= r * r) return false;           // dentro do corpo sólido: sem horizonte
    const dx = node.cx - cam.x, dy = node.cy - cam.y, dz = node.cz - cam.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < 1e-6) return false;
    let t = -(cam.x * dx + cam.y * dy + cam.z * dz) / dd;
    if (t <= 0 || t >= 1) return false;         // o ponto mais próximo cai fora do segmento
    const px = cam.x + dx * t, py = cam.y + dy * t, pz = cam.z + dz * t;
    const closest = Math.sqrt(px * px + py * py + pz * pz);
    return closest < r - node.boundR;
  }

  /**
   * Seleciona o conjunto de folhas para a câmera dada.
   * @param {{x:number,y:number,z:number}} cam posição da câmera em espaço do planeta (m)
   * @param {Array} out recebe as folhas (é esvaziado)
   * @param {number} lodBias >1 reduz detalhe (ctx.quality.terrainLodBias)
   */
  select(cam, out, lodBias = 1) {
    this.frame++;
    out.length = 0;
    const k = this.splitFactor / Math.max(0.2, lodBias);
    for (let f = 0; f < 6; f++) this._select(this.roots[f], cam, out, k);
    return out;
  }

  _select(node, cam, out, k) {
    const dx = cam.x - node.cx, dy = cam.y - node.cy, dz = cam.z - node.cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - node.lodR;
    node._dist = d > 0 ? d : 0;
    node.lastSeen = this.frame;

    if (this._occluded(cam, node)) {
      node._culled = true;
      node._split = false;
      return;
    }
    node._culled = false;

    if (node.level < this.maxLevel && node._dist < k * node.arc) {
      node._split = true;
      const ch = node.children || this.subdivide(node);
      this._select(ch[0], cam, out, k);
      this._select(ch[1], cam, out, k);
      this._select(ch[2], cam, out, k);
      this._select(ch[3], cam, out, k);
    } else {
      node._split = false;
      out.push(node);
    }
  }

  /**
   * Nível que a seleção escolheria para uma direção — usado por `waitReady`
   * para saber se o LOD daquele ponto já convergiu.
   */
  wantedLevel(cam, dir, lodBias = 1) {
    const k = this.splitFactor / Math.max(0.2, lodBias);
    let node = this._rootFor(dir);
    for (;;) {
      const dx = cam.x - node.cx, dy = cam.y - node.cy, dz = cam.z - node.cz;
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - node.lodR);
      if (node.level >= this.maxLevel || d >= k * node.arc) return node.level;
      const ch = node.children || this.subdivide(node);
      node = this._bestChild(ch, dir);
    }
  }

  /** Folha atualmente selecionada que cobre a direção (segue os flags `_split`). */
  selectedLeafAt(dir) {
    let node = this._rootFor(dir);
    while (node._split && node.children) node = this._bestChild(node.children, dir);
    return node;
  }

  _rootFor(dir) {
    let best = this.roots[0], bestDot = -2;
    for (let f = 0; f < 6; f++) {
      const n = this.roots[f].dir;
      const dot = n.x * dir.x + n.y * dir.y + n.z * dir.z;
      if (dot > bestDot) { bestDot = dot; best = this.roots[f]; }
    }
    return best;
  }

  /**
   * Escolhe o filho cuja direção central está mais próxima — evita depender de
   * uma inversa exata da esferificação para descer a árvore.
   */
  _bestChild(children, dir) {
    let best = children[0], bestDot = -2;
    for (let i = 0; i < 4; i++) {
      const c = children[i].dir;
      const dot = c.x * dir.x + c.y * dir.y + c.z * dir.z;
      if (dot > bestDot) { bestDot = dot; best = children[i]; }
    }
    return best;
  }

  /**
   * Poda subárvores não visitadas há `maxAge` frames. `onDrop(node)` recebe cada
   * nó descartado para o gerente liberar a malha correspondente.
   */
  prune(maxAge, onDrop) {
    for (let f = 0; f < 6; f++) this._prune(this.roots[f], maxAge, onDrop);
  }

  _prune(node, maxAge, onDrop) {
    if (!node.children) return;
    let stale = true;
    for (let i = 0; i < 4; i++) {
      const c = node.children[i];
      this._prune(c, maxAge, onDrop);
      if (this.frame - c.lastSeen < maxAge || c.children) stale = false;
    }
    if (stale) {
      for (let i = 0; i < 4; i++) { onDrop(node.children[i]); this.nodeCount--; }
      node.children = null;
      node._split = false;
    }
  }

  dispose(onDrop) {
    const walk = (n) => {
      if (n.children) { for (let i = 0; i < 4; i++) walk(n.children[i]); n.children = null; }
      onDrop(n);
    };
    for (let f = 0; f < 6; f++) walk(this.roots[f]);
    this.roots.length = 0;
    this.nodeCount = 0;
  }
}
