import { createHmac } from 'node:crypto';
import type { IceServer } from '@pulse/protocol';

export type TurnConfig = { stunUrls: string[]; turnUrls: string[]; turnSecret: string; turnUsername: string; turnCredential: string; turnTtlSec: number };

/**
 * ICE servers for a client. With a shared secret (coturn `--use-auth-secret`), credentials follow the
 * TURN REST API convention: username = "<expiry>:<label>", credential = base64(HMAC-SHA1(secret, username)),
 * so they expire on their own and the secret never reaches clients.
 */
export function iceServersFor(label: string, cfg: TurnConfig, nowMs = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length) {
    if (cfg.turnSecret) {
      const username = `${Math.floor(nowMs / 1000) + cfg.turnTtlSec}:${label}`;
      const credential = createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
      servers.push({ urls: cfg.turnUrls, username, credential });
    } else if (cfg.turnUsername && cfg.turnCredential) {
      servers.push({ urls: cfg.turnUrls, username: cfg.turnUsername, credential: cfg.turnCredential });
    }
  }
  return servers;
}
