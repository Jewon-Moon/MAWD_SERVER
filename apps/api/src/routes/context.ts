// 매장 문서(MD) API. 프론트: 템플릿 편집기(GET …/template의 fields_schema로 폼 → PUT {mode:'template', fields})
// 또는 직접 작성(PUT {mode:'custom', markdown}). 저장하면 다음 메시지부터 AI 프롬프트에 반영
import { tenantOf } from '../auth.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import { templateMd, TITLES, type ContextStore, type Kind } from '../context/docs.js';

const kindParam = z.object({ kind: C.ContextKind });

export function contextRoutes(deps: { context: ContextStore }): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/context-docs', { schema: { tags: ['context'], response: { 200: z.array(C.ContextDoc) }, description: '매장 문서 3종 (매장 소개 · 상품 · 서비스 · 운영 정책). 저장 안 한 문서는 기본값(is_default)' } },
      async (req) => Object.values(await deps.context.load(tenantOf(req))));

    app.get('/context-docs/:kind', { schema: { tags: ['context'], params: kindParam, response: { 200: C.ContextDoc } } },
      async (req) => (await deps.context.load(tenantOf(req)))[req.params.kind as Kind]);

    app.get('/context-docs/:kind/template', {
      schema: { tags: ['context'], params: kindParam, response: { 200: z.object({ kind: C.ContextKind, title: z.string(), template_md: z.string(), fields_schema: z.record(z.string(), z.unknown()) }) }, description: '템플릿 편집기용: MD 템플릿 원본 + 입력 필드 JSON 스키마 (폼 자동 생성)' },
    }, async (req) => {
      const kind = req.params.kind as Kind;
      return { kind, title: TITLES[kind], template_md: templateMd(kind), fields_schema: z.toJSONSchema(C.ContextDocFields[kind]) as Record<string, unknown> };
    });

    app.post('/context-docs/:kind/preview', {
      schema: { tags: ['context'], params: kindParam, body: C.ContextDocPut, response: { 200: z.object({ markdown: z.string() }) }, description: '저장하지 않고 AI에 들어갈 MD 미리보기' },
    }, async (req) => ({ markdown: deps.context.preview(req.params.kind as Kind, req.body) }));

    app.put('/context-docs/:kind', {
      schema: { tags: ['context'], params: kindParam, body: C.ContextDocPut, response: { 200: C.ContextDoc }, description: '저장. 템플릿 모드는 필드를 검증해 MD 생성(안 맞으면 422), 직접 작성은 MD 그대로 (문서당 8000자)' },
    }, async (req) => deps.context.put(tenantOf(req), req.params.kind as Kind, req.body));

    app.delete('/context-docs/:kind', { schema: { tags: ['context'], params: kindParam, response: { 200: C.ContextDoc }, description: '기본 템플릿으로 되돌리기' } },
      async (req) => deps.context.reset(tenantOf(req), req.params.kind as Kind));
  };
}
