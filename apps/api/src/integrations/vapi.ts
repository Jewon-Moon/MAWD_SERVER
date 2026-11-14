// Vapi: 음성 인식 · 말 끝 감지 · 끼어들기 · 음성 합성만 맡김. 답변은 Vapi가 우리 서버(/v1/vapi/{token}/chat/completions, Custom LLM)를 불러서 받음
// → 상태 머신 · 본인 확인 · 안전장치는 브라우저 통화와 같은 코드 (docs.vapi.ai/customization/custom-llm/using-your-server)
import type { TenantConfig } from '../tenantConfig.js';

const VAPI_API = 'https://api.vapi.ai';
// Vapi는 Custom LLM과 함께 쓸 때 OpenAI 음성 일부(coral · ash · ballad · sage · verse)를 거부함 (2026-11-14 실제 API로 확인).
// 그 외(브라우저 음성 이름 등)는 coral과 가장 비슷한 marin
const VAPI_OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer', 'marin', 'cedar']);
export const SECRET_HEADER = 'x-mawd-secret';

/** 매장 설정 → Vapi 어시스턴트 설정. 매장이 음성 설정을 바꾸면 다시 동기화(POST /v1/vapi/assistant/sync) */
export function vapiAssistantConfig(cfg: TenantConfig, o: { baseUrl: string; webhookToken: string; secret?: string; tenantId: string }) {
  const v = cfg.settings.voice;
  const root = `${o.baseUrl.replace(/\/$/, '')}/v1/vapi/${o.webhookToken}`;
  const headers = o.secret ? { [SECRET_HEADER]: o.secret } : {};
  return {
    name: `감정방패-${cfg.storeName}`.slice(0, 40),
    // 인사도 우리 서버가 만듦 (매장 템플릿 · AI 고지 · 통화 기록 시작을 한곳에서)
    firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
    model: { provider: 'custom-llm', url: root, model: 'mawd-call', headers, metadataSendMode: 'variable', timeoutSeconds: 20 },
    voice: {
      provider: 'openai', model: 'gpt-4o-mini-tts',
      voiceId: VAPI_OPENAI_VOICES.has(v.tts.voice_name ?? '') ? v.tts.voice_name : 'marin',
      speed: v.tts.rate, ...(v.tts.instructions ? { instructions: v.tts.instructions } : {}),
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'ko' },
    startSpeakingPlan: { waitSeconds: Math.min(5, v.silence_ms / 1000) },
    // 끼어들기를 끈 매장은 고객이 꽤 길게(10단어) 말해야 멈춤 (Vapi에 완전히 끄는 옵션은 없음)
    stopSpeakingPlan: { numWords: v.barge_in ? 0 : 10 },
    maxDurationSeconds: v.max_call_minutes * 60,
    server: { url: `${root}/events`, headers },
    serverMessages: ['end-of-call-report', 'status-update'],
    metadata: { tenant_id: o.tenantId },
  };
}

export type VapiClient = ReturnType<typeof createVapiClient>;

export function createVapiClient(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch) {
  const key = env.VAPI_PRIVATE_KEY;
  return {
    configured: !!(key && env.VAPI_PUBLIC_KEY && env.PUBLIC_BASE_URL),
    publicKey: env.VAPI_PUBLIC_KEY || null,
    /** id가 있으면 그 어시스턴트를 덮어쓰고, 없으면 새로 만듦. 어시스턴트 id 반환 */
    async upsertAssistant(id: string | null, body: object): Promise<string> {
      const res = await fetchFn(id ? `${VAPI_API}/assistant/${id}` : `${VAPI_API}/assistant`, {
        method: id ? 'PATCH' : 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`vapi assistant ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()) as { id: string }).id;
    },
    /** 통화 중 제어 (docs.vapi.ai/calls/call-features). 마지막 인사를 다 읽은 뒤 끊기에 사용 */
    async control(controlUrl: string, body: object) {
      const res = await fetchFn(controlUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`vapi control ${res.status}`);
    },
  };
}
