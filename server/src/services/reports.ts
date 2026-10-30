import { config } from '../config.js';
import type { Q } from '../db/pool.js';

export interface ReportFilters {
  eventId?: string;
  from?: string;
  to?: string;
  productId?: string;
  operatorId?: string;
  method?: 'CASH' | 'PIX' | 'DEBIT' | 'CREDIT';
  status?: 'COMPLETED' | 'CANCELLED';
  q?: string;
}

/** Monta WHERE sobre `sales s` (+ payments p). Sempre filtra por company_id do servidor. */
function build(companyId: string, f: ReportFilters) {
  const params: unknown[] = [companyId];
  const conds = ['s.company_id = $1'];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace('?', `$${params.length}`));
  };
  if (f.eventId) add('s.event_id = ?', f.eventId);
  if (f.from) add('s.created_at >= ?', f.from);
  if (f.to) add('s.created_at < ?', f.to);
  if (f.operatorId) add('s.operator_id = ?', f.operatorId);
  if (f.status) add('s.status = ?', f.status);
  if (f.method) add('p.method = ?', f.method);
  if (f.q && /^\d+$/.test(f.q)) add('s.sale_number = ?', Number(f.q));
  let amt = 's.total_cents';
  if (f.productId) {
    params.push(f.productId);
    const n = params.length;
    conds.push(`EXISTS (SELECT 1 FROM sale_items fi WHERE fi.sale_id = s.id AND fi.product_id = $${n})`);
    // com filtro de produto, os valores passam a ser os do item filtrado
    amt = `(SELECT COALESCE(sum(fi.subtotal_cents),0) FROM sale_items fi WHERE fi.sale_id = s.id AND fi.product_id = $${n})`;
  }
  return { where: conds.join(' AND '), params, amt, productId: f.productId };
}

const FROM = `FROM sales s JOIN payments p ON p.sale_id = s.id`;

export async function summary(q: Q, companyId: string, f: ReportFilters) {
  const b = build(companyId, f);
  const tz = config.timezone;
  const [tot, byOp, byMethod, top, byDay] = await Promise.all([
    q.query(
      `SELECT count(*) FILTER (WHERE s.status = 'COMPLETED')::int AS "completedCount",
              count(*) FILTER (WHERE s.status = 'CANCELLED')::int AS "cancelledCount",
              COALESCE(sum(${b.amt}), 0)::bigint AS "grossCents",
              COALESCE(sum(${b.amt}) FILTER (WHERE s.status = 'CANCELLED'), 0)::bigint AS "cancelledCents"
         ${FROM} WHERE ${b.where}`,
      b.params,
    ),
    q.query(
      `SELECT u.id AS "operatorId", u.name AS "operatorName",
              count(*) FILTER (WHERE s.status = 'COMPLETED')::int AS "completedCount",
              count(*) FILTER (WHERE s.status = 'CANCELLED')::int AS "cancelledCount",
              COALESCE(sum(${b.amt}), 0)::bigint AS "grossCents",
              COALESCE(sum(${b.amt}) FILTER (WHERE s.status = 'CANCELLED'), 0)::bigint AS "cancelledCents"
         ${FROM} JOIN users u ON u.id = s.operator_id WHERE ${b.where}
        GROUP BY u.id, u.name ORDER BY 5 DESC`,
      b.params,
    ),
    q.query(
      `SELECT p.method,
              count(*) FILTER (WHERE s.status = 'COMPLETED')::int AS "completedCount",
              COALESCE(sum(${b.amt}), 0)::bigint AS "grossCents",
              COALESCE(sum(${b.amt}) FILTER (WHERE s.status = 'CANCELLED'), 0)::bigint AS "cancelledCents"
         ${FROM} WHERE ${b.where} GROUP BY p.method ORDER BY 3 DESC`,
      b.params,
    ),
    q.query(
      `SELECT si.product_id AS "productId", si.product_name AS name,
              sum(si.quantity)::int AS quantity, sum(si.subtotal_cents)::bigint AS "revenueCents"
         ${FROM} JOIN sale_items si ON si.sale_id = s.id
        WHERE ${b.where} AND s.status = 'COMPLETED'
          ${b.productId ? `AND si.product_id = $${b.params.length}` : ''}
        GROUP BY si.product_id, si.product_name ORDER BY 3 DESC, 4 DESC LIMIT 10`,
      b.params,
    ),
    q.query(
      `SELECT to_char(s.created_at AT TIME ZONE '${tz}', 'YYYY-MM-DD') AS day,
              COALESCE(sum(${b.amt}) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint AS "netCents",
              count(*) FILTER (WHERE s.status = 'COMPLETED')::int AS "completedCount"
         ${FROM} WHERE ${b.where} GROUP BY 1 ORDER BY 1`,
      b.params,
    ),
  ]);
  const t = tot.rows[0];
  const netCents = t.grossCents - t.cancelledCents;
  const withNet = <T extends { grossCents: number; cancelledCents: number }>(r: T) => ({
    ...r,
    netCents: r.grossCents - r.cancelledCents,
  });
  return {
    ...t,
    netCents,
    averageTicketCents: t.completedCount ? Math.round(netCents / t.completedCount) : 0,
    byOperator: byOp.rows.map(withNet),
    byMethod: byMethod.rows.map(withNet),
    topProducts: top.rows,
    byDay: byDay.rows,
  };
}

export async function stockOverview(q: Q, companyId: string, eventId?: string) {
  const base = `FROM products p JOIN stock s ON s.product_id = p.id
                 WHERE p.company_id = $1 AND ($2::uuid IS NULL OR p.event_id = $2)`;
  const [low, avail] = await Promise.all([
    q.query(
      `SELECT p.id AS "productId", p.name, p.internal_code AS code, p.min_stock AS "minStock",
              s.physical_qty AS "physicalQty", s.reserved_qty AS "reservedQty", (s.physical_qty - s.reserved_qty) AS "availableQty"
         ${base} AND p.active AND (s.physical_qty - s.reserved_qty) <= p.min_stock
        ORDER BY (s.physical_qty - s.reserved_qty), p.name LIMIT 50`,
      [companyId, eventId ?? null],
    ),
    q.query(
      `SELECT count(*) FILTER (WHERE p.active AND s.physical_qty - s.reserved_qty > 0)::int AS "availableProducts",
              count(*) FILTER (WHERE p.active)::int AS "activeProducts"
         ${base}`,
      [companyId, eventId ?? null],
    ),
  ]);
  return { lowStock: low.rows, ...avail.rows[0] };
}

export async function listSales(q: Q, companyId: string, f: ReportFilters, page: number, pageSize: number) {
  const b = build(companyId, f);
  const [rows, count] = await Promise.all([
    q.query(
      `SELECT s.id, s.sale_number AS "saleNumber", s.status, s.total_cents AS "totalCents", s.items_count AS "itemsCount",
              s.created_at AS "createdAt", u.name AS "operatorName", p.method,
              s.cancelled_at AS "cancelledAt", s.cancel_reason AS "cancelReason", cu.name AS "cancelledByName",
              (SELECT count(*) FROM cancellation_requests cr WHERE cr.sale_id = s.id AND cr.status = 'PENDING')::int AS "pendingRequest"
         ${FROM} JOIN users u ON u.id = s.operator_id LEFT JOIN users cu ON cu.id = s.cancelled_by_id
        WHERE ${b.where} ORDER BY s.created_at DESC, s.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      b.params,
    ),
    q.query(`SELECT count(*)::int AS n ${FROM} WHERE ${b.where}`, b.params),
  ]);
  return { rows: rows.rows, total: count.rows[0].n as number, page, pageSize };
}

export async function listMovements(
  q: Q,
  companyId: string,
  f: { eventId?: string; productId?: string; type?: string; userId?: string },
  page: number,
  pageSize: number,
) {
  const where = `m.company_id = $1 AND ($2::uuid IS NULL OR m.event_id = $2) AND ($3::uuid IS NULL OR m.product_id = $3)
                 AND ($4::text IS NULL OR m.type = $4) AND ($5::uuid IS NULL OR m.user_id = $5)`;
  const params = [companyId, f.eventId ?? null, f.productId ?? null, f.type ?? null, f.userId ?? null];
  const [rows, count] = await Promise.all([
    q.query(
      `SELECT m.id, m.type, m.quantity, m.balance_before AS "balanceBefore", m.balance_after AS "balanceAfter",
              m.reason, m.created_at AS "createdAt", p.name AS "productName", p.internal_code AS "productCode",
              u.name AS "userName", s.sale_number AS "saleNumber", m.event_id AS "eventId"
         FROM stock_movements m JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id LEFT JOIN sales s ON s.id = m.sale_id
        WHERE ${where} ORDER BY m.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    ),
    q.query(`SELECT count(*)::int AS n FROM stock_movements m WHERE ${where}`, params),
  ]);
  return { rows: rows.rows, total: count.rows[0].n as number, page, pageSize };
}
