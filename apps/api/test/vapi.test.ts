// Vapi 연동 테스트: Vapi가 보내는 Custom LLM 요청 · 서버 메시지를 흉내 내서 인사 → 본인 확인 → 종료(통화 제어) → 요약 카드까지.
// LLM · Vapi API는 스텁, DB는 테스트 DB
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import type { Llm } from '../src/integrations/llm.js';
import { vapiAssistantConfig, type VapiClient } from '../src/integrations/vapi.js';
import { TENANT_ID } from '../src/mocks/data.js';
import { getTenantConfig, store } from '../src/tenantConfig.js';
import { testUrls } from './urls.js';

const db = createDb(testUrls().app);
const llm: Llm = {
  async *stream() { yield '평일 10시부터 19시까지 운영해요.'; },
  async json(_m, schema, { name }) {
    return schema.parse(name === 'call_card'
      ? { title: '통화 문의', demands: ['안내'], facts: [], recommendations: [{ label: '안내', draft: '안내드립니다.', policy_ref: null }], heat_label: '보통', risk_flags: [] }
      : { heat: 10, needs_owner: false, risk_flags: [] });
  },
  async warmup() {},
};
const controls: { url: string; body: Record<string, unknown> }[] = [];
const upserts: { id: string | null; body: Record<string, unknown> }[] = [];
const vapi: VapiClient = {
  configured: true, publicKey: 'pk-test',
  async upsertAssistant(id, body) { upserts.push({ id, body: body as Record<string, unknown> }); return id ?? 'asst-1'; },
  async control(url, body) { controls.push({ url, body: body as Record<string, unknown> }); },
};
process.env.VAPI_SERVER_SECRET = 'vapi-secret';
process.env.PUBLIC_BASE_URL = 'https://demo.example.com';
delete process.env.VAPI_ASSISTANT_ID; // 실제 .env 값과 무관하게 새로 만드는 경로부터
const app = await buildApp({ db, llm, vapi });

const CONTROL = 'https://phone-call-websocket.example/control/abc';
const llmCall = (callId: string, messages: { role: string; content: string }[], secret = 'vapi-secret', token = 'demo-token') =>
  app.inject({
    method: 'POST', url: `/v1/vapi/${token}/chat/completions`, headers: { 'x-mawd-secret': secret },
    payload: { model: 'mawd-call', stream: true, messages, call: { id: callId, monitor: { controlUrl: CONTROL } } },
  });
// SSE 본문에서 Vapi가 읽을 텍스트만 이어 붙임
const spoken = (body: string) => body.split('\n\n').filter((l) => l.startsWith('data: {'))
  .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('').trim();

beforeAll(async () => {
  await db.withTenant(TENANT_ID, (tx) => tx.insert(s.tenants).values({ id: TENANT_ID, name: '데모 상점', webhookToken: 'demo-token' }).onConflictDoNothing());
  store.settings.hours.weekly = Object.fromEntries((['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((d) => [d, [{ open: '00:00', close: '23:59' }]])) as typeof store.settings.hours.weekly; store.settings.hours.holidays = []; // 테스트 시각과 무관하게 영업 중
});
afterAll(async () => { await app.close(); await db.close(); });

describe('Vapi Custom LLM', () => {
  it('매장 토큰이 없으면 404, 확인 값이 틀리면 401', async () => {
    expect((await llmCall('c-x', [], 'vapi-secret', 'nope')).statusCode).toBe(404);
    expect((await llmCall('c-x', [], 'wrong')).statusCode).toBe(401);
  });

  it('첫 요청은 인사(AI 고지), 이후 고객 발화마다 같은 상태 머신으로 답하고 OpenAI 스트림 형식으로 끝난다', async () => {
    const hi = await llmCall('call-1', [{ role: 'system', content: '' }]);
    expect(hi.headers['content-type']).toContain('text/event-stream');
    expect(spoken(hi.body)).toContain('AI');
    expect(hi.body.trim().endsWith('data: [DONE]')).toBe(true);

    const r = await llmCall('call-1', [{ role: 'assistant', content: '안녕하세요' }, { role: 'user', content: '주문한 거 언제 와요?' }]);
    expect(spoken(r.body)).toBe('확인을 위해 주문번호와 연락처 뒷 4자리를 알려주세요.');
    const d = (await app.inject({ method: 'GET', url: '/v1/vapi/calls/call-1' })).json();
    expect(d).toMatchObject({ state: 'VERIFY', ended: false });
    expect(d.transcript.at(-2)).toEqual({ role: 'customer', text: '주문한 거 언제 와요?' });
  });

  it('말이 잘려 고객 발화가 연달아 오면 한 턴으로 합쳐 답한다 (앞부분을 잃지 않음)', async () => {
    await llmCall('call-split', [{ role: 'system', content: '' }]);
    await llmCall('call-split', [{ role: 'assistant', content: '안녕하세요' }, { role: 'user', content: '인스타 보고 잠옷을 샀는데' }, { role: 'user', content: '재질이 너무 거칠어요' }]);
    const d = (await app.inject({ method: 'GET', url: '/v1/vapi/calls/call-split' })).json();
    expect(d.transcript.at(-2)).toEqual({ role: 'customer', text: '인스타 보고 잠옷을 샀는데 재질이 너무 거칠어요' });
  });

  it('종료 턴의 마지막 인사는 응답에 싣지 않고 "다 읽고 끊기" 통화 제어로 보낸다', async () => {
    const r = await llmCall('call-1', [{ role: 'user', content: '네 됐어요 끊을게요' }]);
    expect(spoken(r.body)).toBe('');
    expect(controls.at(-1)).toEqual({ url: CONTROL, body: { type: 'say', content: '말씀하신 내용으로 접수했습니다. 감사합니다.', endCallAfterSpoken: true } });
  });

  it('통화 종료 보고가 오면 요약 카드를 만든다 (중복 보고는 무시)', async () => {
    const ev = (type: string, extra = {}) => app.inject({ method: 'POST', url: '/v1/vapi/demo-token/events', headers: { 'x-mawd-secret': 'vapi-secret' }, payload: { message: { type, call: { id: 'call-1' }, ...extra } } });
    expect((await ev('end-of-call-report')).statusCode).toBe(200);
    expect((await ev('status-update', { status: 'ended' })).statusCode).toBe(200);
    const end = Date.now() + 3000;
    let d;
    do { d = (await app.inject({ method: 'GET', url: '/v1/vapi/calls/call-1' })).json(); } while (!d.card && Date.now() < end && (await new Promise((r) => setTimeout(r, 20)), true));
    expect(d).toMatchObject({ ended: true, state: 'CLOSE', card: { title: '통화 문의' } });
    const cards = await db.withTenant(TENANT_ID, (tx) => tx.select().from(s.cards));
    expect(cards.filter((c) => c.inquiryId === d.inquiry_id)).toHaveLength(1);
  });
});

describe('Vapi 어시스턴트 동기화', () => {
  it('매장 음성 설정으로 어시스턴트를 만들고, 답변 주소 · 종료 보고 주소에 매장 토큰과 확인 값을 싣는다', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/vapi/assistant/sync' });
    expect(r.json()).toEqual({ assistant_id: 'asst-1' });
    const b = upserts.at(-1)!.body as ReturnType<typeof vapiAssistantConfig>;
    expect(b.model).toMatchObject({ provider: 'custom-llm', url: 'https://demo.example.com/v1/vapi/demo-token', headers: { 'x-mawd-secret': 'vapi-secret' } });
    expect(b.server.url).toBe('https://demo.example.com/v1/vapi/demo-token/events');
    expect(b.voice).toEqual({ provider: 'azure', voiceId: 'ko-KR-SunHiNeural', speed: 1.2 }); // 기본: 한국어 원어민 음성
    expect(b.transcriber).toMatchObject({ provider: 'deepgram', model: 'nova-3', language: 'ko', endpointing: 600 });
    expect(b.transcriber.keyterm).toEqual(expect.arrayContaining(['재질', '교환', '머그컵', '텀블러'])); // 상담 단어 + 매장 상품명
    // 문장부호 없이 끝나면 silence_ms(기본 1200ms)만큼 기다려 숨 고르는 사이에 끊지 않음
    expect(b.startSpeakingPlan.transcriptionEndpointingPlan).toMatchObject({ onNoPunctuationSeconds: 1.2, onNumberSeconds: 1.2 });
    // 두 번째부터는 같은 어시스턴트를 갱신
    await app.inject({ method: 'POST', url: '/v1/vapi/assistant/sync' });
    expect(upserts.at(-1)!.id).toBe('asst-1');
    expect((await app.inject({ method: 'GET', url: '/v1/vapi/config' })).json()).toEqual({ enabled: true, public_key: 'pk-test', assistant_id: 'asst-1' });
  });

  it('음성 인식 엔진 선택 · 매장 단어 힌트가 엔진별 형식으로 들어간다', () => {
    const cfg = structuredClone(getTenantConfig(TENANT_ID));
    const tr = () => vapiAssistantConfig(cfg, { baseUrl: 'https://x/', webhookToken: 't', tenantId: TENANT_ID }).transcriber as Record<string, unknown>;
    cfg.settings.voice.keyterms = ['디자인 감각'];
    expect((tr().keyterm as string[])[0]).toBe('디자인 감각'); // 매장 단어가 맨 앞
    cfg.settings.voice.transcriber = 'azure';
    expect(tr()).toEqual({ provider: 'azure', language: 'ko-KR' });
    cfg.settings.voice.transcriber = 'soniox';
    expect(tr()).toMatchObject({ provider: 'soniox', language: 'ko', customVocabulary: expect.arrayContaining(['디자인 감각', '감각']) });
    cfg.settings.voice.transcriber = 'openai';
    expect(tr()).toMatchObject({ provider: 'openai', model: 'gpt-transcribe', keywords: expect.arrayContaining(['디자인 감각']) });
  });

  it('외부 소음 억제: 기본은 Krisp, strong이면 배경 음성 필터까지, off면 없음', () => {
    const cfg = structuredClone(getTenantConfig(TENANT_ID));
    const conf = () => vapiAssistantConfig(cfg, { baseUrl: 'https://x/', webhookToken: 't', tenantId: TENANT_ID }) as Record<string, unknown>;
    expect(conf().backgroundSpeechDenoisingPlan).toEqual({ smartDenoisingPlan: { enabled: true } });
    cfg.settings.voice.noise_suppression = 'strong';
    expect(conf().backgroundSpeechDenoisingPlan).toEqual({ smartDenoisingPlan: { enabled: true }, fourierDenoisingPlan: { enabled: true, mediaDetectionEnabled: true } });
    cfg.settings.voice.noise_suppression = 'off';
    expect(conf()).not.toHaveProperty('backgroundSpeechDenoisingPlan');
  });

  it('매장이 목소리 제공사를 바꾸면 그대로, 제공사별 속도 범위에 맞춤. openai에서 Vapi가 거부하는 목소리는 marin', () => {
    const cfg = structuredClone(getTenantConfig(TENANT_ID));
    const conf = () => vapiAssistantConfig(cfg, { baseUrl: 'https://x/', webhookToken: 't', tenantId: TENANT_ID }).voice;
    cfg.settings.voice.vapi_voice = { provider: '11labs', voice_id: 'sarah', model: null };
    expect(conf()).toMatchObject({ provider: '11labs', voiceId: 'sarah', model: 'eleven_flash_v2_5', language: 'ko', speed: 1.2 });
    cfg.settings.voice.tts.rate = 1.8;
    expect(conf()).toMatchObject({ speed: 1.2 }); // 11labs는 1.2까지
    cfg.settings.voice.vapi_voice = { provider: 'openai', voice_id: 'coral', model: null };
    expect(conf()).toMatchObject({ provider: 'openai', voiceId: 'marin' });
  });
});
