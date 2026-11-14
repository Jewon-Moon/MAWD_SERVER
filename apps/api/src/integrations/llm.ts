// LLM 어댑터 (라이너 Router 기본 · OpenAI 호환). LLM_BASE_URL로 라이너 Router · EXAONE · OpenAI 등 선택.
// EXAONE은 추론을 끌 수 없고(추론 토큰이 max_tokens에 포함), 구조화 출력(json_schema)이 문서에 없어 아래에서 따로 처리
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';

export type ChatMessage = ChatCompletionMessageParam;
export type ModelTier = 'fast' | 'smart';
export type RoutingStrategy = 'cost' | 'balanced' | 'quality';

/** 테스트에서 바꿔 끼울 수 있게 인터페이스로 둡니다 */
export interface Llm {
  /** 텍스트 조각을 스트리밍. signal로 중간 취소(끼어들기) */
  stream(messages: ChatMessage[], opts: { tier: ModelTier; model?: string; routing?: RoutingStrategy; signal?: AbortSignal; maxTokens?: number }): AsyncIterable<string>;
  /** 통화 시작 시 API 연결(TLS)을 미리 맺어 첫 턴 지연을 줄임. 토큰을 쓰지 않는 GET /models */
  warmup(): Promise<void>;
  /** 스키마에 맞는 JSON 한 개 */
  json<T extends z.ZodTypeAny>(messages: ChatMessage[], schema: T, opts: { tier: ModelTier; model?: string; routing?: RoutingStrategy; name: string; jsonSchema: Record<string, unknown> }): Promise<z.infer<T>>;
}

// EXAONE은 추론 토큰도 max_tokens에 포함 → 답변 길이에 이만큼 더 줘야 답이 잘리지 않음
const EXAONE_REASONING_BUDGET = 2048;
const LINER_BASE_URL = 'https://platform.liner.com/api/v1';

/** 설정값(cost/balanced/quality) → 라이너 Router 파라미터 (실제 API: router 모델만 cost · balanced · quality 허용) */
function linerRouting(modelName: string, routing?: RoutingStrategy) {
  if (!routing || !modelName.includes('router')) return {};
  return { routing_strategy: routing };
}

export function createLlm(env = process.env, fetchFn?: typeof fetch): Llm {
  const baseURL = env.LLM_BASE_URL?.trim() || LINER_BASE_URL;
  const isLiner = baseURL.includes('liner.com');
  const isExaone = baseURL.includes('exaone.ai');
  const apiKey = (isLiner ? env.LINER_API_KEY?.trim() : undefined) || env.LLM_API_KEY?.trim() || env.LINER_API_KEY?.trim();
  const client = new OpenAI({ baseURL, apiKey, maxRetries: 1, timeout: 30_000, ...(fetchFn ? { fetch: fetchFn } : {}) });
  // json_schema(구조화 출력)를 지원하지 않는 곳은 스키마를 프롬프트로 주고 응답을 zod로 검증 (LLM_JSON_MODE로 강제 가능)
  const jsonMode = env.LLM_JSON_MODE === 'prompt' || env.LLM_JSON_MODE === 'schema' ? env.LLM_JSON_MODE : isExaone ? 'prompt' : 'schema';
  const tokens = (max?: number) => (isExaone ? { max_tokens: (max ?? 1024) + EXAONE_REASONING_BUDGET } : max ? { max_completion_tokens: max } : {});
  const model = (tier: ModelTier, override?: string) => {
    const envModel = (tier === 'fast' ? env.LLM_MODEL_FAST : env.LLM_MODEL_SMART)?.trim();
    if (isLiner) {
      // .env에 이전 OpenAI 모델명(gpt-4.1-mini 등)이 남아 있어도 라이너에서 400이 나지 않도록 매장 설정 · 라이너 모델 우선
      const linerEnv = envModel && (envModel.startsWith('liner-') || envModel.includes('/')) ? envModel : '';
      return override?.trim() || linerEnv || 'liner-gpt-router';
    }
    return envModel || override || 'liner-gpt-router';
  };
  // 라이너 Router 전용 파라미터. OpenAI 등에 보내면 400이라 라이너일 때만 붙임
  const extra = (modelName: string, routing?: RoutingStrategy) => (isLiner ? linerRouting(modelName, routing) : {});
  // 음성 턴은 첫 토큰 속도가 중요. 추론 모델이면 LLM_REASONING_FAST=none 으로 추론을 끔
  // EXAONE은 추론을 끌 수 없어 low가 가장 빠름 (기본 max는 느림). LLM_REASONING_SMART로 카드 등 고성능 작업의 강도 조절
  const reasoning = (tier: ModelTier) => {
    const v = (tier === 'fast' ? env.LLM_REASONING_FAST : env.LLM_REASONING_SMART)?.trim() || (isExaone ? (tier === 'fast' ? 'low' : 'high') : '');
    return v ? { reasoning_effort: v as OpenAI.ReasoningEffort } : {};
  };

  return {
    async *stream(messages, { tier, model: override, routing, signal, maxTokens }) {
      const m = model(tier, override);
      const res = await client.chat.completions.create(
        { model: m, messages, stream: true, ...tokens(maxTokens), ...extra(m, routing), ...reasoning(tier) } as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal },
      );
      let started = false;
      for await (const chunk of res) {
        // 추론 과정(delta.reasoning_content)은 고객에게 보내지 않음. 답변(content)만
        let delta = chunk.choices[0]?.delta?.content;
        if (!started && delta) delta = delta.replace(/^\s+/, ''); // EXAONE은 답변 앞에 줄바꿈이 붙을 수 있음
        if (delta) { started = true; yield delta; }
      }
    },
    async warmup() {
      await client.models.list().catch(() => {});
    },
    async json(messages, schema, { tier, model: override, routing, name, jsonSchema }) {
      const m = model(tier, override);
      if (jsonMode === 'schema') {
        try {
          const res = await client.chat.completions.create({
            model: m, messages, ...extra(m, routing), ...reasoning(tier),
            response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema } },
          } as OpenAI.ChatCompletionCreateParamsNonStreaming);
          return schema.parse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
        } catch (err) {
          // 라이너 Router 하위 모델 중 strict json_schema를 지원하지 않는 경우 프롬프트 JSON 추출로 폴백
          if (!isLiner) throw err;
        }
      }
      // 프롬프트 방식: 스키마를 알려주고, 응답에서 JSON 객체만 꺼내 zod로 검증. 형식이 틀리면 한 번 더
      const ask: ChatMessage = { role: 'system', content: `다른 말 없이 아래 JSON 스키마에 맞는 JSON 객체 하나만 출력하세요. 코드 블록 · 설명 금지.\n${JSON.stringify(jsonSchema)}` };
      let lastErr: unknown;
      for (let i = 0; i < 2; i++) {
        const res = await client.chat.completions.create({ model: m, messages: [...messages, ask], ...tokens(1500), ...extra(m, routing), ...reasoning(tier) } as OpenAI.ChatCompletionCreateParamsNonStreaming);
        try { return schema.parse(extractJson(res.choices[0]?.message?.content ?? '')); } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
  };
}

/** 응답 텍스트에서 첫 '{'부터 마지막 '}'까지를 JSON으로 (코드 블록 · 앞뒤 설명이 섞여도) */
export function extractJson(text: string): unknown {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('JSON 객체가 없음');
  return JSON.parse(text.slice(a, b + 1));
}

// strict 모드용 JSON 스키마: 모든 객체에 additionalProperties=false, 모든 키 required.
// 숫자 범위 · 길이 같은 제약은 모델 쪽 지원이 제각각이라 빼고, 응답은 zod로 다시 검증합니다.
const DROP = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'default', 'description']);
export function strictJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' && v && typeof v === 'object') {
        // 속성 이름은 지우면 안 됨 (예: "description"이라는 필드)
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]));
      } else if (!DROP.has(k)) out[k] = walk(v);
    }
    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}
