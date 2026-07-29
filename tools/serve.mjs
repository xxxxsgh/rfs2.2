/**
 * Servidor estático mínimo, sem dependências.
 * Necessário porque módulos ES e Web Workers não funcionam via file://.
 *
 *   node tools/serve.mjs [porta]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Necessário para SharedArrayBuffer se algum dia usarmos threads no worker.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`aether: http://localhost:${PORT}/`));
