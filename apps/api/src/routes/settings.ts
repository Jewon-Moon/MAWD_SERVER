// 매장별 세부 설정 API (목). 서버가 떠 있는 동안은 메모리에 저장돼서 PATCH 결과가 유지됩니다.
// shortcut: 메모리 저장 + 단일 데모 매장, 실제 구현 때 tenants.settings(jsonb) + 목록형 테이블(RLS)로 교체
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import * as M from '../mocks/data.js';
import { ApiError, notFound } from '../errors.js';
import { audit } from '../mocks/audit.js';
import { store } from '../tenantConfig.js';

const idParam = z.object({ id: z.string().uuid() });
const ok = z.object({ ok: z.literal(true) });

/** 목록형 리소스 CRUD를 한 번에 등록 */
function crud<T extends { id: string }>(
  app: Parameters<FastifyPluginAsyncZod>[0],
  path: string, tag: string, list: () => T[],
  item: z.ZodTypeAny, input: z.ZodObject<z.ZodRawShape>, // ZodTypeAny: 제네릭 헬퍼라 응답 타입 추론은 포기, 검증은 런타임 스키마가 함
) {
  app.get(path, { schema: { tags: [tag], response: { 200: z.array(item) } } }, async () => list());
  app.post(path, { schema: { tags: [tag], body: input, response: { 201: item } } }, async (req, reply) => {
    const row = { ...(req.body as object), id: randomUUID() } as T;
    list().push(row);
    audit('owner', 'settings_change', { resource: path, op: 'create', id: row.id });
    return reply.status(201).send(row);
  });
  app.patch(`${path}/:id`, { schema: { tags: [tag], params: idParam, body: input.partial(), response: { 200: item } } }, async (req) => {
    const rows = list();
    const i = rows.findIndex((r) => r.id === req.params.id);
    if (i < 0) notFound(`${tag}_not_found`);
    rows[i] = { ...rows[i]!, ...(req.body as object) };
    audit('owner', 'settings_change', { resource: path, op: 'update', id: req.params.id, fields: Object.keys(req.body as object) });
    return rows[i]!;
  });
  app.delete(`${path}/:id`, { schema: { tags: [tag], params: idParam, response: { 200: ok } } }, async (req) => {
    const rows = list();
    const i = rows.findIndex((r) => r.id === req.params.id);
    if (i < 0) notFound(`${tag}_not_found`);
    rows.splice(i, 1);
    audit('owner', 'settings_change', { resource: path, op: 'delete', id: req.params.id });
    return { ok: true as const };
  });
}

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  // --- 섹션형 설정 ---
  app.get('/settings', { schema: { tags: ['settings'], description: '모든 설정 섹션을 한 번에', response: { 200: C.AllSettings } } },
    async () => store.settings);

  for (const [section, schema] of Object.entries(C.SettingsSections) as [C.SettingsSection, z.ZodObject<z.ZodRawShape>][]) {
    app.get(`/settings/${section}`, { schema: { tags: ['settings'], response: { 200: schema } } }, async () => store.settings[section]);
    app.patch(`/settings/${section}`, {
      schema: {
        tags: ['settings'], body: schema.partial(), response: { 200: schema },
        description: '부분 수정. 최상위 필드 단위로 덮어씁니다(중첩 객체는 통째로 교체). 합친 결과가 스키마에 맞지 않으면 422',
      },
    }, async (req) => {
      const merged = schema.safeParse({ ...store.settings[section], ...(req.body as object) });
      if (!merged.success) throw new ApiError(422, 'validation_error', merged.error.message);
      (store.settings as Record<string, unknown>)[section] = merged.data;
      audit('owner', 'settings_change', { section, fields: Object.keys(req.body as object) });
      return merged.data;
    });
  }
  app.post('/settings/reset', {
    schema: { tags: ['settings'], body: z.object({ sections: z.array(z.enum(Object.keys(C.SettingsSections) as [C.SettingsSection, ...C.SettingsSection[]])).min(1) }), response: { 200: C.AllSettings } },
  }, async (req) => {
    for (const s of req.body.sections) (store.settings as Record<string, unknown>)[s] = structuredClone(M.defaultSettings[s]);
    audit('owner', 'settings_change', { op: 'reset', sections: req.body.sections });
    return store.settings;
  });

  // --- 목록형 설정 ---
  crud(app, '/categories', 'categories', () => store.categories, C.Category, C.CategoryInput);
  crud(app, '/escalation-rules', 'escalation-rules', () => store.rules, C.EscalationRule, C.EscalationRuleInput);
  crud(app, '/faqs', 'faqs', () => store.faqs, C.Faq, C.FaqInput);

  app.get('/templates', { schema: { tags: ['templates'], response: { 200: z.array(C.Template) } } }, async () => store.templates);
  app.put('/templates/:kind', { schema: { tags: ['templates'], params: z.object({ kind: C.TemplateKind }), body: C.TemplateInput, response: { 200: C.Template } } },
    async (req) => {
      const row = { kind: req.params.kind, ...req.body };
      const i = store.templates.findIndex((t) => t.kind === row.kind);
      if (i < 0) store.templates.push(row); else store.templates[i] = row;
      audit('owner', 'settings_change', { resource: '/templates', kind: row.kind });
      return row;
    });

  // --- 튜닝 도구 ---
  app.post('/playground/simulate', {
    schema: { tags: ['playground'], body: C.SimulateBody, response: { 200: C.SimulateResult }, description: '저장 · 전송 · 감사 로그 없이 현재(또는 override) 설정으로 판단 결과를 미리 봅니다' },
  }, async (req) => {
    // shortcut: 목은 키워드 휴리스틱으로 흉내, 실제 구현 때 F3~F5 파이프라인을 dry-run으로 호출
    const cfg = { ...store.settings, ...req.body.settings_override } as C.AllSettings;
    const text = req.body.messages.filter((m) => m.sender === 'customer').map((m) => m.text).join(' ');
    const heat = /씨|개같|미친|!!|당장/.test(text) ? 88 : /환불|화나|짜증/.test(text) ? 55 : 15;
    const category = store.categories.find((c) => c.enabled && c.description.split(/[ ,]+/).some((w) => w && text.includes(w)))?.name ?? '기타';
    const matched = store.rules
      .filter((r) => r.enabled && (!r.match.channels || r.match.channels.includes(req.body.channel)))
      .filter((r) => (!r.match.keywords || r.match.keywords.some((k) => text.includes(k))) && (r.match.heat_gte === undefined || heat >= r.match.heat_gte) && (!r.match.regex || new RegExp(r.match.regex).test(text)))
      .sort((a, b) => a.priority - b.priority);
    const routing = store.categories.find((c) => c.name === category)?.routing ?? 'intake_only';
    const route: 'A' | 'B' | 'C' = matched.some((r) => r.action !== 'approve') || routing === 'intake_only' ? 'C' : heat >= cfg.response.heat_threshold || routing === 'approve' ? 'B' : 'A';
    const label = heat >= cfg.response.heat_labels.very_high ? '매우 높음' : heat >= cfg.response.heat_labels.high ? '높음' : '보통';
    const tpl = (k: string) => store.templates.find((t) => t.kind === k)?.text.replace('{sla}', `${cfg.response.owner_reply_sla_minutes}분`) ?? null;
    return {
      analysis: { category, heat, heat_label: label, needs_owner: route !== 'A', confidence: 0.8, abuse_spans: [] },
      route,
      matched_rules: matched.map((r) => ({ id: r.id, name: r.name, action: r.action })),
      reply_preview: !cfg.response.ai_enabled ? null : route === 'A' ? '(정책 근거 답변 미리보기)' : tpl(route === 'B' ? 'calm' : 'intake'),
      card_preview: route === 'A' ? null : { title: text.slice(0, 30), heat_label: label, risk_flags: matched.map((r) => r.risk_flag).filter(Boolean) },
      would_notify: route !== 'A' && heat >= cfg.notifications.min_heat_to_notify,
      reasons: [
        `카테고리 '${category}' (라우팅: ${routing})`,
        `감정 점수 ${heat} / 격앙 기준 ${cfg.response.heat_threshold}`,
        ...matched.map((r) => `규칙 '${r.name}' 매칭 → ${r.action}`),
      ],
    };
  });

  app.get('/usage', { schema: { tags: ['usage'], querystring: C.UsageQuery, response: { 200: C.Usage } } }, async (req) => ({
    inquiries: 312, auto_handled: 198, shielded_heated: 41, calls: 57, call_minutes: 143.5, ai_cost_usd: 18.42,
    by_day: [{ date: req.query.from, inquiries: 12, ai_cost_usd: 0.71 }],
  }));
};
