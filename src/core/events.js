/**
 * Barramento de eventos mínimo. Todo acoplamento entre sistemas passa por aqui
 * — nenhum módulo importa outro módulo de gameplay diretamente.
 *
 * Eventos canônicos (mantenha esta lista atualizada ao adicionar um novo):
 *
 *   boot:progress        {frac, label}
 *   boot:ready           {}
 *   game:start           {}
 *   game:pause           {paused}
 *
 *   frame:rebase         {shift, origin}
 *
 *   universe:seed        {seed}
 *   system:enter         {system}
 *   system:leave         {system}
 *   planet:approach      {planet}          // entrou na esfera de influência
 *   planet:enterAtmo     {planet}
 *   planet:leaveAtmo     {planet}
 *   planet:land          {planet, position}
 *   planet:takeoff       {planet}
 *   warp:begin           {from, to}
 *   warp:end             {system}
 *
 *   player:modeChange    {mode: 'ship'|'foot'}
 *   player:damage        {amount, source}
 *   player:death         {cause}
 *
 *   terrain:chunkReady   {node}
 *   terrain:edit         {center, radius, delta}
 *
 *   tool:fire            {tool, target}
 *   mining:hit           {resource, amount, position}
 *   scan:ping            {position, radius}
 *   discovery:new        {kind, id, name}
 *
 *   inventory:change     {slot, item, count}
 *   craft:done           {recipe}
 *
 *   combat:hit           {attacker, victim, damage}
 *   sentinel:alert       {level}
 *
 *   audio:cue            {name, params}
 *   music:mood           {mood, intensity}
 *
 *   ui:notify            {text, kind}
 */
export class EventBus {
  constructor() { this._map = new Map(); this._any = []; }

  on(type, fn) {
    let arr = this._map.get(type);
    if (!arr) { arr = []; this._map.set(type, arr); }
    arr.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const un = this.on(type, (p) => { un(); fn(p); });
    return un;
  }

  off(type, fn) {
    const arr = this._map.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  /** Escuta tudo — para debug e para o auditor de performance. */
  onAny(fn) { this._any.push(fn); return () => { const i = this._any.indexOf(fn); if (i >= 0) this._any.splice(i, 1); }; }

  emit(type, payload) {
    const arr = this._map.get(type);
    if (arr) {
      // cópia defensiva: handlers podem se desinscrever durante o despacho
      const snapshot = arr.slice();
      for (let i = 0; i < snapshot.length; i++) {
        try { snapshot[i](payload, type); }
        catch (e) { console.error(`[events] handler de "${type}" falhou:`, e); }
      }
    }
    for (let i = 0; i < this._any.length; i++) {
      try { this._any[i](payload, type); } catch (e) { /* ignora */ }
    }
  }

  clear() { this._map.clear(); this._any.length = 0; }
}
