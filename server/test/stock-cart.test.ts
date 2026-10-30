import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { companyAuthFor } from './auth-for.js';
import { expireDueCarts } from '../src/services/cart.js';
import { call, resetDb, seedProduct, startCtx, stopCtx, stockOf, login, seedUser, world, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => { c = await startCtx(); });
afterAll(async () => { await stopCtx(c); });
beforeEach(async () => { await resetDb(c.pool); });

describe('produtos e estoque', () => {
  it('5. admin cadastra produto com estoque inicial, entrada e ajuste (histórico preservado)', async () => {
    const w = await world(c);
    const created = await call(c.app, 'POST', `/api/admin/events/${w.eventId}/products`, w.admin, {
      name: 'Cerveja Lata', internalCode: 'CERV', barcode: '789000', category: 'Bebidas', priceCents: 800, costCents: 350, minStock: 10, initialQty: 40,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(await stockOf(c.pool, id)).toEqual({ physical: 40, reserved: 0 });
    // código duplicado no mesmo evento
    const dup = await call(c.app, 'POST', `/api/admin/events/${w.eventId}/products`, w.admin, { name: 'Outra', internalCode: 'CERV', priceCents: 100 });
    expect(dup.status).toBe(409);
    // preço zero/negativo é inválido
    expect((await call(c.app, 'POST', `/api/admin/events/${w.eventId}/products`, w.admin, { name: 'Z', internalCode: 'Z', priceCents: 0 })).status).toBe(400);
    expect((await call(c.app, 'POST', `/api/admin/products/${id}/stock/entry`, w.admin, { quantity: 10, reason: 'Reposição' })).body.physicalQty).toBe(50);
    // ajuste exige justificativa
    expect((await call(c.app, 'POST', `/api/admin/products/${id}/stock/adjust`, w.admin, { newPhysicalQty: 45, reason: '' })).status).toBe(400);
    expect((await call(c.app, 'POST', `/api/admin/products/${id}/stock/adjust`, w.admin, { newPhysicalQty: 45, reason: 'Quebra de 5 latas' })).body.physicalQty).toBe(45);
    const mv = await call(c.app, 'GET', `/api/admin/movements?productId=${id}`, w.admin);
    expect(mv.body.rows.map((m: any) => [m.type, m.quantity, m.balanceBefore, m.balanceAfter])).toEqual([
      ['ADJUSTMENT', -5, 50, 45], ['ENTRY', 10, 40, 50], ['INITIAL', 40, 0, 40],
    ]);
    // histórico é imutável no banco
    await expect(c.pool.query(`DELETE FROM stock_movements`)).rejects.toThrow(/imutável/);
    await expect(c.pool.query(`UPDATE stock_movements SET quantity = 99`)).rejects.toThrow(/imutável/);
    // preço de custo só aparece para o admin
    const list = await call(c.app, 'GET', `/api/admin/events/${w.eventId}/products?q=cerv`, w.admin);
    expect(list.body.products[0]).toMatchObject({ costCents: 350, availableQty: 45 });
    // produto inativo não aparece/vende no PDV
    await call(c.app, 'PATCH', `/api/admin/products/${id}`, w.admin, { active: false });
    const pdv = await call(c.app, 'GET', '/api/pdv/products?q=cerv', w.sellers[0]!.cookie);
    expect(pdv.body.products).toHaveLength(0);
    expect((await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[0]!.cookie, { productId: id, delta: 1 })).body.error.code).toBe('PRODUCT_INACTIVE');
  });
});

describe('carrinho e reservas', () => {
  it('6. adicionar ao carrinho reserva sem baixar o estoque físico; só a diferença ao aumentar', async () => {
    const w = await world(c, { qtyA: 100 });
    const s = w.sellers[0]!.cookie;
    const r1 = await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 5 });
    expect(r1.status).toBe(200);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 5 });
    const avail = await call(c.app, 'GET', '/api/pdv/products', w.sellers[1]!.cookie);
    expect(avail.body.products.find((p: any) => p.id === w.a).availableQty).toBe(95);
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 3 });
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 8 });
    const cart = await call(c.app, 'GET', '/api/pdv/cart', s);
    expect(cart.body.cart.items[0].quantity).toBe(8);
    expect(cart.body.cart.totalCents).toBe(8000);
    // reservas ativas e contador coerentes
    const res = await c.pool.query(`SELECT quantity FROM stock_reservations WHERE status = 'ACTIVE'`);
    expect(res.rows).toEqual([{ quantity: 8 }]);
    // outro operador não pode reservar o que está reservado
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[1]!.cookie, { productId: w.a, delta: 92 });
    const over = await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[1]!.cookie, { productId: w.a, delta: 1 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 100 });
  });

  it('7. diminuir, remover e limpar liberam a reserva imediatamente', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 10 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 4 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: -3 });
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 7 });
    expect((await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: -50 })).status).toBe(400);
    await call(c.app, 'DELETE', `/api/pdv/cart/items/${w.b}`, s);
    expect(await stockOf(c.pool, w.b)).toEqual({ physical: 50, reserved: 0 });
    const cleared = await call(c.app, 'DELETE', '/api/pdv/cart', s);
    expect(cleared.body.cart).toBeNull();
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    expect((await c.pool.query(`SELECT count(*)::int n FROM stock_reservations WHERE status = 'ACTIVE'`)).rows[0].n).toBe(0);
  });

  it('8. reservas abandonadas expiram no servidor (job) e no acesso (lazy), com aviso único', async () => {
    const w = await world(c);
    const [s1, s2] = w.sellers;
    await call(c.app, 'POST', '/api/pdv/cart/items', s1!.cookie, { productId: w.a, delta: 6 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s2!.cookie, { productId: w.b, delta: 2 });
    // simula navegador fechado: prazo vencido, ninguém chama a API
    await c.pool.query(`UPDATE carts SET expires_at = now() - interval '1 minute'`);
    expect(await expireDueCarts(c.pool)).toBe(2);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    expect(await stockOf(c.pool, w.b)).toEqual({ physical: 50, reserved: 0 });
    // operador é avisado uma única vez
    const first = await call(c.app, 'GET', '/api/pdv/cart', s1!.cookie);
    expect(first.body.cart).toBeNull();
    expect(first.body.notice).toMatchObject({ type: 'CART_EXPIRED', items: [{ quantity: 6 }] });
    expect((await call(c.app, 'GET', '/api/pdv/cart', s1!.cookie)).body.notice).toBeNull();
    // lazy: mesmo sem o job, o acesso expira
    await call(c.app, 'POST', '/api/pdv/cart/items', s1!.cookie, { productId: w.a, delta: 4 });
    await c.pool.query(`UPDATE carts SET expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'`);
    const lazy = await call(c.app, 'GET', '/api/pdv/cart', s1!.cookie);
    expect(lazy.body.cart).toBeNull();
    expect(lazy.body.notice.type).toBe('CART_EXPIRED');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    // finalizar com reserva vencida é recusado e libera
    await call(c.app, 'POST', '/api/pdv/cart/items', s1!.cookie, { productId: w.a, delta: 1 });
    await c.pool.query(`UPDATE carts SET expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'`);
    const co = await call(c.app, 'POST', '/api/pdv/cart/checkout', s1!.cookie, { idempotencyKey: 'chave-expirada-1', expectedTotalCents: 1000, payment: { method: 'PIX', confirmed: true } });
    expect(co.body.error.code).toBe('CART_EXPIRED');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
  });

  it('renova o prazo a cada atividade, respeitando o limite máximo do carrinho', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 1 });
    await c.pool.query(`UPDATE carts SET expires_at = now() + interval '10 seconds' WHERE status = 'ACTIVE'`);
    const t = await call(c.app, 'POST', '/api/pdv/cart/touch', s);
    expect(new Date(t.body.cart.expiresAt).getTime() - new Date(t.body.serverTime).getTime()).toBeGreaterThan(280_000);
    await c.pool.query(`UPDATE carts SET created_at = now() - interval '59 minutes 30 seconds' WHERE status = 'ACTIVE'`);
    const t2 = await call(c.app, 'POST', '/api/pdv/cart/touch', s);
    expect(new Date(t2.body.cart.expiresAt).getTime() - new Date(t2.body.serverTime).getTime()).toBeLessThan(31_000);
  });

  it('9. dois operadores disputando as últimas unidades: só a disponibilidade real é aceita', async () => {
    const w = await world(c, { sellers: 2, qtyA: 1 });
    const [r1, r2] = await Promise.all(w.sellers.map((s) => call(c.app, 'POST', '/api/pdv/cart/items', s.cookie, { productId: w.a, delta: 1 })));
    expect([r1!.status, r2!.status].sort()).toEqual([200, 409]);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 1, reserved: 1 });
  });

  it('9b. estresse: 25 operadores x 5 unidades — exatamente 5 reservas, nunca negativo/oversell', async () => {
    const w = await world(c, { sellers: 0, qtyA: 5 });
    const sellers: string[] = [];
    for (let i = 0; i < 25; i++) {
      await seedUser(c.pool, w.companyId, `bulk${i}`, 'SELLER');
      sellers.push((await login(c.app, 'acme', `bulk${i}`)).cookie);
    }
    const results = await Promise.all(sellers.map((ck) => call(c.app, 'POST', '/api/pdv/cart/items', ck, { productId: w.a, delta: 1 })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(20);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 5, reserved: 5 });
    // e todos finalizam as 5 vendas ao mesmo tempo, sem estoque negativo
    const winners = results.map((r, i) => (r.status === 200 ? sellers[i]! : null)).filter(Boolean) as string[];
    const sales = await Promise.all(winners.map((ck, i) => call(c.app, 'POST', '/api/pdv/cart/checkout', ck, { idempotencyKey: `bulk-chave-${i}`, expectedTotalCents: 1000, payment: { method: 'CASH', receivedCents: 1000 } })));
    expect(sales.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 0, reserved: 0 });
    void companyAuthFor; void seedProduct;
  });

  it('expiração sob demanda (sem job): reserva vencida de outro operador libera estoque na hora', async () => {
    const w = await world(c, { qtyA: 3 });
    const [s1, s2] = w.sellers;
    await call(c.app, 'POST', '/api/pdv/cart/items', s1!.cookie, { productId: w.a, delta: 3 });
    await c.pool.query(`UPDATE carts SET expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'`);
    // listagem do PDV já mostra a quantidade liberada, sem rodar o job
    const list = await call(c.app, 'GET', '/api/pdv/products', s2!.cookie);
    expect(list.body.products.find((p: any) => p.id === w.a).availableQty).toBe(3);
    // e reservar após vencimento funciona mesmo quando o contador ainda estava cheio
    await call(c.app, 'POST', '/api/pdv/cart/items', s2!.cookie, { productId: w.a, delta: 3 });
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 3, reserved: 3 });
    await call(c.app, 'DELETE', '/api/pdv/cart', s2!.cookie);
    await call(c.app, 'POST', '/api/pdv/cart/items', s1!.cookie, { productId: w.a, delta: 3 });
    await c.pool.query(`UPDATE carts SET expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'`);
    const r = await call(c.app, 'POST', '/api/pdv/cart/items', s2!.cookie, { productId: w.a, delta: 2 }); // sem listar antes
    expect(r.status).toBe(200);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 3, reserved: 2 });
  });

  it('não permite reduzir o estoque físico abaixo do reservado', async () => {
    const w = await world(c);
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[0]!.cookie, { productId: w.a, delta: 30 });
    const r = await call(c.app, 'POST', `/api/admin/products/${w.a}/stock/adjust`, w.admin, { newPhysicalQty: 20, reason: 'Contagem' });
    expect(r.body.error.code).toBe('BELOW_RESERVED');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 30 });
  });

  it('encerrar o evento libera os carrinhos abertos; desativar usuário também', async () => {
    const w = await world(c);
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[0]!.cookie, { productId: w.a, delta: 3 });
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[1]!.cookie, { productId: w.a, delta: 2 });
    await call(c.app, 'PATCH', `/api/admin/users/${w.sellers[1]!.id}`, w.admin, { active: false });
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 3 });
    expect((await call(c.app, 'GET', '/api/pdv/cart', w.sellers[1]!.cookie)).status).toBe(401);
    await call(c.app, 'PATCH', `/api/admin/events/${w.eventId}`, w.admin, { status: 'ENDED' });
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    expect((await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[0]!.cookie, { productId: w.a, delta: 1 })).body.error.code).toBe('NO_ACTIVE_EVENT');
  });
});
