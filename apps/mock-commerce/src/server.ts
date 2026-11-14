import { buildMockCommerceApp } from './app.js';

const port = Number(process.env.MOCK_COMMERCE_PORT ?? 8100);
const app = buildMockCommerceApp({ logger: true });

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
