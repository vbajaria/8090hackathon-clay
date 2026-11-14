import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptCredentials, decryptCredentials } from '../dist/index.js';
const key = randomBytes(32).toString('base64');
const context = JSON.stringify(['workspace-1', 'connection-1']);
const credentials = { apiKey: 'SECRET_API', clientId: 'CLIENT', clientSecret: 'SECRET_CLIENT' };
test('AES-256-GCM round trip, randomized IV and no plaintext', () => {
  const a = encryptCredentials(credentials, key, context), b = encryptCredentials(credentials, key, context);
  assert.notEqual(a, b);
  assert.deepEqual(decryptCredentials(a, key, context), credentials);
  for (const value of Object.values(credentials)) assert.equal(a.includes(value), false);
});
test('wrong workspace, connection, key and authenticated tampering fail safely', () => {
  const ciphertext = encryptCredentials(credentials, key, context);
  const parts = ciphertext.split('.');
  const data = Buffer.from(parts[3], 'base64url'); data[0] ^= 1; parts[3] = data.toString('base64url');
  for (const [value, k, ctx] of [[ciphertext, key, 'other-workspace'], [ciphertext, key, JSON.stringify(['workspace-1', 'connection-2'])], [ciphertext, randomBytes(32).toString('base64'), context], [parts.join('.'), key, context], ['v1.bad.bad.bad', key, context]]) {
    assert.throws(() => decryptCredentials(value, k, ctx), { message: 'Credential encryption operation failed' });
  }
});
test('rotation is explicit decrypt/re-encrypt; old key cannot read new version', () => {
  const newKey = randomBytes(32).toString('base64');
  const original = encryptCredentials(credentials, key, context);
  const rotated = encryptCredentials(decryptCredentials(original, key, context), newKey, context);
  assert.deepEqual(decryptCredentials(rotated, newKey, context), credentials);
  assert.throws(() => decryptCredentials(rotated, key, context));
});
test('invalid/noncanonical keys, contexts and credential shapes have generic errors', () => {
  for (const invalid of ['', 'API_SECRET', randomBytes(31).toString('base64'), key.replace(/=$/, ''), key + '\n']) {
    assert.throws(() => encryptCredentials(credentials, invalid, context), { message: 'Credential encryption operation failed' });
    assert.throws(() => decryptCredentials('v1.bad.bad.bad', invalid, context), { message: 'Credential encryption operation failed' });
  }
  assert.throws(() => encryptCredentials(credentials, key, ''));
  assert.throws(() => encryptCredentials({ accessToken: 'DO_NOT_PERSIST' }, key, context));
  assert.throws(() => encryptCredentials({ apiKey: 3 }, key, context));
});
