import http from 'node:http';

const PORT = Number(process.env.ORLYNX_PREVIEW_PROXY_PORT || 4108);
const BLOCKED = new Set([4096, PORT]);

function target(reqUrl = '/') {
  const url = new URL(reqUrl, 'http://preview.internal');
  const match = url.pathname.match(/^\/proxy\/(\d{4,5})(\/.*)?$/);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || BLOCKED.has(port)) return null;
  return { port, path: (match[2] || '/') + url.search };
}

function headersFor(headers, port) {
  const next = { ...headers, host: `127.0.0.1:${port}` };
  delete next.cookie;
  delete next.authorization;
  delete next['proxy-authorization'];
  return next;
}

const server = http.createServer((req, res) => {
  const destination = target(req.url);
  if (!destination) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Preview target not found.');
    return;
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: destination.port,
    path: destination.path,
    method: req.method,
    headers: headersFor(req.headers, destination.port),
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Preview server is unavailable.');
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const destination = target(req.url);
  if (!destination) { socket.destroy(); return; }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: destination.port,
    path: destination.path,
    method: req.method,
    headers: headersFor(req.headers, destination.port),
  });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    let status = `HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}\r\n`;
    for (const [key, value] of Object.entries(response.headers)) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) status += `${key}: ${item}\r\n`;
    }
    status += '\r\n';
    socket.write(status);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on('response', (response) => {
    socket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(PORT, '0.0.0.0', () => console.log(`[preview-proxy] listening on :${PORT}`));
