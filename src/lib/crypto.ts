import crypto from 'node:crypto';

// Refresh tokens grant standing mailbox access and the DB file travels in
// nightly backups, so long-lived credentials are sealed at rest. Access tokens
// (≤1h) are not worth the ceremony.

function key(): Buffer {
  const b64 = (process.env.TOKEN_ENC_KEY ?? '').trim();
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes of base64 (openssl rand -base64 32)');
  return k;
}

/** AES-256-GCM. Output "iv.ct.tag", each base64. */
export function sealToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${ct.toString('base64')}.${cipher.getAuthTag().toString('base64')}`;
}

/** Strict base64: Buffer.from(…, 'base64') silently drops characters it does not
 *  understand, so a corrupted segment must be refused before it is decoded. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The shape sealToken writes: three base64 parts. The ciphertext may be EMPTY —
 *  an empty secret (an endpoint with no key) seals to "iv..tag" and is still
 *  authenticated by its tag — but every part must be well-formed base64, the iv
 *  and tag must be their exact lengths, and a tag that does not verify throws. */
export function openToken(sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 3 || !parts.every((p) => BASE64.test(p))) throw new Error('malformed sealed token');
  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed sealed token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
