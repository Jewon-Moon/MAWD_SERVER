// 외부 커머스 플랫폼 연동 (F13): 네이버 · 쿠팡 등에서 주문을 가져와 AI 응대의 [주문 데이터]로 씁니다.
import { z } from 'zod';

const isoTime = z.string().datetime();

/** 주문이 들어온 곳. csv = 직접 업로드(판매처 미지정) */
export const CommerceSource = z.enum(['naver', 'coupang', 'musinsa', 'ably', 'baemin', 'coupangeats', 'yogiyo', 'csv']);
export type CommerceSource = z.infer<typeof CommerceSource>;

/** api = 공식 API로 자동 동기화, demo = 데모 데이터(키 없이 시연), file = 판매자센터 엑셀/CSV 업로드 */
export const ConnectionMode = z.enum(['api', 'demo', 'file']);

export const PlatformInfo = z.object({
  source: CommerceSource,
  label: z.string(),
  kind: z.enum(['api', 'partner', 'file']).describe('api=공개 API로 바로 연동, partner=플랫폼 제휴 필요(지금은 파일 업로드), file=업로드 전용'),
  modes: z.array(ConnectionMode),
  credential_fields: z.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean(), required: z.boolean().default(true) })),
  admin_url: z.string().url().nullable().describe('사장님이 실제 처리(환불 · 반품 승인)를 하는 판매자센터'),
  note: z.string(),
});

export const CommerceConnection = z.object({
  source: CommerceSource,
  label: z.string(),
  mode: ConnectionMode,
  status: z.enum(['connected', 'error', 'disabled']),
  last_synced_at: isoTime.nullable(),
  last_error: z.string().nullable(),
  order_count: z.number().int(),
  admin_url: z.string().url().nullable(),
});

export const ConnectionUpsert = z.object({
  mode: ConnectionMode,
  credentials: z.record(z.string(), z.string()).optional().describe('mode=api일 때 플랫폼별 키 (GET /commerce/platforms의 credential_fields). 서버에 암호화 저장, 응답에 다시 나오지 않음'),
});

export const SyncResult = z.object({
  source: CommerceSource,
  ok: z.boolean(),
  fetched: z.number().int(),
  upserted: z.number().int(),
  error: z.string().nullable(),
  synced_at: isoTime,
});

export const OrderListQuery = z.object({
  source: CommerceSource.optional(),
  q: z.string().max(50).optional().describe('주문번호 · 고객명 · 연락처 뒷자리'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const OrderImportBody = z.object({
  source: CommerceSource.default('csv').describe('어느 판매처에서 내려받은 파일인지 (같은 주문번호라도 판매처가 다르면 다른 주문)'),
  csv: z.string().min(1).max(5_000_000).describe('CSV 본문. 첫 줄은 헤더 (주문번호 · 고객명 · 연락처 · 상품 · 결제금액 · 주문일 · 상태 · 송장번호 · 택배사 · 도착예정일 등)'),
  dry_run: z.boolean().default(true).describe('true면 미리보기만, false면 저장'),
});
