import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Me } from '../auth';
import { SaleDetail, StatusBadge } from '../components/SaleViews';
import { Badge, Button, cx, ErrorBox, Input, Loading, Modal, Spinner, useToast } from '../components/ui';
import { ApiError, del, get, post } from '../lib/api';
import { brl, dt, METHOD, newKey, parseMoney } from '../lib/format';

interface Product { id: string; name: string; code: string; barcode: string | null; category: string | null; priceCents: number; availableQty: number }
interface CartItem { productId: string; name: string; code: string; unitPriceCents: number; quantity: number; subtotalCents: number; active: boolean }
interface CartView { cart: null | { id: string; expiresAt: string; items: CartItem[]; totalCents: number; itemsCount: number }; serverTime: string; notice: null | { type: string; items: { name: string; quantity: number }[] } }

export default function Pdv({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ctx = useQuery({ queryKey: ['pdv-context'], queryFn: () => get('/pdv/context'), refetchInterval: 30_000 });
  const products = useQuery({ queryKey: ['pdv-products'], queryFn: () => get<{ products: Product[]; categories: string[] }>('/pdv/products'), refetchInterval: 5_000, enabled: !!ctx.data?.event });
  const cartQ = useQuery({ queryKey: ['pdv-cart'], queryFn: () => get<CartView>('/pdv/cart'), refetchInterval: 15_000, enabled: !!ctx.data?.event });

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [payTotal, setPayTotal] = useState<number | null>(null); // total capturado ao abrir o pagamento (o modal sobrevive à limpeza do carrinho)
  const [salesOpen, setSalesOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false); // gaveta do carrinho em telas pequenas
  const [notice, setNotice] = useState<CartView['notice']>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const cart = cartQ.data?.cart ?? null;
  const items = cart?.items ?? [];
  const qtyIn = useMemo(() => new Map(items.map((i) => [i.productId, i.quantity])), [items]);

  // aviso de expiração (entregue uma vez pelo servidor)
  useEffect(() => { if (cartQ.data?.notice) setNotice(cartQ.data.notice); }, [cartQ.data?.notice]);

  // ---- fila: alterações do carrinho são enviadas uma por vez, na ordem dos cliques
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(fn: () => Promise<T>) => {
    const p = queue.current.then(fn, fn);
    queue.current = p.catch(() => {});
    return p;
  }, []);

  const apply = (v: CartView) => { qc.setQueryData(['pdv-cart'], v); };
  const refreshAll = () => { qc.invalidateQueries({ queryKey: ['pdv-products'] }); qc.invalidateQueries({ queryKey: ['pdv-cart'] }); };

  const change = useCallback((p: { id: string; name: string }, delta: number) => {
    setBusyIds((s) => new Set(s).add(p.id));
    return enqueue(() => post<CartView>('/pdv/cart/items', { productId: p.id, delta }))
      .then(apply)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') toast('err', `Estoque insuficiente de "${p.name}". Disponível agora: ${e.details?.available ?? 0}.`);
        else toast('err', e instanceof ApiError ? e.message : 'Erro ao atualizar o carrinho.');
        refreshAll();
      })
      .finally(() => { qc.invalidateQueries({ queryKey: ['pdv-products'] }); setBusyIds((s) => { const n = new Set(s); n.delete(p.id); return n; }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enqueue]);

  const remove = (i: CartItem) => {
    setBusyIds((s) => new Set(s).add(i.productId));
    enqueue(() => del<CartView>(`/pdv/cart/items/${i.productId}`)).then(apply).catch((e) => toast('err', e.message)).finally(() => { qc.invalidateQueries({ queryKey: ['pdv-products'] }); setBusyIds((s) => { const n = new Set(s); n.delete(i.productId); return n; }); });
  };
  const [clearing, setClearing] = useState(false);
  const clear = () => { setClearing(true); enqueue(() => del<CartView>('/pdv/cart')).then(apply).catch((e) => toast('err', e.message)).finally(() => { setClearing(false); qc.invalidateQueries({ queryKey: ['pdv-products'] }); searchRef.current?.focus(); }); };

  // ---- relógio da reserva (usa o horário do servidor) e renovação por atividade real
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const offsetRef = useRef(0);
  useEffect(() => { if (cartQ.data) offsetRef.current = Date.now() - new Date(cartQ.data.serverTime).getTime(); }, [cartQ.data]);
  const remaining = cart ? Math.floor((new Date(cart.expiresAt).getTime() - (now - offsetRef.current)) / 1000) : null;
  const expiredPing = useRef(false);
  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !expiredPing.current) { expiredPing.current = true; qc.invalidateQueries({ queryKey: ['pdv-cart'] }); qc.invalidateQueries({ queryKey: ['pdv-products'] }); }
    if (remaining === null || remaining > 0) expiredPing.current = false;
  }, [remaining, qc]);
  const lastTouch = useRef(0);
  useEffect(() => {
    if (!cart) return;
    const touch = () => {
      if (Date.now() - lastTouch.current < 30_000) return;
      lastTouch.current = Date.now();
      post<CartView>('/pdv/cart/touch').then(apply).catch(() => {});
    };
    window.addEventListener('pointerdown', touch); window.addEventListener('keydown', touch);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!cart]);

  // ---- busca / leitor de código de barras
  const list = products.data?.products ?? [];
  const filtered = useMemo(() => {
    const t = search.trim().toLowerCase();
    return list.filter((p) => (!category || p.category === category) && (!t || p.name.toLowerCase().includes(t) || p.code.toLowerCase().includes(t) || (p.barcode ?? '') === search.trim()));
  }, [list, search, category]);

  function onSearchEnter() {
    const t = search.trim().toLowerCase();
    if (!t) return;
    const exact = list.find((p) => (p.barcode && p.barcode === search.trim()) || p.code.toLowerCase() === t);
    const target = exact ?? (filtered.length === 1 ? filtered[0] : undefined);
    if (!target) return toast('err', 'Produto não encontrado.');
    if (target.availableQty <= 0) return toast('err', `"${target.name}" sem estoque disponível.`);
    change(target, 1);
    setSearch('');
  }

  const total = cart?.totalCents ?? 0;
  const hasInactive = items.some((i) => !i.active);

  if (ctx.isLoading) return <Loading />;
  if (ctx.isError) return <div className="p-4"><ErrorBox error={ctx.error} retry={() => ctx.refetch()} /></div>;
  const ev = ctx.data.event;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-slate-900 px-4 py-2 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{ev ? ev.name : 'Nenhum evento ativo'}</p>
          <p className="truncate text-xs text-slate-300">{me.company.name} · Operador: {me.user.name}</p>
        </div>
        {remaining !== null && items.length > 0 && (
          <span title="Tempo restante da reserva (renova com a atividade)" className={cx('rounded-md px-2 py-1 text-xs font-semibold money', remaining < 60 ? 'bg-amber-500 text-slate-900' : 'bg-slate-700')}>
            Reserva {Math.max(0, Math.floor(remaining / 60))}:{String(Math.max(0, remaining % 60)).padStart(2, '0')}
          </span>
        )}
        <Button variant="secondary" className="!py-1.5" onClick={() => setSalesOpen(true)}>Minhas vendas</Button>
        {me.user.role === 'COMPANY_ADMIN' && <Link to="/admin" className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20">Painel</Link>}
        <Button variant="ghost" className="!py-1.5 !text-white hover:!bg-white/10" onClick={async () => { await post('/auth/logout').catch(() => {}); qc.clear(); qc.setQueryData(['me'], null); }}>Sair</Button>
      </header>

      {!ev ? (
        <div className="grid flex-1 place-items-center p-6 text-center"><div><p className="text-lg font-semibold">Não há evento ativo.</p><p className="text-sm text-slate-600">Peça ao administrador para ativar um evento para começar a vender.</p><Button className="mt-4" variant="secondary" onClick={() => ctx.refetch()}>Verificar novamente</Button></div></div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_26rem]">
          {/* ------------------------------------------------ produtos */}
          <section className="flex min-h-0 flex-col" aria-label="Produtos">
            <div className="space-y-2 border-b border-slate-200 bg-white p-3">
              <div className="flex gap-2">
                <Input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSearchEnter()}
                  placeholder="Buscar produto ou ler código de barras (Enter adiciona)" aria-label="Buscar produto ou código de barras" className="!py-3 !text-base" inputMode="search" />
                {search && <Button variant="secondary" onClick={() => { setSearch(''); searchRef.current?.focus(); }}>Limpar</Button>}
              </div>
              {(products.data?.categories.length ?? 0) > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Categorias">
                  {['', ...(products.data?.categories ?? [])].map((c) => (
                    <button key={c || 'all'} onClick={() => setCategory(c)} aria-pressed={category === c}
                      className={cx('shrink-0 rounded-full px-3 py-1 text-sm font-medium', category === c ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}>{c || 'Todas'}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-28 lg:pb-3">
              {products.isLoading ? <Loading /> : products.isError ? <ErrorBox error={products.error} retry={() => products.refetch()} /> : filtered.length === 0 ? (
                <p className="p-8 text-center text-slate-500">{list.length ? 'Nenhum produto encontrado.' : 'Nenhum produto ativo neste evento.'}</p>
              ) : (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {filtered.map((p) => {
                    const out = p.availableQty <= 0;
                    const low = !out && p.availableQty <= 5;
                    const inCart = qtyIn.get(p.id) ?? 0;
                    return (
                      <li key={p.id}>
                        <button disabled={out || busyIds.has(p.id)} onClick={() => { change(p, 1); searchRef.current?.focus(); }}
                          className={cx('relative flex h-full min-h-28 w-full flex-col justify-between rounded-xl border-2 bg-white p-3 text-left shadow-sm transition active:scale-[0.98]',
                            out ? 'border-slate-200 opacity-50' : inCart ? 'border-brand-500' : 'border-transparent hover:border-brand-500')}
                          aria-label={`Adicionar ${p.name}, ${brl(p.priceCents)}, ${p.availableQty} disponíveis`}>
                          {inCart > 0 && <span className="absolute -right-2 -top-2 grid size-7 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white">{inCart}</span>}
                          <span><span className="block text-sm font-semibold leading-tight">{p.name}</span><span className="text-xs text-slate-500">{p.code}</span></span>
                          <span className="mt-2 flex items-end justify-between gap-1">
                            <span className="money text-xl font-extrabold text-slate-900">{brl(p.priceCents)}</span>
                            <Badge tone={out ? 'red' : low ? 'amber' : 'slate'}>{out ? 'Esgotado' : `${p.availableQty} disp.`}</Badge>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* ------------------------------------------------ carrinho */}
          <aside className={cx('flex min-h-0 flex-col border-l border-slate-200 bg-white', 'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:rounded-t-2xl max-lg:shadow-2xl', cartOpen ? 'max-lg:top-16' : 'max-lg:top-auto')} aria-label="Carrinho">
            <button className="flex items-center justify-between px-4 py-3 text-left lg:hidden" onClick={() => setCartOpen((o) => !o)} aria-expanded={cartOpen}>
              <span className="font-semibold">Carrinho ({cart?.itemsCount ?? 0})</span>
              <span className="money text-lg font-extrabold">{brl(total)}</span>
            </button>
            <div className={cx('min-h-0 flex-1 flex-col', cartOpen ? 'flex' : 'hidden lg:flex')}>
              <div className="hidden items-center justify-between border-b border-slate-100 px-4 py-3 lg:flex">
                <h2 className="font-semibold">Carrinho {cart ? `(${cart.itemsCount})` : ''}</h2>
                <Button variant="ghost" className="!py-1 text-red-600" disabled={!items.length} loading={clearing} onClick={clear}>Limpar</Button>
              </div>
              {notice && (
                <div role="alert" className="m-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-semibold">A reserva expirou e os itens foram liberados:</p>
                  <ul className="list-disc pl-5">{notice.items.map((i, k) => <li key={k}>{i.quantity}× {i.name}</li>)}</ul>
                  <button className="mt-1 font-semibold underline" onClick={() => setNotice(null)}>Entendi</button>
                </div>
              )}
              <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
                {items.length === 0 && <li className="p-8 text-center text-sm text-slate-500">Carrinho vazio. Toque em um produto para reservar.</li>}
                {items.map((i) => (
                  <li key={i.productId} className="flex items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{i.name}</p><p className="money text-xs text-slate-500">{brl(i.unitPriceCents)} un.{!i.active && <span className="ml-1 font-semibold text-red-600">· inativo</span>}</p></div>
                    <div className="flex items-center rounded-lg border border-slate-300">
                      <button aria-label={`Diminuir ${i.name}`} className="size-11 text-xl font-bold hover:bg-slate-100 disabled:opacity-40" disabled={busyIds.has(i.productId)} onClick={() => change({ id: i.productId, name: i.name }, -1)}>−</button>
                      <span className="money w-9 text-center font-bold" aria-live="polite">{i.quantity}</span>
                      <button aria-label={`Aumentar ${i.name}`} className="size-11 text-xl font-bold hover:bg-slate-100 disabled:opacity-40" disabled={busyIds.has(i.productId)} onClick={() => change({ id: i.productId, name: i.name }, 1)}>+</button>
                    </div>
                    <p className="money w-20 text-right font-bold">{brl(i.subtotalCents)}</p>
                    <button aria-label={`Remover ${i.name}`} className="size-9 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove(i)}>✕</button>
                  </li>
                ))}
              </ul>
              <div className="space-y-3 border-t border-slate-200 bg-slate-50 p-4">
                <div className="flex items-baseline justify-between"><span className="text-sm font-medium text-slate-600">Total</span><span className="money text-4xl font-black tracking-tight" data-testid="total">{brl(total)}</span></div>
                {hasInactive && <p className="text-xs font-medium text-red-600">Há produto desativado no carrinho. Remova-o para finalizar.</p>}
                <div className="flex gap-2 lg:hidden"><Button variant="secondary" disabled={!items.length} onClick={clear}>Limpar</Button></div>
                <Button variant="success" className="w-full !py-4 !text-lg" disabled={!items.length || hasInactive} onClick={() => setPayTotal(total)}>Finalizar venda</Button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {payTotal !== null && <PaymentModal totalCents={payTotal} onClose={() => { setPayTotal(null); refreshAll(); }} onSold={() => { refreshAll(); qc.invalidateQueries({ queryKey: ['pdv-sales'] }); }} onAfter={() => { setPayTotal(null); setCartOpen(false); setTimeout(() => searchRef.current?.focus(), 50); }} />}
      {salesOpen && <MySales me={me} onClose={() => { setSalesOpen(false); refreshAll(); }} />}
    </div>
  );
}

// ======================================================================= pagamento
type Method = 'CASH' | 'PIX' | 'DEBIT' | 'CREDIT';
function PaymentModal({ totalCents, onClose, onSold, onAfter }: { totalCents: number; onClose: () => void; onSold: () => void; onAfter: () => void }) {
  const [method, setMethod] = useState<Method>('CASH');
  const [received, setReceived] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sale, setSale] = useState<any>(null);
  const key = useRef(newKey()); // mesma chave em reenvios → nunca duplica a venda
  const submitting = useRef(false);

  const receivedCents = parseMoney(received);
  const change = receivedCents !== null ? receivedCents - totalCents : null;
  const cashOk = method === 'CASH' && receivedCents !== null && receivedCents >= totalCents;
  const canPay = method === 'CASH' ? cashOk : confirmed;

  const m = useMutation({
    mutationFn: () => post('/pdv/cart/checkout', {
      idempotencyKey: key.current, expectedTotalCents: totalCents,
      payment: method === 'CASH' ? { method, receivedCents } : { method, confirmed: true },
    }),
    onSuccess: (r) => { setSale(r.sale); onSold(); },
    onError: (e) => {
      if (e instanceof ApiError) {
        if (e.code === 'PRICE_CHANGED') setErr(`Os preços mudaram. Novo total: ${brl(e.details?.totalCents ?? 0)}. Feche e confira o carrinho.`);
        else if (e.code === 'CART_EXPIRED' || e.code === 'CART_EMPTY' || e.code === 'RESERVATION_INVALID') setErr(e.message + ' Feche esta janela e confira o carrinho.');
        else setErr(e.message);
      } else setErr('Erro inesperado.');
    },
    onSettled: () => { submitting.current = false; },
  });
  const pay = () => { if (submitting.current || !canPay) return; submitting.current = true; setErr(null); m.mutate(); };

  const quick = useMemo(() => [...new Set([totalCents, ...[500, 1000, 2000, 5000, 10000, 20000].filter((v) => v >= totalCents)])].slice(0, 5), [totalCents]);

  if (sale) {
    return (
      <Modal open onClose={onAfter} title="Venda concluída" locked
        footer={<Button variant="success" autoFocus className="w-full !py-3 !text-base" onClick={onAfter}>Nova venda</Button>}>
        <div className="space-y-3 text-center">
          <p className="text-5xl" aria-hidden>✅</p>
          <p className="text-lg font-bold">Venda nº {sale.saleNumber} registrada</p>
          <p className="money text-3xl font-black">{brl(sale.totalCents)}</p>
          <p className="text-sm text-slate-600">{METHOD[sale.method]}</p>
          {sale.method === 'CASH' && <div className="rounded-xl bg-amber-50 p-4"><p className="text-sm font-medium text-amber-900">Troco</p><p className="money text-5xl font-black text-amber-900">{brl(sale.changeCents)}</p></div>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Pagamento" locked={m.isPending}
      footer={<><Button variant="secondary" onClick={onClose} disabled={m.isPending}>Voltar</Button><Button variant="success" className="min-w-44 !py-3 !text-base" loading={m.isPending} disabled={!canPay} onClick={pay}>Concluir venda</Button></>}>
      <div className="space-y-4" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON' && pay()}>
        <div className="rounded-xl bg-slate-900 p-4 text-center text-white"><p className="text-xs uppercase tracking-wider text-slate-300">Total a receber</p><p className="money text-4xl font-black">{brl(totalCents)}</p></div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Forma de pagamento">
          {(['CASH', 'PIX', 'DEBIT', 'CREDIT'] as Method[]).map((k) => (
            <button key={k} role="radio" aria-checked={method === k} onClick={() => { setMethod(k); setErr(null); }}
              className={cx('rounded-xl border-2 py-3 text-base font-bold', method === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 hover:border-slate-300')}>{METHOD[k]}</button>
          ))}
        </div>
        {method === 'CASH' ? (
          <div className="space-y-2">
            <label htmlFor="rec" className="text-sm font-medium">Valor recebido (R$)</label>
            <Input id="rec" autoFocus inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="0,00" className="!py-3 !text-2xl font-bold money" />
            <div className="flex flex-wrap gap-2">{quick.map((v) => <button key={v} className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold hover:bg-slate-200" onClick={() => setReceived((v / 100).toFixed(2).replace('.', ','))}>{v === totalCents ? 'Valor exato' : brl(v)}</button>)}</div>
            {receivedCents !== null && change !== null && (change >= 0
              ? <div className="rounded-xl bg-emerald-50 p-3 text-center"><p className="text-sm text-emerald-800">Troco</p><p className="money text-4xl font-black text-emerald-800">{brl(change)}</p></div>
              : <div className="rounded-xl bg-red-50 p-3 text-center"><p className="text-sm text-red-800">Faltam</p><p className="money text-3xl font-black text-red-800">{brl(-change)}</p></div>)}
          </div>
        ) : (
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-slate-200 p-3 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
              <input type="checkbox" className="mt-1 size-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} autoFocus />
              <span className="text-sm font-medium">Confirmo que o pagamento de <b className="money">{brl(totalCents)}</b> via {METHOD[method]} foi recebido/aprovado.</span>
            </label>
            <p className="text-xs text-slate-500">O sistema apenas registra a forma de pagamento informada; não há integração com maquininha, banco ou PIX.</p>
          </div>
        )}
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Modal>
  );
}

// ======================================================================= minhas vendas
function MySales({ me, onClose }: { me: Me; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pdv-sales'], queryFn: () => get('/pdv/sales'), refetchInterval: 10_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Modal open onClose={onClose} title="Minhas vendas (evento atual)" wide footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : q.data.sales.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Nenhuma venda ainda.</p> : (
          <ul className="divide-y divide-slate-100">
            {q.data.sales.map((s: any) => (
              <li key={s.id}><button onClick={() => setOpen(s.id)} className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-slate-50">
                <span className="w-12 font-bold money">#{s.saleNumber}</span><span className="flex-1 text-sm text-slate-600">{dt(s.createdAt)} · {METHOD[s.method]} · {s.itemsCount} item(ns)</span>
                {s.pendingRequest > 0 && <Badge tone="amber">Cancelamento solicitado</Badge>}<StatusBadge status={s.status} /><span className="money w-24 text-right font-bold">{brl(s.totalCents)}</span></button></li>
            ))}
          </ul>
        )}
      </Modal>
      {open && <SaleDetail saleId={open} me={me} scope="pdv" onClose={() => setOpen(null)} onChanged={() => q.refetch()} />}
    </>
  );
}
void Spinner;
