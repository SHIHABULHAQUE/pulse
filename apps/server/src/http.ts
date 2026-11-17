import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json'
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

export function securityHeaders(res: ServerResponse, production: boolean): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self), payment=(), usb=()');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Serves the built SPA. Unknown paths without an extension fall back to index.html. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rootAbs = resolve(root);
  if (!existsSync(join(rootAbs, 'index.html'))) return false;
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return false; }
  let file = normalize(join(rootAbs, pathname));
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(pathname)) return false;
    file = join(rootAbs, 'index.html');
  }
  const ext = extname(file);
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  // Hashed assets are immutable; HTML and the service worker must revalidate.
  const immutable = file.includes(`${sep}assets${sep}`);
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.writeHead(200);
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

export function prometheus(values: Record<string, { help: string; type: 'counter' | 'gauge'; value: number }>): string {
  return Object.entries(values).map(([name, m]) => `# HELP ${name} ${m.help}\n# TYPE ${name} ${m.type}\n${name} ${m.value}`).join('\n') + '\n';
}
