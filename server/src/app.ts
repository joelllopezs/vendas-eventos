import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, isProd, isTest } from './config.js';
import type { Pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { expireDueCarts } from './services/cart.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { pdvRoutes } from './routes/pdv.js';
import { platformRoutes } from './routes/platform.js';

export async function buildApp(pool: Pool) {
  const app = Fastify({
    logger: isTest ? false : { level: isProd ? 'info' : 'warn', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: process.env.TRUST_PROXY === 'true' || !!process.env.VERCEL,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': config.cookieSecure === true ? [] : null, 'img-src': ["'self'", 'data:'], 'style-src': ["'self'", "'unsafe-inline'"] } } });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // CSRF: SameSite=Lax + checagem de Origin em métodos que alteram estado
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return; // clientes não-navegador (testes/scripts) não enviam Origin
    const host = req.host; // respeita X-Forwarded-Host quando há proxy confiável (Vercel, Nginx...)
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.host === host || o.host === req.headers.host || config.allowedOrigins.includes(origin);
    } catch {
      ok = false;
    }
    if (!ok) throw new AppError(403, 'BAD_ORIGIN', 'Origem não permitida.');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um instante.' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: 'Requisição inválida.' } });
    }
    // violação de CHECK/FK do banco: última barreira — não vaza detalhes
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23514' || pgCode === '23503') {
      req.log.error({ err }, 'violação de restrição');
      return reply.code(409).send({ error: { code: 'CONSTRAINT', message: 'A operação violaria uma regra de integridade e foi recusada.' } });
    }
    req.log.error({ err }, 'erro interno');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Erro interno. Tente novamente.' } });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Opcional (Vercel Cron, plano Pro): limpeza periódica. Protegido por CRON_SECRET; sem ele a rota não existe.
  app.get('/api/internal/expire-carts', async (req) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new AppError(404, 'NOT_FOUND', 'Rota não encontrada.');
    return { expired: await expireDueCarts(pool) };
  });

  await app.register(
    async (api) => {
      api.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });
      await authRoutes(api, pool);
      await platformRoutes(api, pool);
      await adminRoutes(api, pool);
      await pdvRoutes(api, pool);
    },
    { prefix: '/api' },
  );

  // frontend (build do Vite) servido pelo próprio backend em produção
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = config.webDistDir || path.resolve(here, '../../web/dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));
  }
  return app;
}
