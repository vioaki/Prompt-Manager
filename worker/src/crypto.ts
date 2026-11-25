import type { AllowedMediaMimeType } from '@prompt-pages/shared';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface NativeBase64Uint8Array extends Uint8Array {
  toBase64?: (options?: { alphabet?: 'base64' | 'base64url'; omitPadding?: boolean }) => string;
}

interface NativeBase64Uint8ArrayConstructor {
  fromBase64?: (
    str: string,
    options?: {
      alphabet?: 'base64' | 'base64url';
      lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial';
    },
  ) => Uint8Array<ArrayBuffer>;
}

const NativeU8 = Uint8Array as unknown as NativeBase64Uint8ArrayConstructor;

export function base64UrlEncode(bytes: Uint8Array): string {
  const native = bytes as NativeBase64Uint8Array;
  if (typeof native.toBase64 === 'function') {
    return native.toBase64({ alphabet: 'base64url', omitPadding: true });
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) {
    throw new Error('Invalid base64url input');
  }
  if (typeof NativeU8.fromBase64 === 'function') {
    const decoded = NativeU8.fromBase64(str, { alphabet: 'base64url' });
    // Ensure BufferSource backed by plain ArrayBuffer
    const out = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    out.set(decoded);
    return out;
  }
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as NativeBase64Uint8Array;
  if (typeof native.toBase64 === 'function') {
    return native.toBase64({ alphabet: 'base64' });
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const cleaned = b64.replace(/\s+/g, '');
  if (typeof NativeU8.fromBase64 === 'function') {
    const decoded = NativeU8.fromBase64(cleaned, { alphabet: 'base64' });
    const out = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    out.set(decoded);
    return out;
  }
  const binary = atob(cleaned);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomBase64Url(byteLength = 24): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwtHs256(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(
    textEncoder.encode(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds })),
  );
  const signingInput = `${header}.${body}`;
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, textEncoder.encode(signingInput)),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export async function verifyJwtHs256<T extends Record<string, unknown>>(
  token: string,
  secret: string,
): Promise<(T & { iat: number; exp: number }) | null> {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  try {
    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecode(sig);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      textEncoder.encode(`${header}.${body}`),
    );
    if (!valid) return null;

    const parsed = JSON.parse(textDecoder.decode(base64UrlDecode(body))) as T & {
      iat: number;
      exp: number;
    };
    const now = Math.floor(Date.now() / 1000);
    if (typeof parsed.exp !== 'number' || parsed.exp < now) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

// Wrap a PKCS#1 RSAPrivateKey DER payload into PKCS#8 PrivateKeyInfo DER
// so GitHub App's default `BEGIN RSA PRIVATE KEY` works directly with Web Crypto.
function wrapPkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array([
    0x02, 0x01, 0x00,
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const octetLen = encodeDerLength(pkcs1Der.length);
  const innerLen = header.length + 1 + octetLen.length + pkcs1Der.length;
  const seqLen = encodeDerLength(innerLen);

  const out = new Uint8Array(new ArrayBuffer(1 + seqLen.length + innerLen));
  let offset = 0;
  out[offset++] = 0x30;
  out.set(seqLen, offset);
  offset += seqLen.length;
  out.set(header, offset);
  offset += header.length;
  out[offset++] = 0x04;
  out.set(octetLen, offset);
  offset += octetLen.length;
  out.set(pkcs1Der, offset);
  return out;
}

function pemToPkcs8DerBytes(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const isPkcs1 = normalized.includes('BEGIN RSA PRIVATE KEY');
  const body = normalized
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
    .replace(/-----END [A-Z0-9 ]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = base64ToBytes(body);
  return isPkcs1 ? wrapPkcs1ToPkcs8(bytes) : bytes;
}

export async function signJwtRs256(
  payload: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8DerBytes(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(signingInput)),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

export function detectImageMimeFromBytes(buf: Uint8Array): AllowedMediaMimeType | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export function mimeToExtension(mime: AllowedMediaMimeType): string {
  switch (mime) {
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
  }
}
