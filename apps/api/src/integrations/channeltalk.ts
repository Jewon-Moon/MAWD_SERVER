// 채널톡 연동. 웹훅 형식 · 발송 API는 공식 문서(developers.channel.io, api-doc.channel.io)를 보고 만든 추정치라
// 해커톤 당일 실제 페이로드와 대조해 이 파일만 고치면 됩니다. 체크리스트: docs/channeltalk-dayof.md

export type IncomingMessage = { chatId: string; text: string; customerName: string | null; customerPhone: string | null };

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
  const text = typeof e.plainText === 'string' ? e.plainText.trim() : '';
  if (!text || typeof e.chatId !== 'string') return null;
  return { chatId: e.chatId, text: text.slice(0, 2000), customerName: b.refers?.user?.name ?? null, customerPhone: b.refers?.user?.profile?.mobileNumber ?? null };
}

export interface ChatSender {
  send(chatId: string, text: string): Promise<void>;
}

/** 키가 없으면 보내지 않고 로그만 (데모 페이지 · 테스트용). 데모 화면은 서버의 대화 기록을 직접 보여 줌 */
export function createChannelTalkSender(env = process.env, log: (msg: string) => void = () => {}): ChatSender {
  const key = env.CHANNELTALK_ACCESS_KEY, secret = env.CHANNELTALK_ACCESS_SECRET;
  if (!key || !secret) return { async send(chatId) { log(`channeltalk sender off (키 없음): ${chatId}`); } };
  // shortcut: 매장 하나의 키를 환경변수로. 여러 매장이면 secrets 테이블(암호화)에서 매장별로 꺼내 씀
  const base = env.CHANNELTALK_API_BASE || 'https://api.channel.io/open/v5';
  const botName = encodeURIComponent(env.CHANNELTALK_BOT_NAME || 'AI 상담원');
  return {
    async send(chatId, text) {
      const res = await fetch(`${base}/user-chats/${encodeURIComponent(chatId)}/messages?botName=${botName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-access-key': key, 'x-access-secret': secret },
        body: JSON.stringify({ blocks: [{ type: 'text', value: text }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`channeltalk send ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}
