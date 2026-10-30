import type { CompanyAuth } from '../auth.js';
import { withTx, type Pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { expireDueCarts } from './cart.js';

/** Entrada de mercadoria (quantity > 0) ou ajuste com justificativa (newPhysicalQty). Nunca apaga histórico. */
export async function changeStock(
  pool: Pool,
  a: CompanyAuth,
  productId: string,
  op: Parameters<typeof changeStockOnce>[3],
) {
  try {
    return await changeStockOnce(pool, a, productId, op);
  } catch (err) {
    if (err instanceof AppError && err.code === 'BELOW_RESERVED' && (await expireDueCarts(pool)) > 0) {
      return changeStockOnce(pool, a, productId, op);
    }
    throw err;
  }
}

async function changeStockOnce(
  pool: Pool,
  a: CompanyAuth,
  productId: string,
  op: { type: 'ENTRY'; quantity: number; reason?: string | null } | { type: 'ADJUSTMENT'; newPhysicalQty: number; reason: string },
) {
  return withTx(pool, async (tx) => {
    const r = await tx.query<{ event_id: string; physical_qty: number; reserved_qty: number }>(
      `SELECT event_id, physical_qty, reserved_qty FROM stock WHERE product_id = $1 AND company_id = $2 FOR UPDATE`,
      [productId, a.companyId],
    );
    const s = r.rows[0];
    if (!s) throw notFound('Produto');
    const before = s.physical_qty;
    const after = op.type === 'ENTRY' ? before + op.quantity : op.newPhysicalQty;
    if (op.type === 'ENTRY' && op.quantity <= 0) throw badRequest('INVALID_QUANTITY', 'Informe uma quantidade positiva.');
    if (after < 0) throw badRequest('INVALID_QUANTITY', 'O estoque não pode ficar negativo.');
    if (after === before) throw badRequest('NO_CHANGE', 'A quantidade informada é igual à atual.');
    if (after < s.reserved_qty) {
      throw new AppError(409, 'BELOW_RESERVED', `Há ${s.reserved_qty} unidade(s) reservada(s) em carrinhos ativos; o estoque não pode ficar abaixo disso.`, {
        reserved: s.reserved_qty,
      });
    }
    await tx.query(`UPDATE stock SET physical_qty = $2, updated_at = now() WHERE product_id = $1`, [productId, after]);
    await tx.query(
      `INSERT INTO stock_movements (company_id, event_id, product_id, type, quantity, balance_before, balance_after, user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.companyId, s.event_id, productId, op.type, after - before, before, after, a.userId, op.reason ?? null],
    );
    await audit(tx, {
      companyId: a.companyId, actorType: 'USER', actorId: a.userId, action: `stock.${op.type.toLowerCase()}`,
      entityType: 'product', entityId: productId, metadata: { before, after, reason: op.reason ?? null },
    });
    return { physicalQty: after, reservedQty: s.reserved_qty, availableQty: after - s.reserved_qty };
  });
}

/**
 * Recuperação de inconsistências: recalcula reserved_qty a partir das reservas ativas
 * e encerra reservas ativas órfãs (carrinho já encerrado). Retorna o que foi (ou seria) corrigido.
 */
export async function reconcileStock(pool: Pool, opts: { fix: boolean; companyId?: string }) {
  return withTx(pool, async (tx) => {
    let orphans = 0;
    if (opts.fix) {
      await tx.query(`LOCK TABLE stock, stock_reservations IN SHARE ROW EXCLUSIVE MODE`);
      const o = await tx.query(
        `UPDATE stock_reservations r SET status = 'RELEASED', resolved_at = now(), updated_at = now()
          FROM carts c WHERE c.id = r.cart_id AND r.status = 'ACTIVE' AND c.status <> 'ACTIVE'
            AND ($1::uuid IS NULL OR r.company_id = $1)`,
        [opts.companyId ?? null],
      );
      orphans = o.rowCount ?? 0;
    }
    const diff = await tx.query<{ product_id: string; reserved_qty: number; expected: number }>(
      `SELECT s.product_id, s.reserved_qty, COALESCE(r.q, 0)::int AS expected
         FROM stock s
         LEFT JOIN (SELECT product_id, SUM(quantity) q FROM stock_reservations WHERE status = 'ACTIVE' GROUP BY 1) r
           ON r.product_id = s.product_id
        WHERE s.reserved_qty <> COALESCE(r.q, 0) AND ($1::uuid IS NULL OR s.company_id = $1)`,
      [opts.companyId ?? null],
    );
    if (opts.fix) {
      for (const d of diff.rows) {
        await tx.query(`UPDATE stock SET reserved_qty = $2, updated_at = now() WHERE product_id = $1`, [d.product_id, d.expected]);
      }
      if (diff.rows.length || orphans) {
        await audit(tx, {
          companyId: opts.companyId ?? null, actorType: 'SYSTEM', action: 'stock.reconcile',
          metadata: { corrected: diff.rows.length, orphanReservations: orphans },
        });
      }
    }
    return { orphanReservations: orphans, mismatches: diff.rows.map((d) => ({ productId: d.product_id, was: d.reserved_qty, now: d.expected })) };
  });
}
