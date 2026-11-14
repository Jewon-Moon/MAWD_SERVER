// §14.1 공통 에러 형식: { error: { code, message } }
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export const notFound = (code: string): never => {
  throw new ApiError(404, code, '대상을 찾을 수 없습니다.');
};

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(422).send({ error: { code: 'validation_error', message: err.message } });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      error: { code: status >= 500 ? 'internal_error' : (err.code ?? 'bad_request'), message: status >= 500 ? '서버 오류가 발생했습니다.' : err.message },
    });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: '경로를 찾을 수 없습니다.' } }));
}
