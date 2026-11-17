// Generates docs/export.schema.json from the Zod source of truth.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EncryptedExportSchema, ExportFileSchema } from '../src/export.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = resolve(root, 'docs');
mkdirSync(out, { recursive: true });
const write = (name: string, schema: object) => writeFileSync(resolve(out, name), JSON.stringify(schema, null, 2) + '\n');
write('export.schema.json', { $id: 'https://pulse.app/schemas/export.schema.json', ...zodToJsonSchema(ExportFileSchema, { name: 'PulseExport', $refStrategy: 'none' }) });
write('export-encrypted.schema.json', { $id: 'https://pulse.app/schemas/export-encrypted.schema.json', ...zodToJsonSchema(EncryptedExportSchema, { name: 'PulseEncryptedExport', $refStrategy: 'none' }) });
console.log('wrote docs/export.schema.json and docs/export-encrypted.schema.json');
