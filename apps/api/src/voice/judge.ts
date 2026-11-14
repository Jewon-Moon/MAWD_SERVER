// 고객 발화 판단 (F3): 감정 점수 · 사장님 판단 필요 · 법적 조치 언급 · 문의 분류.
// 매장 설정 ai.judge = bivia면 Bivia(결정 모델), 아니면 LLM. Bivia가 실패하면 LLM으로 대신. 결과는 다음 턴 상태 결정 · 알림 우선순위에 반영
import { z } from 'zod';
import type { Bivia } from '../integrations/bivia.js';
import { strictJsonSchema, type Llm } from '../integrations/llm.js';
import type { TenantConfig } from '../tenantConfig.js';
import type { CallSession } from './policy.js';

export type Judgement = {
  heat: number | null;          // null = 판단 보류 (이전 값 유지)
  needsOwner: boolean;
  riskFlags: string[];
  category: string | null;
  abusive: boolean;             // 이번 고객 발화에 욕설 · 비하 표현이 있는가 (키워드 목록에 없는 변형 포함)
  uncertain: boolean;           // 확신이 낮아 사장님에게 넘김 (F3 "확신이 낮으면 답하지 않는다")
  by: 'bivia' | 'llm';
};

const LEGAL_FLAG = '법적 조치 언급';
const transcript = (s: CallSession, text: string) =>
  [...s.history.slice(-4), { role: 'user' as const, content: text }].map((m) => `${m.role === 'user' ? '고객' : 'AI'}: ${m.content}`).join('\n');

export async function judgeWithBivia(s: CallSession, text: string, cfg: TenantConfig, bivia: Bivia): Promise<Judgement> {
  const state = transcript(s, text);
  const min = cfg.settings.response.min_confidence;
  const cats = cfg.categories.filter((c) => c.enabled).sort((a, b) => a.sort - b.sort);
  const [heat, owner, legal, cat, abuse] = await Promise.all([
    bivia.score({ question: '고객의 분노 · 공격성 강도는? (0 = 차분함, 100 = 극도로 격앙)', state, range: [0, 100] }),
    bivia.boolean({ question: '금전 보상, 환불 결정, 법적 조치, 정책 예외 요청처럼 사업자(사장님)가 직접 판단해야 하는 요청이 있는가?', state }),
    bivia.boolean({ question: '소송, 고소, 소비자원 · 경찰 신고 같은 법적 조치를 언급했는가?', state }),
    cats.length >= 2 && cats.length <= 26
      ? bivia.choice({ question: `마지막 고객 문의의 주제는? ${cats.map((c) => `${c.name}${c.description ? `(${c.description})` : ''}`).join(', ')}`, state, choices: cats.map((c) => c.name) })
      : Promise.resolve(null),
    // 대화 전체가 아니라 이번 발화에서만 (AI 말이나 이전 발화를 다시 세지 않게)
    bivia.span({ question: '욕설, 비속어, 인신공격, 비하, 조롱, 위협, 반말 폭언 표현', state: text }),
  ]);
  const sure = (r: { status: string; probability: number | null }) => r.status === 'answered' && (r.probability ?? 0) >= min;
  // "사장님 판단 필요" 확률이 1 - min_confidence 이상이면 넘김 (기본 40%). 보류여도 확률이 낮으면 그대로 응대
  // (예: 주문번호만 말한 턴 → 보류, 필요 13% → 넘기지 않음). 위험 표시(→ 긴급)로는 올리지 않음
  const pYes = owner.distribution?.yes ?? (owner.value === 'yes' ? owner.probability ?? 1 : owner.value === 'no' ? 1 - (owner.probability ?? 1) : 0);
  const ownerNeeded = pYes >= 1 - min;
  const uncertain = ownerNeeded && !sure(owner);
  return {
    heat: heat.status === 'answered' && heat.value != null ? Math.max(0, Math.min(100, heat.value)) : null,
    needsOwner: ownerNeeded,
    riskFlags: sure(legal) && legal.value === 'yes' ? [LEGAL_FLAG] : [],
    category: cat && sure(cat) ? cat.value : null,
    abusive: abuse.status === 'answered' && (abuse.value?.length ?? 0) > 0,
    uncertain,
    by: 'bivia',
  };
}

const LlmJudgement = z.object({ heat: z.number(), needs_owner: z.boolean(), abusive: z.boolean(), risk_flags: z.array(z.string()) });
export async function judgeWithLlm(s: CallSession, text: string, llm: Llm, model?: string): Promise<Judgement> {
  const j = await llm.json([
    { role: 'system', content: '고객 발화를 엄격하게 판단합니다. heat: 분노 · 공격성 0~100. needs_owner: 금전 보상 · 환불 결정 · 주문 변경 · 배송 방법/배송지 변경 · 취소/예외 요청 · 법적 조치 · 정책 예외 요청처럼 사업자 판단이 필요하면 true. abusive: 마지막 고객 발화에 욕설 · 비속어 · 인신공격 · 비하 · 조롱 · 위협 · 반말 폭언(변형 · 초성 · 은어 포함)이 있으면 true. risk_flags: 짧은 한국어 위험 표시 (예: "법적 조치 언급"), 없으면 빈 배열.' },
    ...s.history.slice(-4),
    { role: 'user', content: text },
  ], LlmJudgement, { tier: 'fast', model, name: 'judgement', jsonSchema: strictJsonSchema(LlmJudgement) });
  return { heat: Math.max(0, Math.min(100, Math.round(j.heat))), needsOwner: j.needs_owner, riskFlags: j.risk_flags, category: null, abusive: j.abusive, uncertain: false, by: 'llm' };
}

/** 매장 설정대로 판단. Bivia 장애 · 미설정이면 LLM */
export async function judge(s: CallSession, text: string, deps: { cfg: TenantConfig; llm: Llm; bivia?: Bivia }): Promise<Judgement> {
  if (deps.cfg.settings.ai.judge === 'bivia' && deps.bivia?.configured) {
    try { return await judgeWithBivia(s, text, deps.cfg, deps.bivia); } catch { /* 아래 LLM으로 */ }
  }
  return judgeWithLlm(s, text, deps.llm, deps.cfg.settings.ai.model);
}
