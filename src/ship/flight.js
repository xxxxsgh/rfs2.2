import * as THREE from 'three';
import { Vec3d } from '../core/frame.js';
import { createShip } from './shipmodel.js';

/**
 * VOO — nave, jogador a pé e câmera.
 *
 * Este módulo é o motor do `ctx.player`: todo o resto (terreno, céu, HUD, pós)
 * lê a posição, a velocidade e a orientação que ele escreve. Por isso ele roda
 * cedo (order 20) e nunca depende de outro sistema para funcionar — tudo que
 * vem de fora entra por optional chaining com fallback analítico.
 *
 * ── Dois modelos de voo, sem `if` ───────────────────────────────────────────
 * Existe um modelo NEWTONIANO (vácuo: empuxo no nariz, inércia total, nenhum
 * arrasto) e um modelo AERODINÂMICO (sustentação ~ ρ·v²·sen α, arrasto
 * quadrático, estabilidade de guinada, a nave "cai" para o vetor velocidade).
 * A cada frame calculamos AS DUAS acelerações e interpolamos pela densidade do
 * ar. POR QUÊ: um `if (altitude < X)` produz um solavanco visível e audível na
 * fronteira; o LERP dá a reentrada contínua que o No Man's Sky tem.
 *
 * ── Precisão ────────────────────────────────────────────────────────────────
 * Posição/velocidade do jogador vivem em Vec3d (float64). A nave e a câmera só
 * recebem coordenadas relativas via ctx.frame.toLocal(), escritas em
 * lateUpdate (depois do rebase) e também no evento 'frame:rebase'.
 *
 * ── Pose travada (arnês de screenshots) ─────────────────────────────────────
 * teleport()/setOrientation() entram em "pose travada": a câmera passa a valer
 * exatamente a posição/orientação pedida e a física deixa de aplicar gravidade
 * e colisão. Sem isso, os 45 frames de `settle()` do arnês derrubariam o
 * jogador do ponto escolhido antes da captura. O travamento cai sozinho no
 * primeiro comando real do jogador.
 */

export const id = 'flight';
export const order = 20;

// ── Constantes de projeto (metros, segundos) ────────────────────────────────
const EYE = 1.7;                  // altura do olho a pé (§7 da arquitetura)
const WALK = 6, RUN = 10.6;
const JUMP_V = 5.4, JET_ACC = 17, JET_DRAIN = 26, ENERGY_REGEN = 15;

const THRUST_SPACE = 240;         // m/s² no vácuo
const THRUST_PULSE = 3200;        // impulso ("pulse drive")
const THRUST_ATMO = 62;           // dentro da atmosfera o motor rende menos
const RCS = 34;                   // propulsores laterais/verticais
const BRAKE = 180;
const V_MAX_SPACE = 1200, V_MAX_PULSE = 20000;
const DRAG_K = 6.9e-4;            // arrasto: v_terminal ≈ 300 m/s a ρ=1
const LIFT_K = 2.6e-3;
const ROLL_ACC = 3.0, MOUSE_IMPULSE = 5.2, ANG_MAX = 2.9;
const ASSIST_DAMP = 2.9, FREE_DAMP = 0.12;

const CAM_SPRING = 7.5, CAM_TURN = 9.0;
const FOV_BASE = 70, FOV_GAIN = 26;

// ── Estado do módulo ────────────────────────────────────────────────────────
const S = {
  ctx: null,
  ready: false,
  shipApi: null,
  ship: null,
  mode: 'ship',
  assist: true,                 // amortecimento assistido de rotação
  camDist: 22,                  // 0 → primeira pessoa (a nave tem ~17 m)
  poseHold: false,
  warping: false,

  shipPos: new Vec3d(),
  shipQuat: new THREE.Quaternion(),
  camWorld: new Vec3d(),
  camQ: new THREE.Quaternion(),

  angVel: new THREE.Vector3(),  // rad/s no espaço do corpo
  heading: new THREE.Vector3(1, 0, 0),  // direção tangencial a pé
  pitch: 0,

  body: null,
  radialUp: new THREE.Vector3(0, 1, 0),
  groundNormal: new THREE.Vector3(0, 1, 0),
  altitude: Infinity,
  density: 0,
  gravity: 0,

  speed: 0,
  boostFactor: 0,
  thrustVis: 0,
  gear: 0,
  landed: false,
  shake: 0,
  fov: FOV_BASE,
  jetOn: false,
};

// ── Temporários: zero alocação nos caminhos quentes ─────────────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _shipUp = new THREE.Vector3();
const _vhat = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _accS = new THREE.Vector3();
const _accA = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _localV = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _camFinal = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _d1 = new Vec3d();
const _d2 = new Vec3d();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (dt, k) => 1 - Math.exp(-k * dt);

// ── Consulta do mundo (tudo opcional, tudo com fallback) ────────────────────

/**
 * Chamadas a outros módulos são sempre embrulhadas: eles podem estar a meio de
 * um streaming e lançar. Um erro no update do voo derruba o jogo inteiro, então
 * aqui a degradação é silenciosa e volta para o modelo analítico.
 */
function safeAlt(ctx, pos) {
  try { const a = ctx.planet?.altitudeAt?.(pos); return Number.isFinite(a) ? a : NaN; }
  catch (e) { return NaN; }
}
function safeSurface(ctx, dir) {
  try { return ctx.planet?.sampleSurface?.(dir) || null; } catch (e) { return null; }
}
function safeDensity(ctx, altitude) {
  try {
    let d = ctx.sky?.densityAt?.(ctx.player.position);
    if (!Number.isFinite(d)) d = ctx.sky?.atmosphereDensity?.(altitude);
    if (!Number.isFinite(d)) d = ctx.planet?.atmosphereDensityAt?.(ctx.player.position);
    return Number.isFinite(d) ? d : NaN;
  } catch (e) { return NaN; }
}

/** Corpo dominante: o planeta streamado ou o mais próximo do sistema. */
function pickBody(ctx) {
  let cur = null, bodies = null;
  // `current`/`bodies` podem ser getters que calculam algo e falham durante o
  // streaming; nem isso pode derrubar o voo.
  try { cur = ctx.planet?.current || null; } catch (e) { cur = null; }
  if (isUsableBody(cur)) return cur;
  try { bodies = ctx.universe?.current?.bodies || ctx.system?.bodies || null; } catch (e) { bodies = null; }
  if (!bodies || bodies.length === 0) return null;
  const p = ctx.player.position;
  let best = null, bestD = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (!isUsableBody(b)) continue;
    const dx = b.center.x - p.x, dy = b.center.y - p.y, dz = b.center.z - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

function isUsableBody(b) {
  return !!b && !!b.center && Number.isFinite(b.center.x) && Number.isFinite(b.radius) && b.radius > 1;
}

/**
 * Densidade do ar normalizada [0,1]. Pergunta ao céu/planeta; se ninguém
 * responder, usa uma atmosfera exponencial com o topo em radius*0.06 (§7).
 */
function airDensity(ctx, body, altitude) {
  let d = safeDensity(ctx, altitude);
  if (!Number.isFinite(d)) {
    if (!body) return 0;
    // Se o módulo `sky` já definiu a espessura e a altura de escala da
    // atmosfera, usamos as MESMAS: a fronteira aerodinâmica tem de coincidir
    // com a fronteira que o jogador vê.
    let top = 0, hR = 0;
    try { top = ctx.sky?.atmosphereThickness || 0; hR = ctx.sky?.params?.hR || 0; } catch (e) { top = 0; hR = 0; }
    if (!(top > 0)) top = body.radius * 0.06;          // §7 da arquitetura
    const scaleH = hR > 1 ? hR : top / 3.2;
    d = Math.exp(-Math.max(0, altitude) / scaleH);
    const amount = body.atmosphere ?? body.biome?.sky?.density
      ?? body.biome?.atmosphere ?? (body.type === 'moon' ? 0.18 : 1);
    d *= amount;
  }
  return clamp(d, 0, 1);
}

/** Gravidade escalar em r, apontando sempre para body.center. */
function gravityAt(body, r) {
  if (!body) return 0;
  const g0 = body.gravity ?? body.surfaceGravity ?? 9.4;
  const k = body.radius / Math.max(body.radius, r);
  return g0 * k * k;
}

/** Lê o estado do mundo uma vez por frame e publica em ctx.player. */
function readWorld(ctx) {
  const p = ctx.player;
  const body = pickBody(ctx);
  S.body = body;

  if (body) {
    _d1.subVectors(p.position, body.center);
    const r = Math.max(1e-6, _d1.length());
    S.radialUp.set(_d1.x / r, _d1.y / r, _d1.z / r);
    let alt = safeAlt(ctx, p.position);
    if (!Number.isFinite(alt)) alt = r - body.radius;
    S.altitude = alt;
    S.gravity = gravityAt(body, r);
    S.density = airDensity(ctx, body, alt);
    // Normal do terreno: essencial para pousar torto num vale e continuar torto.
    // Só amostramos perto do chão — sampleSurface pode ser caro e no espaço a
    // normal não serve para nada.
    if (alt < 3000) {
      const surf = safeSurface(ctx, S.radialUp);
      if (surf && surf.normal && Number.isFinite(surf.normal.x)) S.groundNormal.copy(surf.normal).normalize();
      else S.groundNormal.copy(S.radialUp);
    } else {
      S.groundNormal.copy(S.radialUp);
    }
  } else {
    S.radialUp.set(0, 1, 0);
    S.altitude = Infinity;
    S.gravity = 0;
    S.density = 0;
    S.groundNormal.set(0, 1, 0);
  }

  p.up.copy(S.radialUp);
  p.groundNormal.copy(S.groundNormal);
  p.altitude = S.altitude;
  // O módulo `sky` tem a definição canônica (com histerese e eventos); só
  // escrevemos este campo quando ele não existe, para não brigarmos por ele.
  if (typeof ctx.sky?.inAtmosphere !== 'boolean') p.inAtmosphere = S.density > 0.015;
  S.speed = p.velocity.length();
}

// ── Rotação ─────────────────────────────────────────────────────────────────

/** Integra a velocidade angular na orientação (sem alocação). */
function integrateSpin(q, dt) {
  const w = S.angVel.length();
  if (w < 1e-7) return;
  _axis.copy(S.angVel).multiplyScalar(1 / w);
  _q1.setFromAxisAngle(_axis, w * dt);
  q.multiply(_q1).normalize();
}

// ── Voo da nave ─────────────────────────────────────────────────────────────

function updateShip(dt, ctx) {
  const p = ctx.player;
  const inp = ctx.input;
  const kd = S.density;                 // 0 = vácuo, 1 = ar denso
  const q = p.quaternion;

  _fwd.set(0, 0, -1).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  _shipUp.set(0, 1, 0).applyQuaternion(q);

  const throttle = inp.axis('throttle');
  const strafe = inp.axis('strafe');
  const lift = inp.axis('lift');
  const roll = inp.axis('roll');
  const pulse = inp.down('pulse') && !S.landed;
  const brake = inp.down('brake');

  // ── Momento angular ───────────────────────────────────────────────────────
  // Manobra cai com a densidade: no ar denso as superfícies mandam mais que os
  // propulsores de atitude.
  const manob = 1 - 0.42 * kd;
  S.angVel.x += -inp.axis('pitch') * MOUSE_IMPULSE * manob;
  S.angVel.y += -inp.axis('yaw') * MOUSE_IMPULSE * manob;
  S.angVel.z += -roll * ROLL_ACC * dt * manob;

  if (kd > 0.001 && S.speed > 8) {
    // Estabilidade de guinada/arfagem: a fuselagem "cata-vento" para o vetor
    // velocidade. Torque = eixo que leva o nariz até a velocidade, no corpo.
    _qInv.copy(q).invert();
    _localV.set(p.velocity.x, p.velocity.y, p.velocity.z).applyQuaternion(_qInv).normalize();
    const weather = kd * clamp(S.speed / 140, 0, 1) * 2.6 * dt;
    S.angVel.x += _localV.y * weather;
    S.angVel.y += -_localV.x * weather;
    // Nivelamento de asa contra o radial: sem isso voar reto exige correção
    // constante de rolagem sobre uma esfera.
    _v1.copy(S.radialUp).applyQuaternion(_qInv);
    S.angVel.z += -_v1.x * kd * 1.8 * dt;
  }

  const damp = (S.assist ? ASSIST_DAMP : FREE_DAMP) + kd * 2.4;
  S.angVel.multiplyScalar(Math.exp(-damp * dt));
  const wlen = S.angVel.length();
  if (wlen > ANG_MAX) S.angVel.multiplyScalar(ANG_MAX / wlen);
  integrateSpin(q, dt);

  // ── Acelerações: modelo espacial ─────────────────────────────────────────
  _accS.set(0, 0, 0);
  const maxV = pulse ? V_MAX_PULSE : V_MAX_SPACE;
  const along = p.velocity.dot(_fwd);
  // Limitador do motor (não é arrasto: no vácuo a inércia continua total).
  const headroom = clamp(1 - along / maxV, 0, 1);
  const mainT = pulse ? THRUST_PULSE : THRUST_SPACE;
  if (throttle > 0) _accS.addScaledVector(_fwd, mainT * throttle * headroom);
  else if (throttle < 0) _accS.addScaledVector(_fwd, THRUST_SPACE * 0.6 * throttle);
  _accS.addScaledVector(_right, strafe * RCS);
  _accS.addScaledVector(_shipUp, lift * RCS);

  const hasV = S.speed > 1e-4;
  if (hasV) _vhat.set(p.velocity.x / S.speed, p.velocity.y / S.speed, p.velocity.z / S.speed);
  else _vhat.set(0, 0, 0);
  if (brake && hasV) _accS.addScaledVector(_vhat, -Math.min(BRAKE, S.speed / Math.max(dt, 1e-4)));

  // ── Acelerações: modelo aerodinâmico ─────────────────────────────────────
  _accA.set(0, 0, 0);
  const atmoT = THRUST_ATMO * (pulse ? 2.4 : 1);
  _accA.addScaledVector(_fwd, atmoT * (throttle > 0 ? throttle : throttle * 0.6));
  _accA.addScaledVector(_right, strafe * RCS * 0.55);
  _accA.addScaledVector(_shipUp, lift * RCS * 0.7);
  if (hasV) {
    const dragA = DRAG_K * S.density * S.speed * S.speed + (brake ? BRAKE : 0);
    _accA.addScaledVector(_vhat, -Math.min(dragA, S.speed / Math.max(dt, 1e-4)));
    // Sustentação ~ ρ·v²·sen(α); α é o ângulo entre o nariz e a velocidade.
    const sinA = clamp(-_vhat.dot(_shipUp), -1, 1);
    let liftA = LIFT_K * S.density * S.speed * S.speed * sinA;
    const cap = S.gravity * 4 + 12;
    liftA = clamp(liftA, -cap, cap);
    _liftDir.copy(_shipUp).addScaledVector(_vhat, -_shipUp.dot(_vhat));
    if (_liftDir.lengthSq() > 1e-8) _accA.addScaledVector(_liftDir.normalize(), liftA);
  }

  // ── A transição É o lerp; nunca um ramo condicional ──────────────────────
  _acc.copy(_accS).lerp(_accA, kd);
  _acc.addScaledVector(S.radialUp, -S.gravity);

  // ── Pouso / decolagem ────────────────────────────────────────────────────
  const clearance = (S.shipApi?.gearClearance || 2.2) + 0.35;
  const landing = inp.down('land');

  // Assistência de solo: perto do terreno os retro-propulsores seguram o peso.
  // POR QUÊ: sem isso voar rasante vira raspar o chão a cada segundo, porque a
  // gravidade radial puxa a nave para dentro do relevo o tempo todo.
  const HOVER_BAND = 70;
  if (!S.landed && Number.isFinite(S.altitude) && S.altitude < HOVER_BAND) {
    const k = 1 - S.altitude / HOVER_BAND;
    const hover = S.gravity * k * (0.55 + 0.45 * kd) * (landing ? 0.25 : 1);
    _acc.addScaledVector(S.radialUp, hover);
    // Com o trem de pouso pedido, a nave também freia sozinha para assentar.
    if (landing) _acc.addScaledVector(S.radialUp, -3.2);
  }

  // O trem sai perto do solo mesmo em lua sem ar — senão não haveria como
  // pousar num corpo sem atmosfera.
  const gearWant = (S.landed || landing || S.altitude < 260) ? 1 : 0;
  S.gear += (gearWant - S.gear) * smooth(dt, 3.2);
  S.shipApi?.setGear(S.gear);

  if (S.landed) {
    // Decolagem: qualquer comando de subir/acelerar solta a nave do chão.
    if (throttle > 0.15 || lift > 0.15 || pulse) {
      S.landed = false;
      p.velocity.addScaled(S.radialUp, 7);
      ctx.events.emit('planet:takeoff', { planet: S.body });
    } else {
      // Fica colado: o terreno pode chegar por streaming e mudar de altura.
      p.velocity.set(0, 0, 0);
      if (Number.isFinite(S.altitude)) {
        p.position.addScaled(S.radialUp, (clearance - S.altitude) * smooth(dt, 6));
      }
      alignToGround(q, dt);
    }
  } else {
    p.velocity.addScaled(_acc, dt);
    p.position.addScaled(p.velocity, dt);

    const vRad = p.velocity.dot(S.radialUp);
    if (Number.isFinite(S.altitude) && S.altitude <= clearance) {
      // Regra dura: o casco nunca entra no terreno.
      p.position.addScaled(S.radialUp, clearance - S.altitude);
      if (vRad < 0) p.velocity.addScaled(S.radialUp, -vRad);
      const tangential = p.velocity.length();
      const impact = -vRad;
      // vRad < 1.5 impede que a nave "pouse" no mesmo instante em que decola.
      if (tangential < 14 && vRad < 1.5 && S.gear > 0.45 && impact < 30) {
        // Toque válido: assenta, zera tudo e avisa o resto do jogo.
        p.velocity.set(0, 0, 0);
        S.angVel.set(0, 0, 0);
        S.landed = true;
        S.gear = 1;
        _d2.copy(p.position);
        ctx.events.emit('planet:land', { planet: S.body, position: _d2.clone() });
      } else {
        // Raspão: atrito, sem atravessar; só machuca se a descida foi violenta.
        p.velocity.multiplyScalar(0.985);
        if (impact > 34) {
          p.velocity.multiplyScalar(0.5);
          ctx.events.emit('player:damage', { amount: Math.min(35, impact * 0.4), source: 'impact' });
        }
      }
    }
  }

  p.onGround = S.landed;
  S.thrustVis += (clamp(Math.abs(throttle) + (pulse ? 1 : 0), 0, 1) - S.thrustVis) * smooth(dt, 6);
  S.shipApi?.setThrust(S.thrustVis);

  // ── Warp entre sistemas ──────────────────────────────────────────────────
  if (inp.pressed('warp') && !S.warping && ctx.universe?.warpTo) {
    const idx = (ctx.universe.current?.index ?? 0) + 1;
    S.warping = true;
    Promise.resolve()
      .then(() => ctx.universe.warpTo(idx))
      .catch(() => {})
      .then(() => { S.warping = false; });
  }
}

/** Alinha suavemente a nave pousada à normal do terreno, preservando a proa. */
function alignToGround(q, dt) {
  _v1.set(0, 0, -1).applyQuaternion(q);
  _v1.addScaledVector(S.groundNormal, -_v1.dot(S.groundNormal));
  if (_v1.lengthSq() < 1e-6) _v1.set(1, 0, 0).addScaledVector(S.groundNormal, -S.groundNormal.x);
  _v1.normalize();
  _v2.crossVectors(_v1, S.groundNormal).normalize();   // "direita"
  _v3.copy(_v1).multiplyScalar(-1);                    // three olha para -Z
  _m4.makeBasis(_v2, S.groundNormal, _v3);
  _q1.setFromRotationMatrix(_m4);
  q.slerp(_q1, smooth(dt, 2.4));
}

// ── Jogador a pé ────────────────────────────────────────────────────────────

function updateFoot(dt, ctx) {
  const p = ctx.player;
  const inp = ctx.input;

  // Olhar: guinada em torno do radial, arfagem limitada. A direção de proa é
  // transportada paralelamente para sobreviver ao caminhar sobre a esfera.
  S.heading.addScaledVector(S.radialUp, -S.heading.dot(S.radialUp));
  if (S.heading.lengthSq() < 1e-8) arbitraryTangent(S.radialUp, S.heading);
  S.heading.normalize();
  const yaw = -inp.axis('yaw');
  if (yaw !== 0) S.heading.applyAxisAngle(S.radialUp, yaw);
  S.pitch = clamp(S.pitch - inp.axis('pitch'), -1.45, 1.45);

  _right.crossVectors(S.heading, S.radialUp).normalize();
  _fwd.copy(S.heading).applyAxisAngle(_right, S.pitch);
  buildLook(p.quaternion, _fwd, S.radialUp);

  // Movimento tangencial relativo ao olhar.
  const throttle = inp.axis('throttle');
  const strafe = inp.axis('strafe');
  const sprint = inp.down('sprint') && throttle > 0.1;
  const wish = sprint ? RUN : WALK;
  _v1.copy(S.heading).multiplyScalar(throttle).addScaledVector(_right, strafe);
  const wl = _v1.length();
  if (wl > 1) _v1.multiplyScalar(1 / wl);
  _v1.multiplyScalar(wish);

  const grounded = Number.isFinite(S.altitude) && S.altitude <= EYE + 0.12;
  const vRad = p.velocity.dot(S.radialUp);

  // Decompõe: componente tangencial persegue o desejo, radial obedece à física.
  _v2.set(p.velocity.x, p.velocity.y, p.velocity.z).addScaledVector(S.radialUp, -vRad);
  const accel = grounded ? 24 : 4.5;
  _v2.lerp(_v1, clamp(accel * dt, 0, 1));

  let newRad = vRad - S.gravity * dt;
  S.jetOn = false;
  if (grounded && inp.pressed('jump')) {
    newRad = JUMP_V;
  } else if (!grounded && inp.down('jump') && p.energy > 0.5) {
    // Jetpack: sobe enquanto houver energia; é o que torna o terreno vertical
    // navegável a pé sem trapacear a gravidade.
    newRad += JET_ACC * dt;
    p.energy = Math.max(0, p.energy - JET_DRAIN * dt);
    S.jetOn = true;
  }
  if (grounded && !S.jetOn) p.energy = Math.min(100, p.energy + ENERGY_REGEN * dt);

  p.velocity.set(_v2.x, _v2.y, _v2.z).addScaled(S.radialUp, newRad);
  p.position.addScaled(p.velocity, dt);

  // Colisão com o terreno: o olho nunca desce abaixo de EYE.
  const altNow = safeAlt(ctx, p.position);
  const alt = Number.isFinite(altNow) ? altNow : S.altitude;
  if (Number.isFinite(alt) && alt < EYE) {
    p.position.addScaled(S.radialUp, EYE - alt);
    const vr = p.velocity.dot(S.radialUp);
    if (vr < 0) p.velocity.addScaled(S.radialUp, -vr);
    p.onGround = true;
    S.altitude = EYE;
  } else {
    p.onGround = grounded;
    if (Number.isFinite(alt)) S.altitude = alt;
  }
  p.altitude = S.altitude;
}

/** Tangente qualquer estável para um dado 'up'. */
function arbitraryTangent(up, out) {
  if (Math.abs(up.y) > 0.92) out.set(1, 0, 0);
  else out.set(0, 1, 0);
  out.crossVectors(out, up).normalize();
  return out;
}

/** Constrói um quaternion "olhando para fwd com up" (three olha para -Z). */
function buildLook(qOut, fwd, up) {
  _v1.copy(fwd).normalize();
  _v2.copy(up).normalize();
  _axis.crossVectors(_v1, _v2).normalize();          // right
  if (_axis.lengthSq() < 1e-8) return qOut;
  _v2.crossVectors(_axis, _v1).normalize();          // up ortogonalizado
  _v1.multiplyScalar(-1);                            // -forward para a base
  _m4.makeBasis(_axis, _v2, _v1);
  qOut.setFromRotationMatrix(_m4);
  return qOut;
}

// ── Transição nave ⇄ pé ─────────────────────────────────────────────────────

function checkEmbark(ctx) {
  if (!ctx.input.pressed('exitShip')) return;
  if (S.mode === 'ship') {
    if (!S.landed && S.altitude > 6) return;   // só desembarca com a nave no chão
    setMode('foot');
  } else {
    const d = ctx.player.position.distanceTo(S.shipPos);
    if (d < 45) setMode('ship');
  }
}

/** Estaciona a nave ao lado do jogador, assentada no terreno. */
function parkShipNear(ctx, pos) {
  arbitraryTangent(S.radialUp, _v1);
  S.shipPos.copy(pos).addScaled(_v1, 16);
  const clearance = (S.shipApi?.gearClearance || 2.2) + 0.35;
  const alt = safeAlt(ctx, S.shipPos);
  if (Number.isFinite(alt)) S.shipPos.addScaled(S.radialUp, clearance - alt);
  else S.shipPos.addScaled(S.radialUp, clearance - EYE);
  arbitraryTangent(S.radialUp, _v2);
  buildLook(S.shipQuat, _v2, S.radialUp);
  S.gear = 1;
  S.shipApi?.setGear(1);
  S.landed = true;
}

// ── Câmera ──────────────────────────────────────────────────────────────────

function updateCamera(dt, ctx) {
  const p = ctx.player;

  // Roda do mouse aproxima/afasta; colada na nave vira primeira pessoa.
  if (ctx.input.mouse.wheel !== 0 && S.mode === 'ship') {
    S.camDist = clamp(S.camDist + ctx.input.mouse.wheel * 2.5, 0, 40);
  }

  if (S.poseHold) {
    // Pose do arnês: a câmera É a posição do jogador, orientação intocada.
    S.camWorld.copy(p.position);
  } else if (S.mode === 'foot') {
    S.camWorld.copy(p.position);       // position já é o olho (1,7 m)
    S.camQ.copy(p.quaternion);
  } else if (isFirstPerson(ctx)) {
    // Assento do cockpit: âncora rígida, sem mola (senão a UI 3D nada).
    _v1.copy(S.shipApi.anchors.cockpitSeat.position).applyQuaternion(S.shipQuat);
    S.camWorld.copy(S.shipPos).add(_v1);
    S.camQ.copy(S.shipQuat);
  } else {
    // Terceira pessoa: mola amortecida atrás/acima + recuo pelo vetor de
    // velocidade (a nave "puxa" o quadro quando acelera).
    _v1.set(0, 2.6 + S.camDist * 0.07, S.camDist).applyQuaternion(S.shipQuat);
    _d1.copy(S.shipPos).add(_v1);
    if (S.speed > 1) {
      const k = Math.min(S.speed * 0.035, 7);
      _d1.addScaled(_vhat, -k);
    }
    const a = smooth(dt, CAM_SPRING);
    if (S.camWorld.distanceToSq(_d1) > 4e6) S.camWorld.copy(_d1);  // pós-teleporte
    else S.camWorld.lerp(_d1, a);
    S.camQ.slerp(S.shipQuat, smooth(dt, CAM_TURN));
  }

  // FOV cresce com a velocidade — o único jeito barato de fazer 20 km/s parecer
  // 20 km/s.
  const norm = clamp(S.speed / (V_MAX_SPACE * 0.9), 0, 1);
  S.boostFactor += (Math.max(norm, ctx.input.down('pulse') ? 0.4 : 0) - S.boostFactor) * smooth(dt, 2.2);
  const targetFov = FOV_BASE + FOV_GAIN * S.boostFactor * (S.mode === 'ship' ? 1 : 0);
  S.fov += (targetFov - S.fov) * smooth(dt, 2.5);

  // Reentrada: ar denso + velocidade alta = tremor.
  const reentry = clamp((S.density * S.speed - 90) / 420, 0, 1);
  S.shake += (reentry - S.shake) * smooth(dt, 3.5);

  _camFinal.copy(S.camQ);
  if (S.shake > 0.003 && !S.poseHold) {
    const t = ctx.time.elapsed;
    const amp = S.shake * 0.016;
    _eul.set(
      Math.sin(t * 37.1) * amp + Math.sin(t * 71.3) * amp * 0.5,
      Math.sin(t * 29.7) * amp + Math.sin(t * 83.9) * amp * 0.4,
      Math.sin(t * 43.3) * amp * 0.6, 'XYZ',
    );
    _q2.setFromEuler(_eul);
    _camFinal.multiply(_q2);
  }
}

function isFirstPerson(ctx) {
  return S.mode === 'ship' && S.camDist < 1.5 && !!S.shipApi?.anchors?.cockpitSeat;
}

// ── Escrita no grafo de cena (sempre relativa à origem flutuante) ───────────

function syncTransforms(ctx) {
  if (!S.ready) return;
  const f = ctx.frame;
  const p = ctx.player;

  if (S.mode === 'ship') {
    if (S.poseHold) {
      // Na pose travada quem manda é a câmera. Com cockpit presente a nave
      // externa some (o interior é do módulo `cockpit`); sem ele, colocamos a
      // nave à frente/abaixo para o enquadramento clássico de terceira pessoa.
      if (ctx.cockpit) {
        S.shipPos.copy(p.position);
        S.shipQuat.copy(p.quaternion);
      } else {
        // Mesmo enquadramento da terceira pessoa em jogo (a nave tem ~17 m).
        _v1.set(0, -2.6, -S.camDist).applyQuaternion(p.quaternion);
        S.shipPos.copy(p.position).add(_v1);
        S.shipQuat.copy(p.quaternion);
      }
    } else {
      S.shipPos.copy(p.position);
      S.shipQuat.copy(p.quaternion);
    }
  }

  const ship = S.ship;
  ship.position.copy(f.toLocal(S.shipPos, _v1));
  ship.quaternion.copy(S.shipQuat);
  // Em primeira pessoa com cockpit dedicado o casco externo só atrapalha.
  ship.visible = !(S.mode === 'ship' && ctx.cockpit && (isFirstPerson(ctx) || S.poseHold));
  ship.updateMatrixWorld(true);

  const cam = ctx.engine.camera;
  cam.position.copy(f.toLocal(S.camWorld, _v1));
  cam.quaternion.copy(_camFinal);
  if (Math.abs(cam.fov - S.fov) > 0.05) { cam.fov = S.fov; cam.updateProjectionMatrix(); }
  cam.updateMatrixWorld(true);
}

// ── Pose travada ────────────────────────────────────────────────────────────

/** Qualquer comando real do jogador devolve o controle à física. */
function releaseHoldIfPlayerActs(ctx) {
  if (!S.poseHold) return;
  const i = ctx.input;
  if (
    Math.abs(i.axis('throttle')) > 0.01 || Math.abs(i.axis('strafe')) > 0.01 ||
    Math.abs(i.axis('lift')) > 0.01 || Math.abs(i.axis('roll')) > 0.01 ||
    i.mouse.dx !== 0 || i.mouse.dy !== 0 ||
    i.down('pulse') || i.down('brake') || i.pressed('exitShip') || i.pressed('land')
  ) {
    S.poseHold = false;
    // A câmera precisa reencontrar a nave sem um salto brusco.
    if (S.mode === 'ship') S.shipPos.copy(ctx.player.position);
  }
}

/** Física reduzida usada enquanto a pose está travada: só deriva balística. */
function coastWhileHeld(dt, ctx) {
  const p = ctx.player;
  if (S.speed > 1e-6) p.position.addScaled(p.velocity, dt);
  S.thrustVis += ((S.speed > 40 ? 0.55 : 0.12) - S.thrustVis) * smooth(dt, 4);
  S.shipApi?.setThrust(S.thrustVis);
  const gearWant = S.mode === 'foot' || (Number.isFinite(S.altitude) && S.altitude < 260) ? 1 : 0;
  S.gear += (gearWant - S.gear) * smooth(dt, 4);
  S.shipApi?.setGear(S.gear);
}

// ── API pública ─────────────────────────────────────────────────────────────

function setMode(mode) {
  const ctx = S.ctx;
  if (!ctx || (mode !== 'ship' && mode !== 'foot') || mode === S.mode) return;
  const p = ctx.player;

  if (mode === 'foot') {
    // Desembarque: a nave fica onde está; o jogador aparece ao lado dela.
    S.shipPos.copy(p.position);
    S.shipQuat.copy(p.quaternion);
    arbitraryTangent(S.radialUp, _v1);
    p.position.copy(S.shipPos).addScaled(_v1, -6);
    const alt = safeAlt(ctx, p.position);
    if (Number.isFinite(alt)) p.position.addScaled(S.radialUp, EYE - alt);
    p.velocity.set(0, 0, 0);
    S.heading.set(0, 0, -1).applyQuaternion(S.shipQuat);
    S.heading.addScaledVector(S.radialUp, -S.heading.dot(S.radialUp));
    if (S.heading.lengthSq() < 1e-8) arbitraryTangent(S.radialUp, S.heading);
    S.heading.normalize();
    S.pitch = 0;
    buildLook(p.quaternion, S.heading, S.radialUp);
    S.landed = true;
    S.gear = 1;
    S.shipApi?.setGear(1);
  } else {
    // Embarque: o jogador some dentro da nave.
    p.position.copy(S.shipPos);
    p.quaternion.copy(S.shipQuat);
    p.velocity.set(0, 0, 0);
    S.angVel.set(0, 0, 0);
  }

  S.mode = mode;
  p.mode = mode;
  S.camWorld.copy(p.position);
  S.camQ.copy(p.quaternion);
  _camFinal.copy(p.quaternion);
  ctx.events.emit('player:modeChange', { mode });
  syncTransforms(ctx);
}

function setOrientation(q) {
  const ctx = S.ctx;
  if (!ctx || !q) return;
  ctx.player.quaternion.copy(q);
  S.shipQuat.copy(q);
  S.camQ.copy(q);
  _camFinal.copy(q);
  S.angVel.set(0, 0, 0);
  // A pé, reconstrói proa/arfagem a partir do quaternion para não brigar com
  // o olhar no primeiro frame depois da pose.
  _v1.set(0, 0, -1).applyQuaternion(q);
  S.pitch = Math.asin(clamp(_v1.dot(S.radialUp), -1, 1));
  S.heading.copy(_v1).addScaledVector(S.radialUp, -_v1.dot(S.radialUp));
  if (S.heading.lengthSq() < 1e-8) arbitraryTangent(S.radialUp, S.heading);
  S.heading.normalize();
  S.poseHold = true;
  syncTransforms(ctx);
}

function teleport(worldPos, quaternion) {
  const ctx = S.ctx;
  if (!ctx || !worldPos) return;
  const p = ctx.player;
  p.position.copy(worldPos);
  if (quaternion) {
    p.quaternion.copy(quaternion);
    S.shipQuat.copy(quaternion);
    S.camQ.copy(quaternion);
    _camFinal.copy(quaternion);
  } else {
    // Sem orientação pedida: é um reposicionamento "limpo" — zera a inércia.
    p.velocity.set(0, 0, 0);
    S.angVel.set(0, 0, 0);
  }
  S.landed = false;
  S.poseHold = true;
  readWorld(ctx);
  if (S.mode === 'ship') {
    S.shipPos.copy(p.position);
  } else {
    parkShipNear(ctx, p.position);
  }
  S.camWorld.copy(p.position);
  syncTransforms(ctx);
}

// ── Ciclo de vida ───────────────────────────────────────────────────────────

export async function init(ctx) {
  S.ctx = ctx;

  // A nave também é conteúdo procedural: deriva da seed do universo.
  S.shipApi = createShip(ctx.rng.derive('ship', 0));
  S.ship = S.shipApi.root;
  S.ship.frustumCulled = false;         // fica sempre perto da câmera
  ctx.engine.scene.add(S.ship);

  // Ponto de partida: aproximação orbital do primeiro corpo sólido do sistema,
  // que é o enquadramento onde a curvatura do planeta se lê de imediato.
  const sys = ctx.universe?.current || ctx.universe?.getSystem?.(0);
  const body = (sys?.bodies || []).find((b) => b && b.type !== 'gas') || (sys?.bodies || [])[0];
  const p = ctx.player;
  if (body?.center) {
    const rng = ctx.rng.derive('spawn', 0);
    const dir = rng.onSphere();
    const r = body.radius * 1.22;
    p.position.set(body.center.x + dir.x * r, body.center.y + dir.y * r, body.center.z + dir.z * r);
    _v1.set(dir.x, dir.y, dir.z);
    arbitraryTangent(_v1, _v2);
    // Voa tangente com o planeta na parte de baixo do quadro.
    _fwd.copy(_v2).addScaledVector(_v1, -0.28).normalize();
    buildLook(p.quaternion, _fwd, _v1);
    p.velocity.set(_v2.x * 180, _v2.y * 180, _v2.z * 180);
  }
  p.mode = S.mode;
  S.shipPos.copy(p.position);
  S.shipQuat.copy(p.quaternion);
  S.camQ.copy(p.quaternion);
  _camFinal.copy(p.quaternion);
  // Já nasce no lugar da terceira pessoa; senão o primeiro meio segundo é a
  // câmera saindo de dentro do casco.
  _v1.set(0, 2.6 + S.camDist * 0.07, S.camDist).applyQuaternion(p.quaternion);
  S.camWorld.copy(p.position).add(_v1);
  ctx.frame.rebaseTo(p.position);

  // O rebase mexe a origem do mundo inteiro: reescrevemos nave e câmera na hora
  // para não existir um frame com a nave a 2 km de distância.
  ctx.events.on('frame:rebase', () => { try { syncTransforms(ctx); } catch (e) { /* degradação graciosa */ } });

  S.ready = true;
  readWorld(ctx);
  syncTransforms(ctx);

  ctx.provide(id, {
    get speed() { return S.speed; },
    get boostFactor() { return S.boostFactor; },
    get ship() { return S.ship; },
    get mode() { return S.mode; },
    get landed() { return S.landed; },
    get airDensity() { return S.density; },
    get gravity() { return S.gravity; },
    anchors: S.shipApi.anchors,
    model: S.shipApi,
    teleport,
    setMode,
    setOrientation,
    /** 0 = primeira pessoa (cockpit), >0 = distância de terceira pessoa. */
    setView(dist) { S.camDist = clamp(dist, 0, 40); },
    setAssist(on) { S.assist = !!on; },
    dispose() { S.shipApi?.dispose(); },
  });
}

export function update(dt, ctx) {
  if (!S.ready) return;
  releaseHoldIfPlayerActs(ctx);
  readWorld(ctx);

  if (S.poseHold) {
    coastWhileHeld(dt, ctx);
  } else {
    checkEmbark(ctx);
    if (S.mode === 'ship') updateShip(dt, ctx);
    else updateFoot(dt, ctx);
  }

  // ctx.flight.speed é lido pelo HUD e pelo postfx no mesmo frame.
  S.speed = ctx.player.velocity.length();

  // A câmera precisa da pose da nave DESTE frame, senão fica um frame atrás
  // e a nave "nada" dentro do quadro em curvas rápidas.
  if (S.mode === 'ship' && !S.poseHold) {
    S.shipPos.copy(ctx.player.position);
    S.shipQuat.copy(ctx.player.quaternion);
  }

  updateCamera(dt, ctx);

  // Formatar número em string aloca; só fazemos isso com o overlay ligado.
  if (ctx.debug.enabled) {
    ctx.debug.set('modo', S.mode + (S.poseHold ? ' (pose)' : ''));
    ctx.debug.set('vel', S.speed > 999 ? (S.speed / 1000).toFixed(1) + ' km/s' : S.speed.toFixed(1) + ' m/s');
    ctx.debug.set('alt', Number.isFinite(S.altitude) ? Math.round(S.altitude) + ' m' : '—');
    ctx.debug.set('ar', S.density.toFixed(3));
    ctx.debug.set('g', S.gravity.toFixed(2) + ' m/s²');
    ctx.debug.set('pouso', S.landed ? 'sim' : 'não');
  }
}

export function lateUpdate(dt, ctx) {
  // Depois do rebase: só aqui as coordenadas relativas são válidas.
  syncTransforms(ctx);
}

export function dispose(ctx) {
  if (S.ship) ctx.engine.scene.remove(S.ship);
  S.shipApi?.dispose();
  S.ready = false;
}
