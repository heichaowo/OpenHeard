import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// 只用 Node 自带的。一个操作者、一个口令，不值得为它引一套会话框架。

const SCRYPT_N = 16384;
const KEY_LEN = 32;
export const COOKIE = 'openheard_session';
/** 会话有效期。一个人自己用的东西，不必天天登。 */
export const SESSION_DAYS = 30;

/** 口令哈希的存储形式：`scrypt$<N>$<salt hex>$<hash hex>`。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !n || !saltHex || !keyHex) return false;
  let key: Buffer;
  try {
    key = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LEN, {
      N: Number(n),
      r: 8,
      p: 1,
    });
  } catch {
    return false;
  }
  const want = Buffer.from(keyHex, 'hex');
  // 长度不等时 timingSafeEqual 会抛，所以先挡一道。
  return key.length === want.length && timingSafeEqual(key, want);
}

/** 会话令牌是 `<到期秒>.<HMAC>`，服务端不存任何状态。 */
export function signSession(secret: string, expiresAt: number): string {
  const mac = createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${mac}`;
}

export function verifySession(secret: string, token: string | undefined, now: number): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now) return false;
  const want = Buffer.from(signSession(secret, exp).slice(dot + 1), 'hex');
  const got = Buffer.from(token.slice(dot + 1), 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
