import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type Credentials = { apiKey?: string; clientId?: string; clientSecret?: string };
const safeError = () => new Error('Credential encryption operation failed');
function keyBytes(key: string): Buffer {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== key) throw safeError();
  return bytes;
}
function checkedCredentials(value: unknown): Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw safeError();
  const entries = Object.entries(value);
  if (entries.some(([key, v]) => !['apiKey', 'clientId', 'clientSecret'].includes(key) || typeof v !== 'string' || v.length > 8192)) throw safeError();
  return value as Credentials;
}
function aad(context: string): Buffer {
  if (typeof context !== 'string' || !context.trim() || context.length > 4096) throw safeError();
  return Buffer.from(`leadwork:credentials:v1:${context}`, 'utf8');
}
/** Server only. Bind context to both workspace and connection; persist key version separately. */
export function encryptCredentials(credentials: Credentials, key32base64: string, context: string): string {
  try {
    const key = keyBytes(key32base64), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(context));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(checkedCredentials(credentials)), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  } catch { throw safeError(); }
}
export function decryptCredentials(ciphertext: string, key32base64: string, context: string): Credentials {
  try {
    if (typeof ciphertext !== 'string' || ciphertext.length > 40000) throw safeError();
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw safeError();
    const decode = (s: string) => {
      const value = Buffer.from(s, 'base64url');
      if (!s || value.toString('base64url') !== s) throw safeError();
      return value;
    };
    const iv = decode(parts[1]!), tag = decode(parts[2]!), data = decode(parts[3]!);
    if (iv.length !== 12 || tag.length !== 16) throw safeError();
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key32base64), iv);
    decipher.setAAD(aad(context)); decipher.setAuthTag(tag);
    return checkedCredentials(JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')));
  } catch { throw safeError(); }
}
