// drizzle/*.sql을 순서대로 적용합니다. app_owner(OWNER_DATABASE_URL)로만 실행합니다.
// RLS · 역할 · 함수가 핵심이라 SQL 파일이 원본이고, schema.ts는 쿼리 타입용 거울입니다.
import { readdirSync, readFileSync } from 'node:fs';
import postgres from 'postgres';

export async function migrate(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = new URL('../../drizzle/', import.meta.url);
    const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(new URL(file, dir), 'utf8'));
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      console.log('applied', file);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.OWNER_DATABASE_URL;
  if (!url) throw new Error('OWNER_DATABASE_URL is required');
  await migrate(url);
}
