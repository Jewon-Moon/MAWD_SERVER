// Vapi: 음성 인식 · 말 끝 감지 · 끼어들기 · 음성 합성만 맡김. 답변은 Vapi가 우리 서버(/v1/vapi/{token}/chat/completions, Custom LLM)를 불러서 받음
// → 상태 머신 · 본인 확인 · 안전장치는 브라우저 통화와 같은 코드 (docs.vapi.ai/customization/custom-llm/using-your-server)
import type { TenantConfig } from '../tenantConfig.js';

const VAPI_API = 'https://api.vapi.ai';
// Vapi는 Custom LLM과 함께 쓸 때 OpenAI 음성 일부(coral · ash · ballad · sage · verse)를 거부함 (2026-11-14 실제 API로 확인).
// 그 외(브라우저 음성 이름 등)는 coral과 가장 비슷한 marin
const VAPI_OPENAI_VOICES = new Set(['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer', 'marin', 'cedar']);
export const SECRET_HEADER = 'x-mawd-secret';

// 음성 인식이 자주 틀리는 상담 단어 + 매장 상품명 (Deepgram 키워드 힌트). 예: "재질"이 "기술"로 들리던 문제
const SUPPORT_TERMS = ['재질', '소재', '촉감', '디자인', '감각', '색상', '사이즈', '핏', '교환', '환불', '반품', '배송', '택배', '송장', '주문번호', '불량', '파손', '품절', '쿠폰', '결제', '취소'];
/** 매장의 통화 목소리 → Vapi voice. 제공사마다 속도 범위가 달라 맞춰 넣음 */
function vapiVoice(v: TenantConfig['settings']['voice']) {
  const { provider, voice_id, model } = v.vapi_voice;
  const rate = v.tts.rate;
  if (provider === 'azure') {
    const azureVoice = /^[a-z]{2}-[A-Z]{2}-.+Neural$/.test(voice_id) ? voice_id : 'ko-KR-SunHiNeural';
    return { provider, voiceId: azureVoice, speed: Math.min(2, Math.max(0.5, rate)) };
  }
  if (provider === '11labs') {
    const elevenVoice = /^[a-z]{2}-[A-Z]{2}-/.test(voice_id) || VAPI_OPENAI_VOICES.has(voice_id) ? 'EXAVITQu4vr4xnSDxMaL' : voice_id;
    return { provider, voiceId: elevenVoice, model: model || 'eleven_flash_v2_5', language: 'ko', speed: Math.min(1.2, Math.max(0.7, rate)) };
  }
  return {
    provider: 'openai', model: 'gpt-4o-mini-tts', voiceId: VAPI_OPENAI_VOICES.has(voice_id) ? voice_id : 'marin',
    speed: rate, ...(v.tts.instructions ? { instructions: v.tts.instructions } : {}),
  };
}

/** 매장이 고른 음성 인식 엔진 → Vapi transcriber. 힌트(매장 단어)를 받는 엔진엔 각자 형식으로 넣음 */
function transcriberOf(cfg: TenantConfig) {
  const terms = keytermsOf(cfg);
  switch (cfg.settings.voice.transcriber) {
    case 'azure': return { provider: 'azure', language: 'ko-KR' };
    case 'soniox': return { provider: 'soniox', model: 'stt-rt-v6', language: 'ko', customVocabulary: terms };
    case 'openai': return { provider: 'openai', model: 'gpt-transcribe', language: 'ko', keywords: terms };
    case '11labs': return { provider: '11labs', model: 'scribe_v2_realtime', language: 'ko' };
    default: return {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'ko',
      endpointing: Math.min(1000, Math.max(500, Math.round(cfg.settings.voice.silence_ms / 2))),
      keyterm: terms,
    };
  }
}

export function keytermsOf(cfg: TenantConfig): string[] {
  const names = [...cfg.context.offerings.matchAll(/^##\s+(.+?)(?:\s+\(|\s+—|$)/gm)].map((m) => m[1]!.trim());
  return [...new Set([...cfg.settings.voice.keyterms, cfg.storeName, ...names, ...SUPPORT_TERMS])].filter((t) => t && t.length <= 40).slice(0, 50);
}

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
    voice: vapiVoice(v),
    // endpointing: Deepgram이 조용해진 뒤 문장을 확정하기까지 (짧으면 숨 고르는 사이에 문장이 잘림)
    transcriber: transcriberOf(cfg),
    // 한국어 인식 결과는 문장부호가 거의 없어 onNoPunctuationSeconds가 사실상 "말 끝 판단 시간" (매장 설정 silence_ms)
    startSpeakingPlan: {
      waitSeconds: 0.4,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: Math.min(3, Math.max(0.3, v.silence_ms / 2000)),
        onNoPunctuationSeconds: Math.min(3, v.silence_ms / 1000),
        onNumberSeconds: Math.min(3, Math.max(1, v.silence_ms / 1000)), // 주문번호 · 전화번호를 끊어 부르는 동안 기다림
      },
    },
    ...(v.noise_suppression === 'off' ? {} : {
      backgroundSpeechDenoisingPlan: {
        smartDenoisingPlan: { enabled: true },
        // 배경 음성 · TV처럼 일정하게 깔리는 소리를 걸러냄 (Vapi 실험 기능)
        ...(v.noise_suppression === 'strong' ? { fourierDenoisingPlan: { enabled: true, mediaDetectionEnabled: true } } : {}),
      },
    }),
    // 끼어들기를 켠 매장도 0.3초 이상/2단어 이상 발화에만 멈춰 배경 소음으로 인한 오작동을 줄임
    stopSpeakingPlan: v.barge_in
      ? { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 0.8 }
      : { numWords: 10 },
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
