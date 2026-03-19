// src/lib/secrets.js
// AES-256-GCM encrypt/decrypt for secrets at rest (e.g. device passwords)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SCRYPT_SALT = 'lopesul-relay-salt';

function deriveKey(masterKey) {
  return scryptSync(masterKey, SCRYPT_SALT, 32);
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns a string with format: enc:<ivHex>:<tagHex>:<ciphertextHex>
 */
export function encryptSecret(plaintext, masterKey) {
  if (!masterKey) throw new Error('RELAY_MASTER_KEY is required for encryptSecret');
  const key = deriveKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a ciphertext produced by encryptSecret.
 * If the value does not start with 'enc:', returns it as-is (legacy plaintext support).
 */
export function decryptSecret(ciphertext, masterKey) {
  if (!ciphertext) return ciphertext;
  if (!String(ciphertext).startsWith('enc:')) return ciphertext; // plaintext legado
  if (!masterKey) throw new Error('RELAY_MASTER_KEY is required for decryptSecret');
  const parts = String(ciphertext).split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted secret format');
  const [, ivHex, tagHex, encHex] = parts;
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}
