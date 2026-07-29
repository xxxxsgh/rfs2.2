import * as THREE from 'three';

/**
 * COCKPIT — interior em primeira pessoa, desenhado na `engine.overlayScene`.
 *
 * ── Por que uma cena de overlay própria ─────────────────────────────────────
 * O interior fica a 30 cm da córnea enquanto o planeta está a 200 km. Nenhum
 * frustum único aguenta isso: a `overlayCamera` tem near 0.01 / far 100 e o
 * depth é limpo antes do pass, então o cockpit nunca briga com o terreno por
 * precisão de profundidade. Em troca, este módulo é o ÚNICO responsável por
 * iluminar a própria cena — as luzes do módulo `lighting` vivem em
 * `engine.scene` e não chegam aqui.
 *
 * ── Por que o root copia a orientação da câmera ─────────────────────────────
 * A `overlayCamera` fica na origem com a orientação da câmera principal. Um
 * objeto com transform identidade na overlayScene está, portanto, em espaço de
 * MUNDO (rotacionado), não em espaço de VISÃO. Para o cockpit ficar parafusado
 * ao olho do piloto, o root recebe a mesma quaternion da câmera; qualquer
 * balanço de inércia entra DEPOIS, como um delta local pequeno. O efeito
 * colateral é correto: o tremor de reentrada que o `flight` aplica na câmera
 * sacode o mundo lá fora e deixa o cockpit firme — que é o que acontece quando
 * piloto e fuselagem estão presos na mesma estrutura.
 *
 * ── Por que o HUD daqui é geometria, e não DOM ──────────────────────────────
 * Mostradores desenhados em 2D por cima da tela denunciam protótipo: não têm
 * paralaxe, não recebem o reflexo do vidro e não se deformam com a curvatura do
 * painel. Aqui cada mostrador é um painel curvo com CanvasTexture emissiva. O
 * canvas SÓ é redesenhado quando a assinatura dos valores muda (dirty flag) e
 * no máximo a ~8 Hz — redesenhar um canvas 512² por frame custaria mais que o
 * resto do módulo inteiro.
 *
 * ── Nota técnica sobre shaders ──────────────────────────────────────────────
 * O renderer roda com `logarithmicDepthBuffer`. Por isso NÃO existe nenhum
 * `ShaderMaterial` completo neste arquivo: tudo é material padrão do three
 * (que já injeta os chunks de logdepth) e as customizações entram por
 * `onBeforeCompile`. Se algum dia for preciso um shader próprio aqui, ele tem
 * de incluir <common>, <logdepthbuf_pars_vertex>, <logdepthbuf_vertex>,
 * <logdepthbuf_pars_fragment> e <logdepthbuf_fragment>, nessa ordem.
 */

export const id = 'cockpit';
export const order = 65;

// ── Paleta diegética (ciano/âmbar, §8.3 da arquitetura) ─────────────────────
const CY = '#5fe0ff';
const CY_DIM = 'rgba(95,224,255,0.34)';
const AM = '#ffb347';
const AM_DIM = 'rgba(255,179,71,0.30)';
const RED = '#ff6a52';

// ── Estado do módulo ────────────────────────────────────────────────────────
const S = {
  ctx: null,
  ready: false,
  root: null,
  lightRig: null,
  sun: null,
  ambient: null,
  glassMat: null,
  glassUniforms: null,
  gauges: [],
  stick: null,
  throttleLever: null,
  armR: null,
  armL: null,
  disposables: [],

  /** null = automático; true/false = forçado por setVisible (arnês de captura). */
  forced: null,
  visible: false,

  // Inércia
  prevVel: { x: 0, y: 0, z: 0 },
  hasPrevVel: false,
  accWorld: new THREE.Vector3(),
  swayPos: new THREE.Vector3(),
  swayRot: new THREE.Vector3(),
  shake: 0,

  // Combustível de impulso simulado localmente (ver comentário em updateFuel).
  pulseFuel: 100,

  // Cadência de redesenho dos mostradores. Começa "estourado" para que o
  // PRIMEIRO frame visível já desenhe — senão a captura pega telas em branco.
  gaugeClock: 1,
  gaugeC: null, gaugeL: null, gaugeR: null,
  buttons: null,

  envSeen: undefined,
};

// ── Temporários: zero alocação nos caminhos quentes ─────────────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _eul = new THREE.Euler();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (dt, k) => 1 - Math.exp(-k * dt);

// ═══════════════════════════════════════════════════════════════════════════
//  Geometria auxiliar
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enrola uma geometria plana em torno do eixo Y, a uma distância R do piloto.
 * POR QUÊ: consoles e telas de cockpit são cilíndricos — envolvem o assento.
 * Um painel reto lê como maquete de papelão; um arco lê como cabine.
 * A coordenada x vira ângulo e z vira deslocamento radial (z>0 = mais longe).
 */
function wrapZ(geo, R) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const a = x / R;
    const r = R + z;
    p.setX(i, Math.sin(a) * r);
    p.setZ(i, -Math.cos(a) * r);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Painel curvo (tela/decalque) já inclinado para o piloto antes de enrolar. */
function curvedPanel(w, h, R, tilt, xOff, segs = 10) {
  const g = new THREE.PlaneGeometry(w, h, segs, 2);
  if (tilt) g.rotateX(tilt);
  if (xOff) g.translate(xOff, 0, 0);
  return wrapZ(g, R);
}

/** Bloco curvo (console, quilha do painel). */
function curvedSlab(w, h, d, R, tilt, xOff, segs = 20) {
  const g = new THREE.BoxGeometry(w, h, d, segs, 1, 1);
  if (tilt) g.rotateX(tilt);
  if (xOff) g.translate(xOff, 0, 0);
  return wrapZ(g, R);
}

/**
 * Nervura da canópia: um toro elíptico que abraça exatamente o elipsoide do
 * vidro. Gerar a nervura a partir da MESMA equação do vidro é o que impede o
 * clássico "arco flutuando 3 cm acima do canopy".
 */
function canopyRib({ x = 0, tube = 0.035, arc = Math.PI, rot = 0, sx = 1.30, sy = 1.05, sz = 1.75 }) {
  const k = Math.sqrt(Math.max(0, 1 - (x / sx) * (x / sx)));
  const g = new THREE.TorusGeometry(k, tube / Math.max(k, 0.2), 6, 40, arc);
  g.rotateZ(rot);
  g.rotateY(Math.PI * 0.5);      // do plano XY para o plano ZY (meridiano)
  g.scale(1, sy, sz);
  g.translate(x, 0, 0);
  return g;
}

/** Anel transversal (latitude) sobre a mesma casca. */
function canopyRing({ theta = 1.9, tube = 0.03, sx = 1.30, sy = 1.05, sz = 1.75 }) {
  const k = Math.sin(theta);
  const g = new THREE.TorusGeometry(k, tube, 6, 56);
  g.rotateX(Math.PI * 0.5);      // plano XZ
  g.scale(sx, 1, sz);
  g.translate(0, Math.cos(theta) * sy, 0);
  return g;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Texturas procedurais (regra 5: nenhum asset binário)
// ═══════════════════════════════════════════════════════════════════════════

/** Chapa metálica com linhas de painel e rebites — dá escala ao interior. */
function makePlateTexture(rng) {
  const N = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');

  g.fillStyle = '#3a4048';
  g.fillRect(0, 0, N, N);

  // Painéis irregulares: sem essa variação o metal lê como plástico liso.
  for (let i = 0; i < 46; i++) {
    const w = rng.range(0.08, 0.34) * N, h = rng.range(0.06, 0.26) * N;
    const x = rng.float() * N, y = rng.float() * N;
    const k = rng.range(-0.10, 0.10);
    g.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(0,0,0,${-k})`;
    g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1.4;
    g.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  // Rebites.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < 900; i++) g.fillRect(rng.float() * N, rng.float() * N, 2, 2);
  // Sujeira acumulada nas quinas.
  const vg = g.createRadialGradient(N * 0.5, N * 0.5, N * 0.18, N * 0.5, N * 0.5, N * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vg;
  g.fillRect(0, 0, N, N);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Sujeira e arranhões do vidro. Entra como `alphaMap`: onde há sujeira, o vidro
 * fica opaco o bastante para receber o reflexo do ambiente. Mantido MUITO
 * discreto — vidro sujo demais some com a paisagem, que é o produto.
 */
function makeGrimeTexture(rng) {
  const N = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');

  g.fillStyle = '#000000';
  g.fillRect(0, 0, N, N);

  // Manchas difusas (resíduo de chuva/poeira).
  for (let i = 0; i < 42; i++) {
    const x = rng.float() * N, y = rng.float() * N, r = rng.range(18, 96);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = rng.range(0.03, 0.13);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  // Arranhões: arcos finos concêntricos, como limpeza a pano seco.
  g.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const cx = rng.range(0.1, 0.9) * N, cy = rng.range(0.1, 0.9) * N;
    const r = rng.range(20, 210), a0 = rng.float() * Math.PI * 2;
    g.strokeStyle = `rgba(255,255,255,${rng.range(0.05, 0.20)})`;
    g.lineWidth = rng.range(0.5, 1.4);
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + rng.range(0.12, 0.6));
    g.stroke();
  }

  // Grime nas bordas (onde a moldura encontra o vidro a sujeira se acumula).
  const vg = g.createRadialGradient(N * 0.5, N * 0.5, N * 0.30, N * 0.5, N * 0.5, N * 0.60);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(1, 'rgba(255,255,255,0.16)');
  g.fillStyle = vg;
  g.fillRect(0, 0, N, N);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Mostradores diegéticos
// ═══════════════════════════════════════════════════════════════════════════

/** Cria um mostrador: canvas + textura + dirty flag por assinatura de valores. */
function makeGauge(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const gauge = { cv, g, tex, w, h, sig: '' };
  S.gauges.push(gauge);
  return gauge;
}

/** Texto com leve aberração cromática — o "sinal de CRT" sem custo de shader. */
function neonText(g, txt, x, y, font, color, align) {
  g.font = font;
  g.textAlign = align || 'left';
  g.textBaseline = 'alphabetic';
  g.globalAlpha = 0.30;
  g.fillStyle = '#ff3a2a';
  g.fillText(txt, x - 1.4, y);
  g.fillStyle = '#39e6ff';
  g.fillText(txt, x + 1.4, y);
  g.globalAlpha = 1;
  g.fillStyle = color;
  g.fillText(txt, x, y);
}

/** Fundo comum: vinheta, moldura hexagonal e cantos. */
function gaugeBase(g, w, h, tint) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(2,7,12,0.92)';
  g.fillRect(0, 0, w, h);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, 'rgba(20,60,80,0.30)');
  grd.addColorStop(1, 'rgba(4,10,18,0.0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = tint;
  g.lineWidth = 2;
  g.globalAlpha = 0.55;
  const m = 6, c = 14;
  g.beginPath();
  g.moveTo(m + c, m); g.lineTo(w - m - c, m); g.lineTo(w - m, m + c);
  g.lineTo(w - m, h - m - c); g.lineTo(w - m - c, h - m);
  g.lineTo(m + c, h - m); g.lineTo(m, h - m - c); g.lineTo(m, m + c);
  g.closePath(); g.stroke();
  g.globalAlpha = 1;
}

/** Scanlines + brilho de fósforo por cima de tudo. */
function gaugeScanlines(g, w, h) {
  g.globalAlpha = 0.16;
  g.fillStyle = '#000000';
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  g.globalAlpha = 1;
  // Reflexo do vidro do próprio mostrador.
  const gl = g.createLinearGradient(0, 0, w * 0.6, h);
  gl.addColorStop(0, 'rgba(255,255,255,0.055)');
  gl.addColorStop(0.45, 'rgba(255,255,255,0.0)');
  g.fillStyle = gl;
  g.fillRect(0, 0, w, h);
}

/** Barra segmentada — lê melhor que uma barra contínua a 40 cm do olho. */
function segBar(g, x, y, w, h, frac, color, dim) {
  const n = 18, gap = 2;
  const sw = (w - gap * (n - 1)) / n;
  const lit = Math.round(clamp(frac, 0, 1) * n);
  for (let i = 0; i < n; i++) {
    g.fillStyle = i < lit ? color : dim;
    g.fillRect(x + i * (sw + gap), y, sw, h);
  }
}

/** Mostrador central: velocidade, altitude e alvo travado. */
function drawCenter(gauge, d) {
  const { g, w, h } = gauge;
  gaugeBase(g, w, h, CY_DIM);

  neonText(g, 'VELOCIDADE', 22, 34, '600 17px monospace', CY_DIM);
  neonText(g, d.speedTxt, 22, 88, '300 60px monospace', CY);
  // A unidade fica numa coluna FIXA: alinhá-la ao fim do número faria o rótulo
  // dançar a cada dígito ganho ou perdido.
  neonText(g, d.speedUnit, 224, 88, '600 20px monospace', AM);

  neonText(g, 'ALTITUDE', 22, 128, '600 15px monospace', AM_DIM);
  neonText(g, d.altTxt, 22, 166, '300 34px monospace', AM);

  // Régua de arfagem: dá sensação de atitude sem custar geometria.
  const cx = w * 0.74, cy = 108, R = 62;
  g.strokeStyle = CY_DIM; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.72, Math.PI * 2.28); g.stroke();
  g.save();
  g.translate(cx, cy);
  g.rotate(clamp(d.pitch, -1.2, 1.2) * 0.6);
  g.strokeStyle = AM; g.lineWidth = 3;
  g.beginPath(); g.moveTo(-R * 0.62, 0); g.lineTo(-R * 0.2, 0); g.stroke();
  g.beginPath(); g.moveTo(R * 0.2, 0); g.lineTo(R * 0.62, 0); g.stroke();
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -8); g.stroke();
  g.restore();

  if (d.target) {
    g.strokeStyle = RED; g.lineWidth = 2;
    g.globalAlpha = 0.9;
    g.strokeRect(w - 172, h - 46, 150, 30);
    g.globalAlpha = 1;
    neonText(g, d.target, w - 166, h - 25, '600 16px monospace', RED);
  } else {
    neonText(g, 'SEM ALVO', w - 24, h - 25, '600 15px monospace', CY_DIM, 'right');
  }

  gaugeScanlines(g, w, h);
  gauge.tex.needsUpdate = true;
}

/** Mostrador esquerdo: escudo, casco e combustível de impulso. */
function drawLeft(gauge, d) {
  const { g, w, h } = gauge;
  gaugeBase(g, w, h, AM_DIM);

  neonText(g, 'ESCUDO', 20, 36, '600 15px monospace', CY_DIM);
  segBar(g, 20, 46, w - 40, 16, d.shield / 100, CY, 'rgba(95,224,255,0.13)');
  neonText(g, (d.shield | 0) + '%', w - 20, 36, '600 15px monospace', CY, 'right');

  neonText(g, 'CASCO', 20, 100, '600 15px monospace', AM_DIM);
  segBar(g, 20, 110, w - 40, 16, d.hull / 100, AM, 'rgba(255,179,71,0.13)');
  neonText(g, (d.hull | 0) + '%', w - 20, 100, '600 15px monospace', AM, 'right');

  neonText(g, 'IMPULSO', 20, 164, '600 15px monospace', AM_DIM);
  segBar(g, 20, 174, w - 40, 16, d.fuel / 100, d.fuel < 22 ? RED : AM, 'rgba(255,179,71,0.13)');
  neonText(g, (d.fuel | 0) + '%', w - 20, 164, '600 15px monospace', d.fuel < 22 ? RED : AM, 'right');

  neonText(g, d.mode, 20, h - 18, '600 14px monospace', CY_DIM);

  gaugeScanlines(g, w, h);
  gauge.tex.needsUpdate = true;
}

/** Mostrador direito: minimapa radial com blips e varredura. */
function drawRight(gauge, d) {
  const { g, w, h } = gauge;
  gaugeBase(g, w, h, CY_DIM);

  const cx = w * 0.5, cy = h * 0.52, R = Math.min(w, h) * 0.38;

  // Anéis de alcance.
  g.strokeStyle = CY_DIM; g.lineWidth = 1.5;
  for (let i = 1; i <= 3; i++) {
    g.beginPath(); g.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2); g.stroke();
  }
  // Cruz e marcas cardeais.
  g.beginPath();
  g.moveTo(cx - R, cy); g.lineTo(cx + R, cy);
  g.moveTo(cx, cy - R); g.lineTo(cx, cy + R);
  g.stroke();

  // Varredura: um setor que gira. A rotação vem de d.sweep (tempo quantizado),
  // por isso o mostrador precisa mesmo ser redesenhado periodicamente.
  const a0 = d.sweep;
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0, 'rgba(95,224,255,0.30)');
  grd.addColorStop(1, 'rgba(95,224,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(cx, cy);
  g.arc(cx, cy, R, a0 - 0.5, a0);
  g.closePath();
  g.fill();

  // Blips.
  for (let i = 0; i < d.blips.length; i += 3) {
    const bx = cx + d.blips[i] * R;
    const by = cy + d.blips[i + 1] * R;
    const kind = d.blips[i + 2];
    g.fillStyle = kind > 0.5 ? AM : CY;
    g.beginPath(); g.arc(bx, by, 4, 0, Math.PI * 2); g.fill();
  }

  // A própria nave.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(cx, cy - 8); g.lineTo(cx + 5, cy + 6); g.lineTo(cx, cy + 3); g.lineTo(cx - 5, cy + 6);
  g.closePath(); g.fill();

  neonText(g, 'RADAR', 16, 26, '600 14px monospace', CY_DIM);
  neonText(g, d.range, w - 16, 26, '600 14px monospace', AM, 'right');
  neonText(g, d.heading, cx, h - 12, '600 16px monospace', CY, 'center');

  gaugeScanlines(g, w, h);
  gauge.tex.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Construção do interior
// ═══════════════════════════════════════════════════════════════════════════

function build(ctx) {
  const rng = ctx.rng.derive('cockpit', 0);
  const root = new THREE.Group();
  root.name = 'cockpit';
  root.matrixAutoUpdate = true;

  const plate = makePlateTexture(rng);
  const grime = makeGrimeTexture(rng);
  S.disposables.push(plate, grime);

  // ── Materiais ─────────────────────────────────────────────────────────────
  const matFrame = new THREE.MeshStandardMaterial({
    map: plate, color: 0x8a95a3, metalness: 0.78, roughness: 0.44, envMapIntensity: 1.1,
  });
  const matPad = new THREE.MeshStandardMaterial({
    color: 0x14181f, metalness: 0.12, roughness: 0.94, envMapIntensity: 0.5,
  });
  const matTrim = new THREE.MeshStandardMaterial({
    color: 0x2a3038, metalness: 0.9, roughness: 0.26,
    emissive: new THREE.Color(0x2a1300), emissiveIntensity: 1.0, envMapIntensity: 1.4,
  });
  const matSuit = new THREE.MeshStandardMaterial({
    color: 0x2b3550, metalness: 0.18, roughness: 0.78, envMapIntensity: 0.7,
  });
  const matGlove = new THREE.MeshStandardMaterial({
    color: 0xb85f22, metalness: 0.25, roughness: 0.62, envMapIntensity: 0.8,
  });

  /**
   * Vidro: metal puro + rugosidade baixa = só reflexo especular do ambiente,
   * que é exatamente o comportamento de um canopy. A opacidade sai de um
   * Fresnel injetado por onBeforeCompile: de frente o vidro some (o jogador
   * precisa ver o planeta), de raspão ele acende com o céu refletido.
   */
  const matGlass = new THREE.MeshStandardMaterial({
    color: 0xbfe6ff, metalness: 1.0, roughness: 0.045,
    alphaMap: grime, transparent: true, opacity: 1.0,
    depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6,
  });
  const gu = {
    uGlassBase: { value: 0.045 },     // névoa mínima: o vidro nunca é invisível
    uGlassFresnel: { value: 0.62 },
    uGlassTint: { value: new THREE.Color(0x8fd8ff) },
  };
  matGlass.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassBase = gu.uGlassBase;
    sh.uniforms.uGlassFresnel = gu.uGlassFresnel;
    sh.uniforms.uGlassTint = gu.uGlassTint;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlassBase;\nuniform float uGlassFresnel;\nuniform vec3 uGlassTint;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // vViewPosition aponta do fragmento para a câmera (espaço de visão).
        float cosT = clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 );
        float fres = pow( 1.0 - cosT, 3.4 );
        // diffuseColor.a já traz a sujeira via alphaMap.
        diffuseColor.a = clamp( diffuseColor.a * 0.9 + uGlassBase + fres * uGlassFresnel, 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uGlassTint, 0.35 );`,
      );
  };
  // Chave de cache: sem isso o three reaproveita o programa de outro material.
  matGlass.customProgramCacheKey = () => 'aether-cockpit-glass';
  S.glassMat = matGlass;
  S.glassUniforms = gu;

  const mats = [matFrame, matPad, matTrim, matSuit, matGlove, matGlass];
  S.disposables.push(...mats);

  const add = (geo, mat, name, order2) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.frustumCulled = false;     // sempre a <2 m da câmera; testar é desperdício
    if (order2) m.renderOrder = order2;
    root.add(m);
    S.disposables.push(geo);
    return m;
  };

  // ── Canópia de vidro ──────────────────────────────────────────────────────
  const SX = 1.30, SY = 1.05, SZ = 1.75;
  const glassGeo = new THREE.SphereGeometry(1, 44, 30, 0, Math.PI * 2, 0, Math.PI * 0.68);
  glassGeo.scale(SX, SY, SZ);
  glassGeo.translate(0, -0.16, -0.28);
  add(glassGeo, matGlass, 'canopy_glass', 20);

  // ── Estrutura da canópia: assimétrica de propósito ────────────────────────
  // Um cockpit simétrico lê como render de CAD. O montante esquerdo é grosso
  // (estrutural), o direito é fino, e há uma diagonal só de um lado.
  const rib = (opts) => {
    const g = canopyRib({ sx: SX, sy: SY, sz: SZ, ...opts });
    g.translate(0, -0.16, -0.28);
    return g;
  };
  add(rib({ x: -0.60, tube: 0.052, arc: Math.PI * 1.06, rot: -Math.PI * 0.52 }), matFrame, 'pillar_L');
  add(rib({ x: 0.66, tube: 0.030, arc: Math.PI * 0.92, rot: -Math.PI * 0.46 }), matFrame, 'pillar_R');
  add(rib({ x: 0.02, tube: 0.026, arc: Math.PI * 0.55, rot: -Math.PI * 0.28 }), matFrame, 'spine');
  add(rib({ x: -1.02, tube: 0.040, arc: Math.PI * 1.1, rot: -Math.PI * 0.55 }), matFrame, 'pillar_LL');

  const ring1 = canopyRing({ theta: 1.98, tube: 0.042, sx: SX, sy: SY, sz: SZ });
  ring1.translate(0, -0.16, -0.28);
  add(ring1, matFrame, 'canopy_rim');
  const ring2 = canopyRing({ theta: 1.02, tube: 0.022, sx: SX, sy: SY, sz: SZ });
  ring2.translate(0, -0.16, -0.28);
  add(ring2, matFrame, 'canopy_band');

  // Diagonal só à direita — a quebra de simetria que vende "veículo real".
  const diag = new THREE.CylinderGeometry(0.022, 0.022, 1.5, 6);
  diag.rotateZ(-0.85);
  diag.rotateX(0.30);
  diag.translate(0.74, 0.28, -1.02);
  add(diag, matFrame, 'brace_R');

  // ── Painel inferior curvo ─────────────────────────────────────────────────
  const dashTop = curvedSlab(2.30, 0.09, 0.62, 0.94, -0.10, 0);
  dashTop.translate(0, -0.52, 0);
  add(dashTop, matPad, 'dash_top');

  const dashFace = curvedSlab(2.20, 0.52, 0.10, 0.84, -0.42, 0);
  dashFace.translate(0, -0.74, 0);
  add(dashFace, matFrame, 'dash_face');

  const dashLip = curvedSlab(2.34, 0.05, 0.09, 1.03, 0, 0);
  dashLip.translate(0, -0.50, 0);
  add(dashLip, matTrim, 'dash_lip');

  // Quilha central entre as pernas — referência de escala imediata.
  const keel = new THREE.BoxGeometry(0.30, 0.46, 0.62);
  keel.translate(0, -1.05, -0.42);
  add(keel, matPad, 'keel');

  // ── Consoles laterais ─────────────────────────────────────────────────────
  for (const s of [-1, 1]) {
    const con = new THREE.BoxGeometry(0.34, 0.16, 0.86);
    con.rotateZ(s * 0.22);
    con.translate(s * 0.70, -0.74, -0.24);
    add(con, matFrame, 'console_' + s);
    const conPad = new THREE.BoxGeometry(0.30, 0.05, 0.80);
    conPad.rotateZ(s * 0.22);
    conPad.translate(s * 0.70, -0.65, -0.24);
    add(conPad, matTrim, 'console_pad_' + s);
    // Anteparo lateral: fecha a visão periférica como um assento real.
    const wall = new THREE.BoxGeometry(0.08, 0.72, 1.05);
    wall.rotateZ(s * 0.10);
    wall.translate(s * 0.92, -0.86, 0.02);
    add(wall, matFrame, 'wall_' + s);
  }

  // ── Anteparo traseiro e piso ─────────────────────────────────────────────
  const bulk = new THREE.BoxGeometry(1.9, 1.5, 0.14);
  bulk.translate(0, -0.55, 0.62);
  add(bulk, matFrame, 'bulkhead');
  const floor = new THREE.BoxGeometry(1.6, 0.08, 1.6);
  floor.translate(0, -1.32, -0.20);
  add(floor, matPad, 'floor');

  // ── Mostradores diegéticos ────────────────────────────────────────────────
  const gC = makeGauge(512, 224);
  const gL = makeGauge(256, 256);
  const gR = makeGauge(256, 256);

  const screenMat = (tex) => new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const matSC = screenMat(gC.tex), matSL = screenMat(gL.tex), matSR = screenMat(gR.tex);
  S.disposables.push(matSC, matSL, matSR, gC.tex, gL.tex, gR.tex);

  const mountScreen = (mat, w, h, xOff, y, R, tilt) => {
    // Fundo fosco atrás da tela: o blending aditivo só lê bem sobre preto.
    const back = curvedPanel(w * 1.09, h * 1.16, R + 0.012, tilt, xOff);
    back.translate(0, y, 0);
    const bm = new THREE.Mesh(back, matPad);
    bm.frustumCulled = false;
    bm.renderOrder = 4;
    root.add(bm);
    S.disposables.push(back);

    const geo = curvedPanel(w, h, R, tilt, xOff);
    geo.translate(0, y, 0);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 5;
    root.add(m);
    S.disposables.push(geo);
    return m;
  };

  mountScreen(matSC, 0.46, 0.20, 0.00, -0.700, 0.80, -0.44);
  mountScreen(matSL, 0.20, 0.20, -0.42, -0.715, 0.80, -0.44);
  mountScreen(matSR, 0.20, 0.20, 0.42, -0.715, 0.80, -0.44);

  S.gaugeC = gC; S.gaugeL = gL; S.gaugeR = gR;

  // Fileiras de botões/indicadores: pontos de luz que dão vida ao painel.
  const btnGeo = new THREE.BoxGeometry(0.022, 0.008, 0.022);
  const btnMat = new THREE.MeshBasicMaterial({ color: 0x2a90b8, toneMapped: false });
  S.disposables.push(btnGeo, btnMat);
  const btns = new THREE.InstancedMesh(btnGeo, btnMat, 48);
  btns.frustumCulled = false;
  btns.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const _m4 = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _rot = new THREE.Quaternion();
  const _scl = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < 48; i++) {
    const row = i % 3, col = (i / 3) | 0;
    const ang = (-0.72 + col * 0.09) ;
    const rr = 0.83;
    _pos.set(Math.sin(ang) * rr, -0.545 - row * 0.020, -Math.cos(ang) * rr + row * 0.03);
    _eul.set(-0.35, ang, 0, 'YXZ');
    _rot.setFromEuler(_eul);
    _scl.setScalar(rng.range(0.75, 1.3));
    _m4.compose(_pos, _rot, _scl);
    btns.setMatrixAt(i, _m4);
  }
  btns.instanceMatrix.needsUpdate = true;
  root.add(btns);
  S.buttons = btns;

  // ── Manches ───────────────────────────────────────────────────────────────
  // Cada manche é um pivô; braço e mão são FILHOS do pivô, então acompanham o
  // movimento sem nenhuma cinemática inversa por frame.
  const stick = new THREE.Group();
  stick.position.set(0.30, -1.00, -0.34);
  root.add(stick);
  S.stick = stick;
  const shaft = new THREE.CapsuleGeometry(0.026, 0.20, 4, 8);
  shaft.translate(0, 0.13, 0);
  stick.add(new THREE.Mesh(shaft, matFrame));
  const grip = new THREE.CapsuleGeometry(0.045, 0.10, 4, 10);
  grip.rotateX(0.28);
  grip.translate(0, 0.29, 0.01);
  stick.add(new THREE.Mesh(grip, matPad));
  const gripTop = new THREE.SphereGeometry(0.030, 10, 8);
  gripTop.translate(0, 0.36, 0.02);
  stick.add(new THREE.Mesh(gripTop, matTrim));
  S.disposables.push(shaft, grip, gripTop);

  const lever = new THREE.Group();
  lever.position.set(-0.42, -0.96, -0.20);
  root.add(lever);
  S.throttleLever = lever;
  const lshaft = new THREE.CapsuleGeometry(0.020, 0.17, 4, 8);
  lshaft.translate(0, 0.11, 0);
  lever.add(new THREE.Mesh(lshaft, matFrame));
  const lknob = new THREE.BoxGeometry(0.075, 0.055, 0.11);
  lknob.translate(0, 0.23, 0);
  lever.add(new THREE.Mesh(lknob, matTrim));
  S.disposables.push(lshaft, lknob);

  // ── Braços e mãos do piloto ───────────────────────────────────────────────
  const forearm = (parent, sign) => {
    const arm = new THREE.Group();
    // Ombro fora do quadro, antebraço entrando na diagonal: é assim que a
    // silhueta lê como "meus braços" e não como "dois tubos".
    arm.position.set(sign * 0.13, -0.02, 0.02);
    parent.add(arm);
    const fa = new THREE.CapsuleGeometry(0.052, 0.40, 5, 10);
    fa.rotateX(Math.PI * 0.5);
    fa.translate(0, 0, 0.26);
    arm.add(new THREE.Mesh(fa, matSuit));
    const cuff = new THREE.CylinderGeometry(0.062, 0.058, 0.06, 10);
    cuff.rotateX(Math.PI * 0.5);
    cuff.translate(0, 0, 0.06);
    arm.add(new THREE.Mesh(cuff, matTrim));
    const hand = new THREE.BoxGeometry(0.085, 0.055, 0.11);
    hand.translate(0, -0.005, -0.03);
    arm.add(new THREE.Mesh(hand, matGlove));
    for (let f = 0; f < 3; f++) {
      const fin = new THREE.CapsuleGeometry(0.012, 0.045, 3, 6);
      fin.rotateZ(Math.PI * 0.5);
      fin.translate(sign * -0.035, -0.028, -0.055 + f * 0.028);
      arm.add(new THREE.Mesh(fin, matGlove));
      S.disposables.push(fin);
    }
    S.disposables.push(fa, cuff, hand);
    return arm;
  };
  S.armR = forearm(stick, 1);
  S.armR.position.set(0.02, 0.30, 0.03);
  S.armL = forearm(lever, -1);
  S.armL.position.set(-0.02, 0.22, 0.03);

  // ── Luzes próprias da overlayScene ───────────────────────────────────────
  const rig = new THREE.Group();
  rig.name = 'cockpit_lights';
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sun.position.set(0.3, 1, -0.6);
  rig.add(sun);
  rig.add(sun.target);
  const amb = new THREE.AmbientLight(0x2c3f5a, 0.9);
  rig.add(amb);
  // Preenchimento interno: âmbar no painel, ciano nas telas. Sem isso o metal
  // fica preto quando o sol está atrás e o cockpit vira uma silhueta chapada.
  const fillA = new THREE.PointLight(0xffa24a, 1.1, 2.6, 2);
  fillA.position.set(0, -0.62, -0.55);
  const fillC = new THREE.PointLight(0x63d8ff, 0.9, 2.2, 2);
  fillC.position.set(0.1, -0.55, -0.35);
  root.add(fillA, fillC);
  S.disposables.push(sun, amb, fillA, fillC);
  S.sun = sun;
  S.ambient = amb;
  S.lightRig = rig;

  return root;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Leitura do mundo para os mostradores
// ═══════════════════════════════════════════════════════════════════════════

/** Blips do radar, normalizados em [-1,1] no plano tangente. Sem alocação. */
const _blips = [];
const _bTmp = new THREE.Vector3();

function collectBlips(ctx, range) {
  _blips.length = 0;
  const src = readMarkerSources(ctx);
  if (!src) return _blips;

  const p = ctx.player.position;
  const up = ctx.player.up;
  // Base tangente: "frente" da nave projetada no plano do horizonte.
  _v1.set(0, 0, -1).applyQuaternion(ctx.player.quaternion);
  _v1.addScaledVector(up, -_v1.dot(up));
  if (_v1.lengthSq() < 1e-8) return _blips;
  _v1.normalize();
  _v2.crossVectors(_v1, up).normalize();      // "direita" no plano tangente

  for (let i = 0; i < src.length && _blips.length < 36; i++) {
    const m = src[i];
    const q = m && (m.position || m.pos || m.worldPos || m.center);
    if (!q || !Number.isFinite(q.x)) continue;
    _bTmp.set(q.x - p.x, q.y - p.y, q.z - p.z);
    const d = _bTmp.length();
    if (d > range || d < 1e-3) continue;
    const fx = _bTmp.dot(_v2) / range;
    const fz = -_bTmp.dot(_v1) / range;
    _blips.push(fx, fz, (m.kind === 'creature' || m.type === 'creature') ? 1 : 0);
  }
  return _blips;
}

/**
 * Fontes de marcadores. Os módulos de descoberta/multiferramenta ainda podem
 * não existir (ou expor nomes diferentes): tentamos as formas plausíveis e
 * degradamos para nada. Nunca lançamos daqui.
 */
const _mkTmp = [];
function readMarkerSources(ctx) {
  _mkTmp.length = 0;
  try {
    const d = ctx.discovery;
    const a = (d && typeof d.getMarkers === 'function' ? d.getMarkers() : null) || d?.markers || d?.nearby;
    if (Array.isArray(a)) for (let i = 0; i < a.length; i++) _mkTmp.push(a[i]);
    const t = ctx.multitool;
    const b = (t && typeof t.getMarkers === 'function' ? t.getMarkers() : null) || t?.markers || t?.scanned;
    if (Array.isArray(b)) for (let i = 0; i < b.length; i++) _mkTmp.push(b[i]);
  } catch (e) { /* módulo alheio a meio de um streaming — ignora */ }
  return _mkTmp;
}

function targetName(ctx) {
  try {
    const t = ctx.combat?.target || ctx.combat?.lockedTarget || ctx.combat?.lock;
    if (!t) return '';
    return String(t.name || t.id || 'CONTATO').slice(0, 14).toUpperCase();
  } catch (e) { return ''; }
}

/**
 * Combustível de impulso. O módulo `flight` não modela consumo e `inventory`
 * pode não existir; para o mostrador não ficar morto, simulamos aqui uma célula
 * que drena no impulso e recarrega em cruzeiro, e publicamos o valor para que o
 * HUD DOM mostre exatamente o mesmo número.
 */
function updateFuel(dt, ctx) {
  const ext = ctx.inventory?.pulseFuel ?? ctx.inventory?.fuel?.pulse;
  if (Number.isFinite(ext)) { S.pulseFuel = clamp(ext, 0, 100); return; }
  const boosting = ctx.input?.down?.('pulse') && (ctx.flight?.speed || 0) > 60;
  S.pulseFuel += boosting ? -13 * dt : 3.4 * dt;
  S.pulseFuel = clamp(S.pulseFuel, 0, 100);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ciclo de vida
// ═══════════════════════════════════════════════════════════════════════════

export async function init(ctx) {
  S.ctx = ctx;
  const root = build(ctx);
  S.root = root;
  root.visible = false;
  ctx.engine.overlayScene.add(root);
  ctx.engine.overlayScene.add(S.lightRig);
  S.ready = true;

  ctx.provide(id, {
    get root() { return S.root; },
    get visible() { return S.visible; },
    /** Combustível de impulso 0..100 — consumido pelo HUD DOM. */
    get pulseFuel() { return S.pulseFuel; },
    /**
     * OBRIGATÓRIO: o arnês de screenshots chama isto na pose "cockpit".
     * `true` força visível enquanto o jogador estiver na nave; `false` esconde
     * incondicionalmente (captura limpa); `null` devolve o controle automático.
     */
    setVisible(v) { S.forced = (v === null || v === undefined) ? null : !!v; },
    /** Intensidade do reflexo do ambiente no vidro (0 = vidro limpo e neutro). */
    setGlassReflection(k) { if (S.glassUniforms) S.glassUniforms.uGlassFresnel.value = clamp(k, 0, 1.5); },
    dispose() { dispose(ctx); },
  });
}

/** Primeira pessoa: o `flight` esconde o casco externo exatamente nesse caso. */
function isFirstPerson(ctx) {
  const ship = ctx.flight?.ship;
  if (!ship) return true;
  return ship.visible === false;
}

function computeVisible(ctx) {
  if (S.forced === false) return false;
  const inShip = (ctx.player?.mode || ctx.flight?.mode) === 'ship';
  if (!inShip) return false;
  if (S.forced === true) return true;
  return isFirstPerson(ctx);
}

export function lateUpdate(dt, ctx) {
  if (!S.ready) return;

  updateFuel(dt, ctx);

  const vis = computeVisible(ctx);
  if (vis !== S.visible) {
    S.visible = vis;
    S.root.visible = vis;
    S.lightRig.visible = vis;
  }
  if (!vis) { S.hasPrevVel = false; return; }

  const cam = ctx.engine.camera;
  const p = ctx.player;

  // ── Ambiente: o IBL do módulo `lighting` também acende o cockpit ─────────
  const env = ctx.engine.scene.environment;
  if (env !== S.envSeen) {
    S.envSeen = env;
    ctx.engine.overlayScene.environment = env;
    ctx.engine.overlayScene.environmentIntensity = 1.0;
    // Sem IBL o metal fica preto: compensamos com ambiente difuso forte.
    S.ambient.intensity = env ? 0.85 : 2.4;
  }

  // ── Sol na cena de overlay (direções de mundo valem aqui) ────────────────
  const sd = ctx.sky?.sunDirection;
  if (sd && Number.isFinite(sd.x)) {
    S.sun.position.set(sd.x * 8, sd.y * 8, sd.z * 8);
    const sc = ctx.sky?.sunColor;
    if (sc) S.sun.color.copy(sc);
    const si = ctx.sky?.sunIntensity;
    S.sun.intensity = Number.isFinite(si) ? clamp(si * 1.4, 0.4, 6) : 2.6;
  }

  // ── Inércia: o cockpit anda CONTRA a aceleração ─────────────────────────
  // O corpo do piloto tem massa; num arranque o assento vai à frente e o
  // interior "atrasa" alguns centímetros. Derivamos a aceleração do vetor de
  // velocidade em float64 (o escalar `flight.speed` sozinho não sabe curva).
  const v = p.velocity;
  if (dt > 1e-5 && S.hasPrevVel) {
    const inv = 1 / dt;
    _v3.set((v.x - S.prevVel.x) * inv, (v.y - S.prevVel.y) * inv, (v.z - S.prevVel.z) * inv);
    const a = _v3.length();
    if (a > 400) _v3.multiplyScalar(400 / a);   // teleporte/colisão não conta
    S.accWorld.lerp(_v3, smooth(dt, 6));
  }
  S.prevVel.x = v.x; S.prevVel.y = v.y; S.prevVel.z = v.z;
  S.hasPrevVel = true;

  _qInv.copy(cam.quaternion).invert();
  _v1.copy(S.accWorld).applyQuaternion(_qInv);          // aceleração em espaço de visão
  const k = 1 / 260;
  S.swayPos.set(
    clamp(-_v1.x * k, -0.05, 0.05),
    clamp(-_v1.y * k, -0.05, 0.05),
    clamp(-_v1.z * k, -0.06, 0.06),
  );
  S.swayRot.set(
    clamp(_v1.z * k * 0.9, -0.045, 0.045),   // frenagem levanta o nariz do painel
    clamp(-_v1.x * k * 0.7, -0.04, 0.04),
    clamp(_v1.x * k * 1.4, -0.07, 0.07),     // aceleração lateral rola o interior
  );

  // ── Tremor de reentrada (mesma fórmula do `flight`, para casar com a câmera) ──
  const dens = ctx.flight?.airDensity ?? 0;
  const spd = ctx.flight?.speed ?? 0;
  const reentry = clamp((dens * spd - 90) / 420, 0, 1);
  S.shake += (reentry - S.shake) * smooth(dt, 3.2);
  if (S.shake > 0.002) {
    const t = ctx.time.elapsed;
    const amp = S.shake * 0.010;
    S.swayPos.x += Math.sin(t * 61.7) * amp * 0.5;
    S.swayPos.y += Math.sin(t * 47.3) * amp;
    S.swayRot.z += Math.sin(t * 83.1) * amp * 1.6;
    S.swayRot.x += Math.sin(t * 71.9) * amp * 1.1;
  }

  // Respiração: 2 mm a 0,22 Hz. Imperceptível como movimento, decisivo para o
  // interior não parecer uma imagem congelada.
  const br = Math.sin(ctx.time.elapsed * 1.35) * 0.0022;
  S.swayPos.y += br;

  // ── Pose final do root ───────────────────────────────────────────────────
  _eul.set(S.swayRot.x, S.swayRot.y, S.swayRot.z, 'XYZ');
  _q1.setFromEuler(_eul);
  S.root.quaternion.copy(cam.quaternion).multiply(_q1);
  _v2.copy(S.swayPos).applyQuaternion(cam.quaternion);
  S.root.position.copy(_v2);

  // ── Controles respondendo ao input ───────────────────────────────────────
  const inp = ctx.input;
  const pitchIn = clamp(-(inp.axis('pitch') * 26), -1, 1);
  const rollIn = clamp(inp.axis('roll') + inp.axis('yaw') * 18, -1, 1);
  const thr = clamp(inp.axis('throttle'), -1, 1);
  const st = S.stick;
  st.rotation.x += (pitchIn * 0.22 - st.rotation.x) * smooth(dt, 9);
  st.rotation.z += (-rollIn * 0.26 - st.rotation.z) * smooth(dt, 9);
  const lv = S.throttleLever;
  lv.rotation.x += (-0.28 - thr * 0.42 - lv.rotation.x) * smooth(dt, 6);

  // ── Mostradores: dirty flag + teto de 8 Hz ───────────────────────────────
  S.gaugeClock += dt;
  if (S.gaugeClock >= 0.125) {
    S.gaugeClock = 0;
    refreshGauges(ctx);
  }

  if (ctx.debug.enabled) {
    ctx.debug.set('cockpit', S.visible ? 'visível' : 'oculto');
    ctx.debug.set('impulso', Math.round(S.pulseFuel) + '%');
  }
}

// ── Redesenho condicional dos mostradores ───────────────────────────────────
const _dC = { speedTxt: '', speedUnit: '', altTxt: '', pitch: 0, target: '' };
const _dL = { shield: 0, hull: 0, fuel: 0, mode: '' };
const _dR = { blips: _blips, sweep: 0, range: '', heading: '' };

function refreshGauges(ctx) {
  const p = ctx.player;
  const spd = ctx.flight?.speed ?? p.velocity.length();
  const alt = p.altitude;

  // ── central ──
  if (spd >= 1000) { _dC.speedTxt = (spd / 1000).toFixed(1); _dC.speedUnit = 'km/s'; }
  else { _dC.speedTxt = String(Math.round(spd)); _dC.speedUnit = 'm/s'; }
  _dC.altTxt = Number.isFinite(alt)
    ? (alt >= 10000 ? (alt / 1000).toFixed(1) + ' km' : Math.round(alt) + ' m')
    : 'ÓRBITA';
  _v1.set(0, 0, -1).applyQuaternion(p.quaternion);
  _dC.pitch = Math.asin(clamp(_v1.dot(p.up), -1, 1));
  _dC.target = targetName(ctx);
  const sigC = _dC.speedTxt + '|' + _dC.altTxt + '|' + (_dC.pitch * 12 | 0) + '|' + _dC.target;
  if (sigC !== S.gaugeC.sig) { S.gaugeC.sig = sigC; drawCenter(S.gaugeC, _dC); }

  // ── esquerdo ──
  _dL.shield = clamp(p.shield ?? 100, 0, 100);
  _dL.hull = clamp(p.health ?? 100, 0, 100);
  _dL.fuel = S.pulseFuel;
  _dL.mode = ctx.flight?.landed ? 'POUSADO' : (p.inAtmosphere ? 'ATMOSFERA' : 'VÁCUO');
  const sigL = (_dL.shield | 0) + '|' + (_dL.hull | 0) + '|' + (_dL.fuel | 0) + '|' + _dL.mode;
  if (sigL !== S.gaugeL.sig) { S.gaugeL.sig = sigL; drawLeft(S.gaugeL, _dL); }

  // ── direito (radar) ──
  const range = Number.isFinite(alt) && alt < 3000 ? 1500 : 12000;
  collectBlips(ctx, range);
  _dR.blips = _blips;
  _dR.sweep = (ctx.time.elapsed * 1.6) % (Math.PI * 2);
  _dR.range = range >= 1000 ? (range / 1000) + ' km' : range + ' m';
  _v1.set(0, 0, -1).applyQuaternion(p.quaternion);
  _v1.addScaledVector(p.up, -_v1.dot(p.up));
  _v2.set(0, 1, 0);
  if (Math.abs(_v2.dot(p.up)) > 0.97) _v2.set(1, 0, 0);
  _v2.addScaledVector(p.up, -_v2.dot(p.up));
  let hdg = 0;
  if (_v1.lengthSq() > 1e-8 && _v2.lengthSq() > 1e-8) {
    _v1.normalize(); _v2.normalize();
    _v3.crossVectors(_v2, p.up);
    hdg = (Math.atan2(_v1.dot(_v3), _v1.dot(_v2)) * 180 / Math.PI + 360) % 360;
  }
  _dR.heading = String(Math.round(hdg)).padStart(3, '0') + '°';
  // O sweep gira sempre: o radar é o único mostrador com dirty flag temporal.
  const sigR = _dR.heading + '|' + (_dR.sweep * 6 | 0) + '|' + _blips.length;
  if (sigR !== S.gaugeR.sig) { S.gaugeR.sig = sigR; drawRight(S.gaugeR, _dR); }
}

export function dispose(ctx) {
  S.ready = false;
  if (S.root) ctx.engine.overlayScene.remove(S.root);
  if (S.lightRig) ctx.engine.overlayScene.remove(S.lightRig);
  for (const d of S.disposables) { try { d.dispose?.(); } catch (e) { /* já liberado */ } }
  S.disposables.length = 0;
  S.gauges.length = 0;
  S.root = null;
}
