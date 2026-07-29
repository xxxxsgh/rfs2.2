import * as THREE from 'three';

/**
 * HUD — camada DOM dentro de #hud.
 *
 * ── Por que DOM e não canvas ────────────────────────────────────────────────
 * O compositor do navegador desenha texto subpixel e sombras de graça, com o
 * DPI real da tela. Um HUD em canvas na resolução interna do jogo (que o módulo
 * `perf` reduz para 0,6 quando aperta) ficaria borrado exatamente quando o
 * jogador mais precisa ler. O preço é disciplina: nada de reconstruir nós por
 * frame — ver a seção "regra de escrita" abaixo.
 *
 * ── Regra de escrita (a única que importa para performance) ─────────────────
 * Todo nó é criado UMA vez no init. Por frame só acontecem duas coisas:
 *   1. comparação de um valor com o último escrito (`put()` / `cls()`);
 *   2. quando mudou, uma escrita em textContent, className, transform ou
 *      opacity — as quatro propriedades que não disparam layout caro.
 * Nenhum `innerHTML`, nenhum `createElement`, nenhuma leitura de geometria
 * (offsetWidth/getBoundingClientRect) dentro do laço.
 *
 * ── Por que o CSS é injetado em runtime ─────────────────────────────────────
 * Este módulo não é dono do index.html. O <link> para hud.css é criado no init
 * com uma URL resolvida por `import.meta.url`, então funciona igual servido da
 * raiz ou de um subdiretório.
 *
 * ── Degradação ──────────────────────────────────────────────────────────────
 * `discovery`, `multitool`, `combat`, `sentinels` e `inventory` podem não
 * existir. Tudo que vem deles passa por leitura tolerante (try/catch + optional
 * chaining) e o HUD simplesmente omite o widget correspondente.
 */

export const id = 'hud';
export const order = 95;

/** Resolvida contra este arquivo: sobrevive a servir o jogo de um subdiretório. */
const CSS_HREF = new URL('./hud.css', import.meta.url).href;

const MAX_MARKERS = 14;    // marcadores de mundo projetados simultaneamente
const MAX_PIPS = 14;       // marcadores na régua da bússola
const MAX_TOASTS = 5;
const MAX_SEG = 20;        // segmentos da barra de impulso
const TOAST_LIFE = 5.0;    // segundos visível
const TOAST_FADE = 0.5;

const CMP_PPD = 3.2;       // pixels por grau na régua da bússola
const CMP_TURNS = 3;       // 0..1080°, para nunca faltar régua nas pontas

// ── Estado do módulo ────────────────────────────────────────────────────────
const S = {
  ctx: null,
  ready: false,
  root: null,
  visible: true,

  // refs cacheadas
  cmpTrack: null, cmpPips: null, cmpDeg: null,
  arcs: null, arcKeys: null, hexVal: null, hexLbl: null,
  flight: null, spdVal: null, spdUnit: null, altVal: null, segs: null,
  modeTxt: null, target: null, targetTxt: null,
  tool: null, toolName: null, toolSub: null,
  reticle: null, units: null, unitsVal: null, markers: null, toasts: null, debug: null,

  pips: [], mks: [], toastPool: [],

  // último valor escrito (evita tocar no DOM sem necessidade)
  last: Object.create(null),

  liveToasts: [],
  // Começa estourado para o overlay de debug preencher já no primeiro frame em
  // que é ligado, em vez de piscar uma caixa vazia por 250 ms.
  debugClock: 1,
  markerClock: 0,
  heading: 0,
  provider: [],
};

// ── Temporários: zero alocação nos caminhos quentes ─────────────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ═══════════════════════════════════════════════════════════════════════════
//  Escrita disciplinada no DOM
// ═══════════════════════════════════════════════════════════════════════════

/** textContent só quando o valor mudou de verdade. */
function put(key, el, value) {
  if (!el || S.last[key] === value) return false;
  S.last[key] = value;
  el.textContent = value;
  return true;
}

/** className só quando mudou. */
function cls(key, el, value) {
  if (!el || S.last[key] === value) return false;
  S.last[key] = value;
  el.className = value;
  return true;
}

/** transform só quando mudou (a string é montada apenas nesse caso). */
function xf(key, el, value) {
  if (!el || S.last[key] === value) return false;
  S.last[key] = value;
  el.style.transform = value;
  return true;
}

function styl(key, el, prop, value) {
  if (!el || S.last[key] === value) return false;
  S.last[key] = value;
  el.style[prop] = value;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Construção (uma vez, no init)
// ═══════════════════════════════════════════════════════════════════════════

function injectCss() {
  if (document.querySelector('link[data-aether-hud]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = CSS_HREF;
  l.setAttribute('data-aether-hud', '1');
  document.head.appendChild(l);
}

/** Ponto de um arco em coordenadas SVG (0° = topo, sentido horário). */
function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Caminho de arco com pathLength normalizado — permite dasharray em %. */
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = (a1 - a0) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

const ARC_A0 = 138, ARC_A1 = 402;   // abertura no canto superior direito

function buildSkeleton() {
  const host = document.getElementById('hud') || document.body;
  const root = document.createElement('div');
  root.className = 'ah';

  // O esqueleto estático entra de uma vez — é a ÚNICA escrita de innerHTML do
  // módulo, e acontece antes do primeiro frame.
  root.innerHTML = `
<div class="ah-compass">
  <div class="ah-cmp-win">
    <div class="ah-cmp-track"></div>
    <div class="ah-cmp-pips"></div>
  </div>
  <div class="ah-cmp-needle"></div>
  <div class="ah-cmp-deg">000</div>
</div>

<div class="ah-vitals">
  <svg class="ah-arcs" viewBox="0 0 118 118" aria-hidden="true">
    <path class="ah-arc-bg" d="${arcPath(59, 59, 53, ARC_A0, ARC_A1)}"></path>
    <path class="ah-arc-bg" d="${arcPath(59, 59, 45, ARC_A0, ARC_A1)}"></path>
    <path class="ah-arc-bg" d="${arcPath(59, 59, 37, ARC_A0, ARC_A1)}"></path>
    <path class="ah-arc a0" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="0" d="${arcPath(59, 59, 53, ARC_A0, ARC_A1)}"></path>
    <path class="ah-arc a1" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="0" d="${arcPath(59, 59, 45, ARC_A0, ARC_A1)}"></path>
    <path class="ah-arc a2" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="0" d="${arcPath(59, 59, 37, ARC_A0, ARC_A1)}"></path>
  </svg>
  <div class="ah-hex"><b>100</b><span>VIT</span></div>
  <div class="ah-vit-keys">
    <div class="ah-vit-key k0"><i></i><span>vitalidade</span><b>100</b></div>
    <div class="ah-vit-key k1"><i></i><span>escudo</span><b>100</b></div>
    <div class="ah-vit-key k2"><i></i><span>energia</span><b>100</b></div>
  </div>
</div>

<div class="ah-flight">
  <div class="ah-spd"><b>0</b><i>m/s</i></div>
  <div class="ah-row"><span>altitude</span><b>—</b></div>
  <div class="ah-seg"></div>
  <div class="ah-mode">—</div>
</div>

<div class="ah-target"><i></i><span></span></div>

<div class="ah-tool">
  <span class="ah-tool-name">—</span>
  <span class="ah-tool-sub">—</span>
</div>

<div class="ah-reticle"><i></i><i></i><i></i><i></i></div>

<div class="ah-units"><span>unidades</span><b>0</b></div>

<div class="ah-markers"></div>
<div class="ah-toasts"></div>
<pre class="ah-debug"></pre>
`;
  host.appendChild(root);
  S.root = root;

  // ── Cache de referências ────────────────────────────────────────────────
  const q = (sel) => root.querySelector(sel);
  S.cmpTrack = q('.ah-cmp-track');
  S.cmpPips = q('.ah-cmp-pips');
  S.cmpDeg = q('.ah-cmp-deg');
  S.arcs = root.querySelectorAll('.ah-arc');
  S.arcKeys = root.querySelectorAll('.ah-vit-key');
  S.hexVal = q('.ah-hex b');
  S.hexLbl = q('.ah-hex span');
  S.flight = q('.ah-flight');
  S.spdVal = q('.ah-spd b');
  S.spdUnit = q('.ah-spd i');
  S.altVal = q('.ah-row b');
  S.modeTxt = q('.ah-mode');
  S.target = q('.ah-target');
  S.targetTxt = q('.ah-target span');
  S.tool = q('.ah-tool');
  S.toolName = q('.ah-tool-name');
  S.toolSub = q('.ah-tool-sub');
  S.reticle = q('.ah-reticle');
  S.units = q('.ah-units');
  S.unitsVal = q('.ah-units b');
  S.markers = q('.ah-markers');
  S.toasts = q('.ah-toasts');
  S.debug = q('.ah-debug');

  buildCompassTrack();
  buildSegments();
  buildMarkerPool();
  buildPipPool();
  buildToastPool();
}

/** Régua da bússola: 3 voltas de rótulos, criadas uma vez e só transladadas. */
function buildCompassTrack() {
  const CARD = { 0: 'N', 45: 'NE', 90: 'L', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
  const frag = document.createDocumentFragment();
  for (let turn = 0; turn < CMP_TURNS; turn++) {
    for (let d = 0; d < 360; d += 15) {
      const abs = turn * 360 + d;
      const x = abs * CMP_PPD;
      const t = document.createElement('div');
      const major = (d % 45) === 0;
      t.className = 'ah-cmp-tick' + (major ? ' maj' : '');
      t.style.left = x + 'px';
      frag.appendChild(t);
      if (major) {
        const c = document.createElement('div');
        const cardinal = CARD[d];
        c.className = 'ah-cmp-card' + (d % 90 === 0 ? '' : ' sub');
        c.style.left = x + 'px';
        c.textContent = cardinal;
        frag.appendChild(c);
      }
    }
  }
  S.cmpTrack.style.width = (CMP_TURNS * 360 * CMP_PPD) + 'px';
  S.cmpTrack.appendChild(frag);
}

function buildSegments() {
  const holder = S.root.querySelector('.ah-seg');
  const frag = document.createDocumentFragment();
  S.segs = [];
  for (let i = 0; i < MAX_SEG; i++) {
    const e = document.createElement('i');
    frag.appendChild(e);
    S.segs.push(e);
  }
  holder.appendChild(frag);
}

function buildMarkerPool() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < MAX_MARKERS; i++) {
    const d = document.createElement('div');
    d.className = 'ah-mk';
    d.innerHTML = '<div class="ah-mk-arw"></div><div class="ah-mk-ico"></div><div class="ah-mk-txt"></div><div class="ah-mk-dst"></div>';
    frag.appendChild(d);
    S.mks.push({
      el: d,
      arw: d.querySelector('.ah-mk-arw'),
      txt: d.querySelector('.ah-mk-txt'),
      dst: d.querySelector('.ah-mk-dst'),
      cls: '', tx: '', label: '', dist: '', arwRot: '',
    });
  }
  S.markers.appendChild(frag);
}

function buildPipPool() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < MAX_PIPS; i++) {
    const d = document.createElement('div');
    d.className = 'ah-pip';
    frag.appendChild(d);
    S.pips.push({ el: d, cls: '', tx: '' });
  }
  S.cmpPips.appendChild(frag);
}

function buildToastPool() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < MAX_TOASTS; i++) {
    const d = document.createElement('div');
    d.className = 'ah-toast';
    d.innerHTML = '<em></em><span></span>';
    frag.appendChild(d);
    S.toastPool.push({ el: d, kind: d.querySelector('em'), txt: d.querySelector('span'), t: 0, busy: false });
  }
  S.toasts.appendChild(frag);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Avisos
// ═══════════════════════════════════════════════════════════════════════════

const KIND_LABEL = { info: 'sistema', discovery: 'descoberta', alert: 'alerta', warn: 'atenção' };

function notify(text, kind) {
  if (!S.ready || !text) return;
  const k = KIND_LABEL[kind] ? kind : 'info';
  let slot = S.toastPool.find((t) => !t.busy);
  if (!slot) {
    // Todos ocupados: recicla o mais velho em vez de crescer o pool.
    slot = S.liveToasts.shift();
    if (!slot) return;
  }
  slot.busy = true;
  slot.t = 0;
  slot.kind.textContent = KIND_LABEL[k];
  slot.txt.textContent = String(text);
  // Reinicia a animação: remover e reaplicar a classe força um novo ciclo.
  slot.el.className = 'ah-toast k-' + k;
  void slot.el.offsetWidth;
  slot.el.className = 'ah-toast k-' + k + ' live';
  if (S.liveToasts.indexOf(slot) < 0) S.liveToasts.push(slot);
}

function tickToasts(dt) {
  for (let i = S.liveToasts.length - 1; i >= 0; i--) {
    const t = S.liveToasts[i];
    t.t += dt;
    if (t.t > TOAST_LIFE && t.el.className.indexOf('out') < 0) {
      t.el.className += ' out';
    }
    if (t.t > TOAST_LIFE + TOAST_FADE) {
      t.el.className = 'ah-toast';
      t.busy = false;
      S.liveToasts.splice(i, 1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Marcadores de mundo
// ═══════════════════════════════════════════════════════════════════════════

const _src = [];
const _srcKind = [];        // categoria resolvida em paralelo a _src
const _shipMarker = { object: null, label: 'nave' };

/**
 * Reúne marcadores de todas as fontes disponíveis. Cada entrada pode expor:
 *   { object3d|object }  → Object3D já na cena próxima (coordenadas relativas)
 *   { position }         → Vec3d em coordenadas de MUNDO (float64)
 * Nenhuma fonte é obrigatória; um módulo ausente simplesmente não contribui.
 *
 * POR QUÊ a categoria vai num array paralelo: os objetos vêm de OUTROS módulos.
 * Escrever `m.kind` neles seria mutar dado alheio — proibido pelo contrato.
 */
function collectMarkers(ctx) {
  _src.length = 0;
  _srcKind.length = 0;

  // A nave é o marcador que sempre importa: a pé, é o caminho de volta.
  try {
    if (ctx.player.mode === 'foot' && ctx.flight?.ship) {
      _shipMarker.object = ctx.flight.ship;
      _src.push(_shipMarker); _srcKind.push('ship');
    }
  } catch (e) { /* voo a meio de uma troca de modo */ }

  for (let i = 0; i < S.provider.length; i++) {
    try {
      const arr = S.provider[i](ctx);
      if (Array.isArray(arr)) {
        for (let j = 0; j < arr.length; j++) { _src.push(arr[j]); _srcKind.push(arr[j]?.kind || 'poi'); }
      }
    } catch (e) { /* fonte externa nunca derruba o HUD */ }
  }

  // Fontes canônicas opcionais.
  pushFrom(ctx.discovery, 'poi');
  pushFrom(ctx.multitool, 'scan');
  pushFrom(ctx.building, 'base');
  pushFrom(ctx.sentinels, 'alert');
  return _src;
}

function pushFrom(mod, kind) {
  if (!mod) return;
  try {
    const a = (typeof mod.getMarkers === 'function' ? mod.getMarkers() : null) || mod.markers || mod.beacons;
    if (!Array.isArray(a)) return;
    for (let i = 0; i < a.length && _src.length < MAX_MARKERS * 3; i++) {
      const m = a[i];
      if (!m) continue;
      _src.push(m);
      _srcKind.push(m.kind || kind);
    }
  } catch (e) { /* ignora */ }
}

/** Escreve a posição do marcador (espaço da cena próxima) em `out`. */
function markerLocal(ctx, m, out) {
  const obj = m.object3d || m.object;
  if (obj && obj.getWorldPosition) { obj.getWorldPosition(out); return true; }
  const w = m.position || m.pos || m.worldPos || m.center;
  if (!w || !Number.isFinite(w.x)) return false;
  ctx.frame.toLocal(w, out);
  return true;
}

function fmtDist(d) {
  if (!Number.isFinite(d)) return '';
  if (d >= 100000) return (d / 1000).toFixed(0) + 'km';
  if (d >= 1000) return (d / 1000).toFixed(1) + 'km';
  return Math.round(d) + 'm';
}

/**
 * Projeta 3D→2D, com grude na borda e seta.
 * POR QUÊ o teste de `z > 1`: pontos atrás da câmera projetam invertidos; sem
 * inverter x/y à mão, um marcador às costas apareceria na frente, do lado
 * errado — o erro clássico de HUD 3D.
 */
function updateMarkers(ctx) {
  const cam = ctx.engine.camera;
  const W = ctx.engine.size.x, H = ctx.engine.size.y;
  const hw = W * 0.5, hh = H * 0.5;
  const mgx = hw - 54, mgy = hh - 54;

  const list = collectMarkers(ctx);
  let n = 0;

  for (let i = 0; i < list.length && n < MAX_MARKERS; i++) {
    const m = list[i];
    if (!markerLocal(ctx, m, _p)) continue;

    const dist = _p.distanceTo(cam.position);
    if (dist < 4) continue;                 // dentro do próprio jogador
    const maxD = m.maxDistance || 2.5e5;
    if (dist > maxD) continue;

    _v1.copy(_p).project(cam);
    const behind = _v1.z > 1;
    let cx = (behind ? -_v1.x : _v1.x) * hw;
    let cy = (behind ? _v1.y : -_v1.y) * hh;
    if (behind && Math.abs(cx) < 1 && Math.abs(cy) < 1) cy = mgy;   // direto atrás

    let edge = behind;
    const ax = Math.abs(cx), ay = Math.abs(cy);
    if (behind || ax > mgx || ay > mgy) {
      const s = Math.min(mgx / Math.max(ax, 1e-3), mgy / Math.max(ay, 1e-3));
      cx *= s; cy *= s;
      edge = true;
    }

    const slot = S.mks[n++];
    const want = 'ah-mk on k-' + (_srcKind[i] || 'poi') + (edge ? ' edge' : '');
    if (slot.cls !== want) { slot.cls = want; slot.el.className = want; }
    const tx = 'translate3d(' + (hw + cx).toFixed(1) + 'px,' + (hh + cy).toFixed(1) + 'px,0)';
    if (slot.tx !== tx) { slot.tx = tx; slot.el.style.transform = tx; }

    const label = String(m.label || m.name || 'sinal').toUpperCase();
    if (slot.label !== label) { slot.label = label; slot.txt.textContent = label; }
    const ds = fmtDist(dist);
    if (slot.dist !== ds) { slot.dist = ds; slot.dst.textContent = ds; }
    if (edge) {
      // A seta aponta para fora, na direção em que o marcador saiu do quadro.
      const rot = 'rotate(' + (Math.atan2(cy, cx) * 180 / Math.PI).toFixed(0) + 'deg)';
      if (slot.arwRot !== rot) { slot.arwRot = rot; slot.arw.style.transform = rot; }
    }
  }

  for (let i = n; i < MAX_MARKERS; i++) {
    const slot = S.mks[i];
    if (slot.cls !== 'ah-mk') { slot.cls = 'ah-mk'; slot.el.className = 'ah-mk'; }
  }
  return list;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Bússola
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base tangente estável no ponto do jogador. "Norte" é a projeção do eixo polar
 * do planeta no plano do horizonte — a mesma definição que uma bússola real usa,
 * e por isso o rumo permanece coerente ao caminhar em volta do globo.
 */
function tangentBasis(ctx) {
  const up = ctx.player.up;
  const body = ctx.planet?.current;
  let px = 0, py = 1, pz = 0;
  if (body?.axis && Number.isFinite(body.axis.x)) { px = body.axis.x; py = body.axis.y; pz = body.axis.z; }
  _north.set(px, py, pz);
  if (Math.abs(_north.dot(up)) > 0.97) _north.set(1, 0, 0);
  _north.addScaledVector(up, -_north.dot(up));
  if (_north.lengthSq() < 1e-8) _north.set(1, 0, 0).addScaledVector(up, -up.x);
  _north.normalize();
  _east.crossVectors(_north, up).normalize();
}

/** Rumo em graus [0,360) de uma direção qualquer projetada no horizonte. */
function bearingOf(dir, up) {
  _v3.copy(dir).addScaledVector(up, -dir.dot(up));
  if (_v3.lengthSq() < 1e-10) return NaN;
  _v3.normalize();
  return (Math.atan2(_v3.dot(_east), _v3.dot(_north)) * 180 / Math.PI + 360) % 360;
}

function updateCompass(ctx, list) {
  const cam = ctx.engine.camera;
  const up = ctx.player.up;
  tangentBasis(ctx);

  _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
  let hdg = bearingOf(_v1, up);
  if (!Number.isFinite(hdg)) hdg = S.heading;
  S.heading = hdg;

  // A régua tem 3 voltas; centramos na do meio para sobrar conteúdo dos dois
  // lados sem nenhum salto quando o rumo cruza 0°.
  const px = -(360 + hdg) * CMP_PPD;
  xf('cmpx', S.cmpTrack, 'translate3d(' + px.toFixed(1) + 'px,0,0)');
  put('cmpdeg', S.cmpDeg, String(Math.round(hdg)).padStart(3, '0') + '°');

  // Marcadores na régua: mesma lista dos marcadores de mundo.
  const halfWin = 62;   // graus visíveis para cada lado
  let n = 0;
  for (let i = 0; i < list.length && n < MAX_PIPS; i++) {
    const m = list[i];
    if (!markerLocal(ctx, m, _p)) continue;
    _v2.copy(_p).sub(cam.position);
    const b = bearingOf(_v2, up);
    if (!Number.isFinite(b)) continue;
    let d = b - hdg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (Math.abs(d) > halfWin) continue;
    const slot = S.pips[n++];
    const want = 'ah-pip on k-' + (_srcKind[i] || 'poi');
    if (slot.cls !== want) { slot.cls = want; slot.el.className = want; }
    // O pip já nasce em left:50%; o transform é só o desvio angular em pixels.
    const tx = 'translate3d(' + (d * CMP_PPD).toFixed(1) + 'px,0,0)';
    if (slot.tx !== tx) { slot.tx = tx; slot.el.style.transform = tx; }
  }
  for (let i = n; i < MAX_PIPS; i++) {
    const slot = S.pips[i];
    if (slot.cls !== 'ah-pip') { slot.cls = 'ah-pip'; slot.el.className = 'ah-pip'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Widgets de estado
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Atualiza um arco. Em SVG, `element.className` é um SVGAnimatedString somente
 * leitura — por isso classe e dasharray entram por setAttribute.
 */
function setArc(i, key, frac, low) {
  const el = S.arcs[i];
  if (!el) return;
  const off = 100 - clamp(frac, 0, 1) * 100;
  const q = Math.round(off * 2) / 2;          // quantiza: evita escrita a cada frame
  if (S.last[key] !== q) {
    S.last[key] = q;
    el.setAttribute('stroke-dashoffset', String(q));
  }
  const c = 'ah-arc a' + i + (low ? ' low' : '');
  if (S.last[key + 'c'] !== c) { S.last[key + 'c'] = c; el.setAttribute('class', c); }
}

function updateVitals(ctx) {
  const p = ctx.player;
  const ship = p.mode === 'ship';

  // A pé: vitalidade / escudo / energia. Na nave: casco / escudo / impulso.
  const v0 = clamp(ship ? (p.health ?? 100) : (p.life ?? p.health ?? 100), 0, 100);
  const v1 = clamp(p.shield ?? 100, 0, 100);
  const v2 = clamp(ship ? (ctx.cockpit?.pulseFuel ?? 100) : (p.energy ?? 100), 0, 100);

  setArc(0, 'a0', v0 / 100, v0 < 25);
  setArc(1, 'a1', v1 / 100, v1 < 25);
  setArc(2, 'a2', v2 / 100, v2 < 20);

  put('hexv', S.hexVal, String(Math.round(v0)));
  put('hexl', S.hexLbl, ship ? 'CASCO' : 'VIT');

  const k = S.arcKeys;
  put('k0n', k[0].children[1], ship ? 'casco' : 'vitalidade');
  put('k1n', k[1].children[1], 'escudo');
  put('k2n', k[2].children[1], ship ? 'impulso' : 'energia');
  put('k0v', k[0].children[2], String(Math.round(v0)));
  put('k1v', k[1].children[2], String(Math.round(v1)));
  put('k2v', k[2].children[2], String(Math.round(v2)));
}

function updateFlight(ctx) {
  const p = ctx.player;
  const ship = p.mode === 'ship';
  styl('fvis', S.flight, 'display', ship ? 'block' : 'none');
  styl('tvis', S.tool, 'display', ship ? 'none' : 'block');
  cls('ret', S.reticle, 'ah-reticle' + (ship ? '' : ' on'));

  if (ship) {
    const spd = ctx.flight?.speed ?? p.velocity.length();
    if (spd >= 1000) { put('spd', S.spdVal, (spd / 1000).toFixed(1)); put('spdu', S.spdUnit, 'km/s'); }
    else { put('spd', S.spdVal, String(Math.round(spd))); put('spdu', S.spdUnit, 'm/s'); }

    const alt = p.altitude;
    put('alt', S.altVal, Number.isFinite(alt)
      ? (alt >= 10000 ? (alt / 1000).toFixed(1) + ' km' : Math.round(alt) + ' m')
      : 'ÓRBITA');

    // Barra: combustível de impulso quando existe, senão fator de aceleração.
    const fuel = ctx.cockpit?.pulseFuel;
    const frac = Number.isFinite(fuel) ? fuel / 100 : clamp(ctx.flight?.boostFactor ?? 0, 0, 1);
    const lit = Math.round(clamp(frac, 0, 1) * MAX_SEG);
    const warn = Number.isFinite(fuel) && fuel < 22;
    if (S.last.seg !== lit || S.last.segw !== warn) {
      S.last.seg = lit; S.last.segw = warn;
      for (let i = 0; i < MAX_SEG; i++) {
        S.segs[i].className = i < lit ? (warn ? 'warn' : 'on') : '';
      }
    }

    const landed = ctx.flight?.landed;
    put('mode', S.modeTxt, landed ? 'pousado' : (p.inAtmosphere ? 'voo atmosférico' : 'vácuo'));
  } else {
    // Multiferramenta: nome e modo ativos, quando o módulo existir.
    let name = 'multiferramenta', sub = 'sem módulo';
    try {
      const t = ctx.multitool;
      if (t) {
        // `active` pode ser um objeto de ferramenta; só aceitamos strings para
        // não escrever "[object Object]" na tela quando o contrato mudar.
        const cand = [t.activeName, t.currentName, t.active?.name, t.active, t.mode];
        for (let i = 0; i < cand.length; i++) {
          if (typeof cand[i] === 'string' && cand[i]) { name = cand[i]; break; }
        }
        const c = t.charge ?? t.energy;
        sub = Number.isFinite(c) ? Math.round(c) + '% carga' : (typeof t.subtitle === 'string' ? t.subtitle : 'pronto');
      }
    } catch (e) { /* módulo alheio */ }
    put('tooln', S.toolName, name);
    put('tools', S.toolSub, sub);
  }

  // Alvo travado (módulo de combate opcional).
  let tname = '';
  try {
    const t = ctx.combat?.target || ctx.combat?.lockedTarget || ctx.combat?.lock;
    if (t) tname = String(t.name || t.id || 'contato');
  } catch (e) { /* ignora */ }
  cls('tgt', S.target, 'ah-target' + (tname ? ' on' : ''));
  if (tname) put('tgtn', S.targetTxt, tname);

  // Saldo de unidades — só existe se o módulo `discovery` carregou.
  const u = ctx.discovery?.units;
  styl('uvis', S.units, 'display', Number.isFinite(u) ? 'flex' : 'none');
  if (Number.isFinite(u)) put('uval', S.unitsVal, u >= 1e6 ? (u / 1e6).toFixed(2) + 'M' : String(Math.round(u)));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay de depuração
// ═══════════════════════════════════════════════════════════════════════════

const _dbg = [];

function updateDebug(ctx, dt) {
  const on = !!ctx.debug.enabled;
  cls('dbg', S.debug, 'ah-debug' + (on ? ' on' : ''));
  if (!on) return;
  S.debugClock += dt;
  if (S.debugClock < 0.25) return;            // 4 Hz: montar a string aloca
  S.debugClock = 0;

  const st = ctx.engine.stats;
  _dbg.length = 0;
  _dbg.push('fps        ' + st.fps.toFixed(0) + '  (' + st.frameMs.toFixed(1) + ' ms)');
  _dbg.push('draw calls ' + st.drawCalls);
  _dbg.push('triângulos ' + fmtNum(st.triangles));
  _dbg.push('programas  ' + st.programs);
  _dbg.push('seed       ' + ctx.seed + '  q=' + ctx.quality.preset);
  _dbg.push('─────────────────────────');
  for (const [k, v] of ctx.debug.lines) _dbg.push(pad(k, 10) + ' ' + v);
  S.debug.textContent = _dbg.join('\n');
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ciclo de vida
// ═══════════════════════════════════════════════════════════════════════════

export async function init(ctx) {
  S.ctx = ctx;
  injectCss();
  buildSkeleton();
  S.ready = true;

  ctx.events.on('ui:notify', (p) => notify(p?.text, p?.kind || 'info'));
  ctx.events.on('discovery:new', (p) => {
    if (!p) return;
    notify((p.name || p.id || 'algo novo') + (p.kind ? ' · ' + p.kind : ''), 'discovery');
  });
  ctx.events.on('sentinel:alert', (p) => {
    const lvl = p?.level ?? 1;
    notify('sentinelas — nível ' + lvl, 'alert');
  });
  ctx.events.on('planet:land', () => notify('pouso concluído', 'info'));
  ctx.events.on('player:damage', (p) => {
    if ((p?.amount || 0) > 12) notify('dano ao casco', 'alert');
  });

  ctx.provide(id, {
    get visible() { return S.visible; },
    /** OBRIGATÓRIO: o arnês captura sem HUD chamando setVisible(false). */
    setVisible(v) {
      S.visible = !!v;
      // A classe (opacidade) mantém o layout vivo — nada recalcula ao voltar.
      S.root.className = 'ah' + (S.visible ? '' : ' ah-off');
    },
    notify,
    /** Fonte extra de marcadores: fn(ctx) → array de {position|object,label,kind}. */
    addMarkerSource(fn) { if (typeof fn === 'function') S.provider.push(fn); },
    removeMarkerSource(fn) { const i = S.provider.indexOf(fn); if (i >= 0) S.provider.splice(i, 1); },
    dispose() { dispose(ctx); },
  });
}

/**
 * Tudo no lateUpdate: os marcadores dependem da câmera, e quem escreve a câmera
 * é o módulo `flight` no lateUpdate dele (order 20, antes deste). Fazer a
 * projeção no `update` deixaria os marcadores um frame atrás — visível como
 * "nado" durante uma curva.
 */
export function lateUpdate(dt, ctx) {
  if (!S.ready) return;
  tickToasts(dt);
  if (!S.visible) return;

  updateVitals(ctx);
  updateFlight(ctx);

  // Marcadores e bússola a 30 Hz: são a parte mais cara (projeção + N nós) e
  // ninguém percebe a diferença num elemento que se move poucos pixels.
  S.markerClock += dt;
  if (S.markerClock >= 1 / 30) {
    S.markerClock = 0;
    const list = updateMarkers(ctx);
    updateCompass(ctx, list);
  }

  updateDebug(ctx, dt);
}

export function dispose(ctx) {
  S.ready = false;
  if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
  S.root = null;
  S.mks.length = 0;
  S.pips.length = 0;
  S.toastPool.length = 0;
  S.liveToasts.length = 0;
  S.provider.length = 0;
}
