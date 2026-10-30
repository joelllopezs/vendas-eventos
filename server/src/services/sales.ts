import type { CompanyAuth } from '../auth.js';
import { isUniqueViolation, withTx, type Pool, type Q, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { releaseCart } from './cart.js';

export type PayMethod = 'CASH' | 'PIX' | 'DEBIT' | 'CREDIT';

export interface CheckoutInput {
  idempotencyKey: string;
  expectedTotalCents: number;
  payment: { method: PayMethod; receivedCents?: number; confirmed?: boolean };
}

/** Ganchos só para testes de falha (nunca expostos via HTTP). */
export interface TestHooks {
  afterStockUpdate?: () => Promise<void> | void;
}

const SALE_SELECT = `
  SELECT s.id, s.sale_number AS "saleNumber", s.event_id AS "eventId", s.status, s.total_cents AS "totalCents",
         s.items_count AS "itemsCount", s.created_at AS "createdAt", s.operator_id AS "operatorId",
         u.name AS "operatorName", s.cancelled_at AS "cancelledAt", s.cancel_reason AS "cancelReason",
         cu.name AS "cancelledByName",
         p.method, p.received_cents AS "receivedCents", p.change_cents AS "changeCents",
         sc.requires_external_refund AS "requiresExternalRefund", sc.cash_refund_cents AS "cashRefundCents"
    FROM sales s
    JOIN users u ON u.id = s.operator_id
    JOIN payments p ON p.sale_id = s.id
    LEFT JOIN users cu ON cu.id = s.cancelled_by_id
    LEFT JOIN sale_cancellations sc ON sc.sale_id = s.id`;

export async function getSaleDetail(q: Q, companyId: string, saleId: string, operatorId?: string) {
  const r = await q.query(
    `${SALE_SELECT} WHERE s.id = $1 AND s.company_id = $2 AND ($3::uuid IS NULL OR s.operator_id = $3)`,
    [saleId, companyId, operatorId ?? null],
  );
  if (!r.rows[0]) throw notFound('Venda');
  const items = await q.query(
    `SELECT product_id AS "productId", product_name AS name, product_code AS code,
            unit_price_cents AS "unitPriceCents", quantity, subtotal_cents AS "subtotalCents"
       FROM sale_items WHERE sale_id = $1 AND company_id = $2 ORDER BY product_name`,
    [saleId, companyId],
  );
  return { ...r.rows[0], items: items.rows };
}

export async function checkout(pool: Pool, a: CompanyAuth, input: CheckoutInput, hooks: TestHooks = {}) {
  type Outcome = { saleId: string; duplicate: boolean } | { expired: true };
  const out: Outcome = await withTx(pool, async (tx): Promise<Outcome> => {
    // 1) trava o carrinho ativo do operador (serializa cliques/reenvios simultâneos)
    const cartR = await tx.query<{ id: string; event_id: string; expires_at: Date }>(
      `SELECT id, event_id, expires_at FROM carts
        WHERE user_id = $1 AND company_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [a.userId, a.companyId],
    );
    const cart = cartR.rows[0];

    // 2) idempotência: mesma chave → devolve a venda já registrada
    const dup = await tx.query<{ id: string }>(
      `SELECT id FROM sales WHERE operator_id = $1 AND idempotency_key = $2`,
      [a.userId, input.idempotencyKey],
    );
    if (dup.rows[0]) return { saleId: dup.rows[0].id, duplicate: true };

    if (!cart) throw new AppError(409, 'CART_EMPTY', 'Não há carrinho aberto. Adicione produtos para vender.');
    if (cart.expires_at <= new Date()) {
      await releaseCart(tx, cart.id, 'EXPIRED');
      return { expired: true };
    }

    // 3) itens, produtos e reservas
    const items = await tx.query<{
      product_id: string;
      quantity: number;
      name: string;
      internal_code: string;
      price_cents: number;
      active: boolean;
      reserved: number | null;
    }>(
      `SELECT ci.product_id, ci.quantity, p.name, p.internal_code, p.price_cents, p.active,
              (SELECT r.quantity FROM stock_reservations r
                WHERE r.cart_id = ci.cart_id AND r.product_id = ci.product_id AND r.status = 'ACTIVE') AS reserved
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1 ORDER BY ci.product_id`,
      [cart.id],
    );
    if (!items.rows.length) throw new AppError(409, 'CART_EMPTY', 'O carrinho está vazio.');
    for (const i of items.rows) {
      if (!i.active) throw new AppError(409, 'PRODUCT_INACTIVE', `"${i.name}" foi desativado. Remova-o do carrinho.`);
      if (i.reserved !== i.quantity) {
        throw new AppError(409, 'RESERVATION_INVALID', `A reserva de "${i.name}" não está mais válida. Atualize o carrinho.`);
      }
    }

    // 4) total recalculado no servidor
    const total = items.rows.reduce((s, i) => s + i.price_cents * i.quantity, 0);
    if (!Number.isSafeInteger(total) || total <= 0 || total > 2_000_000_000) {
      throw new AppError(400, 'INVALID_TOTAL', 'Total da venda inválido.');
    }
    if (total !== input.expectedTotalCents) {
      throw new AppError(409, 'PRICE_CHANGED', 'Os preços mudaram. Confira o novo total.', { totalCents: total });
    }

    // 5) pagamento (apenas registro informado pelo operador; sem integração externa)
    const pay = input.payment;
    let received: number | null = null;
    let change: number | null = null;
    if (pay.method === 'CASH') {
      if (!Number.isInteger(pay.receivedCents) || (pay.receivedCents as number) < 0) {
        throw new AppError(400, 'INVALID_PAYMENT', 'Informe o valor recebido.');
      }
      received = pay.receivedCents as number;
      if (received < total) {
        throw new AppError(409, 'INSUFFICIENT_PAYMENT', 'Valor recebido menor que o total.', {
          missingCents: total - received,
        });
      }
      change = received - total;
    } else if (pay.confirmed !== true) {
      throw new AppError(400, 'PAYMENT_NOT_CONFIRMED', 'Confirme que o pagamento foi recebido/aprovado.');
    }

    // 6) número sequencial da venda por evento (também valida evento ATIVO)
    const ev = await tx.query<{ n: number }>(
      `UPDATE events SET next_sale_number = next_sale_number + 1
        WHERE id = $1 AND company_id = $2 AND status = 'ACTIVE' RETURNING next_sale_number - 1 AS n`,
      [cart.event_id, a.companyId],
    );
    if (!ev.rows[0]) throw new AppError(409, 'EVENT_NOT_ACTIVE', 'O evento não está ativo.');

    // 7) venda + itens (preço copiado) + pagamento
    const itemsCount = items.rows.reduce((s, i) => s + i.quantity, 0);
    const sale = await tx.query<{ id: string }>(
      `INSERT INTO sales (company_id, event_id, sale_number, cart_id, operator_id, idempotency_key, total_cents, items_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [a.companyId, cart.event_id, ev.rows[0].n, cart.id, a.userId, input.idempotencyKey, total, itemsCount],
    );
    const saleId = sale.rows[0]!.id;
    for (const i of items.rows) {
      await tx.query(
        `INSERT INTO sale_items (sale_id, company_id, event_id, product_id, product_name, product_code, unit_price_cents, quantity, subtotal_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [saleId, a.companyId, cart.event_id, i.product_id, i.name, i.internal_code, i.price_cents, i.quantity, i.price_cents * i.quantity],
      );
    }
    await tx.query(
      `INSERT INTO payments (sale_id, company_id, method, amount_cents, received_cents, change_cents, manual_confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [saleId, a.companyId, pay.method, total, received, change, pay.method !== 'CASH'],
    );

    // 8) baixa física + consumo da reserva, com movimentação (travas em ordem de product_id)
    await tx.query(`SELECT 1 FROM stock WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE`, [
      items.rows.map((i) => i.product_id),
    ]);
    for (const i of items.rows) {
      const s = await tx.query<{ physical_qty: number }>(
        `UPDATE stock SET physical_qty = physical_qty - $2, reserved_qty = reserved_qty - $2, updated_at = now()
          WHERE product_id = $1 AND physical_qty >= $2 AND reserved_qty >= $2 RETURNING physical_qty`,
        [i.product_id, i.quantity],
      );
      if (!s.rows[0]) throw new AppError(409, 'STOCK_INCONSISTENT', `Estoque inconsistente para "${i.name}". Venda não registrada.`);
      const after = s.rows[0].physical_qty;
      await tx.query(
        `INSERT INTO stock_movements (company_id, event_id, product_id, type, quantity, balance_before, balance_after, user_id, sale_id)
         VALUES ($1,$2,$3,'SALE',$4,$5,$6,$7,$8)`,
        [a.companyId, cart.event_id, i.product_id, -i.quantity, after + i.quantity, after, a.userId, saleId],
      );
    }
    await tx.query(
      `UPDATE stock_reservations SET status = 'CONSUMED', resolved_at = now(), updated_at = now()
        WHERE cart_id = $1 AND status = 'ACTIVE'`,
      [cart.id],
    );
    await hooks.afterStockUpdate?.();
    await tx.query(`UPDATE carts SET status = 'COMPLETED', closed_at = now(), updated_at = now() WHERE id = $1`, [cart.id]);
    await audit(tx, {
      companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'sale.create',
      entityType: 'sale', entityId: saleId, metadata: { totalCents: total, method: pay.method },
    });
    return { saleId, duplicate: false };
  }).catch(async (err) => {
    if (isUniqueViolation(err, 'sales_operator_id_idempotency_key_key')) {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM sales WHERE operator_id = $1 AND idempotency_key = $2`,
        [a.userId, input.idempotencyKey],
      );
      if (r.rows[0]) return { saleId: r.rows[0].id, duplicate: true } as Outcome;
    }
    throw err;
  });

  if ('expired' in out) {
    throw new AppError(409, 'CART_EXPIRED', 'A reserva expirou e os itens foram liberados. Adicione os produtos novamente.');
  }
  return { duplicate: out.duplicate, sale: await getSaleDetail(pool, a.companyId, out.saleId) };
}

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------
export async function cancelSale(
  pool: Pool,
  a: CompanyAuth,
  saleId: string,
  input: { reason: string; cashRefundCents?: number | null; requestedById?: string | null },
) {
  await withTx(pool, async (tx) => {
    const s = await tx.query<{
      id: string; event_id: string; status: string; operator_id: string; total_cents: number;
    }>(`SELECT id, event_id, status, operator_id, total_cents FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE`, [
      saleId,
      a.companyId,
    ]);
    const sale = s.rows[0];
    if (!sale) throw notFound('Venda');

    // permissão conforme a política da empresa
    if (a.role !== 'COMPANY_ADMIN') {
      if (a.cancelPolicy !== 'SELLER_OWN' || sale.operator_id !== a.userId) throw forbidden('Você não pode cancelar esta venda.');
    }
    if (sale.status === 'CANCELLED') throw conflict('ALREADY_CANCELLED', 'Esta venda já foi cancelada. O estoque não foi alterado.');

    const pay = (await tx.query<{ method: PayMethod; amount_cents: number }>(
      `SELECT method, amount_cents FROM payments WHERE sale_id = $1`, [saleId],
    )).rows[0]!;
    let refund: number | null = null;
    if (pay.method === 'CASH') {
      refund = input.cashRefundCents ?? pay.amount_cents;
      if (!Number.isInteger(refund) || refund < 0 || refund > pay.amount_cents) {
        throw new AppError(400, 'INVALID_REFUND', 'Valor de reembolso inválido.');
      }
    }

    await tx.query(
      `UPDATE sales SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = $2, cancel_reason = $3 WHERE id = $1`,
      [saleId, a.userId, input.reason],
    );
    const items = await tx.query<{ product_id: string; quantity: number }>(
      `SELECT product_id, quantity FROM sale_items WHERE sale_id = $1 ORDER BY product_id`, [saleId],
    );
    await tx.query(`SELECT 1 FROM stock WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE`, [
      items.rows.map((i) => i.product_id),
    ]);
    for (const i of items.rows) {
      const r = await tx.query<{ physical_qty: number }>(
        `UPDATE stock SET physical_qty = physical_qty + $2, updated_at = now() WHERE product_id = $1 RETURNING physical_qty`,
        [i.product_id, i.quantity],
      );
      const after = r.rows[0]!.physical_qty;
      await tx.query(
        `INSERT INTO stock_movements (company_id, event_id, product_id, type, quantity, balance_before, balance_after, user_id, sale_id, reason)
         VALUES ($1,$2,$3,'SALE_CANCEL_RETURN',$4,$5,$6,$7,$8,$9)`,
        [a.companyId, sale.event_id, i.product_id, i.quantity, after - i.quantity, after, a.userId, saleId, input.reason],
      );
    }
    await tx.query(
      `INSERT INTO sale_cancellations (sale_id, company_id, event_id, cancelled_by_id, requested_by_id, reason,
              original_method, original_amount_cents, cash_refund_cents, requires_external_refund)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [saleId, a.companyId, sale.event_id, a.userId, input.requestedById ?? null, input.reason, pay.method, pay.amount_cents, refund, pay.method !== 'CASH'],
    );
    await tx.query(
      `UPDATE cancellation_requests SET status = 'APPROVED', decided_by_id = $2, decided_at = now()
        WHERE sale_id = $1 AND status = 'PENDING'`,
      [saleId, a.userId],
    );
    await audit(tx, {
      companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'sale.cancel',
      entityType: 'sale', entityId: saleId, metadata: { reason: input.reason, method: pay.method, cashRefundCents: refund },
    });
  });
  return getSaleDetail(pool, a.companyId, saleId);
}

export async function requestCancellation(pool: Pool, a: CompanyAuth, saleId: string, reason: string) {
  if (a.cancelPolicy !== 'SELLER_REQUEST') throw forbidden('A política da empresa não permite solicitar cancelamentos.');
  return withTx(pool, async (tx: Tx) => {
    const s = await tx.query<{ status: string }>(
      `SELECT status FROM sales WHERE id = $1 AND company_id = $2 AND operator_id = $3 FOR UPDATE`,
      [saleId, a.companyId, a.userId],
    );
    if (!s.rows[0]) throw notFound('Venda');
    if (s.rows[0].status === 'CANCELLED') throw conflict('ALREADY_CANCELLED', 'Esta venda já foi cancelada.');
    try {
      const r = await tx.query(
        `INSERT INTO cancellation_requests (company_id, sale_id, requested_by_id, reason) VALUES ($1,$2,$3,$4) RETURNING id`,
        [a.companyId, saleId, a.userId, reason],
      );
      await audit(tx, { companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: 'sale.cancel_request', entityType: 'sale', entityId: saleId, metadata: { reason } });
      return r.rows[0] as { id: string };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('REQUEST_PENDING', 'Já existe uma solicitação pendente para esta venda.');
      throw err;
    }
  });
}
