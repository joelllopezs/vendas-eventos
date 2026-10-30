import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { hashPassword } from '../src/lib/security.js';

export const PW = 'Senha1234';
let pwHash: string;

export interface Ctx {
  pool: Pool;
  app: FastifyInstance;
}

export async function startCtx(): Promise<Ctx> {
  const pool = createPool(process.env.DATABASE_URL, 12);
  await runMigrations(pool);
  pwHash = await hashPassword(PW);
  const app = await buildApp(pool);
  return { pool, app };
}
export async function stopCtx(c: Ctx) {
  await c.app.close();
  await c.pool.end();
}

export async function resetDb(pool: Pool) {
  await pool.query(`TRUNCATE sessions, cancellation_requests, sale_cancellations, payments, sale_items, stock_movements,
    stock_reservations, cart_items, sales, carts, stock, products, events, users, audit_logs, companies, platform_admins RESTART IDENTITY CASCADE`);
}

export async function seedCompany(pool: Pool, slug: string, opts: { cancelPolicy?: string; ttl?: number } = {}) {
  const c = await pool.query<{ id: string }>(
    `INSERT INTO companies (slug, trade_name, contact_email, phone, cancel_policy, cart_ttl_seconds)
     VALUES ($1,$2,'a@b.com','11999999999',$3,$4) RETURNING id`,
    [slug, `Empresa ${slug}`, opts.cancelPolicy ?? 'ADMIN_ONLY', opts.ttl ?? 300],
  );
  return c.rows[0]!.id;
}
export async function seedUser(pool: Pool, companyId: string, login: string, role: 'COMPANY_ADMIN' | 'SELLER') {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (company_id, name, login, password_hash, role, must_change_password) VALUES ($1,$2,$3,$4,$5,false) RETURNING id`,
    [companyId, `User ${login}`, login, pwHash, role],
  );
  return r.rows[0]!.id;
}
export async function seedEvent(pool: Pool, companyId: string, status = 'ACTIVE') {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO events (company_id, name, type, city, state, starts_on, status) VALUES ($1,'Festa','PARTY','Recife','PE','2026-11-01',$2) RETURNING id`,
    [companyId, status],
  );
  return r.rows[0]!.id;
}
export async function seedProduct(pool: Pool, companyId: string, eventId: string, code: string, price: number, qty: number, extra: { min?: number; active?: boolean } = {}) {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO products (company_id, event_id, internal_code, name, price_cents, min_stock, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [companyId, eventId, code, `Produto ${code}`, price, extra.min ?? 0, extra.active ?? true],
  );
  await pool.query(`INSERT INTO stock (product_id, company_id, event_id, physical_qty) VALUES ($1,$2,$3,$4)`, [p.rows[0]!.id, companyId, eventId, qty]);
  return p.rows[0]!.id;
}

export async function login(app: FastifyInstance, company: string, user: string, password = PW) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { company, login: user, password } });
  const cookie = res.cookies.find((c) => c.name === 'pdv_session');
  return { status: res.statusCode, cookie: cookie ? `pdv_session=${cookie.value}` : '', body: res.json() };
}

export async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, body?: unknown) {
  const res = await app.inject({ method, url, headers: { cookie }, ...(body !== undefined ? { payload: body as object } : {}) });
  let json: any = null;
  try { json = res.json(); } catch { /* sem corpo */ }
  return { status: res.statusCode, body: json };
}

export async function stockOf(pool: Pool, productId: string) {
  const r = await pool.query(`SELECT physical_qty AS p, reserved_qty AS r FROM stock WHERE product_id = $1`, [productId]);
  return { physical: r.rows[0].p as number, reserved: r.rows[0].r as number };
}

/** Mundo padrão: empresa, evento ativo, admin, N vendedores logados e 2 produtos. */
export async function world(c: Ctx, opts: { slug?: string; sellers?: number; cancelPolicy?: string; qtyA?: number; qtyB?: number } = {}) {
  const slug = opts.slug ?? 'acme';
  const companyId = await seedCompany(c.pool, slug, { cancelPolicy: opts.cancelPolicy });
  const eventId = await seedEvent(c.pool, companyId);
  await seedUser(c.pool, companyId, 'admin', 'COMPANY_ADMIN');
  const admin = (await login(c.app, slug, 'admin')).cookie;
  const sellers: { id: string; cookie: string }[] = [];
  for (let i = 1; i <= (opts.sellers ?? 2); i++) {
    const id = await seedUser(c.pool, companyId, `vend${i}`, 'SELLER');
    sellers.push({ id, cookie: (await login(c.app, slug, `vend${i}`)).cookie });
  }
  const a = await seedProduct(c.pool, companyId, eventId, 'A1', 1000, opts.qtyA ?? 100);
  const b = await seedProduct(c.pool, companyId, eventId, 'B1', 550, opts.qtyB ?? 50);
  return { companyId, eventId, admin, sellers, a, b };
}
