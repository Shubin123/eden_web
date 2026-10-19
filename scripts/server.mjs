// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import { readFile } from 'node:fs/promises';
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

export function createServer() {
  return http.createServer(async (request, response) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache'
    };
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
      const data = await readFile(file);
      response.writeHead(200, {
        ...headers,
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
