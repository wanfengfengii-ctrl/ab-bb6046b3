import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { auditTraces } from './audit.js';
import { ErrorCode, ValidationFailure } from './errors.js';

export interface ServerOptions {
  port: number;
  host: string;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.post('/api/traces/audit', async (request, reply) => {
    try {
      const result = auditTraces(request.body);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ValidationFailure) {
        return reply.code(422).send({
          error: err.auditError.code,
          message: err.auditError.message,
          ...(err.auditError.details !== undefined
            ? { details: err.auditError.details }
            : {}),
        });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  // Map malformed/non-JSON request bodies to the stable 422 contract instead
  // of Fastify's default 400/415 responses.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 400 || error.statusCode === 415) {
      return reply.code(422).send({
        error: ErrorCode.INVALID_BODY,
        message: 'Request body must be a valid JSON object.',
      });
    }
    request.log.error(error);
    return reply.code(error.statusCode ?? 500).send({ error: 'internal_error' });
  });
  return app;
}

export async function startServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ port: options.port, host: options.host });
  return app;
}
