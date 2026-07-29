/**
 * Arnês de captura visual.
 *
 *   node tools/shoot.mjs [--out dir] [--seed S] [--shots a,b] [--q high] [--w 1920] [--h 1080]
 *
 * Sobe o servidor, abre o Chromium com WebGL por SwiftShader, posiciona a
 * câmera em cada pose canônica de src/core/shots.js e salva PNG + metadados.
 * Também coleta erros de console — um build que loga exceção reprova de saída.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUT = path.resolve(ROOT, arg('out', 'shots'));
const SEED = arg('seed', 'AETHER-PRIME');
const QUALITY = arg('q', 'high');
const WIDTH = Number(arg('w', 1600));
const HEIGHT = Number(arg('h', 900));
const PORT = Number(arg('port', 8231));
const ONLY = arg('shots', '').split(',').filter(Boolean);
const TIMEOUT = Number(arg('timeout', 240000));

fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-webgl2-compute-context',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--js-flags=--max-old-space-size=4096',
  ],
});

const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
// O jogo roda a poucos fps sob SwiftShader; os padrões de 30 s do Playwright
// estouram antes de o compositor entregar o frame.
page.setDefaultTimeout(180000);

const consoleErrors = [];
const consoleWarns = [];
page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') consoleErrors.push(text);
  else if (t === 'warning') consoleWarns.push(text);
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + (err?.message || err)));

const report = { seed: SEED, quality: QUALITY, width: WIDTH, height: HEIGHT, shots: [], errors: [], warnings: [] };
let exitCode = 0;

try {
  const url = `http://localhost:${PORT}/?auto=1&seed=${encodeURIComponent(SEED)}&q=${QUALITY}`;
  console.log('→', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Espera o boot terminar de verdade.
  await page.waitForFunction(() => window.__AETHER__ && window.__AETHER__.ready === true, null, { timeout: TIMEOUT });

  const info = await page.evaluate(() => ({
    failures: (window.__AETHER__.moduleFailures || []).map((f) => ({ id: f.id, msg: String(f.err && f.err.message || f.err) })),
    modules: (window.__AETHER__.modules || []).map((m) => m.id),
    webgl2: window.__AETHER__.engine.renderer.capabilities.isWebGL2,
  }));
  report.modules = info.modules;
  report.moduleFailures = info.failures;
  report.webgl2 = info.webgl2;
  if (info.failures.length) {
    console.warn('módulos degradados:', info.failures.map((f) => f.id).join(', '));
  }

  const names = ONLY.length ? ONLY : await page.evaluate(() => Object.keys(window.__AETHER__.shots));

  for (const name of names) {
    process.stdout.write(`  capturando ${name}… `);
    let meta = null;
    try {
      meta = await page.evaluate(async (n) => await window.__AETHER__.shot(n), name);
    } catch (e) {
      console.log('FALHOU');
      report.shots.push({ shot: name, error: String(e.message || e) });
      exitCode = 1;
      continue;
    }
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, type: 'png', timeout: 180000, animations: 'disabled' });
    meta.file = path.relative(ROOT, file);
    report.shots.push(meta);
    console.log(`ok  (${meta.fps} fps, ${meta.drawCalls} draws, ${(meta.triangles / 1000).toFixed(0)}k tris, ${meta.biome || '—'})`);
  }
} catch (e) {
  console.error('erro no arnês:', e.message);
  report.fatal = String(e.message || e);
  exitCode = 1;
} finally {
  report.errors = dedupe(consoleErrors).slice(0, 40);
  report.warnings = dedupe(consoleWarns).slice(0, 20);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}

if (report.errors.length) {
  console.error(`\n${report.errors.length} erro(s) de console:`);
  report.errors.slice(0, 10).forEach((e) => console.error('  ×', e.slice(0, 200)));
  exitCode = 1;
}
console.log('\nrelatório:', path.relative(ROOT, path.join(OUT, 'report.json')));
process.exit(exitCode);

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((x) => { const k = x.slice(0, 160); if (seen.has(k)) return false; seen.add(k); return true; });
}
