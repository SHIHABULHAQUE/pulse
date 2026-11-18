import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const num = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  /** Comma-separated list of allowed browser origins for the WebSocket upgrade. Empty = same host as the request. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  /** Built web app (apps/web/dist). Served by this process so the whole app is one origin. */
  webDist: process.env.WEB_DIST ?? resolve(here, '../../web/dist'),
  /** Where pinned public room definitions are snapshotted. Never messages or locations. */
  dataDir: process.env.DATA_DIR ?? resolve(here, '../data'),
  roomIdleMs: num(process.env.ROOM_IDLE_MINUTES, 30) * 60_000,
  snapshotDebounceMs: 10_000,
  heartbeatMs: 30_000,
  /** Per-socket send buffer before frames are dropped (an image is up to ~440 KB). */
  maxBufferedBytes: 2_000_000,
  /** STUN servers offered to clients (comma-separated). */
  stunUrls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478').split(',').map((u) => u.trim()).filter(Boolean),
  /** TURN relay for strict NATs, e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349". */
  turnUrls: (process.env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean),
  /** coturn --use-auth-secret shared secret: clients get short-lived HMAC credentials (preferred). */
  turnSecret: process.env.TURN_SECRET ?? '',
  /** Static TURN credentials, for hosted TURN services that hand out a fixed username/password. */
  turnUsername: process.env.TURN_USERNAME ?? '',
  turnCredential: process.env.TURN_CREDENTIAL ?? '',
  turnTtlSec: num(process.env.TURN_TTL_SECONDS, 6 * 3600),
  logLevel: process.env.LOG_LEVEL ?? 'info'
};
