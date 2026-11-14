// Bivia (Articul8 결정 모델): 감정 점수 · 사장님 판단 필요 · 법적 조치 언급 · 문의 분류를 정해진 형식으로 판단.
// 확신이 낮으면 추측하지 않고 abstained를 돌려줌 → "확신이 낮으면 답하지 않는다" 원칙(F3)에 그대로 씀.
// https://docs.articul8.ai/bivia/api  (측정 2026-11-14: 한국어 정상, 서버 60ms 안팎 · 왕복 0.5~0.9초)
export type BiviaResult<V> = { status: 'answered' | 'abstained'; value: V | null; probability: number | null; distribution?: Record<string, number> };
type Common = { question: string; state: string; mode?: 'fast' | 'deep'; signal?: AbortSignal };

export type Bivia = ReturnType<typeof createBivia>;

export function createBivia(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch) {
  const key = env.BIVIA_API_KEY?.trim();
  const base = (env.BIVIA_BASE_URL?.trim() || 'https://api.articul8.ai/bivia').replace(/\/$/, '');

  async function call<V>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<BiviaResult<V>> {
    const res = await fetchFn(`${base}/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      // think=false: 추론 없이 가장 빠르게 (fast 모드에서만 의미 있음)
      body: JSON.stringify({ ...body, think: false }), signal: signal ?? AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`bivia ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { status: 'answered' | 'abstained'; value: V | null; probability?: number; distribution?: Record<string, number> };
    // 보류(abstained)여도 distribution은 옴 → 판단에 씀
    return { status: j.status, value: j.status === 'answered' ? j.value : null, probability: j.probability ?? null, distribution: j.distribution };
  }

  return {
    configured: !!key,
    /** range 범위의 기댓값 (감정 점수 0~100 등) */
    score: (o: Common & { range: [number, number] }) => call<number>('score', { question: o.question, state: o.state, range: o.range, mode: o.mode ?? 'fast' }, o.signal),
    boolean: (o: Common) => call<'yes' | 'no'>('boolean', { question: o.question, state: o.state, mode: o.mode ?? 'fast' }, o.signal),
    choice: (o: Common & { choices: string[] }) => call<string>('choice', { question: o.question, state: o.state, choices: o.choices, mode: o.mode ?? 'fast' }, o.signal),
    /** 질문에 해당하는 구간(욕설 등)의 글자 위치. fast 모드만 지원 */
    span: (o: Omit<Common, 'mode'>) => call<{ start: number; end: number; text: string }[]>('span', { question: o.question, state: o.state, mode: 'fast' }, o.signal),
  };
}
