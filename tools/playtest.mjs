/**
 * Teste de jogabilidade: simula input real e verifica se o jogo RESPONDE.
 * Não julga beleza — julga se dá para jogar.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const s = spawn(process.execPath, ['tools/serve.mjs','8355'], {stdio:'ignore'});
await new Promise(r=>setTimeout(r,600));
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:900,height:500}});
p.setDefaultTimeout(240000);
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); 
await p.goto('http://localhost:8355/?auto=1&seed=AETHER-PRIME&q=medium',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__AETHER__?.ready===true,null,{timeout:240000});

// deixa o terreno carregar sob o jogador
await p.evaluate(async()=>{
  const c=window.__AETHER__;
  if (c.universe) c.universe.timeScale=0;
  const body=c.planet?.current; if(!body) return;
  const THREE=c.THREE;
  const dir=new THREE.Vector3(0.31,0.5,0.81).normalize();
  const r=body.radius+(c.planet.sampleHeight?.(dir)||0)+2;
  const {Vec3d}=await import('/src/core/frame.js');
  const pos=new Vec3d(body.center.x+dir.x*r, body.center.y+dir.y*r, body.center.z+dir.z*r);
  c.flight?.setMode?.('foot'); c.flight?.teleport?.(pos,null); c.frame.rebaseTo(pos);
  await c.planet?.waitReady?.(pos, 90000);
});
await new Promise(r=>setTimeout(r,4000));

async function snap(){ return p.evaluate(()=>{const c=window.__AETHER__;return{
  x:c.player.position.x,y:c.player.position.y,z:c.player.position.z,
  alt:c.player.altitude, mode:c.player.mode, onGround:c.player.onGround,
  spd:Math.hypot(c.player.velocity.x,c.player.velocity.y,c.player.velocity.z), fps:c.engine.stats.fps};});}

const R={};
// ── 1. andar a pé ──
const a0=await snap();
await p.keyboard.down('KeyW'); await new Promise(r=>setTimeout(r,4000)); await p.keyboard.up('KeyW');
const a1=await snap();
R.andar={ distancia_m:+Math.hypot(a1.x-a0.x,a1.y-a0.y,a1.z-a0.z).toFixed(1),
  alt_antes:+a0.alt.toFixed(2), alt_depois:+a1.alt.toFixed(2), noChao:a1.onGround, vel:+a1.spd.toFixed(1)};

// ── 2. pulo / jetpack ──
await p.keyboard.down('Space'); await new Promise(r=>setTimeout(r,1200)); await p.keyboard.up('Space');
const j1=await snap(); await new Promise(r=>setTimeout(r,2500)); const j2=await snap();
R.pulo={ alt_no_topo:+j1.alt.toFixed(2), alt_apos_queda:+j2.alt.toFixed(2), voltou_ao_chao:j2.onGround };

// ── 3. entrar na nave e acelerar ──
await p.evaluate(()=>window.__AETHER__.flight?.setMode?.('ship'));
await new Promise(r=>setTimeout(r,500));
const s0=await snap();
await p.keyboard.down('KeyW'); await new Promise(r=>setTimeout(r,5000));
const s1=await snap(); await p.keyboard.up('KeyW');
R.voo={ modo:s1.mode, vel_inicial:+s0.spd.toFixed(1), vel_apos_5s:+s1.spd.toFixed(1),
  subiu_m:+(s1.alt-s0.alt).toFixed(0) };

R.fps_medio=+(await snap()).fps.toFixed(1);
R.erros_de_pagina=errs.slice(0,3);
console.log(JSON.stringify(R,null,1));
await b.close(); s.kill();
