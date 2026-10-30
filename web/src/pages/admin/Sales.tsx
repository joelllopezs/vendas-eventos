import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../../auth';
import { EventSelect, Pager } from '../../components/EventSelect';
import { SaleDetail, StatusBadge } from '../../components/SaleViews';
import { Badge, Button, Card, ErrorBox, Input, Loading, Select, Table, Td, Empty, errMsg, useToast } from '../../components/ui';
import { get, post, qs } from '../../lib/api';
import { brl, dateBr, dayEndISO, dayStartISO, dt, METHOD } from '../../lib/format';
import { useEventSelection, useUsers } from '../../lib/hooks';

export default function SalesAdmin() {
  const me = useMe().data!;
  const sel = useEventSelection(true); const users = useUsers(); const qc = useQueryClient(); const toast = useToast();
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [operatorId, setOperatorId] = useState(''); const [method, setMethod] = useState(''); const [status, setStatus] = useState(''); const [text, setText] = useState('');
  const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null);
  const params = { eventId: sel.eventId, from: from ? dayStartISO(from) : '', to: to ? dayEndISO(to) : '', operatorId, method, status, q: text, page, pageSize: 25 };
  const q = useQuery({ queryKey: ['admin-sales', params], queryFn: () => get(`/admin/sales${qs(params)}`), enabled: !sel.loading, refetchInterval: 15_000 });
  const reqs = useQuery({ queryKey: ['cancel-requests'], queryFn: () => get('/admin/cancellation-requests'), refetchInterval: 15_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-sales'] }); qc.invalidateQueries({ queryKey: ['cancel-requests'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const approve = useMutation({ mutationFn: (id: string) => post(`/admin/cancellation-requests/${id}/approve`, { confirm: true }), onSuccess: () => { toast('ok', 'Cancelamento aprovado; itens devolvidos ao estoque.'); refresh(); }, onError: (e) => toast('err', errMsg(e)) });
  const reject = useMutation({ mutationFn: (id: string) => post(`/admin/cancellation-requests/${id}/reject`, {}), onSuccess: () => { toast('ok', 'Solicitação recusada.'); refresh(); }, onError: (e) => toast('err', errMsg(e)) });
  const f = (set: (v: string) => void) => (e: { target: { value: string } }) => { set(e.target.value); setPage(1); };
  return (
    <>
      <h1 className="text-xl font-bold">Vendas</h1>
      {reqs.data?.requests.length > 0 && (
        <Card title={<>Solicitações de cancelamento <Badge tone="amber">{reqs.data.requests.length}</Badge></>}>
          <Table head={['Venda', 'Valor', 'Solicitante', 'Motivo', 'Quando', '']}>
            {reqs.data.requests.map((r: any) => (
              <tr key={r.id}><Td>#{r.saleNumber}</Td><Td right>{brl(r.totalCents)}</Td><Td>{r.requestedByName}</Td><Td className="max-w-xs">{r.reason}</Td><Td>{dt(r.createdAt)}</Td>
                <Td><div className="flex gap-1"><Button variant="danger" loading={approve.isPending} onClick={() => confirm(`Aprovar o cancelamento da venda #${r.saleNumber}? Os itens voltarão ao estoque.`) && approve.mutate(r.id)}>Aprovar</Button><Button variant="secondary" onClick={() => reject.mutate(r.id)}>Recusar</Button><Button variant="ghost" onClick={() => setOpen(r.saleId)}>Ver</Button></div></Td></tr>))}
          </Table>
        </Card>)}
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <EventSelect events={sel.events} value={sel.eventId} onChange={(v) => { sel.setEventId(v); setPage(1); }} allowAll />
          <Input type="date" value={from} onChange={f(setFrom)} aria-label="De" className="!w-auto" /><Input type="date" value={to} onChange={f(setTo)} aria-label="Até" className="!w-auto" />
          <Select value={operatorId} onChange={f(setOperatorId)} className="!w-auto" aria-label="Operador"><option value="">Todos os operadores</option>{users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          <Select value={method} onChange={f(setMethod)} className="!w-auto" aria-label="Pagamento"><option value="">Todas as formas</option>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Select value={status} onChange={f(setStatus)} className="!w-auto" aria-label="Status"><option value="">Todos os status</option><option value="COMPLETED">Concluídas</option><option value="CANCELLED">Canceladas</option></Select>
          <Input value={text} onChange={f(setText)} inputMode="numeric" placeholder="Nº da venda" aria-label="Número da venda" className="!w-32" />
        </div>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : q.data.rows.length === 0 ? <Empty>Nenhuma venda encontrada.</Empty> : (
          <>
            <Table head={['Nº', 'Data/hora', 'Operador', 'Pagamento', 'Itens', 'Total', 'Status', '']}>
              {q.data.rows.map((s: any) => (
                <tr key={s.id} className={s.status === 'CANCELLED' ? 'text-slate-500' : ''}><Td>#{s.saleNumber}</Td><Td>{dt(s.createdAt)}</Td><Td>{s.operatorName}</Td><Td>{METHOD[s.method]}</Td><Td right>{s.itemsCount}</Td>
                  <Td right><span className={s.status === 'CANCELLED' ? 'line-through' : 'font-semibold'}>{brl(s.totalCents)}</span></Td><Td><StatusBadge status={s.status} /></Td><Td><Button variant="ghost" onClick={() => setOpen(s.id)}>Detalhes</Button></Td></tr>))}
            </Table>
            <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>)}
      </Card>
      {open && <SaleDetail saleId={open} me={me} scope="admin" onClose={() => setOpen(null)} onChanged={refresh} />}
      <span hidden>{dateBr('2000-01-01')}</span>
    </>
  );
}
