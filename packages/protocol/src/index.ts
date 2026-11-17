import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ primitives */

const requestId = z.string().min(1).max(80);
export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9+/=_-]{40,400}$/);
export const RoomIdSchema = z.string().regex(/^[a-z0-9-]{3,48}$/);
export const HandleSchema = z.string().trim().min(2).max(32).regex(/^[\p{L}\p{N}_.\- ]+$/u, 'Handle may contain letters, numbers, spaces, _ . -');
export const StatusSchema = z.enum(['online', 'away', 'dnd', 'invisible']);
export type Status = z.infer<typeof StatusSchema>;

export const LIMITS = {
  messageChars: 4000,
  roomsPerSession: 20,
  maxFrameBytes: 64 * 1024,
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
  mode: RoomModeSchema.default('text'),
  memberCap: z.number().int().min(2).max(500).default(100),
  slowModeSec: z.number().int().min(0).max(3600).default(0),
  rules: z.string().trim().max(2000).default('')
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const RoomSchema = RoomSettingsSchema.extend({
  id: RoomIdSchema,
  kind: z.enum(['public', 'private']),
  ownerKey: PublicKeySchema.nullable(),
  pinned: z.boolean(),
  members: z.number().int().min(0),
  createdAt: z.number().int().positive()
});
export type Room = z.infer<typeof RoomSchema>;

/* ------------------------------------------------------------------ presence */

export const PresenceSchema = z.object({
  publicKey: PublicKeySchema,
  handle: HandleSchema,
  status: StatusSchema,
  rooms: z.array(RoomIdSchema)
});
export type Presence = z.infer<typeof PresenceSchema>;

export const AuthorSchema = z.object({ publicKey: PublicKeySchema, handle: HandleSchema });
export type Author = z.infer<typeof AuthorSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1).max(80),
  clientMessageId: z.string().min(1).max(80),
  roomId: RoomIdSchema,
  text: z.string().max(LIMITS.messageChars),
  author: AuthorSchema,
  sentAt: z.number().int()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/* ------------------------------------------------------------------ client → server */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('client.hello'), requestId, payload: z.object({ publicKey: PublicKeySchema, signature: z.string().min(1).max(512), handle: HandleSchema, resumeToken: z.string().max(128).optional() }) }),
  z.object({ type: z.literal('profile.update'), requestId, payload: z.object({ handle: HandleSchema }) }),
  z.object({ type: z.literal('presence.update'), requestId, payload: z.object({ status: StatusSchema }) }),
  z.object({ type: z.literal('room.list'), requestId }),
  z.object({ type: z.literal('room.create'), requestId, payload: RoomSettingsSchema }),
  z.object({ type: z.literal('room.join'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('room.leave'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('room.pin'), requestId, payload: z.object({ roomId: RoomIdSchema, pinned: z.boolean() }) }),
  z.object({ type: z.literal('chat.send'), requestId, payload: z.object({ roomId: RoomIdSchema, text: z.string().trim().min(1).max(LIMITS.messageChars), clientMessageId: z.string().min(1).max(80) }) })
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

/* ------------------------------------------------------------------ server → client */

export const ErrorCodeSchema = z.enum([
  'INVALID_MESSAGE', 'AUTH_FAILED', 'NOT_AUTHENTICATED', 'RATE_LIMITED', 'ROOM_NOT_FOUND', 'ROOM_FULL',
  'NOT_IN_ROOM', 'TOO_MANY_ROOMS', 'SLOW_MODE', 'FORBIDDEN', 'INTERNAL'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('server.challenge'), requestId, payload: z.object({ challenge: z.string(), expiresAt: z.number().int() }) }),
  z.object({ type: z.literal('server.ready'), requestId, payload: z.object({ sessionId: z.string(), publicKey: PublicKeySchema, resumeToken: z.string(), resumed: z.boolean(), joinedRooms: z.array(RoomIdSchema), rooms: z.array(RoomSchema) }) }),
  z.object({ type: z.literal('server.error'), requestId, payload: z.object({ code: ErrorCodeSchema, message: z.string(), retryAfterMs: z.number().int().optional() }) }),
  z.object({ type: z.literal('room.listed'), requestId, payload: z.object({ rooms: z.array(RoomSchema) }) }),
  z.object({ type: z.literal('room.updated'), requestId, payload: RoomSchema }),
  z.object({ type: z.literal('room.removed'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('room.joined'), requestId, payload: RoomSchema }),
  z.object({ type: z.literal('room.left'), requestId, payload: z.object({ roomId: RoomIdSchema }) }),
  z.object({ type: z.literal('presence.snapshot'), requestId, payload: z.array(PresenceSchema) }),
  z.object({ type: z.literal('chat.message'), requestId, payload: ChatMessageSchema })
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
