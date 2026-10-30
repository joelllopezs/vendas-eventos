import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkout } from '../src/services/sales.js';
import { reconcileStock } from '../src/services/stock.js';
import { companyAuthFor } from './auth-for.js';
import { call, resetDb, startCtx, stopCtx, stockOf, world, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => { c = await startCtx(); });
afterAll(async () => { await stopCtx(c); });
beforeEach(async () => { await resetDb(c.pool); });

const pay = (ck: string, key: string, total: number, payment: object) =>
  call(c.app, 'POST', '/api/pdv/cart/checkout', ck, { idempotencyKey: key, expectedTotalCents: total, payment });

describe('finalização de venda', () => {
  it('10. baixa o estoque físico, consome a reserva, grava venda/itens/pagamento/movimentação', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 3 }); // 3 x 10,00
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 2 }); // 2 x  5,50
    const r = await pay(s, 'venda-chave-0001', 4100, { method: 'PIX', confirmed: true });
    expect(r.status).toBe(201);
    expect(r.body.sale).toMatchObject({ status: 'COMPLETED', totalCents: 4100, itemsCount: 5, method: 'PIX', saleNumber: 1 });
    expect(r.body.sale.items).toHaveLength(2);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 97, reserved: 0 });
    expect(await stockOf(c.pool, w.b)).toEqual({ physical: 48, reserved: 0 });
    const mv = await c.pool.query(`SELECT product_id, type, quantity, balance_before, balance_after, user_id, sale_id FROM stock_movements WHERE type = 'SALE'`);
    expect(mv.rows).toHaveLength(2);
    expect(mv.rows.find((m) => m.product_id === w.a)).toMatchObject({ quantity: -3, balance_before: 100, balance_after: 97, user_id: w.sellers[0]!.id, sale_id: r.body.sale.id });
    expect((await c.pool.query(`SELECT status FROM stock_reservations`)).rows.every((x) => x.status === 'CONSUMED')).toBe(true);
    // carrinho encerrado; próximo carrinho é novo
    expect((await call(c.app, 'GET', '/api/pdv/cart', s)).body.cart).toBeNull();
    // preço histórico: alterar o cadastro não muda a venda anterior
    await call(c.app, 'PATCH', `/api/admin/products/${w.a}`, w.admin, { priceCents: 2500 });
    const detail = await call(c.app, 'GET', `/api/pdv/sales/${r.body.sale.id}`, s);
    expect(detail.body.items.find((i: any) => i.productId === w.a).unitPriceCents).toBe(1000);
    // venda sequencial por evento
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 1 });
    expect((await pay(s, 'venda-chave-0002', 550, { method: 'DEBIT', confirmed: true })).body.sale.saleNumber).toBe(2);
    // vendedor só enxerga as próprias vendas
    expect((await call(c.app, 'GET', '/api/pdv/sales', w.sellers[1]!.cookie)).body.sales).toHaveLength(0);
    expect((await call(c.app, 'GET', `/api/pdv/sales/${r.body.sale.id}`, w.sellers[1]!.cookie)).status).toBe(404);
    // imutabilidade das vendas no banco
    await expect(c.pool.query(`DELETE FROM sales`)).rejects.toThrow(/não podem ser excluídas/);
    await expect(c.pool.query(`UPDATE sales SET total_cents = 1`)).rejects.toThrow();
    await expect(c.pool.query(`UPDATE sale_items SET quantity = 99`)).rejects.toThrow(/imutável/);
  });

  it('recusa preço alterado no carrinho, produto desativado e carrinho vazio', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    expect((await pay(s, 'venda-vazia-0001', 100, { method: 'PIX', confirmed: true })).body.error.code).toBe('CART_EMPTY');
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 1 });
    await call(c.app, 'PATCH', `/api/admin/products/${w.a}`, w.admin, { priceCents: 1200 });
    const r = await pay(s, 'venda-preco-0001', 1000, { method: 'PIX', confirmed: true });
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.totalCents).toBe(1200);
    await call(c.app, 'PATCH', `/api/admin/products/${w.a}`, w.admin, { active: false });
    expect((await pay(s, 'venda-inativo-001', 1200, { method: 'PIX', confirmed: true })).body.error.code).toBe('PRODUCT_INACTIVE');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 1 }); // nada mudou
  });

  it('11. proteção contra venda duplicada (cliques repetidos simultâneos e reenvio depois)', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 2 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => pay(s, 'mesma-chave-001', 2000, { method: 'CASH', receivedCents: 2000 })));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.sale.id)).size).toBe(1);
    expect((await c.pool.query(`SELECT count(*)::int n FROM sales`)).rows[0].n).toBe(1);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 98, reserved: 0 });
    // reenvio tardio (falha de conexão) devolve a mesma venda
    const again = await pay(s, 'mesma-chave-001', 2000, { method: 'CASH', receivedCents: 2000 });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 98, reserved: 0 });
    expect((await c.pool.query(`SELECT count(*)::int n FROM stock_movements WHERE type = 'SALE'`)).rows[0].n).toBe(1);
  });

  it('12. troco calculado em centavos (R$ 37,00 pago com R$ 50,00 → R$ 13,00)', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    // 3 x 10,00 + 1 x 5,50 + ... = 37,00 → 2x10,00 + 3x5,50 = 36,50; usamos 1x10 + 2x... montar 37,00: 2x10,00 + 1x5,50 +... não fecha; ajustar preço do B
    await call(c.app, 'PATCH', `/api/admin/products/${w.b}`, w.admin, { priceCents: 350 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 3 }); // 30,00
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 2 }); //  7,00
    const r = await pay(s, 'troco-chave-0001', 3700, { method: 'CASH', receivedCents: 5000 });
    expect(r.status).toBe(201);
    expect(r.body.sale).toMatchObject({ totalCents: 3700, receivedCents: 5000, changeCents: 1300 });
    // centavos quebrados sem erro de ponto flutuante: 3 x R$ 0,10 = 0,30
    await call(c.app, 'PATCH', `/api/admin/products/${w.b}`, w.admin, { priceCents: 10 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 3 });
    const r2 = await pay(s, 'troco-chave-0002', 30, { method: 'CASH', receivedCents: 100 });
    expect(r2.body.sale.changeCents).toBe(70);
    // valor exato → troco zero
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 1 });
    expect((await pay(s, 'troco-chave-0003', 10, { method: 'CASH', receivedCents: 10 })).body.sale.changeCents).toBe(0);
  });

  it('13. bloqueia dinheiro insuficiente e valores inválidos, sem alterar o estoque', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 2 });
    const r = await pay(s, 'insuf-chave-0001', 2000, { method: 'CASH', receivedCents: 1500 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_PAYMENT', details: { missingCents: 500 } });
    expect((await pay(s, 'insuf-chave-0002', 2000, { method: 'CASH' })).status).toBe(400);
    expect((await pay(s, 'insuf-chave-0003', 2000, { method: 'CASH', receivedCents: -5 })).status).toBe(400);
    expect((await pay(s, 'insuf-chave-0004', 2000, { method: 'CASH', receivedCents: 20.5 })).status).toBe(400);
    expect((await c.pool.query(`SELECT count(*)::int n FROM sales`)).rows[0].n).toBe(0);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 2 }); // reserva segue válida
    // depois do erro o operador corrige e conclui
    expect((await pay(s, 'insuf-chave-0005', 2000, { method: 'CASH', receivedCents: 2000 })).status).toBe(201);
  });

  it('14. PIX, débito e crédito: só registro manual; exige confirmação do operador', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    for (const [i, method] of (['PIX', 'DEBIT', 'CREDIT'] as const).entries()) {
      await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 1 });
      const sem = await pay(s, `manual-sem-conf-${i}`, 1000, { method });
      expect(sem.body.error.code).toBe('PAYMENT_NOT_CONFIRMED');
      const ok = await pay(s, `manual-confirm-${i}`, 1000, { method, confirmed: true });
      expect(ok.status).toBe(201);
      expect(ok.body.sale).toMatchObject({ method, receivedCents: null, changeCents: null });
    }
    const p = await c.pool.query(`SELECT method, manual_confirmation FROM payments ORDER BY created_at`);
    expect(p.rows).toEqual([{ method: 'PIX', manual_confirmation: true }, { method: 'DEBIT', manual_confirmation: true }, { method: 'CREDIT', manual_confirmation: true }]);
    // não existe integração: nenhuma tabela/coluna de gateway, e método desconhecido é recusado
    expect((await pay(s, 'metodo-invalido-1', 1000, { method: 'BOLETO', confirmed: true })).status).toBe(400);
  });
});

describe('cancelamento', () => {
  async function sold(opts: { policy?: string } = {}) {
    const w = await world(c, { cancelPolicy: opts.policy });
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 4 });
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.b, delta: 2 });
    const r = await pay(s, 'canc-venda-0001', 5100, { method: 'CASH', receivedCents: 6000 });
    return { w, s, saleId: r.body.sale.id as string };
  }

  it('15. cancelar devolve ao estoque do evento, preserva a venda e registra quem/quando/motivo', async () => {
    const { w, saleId } = await sold();
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 96, reserved: 0 });
    // exige confirmação e motivo
    expect((await call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, w.admin, { reason: 'Erro' })).status).toBe(400);
    expect((await call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, w.admin, { confirm: true, reason: '' })).status).toBe(400);
    const r = await call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, w.admin, { confirm: true, reason: 'Cliente desistiu', cashRefundCents: 5100 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cliente desistiu', cancelledByName: 'User admin', cashRefundCents: 5100, requiresExternalRefund: false });
    expect(r.body.cancelledAt).toBeTruthy();
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    expect(await stockOf(c.pool, w.b)).toEqual({ physical: 50, reserved: 0 });
    const mv = await c.pool.query(`SELECT quantity, balance_before, balance_after FROM stock_movements WHERE type = 'SALE_CANCEL_RETURN' AND product_id = $1`, [w.a]);
    expect(mv.rows).toEqual([{ quantity: 4, balance_before: 96, balance_after: 100 }]);
    // venda e itens permanecem
    expect((await c.pool.query(`SELECT count(*)::int n FROM sale_items`)).rows[0].n).toBe(2);
    expect((await call(c.app, 'GET', `/api/admin/sales/${saleId}`, w.admin)).body.items).toHaveLength(2);
  });

  it('cancelar venda por PIX/cartão não alega estorno: marca estorno externo obrigatório', async () => {
    const w = await world(c);
    const s = w.sellers[0]!.cookie;
    await call(c.app, 'POST', '/api/pdv/cart/items', s, { productId: w.a, delta: 1 });
    const sale = await pay(s, 'canc-pix-0000001', 1000, { method: 'PIX', confirmed: true });
    const r = await call(c.app, 'POST', `/api/admin/sales/${sale.body.sale.id}/cancel`, w.admin, { confirm: true, reason: 'Pagamento não caiu' });
    expect(r.body).toMatchObject({ status: 'CANCELLED', requiresExternalRefund: true, cashRefundCents: null });
  });

  it('16. cancelamento duplicado (inclusive simultâneo) não devolve ao estoque duas vezes', async () => {
    const { w, saleId } = await sold();
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, w.admin, { confirm: true, reason: 'Cancelamento duplo' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_CANCELLED')).toBe(true);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    const again = await call(c.app, 'POST', `/api/admin/sales/${saleId}/cancel`, w.admin, { confirm: true, reason: 'De novo' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/já foi cancelada/);
    expect((await c.pool.query(`SELECT count(*)::int n FROM stock_movements WHERE type = 'SALE_CANCEL_RETURN'`)).rows[0].n).toBe(2);
    expect((await c.pool.query(`SELECT count(*)::int n FROM sale_cancellations`)).rows[0].n).toBe(1);
  });

  it('política da empresa: ADMIN_ONLY, SELLER_REQUEST e SELLER_OWN', async () => {
    // ADMIN_ONLY: vendedor não cancela nem solicita
    let { w, s, saleId } = await sold();
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel`, s, { confirm: true, reason: 'quero cancelar' })).status).toBe(403);
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel-request`, s, { reason: 'quero cancelar' })).status).toBe(403);
    // SELLER_REQUEST: solicita; admin aprova; vendedor não cancela direto
    await resetDb(c.pool);
    ({ w, s, saleId } = await sold({ policy: 'SELLER_REQUEST' }));
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel`, s, { confirm: true, reason: 'direto' })).status).toBe(403);
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel-request`, s, { reason: 'Cliente desistiu' })).status).toBe(200);
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel-request`, s, { reason: 'Cliente desistiu' })).status).toBe(409);
    const list = await call(c.app, 'GET', '/api/admin/cancellation-requests', w.admin);
    expect(list.body.requests).toHaveLength(1);
    const ap = await call(c.app, 'POST', `/api/admin/cancellation-requests/${list.body.requests[0].id}/approve`, w.admin, { confirm: true });
    expect(ap.body.status).toBe('CANCELLED');
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 0 });
    expect((await call(c.app, 'GET', '/api/admin/cancellation-requests', w.admin)).body.requests).toHaveLength(0);
    // SELLER_OWN: cancela só a própria venda
    await resetDb(c.pool);
    ({ w, s, saleId } = await sold({ policy: 'SELLER_OWN' }));
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel`, w.sellers[1]!.cookie, { confirm: true, reason: 'de outro vendedor' })).status).toBe(404);
    expect((await call(c.app, 'POST', `/api/pdv/sales/${saleId}/cancel`, s, { confirm: true, reason: 'minha venda' })).body.status).toBe('CANCELLED');
  });
});

describe('relatórios e recuperação', () => {
  it('17. dashboard reflete vendas e cancelamentos (bruto, cancelado, líquido, ticket, por operador/forma)', async () => {
    const w = await world(c);
    const [s1, s2] = w.sellers;
    const mk = async (ck: string, key: string, pid: string, qty: number, total: number, payment: object) => {
      await call(c.app, 'POST', '/api/pdv/cart/items', ck, { productId: pid, delta: qty });
      return (await pay(ck, key, total, payment)).body.sale.id as string;
    };
    await mk(s1!.cookie, 'rel-venda-000001', w.a, 3, 3000, { method: 'CASH', receivedCents: 5000 }); // 30,00
    const v2 = await mk(s1!.cookie, 'rel-venda-000002', w.b, 2, 1100, { method: 'PIX', confirmed: true }); // 11,00
    await mk(s2!.cookie, 'rel-venda-000003', w.a, 1, 1000, { method: 'CREDIT', confirmed: true }); // 10,00
    // carrinho aberto/reserva NÃO conta como venda
    await call(c.app, 'POST', '/api/pdv/cart/items', s2!.cookie, { productId: w.a, delta: 5 });
    let d = (await call(c.app, 'GET', '/api/admin/dashboard', w.admin)).body;
    expect(d).toMatchObject({ completedCount: 3, cancelledCount: 0, grossCents: 5100, cancelledCents: 0, netCents: 5100, averageTicketCents: 1700 });
    await call(c.app, 'POST', `/api/admin/sales/${v2}/cancel`, w.admin, { confirm: true, reason: 'Erro de digitação' });
    d = (await call(c.app, 'GET', '/api/admin/dashboard', w.admin)).body;
    expect(d).toMatchObject({ completedCount: 2, cancelledCount: 1, grossCents: 5100, cancelledCents: 1100, netCents: 4000, averageTicketCents: 2000 });
    expect(d.byOperator.find((o: any) => o.operatorName === 'User vend1')).toMatchObject({ completedCount: 1, grossCents: 4100, cancelledCents: 1100, netCents: 3000 });
    expect(d.byMethod.find((m: any) => m.method === 'PIX')).toMatchObject({ completedCount: 0, grossCents: 1100, cancelledCents: 1100, netCents: 0 });
    expect(d.topProducts[0]).toMatchObject({ name: 'Produto A1', quantity: 4 }); // só vendas concluídas
    expect(d.availableProducts).toBe(2);
    // filtros
    const byOp = (await call(c.app, 'GET', `/api/admin/dashboard?operatorId=${s2!.id}`, w.admin)).body;
    expect(byOp).toMatchObject({ completedCount: 1, netCents: 1000 });
    const byMethod = (await call(c.app, 'GET', '/api/admin/dashboard?method=CASH', w.admin)).body;
    expect(byMethod.netCents).toBe(3000);
    const byProduct = (await call(c.app, 'GET', `/api/admin/dashboard?productId=${w.b}`, w.admin)).body;
    expect(byProduct).toMatchObject({ grossCents: 1100, cancelledCents: 1100, netCents: 0 });
    const cancelledOnly = await call(c.app, 'GET', '/api/admin/sales?status=CANCELLED', w.admin);
    expect(cancelledOnly.body.total).toBe(1);
    const future = (await call(c.app, 'GET', `/api/admin/dashboard?from=${encodeURIComponent('2999-01-01T00:00:00Z')}`, w.admin)).body;
    expect(future.grossCents).toBe(0);
    // estoque baixo
    await c.pool.query(`UPDATE products SET min_stock = 100 WHERE id = $1`, [w.b]);
    expect((await call(c.app, 'GET', '/api/admin/dashboard', w.admin)).body.lowStock.map((p: any) => p.name)).toContain('Produto B1');
    // vendedor não vê relatórios
    expect((await call(c.app, 'GET', '/api/admin/dashboard', s1!.cookie)).status).toBe(403);
  });

  it('18a. falha no meio da finalização reverte tudo (sem venda incompleta nem estoque inconsistente)', async () => {
    const w = await world(c);
    const s = w.sellers[0]!;
    await call(c.app, 'POST', '/api/pdv/cart/items', s.cookie, { productId: w.a, delta: 5 });
    const auth = companyAuthFor({ userId: s.id, companyId: w.companyId });
    await expect(
      checkout(c.pool, auth, { idempotencyKey: 'falha-injetada-01', expectedTotalCents: 5000, payment: { method: 'PIX', confirmed: true } }, {
        afterStockUpdate: () => { throw new Error('queda simulada'); },
      }),
    ).rejects.toThrow('queda simulada');
    for (const t of ['sales', 'sale_items', 'payments']) expect((await c.pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n).toBe(0);
    expect((await c.pool.query(`SELECT count(*)::int n FROM stock_movements WHERE type = 'SALE'`)).rows[0].n).toBe(0);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 5 });
    expect((await c.pool.query(`SELECT status FROM stock_reservations`)).rows).toEqual([{ status: 'ACTIVE' }]);
    expect((await c.pool.query(`SELECT next_sale_number n FROM events WHERE id = $1`, [w.eventId])).rows[0].n).toBe(1);
    // o operador pode tentar de novo e funciona
    expect((await pay(s.cookie, 'falha-injetada-02', 5000, { method: 'PIX', confirmed: true })).status).toBe(201);
  });

  it('18b. reconciliação corrige contador de reservas e reservas órfãs', async () => {
    const w = await world(c);
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[0]!.cookie, { productId: w.a, delta: 4 });
    // corrupção: contador errado + reserva ativa de um carrinho já encerrado
    await c.pool.query(`UPDATE stock SET reserved_qty = 9 WHERE product_id = $1`, [w.a]);
    await call(c.app, 'POST', '/api/pdv/cart/items', w.sellers[1]!.cookie, { productId: w.b, delta: 3 });
    await c.pool.query(`UPDATE carts SET status = 'EXPIRED', closed_at = now() WHERE user_id = $1`, [w.sellers[1]!.id]); // reserva ficou ativa por engano
    const dry = await reconcileStock(c.pool, { fix: false });
    expect(dry.mismatches.length).toBeGreaterThan(0);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 9 }); // dry-run não altera
    const fixed = await reconcileStock(c.pool, { fix: true });
    expect(fixed.orphanReservations).toBe(1);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 4 });
    expect(await stockOf(c.pool, w.b)).toEqual({ physical: 50, reserved: 0 });
    expect((await reconcileStock(c.pool, { fix: false })).mismatches).toHaveLength(0);
    // via API do admin
    await c.pool.query(`UPDATE stock SET reserved_qty = 2 WHERE product_id = $1`, [w.a]);
    const api = await call(c.app, 'POST', '/api/admin/maintenance/reconcile-stock', w.admin);
    expect(api.body.mismatches).toHaveLength(1);
    expect(await stockOf(c.pool, w.a)).toEqual({ physical: 100, reserved: 4 });
  });

  it('18c. o banco recusa estoque negativo / reservado acima do físico mesmo com bug no código', async () => {
    const w = await world(c);
    await expect(c.pool.query(`UPDATE stock SET physical_qty = -1 WHERE product_id = $1`, [w.a])).rejects.toThrow(/stock_non_negative|check/i);
    await expect(c.pool.query(`UPDATE stock SET reserved_qty = 101 WHERE product_id = $1`, [w.a])).rejects.toThrow(/reserved_le_physical|check/i);
    // FK composta: não dá para ligar produto de uma empresa a evento de outra
    const other = await c.pool.query<{ id: string }>(`INSERT INTO companies (slug, trade_name, contact_email, phone) VALUES ('outra','Outra','a@b.c','1234567890') RETURNING id`);
    await expect(
      c.pool.query(`INSERT INTO products (company_id, event_id, internal_code, name, price_cents) VALUES ($1,$2,'X','X',100)`, [other.rows[0]!.id, w.eventId]),
    ).rejects.toThrow(/foreign key/i);
  });
});
