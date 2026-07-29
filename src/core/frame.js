/**
 * Origem flutuante / renderização relativa à câmera.
 *
 * O problema: um planeta de 150 km de raio, orbitado a 400 km, com detalhe de
 * centímetros no chão. float32 tem ~7 dígitos significativos — a 400.000 m a
 * resolução já é ~0,03 m e a geometria começa a tremer e a vibrar.
 *
 * A solução: TODAS as posições canônicas do jogo vivem em `Vec3d` (números JS,
 * que são float64). O grafo de cena do three.js recebe apenas coordenadas
 * RELATIVAS a uma origem móvel que segue a câmera. A origem só se move em
 * saltos discretos quando a câmera se afasta demais, e todo o conteúdo da cena
 * é transladado de uma vez.
 *
 * Contrato para os módulos:
 *   - Guarde a posição real do seu objeto em double (Vec3d).
 *   - A cada frame, ou ao ouvir 'frame:rebase', escreva
 *       obj.position.copy(frame.toLocal(worldPosDouble))
 *   - Nunca guarde uma posição absoluta grande dentro de um Object3D.
 */

/** Vetor de precisão dupla. Deliberadamente simples e sem alocação escondida. */
export class Vec3d {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3d(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  distanceToSq(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  normalize() { const l = this.length(); if (l > 0) this.multiplyScalar(1 / l); return this; }
  cross(v) {
    const x = this.y * v.z - this.z * v.y;
    const y = this.z * v.x - this.x * v.z;
    const z = this.x * v.y - this.y * v.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  /** Copia de/para qualquer objeto com x,y,z (inclusive THREE.Vector3). */
  fromVector3(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  toArray() { return [this.x, this.y, this.z]; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
}

export class FloatingOrigin {
  /**
   * @param {object} opts
   * @param {number} opts.threshold distância (m) que dispara o rebase
   */
  constructor({ threshold = 2000 } = {}) {
    /** Origem atual do espaço de renderização, em coordenadas de mundo (double). */
    this.origin = new Vec3d(0, 0, 0);
    /** Posição da câmera em coordenadas de mundo (double). Fonte da verdade. */
    this.camera = new Vec3d(0, 0, 0);
    this.threshold = threshold;
    this.thresholdSq = threshold * threshold;
    /** Deslocamento aplicado no último rebase (mundo → mundo). */
    this.lastShift = new Vec3d(0, 0, 0);
    this.rebaseCount = 0;
    this._listeners = [];
    this._tmp = new Vec3d();
  }

  /** Registra callback(shift: Vec3d, origin: Vec3d). */
  onRebase(fn) { this._listeners.push(fn); return () => this.off(fn); }
  off(fn) { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }

  /**
   * Atualiza a posição de mundo da câmera e rebaseia se necessário.
   * @returns {boolean} true se houve rebase neste frame
   */
  update(cameraWorldPos) {
    this.camera.copy(cameraWorldPos);
    if (this.camera.distanceToSq(this.origin) < this.thresholdSq) return false;
    return this.rebaseTo(this.camera);
  }

  /** Força a origem para um ponto específico do mundo. */
  rebaseTo(worldPos) {
    this.lastShift.subVectors(worldPos, this.origin);
    this.origin.copy(worldPos);
    this.rebaseCount++;
    for (let i = 0; i < this._listeners.length; i++) {
      this._listeners[i](this.lastShift, this.origin);
    }
    return true;
  }

  /**
   * Mundo (double) → espaço de renderização (float, pequeno).
   * @param {Vec3d} worldPos
   * @param {{x:number,y:number,z:number}} out destino (THREE.Vector3 serve)
   */
  toLocal(worldPos, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    out = o;
    out.x = worldPos.x - this.origin.x;
    out.y = worldPos.y - this.origin.y;
    out.z = worldPos.z - this.origin.z;
    return out;
  }

  /** Espaço de renderização → mundo (double). */
  toWorld(localPos, out) {
    const o = out || new Vec3d();
    o.x = localPos.x + this.origin.x;
    o.y = localPos.y + this.origin.y;
    o.z = localPos.z + this.origin.z;
    return o;
  }

  /**
   * Distância de renderização segura: para objetos muito distantes (outros
   * planetas, estrelas) devolve uma posição comprimida logaritmicamente que
   * preserva a direção e a ordem de profundidade, mantendo tudo dentro do
   * alcance útil do float32.
   * @param {Vec3d} worldPos
   * @param {number} maxRender raio além do qual comprimimos
   */
  toLocalCompressed(worldPos, out, maxRender = 5e7) {
    const dx = worldPos.x - this.origin.x;
    const dy = worldPos.y - this.origin.y;
    const dz = worldPos.z - this.origin.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const o = out || { x: 0, y: 0, z: 0 };
    if (d <= maxRender || d === 0) {
      o.x = dx; o.y = dy; o.z = dz;
      return { pos: o, scale: 1 };
    }
    // Comprime além de maxRender; devolve a escala a aplicar no objeto para
    // que ele mantenha o mesmo tamanho angular.
    const compressed = maxRender * (1 + Math.log(d / maxRender));
    const k = compressed / d;
    o.x = dx * k; o.y = dy * k; o.z = dz * k;
    return { pos: o, scale: k };
  }
}
