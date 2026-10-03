// Production server: built viewer (viewer/dist) + the extraction API.
// Usage: npm run build --prefix viewer && node server/index.js [port]
// The desktop app (app/main.mjs) imports start() instead.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './api.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Serves the viewer and the API. Port 0 picks a free port; host '127.0.0.1' keeps it
 * off the network (the default listens on all interfaces, like before).
 * @returns {Promise<number>} the port actually listened on
 */
export function start({ port = 5180, host, dist = DIST } = {}) {
  if (!existsSync(dist)) throw new Error('viewer/dist not found: run `npm run build --prefix viewer` first.');
  const server = createServer(async (req, res) => {
    if (await handle(req, res)) return;
    const pathname = new URL(req.url, 'http://local').pathname;
    let file = path.join(dist, decodeURIComponent(pathname));
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 5180);
  start({ port }).then(
    (p) => console.log(`Subway environment viewer: http://localhost:${p}`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
