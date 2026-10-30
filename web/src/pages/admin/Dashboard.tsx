import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EventSelect } from '../../components/EventSelect';
import { Badge, Card, ErrorBox, Input, Loading, Select, Table, Td, Empty } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { brl, dateBr, dayEndISO, dayStartISO, METHOD } from '../../lib/format';
import { useEventSelection, useUsers } from '../../lib/hooks';

export default function Dashboard() {
  const sel = useEventSelection(true);
  const users = useUsers();
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [operatorId, setOperatorId] = useState(''); const [method, setMethod] = useState(''); const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const products = useQuery({ queryKey: ['dash-products', sel.eventId], queryFn: () => get(`/admin/events/${sel.eventId}/products`), enabled: !!sel.eventId });

  const params = { eventId: sel.eventId, from: from ? dayStartISO(from) : '', to: to ? dayEndISO(to) : '', operatorId, method, status, productId };
  const q = useQuery({ queryKey: ['dashboard', params], queryFn: () => get(`/admin/dashboard${qs(params)}`), enabled: !sel.loading, refetchInterval: 15_000 });
  const d = q.data;
  const maxDay = Math.max(1, ...(d?.byDay ?? []).map((x: any) => x.netCents));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3"><h1 className="text-xl font-bold">Dashboard</h1><span className="text-xs text-slate-500">Atualiza a cada 15 s · dados do banco</span></div>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Lbl t="Evento"><EventSelect events={sel.events} value={sel.eventId} onChange={(v) => { sel.setEventId(v); setProductId(''); }} allowAll /></Lbl>
          <Lbl t="De"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Lbl>
          <Lbl t="Até"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Lbl>
          <Lbl t="Operador"><Select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}><option value="">Todos</option>{users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Lbl>
          <Lbl t="Pagamento"><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Todos</option>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Lbl>
          <Lbl t="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="COMPLETED">Concluídas</option><option value="CANCELLED">Canceladas</option></Select></Lbl>
          <Lbl t="Produto"><Select value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!sel.eventId}><option value="">Todos</option>{products.data?.products.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Lbl>
        </div>
      </Card>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi t="Faturamento bruto" v={brl(d.grossCents)} s="vendas feitas no período" />
            <Kpi t="Vendas canceladas" v={brl(d.cancelledCents)} s={`${d.cancelledCount} venda(s)`} tone="red" />
            <Kpi t="Faturamento líquido" v={brl(d.netCents)} s="bruto − canceladas" tone="green" />
            <Kpi t="Vendas concluídas" v={String(d.completedCount)} s={`Ticket médio ${brl(d.averageTicketCents)}`} />
            <Kpi t="Produtos disponíveis" v={`${d.availableProducts ?? 0} / ${d.activeProducts ?? 0}`} s="ativos com estoque" />
            <Kpi t="Estoque baixo" v={String(d.lowStock.length)} s="produtos no limite" tone={d.lowStock.length ? 'amber' : undefined} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Líquido por dia">
              {d.byDay.length === 0 ? <Empty>Sem vendas no período.</Empty> : (
                <ul className="space-y-1.5">{d.byDay.map((x: any) => (
                  <li key={x.day} className="flex items-center gap-2 text-sm"><span className="w-20 shrink-0 text-slate-500">{dateBr(x.day)}</span>
                    <span className="h-5 flex-1 rounded bg-slate-100"><span className="block h-5 rounded bg-brand-500" style={{ width: `${(x.netCents / maxDay) * 100}%` }} /></span>
                    <span className="money w-24 text-right font-semibold">{brl(x.netCents)}</span></li>))}</ul>)}
            </Card>
            <Card title="Produtos mais vendidos">
              {d.topProducts.length === 0 ? <Empty>Sem vendas.</Empty> : <Table head={['Produto', 'Qtd.', 'Receita']}>{d.topProducts.map((p: any) => <tr key={p.productId}><Td>{p.name}</Td><Td right>{p.quantity}</Td><Td right>{brl(p.revenueCents)}</Td></tr>)}</Table>}
            </Card>
            <Card title="Vendas por operador">
              {d.byOperator.length === 0 ? <Empty>Sem vendas.</Empty> : <Table head={['Operador', 'Concl.', 'Bruto', 'Cancel.', 'Líquido']}>{d.byOperator.map((o: any) => <tr key={o.operatorId}><Td>{o.operatorName}</Td><Td right>{o.completedCount}</Td><Td right>{brl(o.grossCents)}</Td><Td right>{brl(o.cancelledCents)}</Td><Td right><b>{brl(o.netCents)}</b></Td></tr>)}</Table>}
            </Card>
            <Card title="Vendas por forma de pagamento">
              {d.byMethod.length === 0 ? <Empty>Sem vendas.</Empty> : <Table head={['Forma', 'Concl.', 'Bruto', 'Cancel.', 'Líquido']}>{d.byMethod.map((o: any) => <tr key={o.method}><Td>{METHOD[o.method]}</Td><Td right>{o.completedCount}</Td><Td right>{brl(o.grossCents)}</Td><Td right>{brl(o.cancelledCents)}</Td><Td right><b>{brl(o.netCents)}</b></Td></tr>)}</Table>}
            </Card>
            <Card title="Produtos com estoque baixo" className="lg:col-span-2">
              {d.lowStock.length === 0 ? <Empty>Nenhum produto no limite.</Empty> : <Table head={['Produto', 'Código', 'Físico', 'Reservado', 'Disponível', 'Mínimo']}>{d.lowStock.map((p: any) => <tr key={p.productId}><Td>{p.name}</Td><Td>{p.code}</Td><Td right>{p.physicalQty}</Td><Td right>{p.reservedQty}</Td><Td right><Badge tone={p.availableQty <= 0 ? 'red' : 'amber'}>{p.availableQty}</Badge></Td><Td right>{p.minStock}</Td></tr>)}</Table>}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
const Lbl = ({ t, children }: { t: string; children: React.ReactNode }) => <label className="block text-xs font-medium text-slate-600"><span className="mb-1 block">{t}</span>{children}</label>;
function Kpi({ t, v, s, tone }: { t: string; v: string; s?: string; tone?: 'red' | 'green' | 'amber' }) {
  const c = tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
  return <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs font-medium text-slate-500">{t}</p><p className={`money mt-1 text-2xl font-black ${c}`}>{v}</p>{s && <p className="text-xs text-slate-500">{s}</p>}</div>;
}
