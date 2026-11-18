import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import { LIMITS } from '@pulse/protocol';
import { config } from './config.js';
import { Hub, metrics } from './hub.js';
import { RoomRegistry } from './rooms.js';
import { iceServersFor } from './turn.js';
import { prometheus, securityHeaders, serveStatic } from './http.js';

// Logs never include message content, handles or locations: only ids, counts and error codes.
const log = pino({ level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] });

const rooms = new RoomRegistry({ dataDir: config.dataDir, idleMs: config.roomIdleMs, debounceMs: config.snapshotDebounceMs, onError: (err) => log.warn({ err }, 'room snapshot error') });
const hub = new Hub(rooms, { maxBufferedBytes: config.maxBufferedBytes, log, iceServers: (label) => iceServersFor(label, config) });

const httpServer = createServer((req, res) => {
  securityHeaders(res, config.production);
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'pulse-server', sessions: hub.sessions.size, rooms: rooms.size, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  if (path === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' });
    res.end(prometheus({
      pulse_sessions: { help: 'Open WebSocket sessions', type: 'gauge', value: hub.sessions.size },
      pulse_rooms: { help: 'Live rooms', type: 'gauge', value: rooms.size },
      pulse_connections_total: { help: 'WebSocket connections accepted', type: 'counter', value: metrics.connectionsTotal },
      pulse_messages_relayed_total: { help: 'Chat messages relayed', type: 'counter', value: metrics.messagesRelayedTotal },
      pulse_rate_limited_total: { help: 'Requests rejected by rate limits', type: 'counter', value: metrics.rateLimitedTotal },
      pulse_invalid_messages_total: { help: 'Frames that failed validation', type: 'counter', value: metrics.invalidMessagesTotal },
      pulse_auth_failures_total: { help: 'Failed identity handshakes', type: 'counter', value: metrics.authFailuresTotal },
      pulse_resumes_total: { help: 'Sessions resumed with a token', type: 'counter', value: metrics.resumesTotal },
      pulse_dropped_backpressure_total: { help: 'Frames dropped due to slow consumers', type: 'counter', value: metrics.droppedBackpressureTotal },
      pulse_images_relayed_total: { help: 'Image messages relayed (never stored)', type: 'counter', value: metrics.imagesRelayedTotal },
      pulse_voice_joins_total: { help: 'Voice channel joins', type: 'counter', value: metrics.voiceJoinsTotal },
      pulse_rtc_signals_relayed_total: { help: 'WebRTC signalling messages relayed', type: 'counter', value: metrics.signalsRelayedTotal },
      pulse_ws_rejected_total: { help: 'WebSocket upgrades rejected (origin/path)', type: 'counter', value: wsRejected }
    }));
    return;
  }
  if (serveStatic(req, res, config.webDist)) return;
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

/* ------------------------------------------------------------------ WebSocket upgrade with origin check */

let wsRejected = 0;
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (CLI, load tests) send no Origin; browsers always do.
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/ws' || !originAllowed(req)) {
    wsRejected += 1;
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

type LiveSocket = WebSocket & { isAlive?: boolean };

wss.on('connection', (ws: LiveSocket) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const sessionId = hub.connect({
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    get bufferedAmount() { return ws.bufferedAmount; },
    get open() { return ws.readyState === WebSocket.OPEN; }
  });
  ws.on('message', (data, isBinary) => { if (!isBinary) hub.handle(sessionId, data.toString()); });
  ws.on('close', () => hub.disconnect(sessionId));
  ws.on('error', (err) => log.warn({ err: err.message, sessionId }, 'websocket error'));
});

// Heartbeat: a socket that missed the previous ping is terminated.
setInterval(() => {
  for (const ws of wss.clients as Set<LiveSocket>) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, config.heartbeatMs).unref();

setInterval(() => hub.sweep(), 15_000).unref();

/* ------------------------------------------------------------------ boot / shutdown */

const restored = await rooms.load().catch((err) => { log.warn({ err }, 'could not load room snapshot'); return 0; });
httpServer.listen(config.port, config.host, () => log.info({ port: config.port, restoredRooms: restored, webDist: config.webDist, turn: config.turnUrls.length > 0 }, 'Pulse server listening'));

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  for (const ws of wss.clients) ws.close(1012, 'server restarting');
  await rooms.saveNow().catch(() => undefined);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
