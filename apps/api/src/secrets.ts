// 매장별 연동 키 암호화 (§5.1 I7): AES-256-GCM, 서버 키(SECRETS_KEY)로. DB에는 암호문만 저장됩니다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

/** SECRETS_KEY: 32바이트 hex(64자) 권장 (openssl rand -hex 32). 다른 형식이면 SHA-256으로 32바이트를 만듦 */
function keyOf(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.SECRETS_KEY?.trim();
  if (!raw) return null;
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
}

export function createSecretBox(env: NodeJS.ProcessEnv = process.env) {
  const key = keyOf(env);
  const need = () => { if (!key) throw new ApiError(409, 'secrets_key_missing', '서버에 SECRETS_KEY가 없어 연동 키를 저장할 수 없습니다. (데모 모드는 키 없이 가능)'); return key; };
  return {
    configured: !!key,
    seal(plain: unknown): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', need(), iv);
      const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    },
    open<T = unknown>(sealed: string): T {
      const [v, iv, tag, ct] = sealed.split(':');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown secret format');
      const d = createDecipheriv('aes-256-gcm', need(), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')) as T;
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;
