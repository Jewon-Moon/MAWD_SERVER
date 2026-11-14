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
  // 운영: 0001이 만든 개발용 비밀번호(app_user_dev)를 APP_DB_PASSWORD로 교체 (실행할 때마다 맞춤)
  const pw = process.env.APP_DB_PASSWORD?.trim();
  if (pw) {
    // DATABASE_URL에 그대로 들어가고 SQL에도 직접 넣으므로 URL · SQL에 안전한 글자만 허용
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(pw)) throw new Error('APP_DB_PASSWORD는 영문 · 숫자 · _ · - 16자 이상이어야 합니다 (예: openssl rand -hex 24)');
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try { await sql.unsafe(`ALTER ROLE app_user PASSWORD '${pw}'`); console.log('app_user password set'); }
    finally { await sql.end(); }
  }
}
