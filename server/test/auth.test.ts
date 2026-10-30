import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/security.js';
import { call, login, PW, resetDb, seedCompany, seedEvent, seedProduct, seedUser, startCtx, stopCtx, world, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => { c = await startCtx(); });
afterAll(async () => { await stopCtx(c); });
beforeEach(async () => { await resetDb(c.pool); });

describe('login e permissões', () => {
  it('1. login de administrador (e troca obrigatória de senha após cadastro pela plataforma)', async () => {
    await c.pool.query(`INSERT INTO platform_admins (email, name, password_hash) VALUES ('root@x.com','Root',$1)`, [await hashPassword('PlataformaSegura1')]);
    const pl = await c.app.inject({ method: 'POST', url: '/api/platform/login', payload: { email: 'root@x.com', password: 'PlataformaSegura1' } });
    expect(pl.statusCode).toBe(200);
    const pcookie = `pdv_session=${pl.cookies[0]!.value}`;
    const created = await call(c.app, 'POST', '/api/platform/companies', pcookie, {
      tradeName: 'Eventos Alfa', cnpj: '12.345.678/0001-90', contactEmail: 'c@alfa.com', phone: '81999990000', slug: 'alfa',
      admin: { name: 'Ana Admin', login: 'ana', password: 'Inicial123' },
    });
    expect(created.status).toBe(201);
    const l = await login(c.app, 'alfa', 'ana', 'Inicial123');
    expect(l.status).toBe(200);
    // senha inicial: tudo bloqueado até trocar
    expect((await call(c.app, 'GET', '/api/admin/events', l.cookie)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call(c.app, 'POST', '/api/auth/change-password', l.cookie, { currentPassword: 'Inicial123', newPassword: 'NovaSenha99' })).status).toBe(200);
    const l2 = await login(c.app, 'alfa', 'ana', 'NovaSenha99');
    const me = await call(c.app, 'GET', '/api/auth/me', l2.cookie);
    expect(me.body.user.role).toBe('COMPANY_ADMIN');
    expect((await call(c.app, 'GET', '/api/admin/events', l2.cookie)).status).toBe(200);
    // logout revoga a sessão
    await call(c.app, 'POST', '/api/auth/logout', l2.cookie);
    expect((await call(c.app, 'GET', '/api/auth/me', l2.cookie)).status).toBe(401);
  });

  it('1b. cadastro de empresa exige administrador da plataforma (sem cadastro público)', async () => {
    const r = await c.app.inject({ method: 'POST', url: '/api/platform/companies', payload: {} });
    expect(r.statusCode).toBe(401);
    const w = await world(c);
    expect((await call(c.app, 'POST', '/api/platform/companies', w.admin, {})).status).toBe(401); // admin de empresa não é da plataforma
  });

  it('2. login de vendedor e erros genéricos / bloqueio por tentativas', async () => {
    const w = await world(c);
    const ok = await login(c.app, 'acme', 'vend1');
    expect(ok.status).toBe(200);
    expect((await call(c.app, 'GET', '/api/auth/me', ok.cookie)).body.user.role).toBe('SELLER');
    const bad = await login(c.app, 'acme', 'vend1', 'errada123');
    const noUser = await login(c.app, 'acme', 'fantasma', 'errada123');
    const noCompany = await login(c.app, 'naoexiste', 'vend1', 'errada123');
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe(noUser.body.error.message);
    expect(bad.body.error.message).toBe(noCompany.body.error.message);
    for (let i = 0; i < 5; i++) await login(c.app, 'acme', 'vend2', 'errada123');
    const locked = await login(c.app, 'acme', 'vend2'); // conta bloqueada mesmo com a senha certa
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    void w;
  });

  it('3. vendedor não acessa rotas administrativas nem dados de outros', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    for (const url of ['/api/admin/dashboard', '/api/admin/users', '/api/admin/sales', '/api/admin/events', `/api/admin/events/${w.eventId}/products`, '/api/admin/movements', '/api/admin/settings']) {
      expect((await call(c.app, 'GET', url, s)).status).toBe(403);
    }
    expect((await call(c.app, 'POST', `/api/admin/products/${w.a}/stock/entry`, s, { quantity: 5 })).status).toBe(403);
    expect((await call(c.app, 'POST', '/api/admin/users', s, {})).status).toBe(403);
    // lista do PDV não vaza custo nem estoque físico
    const prods = await call(c.app, 'GET', '/api/pdv/products', s);
    expect(prods.status).toBe(200);
    expect(prods.body.products[0]).not.toHaveProperty('costCents');
    expect(prods.body.products[0]).not.toHaveProperty('physicalQty');
    // sem sessão
    expect((await call(c.app, 'GET', '/api/pdv/products', '')).status).toBe(401);
  });

  it('4. isolamento entre empresas (IDs de outra empresa → 404)', async () => {
    const a = await world(c, { slug: 'acme' });
    const bId = await seedCompany(c.pool, 'beta');
    const bEvent = await seedEvent(c.pool, bId);
    await seedUser(c.pool, bId, 'admin', 'COMPANY_ADMIN');
    const bSeller = await seedUser(c.pool, bId, 'vend1', 'SELLER');
    const bProd = await seedProduct(c.pool, bId, bEvent, 'Z9', 500, 10);
    const bAdmin = (await login(c.app, 'beta', 'admin')).cookie;
    const bSellerCookie = (await login(c.app, 'beta', 'vend1')).cookie;
    // venda real na empresa B
    await call(c.app, 'POST', '/api/pdv/cart/items', bSellerCookie, { productId: bProd, delta: 1 });
    const sale = await call(c.app, 'POST', '/api/pdv/cart/checkout', bSellerCookie, { idempotencyKey: 'chave-beta-0001', expectedTotalCents: 500, payment: { method: 'PIX', confirmed: true } });
    expect(sale.status).toBe(201);
    const saleId = sale.body.sale.id;

    // admin da empresa A tenta alcançar tudo da B
    expect((await call(c.app, 'GET', `/api/admin/events/${bEvent}/products`, a.admin)).status).toBe(404);
    expect((await call(c.app, 'POST', `/api/admin/events/${bEvent}/products`, a.admin, { name: 'X', internalCode: 'X', priceCents: 100 })).status).toBe(404);
    expect((await call(c.app, 'PATCH', `/api/admin/products/${bProd}`, a.admin, { priceCents: 1 })).status).toBe(404);
    expect((await call(c.app, 'POST', `/api/admin/products/${bProd}/stock/entry`, a.admin, { quantity: 5 })).status).toBe(404);
    expect((await call(c.app, 'PATCH', `/api/admin/events/${bEvent}`, a.admin, { name: 'hack' })).status).toBe(404);
    expect((await call(c.app, 'GET', `/api/admin/sales/${saleId}`, a.admin)).status).toBe(404);
    expect((await call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, a.admin, { confirm: true, reason: 'tentativa' })).status).toBe(404);
    expect((await call(c.app, 'PATCH', `/api/admin/users/${bSeller}`, a.admin, { active: false })).status).toBe(404);
    expect((await call(c.app, 'POST', `/api/admin/users/${bSeller}/reset-password`, a.admin, { password: 'Hackeada123' })).status).toBe(404);
    // listagens nunca misturam
    const users = await call(c.app, 'GET', '/api/admin/users', a.admin);
    expect(users.body.users.every((u: { login: string }) => u.login === 'admin' || u.login.startsWith('vend'))).toBe(true);
    expect(users.body.users).toHaveLength(3);
    const sales = await call(c.app, 'GET', '/api/admin/sales', a.admin);
    expect(sales.body.total).toBe(0);
    // vendedor da A não adiciona produto da B ao carrinho
    expect((await call(c.app, 'POST', '/api/pdv/cart/items', a.sellers[0]!.cookie, { productId: bProd, delta: 1 })).status).toBe(404);
    // a venda da B continua intacta
    expect((await call(c.app, 'GET', `/api/admin/sales/${saleId}`, bAdmin)).body.status).toBe('COMPLETED');
    // login só dentro da própria empresa
    expect((await login(c.app, 'acme', 'vend1')).status).toBe(200);
    expect(PW).toBeTruthy();
  });

  it('empresa inativa não entra e sessões existentes caem', async () => {
    const w = await world(c);
    await c.pool.query(`UPDATE companies SET status = 'INACTIVE' WHERE id = $1`, [w.companyId]);
    expect((await call(c.app, 'GET', '/api/auth/me', w.admin)).status).toBe(401);
    expect((await login(c.app, 'acme', 'admin')).status).toBe(401);
  });
});
