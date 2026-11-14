// DB 접근은 이 파일을 통해서만 (§5.1 I2). 앱은 app_user(RLS 적용 역할)로만 접속합니다.
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Tx = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0];

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error('DATABASE_URL is required');
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });

  /** 매장 컨텍스트 안에서만 쿼리합니다. SET LOCAL은 트랜잭션이 끝나면 사라져 풀의 다른 요청으로 새지 않습니다. */
  async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
        return fn(tx);
      },
      opts.readOnly ? { accessMode: 'read only' } : undefined, // F12 조회 도구용 (S1)
    );
  }

  /** 매장을 정하기 전 조회 (§5.1 I4). SECURITY DEFINER 함수만 호출합니다. */
  async function tenantForUser(userId: string): Promise<string | null> {
    const [row] = await client<{ t: string | null }[]>`SELECT tenant_for_user(${userId}) AS t`;
    return row?.t ?? null;
  }
  async function tenantForWebhook(token: string): Promise<string | null> {
    const [row] = await client<{ t: string | null }[]>`SELECT tenant_for_webhook(${token}) AS t`;
    return row?.t ?? null;
  }

  return { withTenant, tenantForUser, tenantForWebhook, close: () => client.end() };
}
