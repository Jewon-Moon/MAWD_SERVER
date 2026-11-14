// 외부 커머스 연동 · 통합 주문 조회 API (F13)
import { tenantOf } from '../auth.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as C from '@mawd/contracts';
import type { CommerceService } from '../commerce/service.js';

const sourceParam = z.object({ source: C.CommerceSource });

export function commerceRoutes(deps: { commerce: CommerceService }): FastifyPluginAsyncZod {

  return async (app) => {
    app.get('/commerce/platforms', {
      schema: { tags: ['commerce'], response: { 200: z.array(C.PlatformInfo) }, description: '연동 가능한 커머스 · 배달 플랫폼 목록과 필요 인증 필드' },
    }, async () => deps.commerce.listPlatforms());

    app.get('/commerce/connections', {
      schema: { tags: ['commerce'], response: { 200: z.array(C.CommerceConnection) }, description: '현재 매장의 플랫폼별 연동 상태와 수집된 주문 수' },
    }, async (req) => deps.commerce.listConnections(tenantOf(req)));

    app.put('/commerce/connections/:source', {
      schema: { tags: ['commerce'], params: sourceParam, body: C.ConnectionUpsert, response: { 200: C.CommerceConnection }, description: '플랫폼 연동 설정(API 키 암호화 저장 + 연결 테스트 + 즉시 1차 동기화, 또는 데모 모드 켜기)' },
    }, async (req) => deps.commerce.upsertConnection(tenantOf(req), req.params.source, req.body));

    app.delete('/commerce/connections/:source', {
      schema: { tags: ['commerce'], params: sourceParam, response: { 200: z.object({ ok: z.literal(true) }) }, description: '플랫폼 연동 해제 (저장된 API 키 삭제, 기존 주문 이력은 유지)' },
    }, async (req) => {
      await deps.commerce.deleteConnection(tenantOf(req), req.params.source);
      return { ok: true as const };
    });

    app.post('/commerce/connections/:source/sync', {
      schema: { tags: ['commerce'], params: sourceParam, response: { 200: C.SyncResult }, description: '지금 즉시 해당 플랫폼에서 변경된 주문을 가져와 AI가 바로 조회할 수 있게 반영' },
    }, async (req) => deps.commerce.syncOne(tenantOf(req), req.params.source));

    app.post('/orders/import', {
      schema: { tags: ['knowledge'], body: C.OrderImportBody, response: { 200: C.OrderImportResult }, description: '판매처별 주문 CSV 업로드 (dry_run=true면 미리보기만, false면 저장)' },
    }, async (req) => deps.commerce.importOrders(tenantOf(req), req.body));

    app.get('/orders', {
      schema: { tags: ['knowledge'], querystring: C.OrderListQuery, response: { 200: C.Page(C.Order) }, description: '연동 · 업로드된 전체 판매처의 통합 주문 목록' },
    }, async (req) => deps.commerce.listOrders(tenantOf(req), req.query));
  };
}
