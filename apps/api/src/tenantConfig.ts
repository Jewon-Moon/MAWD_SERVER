// 매장 설정 저장소. 설정 API와 AI 파이프라인이 같은 값을 읽습니다.
// shortcut: 메모리 + 단일 데모 매장. 실제 구현 때 tenants.settings(jsonb) + 목록형 테이블(RLS)로 교체하고 tenantId로 조회
import type { AllSettings } from '@mawd/contracts';
import { contextMarkdown, type Kind } from './context/docs.js';
import * as M from './mocks/data.js';

export const store = {
  settings: structuredClone(M.defaultSettings),
  categories: structuredClone(M.defaultCategories),
  rules: structuredClone(M.defaultRules),
  templates: structuredClone(M.defaultTemplates),
  faqs: structuredClone(M.defaultFaqs),
};

export type TenantConfig = {
  storeName: string;
  settings: AllSettings;
  categories: typeof store.categories;
  rules: typeof store.rules;
  templates: typeof store.templates;
  faqs: typeof store.faqs;
  context: Record<Kind, string>; // 매장 문서 MD (매장 소개 · 상품 · 정책), context/docs.ts 캐시
};

export function getTenantConfig(_tenantId: string): TenantConfig {
  return { storeName: M.me.tenant.name, ...store, context: contextMarkdown(_tenantId) };
}
