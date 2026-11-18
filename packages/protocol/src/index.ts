import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ primitives */

const requestId = z.string().min(1).max(80);
const b64 = (max: number) => z.string().regex(/^[A-Za-z0-9+/=_-]*$/).max(max);
export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9+/=_-]{40,400}$/);
export const RoomIdSchema = z.string().regex(/^[a-z0-9-]{3,48}$/);
export const SessionIdSchema = z.string().uuid();
export const HandleSchema = z.string().trim().min(2).max(32).regex(/^[\p{L}\p{N}_.\- ]+$/u, 'Handle may contain letters, numbers, spaces, _ . -');
export const StatusSchema = z.enum(['online', 'away', 'dnd', 'invisible']);
export type Status = z.infer<typeof StatusSchema>;

export const LIMITS = {
  messageChars: 4000,
  roomsPerSession: 20,
  /** Big enough for one compressed image per frame. */
  maxFrameBytes: 512 * 1024,
  imageB64Chars: 440_000,
  imageMaxSide: 1280,
  encryptedB64Chars: 480_000,
  voicePerRoom: 8,
  resumeGraceMs: 60_000,
  challengeTtlMs: 60_000
} as const;

/* ------------------------------------------------------------------ rooms */

export const RoomModeSchema = z.enum(['text', 'voice', 'both']);

/** Fields the creator controls. */
export const RoomSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  topic: z.string().trim().max(200).default(''),
  emoji: z.string().max(16).default('#'),
  mode: RoomModeSchema.default('both'),
  memberCap: z.number().int().min(2).max(500).default(100),
  slowModeSec: z.number().int().min(0).max(3600).default(0),
  rules: z.string().trim().max(2000).default('')
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

/**
 * Password lock. The client derives two independent values from the password with PBKDF2 and the public `salt`:
 * `proof` (sent to the server, which stores only scrypt(proof)) and the AES-GCM room key (never leaves devices).
 */
export const RoomLockSchema = z.object({ salt: b64(64).min(16), proof: b64(128).min(32) });

export const RoomSchema = RoomSettingsSchema.extend({
  id: RoomIdSchema,
  kind: z.enum(['public', 'private']),
  ownerKey: PublicKeySchema.nullable(),
  pinned: z.boolean(),
  /** Password protected and end-to-end encrypted. */
  locked: z.boolean(),
  /** Public PBKDF2 salt for locked rooms. */
  keySalt: z.string().max(64).nullable(),
  members: z.number().int().min(0),
  createdAt: z.number().int().positive()
});
export type Room = z.infer<typeof RoomSchema>;

/* ------------------------------------------------------------------ presence & messages */

export const PresenceSchema = z.object({
  publicKey: PublicKeySchema,
  handle: HandleSchema,
  status: StatusSchema,
  rooms: z.array(RoomIdSchema)
});
export type Presence = z.infer<typeof PresenceSchema>;

export const AuthorSchema = z.object({ publicKey: PublicKeySchema, handle: HandleSchema });
export type Author = z.infer<typeof AuthorSchema>;

export const ImageSchema = z.object({
  mime: z.enum(['image/webp', 'image/jpeg', 'image/png']),
  data: b64(LIMITS.imageB64Chars).min(1),
  width: z.number().int().min(1).max(LIMITS.imageMaxSide),
  height: z.number().int().min(1).max(LIMITS.imageMaxSide)
});
export type ImageAttachment = z.infer<typeof ImageSchema>;

/** AES-GCM ciphertext of JSON `{ text, image? }`, bound to the room id as additional data. */
export const EncryptedBodySchema = z.object({ iv: b64(24).min(16), ct: b64(LIMITS.encryptedB64Chars).min(1) });
export type EncryptedBody = z.infer<typeof EncryptedBodySchema>;

/** Plaintext message body (open rooms) or ciphertext (locked rooms). Exactly one form. */
const MessageBodySchema = z.object({
  text: z.string().trim().max(LIMITS.messageChars).default(''),
  image: ImageSchema.optional(),
  enc: EncryptedBodySchema.optional()
});

/** 'plain' = text and/or image, 'encrypted' = ciphertext only, null = empty or mixed (invalid). */
export function bodyKind(body: { text?: string; image?: unknown; enc?: unknown }): 'plain' | 'encrypted' | null {
  const hasPlain = !!body.text?.trim() || !!body.image;
  if (body.enc) return hasPlain ? null : 'encrypted';
  return hasPlain ? 'plain' : null;
}

export const ChatMessageSchema = MessageBodySchema.extend({
  id: z.string().min(1).max(80),
  clientMessageId: z.string().min(1).max(80),
  roomId: RoomIdSchema,
  author: AuthorSchema,
  sentAt: z.number().int()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/* ------------------------------------------------------------------ voice */

export const VoiceParticipantSchema = z.object({ sessionId: SessionIdSchema, publicKey: PublicKeySchema, handle: HandleSchema, muted: z.boolean() });
export type VoiceParticipant = z.infer<typeof VoiceParticipantSchema>;

export const IceServerSchema = z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() });
export type IceServer = z.infer<typeof IceServerSchema>;

const SignalDataSchema = z.object({
  description: z.object({ type: z.enum(['offer', 'answer', 'pranswer', 'rollback']), sdp: z.string().max(30_000).optional() }).optional(),
  candidate: z.object({ candidate: z.string().max(1000), sdpMid: z.string().max(64).nullable().optional(), sdpMLineIndex: z.number().int().nullable().optional(), usernameFragment: z.string().max(256).nullable().optional() }).nullable().optional()
});

/* ------------------------------------------------------------------ client → server */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('client.hello'), requestId, payload: z.object({ publicKey: PublicKeySchema, signature: z.string().min(1).max(512), handle: HandleSchema, resumeToken: z.string().max(128).optional() }) }),
  z.object({ type: z.literal('profile.update'), requestId, payload: z.object({ handle: HandleSchema }) }),
  z.object({ type: z.literal('presence.update'), requestId, payload: z.object({ status: StatusSchema }) }),
  z.object({ type: z.literal('room.list'), requestId }),
  z.object({ type: z.literal('room.create'), requestId, payload: RoomSettingsSchema.extend({ lock: RoomLockSchema.optional() }) }),
  z.object({ type: z.literal('room.join'), requestId, payload: z.object({ roomId: RoomIdSchema, proof: b64(128).optional() }) }),
  z.object({ type: z.literal('room.leave'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('room.pin'), requestId, payload: z.object({ roomId: RoomIdSchema, pinned: z.boolean() }) }),
  z.object({ type: z.literal('chat.send'), requestId, payload: MessageBodySchema.extend({ roomId: RoomIdSchema, clientMessageId: z.string().min(1).max(80) }) }),
  z.object({ type: z.literal('voice.join'), requestId, payload: z.object({ roomId: RoomIdSchema, muted: z.boolean().default(false) }) }),
  z.object({ type: z.literal('voice.leave'), requestId }),
  z.object({ type: z.literal('voice.mute'), requestId, payload: z.object({ muted: z.boolean() }) }),
  z.object({ type: z.literal('rtc.signal'), requestId, payload: SignalDataSchema.extend({ to: SessionIdSchema }) })
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

/* ------------------------------------------------------------------ server → client */

export const ErrorCodeSchema = z.enum([
  'INVALID_MESSAGE', 'AUTH_FAILED', 'NOT_AUTHENTICATED', 'RATE_LIMITED', 'ROOM_NOT_FOUND', 'ROOM_FULL',
  'NOT_IN_ROOM', 'TOO_MANY_ROOMS', 'SLOW_MODE', 'FORBIDDEN', 'BAD_PASSWORD', 'ENCRYPTION_REQUIRED',
  'VOICE_DISABLED', 'VOICE_FULL', 'NOT_IN_VOICE', 'INTERNAL'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('server.challenge'), requestId, payload: z.object({ challenge: z.string(), expiresAt: z.number().int() }) }),
  z.object({ type: z.literal('server.ready'), requestId, payload: z.object({ sessionId: SessionIdSchema, publicKey: PublicKeySchema, resumeToken: z.string(), resumed: z.boolean(), joinedRooms: z.array(RoomIdSchema), rooms: z.array(RoomSchema) }) }),
  z.object({ type: z.literal('server.error'), requestId, payload: z.object({ code: ErrorCodeSchema, message: z.string(), retryAfterMs: z.number().int().optional() }) }),
  z.object({ type: z.literal('room.listed'), requestId, payload: z.object({ rooms: z.array(RoomSchema) }) }),
  z.object({ type: z.literal('room.updated'), requestId, payload: RoomSchema }),
  z.object({ type: z.literal('room.removed'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('room.joined'), requestId, payload: RoomSchema }),
  z.object({ type: z.literal('room.left'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('presence.snapshot'), requestId, payload: z.array(PresenceSchema) }),
  z.object({ type: z.literal('chat.message'), requestId, payload: ChatMessageSchema }),
  z.object({ type: z.literal('voice.joined'), requestId, payload: z.object({ roomId: RoomIdSchema, sessionId: SessionIdSchema, iceServers: z.array(IceServerSchema) }) }),
  z.object({ type: z.literal('voice.left'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('voice.state'), requestId, payload: z.object({ roomId: RoomIdSchema, participants: z.array(VoiceParticipantSchema) }) }),
  z.object({ type: z.literal('rtc.signal'), requestId, payload: SignalDataSchema.extend({ from: SessionIdSchema }) })
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ------------------------------------------------------------------ codec */

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

function parseEnvelope(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== PROTOCOL_VERSION) throw new Error('Unsupported protocol version');
  const { v: _v, ...rest } = parsed as Record<string, unknown>;
  return rest;
}

export function decodeClient(raw: string): ClientMessage {
  return ClientMessageSchema.parse(parseEnvelope(raw));
}

export function decodeServer(raw: string): ServerMessage {
  return ServerMessageSchema.parse(parseEnvelope(raw));
}

export * from './export.js';
