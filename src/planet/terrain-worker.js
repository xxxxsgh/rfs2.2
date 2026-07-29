/**
 * Web Worker de terreno (type: 'module').
 *
 * Recebe a descrição de um nó do quadsphere e devolve a malha pronta em
 * ArrayBuffers transferíveis. Nada de `three` aqui: o worker fala em buffers,
 * o gerente monta o BufferGeometry.
 *
 * ── Por que a normal sai daqui ──────────────────────────────────────────────
 * Normal calculada a partir dos triângulos da malha é uma média de faces: nos
 * nós grandes ela achata o relevo e nas juntas entre níveis ela diverge,
 * produzindo uma costura de iluminação bem visível. Aqui a normal vem de
 * diferenças finitas da PRÓPRIA função de altura sobre uma grade com anel de
 * padding — é a normal da superfície analítica, idêntica dos dois lados de
 * qualquer junta que compartilhe o espaçamento de amostra.
 *
 * ── Saia (skirt) ────────────────────────────────────────────────────────────
 * A grade é (res+2)² e o ANEL EXTERNO é a saia: mesma direção do vértice de
 * borda, raio reduzido. Assim o corner case dos cantos resolve sozinho e a
 * costura entre níveis diferentes fica escondida por uma parede vertical em
 * vez de um buraco.
 *
 * Este módulo também exporta `buildChunk` para a thread principal poder gerar
 * sincronamente (fatiado por orçamento) quando Web Workers não estão
 * disponíveis — degradação graciosa, ARCHITECTURE §2.6.
 */

import { createField, createPalette, shadeVertex } from './terrain-field.js';
import { faceUVToDirection, HALF_PI } from './quadsphere.js';

const IS_WORKER = typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

/**
 * Empacotamento dos atributos (importa: são centenas de chunks vivos).
 *   position  Float32 x3   — precisa de faixa dinâmica, fica como está
 *   normal    Int16   x3 normalizado — erro ~0,003°, invisível, metade do custo
 *   color     Uint16  x3 normalizado — linear; 8 bits bandaria os biomas escuros
 *   matmix    Uint8   x4 normalizado
 * O ÍNDICE não é enviado: a topologia é idêntica em todo chunk da mesma
 * resolução e o gerente compartilha um único BufferAttribute entre todos.
 * Sem `uv`: o material é triplanar, uma UV planar aqui só ocuparia banda.
 */

// ── Cache de scratch por tamanho de grade: zero alocação entre chunks ───────
let _scratchN = 0;
let _dirX = null, _dirY = null, _dirZ = null, _hh = null;
let _nx = null, _ny = null, _nz = null, _slope = null;
let _shadeC = null, _shadeM = null;

function ensureScratch(N) {
  if (_scratchN === N) return;
  const n = N * N;
  _dirX = new Float64Array(n); _dirY = new Float64Array(n); _dirZ = new Float64Array(n);
  _hh = new Float64Array(n);
  _nx = new Float32Array(n); _ny = new Float32Array(n); _nz = new Float32Array(n);
  _slope = new Float32Array(n);
  // Cor/material por vértice ÚNICO: o anel da saia repete o vértice de borda,
  // e classificar + colorir de novo era ~11% do chunk gasto duas vezes.
  _shadeC = new Uint16Array(n * 3); _shadeM = new Uint8Array(n * 4);
  _scratchN = N;
}

const _uv = { x: 0, y: 0, z: 0 };
const _mix = new Float32Array(4);

/**
 * Constrói a malha de um nó.
 * @param {object} job {face,u0,v0,size,resolution}
 * @param {object} field  retorno de createField()
 * @param {object} pal    retorno de createPalette()
 * @param {number} radius raio do datum
 * @returns {{payload:object, transfer:ArrayBuffer[]}}
 */
export function buildChunk(job, field, pal, radius) {
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  const res = job.resolution | 0;
  const N = res + 2;
  const total = N * N;
  ensureScratch(N);

  const step = job.size / (res - 1);
  const arc = job.size * HALF_PI * radius;
  const cell = arc / (res - 1);                 // espaçamento das amostras (m)
  const skirt = arc * 0.14 + 1.5;

  // ── Passo A: direções + alturas na grade com padding ─────────────────────
  let hMin = Infinity, hMax = -Infinity;
  for (let j = 0; j < N; j++) {
    const v = job.v0 + (j - 1) * step;
    for (let i = 0; i < N; i++) {
      const u = job.u0 + (i - 1) * step;
      const k = j * N + i;
      faceUVToDirection(job.face, u, v, _uv);
      _dirX[k] = _uv.x; _dirY[k] = _uv.y; _dirZ[k] = _uv.z;
      const h = field.height(_uv.x, _uv.y, _uv.z, cell);
      _hh[k] = h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }

  // ── Passo B: normais analíticas + inclinação (só no miolo) ───────────────
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      const kL = k - 1, kR = k + 1, kD = k - N, kU = k + N;
      const rL = radius + _hh[kL], rR = radius + _hh[kR];
      const rD = radius + _hh[kD], rU = radius + _hh[kU];
      const ax = _dirX[kR] * rR - _dirX[kL] * rL;
      const ay = _dirY[kR] * rR - _dirY[kL] * rL;
      const az = _dirZ[kR] * rR - _dirZ[kL] * rL;
      const bx = _dirX[kU] * rU - _dirX[kD] * rD;
      const by = _dirY[kU] * rU - _dirY[kD] * rD;
      const bz = _dirZ[kU] * rU - _dirZ[kD] * rD;
      let cx = ay * bz - az * by;
      let cy = az * bx - ax * bz;
      let cz = ax * by - ay * bx;
      const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
      cx /= l; cy /= l; cz /= l;
      // Garante orientação para fora (a base U x V já é externa, mas o relevo
      // extremo pode virar o produto vetorial num vértice degenerado).
      if (cx * _dirX[k] + cy * _dirY[k] + cz * _dirZ[k] < 0) { cx = -cx; cy = -cy; cz = -cz; }
      _nx[k] = cx; _ny[k] = cy; _nz[k] = cz;
      const up = cx * _dirX[k] + cy * _dirY[k] + cz * _dirZ[k];
      _slope[k] = Math.sqrt(Math.max(0, 1 - up * up));   // sen do ângulo com a vertical
    }
  }

  // ── Passo C: escrita dos atributos ───────────────────────────────────────
  const position = new Float32Array(total * 3);
  const normal = new Int16Array(total * 3);
  const color = new Uint16Array(total * 3);
  const matmix = new Uint8Array(total * 4);
  const _col = new Float32Array(3);

  const cDir = { x: 0, y: 0, z: 0 };
  faceUVToDirection(job.face, job.u0 + job.size * 0.5, job.v0 + job.size * 0.5, cDir);
  const ox = cDir.x * radius, oy = cDir.y * radius, oz = cDir.z * radius;

  const amp = field.amplitude;
  let bsMinX = Infinity, bsMinY = Infinity, bsMinZ = Infinity;
  let bsMaxX = -Infinity, bsMaxY = -Infinity, bsMaxZ = -Infinity;

  // Classificação + coloração APENAS dos vértices únicos (o miolo).
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const s = j * N + i;
      const h = _hh[s];
      const cls = field.classify(_dirX[s], _dirY[s], _dirZ[s], h, _slope[s], _mix);
      const o4 = s * 4;
      _shadeM[o4] = (_mix[0] * 255) | 0;
      _shadeM[o4 + 1] = (_mix[1] * 255) | 0;
      _shadeM[o4 + 2] = (_mix[2] * 255) | 0;
      _shadeM[o4 + 3] = (_mix[3] * 255) | 0;
      // Ruído de vértice barato e determinístico para quebrar as faixas.
      const varN = Math.sin((_dirX[s] * 911.7 + _dirY[s] * 573.3 + _dirZ[s] * 337.1) * radius * 0.021) * 0.5;
      shadeVertex(_col, 0, pal, h / amp, _mix, varN, cls.moisture);
      const o3 = s * 3;
      _shadeC[o3] = clamp16(_col[0]);
      _shadeC[o3 + 1] = clamp16(_col[1]);
      _shadeC[o3 + 2] = clamp16(_col[2]);
    }
  }

  for (let j = 0; j < N; j++) {
    const sj = j < 1 ? 1 : (j > N - 2 ? N - 2 : j);
    for (let i = 0; i < N; i++) {
      const si = i < 1 ? 1 : (i > N - 2 ? N - 2 : i);
      const k = j * N + i;
      const s = sj * N + si;
      const isSkirt = (i !== si) || (j !== sj);

      const h = _hh[s];
      const r = radius + h - (isSkirt ? skirt : 0);
      const px = _dirX[s] * r - ox;
      const py = _dirY[s] * r - oy;
      const pz = _dirZ[s] * r - oz;
      const o3 = k * 3, s3 = s * 3;
      position[o3] = px; position[o3 + 1] = py; position[o3 + 2] = pz;
      normal[o3] = (_nx[s] * 32767) | 0;
      normal[o3 + 1] = (_ny[s] * 32767) | 0;
      normal[o3 + 2] = (_nz[s] * 32767) | 0;

      if (px < bsMinX) bsMinX = px; if (px > bsMaxX) bsMaxX = px;
      if (py < bsMinY) bsMinY = py; if (py > bsMaxY) bsMaxY = py;
      if (pz < bsMinZ) bsMinZ = pz; if (pz > bsMaxZ) bsMaxZ = pz;

      const o4 = k * 4, s4 = s * 4;
      matmix[o4] = _shadeM[s4];
      matmix[o4 + 1] = _shadeM[s4 + 1];
      matmix[o4 + 2] = _shadeM[s4 + 2];
      matmix[o4 + 3] = _shadeM[s4 + 3];
      color[o3] = _shadeC[s3];
      color[o3 + 1] = _shadeC[s3 + 1];
      color[o3 + 2] = _shadeC[s3 + 2];
    }
  }

  const quads = (N - 1) * (N - 1);

  const bcx = (bsMinX + bsMaxX) * 0.5, bcy = (bsMinY + bsMaxY) * 0.5, bcz = (bsMinZ + bsMaxZ) * 0.5;
  const bsr = 0.5 * Math.sqrt(
    (bsMaxX - bsMinX) * (bsMaxX - bsMinX) +
    (bsMaxY - bsMinY) * (bsMaxY - bsMinY) +
    (bsMaxZ - bsMinZ) * (bsMaxZ - bsMinZ),
  ) + 1;

  const payload = {
    type: 'chunk',
    nodeId: job.nodeId,
    seq: job.seq,
    gen: job.gen,
    resolution: res,
    position, normal, color, matmix,
    hMin, hMax,
    origin: { x: ox, y: oy, z: oz },
    bs: { x: bcx, y: bcy, z: bcz, r: bsr },
    triangles: quads * 2,
    // Telemetria do custo real do campo: é a medida que diz se a fila drena por
    // ter menos chunks ou por cada chunk ficar mais barato.
    buildMs: t0 ? (performance.now() - t0) : 0,
  };
  const transfer = [position.buffer, normal.buffer, color.buffer, matmix.buffer];
  return { payload, transfer };
}

function clamp16(v) {
  const x = v * 65535;
  return x < 0 ? 0 : (x > 65535 ? 65535 : x | 0);
}

/**
 * Índice compartilhado por TODOS os chunks da mesma resolução: a topologia da
 * grade com saia é sempre a mesma. Economiza ~14 KB por chunk vivo.
 */
export function buildSharedIndex(resolution) {
  const N = resolution + 2;
  const quads = (N - 1) * (N - 1);
  const total = N * N;
  const index = total > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let t = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      index[t++] = a; index[t++] = b; index[t++] = c;
      index[t++] = b; index[t++] = d; index[t++] = c;
    }
  }
  return index;
}

// ── Lado worker ─────────────────────────────────────────────────────────────

if (IS_WORKER) {
  let field = null;
  let pal = null;
  let radius = 150000;

  self.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    switch (m.type) {
      case 'config': {
        radius = m.radius;
        field = createField(m.seed, m.terrain, { radius });
        pal = createPalette(m.palette);
        if (m.brushes) for (let i = 0; i < m.brushes.length; i++) field.editMap.addRaw(m.brushes[i]);
        self.postMessage({ type: 'ready', gen: m.gen });
        break;
      }
      case 'edit': {
        if (field) field.editMap.addRaw(m.brush);
        break;
      }
      case 'clearEdits': {
        if (field) field.editMap.clear();
        break;
      }
      case 'build': {
        if (!field) { self.postMessage({ type: 'fail', nodeId: m.nodeId, seq: m.seq, gen: m.gen }); return; }
        try {
          const { payload, transfer } = buildChunk(m, field, pal, radius);
          self.postMessage(payload, transfer);
        } catch (e) {
          self.postMessage({ type: 'fail', nodeId: m.nodeId, seq: m.seq, gen: m.gen, error: String(e && e.message) });
        }
        break;
      }
      default: break;
    }
  };
}
