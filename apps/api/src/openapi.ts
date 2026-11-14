// 프론트 공유용 openapi.json을 파일로 뽑습니다: pnpm --filter @mawd/api openapi
import { writeFileSync } from 'node:fs';
import { buildApp } from './app.js';

const app = await buildApp();
await app.ready();
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(app.swagger(), null, 2));
await app.close();
console.log('wrote apps/api/openapi.json');
