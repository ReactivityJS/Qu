import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Serves `root` over HTTP as static files. Nothing here knows what QU is —
 * it just maps a URL path to a file on disk with the right Content-Type
 * (in particular .mjs/.js as text/javascript, so the browser accepts them
 * as ES modules) and refuses to serve anything outside `root`.
 */
export function startServer({ root, port = 8787 } = {}) {
  const normalizedRoot = path.normalize(root);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let reqPath = decodeURIComponent(url.pathname);
      if (reqPath === '/') reqPath = '/index.html';

      let filePath = path.normalize(path.join(normalizedRoot, reqPath));
      if (!filePath.startsWith(normalizedRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isDirectory()) filePath = path.join(filePath, 'index.html');

      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Not found: ${req.url}`);
    }
  });

  server.listen(port, () => {
    console.log(`QU dev server running at http://localhost:${port}`);
  });

  return server;
}
