import { buildApp } from './app.js';

const app = await buildApp({ logger: true });
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));
await app.listen({ port: Number(process.env.PORT ?? 8000), host: '0.0.0.0' });
