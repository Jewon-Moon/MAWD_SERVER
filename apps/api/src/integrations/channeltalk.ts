// 채널톡 연동. 웹훅 형식 · 발송 API는 공식 문서(developers.channel.io, api-doc.channel.io)를 보고 만든 추정치라
// 해커톤 당일 실제 페이로드와 대조해 이 파일만 고치면 됩니다. 체크리스트: docs/channeltalk-dayof.md

import { and, eq } from 'drizzle-orm';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { SecretBox } from '../secrets.js';

type Db = ReturnType<typeof createDb>;
export type IncomingMessage = { chatId: string; text: string; customerName: string | null; customerPhone: string | null };

function extractText(e: Record<string, unknown>): string {
  if (typeof e.plainText === 'string' && e.plainText.trim()) return e.plainText.trim();
  if (Array.isArray(e.blocks)) {
    const joined = e.blocks
      .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { value?: unknown }).value === 'string' ? (b as { value: string }).value : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (joined) return joined;
  }
  return '';
}

/**
 * 웹훅 본문 → 고객 메시지. 고객(user)이 1:1 상담(userChat)에 쓴 글만 통과.
 * 매니저 · 봇(우리 AI 포함) 메시지는 null → 무시해야 AI가 자기 답에 다시 답하는 루프가 안 생김.
 * 추정 형식: { event: 'push', type: 'message', entity: { chatId, chatType: 'userChat', personType: 'user', plainText }, refers: { user: { name, profile: { mobileNumber } } } }
 */
export function parseWebhook(body: unknown): IncomingMessage | null {
  const b = body as { type?: string; entity?: Record<string, unknown>; refers?: { user?: { name?: string; profile?: { mobileNumber?: string } } } } | null;
  const e = b?.entity;
  if (!e || (b.type && b.type.toLowerCase() !== 'message')) return null;
  if (e.chatType !== 'userChat' || e.personType !== 'user') return null;
  const text = extractText(e);
  if (!text || typeof e.chatId !== 'string') return null;
  return { chatId: e.chatId, text: text.slice(0, 2000), customerName: b.refers?.user?.name ?? null, customerPhone: b.refers?.user?.profile?.mobileNumber ?? null };
}

export interface ChatSender {
  send(chatId: string, text: string, tenantId?: string): Promise<void>;
}

export async function verifyChannelTalkKeys(
  accessKey: string,
  accessSecret: string,
  env = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ channelId: string | null; channelName: string | null }> {
  const base = env.CHANNELTALK_API_BASE || 'https://api.channel.io/open/v5';
  const res = await fetchFn(`${base}/channel`, {
    method: 'GET',
    headers: { 'x-access-key': accessKey, 'x-access-secret': accessSecret },
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(400, 'channeltalk_key_invalid', '채널톡 Access Key 또는 Access Secret이 올바르지 않아요.');
  }
  if (!res.ok) {
    throw new ApiError(502, 'channeltalk_verify_failed', `채널톡 인증 확인에 실패했어요 (${res.status}).`);
  }
  const j = (await res.json().catch(() => ({}))) as { channel?: { id?: string | number; name?: string } };
  return { channelId: j.channel?.id != null ? String(j.channel.id) : null, channelName: j.channel?.name ?? null };
}

type SenderOpts = { db?: Db; secrets?: SecretBox; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch; log?: (msg: string) => void };

/** 매장별 secrets(channeltalk) 또는 환경변수 키로 채널톡 Open API 발송. 키가 없으면 로그만 */
export function createChannelTalkSender(
  envOrOpts: NodeJS.ProcessEnv | SenderOpts = process.env,
  logArg: (msg: string) => void = () => {},
): ChatSender {
  const isOpts = 'db' in envOrOpts || 'secrets' in envOrOpts || 'fetchFn' in envOrOpts || 'log' in envOrOpts || 'env' in envOrOpts;
  const opts: SenderOpts = isOpts ? (envOrOpts as SenderOpts) : { env: envOrOpts as NodeJS.ProcessEnv, log: logArg };
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? logArg;
  const base = env.CHANNELTALK_API_BASE || 'https://api.channel.io/open/v5';
  const botName = encodeURIComponent(env.CHANNELTALK_BOT_NAME || 'AI 상담원');

  async function resolveKeys(tenantId?: string): Promise<{ key: string; secret: string } | null> {
    if (tenantId && opts.db && opts.secrets) {
      const [sec] = await opts.db.withTenant(
        tenantId,
        (tx) => tx.select({ c: s.secrets.ciphertext }).from(s.secrets).where(and(eq(s.secrets.tenantId, tenantId), eq(s.secrets.kind, 'channeltalk'))),
        { readOnly: true },
      );
      if (sec) {
        const opened = opts.secrets.open<{ access_key: string; access_secret: string }>(sec.c);
        if (opened.access_key && opened.access_secret) return { key: opened.access_key, secret: opened.access_secret };
      }
    }
    const key = env.CHANNELTALK_ACCESS_KEY?.trim();
    const secret = env.CHANNELTALK_ACCESS_SECRET?.trim();
    return key && secret ? { key, secret } : null;
  }

  return {
    async send(chatId, text, tenantId) {
      const creds = await resolveKeys(tenantId);
      if (!creds) {
        log(`channeltalk sender off (키 없음): ${chatId}`);
        return;
      }
      const res = await fetchFn(`${base}/user-chats/${encodeURIComponent(chatId)}/messages?botName=${botName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-access-key': creds.key, 'x-access-secret': creds.secret },
        body: JSON.stringify({ blocks: [{ type: 'text', value: text }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`channeltalk send ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}
