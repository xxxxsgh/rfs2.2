import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Nave procedural — "hauler/fighter" no espírito de No Man's Sky.
 *
 * POR QUÊ procedural: o repositório não carrega asset binário (regra 5 da
 * arquitetura) e a nave precisa variar por seed como o resto do universo. Toda
 * a silhueta, a pintura e os decalques saem de `rng`, então a mesma seed dá
 * sempre a mesma nave.
 *
 * POR QUÊ geometrias fundidas: o voo é o objeto mais próximo da câmera em quase
 * todo frame; fundir tudo por material deixa a nave inteira em ~5 draw calls,
 * o que importa quando o terreno já consome o orçamento.
 *
 * Convenções (o módulo de voo depende delas):
 *   - Nariz em -Z, teto em +Y, estibordo em +X (mesma convenção do three).
 *   - As âncoras são filhas DIRETAS de `root` e sem rotação herdada, para que
 *     `posMundo = navePos + ancora.position.applyQuaternion(naveQuat)` valha
 *     sem precisar atualizar matrizes.
 */

// ── Temporários de construção (nada disso roda por frame) ────────────────────
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();

/** Empilha uma geometria já posicionada. Converte para não indexada porque
 *  mergeGeometries exige homogeneidade e ExtrudeGeometry/Box divergem nisso. */
function put(list, geo, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy, sz);
  _m4.compose(_v, _q, _s);
  geo.applyMatrix4(_m4);
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  // A fusão só aceita o mesmo conjunto de atributos; UV2/tangentes atrapalham.
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  // Espelhamento (escala negativa) inverte o sentido dos triângulos e a peça
  // sumiria por back-face culling. Corrigimos trocando dois vértices por face.
  if (sx * sy * sz < 0) flipWinding(flat);
  list.push(flat);
  return flat;
}

function flipWinding(geo) {
  for (const attr of Object.values(geo.attributes)) {
    const a = attr.array, n = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      const b = (i + 1) * n, c = (i + 2) * n;
      for (let k = 0; k < n; k++) { const t = a[b + k]; a[b + k] = a[c + k]; a[c + k] = t; }
    }
    attr.needsUpdate = true;
  }
}

function mergeInto(list, material, name, castShadow = true) {
  if (list.length === 0) return null;
  const geo = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  list.length = 0;
  if (!geo) return null;
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = castShadow;
  return mesh;
}

/**
 * Asa trapezoidal com enflechamento e afilamento, feita deformando um cubo.
 * POR QUÊ não ExtrudeGeometry: o cubo deformado dá UVs previsíveis para os
 * decalques e uma contagem de vértices ridícula (24), que é o que queremos.
 */
function wingGeometry({ span, rootChord, tipChord, thick, sweep, tipDrop }) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i);            // -0.5 = raiz, +0.5 = ponta
    const t = sx + 0.5;                // 0..1 da raiz para a ponta
    const chord = rootChord + (tipChord - rootChord) * t;
    pos.setX(i, t * span);
    pos.setY(i, pos.getY(i) * thick * (1 - 0.45 * t) - tipDrop * t * t);
    pos.setZ(i, pos.getZ(i) * chord + sweep * t);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Pintura + linhas de painel + faixa + insígnia, tudo em canvas. */
function makeHullTextures(rng, colA, colB) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');

  const rgh = document.createElement('canvas');
  rgh.width = rgh.height = S;
  const gr = rgh.getContext('2d');

  g.fillStyle = colA;
  g.fillRect(0, 0, S, S);
  gr.fillStyle = '#8a8a8a';
  gr.fillRect(0, 0, S, S);

  // Painéis: retângulos com desvio sutil de brilho. Sem isso o casco lê como
  // plástico liso e a escala da nave some.
  const cells = 8;
  const step = S / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const k = rng.range(-0.09, 0.09);
      g.fillStyle = `rgba(255,255,255,${Math.max(0, k)})`;
      g.fillRect(x * step, y * step, step, step);
      g.fillStyle = `rgba(0,0,0,${Math.max(0, -k)})`;
      g.fillRect(x * step, y * step, step, step);
      const r = 110 + rng.range(-40, 55);
      gr.fillStyle = `rgb(${r | 0},${r | 0},${r | 0})`;
      gr.fillRect(x * step + 2, y * step + 2, step - 4, step - 4);
    }
  }
  // Costuras entre painéis.
  g.strokeStyle = 'rgba(0,0,0,0.42)';
  g.lineWidth = 1.5;
  for (let i = 1; i < cells; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, S); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(S, i * step); g.stroke();
  }

  // Faixa de pintura secundária — o traço que faz a nave parecer "de fábrica".
  const bandY = rng.range(0.30, 0.62) * S;
  const bandH = rng.range(0.06, 0.17) * S;
  g.fillStyle = colB;
  g.fillRect(0, bandY, S, bandH);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, bandY + bandH, S, 3);
  if (rng.chance(0.6)) {
    g.fillStyle = colB;
    g.fillRect(0, bandY - bandH * 0.55, S, bandH * 0.22);
  }

  // Rebites: pontos escuros ao longo das costuras.
  g.fillStyle = 'rgba(0,0,0,0.30)';
  for (let i = 0; i < 420; i++) {
    const x = rng.float() * S, y = rng.float() * S;
    g.fillRect(x, y, 2, 2);
  }

  // Insígnia: glifo determinístico (círculo + cunhas) — referência de escala.
  const ix = rng.range(0.15, 0.75) * S, iy = rng.range(0.05, 0.28) * S, ir = rng.range(24, 40);
  g.save();
  g.translate(ix, iy);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 4;
  g.beginPath(); g.arc(0, 0, ir, 0, Math.PI * 2); g.stroke();
  const wedges = rng.intRange(3, 6);
  g.fillStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < wedges; i++) {
    const a = (i / wedges) * Math.PI * 2 + rng.range(0, 0.4);
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, ir * 0.72, a, a + 0.42);
    g.closePath();
    g.fill();
  }
  g.restore();

  // Numeração de casco (o olho lê como escala real).
  g.fillStyle = 'rgba(15,18,24,0.8)';
  g.font = `bold ${Math.round(S * 0.075)}px monospace`;
  g.fillText(`${rng.intRange(10, 99)}-${rng.intRange(100, 999)}`, S * 0.06, S * 0.93);

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;

  const roughMap = new THREE.CanvasTexture(rgh);
  roughMap.wrapS = roughMap.wrapT = THREE.RepeatWrapping;

  return { map, roughMap };
}

/** Cor de pintura em HSL — saturada, no espírito NMS (ver §8.3 da arquitetura). */
function paintColor(rng, hueBase, spread, satMin, satMax, litMin, litMax) {
  const h = (hueBase + rng.range(-spread, spread) + 1) % 1;
  const s = rng.range(satMin, satMax);
  const l = rng.range(litMin, litMax);
  return new THREE.Color().setHSL(h, s, l);
}

/**
 * Constrói uma nave determinística.
 * @param {import('../core/rng.js').Rng} rng
 * @returns {{root: THREE.Group, anchors: Record<string, THREE.Object3D>,
 *            setThrust: (f:number)=>void, setGear: (o:number)=>void,
 *            dispose: ()=>void, params: object}}
 */
export function createShip(rng) {
  const R = rng;

  // ── Parâmetros da silhueta ────────────────────────────────────────────────
  const P = {
    bodyLen: R.range(8.4, 11.6),
    bodyR: R.range(1.02, 1.34),
    noseLen: R.range(2.6, 4.2),
    span: R.range(4.4, 6.6),          // meia-envergadura
    dihedral: R.range(0.10, 0.30),    // rad
    sweep: R.range(0.9, 2.4),
    pods: R.chance(0.82),
    fins: R.intRange(1, 2),
    engines: R.chance(0.55) ? 3 : 2,
  };

  const hueBase = R.float();
  const colA = paintColor(R, hueBase, 0.04, 0.35, 0.72, 0.34, 0.56);
  // Cor secundária complementar-ish: o contraste de matiz é o que separa uma
  // nave "de jogo" de uma maquete cinza.
  const colB = paintColor(R, hueBase + R.range(0.38, 0.58), 0.04, 0.55, 0.9, 0.42, 0.62);
  const accent = paintColor(R, hueBase + 0.5, 0.08, 0.8, 1.0, 0.55, 0.66);

  const { map, roughMap } = makeHullTextures(R, '#' + colA.getHexString(), '#' + colB.getHexString());

  // ── Materiais ────────────────────────────────────────────────────────────
  // metalness moderado de propósito: sem IBL garantido, metal puro fica preto.
  const matHull = new THREE.MeshStandardMaterial({
    map, roughnessMap: roughMap,
    color: 0xffffff, metalness: 0.52, roughness: 0.46, envMapIntensity: 1.15,
  });
  const matTrim = new THREE.MeshStandardMaterial({
    color: colB, metalness: 0.86, roughness: 0.3, envMapIntensity: 1.3,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: 0x22262e, metalness: 0.9, roughness: 0.42, envMapIntensity: 1.1,
  });
  const matGlass = new THREE.MeshStandardMaterial({
    color: 0x0b1a26, metalness: 0.72, roughness: 0.06, envMapIntensity: 2.2,
    transparent: true, opacity: 0.46, side: THREE.FrontSide,
  });
  // Emissivos HDR: `toneMapped=false` + componentes >1 fazem o bloom do postfx
  // sangrar como nos bocais do NMS.
  const matGlow = new THREE.MeshBasicMaterial({ toneMapped: false });
  matGlow.color.setRGB(accent.r * 2.2, accent.g * 2.2, accent.b * 2.6);
  const matFlame = new THREE.MeshBasicMaterial({
    toneMapped: false, transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  matFlame.color.setRGB(3.4, 1.5, 0.55);

  const hull = [], trim = [], dark = [], glass = [], glow = [];

  const HL = P.bodyLen * 0.5;

  // ── Fuselagem: cilindro octogonal achatado (leitura "hard surface") ───────
  put(hull, new THREE.CylinderGeometry(P.bodyR * 0.86, P.bodyR, P.bodyLen, 8, 1, false),
    0, 0, 0, Math.PI * 0.5, 0, 0, 1.18, 1, 0.74);

  // Nariz afilado + ponta.
  put(hull, new THREE.CylinderGeometry(P.bodyR * 0.30, P.bodyR * 0.86, P.noseLen, 8, 1, true),
    0, 0, -HL - P.noseLen * 0.5, Math.PI * 0.5, 0, 0, 1.18, 1, 0.74);
  put(trim, new THREE.SphereGeometry(P.bodyR * 0.32, 10, 6),
    0, 0, -HL - P.noseLen, 0, 0, 0, 1.2, 0.8, 1.4);

  // Espinha dorsal e quilha — quebram a silhueta cilíndrica.
  put(trim, new THREE.BoxGeometry(0.5, 0.42, P.bodyLen * 0.72),
    0, P.bodyR * 0.72, P.bodyLen * 0.06);
  put(dark, new THREE.BoxGeometry(0.9, 0.34, P.bodyLen * 0.6),
    0, -P.bodyR * 0.66, P.bodyLen * 0.02);

  // ── Cabine de vidro à frente ─────────────────────────────────────────────
  const cockZ = -HL + P.noseLen * 0.15 + 0.6;
  const cockY = P.bodyR * 0.52;
  put(glass, new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    0, cockY, cockZ, 0, 0, 0, 0.86, 0.72, 1.55);
  // Aro e travessa da canópia: sem moldura o vidro lê como bolha de plástico.
  put(trim, new THREE.TorusGeometry(1.0, 0.06, 6, 20),
    0, cockY + 0.02, cockZ, Math.PI * 0.5, 0, 0, 0.9, 1.6, 1);
  put(trim, new THREE.BoxGeometry(0.07, 0.5, 2.9), 0, cockY + 0.3, cockZ);

  // ── Pods laterais ────────────────────────────────────────────────────────
  const podX = P.bodyR * 2.15;
  const podLen = P.bodyLen * 0.62;
  if (P.pods) {
    for (const s of [-1, 1]) {
      put(hull, new THREE.CylinderGeometry(0.44, 0.5, podLen, 8),
        s * podX, -0.16, 0.5, Math.PI * 0.5, 0, 0, 1.1, 1, 0.9);
      put(trim, new THREE.ConeGeometry(0.46, 1.5, 8),
        s * podX, -0.16, 0.5 - podLen * 0.5 - 0.72, -Math.PI * 0.5, 0, 0);
      // Longarina que amarra o pod à fuselagem.
      put(dark, new THREE.BoxGeometry(podX - 0.3, 0.18, 1.5), s * podX * 0.5, -0.1, 0.6);
      // Faixa emissiva no pod — luz de navegação.
      put(glow, new THREE.BoxGeometry(0.06, 0.1, podLen * 0.55),
        s * (podX + 0.44), -0.16, 0.5);
    }
  }

  // ── Asas com diedro ──────────────────────────────────────────────────────
  const wingRootZ = P.bodyLen * 0.12;
  for (const s of [-1, 1]) {
    const geo = wingGeometry({
      span: P.span, rootChord: P.bodyLen * 0.42, tipChord: P.bodyLen * 0.18,
      thick: 0.34, sweep: P.sweep, tipDrop: 0.0,
    });
    // Espelhamento por escala em X; o diedro é uma rotação em Z.
    put(hull, geo, s * (P.pods ? podX + 0.3 : P.bodyR * 0.9), -0.05, wingRootZ,
      0, 0, s * P.dihedral, s, 1, 1);

    // Ponta da asa: pod de canhão + luz.
    const tipX = s * ((P.pods ? podX + 0.3 : P.bodyR * 0.9) + P.span);
    const tipY = -0.05 + Math.sin(P.dihedral) * P.span;
    put(trim, new THREE.CylinderGeometry(0.2, 0.24, 2.2, 8),
      tipX, tipY, wingRootZ + P.sweep - 0.2, Math.PI * 0.5, 0, 0);
    put(dark, new THREE.CylinderGeometry(0.09, 0.11, 1.6, 6),
      tipX, tipY, wingRootZ + P.sweep - 1.6, Math.PI * 0.5, 0, 0);
    put(glow, new THREE.SphereGeometry(0.09, 8, 6),
      tipX, tipY + 0.2, wingRootZ + P.sweep + 1.0);
  }

  // ── Derivas traseiras ────────────────────────────────────────────────────
  for (let i = 0; i < P.fins; i++) {
    const s = P.fins === 1 ? 0 : (i === 0 ? -1 : 1);
    put(hull, new THREE.BoxGeometry(0.16, 1.5, 2.1),
      s * P.bodyR * 0.8, P.bodyR * 0.95, HL - 1.2, 0, 0, s * 0.28);
  }

  // ── Bocais de motor ──────────────────────────────────────────────────────
  const nozzles = [];
  const nz = HL + 0.25;
  const engineXs = P.engines === 3
    ? [-(P.pods ? podX : P.bodyR * 1.2), 0, (P.pods ? podX : P.bodyR * 1.2)]
    : [-(P.pods ? podX : P.bodyR * 0.85), (P.pods ? podX : P.bodyR * 0.85)];
  for (const ex of engineXs) {
    const ey = Math.abs(ex) > 0.01 ? -0.16 : 0;
    put(dark, new THREE.CylinderGeometry(0.56, 0.42, 1.3, 10, 1, true),
      ex, ey, nz, Math.PI * 0.5, 0, 0);
    put(trim, new THREE.TorusGeometry(0.5, 0.07, 6, 14), ex, ey, nz + 0.62);
    nozzles.push({ x: ex, y: ey, z: nz });
  }

  // ── Fusões ───────────────────────────────────────────────────────────────
  const root = new THREE.Group();
  root.name = 'ship';
  const meshes = [];
  for (const [list, mat, name] of [
    [hull, matHull, 'ship_hull'], [trim, matTrim, 'ship_trim'],
    [dark, matDark, 'ship_dark'], [glass, matGlass, 'ship_glass'],
  ]) {
    const m = mergeInto(list, mat, name, name !== 'ship_glass');
    if (m) { root.add(m); meshes.push(m); }
  }
  const glowMesh = mergeInto(glow, matGlow, 'ship_glow', false);
  if (glowMesh) { root.add(glowMesh); meshes.push(glowMesh); }

  // ── Discos e plumas de motor (animados por setThrust) ────────────────────
  const coreGeo = new THREE.CircleGeometry(0.42, 14);
  const flameGeo = new THREE.ConeGeometry(0.36, 1, 10, 1, true);
  const cores = [], flames = [];
  for (const n of nozzles) {
    const core = new THREE.Mesh(coreGeo, matGlow.clone());
    core.position.set(n.x, n.y, n.z + 0.64);   // CircleGeometry já encara +Z (traseira)
    core.renderOrder = 2;
    root.add(core); cores.push(core);

    const flame = new THREE.Mesh(flameGeo, matFlame);
    flame.position.set(n.x, n.y, n.z + 1.2);
    flame.rotation.x = Math.PI * 0.5;  // cone (+Y) apontando para +Z, a ré
    flame.renderOrder = 3;
    flame.visible = false;
    root.add(flame); flames.push(flame);
  }

  // ── Trem de pouso ────────────────────────────────────────────────────────
  // Cada perna é um pivô: recolhida = girada para dentro da baia, aberta = 0.
  const legGeo = new THREE.CylinderGeometry(0.10, 0.12, 1.5, 6);
  const padGeo = new THREE.CylinderGeometry(0.34, 0.28, 0.14, 10);
  const legs = [];
  const legSpots = [
    { x: 0, z: -HL * 0.62, ax: 0.0 },
    { x: -P.bodyR * 1.25, z: HL * 0.42, ax: 0.0 },
    { x: P.bodyR * 1.25, z: HL * 0.42, ax: 0.0 },
  ];
  for (const spot of legSpots) {
    const pivot = new THREE.Group();
    pivot.position.set(spot.x, -P.bodyR * 0.6, spot.z);
    const strut = new THREE.Mesh(legGeo, matDark);
    strut.position.y = -0.75;
    strut.castShadow = true;
    const pad = new THREE.Mesh(padGeo, matTrim);
    pad.position.y = -1.5;
    pad.castShadow = true;
    pivot.add(strut, pad);
    pivot.rotation.x = Math.PI * 0.55;  // recolhido
    pivot.visible = false;
    root.add(pivot);
    legs.push(pivot);
  }

  // ── Âncoras (filhas diretas, sem rotação — ver cabeçalho) ────────────────
  const anchors = {};
  const mkAnchor = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    root.add(o);
    anchors[name] = o;
    return o;
  };
  mkAnchor('cockpitSeat', 0, cockY + 0.12, cockZ + 0.35);
  mkAnchor('thrusterL', engineXs[0], -0.16, nz + 1.0);
  mkAnchor('thrusterR', engineXs[engineXs.length - 1], -0.16, nz + 1.0);
  const gunX = (P.pods ? podX + 0.3 : P.bodyR * 0.9) + P.span;
  const gunY = -0.05 + Math.sin(P.dihedral) * P.span;
  mkAnchor('gunL', -gunX, gunY, wingRootZ + P.sweep - 2.4);
  mkAnchor('gunR', gunX, gunY, wingRootZ + P.sweep - 2.4);
  mkAnchor('landingGear', 0, -P.bodyR * 0.6 - 1.55, 0);

  // ── API animada (chamada por frame — nada de alocação aqui) ──────────────
  let thrust = 0, gear = 0;

  function setThrust(f) {
    thrust = f < 0 ? 0 : f > 1 ? 1 : f;
    const k = 0.9 + thrust * 3.2;
    for (let i = 0; i < cores.length; i++) {
      cores[i].material.color.setRGB(accent.r * k, accent.g * k * 0.9, accent.b * k * 1.15);
      cores[i].scale.setScalar(0.85 + thrust * 0.35);
    }
    const on = thrust > 0.02;
    for (let i = 0; i < flames.length; i++) {
      const fl = flames[i];
      fl.visible = on;
      if (!on) continue;
      fl.scale.set(0.8 + thrust * 0.5, 0.6 + thrust * 5.4, 0.8 + thrust * 0.5);
      fl.position.z = nozzles[i].z + 0.7 + (0.6 + thrust * 5.4) * 0.5;
    }
    matFlame.opacity = 0.25 + thrust * 0.6;
  }

  function setGear(open01) {
    gear = open01 < 0 ? 0 : open01 > 1 ? 1 : open01;
    const vis = gear > 0.004;
    const ang = Math.PI * 0.55 * (1 - gear);
    for (let i = 0; i < legs.length; i++) {
      legs[i].visible = vis;
      legs[i].rotation.x = ang;
    }
  }

  function dispose() {
    for (const m of meshes) { m.geometry.dispose(); m.material.dispose(); }
    for (const c of cores) c.material.dispose();
    coreGeo.dispose(); flameGeo.dispose(); legGeo.dispose(); padGeo.dispose();
    matFlame.dispose(); map.dispose(); roughMap.dispose();
  }

  setThrust(0);
  setGear(0);

  return {
    root, anchors, setThrust, setGear, dispose,
    params: P,
    colors: { primary: colA, secondary: colB, accent },
    /** Altura útil do centro da nave até a base do trem de pouso. */
    gearClearance: P.bodyR * 0.6 + 1.62,
    /** Raio grosseiro para testes de colisão e enquadramento de câmera. */
    boundingRadius: Math.max(P.bodyLen * 0.6 + P.noseLen, P.span + 1.5),
  };
}
