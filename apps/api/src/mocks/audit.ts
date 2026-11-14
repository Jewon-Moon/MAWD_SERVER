// 목 감사 로그 (메모리). 실제 구현은 actions 테이블.
import { randomUUID } from 'node:crypto';

export type AuditRow = { id: string; actor: 'ai' | 'owner' | 'system'; type: string; payload: Record<string, unknown>; created_at: string; inquiry_id?: string };

export const auditLog: AuditRow[] = [
  { id: randomUUID(), actor: 'ai', type: 'read_lookup', inquiry_id: 'aaaaaaaa-0000-4000-8000-000000000001', payload: { tool: 'lookup_order', verified: true, rows: 1 }, created_at: new Date().toISOString() },
];

export function audit(actor: AuditRow['actor'], type: string, payload: Record<string, unknown>, inquiry_id?: string) {
  auditLog.unshift({ id: randomUUID(), actor, type, payload, created_at: new Date().toISOString(), inquiry_id });
}
