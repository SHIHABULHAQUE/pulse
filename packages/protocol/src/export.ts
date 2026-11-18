import { z } from 'zod';

/**
 * The user-owned export file ("pulse-<handle>-<date>.json").
 *
 * Versioning: `version` is bumped on every breaking change. Importers run
 * `migrateExport()` which applies step-wise migrations (v1→v2→…→current) and
 * then validates against the current schema. Files from a newer version are
 * rejected rather than guessed at.
 */
export const EXPORT_FORMAT = 'pulse-export';
export const EXPORT_ENCRYPTED_FORMAT = 'pulse-export-encrypted';
export const EXPORT_VERSION = 1;

const b64 = z.string().max(20_000);

const JwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: b64,
  y: b64,
  d: b64.optional(),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional()
}).passthrough();

export const ExportIdentitySchema = z.object({
  algorithm: z.literal('ECDSA-P256'),
  publicKeySpki: z.string().min(40).max(400),
  publicKeyJwk: JwkSchema,
  privateKeyJwk: JwkSchema
});

export const ExportProfileSchema = z.object({
  handle: z.string().min(2).max(32),
  bio: z.string().max(280).default(''),
  status: z.enum(['online', 'away', 'dnd', 'invisible']).default('online')
});

export const ExportSettingsSchema = z.object({
  readReceipts: z.boolean().default(true),
  typingIndicators: z.boolean().default(true),
  sounds: z.boolean().default(true),
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  language: z.string().max(10).default('en')
}).passthrough();

export const ExportContactSchema = z.object({
  publicKey: z.string().min(40).max(400),
  handle: z.string().min(1).max(32),
  addedAt: z.number().int(),
  blocked: z.boolean().default(false)
});

export const ExportRoomSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,48}$/),
  name: z.string().max(80),
  owned: z.boolean().default(false),
  joinedAt: z.number().int(),
  /** Password-derived values for locked rooms so this device can rejoin and decrypt. Optional (added in v1, additive). */
  secret: z.object({ proof: b64, key: b64, invite: b64.optional() }).optional()
});

export const ExportMessageSchema = z.object({
  id: z.string().max(80),
  clientMessageId: z.string().max(80),
  roomId: z.string().max(48),
  text: z.string().max(4000),
  /** Decrypted image as stored on the device. Optional (additive). */
  image: z.object({ mime: z.enum(['image/webp', 'image/jpeg', 'image/png']), data: z.string().max(600_000), width: z.number().int(), height: z.number().int() }).optional(),
  /** True if it was sent end-to-end encrypted in a locked room. */
  encrypted: z.boolean().optional(),
  author: z.object({ publicKey: z.string().max(400), handle: z.string().max(32) }),
  sentAt: z.number().int()
});

export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string().datetime(),
  app: z.string().max(40).default('pulse'),
  identity: ExportIdentitySchema,
  profile: ExportProfileSchema,
  settings: ExportSettingsSchema,
  contacts: z.array(ExportContactSchema).max(10_000),
  rooms: z.array(ExportRoomSchema).max(1_000),
  messages: z.array(ExportMessageSchema).max(200_000)
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

export const EncryptedExportSchema = z.object({
  format: z.literal(EXPORT_ENCRYPTED_FORMAT),
  version: z.literal(EXPORT_VERSION),
  kdf: z.object({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int().min(100_000).max(10_000_000), salt: b64 }),
  cipher: z.object({ name: z.literal('AES-GCM'), iv: b64 }),
  ciphertext: z.string().max(200 * 1024 * 1024)
});
export type EncryptedExport = z.infer<typeof EncryptedExportSchema>;

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;
/** migrations[n] upgrades a version-n file to version n+1. */
const migrations: Record<number, Migration> = {};

export function migrateExport(input: unknown): ExportFile {
  if (!input || typeof input !== 'object') throw new Error('Not a Pulse export file');
  let data = input as Record<string, unknown>;
  if (data.format !== EXPORT_FORMAT) throw new Error('Not a Pulse export file');
  let version = typeof data.version === 'number' ? data.version : NaN;
  if (!Number.isInteger(version) || version < 1) throw new Error('Export file has no valid version');
  if (version > EXPORT_VERSION) throw new Error(`Export file is version ${version}; this app supports up to ${EXPORT_VERSION}. Update Pulse first.`);
  while (version < EXPORT_VERSION) {
    const step = migrations[version];
    if (!step) throw new Error(`No migration from export version ${version}`);
    data = { ...step(data), version: version + 1 };
    version += 1;
  }
  return ExportFileSchema.parse(data);
}
