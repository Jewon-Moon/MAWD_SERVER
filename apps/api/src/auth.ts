// 회원가입 · 로그인 · 세션. 브라우저는 httpOnly 쿠키, 서버 · 앱 클라이언트는 Authorization: Bearer 토큰.
// 로그인한 사람의 매장은 memberships → tenant_for_user()로 정하고, 모든 매장 API는 tenantOf(req)로 그 매장만 다룸
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import type { createDb } from './db/client.js';
import * as s from './db/schema.js';
import { ApiError } from './errors.js';
import { TENANT_ID } from './mocks/data.js';

type Db = ReturnType<typeof createDb>;
export type AuthInfo = { userId: string; email: string; tenantId: string };
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = 'mawd_session';
const SESSION_DAYS = 30;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${(await scryptAsync(pw, salt, 64)).toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), 64);
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 이 요청의 매장. 로그인 안 했으면 401 (개발 · 테스트에서 DEV_ANON_TENANT=1이면 데모 매장) */
export function tenantOf(req: FastifyRequest): string {
  const t = (req as FastifyRequest & { auth?: AuthInfo | null }).auth?.tenantId;
  if (t) return t;
  if (process.env.DEV_ANON_TENANT === '1') return TENANT_ID;
  throw new ApiError(401, 'unauthenticated', '로그인이 필요합니다.');
}
export const authOf = (req: FastifyRequest) => (req as FastifyRequest & { auth?: AuthInfo | null }).auth ?? null;

function tokenFrom(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim() || null;
  const cookie = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : null;
}

export function createAuth(deps: { db: Db }) {
  const { db } = deps;

  /** 요청의 쿠키 · Bearer 토큰 → 로그인 정보 (없거나 만료면 null) */
  async function resolve(req: FastifyRequest): Promise<AuthInfo | null> {
    const token = tokenFrom(req);
    if (!token) return null;
    const [row] = await db.global((tx) => tx.select({ userId: s.users.id, email: s.users.email }).from(s.sessions)
      .innerJoin(s.users, eq(s.users.id, s.sessions.userId))
      .where(and(eq(s.sessions.tokenHash, sha(token)), gt(s.sessions.expiresAt, new Date()))));
    if (!row) return null;
    const tenantId = await db.tenantForUser(row.userId);
    return tenantId ? { userId: row.userId, email: row.email, tenantId } : null;
  }

  async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db.global((tx) => tx.insert(s.sessions).values({ tokenHash: sha(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) }));
    // 프론트(다른 도메인)에서 쿠키를 쓰려면 https에서 SameSite=None; Secure
    const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${SESSION_DAYS * 86_400}; ${https ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);
    return token;
  }

  /** 회원가입: 계정 + 새 매장 + 소유자 연결. 같은 이메일이면 409 */
  async function signup(email: string, password: string, storeName: string): Promise<{ userId: string; tenantId: string }> {
    const mail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const userId = await db.global(async (tx) => {
      const [dup] = await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, mail));
      if (dup) throw new ApiError(409, 'email_taken', '이미 가입된 이메일이에요.');
      const [u] = await tx.insert(s.users).values({ email: mail, passwordHash }).returning({ id: s.users.id });
      return u!.id;
    });
    const tenantId = randomUUID();
    await db.withTenant(tenantId, async (tx) => {
      await tx.insert(s.tenants).values({ id: tenantId, name: storeName.trim(), webhookToken: randomBytes(18).toString('base64url') });
      await tx.insert(s.memberships).values({ tenantId, userId, role: 'owner' });
    });
    return { userId, tenantId };
  }

  async function login(email: string, password: string): Promise<string> {
    const [u] = await db.global((tx) => tx.select().from(s.users).where(eq(s.users.email, email.trim().toLowerCase())));
    // 계정 유무를 드러내지 않도록 같은 오류
    if (!u || !(await verifyPassword(password, u.passwordHash))) throw new ApiError(401, 'invalid_credentials', '이메일 또는 비밀번호가 맞지 않아요.');
    return u.id;
  }

  async function logout(req: FastifyRequest, reply: FastifyReply) {
    const token = tokenFrom(req);
    if (token) await db.global((tx) => tx.delete(s.sessions).where(eq(s.sessions.tokenHash, sha(token))));
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  }

  /** 데모 계정 (시드): 이미 있으면 비밀번호만 맞춤. 데모 매장에 소유자로 연결 */
  async function ensureUser(email: string, password: string, tenantId: string) {
    const mail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const userId = await db.global(async (tx) => {
      const [u] = await tx.insert(s.users).values({ email: mail, passwordHash })
        .onConflictDoUpdate({ target: s.users.email, set: { passwordHash } }).returning({ id: s.users.id });
      return u!.id;
    });
    await db.withTenant(tenantId, (tx) => tx.insert(s.memberships).values({ tenantId, userId, role: 'owner' }).onConflictDoNothing());
    return userId;
  }

  return { resolve, startSession, signup, login, logout, ensureUser };
}
export type Auth = ReturnType<typeof createAuth>;
