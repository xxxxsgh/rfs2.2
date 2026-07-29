/**
 * Medição de custo por passe.
 *
 * Tempo de CPU num pipeline de GL é quase inútil (o driver só enfileira
 * comandos), então quando `EXT_disjoint_timer_query_webgl2` existe usamos
 * queries de timestamp reais. O resultado de uma query só fica disponível
 * alguns frames depois — por isso o pool: nada é alocado no caminho quente,
 * as queries voltam para a lista livre assim que são lidas.
 *
 * Sem a extensão caímos para tempo de CPU por passe. Não é o custo real de GPU
 * — é o custo de montar e submeter o passe — mas é a única medida disponível e
 * ainda denuncia recompilação de shader e upload de uniforme fora de hora.
 *
 * Só roda com o overlay de debug aberto: queries de tempo forçam sincronização
 * no driver de alguns fabricantes, e medir sempre custaria mais do que se mede.
 */
export class GpuProfiler {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.ext = null;
    this.available = false;
    try {
      // `has` antes de `get`: o `get` do three imprime um aviso quando falta.
      if (renderer.extensions.has('EXT_disjoint_timer_query_webgl2')) {
        this.ext = renderer.extensions.get('EXT_disjoint_timer_query_webgl2');
        this.available = !!this.ext;
      }
    } catch (e) { this.available = false; }

    this.enabled = false;
    this._free = [];
    // Arrays paralelos em vez de {q,name}: o profiler roda por frame e um
    // objeto novo por passe por frame é lixo gratuito para o GC.
    this._pendingQ = [];
    this._pendingName = [];
    this._active = null;
    this._activeName = '';
    this._cpuStart = 0;
    /** Média móvel em ms por nome de passe. */
    this.ms = new Map();
    this._maxPool = 24;
    this._resolved = 0;
    this._starvedPolls = 0;
    /** 'gpu' quando há queries de verdade, 'cpu' no fallback. */
    this.mode = this.available ? 'gpu' : 'cpu';
  }

  _accumulate(name, ms) {
    const prev = this.ms.get(name);
    // Suavização: o número precisa ser legível no overlay, não instantâneo.
    this.ms.set(name, prev === undefined ? ms : prev + (ms - prev) * 0.12);
  }

  setEnabled(on) {
    const want = !!on;
    if (want === this.enabled) return;
    this.enabled = want;
    this.mode = this.available ? 'gpu' : 'cpu';
    if (!want) { this._flush(); this.ms.clear(); }
  }

  begin(name) {
    if (!this.enabled || this._active) return;
    if (!this.available) {
      this._activeName = name;
      this._cpuStart = performance.now();
      return;
    }
    const gl = this.gl;
    let q = this._free.pop();
    if (!q) {
      if (this._pendingQ.length >= this._maxPool) return;
      q = gl.createQuery();
      if (!q) { this.available = false; this.enabled = false; return; }
    }
    try {
      gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this._active = q;
      this._activeName = name;
    } catch (e) {
      this._free.push(q);
      this._active = null;
    }
  }

  end() {
    if (!this.available) {
      if (this.enabled && this._activeName) {
        this._accumulate(this._activeName, performance.now() - this._cpuStart);
        this._activeName = '';
      }
      return;
    }
    if (!this._active) return;
    const gl = this.gl;
    try {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this._pendingQ.push(this._active);
      this._pendingName.push(this._activeName);
    } catch (e) {
      this._free.push(this._active);
    }
    this._active = null;
  }

  /** Colhe o que ficou pronto. Chamar uma vez por frame, no fim. */
  poll() {
    if (!this.available) return;
    const gl = this.gl;

    // Alguns backends (ANGLE/SwiftShader, drivers antigos) anunciam a extensão
    // e nunca marcam a query como disponível. Sem esta saída o profiler ficaria
    // eternamente vazio e o overlay não mostraria custo nenhum.
    if (this._pendingQ.length > 0 && this._resolved === 0) {
      if (++this._starvedPolls > 60) {
        this.available = false;
        this.mode = 'cpu';
        this._flush();
        return;
      }
    }

    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this._pendingQ.length - 1; i >= 0; i--) {
      const q = this._pendingQ[i];
      let ready = false;
      try { ready = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); }
      catch (e) { ready = true; }
      if (!ready) continue;
      const name = this._pendingName[i];
      this._pendingQ.splice(i, 1);
      this._pendingName.splice(i, 1);
      if (!disjoint) {
        let ns = 0;
        try { ns = gl.getQueryParameter(q, gl.QUERY_RESULT); } catch (e) { ns = 0; }
        this._accumulate(name, ns / 1e6);
        this._resolved++;
      }
      this._free.push(q);
    }
  }

  _flush() {
    const gl = this.gl;
    for (const q of this._pendingQ) { try { gl.deleteQuery(q); } catch (e) { /* ignora */ } }
    for (const q of this._free) { try { gl.deleteQuery(q); } catch (e) { /* ignora */ } }
    this._pendingQ.length = 0;
    this._pendingName.length = 0;
    this._free.length = 0;
  }

  dispose() { this._flush(); this.ms.clear(); }
}
