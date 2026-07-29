import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { clamp, saturate, lerp, smoothstep } from '../noise/noise.js';
import { speciesSteps, createSkinnedMesh, disposeSpecies, SSS_UNIFORMS } from './creature-gen.js';

/**
 * FAUNA — animação procedural e IA.
 *
 * ── Por que nada aqui é um clipe gravado ─────────────────────────────────────
 * Um ciclo de caminhada em loop denuncia o protótipo em dois segundos: os pés
 * patinam, o bicho não reage ao relevo e todos os membros do rebanho andam em
 * sincronia perfeita. Aqui a locomoção é resolvida na ordem inversa, como no
 * animal real:
 *   1. a IA decide para onde ir e a que velocidade;
 *   2. um GERADOR DE MARCHA converte velocidade em fases por perna;
 *   3. cada pé é PLANTADO num ponto do terreno (em Vec3d, mundo real) e fica lá
 *      enquanto estiver em apoio — é matematicamente impossível patinar;
 *   4. IK de duas juntas dobra o membro para alcançar o pé;
 *   5. o corpo então RESPONDE aos pés: sobe/desce, rola para o lado do apoio e
 *      inclina conforme a diferença de altura entre patas dianteiras e traseiras.
 * O passo 5 é o que faz o bicho "pesar". Sem ele a criatura flutua.
 *
 * ── Precisão ─────────────────────────────────────────────────────────────────
 * Posição da criatura e pontos de apoio dos pés vivem em Vec3d (float64). Os
 * Object3D só recebem o delta para a origem flutuante, recalculado em
 * `lateUpdate` (depois de `frame.update()`), o que também cobre o rebase.
 *
 * ── Custo ────────────────────────────────────────────────────────────────────
 * SkinnedMesh é caro. Teto duro em `ctx.quality.maxCreatures` (24), LOD sem
 * skinning além de 80 m, imposter (sprite) além de 250 m, despawn em 420 m.
 * Todas as instâncias são pooladas por espécie: spawn/despawn não aloca.
 */

export const id = 'fauna';
export const order = 51;

// ── Distâncias de LOD e streaming (metros) ──────────────────────────────────
const LOD_SKIN = 80;
const LOD_STATIC = 250;
const DESPAWN = 420;
const SPAWN_MIN = 62;
const SPAWN_MAX = 155;
const MAX_HARD = 24;          // teto absoluto de SkinnedMesh ativos

const AXIS_Y = new THREE.Vector3(0, 1, 0);

// ── Temporários de módulo: zero alocação nos caminhos quentes ───────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _target = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _lower = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _footFwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _mRot = new THREE.Matrix4();
const _mBasis = new THREE.Matrix4();
const _p1 = new Vec3d();
const _p2 = new Vec3d();
const _probe = new Vec3d();

// ── Estado do módulo ────────────────────────────────────────────────────────
let ctxRef = null;
let group = null;
let enabled = true;
let species = [];
let pending = [];             // geradores de espécie ainda em construção
let creatures = [];           // instâncias ativas
let herds = [];
let spawnRng = null;
let currentBodyId = null;
let spawnCooldown = 0;
let totalInstances = 0;
let discoveredCount = 0;
const nearOut = [];

// ────────────────────────────────────────────────────────────────────────────
// Utilidades de superfície
// ────────────────────────────────────────────────────────────────────────────

/** Direção unitária do centro do planeta até `pos`; devolve a distância. */
function surfaceDir(pos, body, out) {
  out.set(pos.x - body.center.x, pos.y - body.center.y, pos.z - body.center.z);
  const l = out.length() || 1;
  out.multiplyScalar(1 / l);
  return l;
}

/**
 * Raio absoluto do terreno numa direção. Prefere `sampleHeight` (barato e
 * exato); cai para `altitudeAt` sondando de cima quando o planeta só expõe
 * essa via; por último, nível do mar.
 */
function groundRadius(ctx, body, dirUnit) {
  const h = ctx.planet && ctx.planet.sampleHeight ? ctx.planet.sampleHeight(dirUnit) : undefined;
  if (Number.isFinite(h)) return body.radius + h;
  if (ctx.planet && ctx.planet.altitudeAt) {
    const R = body.radius + 4000;
    _probe.set(body.center.x + dirUnit.x * R, body.center.y + dirUnit.y * R, body.center.z + dirUnit.z * R);
    const a = ctx.planet.altitudeAt(_probe);
    if (Number.isFinite(a)) return R - a;
  }
  return ctx.planet && Number.isFinite(ctx.planet.seaLevelRadius) ? ctx.planet.seaLevelRadius : body.radius;
}

/** Base tangente estável em torno de `up` (sem alocar). */
function tangentBasis(up, outRight, outFwd) {
  const ref = Math.abs(up.y) > 0.92 ? 1 : 0;
  _v3.set(ref, 1 - ref, 0);
  outRight.crossVectors(_v3, up).normalize();
  outFwd.crossVectors(up, outRight).normalize();
}

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida
// ────────────────────────────────────────────────────────────────────────────

export async function init(ctx) {
  ctxRef = ctx;
  group = new THREE.Group();
  group.name = 'fauna';
  // O grupo fica cravado na origem flutuante; cada criatura recebe o delta.
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  ctx.engine.scene.add(group);

  spawnRng = ctx.rng.derive('fauna-spawn', 0);

  ctx.events.on('combat:hit', onCombatHit);
  ctx.events.on('creature:feed', onFeed);
  ctx.events.on('scan:ping', onScanPing);
  // Depois de um rebase as posições relativas viram lixo por um frame inteiro;
  // reposicionar na hora evita o "pulo" visível a cada 2 km percorridos.
  ctx.events.on('frame:rebase', () => { placeAll(); });

  ctx.provide(id, api);
  ctx.progress?.(0.51, 'fauna pronta');
}

export function dispose(ctx) {
  clearPlanet();
  if (group && group.parent) group.parent.remove(group);
  group = null;
  ctxRef = null;
}

// ────────────────────────────────────────────────────────────────────────────
// Espécies do planeta atual
// ────────────────────────────────────────────────────────────────────────────

function clearPlanet() {
  for (let i = creatures.length - 1; i >= 0; i--) retire(creatures[i], true);
  creatures.length = 0;
  herds.length = 0;
  for (const sp of species) {
    if (sp._pool) {
      for (const inst of sp._pool) destroyInstance(inst);
      sp._pool.length = 0;
    }
    disposeSpecies(sp);
  }
  species = [];
  pending = [];
  totalInstances = 0;
}

/** Prepara a lista de espécies do corpo ativo — determinística pela seed dele. */
function ensureSpecies(ctx) {
  const body = ctx.planet && ctx.planet.current;
  const bodyId = body ? (body.id || body.name || 'body') : null;
  if (bodyId === currentBodyId) return;
  clearPlanet();
  currentBodyId = bodyId;
  if (!body) return;

  const biome = body.biome;
  const fauna = (biome && biome.fauna) || null;
  if (!fauna || !(fauna.count > 0) || !(fauna.density > 0)) return;

  const seed = Number.isFinite(body.seed) ? body.seed : 0;
  const base = ctx.rng.derive('fauna:' + bodyId, seed);
  spawnRng = base.derive('spawn', 0);

  const n = clamp(Math.round(fauna.count), 1, 8);
  for (let i = 0; i < n; i++) {
    // `sizeT` estratificado: garante bichinho de bolso E colosso no mesmo
    // planeta, que é o que dá escala legível ao ambiente.
    const sizeT = (i + 0.5) / n;
    const rng = base.derive('species', i);
    pending.push({ it: speciesSteps(rng, biome, { sizeT, id: `${bodyId}-sp${i}` }), index: i });
  }
}

/** Avança a geração de espécies em fatias que cabem no orçamento do frame. */
function pumpSpecies(ctx) {
  while (pending.length && ctx.budget.canWork() && ctx.budget.remainingMs() > 1.2) {
    const job = pending[0];
    let r;
    try { r = job.it.next(); }
    catch (e) { pending.shift(); ctx.debug.set('fauna.err', String(e && e.message)); continue; }
    if (r.done) {
      pending.shift();
      const sp = r.value;
      if (sp) {
        sp._pool = [];
        sp.discovered = false;
        // O módulo de iluminação pode querer injetar IBL/CSM nos materiais.
        ctx.lighting?.registerMaterial?.(sp.material, { kind: 'fauna' });
        species.push(sp);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Instâncias (pooling total)
// ────────────────────────────────────────────────────────────────────────────

function createInstance(ctx, sp) {
  const { mesh, bones, skeleton } = createSkinnedMesh(sp);
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = true;
  holder.add(mesh);

  const staticMesh = new THREE.Mesh(sp.geometryLod, sp.material);
  staticMesh.visible = false;
  staticMesh.frustumCulled = false;
  holder.add(staticMesh);

  const sprite = new THREE.Sprite(sp.imposterMaterial);
  sprite.visible = false;
  holder.add(sprite);

  const shadows = !!(ctx.quality && ctx.quality.shadows);
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  staticMesh.castShadow = shadows;
  staticMesh.receiveShadow = shadows;

  const legs = [];
  for (let i = 0; i < sp.rig.legs.length; i++) {
    legs.push({
      footWorld: new Vec3d(), fromWorld: new Vec3d(), toWorld: new Vec3d(),
      stance: true, lift: 0, height: 0,
    });
  }

  const c = {
    sp, holder, mesh, staticMesh, sprite, bones, skeleton, legs,
    pos: new Vec3d(), vel: new Vec3d(),
    up: new THREE.Vector3(0, 1, 0),
    fwd: new THREE.Vector3(0, 0, 1),
    quat: new THREE.Quaternion(),
    lookDir: new THREE.Vector3(0, 0, 1),
    lookTarget: new Vec3d(),
    hasLook: false,
    speed: 0, desiredSpeed: 0,
    desiredDir: new THREE.Vector3(0, 0, 1),
    state: 'wander', stateT: 0,
    gaitPhase: 0, wingPhase: 0, breathe: 0,
    grow: 0, scale: 1, groundR: 0, altitude: 0,
    health: sp.traits.health, alive: true, tame: false,
    herd: null, flankSign: 1, dist: 1e9, lod: 0,
    active: false, retiring: false, cooldown: 0,
    bodyBob: 0, bodyRoll: 0, bodyPitch: 0, lastSpeed: 0,
    voiceT: 2 + spawnRng.float() * 6,
    climb: 0, turnSignal: 0, deathRoll: 0, grazing: false,
    cruise: lerp(22, 95, spawnRng.float()),
  };
  mesh.userData.creature = c;
  staticMesh.userData.creature = c;
  totalInstances++;
  return c;
}

function destroyInstance(inst) {
  if (inst.holder.parent) inst.holder.parent.remove(inst.holder);
  inst.skeleton?.dispose?.();
  totalInstances--;
}

function acquire(ctx, sp) {
  let inst = sp._pool.pop();
  if (!inst) {
    if (totalInstances >= maxActive(ctx)) return null;
    inst = createInstance(ctx, sp);
  }
  inst.active = true;
  inst.retiring = false;
  inst.alive = true;
  inst.tame = false;
  inst.grow = 0;
  inst.health = sp.traits.health;
  inst.speed = 0;
  inst.gaitPhase = spawnRng.float();
  inst.wingPhase = spawnRng.float();
  inst.state = 'wander';
  inst.stateT = spawnRng.range(0, 3);
  inst.hasLook = false;
  group.add(inst.holder);
  return inst;
}

function retire(c, immediate) {
  if (!c.active) return;
  if (!immediate && !c.retiring) { c.retiring = true; return; }
  c.active = false;
  c.retiring = false;
  if (c.herd) {
    const i = c.herd.members.indexOf(c);
    if (i >= 0) c.herd.members.splice(i, 1);
  }
  c.herd = null;
  if (c.holder.parent) c.holder.parent.remove(c.holder);
  c.sp._pool.push(c);
  const k = creatures.indexOf(c);
  if (k >= 0) creatures.splice(k, 1);
}

function maxActive(ctx) {
  return Math.min(MAX_HARD, Math.max(0, (ctx.quality && ctx.quality.maxCreatures) || 0));
}

// ────────────────────────────────────────────────────────────────────────────
// Spawn
// ────────────────────────────────────────────────────────────────────────────

/**
 * Escolhe um ponto de nascimento fora do campo de visão e a mais de ~60 m.
 * Ver um bicho "pipocar" é o defeito que mais denuncia streaming ingênuo.
 */
function pickSpawnPoint(ctx, body, out) {
  const p = ctx.player.position;
  surfaceDir(p, body, _up);
  tangentBasis(_up, _right, _v2);
  _camFwd.set(0, 0, -1).applyQuaternion(ctx.engine.camera.quaternion);

  for (let tries = 0; tries < 10; tries++) {
    const a = spawnRng.float() * Math.PI * 2;
    const dist = lerp(SPAWN_MIN, SPAWN_MAX, spawnRng.float());
    _v1.copy(_right).multiplyScalar(Math.cos(a)).addScaledVector(_v2, Math.sin(a));
    // Atrás da câmera ou bem longe: nos dois casos o surgimento é invisível.
    const facing = _v1.dot(_camFwd);
    if (facing > 0.25 && dist < 110 && tries < 8) continue;
    out.set(p.x + _v1.x * dist, p.y + _v1.y * dist, p.z + _v1.z * dist);
    surfaceDir(out, body, _v3);
    const gr = groundRadius(ctx, body, _v3);
    const sea = ctx.planet && Number.isFinite(ctx.planet.seaLevelRadius) ? ctx.planet.seaLevelRadius : -Infinity;
    if (gr <= sea + 0.5) continue;                      // nada de rebanho no fundo do mar
    out.set(body.center.x + _v3.x * gr, body.center.y + _v3.y * gr, body.center.z + _v3.z * gr);
    return true;
  }
  return false;
}

function spawnHerd(ctx, body) {
  if (!species.length) return;
  // Espécies mais densas no bioma aparecem mais.
  const sp = species[spawnRng.int(species.length)];
  if (!pickSpawnPoint(ctx, body, _p1)) return;
  const herd = {
    sp, members: [], center: _p1.clone(), target: _p1.clone(),
    retarget: 0, alert: 0,
  };
  herds.push(herd);
  herd.pending = clamp(Math.round(sp.traits.herdSize * lerp(0.6, 1.2, spawnRng.float())), 1, 9);
}

/** Materializa no máximo uma criatura por frame — o custo é a SkinnedMesh. */
function pumpHerdSpawn(ctx, body) {
  for (let h = 0; h < herds.length; h++) {
    const herd = herds[h];
    if (!herd.pending) continue;
    if (creatures.length >= maxActive(ctx)) return;
    const c = acquire(ctx, herd.sp);
    if (!c) { herd.pending = 0; return; }
    herd.pending--;
    // Espalha em torno do centro do rebanho.
    surfaceDir(herd.center, body, _up);
    tangentBasis(_up, _right, _v2);
    const a = spawnRng.float() * Math.PI * 2;
    const r = spawnRng.range(1.5, 4.5) * Math.max(1, herd.sp.traits.sizeM);
    _p2.set(
      herd.center.x + (_right.x * Math.cos(a) + _v2.x * Math.sin(a)) * r,
      herd.center.y + (_right.y * Math.cos(a) + _v2.y * Math.sin(a)) * r,
      herd.center.z + (_right.z * Math.cos(a) + _v2.z * Math.sin(a)) * r,
    );
    placeOnGround(ctx, body, c, _p2);
    c.scale = lerp(0.78, 1.22, spawnRng.float());
    c.flankSign = spawnRng.chance(0.5) ? 1 : -1;
    c.herd = herd;
    herd.members.push(c);
    creatures.push(c);
    // Alinha a frente com uma tangente qualquer e planta os pés no lugar.
    tangentBasis(c.up, _right, c.fwd);
    resetFeet(ctx, body, c);
    placeOne(c);
    return;
  }
}

function placeOnGround(ctx, body, c, worldPos) {
  surfaceDir(worldPos, body, _v3);
  const gr = groundRadius(ctx, body, _v3);
  c.groundR = gr;
  const r = c.sp.traits.flying ? gr + c.cruise : gr;
  c.pos.set(body.center.x + _v3.x * r, body.center.y + _v3.y * r, body.center.z + _v3.z * r);
  c.up.copy(_v3);
  c.altitude = r - gr;
}

/**
 * Reancora todos os pés sob os quadris, na pose de repouso.
 * Obrigatório sempre que a criatura andou SEM ser posada (LOD 1/2), depois de
 * um teletransporte ou logo após o spawn: senão a IK tenta alcançar um ponto
 * plantado dezenas de metros atrás e a perna vira um arame esticado.
 */
function resetFeet(ctx, body, c) {
  if (c.sp.traits.flying) return;   // voador não tem contato com o chão
  const s = c.scale * Math.max(0.001, c.grow);
  const rig = c.sp.rig;
  _right.crossVectors(c.up, c.fwd).normalize();
  for (let i = 0; i < rig.legs.length; i++) {
    const L = rig.legs[i], st = c.legs[i];
    st.toWorld.set(
      c.pos.x + _right.x * L.restFoot.x * s + c.fwd.x * L.restFoot.z * s,
      c.pos.y + _right.y * L.restFoot.x * s + c.fwd.y * L.restFoot.z * s,
      c.pos.z + _right.z * L.restFoot.x * s + c.fwd.z * L.restFoot.z * s,
    );
    snapToGround(ctx, body, st.toWorld);
    // O alvo da IK é o TORNOZELO, não o dedo: num bicho digitígrado ele fica
    // acima do solo. Ignorar isso força a perna a esticar demais o tempo todo.
    st.toWorld.addScaled(c.up, L.restFoot.y * s);
    st.footWorld.copy(st.toWorld);
    st.fromWorld.copy(st.toWorld);
    st.stance = true;
    st.lift = 0;
  }
  c.feetStale = false;
}

function snapToGround(ctx, body, v) {
  surfaceDir(v, body, _v1);
  const gr = groundRadius(ctx, body, _v1);
  v.set(body.center.x + _v1.x * gr, body.center.y + _v1.y * gr, body.center.z + _v1.z * gr);
  return gr;
}

// ────────────────────────────────────────────────────────────────────────────
// Update — IA e integração (mundo em float64)
// ────────────────────────────────────────────────────────────────────────────

export function update(dt, ctx) {
  if (!group) return;
  ensureSpecies(ctx);
  pumpSpecies(ctx);

  const body = ctx.planet && ctx.planet.current;
  const active = enabled && !!body && species.length > 0 &&
    ctx.player.altitude < 600 && Number.isFinite(ctx.player.altitude);

  if (!active) {
    for (let i = creatures.length - 1; i >= 0; i--) fadeOut(creatures[i], dt);
    ctx.debug.set('fauna', `${creatures.length} ativos · ${species.length} spp · inativo`);
    return;
  }

  // ── Streaming: rebanhos entram e saem ─────────────────────────────────────
  spawnCooldown -= dt;
  const cap = maxActive(ctx);
  if (spawnCooldown <= 0 && creatures.length < cap * 0.8 && herds.length < 4) {
    spawnCooldown = lerp(2.5, 7, spawnRng.float());
    spawnHerd(ctx, body);
  }
  if (ctx.budget.canWork()) pumpHerdSpawn(ctx, body);

  for (let h = herds.length - 1; h >= 0; h--) {
    const herd = herds[h];
    if (!herd.members.length && !herd.pending) { herds.splice(h, 1); continue; }
    updateHerdCenter(herd);
    herd.retarget -= dt;
    if (herd.retarget <= 0) {
      herd.retarget = lerp(6, 16, spawnRng.float());
      pickHerdTarget(ctx, body, herd);
    }
  }

  // ── Criaturas ─────────────────────────────────────────────────────────────
  const px = ctx.player.position;
  for (let i = creatures.length - 1; i >= 0; i--) {
    const c = creatures[i];
    c.dist = Math.sqrt(c.pos.distanceToSq(px));
    if (c.dist > DESPAWN || !c.herd) { fadeOut(c, dt); continue; }
    if (c.retiring) { fadeOut(c, dt); continue; }
    c.grow = Math.min(1, c.grow + dt * 1.8);
    c.lod = c.dist < LOD_SKIN ? 0 : c.dist < LOD_STATIC ? 1 : 2;
    think(c, dt, ctx, body);
    integrate(c, dt, ctx, body);
    voice(c, dt, ctx);
  }

  ctx.debug.set('fauna', `${creatures.length}/${cap} ativos · ${species.length} spp · ${herds.length} bandos · ${discoveredCount} desc.`);
}

/** Encolhe e devolve ao pool — despawn suave, sem estalo. */
function fadeOut(c, dt) {
  c.retiring = true;
  c.grow -= dt * 2.2;
  if (c.grow <= 0.02) retire(c, true);
}

function updateHerdCenter(herd) {
  const n = herd.members.length;
  if (!n) return;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) { x += herd.members[i].pos.x; y += herd.members[i].pos.y; z += herd.members[i].pos.z; }
  herd.center.set(x / n, y / n, z / n);
}

function pickHerdTarget(ctx, body, herd) {
  // Herbívoro procura flora de verdade; se o módulo não existe, vagueia.
  const food = nearestFlora(ctx, herd.center, 70);
  if (food && herd.sp.traits.diet !== 'carnivore') {
    herd.target.copy(food);
    return;
  }
  surfaceDir(herd.center, body, _up);
  tangentBasis(_up, _right, _v2);
  const a = spawnRng.float() * Math.PI * 2;
  const r = spawnRng.range(12, 55);
  herd.target.set(
    herd.center.x + (_right.x * Math.cos(a) + _v2.x * Math.sin(a)) * r,
    herd.center.y + (_right.y * Math.cos(a) + _v2.y * Math.sin(a)) * r,
    herd.center.z + (_right.z * Math.cos(a) + _v2.z * Math.sin(a)) * r,
  );
}

const _floraTmp = new Vec3d();
/** Consulta a flora de forma totalmente defensiva — o módulo pode não existir. */
function nearestFlora(ctx, pos, radius) {
  const f = ctx.flora;
  if (!f || typeof f.instancesNear !== 'function') return null;
  let list = null;
  try { list = f.instancesNear(pos, radius); } catch (e) { return null; }
  if (!list || !list.length) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const p = it && (it.x !== undefined ? it : (it.position || it.pos || it.worldPos));
    if (!p || p.x === undefined) continue;
    const dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best) return null;
  _floraTmp.set(best.x, best.y, best.z);
  return _floraTmp;
}

// ── Máquina de comportamento ────────────────────────────────────────────────

function think(c, dt, ctx, body) {
  const tr = c.sp.traits;
  const herd = c.herd;
  c.stateT -= dt;

  const px = ctx.player.position;
  const dPlayer = c.dist;
  // O raio de alerta é o temperamento do BIOMA em forma jogável: num mundo
  // dócil dá para chegar perto, num mundo arisco o rebanho some antes de você
  // enquadrar a câmera.
  const alertR = tr.alertRadius * (tr.temperament === 'skittish' ? 1.35 : tr.temperament === 'docile' ? 0.65 : 1);
  const threatened = dPlayer < alertR;

  // Prioridades duras primeiro: morrer, ser domesticado, fugir, caçar.
  if (!c.alive) {
    c.state = 'dying';
    c.deathRoll = Math.min(1.45, c.deathRoll + dt * 2.6);
  } else if (c.tame) {
    c.state = 'follow';
  } else if (tr.diet === 'herbivore' && threatened) {
    if (c.state !== 'flee') {
      c.state = 'flee';
      c.stateT = lerp(2.5, 6, spawnRng.float());
      herd.alert = 1;
      cue(ctx, c, 'creature_alarm');
    }
  } else if (tr.damage > 0 && dPlayer < alertR * 1.35 && tr.aggression > 0.35) {
    if (c.state !== 'hunt' && c.state !== 'attack') {
      c.state = 'hunt';
      cue(ctx, c, 'creature_growl');
    }
  } else if (c.stateT <= 0) {
    // Alternância natural entre pastar e vagar; predadores vagam mais.
    const grazer = tr.diet !== 'carnivore';
    c.state = grazer && spawnRng.chance(0.62) ? 'graze' : 'wander';
    c.stateT = lerp(4, 12, spawnRng.float());
  }

  // ── Alvo de deslocamento por estado ───────────────────────────────────────
  let goalX = herd.target.x, goalY = herd.target.y, goalZ = herd.target.z;
  let speed = tr.speed * 0.35;
  let look = null;

  switch (c.state) {
    case 'flee': {
      // Corre na direção oposta ao jogador, projetada no plano tangente.
      goalX = c.pos.x + (c.pos.x - px.x) * 3;
      goalY = c.pos.y + (c.pos.y - px.y) * 3;
      goalZ = c.pos.z + (c.pos.z - px.z) * 3;
      speed = tr.sprint;
      look = px;
      if (c.stateT <= 0 && dPlayer > alertR * 1.6) { c.state = 'wander'; c.stateT = 4; }
      break;
    }
    case 'hunt': {
      // Flanqueamento: cada membro ataca por um lado, ninguém empilha na mesma
      // linha reta. É o que faz um bando de predadores parecer coordenado.
      surfaceDir(c.pos, body, _up);
      _v1.set(px.x - c.pos.x, px.y - c.pos.y, px.z - c.pos.z);
      const d = _v1.length() || 1;
      _v1.multiplyScalar(1 / d);
      _right.crossVectors(_up, _v1).normalize();
      const flank = clamp(d * 0.55, 0, tr.sizeM * 5) * c.flankSign;
      goalX = px.x + _right.x * flank;
      goalY = px.y + _right.y * flank;
      goalZ = px.z + _right.z * flank;
      speed = d > tr.attackRange * 3 ? tr.sprint : tr.speed;
      look = px;
      if (d < tr.attackRange + tr.sizeM * 0.5) { c.state = 'attack'; c.stateT = 0.85; }
      break;
    }
    case 'attack': {
      speed = tr.sprint * 0.4;
      look = px;
      if (c.stateT <= 0) {
        ctx.events.emit('combat:hit', { attacker: c, victim: 'player', damage: tr.damage });
        ctx.events.emit('player:damage', { amount: tr.damage, source: 'creature' });
        cue(ctx, c, 'creature_attack');
        c.state = 'hunt';
        c.stateT = lerp(1.2, 2.6, spawnRng.float());
      }
      break;
    }
    case 'graze': {
      const food = nearestFlora(ctx, c.pos, 26);
      if (food) { goalX = food.x; goalY = food.y; goalZ = food.z; }
      const near = Math.abs(goalX - c.pos.x) + Math.abs(goalY - c.pos.y) + Math.abs(goalZ - c.pos.z) < tr.sizeM * 1.2;
      speed = near ? 0 : tr.speed * 0.28;
      c.grazing = near;
      break;
    }
    case 'follow': {
      // Domesticada: acompanha o jogador a uma distância confortável.
      const d = dPlayer;
      goalX = px.x; goalY = px.y; goalZ = px.z;
      speed = d > tr.sizeM * 3.5 ? tr.speed * (d > 25 ? 1.7 : 0.9) : 0;
      look = px;
      break;
    }
    case 'dying': {
      speed = 0;
      if (c.stateT <= 0) c.retiring = true;
      break;
    }
    default: {
      speed = tr.speed * lerp(0.25, 0.5, saturate(herd.alert));
      break;
    }
  }
  c.grazing = c.state === 'graze' && speed === 0;
  herd.alert = Math.max(0, herd.alert - dt * 0.35);

  // ── Boids sobre o alvo ────────────────────────────────────────────────────
  surfaceDir(c.pos, body, _up);
  c.up.copy(_up);
  let ax = goalX - c.pos.x, ay = goalY - c.pos.y, az = goalZ - c.pos.z;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;

  const members = herd.members;
  if (members.length > 1 && c.state !== 'attack') {
    const sepR = Math.max(1.6, tr.sizeM * 1.7);
    const cohR = Math.max(8, tr.sizeM * 9);
    let sx = 0, sy = 0, sz = 0, cx = 0, cy = 0, cz = 0, lx = 0, ly = 0, lz = 0, cn = 0;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (m === c || !m.active) continue;
      const dx = m.pos.x - c.pos.x, dy = m.pos.y - c.pos.y, dz = m.pos.z - c.pos.z;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      if (d < sepR) { const w = (sepR - d) / sepR; sx -= dx / d * w; sy -= dy / d * w; sz -= dz / d * w; }
      if (d < cohR) { cx += dx; cy += dy; cz += dz; lx += m.fwd.x; ly += m.fwd.y; lz += m.fwd.z; cn++; }
    }
    if (cn > 0) {
      const inv = 1 / cn;
      cx *= inv; cy *= inv; cz *= inv;
      const cl = Math.hypot(cx, cy, cz) || 1;
      const ll = Math.hypot(lx, ly, lz) || 1;
      // Pesos: separação domina (nunca se atravessam), coesão segura o bando,
      // alinhamento dá o "movimento de cardume".
      ax += sx * 2.4 + (cx / cl) * 0.55 + (lx / ll) * 0.5;
      ay += sy * 2.4 + (cy / cl) * 0.55 + (ly / ll) * 0.5;
      az += sz * 2.4 + (cz / cl) * 0.55 + (lz / ll) * 0.5;
    }
    // Atração ao líder (o primeiro membro vivo do bando).
    const leader = members[0];
    if (leader && leader !== c) {
      const dx = leader.pos.x - c.pos.x, dy = leader.pos.y - c.pos.y, dz = leader.pos.z - c.pos.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const w = 0.45 * smoothstep(cohR * 0.4, cohR * 1.4, d);
      ax += dx / d * w; ay += dy / d * w; az += dz / d * w;
    }
  }

  // Projeta no plano tangente: bicho de chão não anda "para dentro" do planeta.
  if (!tr.flying) {
    const dotUp = ax * _up.x + ay * _up.y + az * _up.z;
    ax -= _up.x * dotUp; ay -= _up.y * dotUp; az -= _up.z * dotUp;
  }
  const l2 = Math.hypot(ax, ay, az) || 1;
  c.desiredDir.set(ax / l2, ay / l2, az / l2);
  c.desiredSpeed = speed;

  // ── Alvo de olhar ─────────────────────────────────────────────────────────
  if (look) { c.lookTarget.copy(look); c.hasLook = true; }
  else if (c.grazing) { c.hasLook = false; }
  else if (dPlayer < alertR * 2.2) { c.lookTarget.copy(px); c.hasLook = true; }
  else c.hasLook = false;
}

function integrate(c, dt, ctx, body) {
  const tr = c.sp.traits;
  _v2.copy(c.fwd);                       // guarda a frente anterior (banking)
  // Giro limitado: a inércia de rotação é metade da leitura de "massa".
  const turn = tr.turnRate * dt * (c.state === 'flee' ? 1.6 : 1);
  const dot = clamp(c.fwd.dot(c.desiredDir), -1, 1);
  const ang = Math.acos(dot);
  if (ang > 1e-4) {
    const t = Math.min(1, turn / ang);
    c.fwd.lerp(c.desiredDir, t);
  }
  // Reortogonaliza contra a vertical local (o "chão" muda a cada passo numa esfera).
  const dUp = c.fwd.dot(c.up);
  c.fwd.addScaledVector(c.up, -dUp);
  if (c.fwd.lengthSq() < 1e-8) tangentBasis(c.up, _right, c.fwd);
  c.fwd.normalize();
  _v3.crossVectors(_v2, c.fwd);
  c.turnSignal = lerp(c.turnSignal, _v3.dot(c.up) / Math.max(1e-3, dt), Math.min(1, dt * 6));

  // Aceleração suave — arrancada e frenagem visíveis.
  const accel = tr.speed * (c.desiredSpeed > c.speed ? 1.6 : 3.0);
  c.lastSpeed = c.speed;
  c.speed += clamp(c.desiredSpeed - c.speed, -accel * dt, accel * dt);
  if (c.speed < 0.02) c.speed = 0;

  c.pos.addScaled(c.fwd, c.speed * dt);

  if (tr.flying) {
    // Voadores: alvo de altitude com planeio (bate asa subindo, plana descendo).
    surfaceDir(c.pos, body, _v1);
    const gr = groundRadius(ctx, body, _v1);
    c.groundR = gr;
    const want = gr + c.cruise;
    const r = c.pos.distanceTo(body.center) || 1;
    const newR = lerp(r, want, Math.min(1, dt * 0.45));
    c.pos.set(body.center.x + _v1.x * newR, body.center.y + _v1.y * newR, body.center.z + _v1.z * newR);
    c.up.copy(_v1);
    c.altitude = newR - gr;
    c.climb = newR - r;
  } else {
    surfaceDir(c.pos, body, _v1);
    const gr = groundRadius(ctx, body, _v1);
    c.groundR = gr;
    c.pos.set(body.center.x + _v1.x * gr, body.center.y + _v1.y * gr, body.center.z + _v1.z * gr);
    c.up.copy(_v1);
    c.altitude = 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// lateUpdate — pose e colocação (tudo relativo à origem flutuante)
// ────────────────────────────────────────────────────────────────────────────

export function lateUpdate(dt, ctx) {
  if (!group) return;

  // Direção do sol em espaço de VISTA para o termo de SSS dos materiais.
  const sun = ctx.sky && ctx.sky.sunDirection;
  if (sun) {
    _v1.copy(sun).transformDirection(ctx.engine.camera.matrixWorldInverse).normalize();
    SSS_UNIFORMS.uSssDir.value.copy(_v1);
  }
  SSS_UNIFORMS.uSssAmount.value = ctx.player.inAtmosphere === false ? 0.55 : 1.0;

  const body = ctx.planet && ctx.planet.current;
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    placeOne(c);
    applyLod(c);
    if (c.lod === 0 && body) poseCreature(c, dt, ctx, body);
    else if (c.lod === 1) poseCoarse(c, dt);
  }
}

/** Reposiciona todos — usado no rebase da origem. */
function placeAll() {
  for (let i = 0; i < creatures.length; i++) placeOne(creatures[i]);
}

function placeOne(c) {
  const o = ctxRef.frame.origin;
  c.holder.position.set(c.pos.x - o.x, c.pos.y - o.y, c.pos.z - o.z);
  // Base ortonormal: +Y = vertical local, +Z = frente. A geometria foi gerada
  // com a frente em +Z, então a base é direta, sem correção de eixo.
  _right.crossVectors(c.up, c.fwd).normalize();
  _v2.crossVectors(c.fwd, _right).normalize();
  _mBasis.makeBasis(_right, _v2, c.fwd);
  c.quat.setFromRotationMatrix(_mBasis);
  if (!c.alive) {
    // Tomba de lado ao morrer.
    _q1.setFromAxisAngle(c.fwd, c.deathRoll || 0);
    c.quat.premultiply(_q1);
  }
  c.holder.quaternion.copy(c.quat);
  const s = c.scale * Math.max(0.001, c.grow);
  c.holder.scale.setScalar(s);
}

function applyLod(c) {
  const skin = c.lod === 0;
  const stat = c.lod === 1;
  const imp = c.lod === 2;
  if (c.mesh.visible !== skin) c.mesh.visible = skin;
  if (c.staticMesh.visible !== stat) c.staticMesh.visible = stat;
  if (c.sprite.visible !== imp) c.sprite.visible = imp;
  if (imp) {
    const tr = c.sp.traits;
    c.sprite.position.set(0, tr.heightM * 0.55, 0);
    c.sprite.scale.set(tr.sizeM * 1.05, tr.sizeM * 0.62, 1);
  }
}

/** LOD1: sem esqueleto. Só um balanço global — a 80 m ninguém vê a junta. */
function poseCoarse(c, dt) {
  if (c.speed > 0.05) {
    c.gaitPhase = (c.gaitPhase + dt * clamp(c.speed / Math.max(0.2, c.sp.traits.strideLen * c.scale), 0.4, 4)) % 1;
    const b = Math.sin(c.gaitPhase * Math.PI * 4) * c.sp.traits.sizeM * 0.012;
    c.staticMesh.position.set(0, b, 0);
    c.staticMesh.rotation.z = Math.sin(c.gaitPhase * Math.PI * 2) * 0.05;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pose completa (LOD0)
// ────────────────────────────────────────────────────────────────────────────

function poseCreature(c, dt, ctx, body) {
  const sp = c.sp, rig = sp.rig, tr = sp.traits, rest = sp.restBones;
  const s = c.scale * Math.max(0.001, c.grow);
  c.breathe += dt * lerp(0.6, 2.2, 1 / (1 + tr.sizeM * 0.4));

  // 1. Marcha: converte velocidade em fase. Fase só avança se há deslocamento —
  //    é isso que impede o "andar no lugar".
  const stride = Math.max(0.15, tr.strideLen * s);
  if (!tr.flying && c.speed > 0.04) {
    c.gaitPhase = (c.gaitPhase + (c.speed / stride) * dt * 0.85) % 1;
  }
  if (tr.flying) c.wingPhase = (c.wingPhase + dt * lerp(3.2, 1.1, saturate(tr.sizeM / 6)) * (c.climb > 0 ? 1.35 : 0.55)) % 1;

  // 2. Pés: alterna apoio/balanço e planta pontos reais do terreno.
  if (!tr.flying) updateFeet(c, dt, ctx, body, s, stride);

  // 3. Corpo responde aos pés (antes da IK, para que a IK compense).
  poseRoot(c, dt, s, rest, rig);

  // 4. Coluna, cauda e pescoço: ondulação secundária.
  poseSpine(c, dt, rest, rig, tr);

  // 5. Matrizes dos ancestrais atualizadas → a IK pode ler os quadris já na
  //    pose deste frame (o renderer refaz isso depois, mas precisamos ANTES).
  c.holder.updateMatrixWorld(true);

  if (!tr.flying) {
    for (let i = 0; i < rig.legs.length; i++) solveLeg(c, i, s);
  } else {
    poseWings(c, rest, rig);
  }

  // 6. Cabeça por último: olha o alvo sem quebrar o pescoço.
  poseHead(c, dt, ctx, rest, rig, tr);
}

function updateFeet(c, dt, ctx, body, s, stride) {
  const rig = c.sp.rig, tr = c.sp.traits;
  const D = tr.dutyFactor;
  const moving = c.speed > 0.05;
  const stepH = Math.max(0.02, tr.strideLen * s * 0.28);
  _right.crossVectors(c.up, c.fwd).normalize();

  for (let i = 0; i < rig.legs.length; i++) {
    const L = rig.legs[i], st = c.legs[i];
    const t = ((c.gaitPhase + L.phase) % 1 + 1) % 1;
    if (!moving || t < D) {
      if (!st.stance) { st.stance = true; st.footWorld.copy(st.toWorld); }
      st.lift = 0;
    } else {
      if (st.stance) {
        st.stance = false;
        st.fromWorld.copy(st.footWorld);
        // Próximo apoio: projeção do quadril à frente, meia passada, no chão.
        const ahead = stride * 0.5 + c.speed * 0.16;
        st.toWorld.set(
          c.pos.x + _right.x * L.restFoot.x * s + c.fwd.x * (L.restFoot.z * s + ahead),
          c.pos.y + _right.y * L.restFoot.x * s + c.fwd.y * (L.restFoot.z * s + ahead),
          c.pos.z + _right.z * L.restFoot.x * s + c.fwd.z * (L.restFoot.z * s + ahead),
        );
        snapToGround(ctx, body, st.toWorld);
      }
      const u = clamp((t - D) / (1 - D), 0, 1);
      const e = u * u * (3 - 2 * u);
      st.footWorld.set(
        lerp(st.fromWorld.x, st.toWorld.x, e),
        lerp(st.fromWorld.y, st.toWorld.y, e),
        lerp(st.fromWorld.z, st.toWorld.z, e),
      );
      st.lift = Math.sin(u * Math.PI) * stepH;
    }
    // Altura do pé em relação ao ponto de contato do corpo: alimenta o balanço.
    st.height = (st.footWorld.x - c.pos.x) * c.up.x
      + (st.footWorld.y - c.pos.y) * c.up.y
      + (st.footWorld.z - c.pos.z) * c.up.z;
  }
}

/**
 * O corpo segue os pés: sobe até a média do apoio, rola para o lado mais alto
 * e inclina no sentido da subida. É o passo que transforma pernas animadas em
 * um animal com peso.
 */
function poseRoot(c, dt, s, rest, rig) {
  const tr = c.sp.traits;
  const root = c.bones[rig.root];
  const r0 = rest[rig.root];

  if (tr.flying) {
    // No ar não há apoio: o corpo sobe no bater de asa e INCLINA na curva.
    // Sem o banking o voo lê como "sprite deslizando".
    const bob = Math.sin(c.wingPhase * Math.PI * 2) * tr.sizeM * 0.02;
    c.bodyBob = lerp(c.bodyBob, bob / Math.max(0.001, s), Math.min(1, dt * 9));
    c.bodyRoll = lerp(c.bodyRoll, clamp(-c.turnSignal * 0.55, -0.7, 0.7), Math.min(1, dt * 4));
    c.bodyPitch = lerp(c.bodyPitch, clamp(-c.climb * 6, -0.35, 0.35), Math.min(1, dt * 4));
    root.position.set(r0.px, r0.py + c.bodyBob, r0.pz);
    _v1.set(1, 0, 0);
    _q1.setFromAxisAngle(_v1, c.bodyPitch);
    _v1.set(0, 0, 1);
    _q2.setFromAxisAngle(_v1, c.bodyRoll);
    _q1.multiply(_q2);
    root.quaternion.copy(_q1).multiply(r0.q);
    return;
  }

  const legs = rig.legs;
  let avg = 0, rollN = 0, roll = 0, pitchN = 0, pitch = 0;
  for (let i = 0; i < legs.length; i++) {
    const st = c.legs[i], L = legs[i];
    avg += st.height;
    if (L.side !== 0) { roll += st.height * L.side; rollN++; }
    pitch += st.height * (L.restFoot.z >= 0 ? 1 : -1); pitchN++;
  }
  const n = Math.max(1, legs.length);
  avg /= n;
  if (rollN) roll /= rollN;
  if (pitchN) pitch /= pitchN;

  const cyc = tr.gaitType === 'gallop' ? 1 : 2;
  const bobA = tr.sizeM * 0.012 * clamp(c.speed / Math.max(0.5, tr.speed), 0, 1.4);
  const bob = Math.sin(c.gaitPhase * Math.PI * 2 * cyc) * bobA
    + Math.sin(c.breathe) * tr.sizeM * 0.0035;     // respiração parada

  c.bodyBob = lerp(c.bodyBob, (avg + bob) / Math.max(0.001, s), Math.min(1, dt * 12));
  c.bodyRoll = lerp(c.bodyRoll, clamp(-roll / Math.max(0.2, tr.sizeM) * 0.7, -0.35, 0.35), Math.min(1, dt * 8));
  const accel = (c.speed - c.lastSpeed) / Math.max(1e-3, dt);
  c.bodyPitch = lerp(c.bodyPitch,
    clamp(pitch / Math.max(0.2, tr.sizeM) * 0.6 - accel * 0.015, -0.4, 0.4),
    Math.min(1, dt * 8));

  root.position.set(r0.px, r0.py + c.bodyBob, r0.pz);
  // Rotação de balanço montada em espaço de CRIATURA (o pai do root é a malha).
  _v1.set(1, 0, 0);
  _q1.setFromAxisAngle(_v1, c.bodyPitch);
  _v1.set(0, 0, 1);
  _q2.setFromAxisAngle(_v1, c.bodyRoll);
  _q1.multiply(_q2);
  root.quaternion.copy(_q1).multiply(r0.q);
}

/** Ondulação da coluna e da cauda — e a locomoção inteira dos serpentinos. */
function poseSpine(c, dt, rest, rig, tr) {
  const undulate = tr.gaitType === 'undulate';
  const wave = c.gaitPhase * Math.PI * 2;
  const amp = undulate ? 0.34 : 0.055;
  const chainSpine = rig.spine;
  for (let i = 0; i < chainSpine.length; i++) {
    const bi = chainSpine[i];
    if (bi === rig.root) continue;
    const r = rest[bi];
    const a = Math.sin(wave - i * (undulate ? 1.05 : 0.55)) * amp * (undulate ? 1 : clamp(c.speed / Math.max(0.5, tr.speed), 0, 1));
    // Eixo Y da CRIATURA levado ao referencial do pai — é o que permite "guinar
    // este osso" sem reconstruir a cadeia.
    _v1.copy(AXIS_Y).applyQuaternion(rest[r.parent >= 0 ? r.parent : bi].iwq);
    _q1.setFromAxisAngle(_v1.normalize(), a);
    c.bones[bi].quaternion.copy(_q1).multiply(r.q);
  }
  for (let i = 0; i < rig.tail.length; i++) {
    const bi = rig.tail[i];
    const r = rest[bi];
    const sway = Math.sin(wave * 0.75 - i * 0.7) * (0.10 + 0.16 * clamp(c.speed / Math.max(0.5, tr.speed), 0, 1));
    const droop = Math.sin(c.breathe * 0.5 + i) * 0.04;
    _v1.copy(AXIS_Y).applyQuaternion(rest[r.parent >= 0 ? r.parent : bi].iwq);
    _q1.setFromAxisAngle(_v1.normalize(), sway);
    _v2.set(1, 0, 0).applyQuaternion(rest[r.parent >= 0 ? r.parent : bi].iwq);
    _q2.setFromAxisAngle(_v2.normalize(), droop);
    c.bones[bi].quaternion.copy(_q1).multiply(_q2).multiply(r.q);
  }
  for (let t = 0; t < rig.tentacles.length; t++) {
    const chain = rig.tentacles[t].chain;
    for (let i = 0; i < chain.length; i++) {
      const bi = chain[i];
      const r = rest[bi];
      const a = Math.sin(c.breathe * 1.4 + t * 1.7 - i * 0.8) * 0.16;
      _v1.set(1, 0, 0).applyQuaternion(rest[r.parent >= 0 ? r.parent : bi].iwq);
      _q1.setFromAxisAngle(_v1.normalize(), a);
      c.bones[bi].quaternion.copy(_q1).multiply(r.q);
    }
  }
}

/** Bater de asas com planeio: a fase decide entre impulso e vela aberta. */
function poseWings(c, rest, rig) {
  const gliding = c.climb <= 0.001;
  const flap = gliding
    ? Math.sin(c.wingPhase * Math.PI * 2) * 0.10 + 0.12
    : Math.sin(c.wingPhase * Math.PI * 2) * 0.85;
  for (let i = 0; i < rig.wings.length; i++) {
    const w = rig.wings[i];
    const rs = rest[w.shoulder], re = rest[w.elbow], rt = rest[w.tip];
    const ps = rest[rs.parent >= 0 ? rs.parent : w.shoulder];
    _v1.set(0, 0, 1).applyQuaternion(ps.iwq).normalize();
    _q1.setFromAxisAngle(_v1, flap * -w.side);
    c.bones[w.shoulder].quaternion.copy(_q1).multiply(rs.q);
    // Atraso na ponta: a asa "chicoteia", que é o que se vê num pássaro real.
    _v2.set(0, 0, 1).applyQuaternion(rest[re.parent >= 0 ? re.parent : w.elbow].iwq).normalize();
    _q2.setFromAxisAngle(_v2, Math.sin((c.wingPhase - 0.12) * Math.PI * 2) * (gliding ? 0.06 : 0.42) * -w.side);
    c.bones[w.elbow].quaternion.copy(_q2).multiply(re.q);
    _v3.set(0, 0, 1).applyQuaternion(rest[rt.parent >= 0 ? rt.parent : w.tip].iwq).normalize();
    _q3.setFromAxisAngle(_v3, Math.sin((c.wingPhase - 0.24) * Math.PI * 2) * (gliding ? 0.04 : 0.34) * -w.side);
    c.bones[w.tip].quaternion.copy(_q3).multiply(rt.q);
  }
}

/**
 * IK analítica de duas juntas. Trabalha em ESPAÇO DE CENA (a mesma referência
 * das matrizes de mundo dos ossos), o que evita converter o alvo de ida e volta.
 */
function solveLeg(c, li, s) {
  const L = c.sp.rig.legs[li];
  const st = c.legs[li];
  const hipB = c.bones[L.hip], kneeB = c.bones[L.knee], ankB = c.bones[L.ankle];
  const o = ctxRef.frame.origin;

  _target.set(st.footWorld.x - o.x, st.footWorld.y - o.y, st.footWorld.z - o.z);
  _target.addScaledVector(c.up, st.lift);

  const e = hipB.matrixWorld.elements;
  _hip.set(e[12], e[13], e[14]);
  _dir.subVectors(_target, _hip);
  let d = _dir.length();
  const l1 = Math.max(1e-4, L.upperLen * s);
  const l2 = Math.max(1e-4, L.lowerLen * s);
  const maxR = (l1 + l2) * 0.995;
  const minR = Math.abs(l1 - l2) * 1.05 + 1e-4;
  if (d < 1e-6) { _dir.copy(c.up).multiplyScalar(-1); d = minR; }
  else _dir.multiplyScalar(1 / d);
  d = clamp(d, minR, maxR);

  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);

  // Polo: leva o joelho sempre para o mesmo lado, derivado da pose de repouso.
  _pole.copy(L.pole).applyQuaternion(c.quat);
  _axis.crossVectors(_dir, _pole);
  if (_axis.lengthSq() < 1e-9) _axis.crossVectors(_dir, c.up);
  if (_axis.lengthSq() < 1e-9) _axis.set(1, 0, 0);
  _axis.normalize();
  _upper.copy(_dir).applyAxisAngle(_axis, a);

  _mRot.extractRotation(hipB.parent.matrixWorld);
  _qParent.setFromRotationMatrix(_mRot);
  _q1.setFromUnitVectors(AXIS_Y, _upper);
  hipB.quaternion.copy(_qParent).invert().multiply(_q1);

  _knee.copy(_hip).addScaledVector(_upper, l1);
  _lower.subVectors(_target, _knee);
  if (_lower.lengthSq() < 1e-10) _lower.copy(_upper);
  else _lower.normalize();
  _q2.setFromUnitVectors(AXIS_Y, _lower);
  kneeB.quaternion.copy(_q1).invert().multiply(_q2);

  // Pé plano no chão, dedos para a frente.
  _footFwd.copy(c.fwd).addScaledVector(c.up, -0.12).normalize();
  _q3.setFromUnitVectors(AXIS_Y, _footFwd);
  ankB.quaternion.copy(_q2).invert().multiply(_q3);
}

/** Look-at amortecido: a cabeça persegue o alvo, o pescoço acompanha um pouco. */
function poseHead(c, dt, ctx, rest, rig, tr) {
  const hi = rig.head;
  if (hi === undefined || hi < 0) return;
  const headB = c.bones[hi];
  const r = rest[hi];

  // Direção desejada em espaço de cena.
  if (c.grazing) {
    // Pastando: focinho para o chão, na frente das patas dianteiras.
    _v1.copy(c.fwd).multiplyScalar(0.75).addScaledVector(c.up, -0.9).normalize();
  } else if (c.hasLook) {
    const o = ctxRef.frame.origin;
    const hw = headB.matrixWorld.elements;
    _v1.set(
      (c.lookTarget.x - o.x) - hw[12],
      (c.lookTarget.y - o.y) - hw[13],
      (c.lookTarget.z - o.z) - hw[14],
    );
    if (_v1.lengthSq() < 1e-8) _v1.copy(c.fwd); else _v1.normalize();
  } else {
    _v1.copy(c.fwd).addScaledVector(c.up, -0.12).normalize();
  }

  // Amortecimento no espaço da direção: nada de estalos ao trocar de alvo.
  c.lookDir.lerp(_v1, Math.min(1, dt * 3.2));
  if (c.lookDir.lengthSq() < 1e-8) c.lookDir.copy(c.fwd);
  c.lookDir.normalize();

  // Limite anatômico: no máximo ~75° fora do eixo do corpo.
  _v2.copy(c.fwd);
  const dotF = clamp(c.lookDir.dot(_v2), -1, 1);
  if (dotF < 0.26) {
    _v3.copy(c.lookDir).addScaledVector(_v2, 0.9).normalize();
    c.lookDir.copy(_v3);
  }

  _mRot.extractRotation(headB.parent.matrixWorld);
  _qParent.setFromRotationMatrix(_mRot);
  _q1.setFromUnitVectors(AXIS_Y, c.lookDir);
  _q2.copy(_qParent).invert().multiply(_q1);
  // Mistura com a pose de repouso: o pescoço divide o esforço com a cabeça.
  headB.quaternion.copy(r.q).slerp(_q2, 0.82);
}

// ────────────────────────────────────────────────────────────────────────────
// Eventos
// ────────────────────────────────────────────────────────────────────────────

function creatureFrom(ref) {
  if (!ref) return null;
  if (ref.sp && ref.holder) return ref;
  if (ref.userData && ref.userData.creature) return ref.userData.creature;
  if (ref.isObject3D && ref.parent && ref.parent.userData && ref.parent.userData.creature) return ref.parent.userData.creature;
  return null;
}

function onCombatHit(payload) {
  if (!payload) return;
  let c = creatureFrom(payload.victim) || creatureFrom(payload.target);
  if (!c && payload.position) c = nearestTo(payload.position, 3.5);
  if (!c || !c.alive) return;
  damage(c, payload.damage || 10, payload.attacker);
}

function damage(c, amount, attacker) {
  if (!c || !c.alive) return;
  c.health -= amount;
  cue(ctxRef, c, 'creature_hurt');
  // Ferir um bicho acorda o bando inteiro: herbívoros debandam, predadores vêm.
  if (c.herd) {
    c.herd.alert = 1;
    for (let i = 0; i < c.herd.members.length; i++) {
      const m = c.herd.members[i];
      if (m.sp.traits.diet === 'herbivore') { m.state = 'flee'; m.stateT = 6; }
      else if (m.sp.traits.damage > 0) { m.state = 'hunt'; m.stateT = 8; }
    }
  }
  if (c.health <= 0) {
    c.alive = false;
    c.state = 'dying';
    c.stateT = 3.2;          // tomba, fica caído um instante e some
    c.deathRoll = 0;
    cue(ctxRef, c, 'creature_death');
  }
}

/**
 * Alimentar: o gesto de "ganhar" um bicho. Ele fica dócil, segue o jogador e
 * dispara um ping de varredura — a recompensa concreta de revelar recursos.
 */
function onFeed(payload) {
  const ctx = ctxRef;
  if (!ctx) return;
  let c = creatureFrom(payload && payload.creature);
  if (!c) c = nearestTo((payload && payload.position) || ctx.player.position, 18);
  if (!c || !c.alive) return;
  c.tame = true;
  c.state = 'follow';
  c.stateT = 60;
  if (c.herd) c.herd.alert = 0;
  cue(ctx, c, 'creature_happy');
  ctx.events.emit('ui:notify', { text: `${c.sp.name} agora confia em você`, kind: 'good' });
  ctx.events.emit('scan:ping', { position: c.pos.clone(), radius: 80, source: 'creature' });
  registerDiscovery(ctx, c.sp);
}

function onScanPing(payload) {
  const ctx = ctxRef;
  if (!ctx || !payload || !payload.position) return;
  const r = payload.radius || 60;
  const seen = new Set();
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    if (seen.has(c.sp.id)) continue;
    if (Math.sqrt(c.pos.distanceToSq(payload.position)) <= r) {
      seen.add(c.sp.id);
      registerDiscovery(ctx, c.sp);
    }
  }
}

function registerDiscovery(ctx, sp) {
  if (sp.discovered) return;
  sp.discovered = true;
  discoveredCount++;
  const info = {
    kind: 'species', id: sp.id, name: sp.name,
    traits: sp.traits,
    planet: ctx.planet && ctx.planet.current ? ctx.planet.current.name : null,
  };
  // Se o módulo de descobertas existe, ele é o dono do registro (e do evento).
  if (ctx.discovery && typeof ctx.discovery.registerSpecies === 'function') {
    ctx.discovery.registerSpecies(info);
  } else {
    ctx.events.emit('discovery:new', info);
    ctx.events.emit('ui:notify', { text: `Espécie descoberta: ${sp.name}`, kind: 'discovery' });
  }
}

function nearestTo(pos, maxDist) {
  let best = null, bestD = maxDist * maxDist;
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    if (!c.alive) continue;
    const d = c.pos.distanceToSq(pos);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Toda a informação que o sintetizador precisa para inventar a voz do bicho. */
function cue(ctx, c, name) {
  if (!ctx) return;
  const tr = c.sp.traits;
  ctx.events.emit('audio:cue', {
    name,
    params: {
      pitch: tr.vocalPitch,
      roughness: tr.vocalRough,
      sizeM: tr.sizeM,
      diet: tr.diet,
      temperament: tr.temperament,
      archetype: tr.archetype,
      distance: c.dist,
      species: c.sp.id,
      position: c.pos,
    },
  });
}

function voice(c, dt, ctx) {
  c.voiceT -= dt;
  if (c.voiceT > 0) return;
  c.voiceT = lerp(7, 22, spawnRng.float());
  if (c.dist < 70 && c.alive) cue(ctx, c, 'creature_idle');
}

// ────────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────────

const api = {
  get species() { return species; },
  get creatures() { return creatures; },
  get herds() { return herds; },

  /** Simétrico ao contrato de flora: criaturas dentro de um raio. */
  instancesNear(worldPos, radius = 60, out) {
    const arr = out || nearOut;
    arr.length = 0;
    const r2 = radius * radius;
    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      if (c.pos.distanceToSq(worldPos) <= r2) arr.push(c);
    }
    return arr;
  },

  nearest(worldPos, maxDist = 60) { return nearestTo(worldPos, maxDist); },

  /** Varredura esférica barata ao longo de um raio — para mira e ferramentas. */
  raycast(originVec3d, dirVec3, maxDist = 120) {
    let best = null, bestT = maxDist;
    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      if (!c.alive) continue;
      const dx = c.pos.x - originVec3d.x, dy = c.pos.y - originVec3d.y, dz = c.pos.z - originVec3d.z;
      const t = dx * dirVec3.x + dy * dirVec3.y + dz * dirVec3.z;
      if (t < 0 || t > bestT) continue;
      const ex = dx - dirVec3.x * t, ey = dy - dirVec3.y * t, ez = dz - dirVec3.z * t;
      const rad = c.sp.traits.sizeM * 0.45 + 0.4;
      if (ex * ex + ey * ey + ez * ez <= rad * rad) { best = c; bestT = t; }
    }
    return best ? { creature: best, distance: bestT } : null;
  },

  damage(creature, amount, attacker) { damage(creatureFrom(creature) || creature, amount, attacker); },
  feed(creatureOrPos) {
    if (creatureOrPos && creatureOrPos.sp) onFeed({ creature: creatureOrPos });
    else onFeed({ position: creatureOrPos });
  },
  scan(worldPos, radius = 60) { onScanPing({ position: worldPos, radius }); },

  setEnabled(v) {
    enabled = !!v;
    if (group) group.visible = enabled;
  },

  /** Força a geração completa das espécies — usado por testes e pré-aquecimento. */
  forceGenerate() {
    while (pending.length) {
      const job = pending[0];
      let r = job.it.next();
      while (!r.done) r = job.it.next();
      pending.shift();
      if (r.value) {
        r.value._pool = [];
        r.value.discovered = false;
        ctxRef.lighting?.registerMaterial?.(r.value.material, { kind: 'fauna' });
        species.push(r.value);
      }
    }
    return species.length;
  },

  get stats() {
    return {
      active: creatures.length,
      species: species.length,
      herds: herds.length,
      pooled: totalInstances,
      discovered: discoveredCount,
    };
  },
};
