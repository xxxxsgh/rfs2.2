/**
 * Entrada unificada: teclado + mouse + gamepad + toque.
 * Expõe ações abstratas para que os módulos nunca leiam teclas cruas.
 *
 *   input.axis('pitch')   -> -1..1
 *   input.down('boost')   -> bool  (estado)
 *   input.pressed('land') -> bool  (borda de subida deste frame)
 *   input.mouse.dx/dy     -> delta do frame quando em pointer lock
 */

const KEYMAP = {
  // eixos
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight'],
  rollLeft: ['KeyQ'],
  rollRight: ['KeyE'],
  // botões
  boost: ['ShiftLeft'],
  brake: ['KeyC'],
  jump: ['Space'],
  sprint: ['ShiftLeft'],
  fire: ['Mouse0'],
  altFire: ['Mouse2'],
  scan: ['KeyF'],
  land: ['KeyL'],
  warp: ['KeyJ'],
  pulse: ['KeyX'],
  exitShip: ['KeyG'],
  inventory: ['Tab'],
  galaxyMap: ['KeyM'],
  build: ['KeyB'],
  toolNext: ['KeyR'],
  interact: ['KeyE'],
  photo: ['KeyP'],
  pause: ['Escape'],
  debug: ['Backquote'],
};

export class Input {
  constructor(target = window, canvasEl = null) {
    this.target = target;
    this.canvas = canvasEl;
    this.keys = new Set();
    this._prevKeys = new Set();
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, locked: false, buttons: 0 };
    this.touch = { active: false, look: { x: 0, y: 0 }, move: { x: 0, y: 0 } };
    this.gamepadIndex = null;
    this.gamepadDeadzone = 0.14;
    this.enabled = true;
    this.invertY = false;
    this.lookSensitivity = 0.0022;
    this._bind();
  }

  _bind() {
    const t = this.target;
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      // Não sequestra atalhos do navegador com modificadores.
      if (e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); this.mouse.buttons = 0; };
    this._onMouseMove = (e) => {
      if (this.mouse.locked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    this._onMouseDown = (e) => { this.keys.add('Mouse' + e.button); this.mouse.buttons |= (1 << e.button); };
    this._onMouseUp = (e) => { this.keys.delete('Mouse' + e.button); this.mouse.buttons &= ~(1 << e.button); };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => { this.mouse.locked = !!document.pointerLockElement; };
    this._onCtx = (e) => e.preventDefault();

    t.addEventListener('keydown', this._onKeyDown);
    t.addEventListener('keyup', this._onKeyUp);
    t.addEventListener('blur', this._onBlur);
    t.addEventListener('mousemove', this._onMouseMove);
    t.addEventListener('mousedown', this._onMouseDown);
    t.addEventListener('mouseup', this._onMouseUp);
    t.addEventListener('wheel', this._onWheel, { passive: true });
    t.addEventListener('contextmenu', this._onCtx);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestPointerLock() {
    const el = this.canvas || document.body;
    if (el.requestPointerLock) el.requestPointerLock();
  }
  exitPointerLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  _any(list) { for (let i = 0; i < list.length; i++) if (this.keys.has(list[i])) return true; return false; }

  /** Estado atual de uma ação. */
  down(action) {
    const list = KEYMAP[action];
    if (list && this._any(list)) return true;
    return this._gamepadButton(action);
  }

  /** Borda de subida: verdadeiro apenas no frame em que a ação começou. */
  pressed(action) {
    const list = KEYMAP[action];
    if (!list) return false;
    const now = this._any(list) || this._gamepadButton(action);
    const before = list.some((k) => this._prevKeys.has(k)) || this._prevGamepad?.has(action);
    return now && !before;
  }

  /** Eixo bipolar composto por duas ações. */
  pair(negAction, posAction) {
    return (this.down(posAction) ? 1 : 0) - (this.down(negAction) ? 1 : 0);
  }

  /** Eixos nomeados de alto nível, já somando gamepad e toque. */
  axis(name) {
    const gp = this._gamepad();
    const dz = (v) => (Math.abs(v) < this.gamepadDeadzone ? 0 : (v - Math.sign(v) * this.gamepadDeadzone) / (1 - this.gamepadDeadzone));
    switch (name) {
      case 'throttle': {
        let v = this.pair('back', 'forward');
        if (gp) v += dz(-gp.axes[1] || 0);
        if (this.touch.active) v += this.touch.move.y;
        return clamp(v, -1, 1);
      }
      case 'strafe': {
        let v = this.pair('left', 'right');
        if (gp) v += dz(gp.axes[0] || 0);
        if (this.touch.active) v += this.touch.move.x;
        return clamp(v, -1, 1);
      }
      case 'lift': {
        let v = (this.down('up') ? 1 : 0) - (this.down('down') ? 1 : 0);
        if (gp) v += ((gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0));
        return clamp(v, -1, 1);
      }
      case 'roll': {
        let v = this.pair('rollLeft', 'rollRight');
        if (gp) v += dz(gp.axes[2] || 0) * 0.6;
        return clamp(v, -1, 1);
      }
      case 'yaw': {
        let v = this.mouse.locked ? this.mouse.dx * this.lookSensitivity : 0;
        if (gp) v += dz(gp.axes[2] || 0) * 0.05;
        if (this.touch.active) v += this.touch.look.x * 0.05;
        return v;
      }
      case 'pitch': {
        let v = this.mouse.locked ? this.mouse.dy * this.lookSensitivity * (this.invertY ? -1 : 1) : 0;
        if (gp) v += dz(gp.axes[3] || 0) * 0.05 * (this.invertY ? -1 : 1);
        if (this.touch.active) v += this.touch.look.y * 0.05;
        return v;
      }
      default: return 0;
    }
  }

  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) return pads[i];
    return null;
  }

  _gamepadButton(action) {
    const gp = this._gamepad();
    if (!gp) return false;
    const B = { fire: 7, altFire: 6, boost: 0, jump: 0, scan: 2, land: 3, interact: 2, inventory: 9, galaxyMap: 8, pulse: 1, brake: 1 };
    const idx = B[action];
    if (idx === undefined) return false;
    const b = gp.buttons[idx];
    return !!b && (b.pressed || b.value > 0.5);
  }

  /** Chame ao FIM de cada frame do jogo. */
  endFrame() {
    this._prevKeys = new Set(this.keys);
    this._prevGamepad = new Set(Object.keys(KEYMAP).filter((a) => this._gamepadButton(a)));
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }

  dispose() {
    const t = this.target;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    t.removeEventListener('mousemove', this._onMouseMove);
    t.removeEventListener('mousedown', this._onMouseDown);
    t.removeEventListener('mouseup', this._onMouseUp);
    t.removeEventListener('wheel', this._onWheel);
    t.removeEventListener('contextmenu', this._onCtx);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export { KEYMAP };
