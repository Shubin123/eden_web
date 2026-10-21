// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

// `isolation: false` omits the COOP/COEP headers, like GitHub Pages, so the COI service worker is used.
export function createServer({ isolation = true } = {}) {
  return http.createServer(async (request, response) => {
    const headers = isolation ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache'
    } : { 'Cache-Control': 'no-cache' };
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, headers);
        response.end();
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const file = path.resolve(root, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
      if (!file.startsWith(root)) {
        response.writeHead(403, headers);
        response.end();
        return;
      }
      // A validator lets the browser revalidate cached files with a 304, so a second page load
      // reuses its HTTP cache and compiled WebAssembly, as it does on GitHub Pages.
      const info = await stat(file);
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { ...headers, ETag: etag });
        response.end();
        return;
      }
      const data = await readFile(file);
      response.writeHead(200, {
        ...headers,
        ETag: etag,
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Content-Length': data.length
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404, headers);
      response.end('Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Eden Web: http://127.0.0.1:${server.address().port}`);
  });
}
