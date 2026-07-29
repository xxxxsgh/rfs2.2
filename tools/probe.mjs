import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const s = spawn(process.execPath, ['tools/serve.mjs','8321'], {stdio:'ignore'});
await new Promise(r=>setTimeout(r,500));
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:800,height:450}});
p.on('pageerror', e=>console.error('PAGEERROR', e.message.slice(0,200)));
await p.goto('http://localhost:8321/?auto=1&seed=AETHER-PRIME&q=high',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__AETHER__?.ready===true,null,{timeout:240000});
const out = await p.evaluate(async () => {
  const c = window.__AETHER__;
  const THREE = c.THREE;
  const r = {};
  const body = c.planet?.current;
  r.body = body ? {name:body.name, radiusKm:(body.radius/1000).toFixed(1), type:body.type,
    biome:body.biome?.id, amplitude:body.biome?.terrain?.amplitude, seaLevel:body.biome?.terrain?.seaLevel,
    center:[body.center.x,body.center.y,body.center.z].map(v=>v.toExponential(2))} : null;
  r.seaLevelRadius = c.planet?.seaLevelRadius;
  // amostra de altura em várias direções
  const dirs=[[1,0,0],[0,1,0],[0,0,1],[0.577,0.577,0.577]];
  r.heights = dirs.map(d=>{const v=new THREE.Vector3(...d).normalize(); return {d, h: c.planet?.sampleHeight?.(v)};});
  // executa a pose
  let poseErr=null;
  try { r.shotMeta = await c.shot('surface_horizon'); } catch(e){ poseErr=String(e.message); }
  r.poseErr = poseErr;
  r.player = {mode:c.player.mode, alt:c.player.altitude,
    pos:[c.player.position.x,c.player.position.y,c.player.position.z].map(v=>v.toExponential(3)),
    distToCenter: body ? (Math.hypot(c.player.position.x-body.center.x,c.player.position.y-body.center.y,c.player.position.z-body.center.z)).toFixed(0) : null};
  r.origin=[c.frame.origin.x,c.frame.origin.y,c.frame.origin.z].map(v=>v.toExponential(3));
  // inventário da cena próxima
  const counts={}; const chunkInfo=[];
  c.engine.scene.traverse(o=>{ if(o.isMesh||o.isPoints||o.isInstancedMesh){
    const k=o.name||o.type; counts[k]=(counts[k]||0)+1;
    if(/chunk|terrain|patch/i.test(o.name||'') && chunkInfo.length<5){
      o.geometry.computeBoundingSphere();
      chunkInfo.push({name:o.name, visible:o.visible, pos:o.position.toArray().map(v=>v.toFixed(0)),
        bs:o.geometry.boundingSphere?.radius?.toFixed(1), verts:o.geometry.attributes.position?.count});
    }}});
  r.sceneCounts=counts; r.chunks=chunkInfo;
  r.camDist = c.engine.camera.position.length().toFixed(1);
  r.sun = c.sky?.sunDirection ? c.sky.sunDirection.toArray().map(v=>v.toFixed(3)) : null;
  r.sunUpDot = (c.sky?.sunDirection && c.player.up) ? c.sky.sunDirection.dot(c.player.up).toFixed(3) : null;
  r.planetDebug = Object.fromEntries([...c.debug.lines].filter(([k])=>/planet|terrain|chunk|lod/i.test(k)));
  r.allDebug = Object.fromEntries(c.debug.lines);
  return r;
});
console.log(JSON.stringify(out,null,1));
await b.close(); s.kill();
