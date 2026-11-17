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
  maxBufferedBytes: 512_000,
  logLevel: process.env.LOG_LEVEL ?? 'info'
};
