import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clearSessionCookie, createSession, platformGuard, plat, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { isUniqueViolation, withTx, type Pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/security.js';
import { optText, parse, password, trimmed, uuid } from '../lib/validate.js';

const companyBody = z.object({
  tradeName: trimmed(2, 120),
  legalName: optText(160),
  cnpj: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v.replace(/\D/g, '') : null))
    .refine((v) => v === null || v.length === 14, 'CNPJ deve ter 14 dígitos.'),
  contactEmail: z.email('E-mail inválido.').max(160),
  phone: trimmed(8, 30),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Identificador: 3 a 40 caracteres (a-z, 0-9, hífen).'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  admin: z.object({
    name: trimmed(2, 120),
    login: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._@+-]{3,60}$/, 'Login: 3 a 60 caracteres (a-z, 0-9 . _ @ + -).'),
    email: z.email().max(160).nullish(),
    password,
  }),
});

const SELECT_COMPANY = `SELECT c.id, c.slug, c.trade_name AS "tradeName", c.legal_name AS "legalName", c.cnpj,
  c.contact_email AS "contactEmail", c.phone, c.status, c.created_at AS "createdAt",
  (SELECT count(*) FROM users u WHERE u.company_id = c.id)::int AS "usersCount",
  (SELECT count(*) FROM events e WHERE e.company_id = c.id)::int AS "eventsCount"
  FROM companies c`;

export async function platformRoutes(app: FastifyInstance, pool: Pool) {
  app.post(
    '/platform/login',
    { config: { rateLimit: { max: config.rateLimitLoginMax, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const b = parse(z.object({ email: z.string().trim().toLowerCase().min(3), password: z.string().min(1) }), req.body);
      const r = await pool.query(
        `SELECT id, password_hash, active, locked_until FROM platform_admins WHERE lower(email) = $1`,
        [b.email],
      );
      const a = r.rows[0];
      const bad = new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');
      if (!a) {
        await dummyVerify(b.password);
        throw bad;
      }
      if (a.locked_until && a.locked_until > new Date()) {
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Muitas tentativas. Aguarde alguns minutos.');
      }
      if (!(await verifyPassword(a.password_hash, b.password)) || !a.active) {
        await pool.query(
          `UPDATE platform_admins SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
           WHERE id = $1`,
          [a.id, config.maxFailedLogins, config.lockMinutes],
        );
        throw bad;
      }
      await pool.query(`UPDATE platform_admins SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [a.id]);
      setSessionCookie(reply, req, await createSession(pool, { kind: 'PLATFORM', adminId: a.id }, req));
      await audit(pool, { companyId: null, actorType: 'PLATFORM_ADMIN', actorId: a.id, action: 'platform.login', ip: req.ip });
      return { ok: true };
    },
  );

  app.register(async (s) => {
    s.addHook('onRequest', platformGuard(pool));

    s.get('/platform/me', async (req) => ({ admin: { name: plat(req).name } }));

    s.post('/platform/logout', async (req, reply) => {
      await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [plat(req).sessionId]);
      clearSessionCookie(reply, req);
      return { ok: true };
    });

    s.get('/platform/companies', async () => {
      const r = await pool.query(`${SELECT_COMPANY} ORDER BY c.created_at DESC`);
      return { companies: r.rows };
    });

    s.post('/platform/companies', async (req, reply) => {
      const b = parse(companyBody, req.body);
      const adminHash = await hashPassword(b.admin.password);
      try {
        const id = await withTx(pool, async (tx) => {
          const c = await tx.query<{ id: string }>(
            `INSERT INTO companies (slug, trade_name, legal_name, cnpj, contact_email, phone, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [b.slug, b.tradeName, b.legalName, b.cnpj, b.contactEmail, b.phone, b.status],
          );
          const companyId = c.rows[0]!.id;
          await tx.query(
            `INSERT INTO users (company_id, name, login, email, password_hash, role, must_change_password)
             VALUES ($1,$2,$3,$4,$5,'COMPANY_ADMIN', true)`,
            [companyId, b.admin.name, b.admin.login, b.admin.email ?? null, adminHash],
          );
          await audit(tx, {
            companyId,
            actorType: 'PLATFORM_ADMIN',
            actorId: plat(req).adminId,
            action: 'company.create',
            entityType: 'company',
            entityId: companyId,
            metadata: { slug: b.slug },
            ip: req.ip,
          });
          return companyId;
        });
        reply.code(201);
        return (await pool.query(`${SELECT_COMPANY} WHERE c.id = $1`, [id])).rows[0];
      } catch (err) {
        if (isUniqueViolation(err, 'companies_slug_key')) throw conflict('SLUG_TAKEN', 'Este identificador já está em uso.');
        if (isUniqueViolation(err, 'companies_cnpj_uq')) throw conflict('CNPJ_TAKEN', 'Este CNPJ já está cadastrado.');
        throw err;
      }
    });

    s.patch('/platform/companies/:id', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(
        z.object({
          tradeName: trimmed(2, 120).optional(),
          legalName: optText(160).optional(),
          contactEmail: z.email().max(160).optional(),
          phone: trimmed(8, 30).optional(),
          status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        }),
        req.body,
      );
      const r = await withTx(pool, async (tx) => {
        const u = await tx.query(
          `UPDATE companies SET trade_name = COALESCE($2, trade_name), legal_name = CASE WHEN $3::boolean THEN $4 ELSE legal_name END,
                  contact_email = COALESCE($5, contact_email), phone = COALESCE($6, phone),
                  status = COALESCE($7, status), updated_at = now()
            WHERE id = $1 RETURNING id`,
          [id, b.tradeName ?? null, b.legalName !== undefined, b.legalName ?? null, b.contactEmail ?? null, b.phone ?? null, b.status ?? null],
        );
        if (!u.rowCount) throw notFound('Empresa');
        if (b.status === 'INACTIVE') {
          await tx.query(
            `UPDATE sessions SET revoked_at = now() WHERE company_id = $1 AND revoked_at IS NULL`,
            [id],
          );
        }
        await audit(tx, { companyId: id, actorType: 'PLATFORM_ADMIN', actorId: plat(req).adminId, action: 'company.update', entityType: 'company', entityId: id, metadata: b as Record<string, unknown> });
        return true;
      });
      void r;
      return (await pool.query(`${SELECT_COMPANY} WHERE c.id = $1`, [id])).rows[0];
    });
  });
}
