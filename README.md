# Pulse

Pulse is an account-free realtime communication PWA. There is **no database**: the server holds only live session state in memory, and each person's identity, rooms and message history live on their own device (IndexedDB), exportable as a single JSON file they own.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Monorepo, Zod protocol, P-256 identity, signed handshake, presence | ✅ Done |
| 2 | Public rooms (create, directory, trending, slow mode, caps, expiry, pinning + `rooms.json`), text chat, IndexedDB, export/import (+ encrypted), offline queue, local search | ✅ Done |
| — | **Password-protected rooms (E2EE), image messages, group voice (P2P mesh, ≤ 8)** | ✅ Done (pulled forward on request) |
| 3 | 1:1 voice/video (P2P), TURN, Web Push for calls | ⏳ Next (TURN config + ICE servers already in place) |
| — | **Private rooms: unlisted, invite link + QR, end-to-end encrypted** | ✅ Done |
| 4 | DMs with E2EE (X25519), file transfer | ⏳ |
| 5 | Nearby discovery | ⏳ |
| 6 | Group video, mediasoup SFU for > 8 people, screen share | ⏳ (voice mesh done) |
| 7 | Safety layer, moderation, full rate-limit policy | ⏳ (token-bucket limits already in place) |
| 8 | PWA/service worker, i18n (en/bn), a11y audit, load test, STRIDE + privacy docs | ⏳ |

## Architecture

```mermaid
flowchart LR
  subgraph Device[Each user's device]
    UI[React + Vite PWA] --> IDB[(IndexedDB\nidentity · rooms · messages · outbox)]
    UI --> WC[WebCrypto\nECDSA P-256 · PBKDF2 → AES-GCM]
  end
  UI <-->|"Typed JSON over WSS /ws"| S[Node 22 server\nin-memory sessions, rooms, presence]
  S -->|"pinned public room defs only"| RJ[(data/rooms.json)]
  S --> H["/health · /metrics"]
  S -->|"static files"| UI
```

- **One process, one port.** In production the Node server serves the built web app *and* the WebSocket at `/ws`, so the app is a single origin (simple to host, strict CSP `connect-src 'self'`).
- **Ephemeral server.** Sessions, room membership and presence are memory-only. A restart clears them; clients reconnect automatically (exponential backoff + 60 s resume token).
- **The only file written** is `data/rooms.json`: definitions of *pinned public* rooms (name, topic, rules, owner public key). Debounced to once per 10 s, written atomically (temp file → rename). Never messages, never locations.

## Run locally

Requires Node 22 and pnpm.

```powershell
pnpm install
pnpm dev          # web on https://localhost:5174 (self-signed), server on :8787
```

The dev web server listens on all interfaces with a self-signed certificate (WebCrypto needs a secure context), and proxies `/ws` to the server, so other devices on your LAN can open `https://<your-ip>:5174` (accept the certificate warning once).

Production-style run (one process):

```powershell
pnpm build
pnpm start        # http://localhost:8787 serves the app and /ws
```

Checks:

```powershell
pnpm typecheck
pnpm test         # Vitest: protocol, rate limiter, rooms/snapshot, hub, crypto/backup
pnpm e2e          # Playwright: two browsers create/join/chat, offline queue, export/import
pnpm gen:schema   # regenerate docs/export.schema.json from the Zod source
```

## Environment variables (server)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` (`8080` in Docker) | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | — | `production` enables HSTS |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated browser origins allowed to open `/ws`. Empty = same host as the request |
| `WEB_DIST` | `apps/web/dist` | Built web app to serve |
| `DATA_DIR` | `apps/server/data` | Where `rooms.json` is written. Empty string disables it |
| `ROOM_IDLE_MINUTES` | `30` | Empty, unpinned rooms expire after this |
| `LOG_LEVEL` | `info` | pino level. Logs never contain message text, handles or locations |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated STUN servers given to callers |
| `TURN_URLS` | *(empty)* | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. Needed for calls between strict NATs (many mobile networks) |
| `TURN_SECRET` | *(empty)* | coturn `--static-auth-secret`: clients get HMAC credentials that expire after `TURN_TTL_SECONDS` (default 6 h) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | *(empty)* | Alternative: fixed credentials from a hosted TURN service |

## Deploy

### Docker (any VPS)

```bash
docker compose up -d --build                      # app on :8080
ALLOWED_ORIGINS=https://pulse.example.com docker compose up -d
TURN_SECRET=change-me docker compose --profile media up -d   # + coturn (calls, Phase 3+)
```

Put Caddy or nginx in front for HTTPS. Caddy example:

```
pulse.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

### Render (free tier)

`render.yaml` is a blueprint: create a new Blueprint from the repo, then add your domain under *Settings → Custom Domains* and create the DNS record Render shows you (a `CNAME` for a subdomain) in your DNS provider (e.g. Hostinger hPanel → *Domains → DNS / Nameservers*). Free instances sleep when idle (first load takes ~50 s), and free hosts cannot run TURN or the SFU; calls will rely on public STUN.

## Protocol (v1)

Every frame is `{ "v": 1, "type", "requestId", "payload" }`, validated with Zod in `packages/protocol` on both ends. Unknown types, wrong versions and oversized frames (> 64 KB) are rejected.

| Direction | Type | Payload |
| --- | --- | --- |
| S → C | `server.challenge` | `{ challenge, expiresAt }` (sent on connect, valid 60 s) |
| C → S | `client.hello` | `{ publicKey, signature, handle, resumeToken? }` (ECDSA P-256 signature of the challenge) |
| S → C | `server.ready` | `{ sessionId, publicKey, resumeToken, resumed, joinedRooms, rooms }` |
| C → S | `profile.update` | `{ handle }` |
| C → S | `presence.update` | `{ status: online \| away \| dnd \| invisible }` |
| S → C | `presence.snapshot` | `[{ publicKey, handle, status, rooms[] }]` (invisible users omitted) |
| C → S | `room.list` | — |
| S → C | `room.listed` | `{ rooms }` (public rooms, busiest first) |
| C → S | `room.create` | `{ name, topic, emoji, mode, memberCap, slowModeSec, rules, lock?: { salt, proof }, private }` (private requires `lock`) |
| C → S | `room.join` | `{ roomId, proof? }` (proof required for locked rooms) |
| C → S | `room.leave` | `{ roomId }` |
| S → C | `room.joined` | room |
| S → C | `room.left` / `room.removed` | `{ roomId }` |
| S → C | `room.updated` | room (broadcast on membership/pin changes) |
| C → S | `room.pin` | `{ roomId, pinned }` (owner only) |
| C → S | `chat.send` | `{ roomId, clientMessageId, text, image? }` in open rooms, `{ roomId, clientMessageId, enc: { iv, ct } }` in locked rooms |
| S → C | `chat.message` | `{ id, clientMessageId, roomId, text, image?, enc?, author: { publicKey, handle }, sentAt }` |
| C → S | `voice.join` | `{ roomId, muted }` (rooms of mode `voice`/`both`, max 8) |
| S → C | `voice.joined` | `{ roomId, sessionId, iceServers }` |
| C → S | `voice.leave` / `voice.mute` | — / `{ muted }` |
| S → C | `voice.state` | `{ roomId, participants: [{ sessionId, publicKey, handle, muted }] }` (sent to all room members) |
| S → C | `voice.left` | `{ roomId }` |
| C ↔ S | `rtc.signal` | `{ to | from, description?, candidate? }` (relayed only between two members of the same voice channel) |
| S → C | `server.error` | `{ code, message, retryAfterMs? }` |

Error codes: `INVALID_MESSAGE`, `AUTH_FAILED`, `NOT_AUTHENTICATED`, `RATE_LIMITED`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_IN_ROOM`, `TOO_MANY_ROOMS`, `SLOW_MODE`, `FORBIDDEN`, `BAD_PASSWORD`, `ENCRYPTION_REQUIRED`, `VOICE_DISABLED`, `VOICE_FULL`, `NOT_IN_VOICE`, `INTERNAL`.

### Password-protected rooms

From the password and the room's public salt the client derives two independent values with PBKDF2-SHA256 (310k iterations): a **join proof** (sent to the server, which stores only `scrypt(proof)`) and an **AES-GCM-256 room key** (never leaves devices). Messages and images are encrypted with the room id as additional data. The server refuses plaintext in locked rooms and ciphertext in open rooms. Passwords can't be recovered or changed.

### Private rooms

Unlisted rooms joined only through an invite link: `https://<host>/#join=<roomId>.<salt>.<secret>`. The creator's device generates a random 256-bit secret; join proof and AES-GCM key are derived from it with HKDF-SHA256 (same split as password rooms). The secret lives in the URL **fragment**, which browsers never send to the server, and the app removes it from the address bar after reading it. The server never lists, announces or reveals private rooms to non-members: room updates go only to members, presence room lists are filtered per viewer, and private rooms are never written to `rooms.json`. Any member can re-share the link (also as a QR code). Anyone holding the link can join; links can't be revoked yet (that needs re-keying, planned with moderation).

### Images

Re-encoded on the sender's device (max 1280 px, WebP or JPEG, about 300 KB, EXIF/GPS stripped), relayed through the WebSocket in one frame (≤ 512 KB) and **never stored by the server**. Images from others are blurred until tapped. Relaying (rather than a peer-to-peer DataChannel) is deliberate: it works on networks where P2P fails without TURN.

### Group voice

Full-mesh WebRTC audio (≤ 8 per room) using perfect negotiation, echo cancellation, noise suppression, ICE restart on network change and speaking detection. Audio flows directly between devices; the server only relays signalling. Without a TURN server some calls between two mobile networks will not connect. Set `TURN_URLS` and credentials to fix that.

Rate limits are token buckets enforced **both per connection and per public key** (frames, chat, room creation, joins, profile changes), so opening more sockets does not multiply throughput.

## Export file

`Settings → Your data` exports `pulse-<handle>-<date>.json` (schema: [`docs/export.schema.json`](docs/export.schema.json)) or an encrypted backup (PBKDF2-SHA256, 600k iterations → AES-GCM-256; schema: [`docs/export-encrypted.schema.json`](docs/export-encrypted.schema.json)).

**Migrations:** every file carries `format` and an integer `version`. On import, `migrateExport()` applies step-wise migrations (`v1→v2→…→current`) and then validates against the current schema. Files from a *newer* version are rejected with a clear message instead of being guessed at. To change the format: bump `EXPORT_VERSION`, add `migrations[old] = (data) => upgraded`, add a test.

## Security & privacy notes (current)

- The private key never leaves the device except inside the user's own export. The UI warns that plain exports contain it and offers the encrypted backup.
- Server checks a fresh signed challenge on every connection; resume tokens only work for the same public key within 60 s.
- Strict CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS in production, Origin check on the WebSocket upgrade, path-traversal-safe static serving.
- Public rooms are plaintext by design (so they can be moderated). Private rooms and DMs will be end-to-end encrypted (Phase 4).
