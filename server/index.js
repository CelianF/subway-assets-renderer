// Production server: built viewer (viewer/dist) + the extraction API.
// Usage: npm run build --prefix viewer && node server/index.js [port]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './api.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'dist');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5180);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

if (!existsSync(DIST)) {
  console.error('viewer/dist not found: run `npm run build --prefix viewer` first.');
  process.exit(1);
}

createServer(async (req, res) => {
  if (await handle(req, res)) return;
  const pathname = new URL(req.url, 'http://local').pathname;
  let file = path.join(DIST, decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end('Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Subway environment viewer: http://localhost:${PORT}`));
