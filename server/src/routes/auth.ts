import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, co, companyGuard, createSession, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest } from '../lib/errors.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/security.js';
import { parse, password } from '../lib/validate.js';

const loginBody = z.object({
  company: z.string().trim().toLowerCase().min(1).max(60),
  login: z.string().trim().toLowerCase().min(1).max(120),
  password: z.string().min(1).max(200),
});

const BAD = () => new AppError(401, 'INVALID_CREDENTIALS', 'Empresa, usuário ou senha incorretos.');

export async function authRoutes(app: FastifyInstance, pool: Pool) {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: config.rateLimitLoginMax, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const b = parse(loginBody, req.body);
      const c = await pool.query<{ id: string }>(
        `SELECT id FROM companies WHERE slug = $1 AND status = 'ACTIVE'`,
        [b.company],
      );
      const companyId = c.rows[0]?.id;
      const u = companyId
        ? await pool.query<{
            id: string;
            password_hash: string;
            active: boolean;
            failed_logins: number;
            locked_until: Date | null;
          }>(
            `SELECT id, password_hash, active, failed_logins, locked_until FROM users
              WHERE company_id = $1 AND (login = $2 OR lower(email) = $2)`,
            [companyId, b.login],
          )
        : { rows: [] };
      const user = u.rows[0];
      if (!user || !companyId) {
        await dummyVerify(b.password);
        throw BAD();
      }
      if (user.locked_until && user.locked_until > new Date()) {
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
      }
      const ok = await verifyPassword(user.password_hash, b.password);
      if (!ok || !user.active) {
        if (!ok) {
          await pool.query(
            `UPDATE users SET failed_logins = failed_logins + 1,
                    locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE id = $1`,
            [user.id, config.maxFailedLogins, config.lockMinutes],
          );
        }
        throw BAD();
      }
      await pool.query(
        `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
        [user.id],
      );
      const token = await createSession(pool, { kind: 'COMPANY', userId: user.id, companyId }, req);
      await audit(pool, {
        companyId,
        actorType: 'USER',
        actorId: user.id,
        action: 'auth.login',
        ip: req.ip,
      });
      setSessionCookie(reply, req, token);
      return { ok: true };
    },
  );

  app.register(async (s) => {
    s.addHook('onRequest', companyGuard(pool));

    s.get('/auth/me', { config: { allowMustChange: true } }, async (req) => {
      const a = co(req);
      return {
        user: { id: a.userId, name: a.userName, login: a.login, role: a.role },
        company: { id: a.companyId, slug: a.companySlug, name: a.companyName },
        mustChangePassword: a.mustChangePassword,
        cancelPolicy: a.cancelPolicy,
        cartTtlSeconds: a.cartTtlSeconds,
      };
    });

    s.post('/auth/logout', { config: { allowMustChange: true } }, async (req, reply) => {
      await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [co(req).sessionId]);
      clearSessionCookie(reply, req);
      return { ok: true };
    });

    s.post('/auth/change-password', { config: { allowMustChange: true } }, async (req) => {
      const a = co(req);
      const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
      const r = await pool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1 AND company_id = $2`,
        [a.userId, a.companyId],
      );
      if (!(await verifyPassword(r.rows[0]!.password_hash, b.currentPassword))) {
        throw badRequest('WRONG_PASSWORD', 'A senha atual está incorreta.');
      }
      if (b.currentPassword === b.newPassword) {
        throw badRequest('SAME_PASSWORD', 'A nova senha deve ser diferente da atual.');
      }
      await pool.query(
        `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
        [await hashPassword(b.newPassword), a.userId],
      );
      // revoga as demais sessões do usuário
      await pool.query(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [a.userId, a.sessionId],
      );
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'auth.change_password', ip: req.ip });
      return { ok: true };
    });
  });
}
