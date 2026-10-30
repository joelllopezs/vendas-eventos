import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { co, companyGuard } from '../auth.js';
import { isUniqueViolation, withTx, type Pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/security.js';
import { dateStr, optText, parse, password, trimmed, uuid } from '../lib/validate.js';
import { releaseActiveCarts, sweepExpired } from '../services/cart.js';
import { cancelSale, getSaleDetail } from '../services/sales.js';
import { changeStock, reconcileStock } from '../services/stock.js';
import * as reports from '../services/reports.js';

const page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const eventBody = z.object({
  name: trimmed(2, 160),
  type: z.enum(['PARTY', 'SHOW', 'FESTIVAL', 'CORPORATE', 'SPORTS', 'OTHER']),
  city: trimmed(2, 100),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF inválida.'),
  startsOn: dateStr,
  endsOn: dateStr.nullish().transform((v) => v || null),
  description: optText(2000),
  status: z.enum(['PLANNED', 'ACTIVE', 'ENDED']).default('PLANNED'),
});

const productBody = z.object({
  name: trimmed(1, 160),
  internalCode: trimmed(1, 40),
  barcode: z.string().trim().max(60).nullish().transform((v) => v || null),
  category: z.string().trim().max(60).nullish().transform((v) => v || null),
  description: optText(500),
  priceCents: z.number().int().min(1).max(100_000_000),
  costCents: z.number().int().min(0).max(100_000_000).nullish().transform((v) => v ?? null),
  minStock: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
});

const userLogin = z.string().trim().toLowerCase().regex(/^[a-z0-9._@+-]{3,60}$/, 'Login: 3 a 60 caracteres (a-z, 0-9 . _ @ + -).');

const filtersQ = z.object({
  eventId: uuid.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  productId: uuid.optional(),
  operatorId: uuid.optional(),
  method: z.enum(['CASH', 'PIX', 'DEBIT', 'CREDIT']).optional(),
  status: z.enum(['COMPLETED', 'CANCELLED']).optional(),
  q: z.string().trim().max(40).optional(),
});

export async function adminRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (s) => {
    s.addHook('onRequest', companyGuard(pool, ['COMPANY_ADMIN']));

    /** Garante que o evento pertence à empresa autenticada (senão 404). */
    async function ownEvent(companyId: string, eventId: string) {
      const r = await pool.query(`SELECT id, status FROM events WHERE id = $1 AND company_id = $2`, [eventId, companyId]);
      if (!r.rows[0]) throw notFound('Evento');
      return r.rows[0] as { id: string; status: string };
    }

    // ------------------------------------------------------------ configurações
    s.get('/admin/settings', async (req) => {
      const r = await pool.query(
        `SELECT cart_ttl_seconds AS "cartTtlSeconds", cancel_policy AS "cancelPolicy" FROM companies WHERE id = $1`,
        [co(req).companyId],
      );
      return r.rows[0];
    });
    s.patch('/admin/settings', async (req) => {
      const b = parse(
        z.object({
          cartTtlSeconds: z.number().int().min(30).max(3600).optional(),
          cancelPolicy: z.enum(['ADMIN_ONLY', 'SELLER_REQUEST', 'SELLER_OWN']).optional(),
        }),
        req.body,
      );
      const a = co(req);
      const r = await pool.query(
        `UPDATE companies SET cart_ttl_seconds = COALESCE($2, cart_ttl_seconds), cancel_policy = COALESCE($3, cancel_policy), updated_at = now()
          WHERE id = $1 RETURNING cart_ttl_seconds AS "cartTtlSeconds", cancel_policy AS "cancelPolicy"`,
        [a.companyId, b.cartTtlSeconds ?? null, b.cancelPolicy ?? null],
      );
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'settings.update', metadata: b });
      return r.rows[0];
    });

    // ------------------------------------------------------------------ eventos
    const EV = `SELECT id, name, type, city, state, starts_on AS "startsOn", ends_on AS "endsOn", description, status, created_at AS "createdAt" FROM events`;
    s.get('/admin/events', async (req) => ({
      events: (await pool.query(`${EV} WHERE company_id = $1 ORDER BY starts_on DESC, created_at DESC`, [co(req).companyId])).rows,
    }));

    s.post('/admin/events', async (req, reply) => {
      const a = co(req);
      const b = parse(eventBody, req.body);
      try {
        const id = await withTx(pool, async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO events (company_id, name, type, city, state, starts_on, ends_on, description, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [a.companyId, b.name, b.type, b.city, b.state, b.startsOn, b.endsOn, b.description, b.status],
          );
          await audit(tx, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'event.create', entityType: 'event', entityId: r.rows[0]!.id });
          return r.rows[0]!.id;
        });
        reply.code(201);
        return (await pool.query(`${EV} WHERE id = $1`, [id])).rows[0];
      } catch (err) {
        if (isUniqueViolation(err, 'events_one_active_per_company')) {
          throw conflict('EVENT_ALREADY_ACTIVE', 'Já existe um evento ativo. Encerre-o antes de ativar outro.');
        }
        if ((err as { constraint?: string }).constraint?.includes('check')) throw new AppError(400, 'VALIDATION', 'A data de término não pode ser anterior ao início.');
        throw err;
      }
    });

    s.patch('/admin/events/:id', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(eventBody.partial(), req.body);
      const cur = await ownEvent(a.companyId, id);
      try {
        await withTx(pool, async (tx) => {
          await tx.query(
            `UPDATE events SET name = COALESCE($3,name), type = COALESCE($4,type), city = COALESCE($5,city),
                    state = COALESCE($6,state), starts_on = COALESCE($7,starts_on),
                    ends_on = CASE WHEN $8::boolean THEN $9 ELSE ends_on END,
                    description = CASE WHEN $10::boolean THEN $11 ELSE description END,
                    status = COALESCE($12,status), updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [id, a.companyId, b.name ?? null, b.type ?? null, b.city ?? null, b.state ?? null, b.startsOn ?? null,
             b.endsOn !== undefined, b.endsOn ?? null, b.description !== undefined, b.description ?? null, b.status ?? null],
          );
          await audit(tx, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'event.update', entityType: 'event', entityId: id, metadata: b });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'events_one_active_per_company')) {
          throw conflict('EVENT_ALREADY_ACTIVE', 'Já existe um evento ativo. Encerre-o antes de ativar outro.');
        }
        throw err;
      }
      // evento deixou de ser ativo → libera reservas dos carrinhos abertos
      if (cur.status === 'ACTIVE' && b.status && b.status !== 'ACTIVE') {
        await releaseActiveCarts(pool, { companyId: a.companyId, eventId: id }, 'ABANDONED');
      }
      return (await pool.query(`${EV} WHERE id = $1`, [id])).rows[0];
    });

    // ----------------------------------------------------------------- usuários
    const USR = `SELECT id, name, login, email, role, active, must_change_password AS "mustChangePassword", last_login_at AS "lastLoginAt", created_at AS "createdAt" FROM users`;
    s.get('/admin/users', async (req) => ({
      users: (await pool.query(`${USR} WHERE company_id = $1 ORDER BY active DESC, name`, [co(req).companyId])).rows,
    }));

    s.post('/admin/users', async (req, reply) => {
      const a = co(req);
      const b = parse(
        z.object({ name: trimmed(2, 120), login: userLogin, email: z.email().max(160).nullish(), role: z.enum(['COMPANY_ADMIN', 'SELLER']), password }),
        req.body,
      );
      try {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO users (company_id, name, login, email, password_hash, role, must_change_password)
           VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
          [a.companyId, b.name, b.login, b.email ?? null, await hashPassword(b.password), b.role],
        );
        await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'user.create', entityType: 'user', entityId: r.rows[0]!.id, metadata: { role: b.role, login: b.login }, ip: req.ip });
        reply.code(201);
        return (await pool.query(`${USR} WHERE id = $1`, [r.rows[0]!.id])).rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('LOGIN_TAKEN', 'Já existe um usuário com este login ou e-mail.');
        throw err;
      }
    });

    s.patch('/admin/users/:id', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(
        z.object({
          name: trimmed(2, 120).optional(),
          login: userLogin.optional(),
          email: z.email().max(160).nullable().optional(),
          role: z.enum(['COMPANY_ADMIN', 'SELLER']).optional(),
          active: z.boolean().optional(),
        }),
        req.body,
      );
      if (id === a.userId && (b.active === false || (b.role && b.role !== 'COMPANY_ADMIN'))) {
        throw new AppError(409, 'SELF_CHANGE', 'Você não pode desativar nem rebaixar o próprio usuário.');
      }
      try {
        await withTx(pool, async (tx) => {
          const u = await tx.query(
            `UPDATE users SET name = COALESCE($3,name), login = COALESCE($4,login),
                    email = CASE WHEN $5::boolean THEN $6 ELSE email END, role = COALESCE($7,role),
                    active = COALESCE($8,active), updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [id, a.companyId, b.name ?? null, b.login ?? null, b.email !== undefined, b.email ?? null, b.role ?? null, b.active ?? null],
          );
          if (!u.rowCount) throw notFound('Usuário');
          const admins = await tx.query(`SELECT 1 FROM users WHERE company_id = $1 AND role = 'COMPANY_ADMIN' AND active`, [a.companyId]);
          if (!admins.rowCount) throw new AppError(409, 'LAST_ADMIN', 'A empresa precisa de ao menos um administrador ativo.');
          if (b.active === false || b.role) {
            await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
          }
          await audit(tx, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'user.update', entityType: 'user', entityId: id, metadata: b, ip: req.ip });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('LOGIN_TAKEN', 'Já existe um usuário com este login ou e-mail.');
        throw err;
      }
      if (b.active === false) await releaseActiveCarts(pool, { companyId: a.companyId, userId: id }, 'ABANDONED');
      return (await pool.query(`${USR} WHERE id = $1`, [id])).rows[0];
    });

    s.post('/admin/users/:id/reset-password', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ password }), req.body);
      const r = await pool.query(
        `UPDATE users SET password_hash = $3, must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now()
          WHERE id = $1 AND company_id = $2`,
        [id, a.companyId, await hashPassword(b.password)],
      );
      if (!r.rowCount) throw notFound('Usuário');
      await pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'user.reset_password', entityType: 'user', entityId: id, ip: req.ip });
      return { ok: true };
    });

    s.get('/admin/users/:id/history', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const { page: pg, pageSize } = parse(page, req.query);
      const u = await pool.query(`${USR} WHERE id = $1 AND company_id = $2`, [id, a.companyId]);
      if (!u.rows[0]) throw notFound('Usuário');
      const [logs, sales] = await Promise.all([
        pool.query(
          `SELECT id, action, entity_type AS "entityType", entity_id AS "entityId", metadata, created_at AS "createdAt"
             FROM audit_logs WHERE company_id = $1 AND actor_id = $2 ORDER BY id DESC LIMIT $3 OFFSET $4`,
          [a.companyId, id, pageSize, (pg - 1) * pageSize],
        ),
        pool.query(
          `SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int AS "completedCount",
                  count(*) FILTER (WHERE status = 'CANCELLED')::int AS "cancelledCount",
                  COALESCE(sum(total_cents) FILTER (WHERE status = 'COMPLETED'),0)::bigint AS "netCents"
             FROM sales WHERE company_id = $1 AND operator_id = $2`,
          [a.companyId, id],
        ),
      ]);
      return { user: u.rows[0], sales: sales.rows[0], logs: logs.rows };
    });

    // ----------------------------------------------------- produtos e estoque
    s.get('/admin/events/:eventId/products', async (req) => {
      const a = co(req);
      const { eventId } = parse(z.object({ eventId: uuid }), req.params);
      const f = parse(z.object({ q: z.string().trim().max(80).optional(), category: z.string().trim().max(60).optional(), lowStock: z.enum(['1', '0']).optional(), active: z.enum(['1', '0']).optional() }), req.query);
      await ownEvent(a.companyId, eventId);
      await sweepExpired(pool);
      const r = await pool.query(
        `SELECT p.id, p.internal_code AS "internalCode", p.barcode, p.name, p.category, p.description,
                p.price_cents AS "priceCents", p.cost_cents AS "costCents", p.min_stock AS "minStock", p.active,
                st.physical_qty AS "physicalQty", st.reserved_qty AS "reservedQty", (st.physical_qty - st.reserved_qty) AS "availableQty"
           FROM products p JOIN stock st ON st.product_id = p.id
          WHERE p.company_id = $1 AND p.event_id = $2
            AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.internal_code ILIKE '%' || $3 || '%' OR p.barcode = $3)
            AND ($4::text IS NULL OR p.category = $4)
            AND ($5::text IS NULL OR $5 = '0' OR (st.physical_qty - st.reserved_qty) <= p.min_stock)
            AND ($6::text IS NULL OR p.active = ($6 = '1'))
          ORDER BY p.name`,
        [a.companyId, eventId, f.q ?? null, f.category ?? null, f.lowStock ?? null, f.active ?? null],
      );
      const cats = await pool.query(`SELECT DISTINCT category FROM products WHERE company_id = $1 AND event_id = $2 AND category IS NOT NULL ORDER BY 1`, [a.companyId, eventId]);
      return { products: r.rows, categories: cats.rows.map((c) => c.category) };
    });

    s.post('/admin/events/:eventId/products', async (req, reply) => {
      const a = co(req);
      const { eventId } = parse(z.object({ eventId: uuid }), req.params);
      const b = parse(productBody.extend({ initialQty: z.number().int().min(0).max(10_000_000).default(0) }), req.body);
      await ownEvent(a.companyId, eventId);
      try {
        const id = await withTx(pool, async (tx) => {
          const p = await tx.query<{ id: string }>(
            `INSERT INTO products (company_id, event_id, internal_code, barcode, name, category, description, price_cents, cost_cents, min_stock, active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [a.companyId, eventId, b.internalCode, b.barcode, b.name, b.category, b.description, b.priceCents, b.costCents, b.minStock, b.active],
          );
          const pid = p.rows[0]!.id;
          await tx.query(`INSERT INTO stock (product_id, company_id, event_id, physical_qty) VALUES ($1,$2,$3,$4)`, [pid, a.companyId, eventId, b.initialQty]);
          if (b.initialQty > 0) {
            await tx.query(
              `INSERT INTO stock_movements (company_id, event_id, product_id, type, quantity, balance_before, balance_after, user_id, reason)
               VALUES ($1,$2,$3,'INITIAL',$4,0,$4,$5,'Estoque inicial')`,
              [a.companyId, eventId, pid, b.initialQty, a.userId],
            );
          }
          await audit(tx, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'product.create', entityType: 'product', entityId: pid, metadata: { priceCents: b.priceCents, initialQty: b.initialQty } });
          return pid;
        });
        reply.code(201);
        return { id };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('PRODUCT_DUPLICATE', 'Já existe um produto com este código interno ou código de barras neste evento.');
        throw err;
      }
    });

    s.patch('/admin/products/:id', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(productBody.partial(), req.body);
      try {
        const r = await pool.query(
          `UPDATE products SET name = COALESCE($3,name), internal_code = COALESCE($4,internal_code),
                  barcode = CASE WHEN $5::boolean THEN $6 ELSE barcode END, category = CASE WHEN $7::boolean THEN $8 ELSE category END,
                  description = CASE WHEN $9::boolean THEN $10 ELSE description END, price_cents = COALESCE($11,price_cents),
                  cost_cents = CASE WHEN $12::boolean THEN $13 ELSE cost_cents END, min_stock = COALESCE($14,min_stock),
                  active = COALESCE($15,active), updated_at = now()
            WHERE id = $1 AND company_id = $2 RETURNING id`,
          [id, a.companyId, b.name ?? null, b.internalCode ?? null, b.barcode !== undefined, b.barcode ?? null, b.category !== undefined, b.category ?? null,
           b.description !== undefined, b.description ?? null, b.priceCents ?? null, b.costCents !== undefined, b.costCents ?? null, b.minStock ?? null, b.active ?? null],
        );
        if (!r.rowCount) throw notFound('Produto');
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('PRODUCT_DUPLICATE', 'Já existe um produto com este código interno ou código de barras neste evento.');
        throw err;
      }
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'product.update', entityType: 'product', entityId: id, metadata: b });
      return { ok: true };
    });

    s.post('/admin/products/:id/stock/entry', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ quantity: z.number().int().min(1).max(10_000_000), reason: optText(300) }), req.body);
      return changeStock(pool, co(req), id, { type: 'ENTRY', quantity: b.quantity, reason: b.reason });
    });
    s.post('/admin/products/:id/stock/adjust', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ newPhysicalQty: z.number().int().min(0).max(10_000_000), reason: trimmed(3, 300) }), req.body);
      return changeStock(pool, co(req), id, { type: 'ADJUSTMENT', newPhysicalQty: b.newPhysicalQty, reason: b.reason });
    });

    s.get('/admin/movements', async (req) => {
      const f = parse(
        z.object({ eventId: uuid.optional(), productId: uuid.optional(), userId: uuid.optional(), type: z.enum(['INITIAL', 'ENTRY', 'ADJUSTMENT', 'SALE', 'SALE_CANCEL_RETURN']).optional() }).extend(page.shape),
        req.query,
      );
      return reports.listMovements(pool, co(req).companyId, f, f.page, f.pageSize);
    });

    s.post('/admin/maintenance/reconcile-stock', async (req) => {
      const a = co(req);
      const r = await reconcileStock(pool, { fix: true, companyId: a.companyId });
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'maintenance.reconcile', metadata: { fixed: r.mismatches.length } });
      return r;
    });

    // ------------------------------------------------------ vendas e relatórios
    s.get('/admin/sales', async (req) => {
      const f = parse(filtersQ.extend(page.shape), req.query);
      return reports.listSales(pool, co(req).companyId, f, f.page, f.pageSize);
    });
    s.get('/admin/sales/:id', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      return getSaleDetail(pool, co(req).companyId, id);
    });
    s.post('/admin/sales/:id/cancel', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ confirm: z.literal(true), reason: trimmed(3, 300), cashRefundCents: z.number().int().min(0).nullish() }), req.body);
      return cancelSale(pool, co(req), id, { reason: b.reason, cashRefundCents: b.cashRefundCents });
    });

    s.get('/admin/cancellation-requests', async (req) => {
      const r = await pool.query(
        `SELECT cr.id, cr.sale_id AS "saleId", s.sale_number AS "saleNumber", s.total_cents AS "totalCents", cr.reason, cr.status,
                u.name AS "requestedByName", cr.created_at AS "createdAt"
           FROM cancellation_requests cr JOIN sales s ON s.id = cr.sale_id JOIN users u ON u.id = cr.requested_by_id
          WHERE cr.company_id = $1 AND cr.status = 'PENDING' ORDER BY cr.created_at`,
        [co(req).companyId],
      );
      return { requests: r.rows };
    });
    s.post('/admin/cancellation-requests/:id/approve', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ confirm: z.literal(true), cashRefundCents: z.number().int().min(0).nullish() }), req.body);
      const r = await pool.query(`SELECT sale_id, requested_by_id, reason FROM cancellation_requests WHERE id = $1 AND company_id = $2 AND status = 'PENDING'`, [id, a.companyId]);
      if (!r.rows[0]) throw notFound('Solicitação');
      return cancelSale(pool, a, r.rows[0].sale_id, { reason: r.rows[0].reason, cashRefundCents: b.cashRefundCents, requestedById: r.rows[0].requested_by_id });
    });
    s.post('/admin/cancellation-requests/:id/reject', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ note: optText(300) }), req.body ?? {});
      const r = await pool.query(
        `UPDATE cancellation_requests SET status = 'REJECTED', decided_by_id = $3, decided_at = now(), decision_note = $4
          WHERE id = $1 AND company_id = $2 AND status = 'PENDING'`,
        [id, a.companyId, a.userId, b.note],
      );
      if (!r.rowCount) throw notFound('Solicitação');
      await audit(pool, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'sale.cancel_request_rejected', entityType: 'cancellation_request', entityId: id });
      return { ok: true };
    });

    s.get('/admin/dashboard', async (req) => {
      const a = co(req);
      const f = parse(filtersQ, req.query);
      await sweepExpired(pool);
      const [sum, stock] = await Promise.all([reports.summary(pool, a.companyId, f), reports.stockOverview(pool, a.companyId, f.eventId)]);
      return { ...sum, ...stock };
    });
  });
}
