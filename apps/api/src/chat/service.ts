// 채팅 응대 (F1~F7): 전화와 같은 상태 머신 · 안전장치(runTurn)를 쓰고, 문장을 모아 한 번에 보냅니다.
// - 답하는 중에 온 메시지는 모아서 다음 턴에 한꺼번에 처리 (고객이 여러 줄로 나눠 보내는 경우)
// - 사장님 연결(HANDOFF)이 되면 AI는 더 답하지 않고 기록만 (사장님이 채널톡에서 직접 답함)
// - 고객이 response.chat_idle_minutes 동안 조용하면 마무리 + 요약 카드
import type { z } from 'zod';
import type { Card } from '@mawd/contracts';
import type { createDb } from '../db/client.js';
import * as s from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ChatSender, IncomingMessage } from '../integrations/channeltalk.js';
import type { Llm } from '../integrations/llm.js';
import { getTenantConfig } from '../tenantConfig.js';
import { newVerifyState } from '../tools/orders.js';
import type { CallSession } from '../voice/policy.js';
import type { AlertCenter } from '../alerts.js';
import type { Bivia } from '../integrations/bivia.js';
import type { Rag } from '../knowledge/rag.js';
import type { Tracker } from '../integrations/tracker.js';
import type { CommerceService } from '../commerce/service.js';
import { createContextStore } from '../context/docs.js';
import { isOpen } from '../voice/policy.js';
import { finalizeInquiry, runTurn } from '../voice/turn.js';

type Db = ReturnType<typeof createDb>;
export type ChatSession = CallSession & {
  chatId: string;
  pending: string[];
  busy: boolean;
  handedOff: boolean;
  finalized: boolean;
  card: z.infer<typeof Card> | null;
  idle?: NodeJS.Timeout;
  idleDone?: Promise<void>;
};
type Log = { error: (obj: object, msg: string) => void };

export function createChatService(deps: { db: Db; llm: Llm; sender: ChatSender; log: Log; alerts?: AlertCenter; bivia?: Bivia; rag?: Rag; tracker?: Tracker; commerce?: CommerceService }) {
  // shortcut: 대화 세션을 프로세스 메모리에 둠 (서버 1대 기준). 여러 대면 Redis + 채팅방별 순서 보장 큐로
  const sessions = new Map<string, Promise<ChatSession>>();
  const closed = new Map<string, ChatSession>(); // 마무리된 대화 (데모 화면이 카드를 읽음). 최근 100개만
  const key = (tenantId: string, chatId: string) => `${tenantId}:${chatId}`;
  const turnDeps = (sess: ChatSession) => ({ db: deps.db, llm: deps.llm, alerts: deps.alerts, bivia: deps.bivia, rag: deps.rag, tracker: deps.tracker, commerce: deps.commerce, cfg: getTenantConfig(sess.tenantId) });

  async function open(tenantId: string, msg: IncomingMessage): Promise<ChatSession> {
    await createContextStore(deps.db).load(tenantId).catch(() => {}); // 매장 문서 최신본
    // 채널톡 상담방 하나 = 문의 하나 (UNIQUE tenant_id, external_chat_id). 마무리된 방에 다시 쓰면 같은 문의를 다시 열고,
    // 사장님이 넘겨받은 방(ai_muted)이면 서버가 재시작돼도 AI는 계속 조용히 있음
    const [inq] = await deps.db.withTenant(tenantId, (tx) => tx.insert(s.inquiries)
      .values({ tenantId, channel: 'chat', status: 'pending', externalChatId: msg.chatId, customerName: msg.customerName })
      .onConflictDoUpdate({ target: [s.inquiries.tenantId, s.inquiries.externalChatId], set: { status: 'pending', updatedAt: new Date() } })
      .returning({ id: s.inquiries.id, aiMuted: s.inquiries.aiMuted }));
    return {
      id: inq!.id, channel: 'chat', tenantId, inquiryId: inq!.id, chatId: msg.chatId, state: 'LISTEN', verify: newVerifyState(), abuseStreak: 0,
      awaitingVerify: false, pendingQuestion: null, heat: 0, needsOwner: false, riskFlags: new Set(), history: [], turnLatencies: [], orderData: [],
      ended: false, pending: [], busy: false, handedOff: inq!.aiMuted, finalized: false, card: null,
    };
  }

  /** 요약 카드는 대화당 한 번 (사장님 연결 시점 또는 마무리 시점 중 먼저) */
  async function finalize(sess: ChatSession) {
    if (sess.finalized) return;
    sess.finalized = true;
    try { sess.card = await finalizeInquiry(sess, turnDeps(sess)); }
    catch (err) { deps.log.error({ err, inquiry: sess.inquiryId }, 'chat card failed'); }
  }

  function close(sess: ChatSession) {
    clearTimeout(sess.idle);
    sess.ended = true;
    const k = key(sess.tenantId, sess.chatId);
    sessions.delete(k); // 다음 메시지는 문의를 다시 열어 새 세션으로
    closed.set(k, sess);
    if (closed.size > 100) closed.delete(closed.keys().next().value!);
    return finalize(sess);
  }

  async function drain(sess: ChatSession) {
    sess.busy = true;
    try {
      while (sess.pending.length && !sess.ended && !sess.handedOff) {
        const text = sess.pending.splice(0).join('\n');
        const parts: string[] = [];
        let endCall = false;
        for await (const e of runTurn(sess, text, turnDeps(sess), new AbortController().signal)) {
          if (e.type === 'sentence') parts.push(e.text);
          if (e.type === 'done') endCall = e.end_call;
        }
        if (parts.length) await deps.sender.send(sess.chatId, parts.join(' ')).catch((err) => deps.log.error({ err, chat: sess.chatId }, 'channeltalk send failed'));
        if (endCall) { await close(sess); break; }
        // 영업시간에는 사장님이 이어받으므로 AI 대기. 영업시간 밖에는 AI가 계속 응대하고(24시간), 카드는 대화가 끝날 때 전체 내용으로
        if (sess.state === 'HANDOFF' && isOpen(getTenantConfig(sess.tenantId).settings.hours, new Date())) {
          sess.handedOff = true;
          await deps.db.withTenant(sess.tenantId, (tx) => tx.update(s.inquiries).set({ aiMuted: true }).where(eq(s.inquiries.id, sess.inquiryId)));
          void finalize(sess); // 카드 생성(수 초)은 기다리지 않음. 사장님 화면은 GET /chats/{id} 로 확인
        }
      }
    } catch (err) {
      deps.log.error({ err, chat: sess.chatId }, 'chat turn failed');
    } finally {
      sess.busy = false;
    }
  }

  return {
    /** 웹훅에서 호출. 응답은 기다리지 않아도 됨 (채널톡 웹훅은 빨리 200을 받아야 함) */
    async handle(tenantId: string, msg: IncomingMessage): Promise<void> {
      const { response } = getTenantConfig(tenantId).settings;
      if (!response.ai_enabled || !response.channels.chat) return; // AI 꺼진 매장: 사장님이 채널톡에서 직접 응대
      const k = key(tenantId, msg.chatId);
      let p = sessions.get(k);
      if (!p) { p = open(tenantId, msg); sessions.set(k, p); p.catch(() => sessions.delete(k)); }
      const sess = await p;
      clearTimeout(sess.idle);
      sess.idle = setTimeout(() => { sess.idleDone = close(sess); }, response.chat_idle_minutes * 60_000);
      sess.idle.unref();
      if (sess.handedOff) {
        // AI는 조용히 기록만. 사장님 화면에서 이어지는 고객 말을 볼 수 있게
        sess.history.push({ role: 'user', content: msg.text });
        await deps.db.withTenant(tenantId, (tx) => tx.insert(s.messages).values({ tenantId, inquiryId: sess.inquiryId, sender: 'customer', text: msg.text }));
        return;
      }
      sess.pending.push(msg.text);
      if (!sess.busy) await drain(sess);
    },
    /** 데모 · 디버그용 */
    async get(tenantId: string, chatId: string) { return (await sessions.get(key(tenantId, chatId))) ?? closed.get(key(tenantId, chatId)); },
    /** 사장님이 '종료' 처리하거나 데모에서 강제로 마무리할 때 */
    async end(tenantId: string, chatId: string) {
      const p = sessions.get(key(tenantId, chatId));
      if (!p) return null;
      const sess = await p;
      await close(sess);
      return sess;
    },
  };
}
export type ChatService = ReturnType<typeof createChatService>;
