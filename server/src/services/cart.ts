import { config } from '../config.js';
import { isUniqueViolation, withTx, type Pool, type Tx } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import type { CompanyAuth } from '../auth.js';

export const MAX_ITEM_QTY = 1000;

export interface CartRow {
  id: string;
  company_id: string;
  event_id: string;
  user_id: string;
  status: string;
  expires_at: Date;
  created_at: Date;
}

/**
 * Libera todas as reservas ativas do carrinho e o encerra (EXPIRED/ABANDONED).
 * Ordem de travas: carrinho (já travado pelo chamador) → linhas de estoque por product_id.
 * O estoque FÍSICO nunca é alterado aqui.
 */
export async function releaseCart(tx: Tx, cartId: string, status: 'EXPIRED' | 'ABANDONED'): Promise<void> {
  const res = await tx.query<{ product_id: string; quantity: number }>(
    `SELECT product_id, quantity FROM stock_reservations
      WHERE cart_id = $1 AND status = 'ACTIVE' ORDER BY product_id`,
    [cartId],
  );
  if (res.rows.length) {
    await tx.query(
      `SELECT 1 FROM stock WHERE product_id = ANY($1::uuid[]) ORDER BY product_id FOR UPDATE`,
      [res.rows.map((r) => r.product_id)],
    );
    for (const r of res.rows) {
      await tx.query(
        `UPDATE stock SET reserved_qty = reserved_qty - $2, updated_at = now() WHERE product_id = $1`,
        [r.product_id, r.quantity],
      );
    }
    await tx.query(
      `UPDATE stock_reservations SET status = $2, resolved_at = now(), updated_at = now()
        WHERE cart_id = $1 AND status = 'ACTIVE'`,
      [cartId, status === 'EXPIRED' ? 'EXPIRED' : 'RELEASED'],
    );
  }
  await tx.query(
    `UPDATE carts SET status = $2, closed_at = now(), updated_at = now(),
            expiry_notice_pending = ($2 = 'EXPIRED')
      WHERE id = $1`,
    [cartId, status],
  );
}

/** Job: expira carrinhos vencidos (seguro com várias instâncias: SKIP LOCKED). */
export async function expireDueCarts(pool: Pool, batch = 100): Promise<number> {
  return withTx(pool, async (tx) => {
    const due = await tx.query<{ id: string }>(
      `SELECT id FROM carts WHERE status = 'ACTIVE' AND expires_at <= now()
        ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const c of due.rows) await releaseCart(tx, c.id, 'EXPIRED');
    return due.rows.length;
  });
}

/** Libera todos os carrinhos ativos de um evento / usuário (encerrar evento, desativar usuário). */
export async function releaseActiveCarts(
  pool: Pool,
  filter: { eventId?: string; userId?: string; companyId: string },
  status: 'EXPIRED' | 'ABANDONED' = 'ABANDONED',
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withTx(pool, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `SELECT id FROM carts WHERE status = 'ACTIVE' AND company_id = $1
            AND ($2::uuid IS NULL OR event_id = $2) AND ($3::uuid IS NULL OR user_id = $3)
          LIMIT 50 FOR UPDATE`,
        [filter.companyId, filter.eventId ?? null, filter.userId ?? null],
      );
      for (const c of r.rows) await releaseCart(tx, c.id, status);
      return r.rows.length;
    });
    total += n;
    if (n === 0) return total;
  }
}

async function activeEvent(tx: Tx, companyId: string) {
  const r = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM events WHERE company_id = $1 AND status = 'ACTIVE'`,
    [companyId],
  );
  return r.rows[0] ?? null;
}

/** Carrinho ativo do operador, travado. Expira (lazy) se vencido ou de outro evento. */
async function lockActiveCart(tx: Tx, a: CompanyAuth): Promise<CartRow | null> {
  const r = await tx.query<CartRow>(
    `SELECT * FROM carts WHERE user_id = $1 AND company_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
    [a.userId, a.companyId],
  );
  return r.rows[0] ?? null;
}

export async function lockOrCreateCart(tx: Tx, a: CompanyAuth): Promise<CartRow> {
  const ev = await activeEvent(tx, a.companyId);
  if (!ev) throw new AppError(409, 'NO_ACTIVE_EVENT', 'Não há evento ativo. Peça ao administrador para ativar um evento.');
  let cart = await lockActiveCart(tx, a);
  if (cart && (cart.expires_at <= new Date() || cart.event_id !== ev.id)) {
    await releaseCart(tx, cart.id, 'EXPIRED');
    cart = null;
  }
  if (cart) return cart;
  await tx.query(
    `INSERT INTO carts (company_id, event_id, user_id, expires_at)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4))
     ON CONFLICT (user_id) WHERE status = 'ACTIVE' DO NOTHING`,
    [a.companyId, ev.id, a.userId, a.cartTtlSeconds],
  );
  cart = await lockActiveCart(tx, a);
  if (!cart) throw conflict('CART_CONFLICT', 'Não foi possível abrir o carrinho. Tente novamente.');
  return cart;
}

/** Renovação única: agora + TTL, limitada a MAX minutos desde a criação do carrinho. */
export async function renewCart(tx: Tx, cartId: string, ttlSeconds: number) {
  await tx.query(
    `UPDATE carts SET updated_at = now(),
            expires_at = LEAST(now() + make_interval(secs => $2), created_at + make_interval(mins => $3))
      WHERE id = $1`,
    [cartId, ttlSeconds, config.cartMaxLifetimeMinutes],
  );
}

/**
 * Altera a quantidade de um produto no carrinho por `delta` (positivo reserva só a diferença;
 * negativo libera na hora). A reserva é um UPDATE condicional atômico no banco.
 */
export async function changeCartItem(
  pool: Pool,
  a: CompanyAuth,
  input: { productId?: string; barcode?: string; delta: number },
) {
  try {
    return await changeCartItemOnce(pool, a, input);
  } catch (err) {
    // Sem job em segundo plano (ex.: serverless): se faltou estoque, libera carrinhos vencidos de outros operadores e tenta uma vez.
    if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK' && (await expireDueCarts(pool)) > 0) {
      return changeCartItemOnce(pool, a, input);
    }
    throw err;
  }
}

/** Libera carrinhos vencidos antes de leituras que mostram disponibilidade; nunca derruba a leitura. */
export async function sweepExpired(pool: Pool): Promise<void> {
  try {
    await expireDueCarts(pool);
  } catch {
    /* melhor esforço */
  }
}

async function changeCartItemOnce(
  pool: Pool,
  a: CompanyAuth,
  input: { productId?: string; barcode?: string; delta: number },
) {
  if (!Number.isInteger(input.delta) || input.delta === 0) throw badRequest('INVALID_QUANTITY', 'Quantidade inválida.');
  return withTx(pool, async (tx) => {
    const cart = await lockOrCreateCart(tx, a);
    const p = await tx.query<{ id: string; name: string; active: boolean }>(
      `SELECT id, name, active FROM products
        WHERE company_id = $1 AND event_id = $2 AND (($3::uuid IS NOT NULL AND id = $3) OR ($4::text IS NOT NULL AND barcode = $4))`,
      [a.companyId, cart.event_id, input.productId ?? null, input.barcode ?? null],
    );
    const prod = p.rows[0];
    if (!prod) throw notFound('Produto');
    const cur = await tx.query<{ quantity: number }>(
      `SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cart.id, prod.id],
    );
    const before = cur.rows[0]?.quantity ?? 0;
    const after = before + input.delta;
    if (after < 0) throw badRequest('INVALID_QUANTITY', 'Quantidade não pode ficar negativa.');
    if (after > MAX_ITEM_QTY) throw badRequest('QUANTITY_TOO_LARGE', `Máximo de ${MAX_ITEM_QTY} unidades por item.`);
    if (input.delta > 0 && !prod.active) {
      throw new AppError(409, 'PRODUCT_INACTIVE', `"${prod.name}" está inativo e não pode ser vendido.`);
    }
    const diff = after - before;
    if (diff > 0) {
      const r = await tx.query(
        `UPDATE stock SET reserved_qty = reserved_qty + $2, updated_at = now()
          WHERE product_id = $1 AND physical_qty - reserved_qty >= $2`,
        [prod.id, diff],
      );
      if (!r.rowCount) {
        const s = await tx.query<{ avail: number }>(
          `SELECT physical_qty - reserved_qty AS avail FROM stock WHERE product_id = $1`,
          [prod.id],
        );
        throw new AppError(409, 'INSUFFICIENT_STOCK', `Estoque insuficiente de "${prod.name}".`, {
          productId: prod.id,
          available: s.rows[0]?.avail ?? 0,
        });
      }
      await tx.query(
        `INSERT INTO stock_reservations (company_id, event_id, cart_id, product_id, quantity)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cart_id, product_id) WHERE status = 'ACTIVE'
         DO UPDATE SET quantity = stock_reservations.quantity + EXCLUDED.quantity, updated_at = now()`,
        [a.companyId, cart.event_id, cart.id, prod.id, diff],
      );
    } else if (diff < 0) {
      await tx.query(
        `UPDATE stock SET reserved_qty = reserved_qty + $2, updated_at = now() WHERE product_id = $1`,
        [prod.id, diff],
      );
      if (after === 0) {
        await tx.query(
          `UPDATE stock_reservations SET status = 'RELEASED', resolved_at = now(), updated_at = now()
            WHERE cart_id = $1 AND product_id = $2 AND status = 'ACTIVE'`,
          [cart.id, prod.id],
        );
      } else {
        await tx.query(
          `UPDATE stock_reservations SET quantity = $3, updated_at = now()
            WHERE cart_id = $1 AND product_id = $2 AND status = 'ACTIVE'`,
          [cart.id, prod.id, after],
        );
      }
    }
    if (after === 0) {
      await tx.query(`DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`, [cart.id, prod.id]);
    } else {
      await tx.query(
        `INSERT INTO cart_items (cart_id, company_id, event_id, product_id, quantity)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [cart.id, a.companyId, cart.event_id, prod.id, after],
      );
    }
    await renewCart(tx, cart.id, a.cartTtlSeconds);
    return readCart(tx, a, cart.id);
  }).catch((err) => {
    if (isUniqueViolation(err)) throw conflict('CART_CONFLICT', 'Operação simultânea no carrinho. Tente novamente.');
    throw err;
  });
}

/** Remove o item inteiro (libera toda a reserva do produto). */
export async function removeCartItem(pool: Pool, a: CompanyAuth, productId: string) {
  const q = await pool.query<{ quantity: number }>(
    `SELECT ci.quantity FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
      WHERE c.user_id = $1 AND c.status = 'ACTIVE' AND ci.product_id = $2`,
    [a.userId, productId],
  );
  if (!q.rows[0]) return getCart(pool, a);
  return changeCartItem(pool, a, { productId, delta: -q.rows[0].quantity });
}

/** Limpar carrinho: libera todas as reservas. */
export async function clearCart(pool: Pool, a: CompanyAuth) {
  await withTx(pool, async (tx) => {
    const cart = await lockActiveCart(tx, a);
    if (cart) await releaseCart(tx, cart.id, 'ABANDONED');
  });
  return getCart(pool, a);
}

/** Atividade do operador: renova o prazo (mesma regra de qualquer alteração). */
export async function touchCart(pool: Pool, a: CompanyAuth) {
  await withTx(pool, async (tx) => {
    const cart = await lockActiveCart(tx, a);
    if (cart && cart.expires_at > new Date()) await renewCart(tx, cart.id, a.cartTtlSeconds);
  });
  return getCart(pool, a);
}

export interface CartView {
  cart: null | {
    id: string;
    eventId: string;
    expiresAt: string;
    items: {
      productId: string;
      name: string;
      code: string;
      unitPriceCents: number;
      quantity: number;
      subtotalCents: number;
      active: boolean;
    }[];
    totalCents: number;
    itemsCount: number;
  };
  serverTime: string;
  notice: null | { type: 'CART_EXPIRED'; items: { name: string; quantity: number }[] };
}

async function readCart(tx: Pick<Tx, 'query'>, a: CompanyAuth, cartId: string): Promise<CartView> {
  const c = await tx.query<{ id: string; event_id: string; expires_at: Date; now: Date }>(
    `SELECT id, event_id, expires_at, now() FROM carts WHERE id = $1 AND user_id = $2`,
    [cartId, a.userId],
  );
  const cart = c.rows[0]!;
  const items = await tx.query(
    `SELECT p.id AS "productId", p.name, p.internal_code AS code, p.price_cents AS "unitPriceCents",
            ci.quantity, (p.price_cents * ci.quantity)::int AS "subtotalCents", p.active
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1 ORDER BY ci.created_at`,
    [cartId],
  );
  const totalCents = items.rows.reduce((s, i) => s + i.subtotalCents, 0);
  return {
    cart: {
      id: cart.id,
      eventId: cart.event_id,
      expiresAt: cart.expires_at.toISOString(),
      items: items.rows,
      totalCents,
      itemsCount: items.rows.reduce((s, i) => s + i.quantity, 0),
    },
    serverTime: cart.now.toISOString(),
    notice: null,
  };
}

/** Leitura do carrinho com expiração lazy e aviso (entregue uma única vez). */
export async function getCart(pool: Pool, a: CompanyAuth): Promise<CartView> {
  return withTx(pool, async (tx) => {
    const now = (await tx.query<{ now: Date }>('SELECT now()')).rows[0]!.now;
    let cart = await lockActiveCart(tx, a);
    if (cart && cart.expires_at <= now) {
      await releaseCart(tx, cart.id, 'EXPIRED');
      cart = null;
    }
    let notice: CartView['notice'] = null;
    const exp = await tx.query<{ id: string }>(
      `SELECT id FROM carts WHERE user_id = $1 AND status = 'EXPIRED' AND expiry_notice_pending FOR UPDATE`,
      [a.userId],
    );
    if (exp.rows.length) {
      const ids = exp.rows.map((r) => r.id);
      const it = await tx.query<{ name: string; quantity: number }>(
        `SELECT p.name, ci.quantity FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ANY($1::uuid[])`,
        [ids],
      );
      notice = { type: 'CART_EXPIRED', items: it.rows };
      await tx.query(`UPDATE carts SET expiry_notice_pending = false WHERE id = ANY($1::uuid[])`, [ids]);
    }
    if (!cart) return { cart: null, serverTime: now.toISOString(), notice };
    const v = await readCart(tx, a, cart.id);
    v.notice = notice;
    return v;
  });
}
