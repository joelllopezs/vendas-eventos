import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { co, companyGuard } from '../auth.js';
import type { Pool } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { parse, trimmed, uuid } from '../lib/validate.js';
import { changeCartItem, clearCart, getCart, removeCartItem, sweepExpired, touchCart } from '../services/cart.js';
import { cancelSale, checkout, getSaleDetail, requestCancellation } from '../services/sales.js';

export async function pdvRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (s) => {
    // administradores também podem operar o PDV (superconjunto do vendedor)
    s.addHook('onRequest', companyGuard(pool));

    s.get('/pdv/context', async (req) => {
      const a = co(req);
      const ev = await pool.query(
        `SELECT id, name, type, city, state FROM events WHERE company_id = $1 AND status = 'ACTIVE'`,
        [a.companyId],
      );
      return {
        event: ev.rows[0] ?? null,
        operator: { id: a.userId, name: a.userName, role: a.role },
        cartTtlSeconds: a.cartTtlSeconds,
        cancelPolicy: a.cancelPolicy,
      };
    });

    // Somente produtos ATIVOS do evento ativo; o vendedor nunca recebe custo nem estoque físico.
    s.get('/pdv/products', async (req) => {
      const a = co(req);
      const f = parse(z.object({ q: z.string().trim().max(80).optional(), category: z.string().trim().max(60).optional() }), req.query);
      await sweepExpired(pool);
      const r = await pool.query(
        `SELECT p.id, p.name, p.internal_code AS code, p.barcode, p.category, p.price_cents AS "priceCents",
                (st.physical_qty - st.reserved_qty) AS "availableQty"
           FROM products p
           JOIN events e ON e.id = p.event_id AND e.status = 'ACTIVE'
           JOIN stock st ON st.product_id = p.id
          WHERE p.company_id = $1 AND p.active
            AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.internal_code ILIKE '%' || $2 || '%' OR p.barcode = $2)
            AND ($3::text IS NULL OR p.category = $3)
          ORDER BY p.name`,
        [a.companyId, f.q ?? null, f.category ?? null],
      );
      const cats = r.rows.length ? [...new Set(r.rows.map((x) => x.category).filter(Boolean))].sort() : [];
      return { products: r.rows, categories: cats };
    });

    s.get('/pdv/cart', async (req) => getCart(pool, co(req)));

    s.post('/pdv/cart/items', async (req) => {
      const b = parse(
        z.object({ productId: uuid.optional(), barcode: z.string().trim().min(1).max(60).optional(), delta: z.number().int().min(-1000).max(1000).default(1) })
          .refine((v) => v.productId || v.barcode, 'Informe o produto ou o código de barras.'),
        req.body,
      );
      return changeCartItem(pool, co(req), b);
    });

    s.delete('/pdv/cart/items/:productId', async (req) => {
      const { productId } = parse(z.object({ productId: uuid }), req.params);
      return removeCartItem(pool, co(req), productId);
    });

    s.delete('/pdv/cart', async (req) => clearCart(pool, co(req)));
    s.post('/pdv/cart/touch', async (req) => touchCart(pool, co(req)));

    s.post('/pdv/cart/checkout', async (req, reply) => {
      const b = parse(
        z.object({
          idempotencyKey: z.string().min(8).max(100),
          expectedTotalCents: z.number().int().min(1),
          payment: z.object({
            method: z.enum(['CASH', 'PIX', 'DEBIT', 'CREDIT']),
            receivedCents: z.number().int().min(0).max(2_000_000_000).optional(),
            confirmed: z.boolean().optional(),
          }),
        }),
        req.body,
      );
      const r = await checkout(pool, co(req), b);
      reply.code(r.duplicate ? 200 : 201);
      return r;
    });

    // ----- vendas do próprio operador
    s.get('/pdv/sales', async (req) => {
      const a = co(req);
      const f = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
      const r = await pool.query(
        `SELECT s.id, s.sale_number AS "saleNumber", s.status, s.total_cents AS "totalCents", s.items_count AS "itemsCount",
                s.created_at AS "createdAt", p.method,
                (SELECT count(*) FROM cancellation_requests cr WHERE cr.sale_id = s.id AND cr.status = 'PENDING')::int AS "pendingRequest"
           FROM sales s JOIN payments p ON p.sale_id = s.id
          WHERE s.company_id = $1 AND s.operator_id = $2 AND s.event_id = (SELECT id FROM events WHERE company_id = $1 AND status = 'ACTIVE')
          ORDER BY s.created_at DESC LIMIT $3`,
        [a.companyId, a.userId, f.limit],
      );
      return { sales: r.rows };
    });

    s.get('/pdv/sales/:id', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      return getSaleDetail(pool, a.companyId, id, a.userId);
    });

    // Cancelamento direto (administrador, ou vendedor se a política for SELLER_OWN) — com confirmação e motivo
    s.post('/pdv/sales/:id/cancel', async (req) => {
      const a = co(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ confirm: z.literal(true), reason: trimmed(3, 300), cashRefundCents: z.number().int().min(0).nullish() }), req.body);
      if (a.role !== 'COMPANY_ADMIN') {
        const own = await pool.query(`SELECT 1 FROM sales WHERE id = $1 AND company_id = $2 AND operator_id = $3`, [id, a.companyId, a.userId]);
        if (!own.rowCount) throw notFound('Venda');
      }
      return cancelSale(pool, a, id, { reason: b.reason, cashRefundCents: b.cashRefundCents });
    });

    s.post('/pdv/sales/:id/cancel-request', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ reason: trimmed(3, 300) }), req.body);
      return requestCancellation(pool, co(req), id, b.reason);
    });
  });
}
