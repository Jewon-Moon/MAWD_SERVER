// 매장 설정 저장소 (매장별). 설정 API와 AI 파이프라인이 같은 값을 읽습니다.
// AI 파이프라인은 동기로 읽어야 해서 매장별로 메모리에 두고, 로그인 · 웹훅 · 대화 시작 때 DB(tenants.settings)에서 한 번 읽어 채움.
// 바뀌면 saveConfig로 DB에 저장 → 재배포 · 재시작해도 유지
// shortcut: 프로세스 메모리 캐시 (서버 1대 기준). 여러 대면 저장 시 다른 서버 캐시 무효화(Redis pub/sub)
import { eq } from 'drizzle-orm';
import type { AllSettings } from '@mawd/contracts';
import { contextMarkdown, type Kind } from './context/docs.js';
import type { createDb } from './db/client.js';
import * as s from './db/schema.js';
import * as M from './mocks/data.js';

type Db = ReturnType<typeof createDb>;
type Config = {
  settings: AllSettings;
  categories: typeof M.defaultCategories;
  rules: typeof M.defaultRules;
  templates: typeof M.defaultTemplates;
  faqs: typeof M.defaultFaqs;
  setup: { done: boolean; template: string | null }; // 초기 세팅(업종 템플릿) 완료 여부
};
const fresh = (): Config => ({
  settings: structuredClone(M.defaultSettings), categories: structuredClone(M.defaultCategories), rules: structuredClone(M.defaultRules),
  templates: structuredClone(M.defaultTemplates), faqs: structuredClone(M.defaultFaqs), setup: { done: false, template: null },
});

const configs = new Map<string, Config>();
const names = new Map<string, string>();
const loaded = new Set<string>();

/** 매장 설정 (없으면 기본값으로 만들어 둠). 바꾼 뒤에는 saveConfig */
export function configOf(tenantId: string): Config {
  let c = configs.get(tenantId);
  if (!c) { c = fresh(); configs.set(tenantId, c); }
  return c;
}

/** 데모 매장 설정 (테스트 · 데모 데이터에서 직접 바꿀 때) */
export const store = configOf(M.TENANT_ID);

export type TenantConfig = Omit<Config, 'setup'> & {
  storeName: string;
  context: Record<Kind, string>; // 매장 문서 MD (매장 소개 · 상품 · 정책), context/docs.ts 캐시
};

export function getTenantConfig(tenantId: string): TenantConfig {
  const { setup: _, ...c } = configOf(tenantId);
  return { storeName: names.get(tenantId) ?? M.me.tenant.name, ...c, context: contextMarkdown(tenantId) };
}

/** DB에서 매장 설정을 한 번 읽어 채움 (이미 읽었으면 그대로). 저장된 값에 없는 새 설정 항목은 기본값 */
export async function loadConfig(db: Db, tenantId: string): Promise<void> {
  if (loaded.has(tenantId)) return;
  const [row] = await db.withTenant(tenantId, (tx) => tx.select({ name: s.tenants.name, settings: s.tenants.settings }).from(s.tenants).where(eq(s.tenants.id, tenantId)), { readOnly: true });
  loaded.add(tenantId);
  if (!row) return;
  names.set(tenantId, row.name);
  const saved = (row.settings ?? {}) as Partial<Config>;
  const c = configOf(tenantId);
  if (saved.settings) {
    const merged = { ...c.settings } as Record<string, unknown>;
    for (const [k, v] of Object.entries(saved.settings)) merged[k] = { ...(c.settings as Record<string, object>)[k], ...(v as object) };
    c.settings = merged as AllSettings;
  }
  for (const k of ['categories', 'rules', 'templates', 'faqs'] as const) if (Array.isArray(saved[k])) (c as Record<string, unknown>)[k] = saved[k];
  if (saved.setup) c.setup = saved.setup;
}

/** 매장 설정을 DB에 저장 (설정 API · 온보딩에서 바꾼 뒤) */
export async function saveConfig(db: Db, tenantId: string): Promise<void> {
  const c = configOf(tenantId);
  await db.withTenant(tenantId, (tx) => tx.update(s.tenants).set({ settings: c }).where(eq(s.tenants.id, tenantId)));
}

export function setStoreName(tenantId: string, name: string) { names.set(tenantId, name); }
