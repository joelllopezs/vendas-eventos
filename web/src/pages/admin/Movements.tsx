import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EventSelect, Pager } from '../../components/EventSelect';
import { Badge, Card, ErrorBox, Loading, Select, Table, Td, Empty } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { dt, MOVE_TYPE } from '../../lib/format';
import { useEventSelection } from '../../lib/hooks';

export default function Movements() {
  const sel = useEventSelection(true);
  const [type, setType] = useState(''); const [page, setPage] = useState(1);
  const params = { eventId: sel.eventId, type, page, pageSize: 50 };
  const q = useQuery({ queryKey: ['movements', params], queryFn: () => get(`/admin/movements${qs(params)}`), enabled: !sel.loading, refetchInterval: 15_000 });
  return (
    <>
      <h1 className="text-xl font-bold">Histórico de movimentações</h1>
      <p className="text-sm text-slate-600">Registro permanente (somente inserção) de toda alteração do estoque físico. Reservas de carrinho não são movimentações.</p>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <EventSelect events={sel.events} value={sel.eventId} onChange={(v) => { sel.setEventId(v); setPage(1); }} allowAll />
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="!w-auto" aria-label="Tipo"><option value="">Todos os tipos</option>{Object.entries(MOVE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </div>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : q.data.rows.length === 0 ? <Empty>Nenhuma movimentação.</Empty> : (
          <>
            <Table head={['Data/hora', 'Produto', 'Tipo', 'Qtd.', 'Saldo anterior', 'Saldo posterior', 'Usuário', 'Venda', 'Justificativa']}>
              {q.data.rows.map((m: any) => (
                <tr key={m.id}><Td>{dt(m.createdAt)}</Td><Td>{m.productName} <span className="text-xs text-slate-500">{m.productCode}</span></Td><Td><Badge tone={m.type === 'SALE' ? 'blue' : m.type === 'ADJUSTMENT' ? 'amber' : 'slate'}>{MOVE_TYPE[m.type]}</Badge></Td>
                  <Td right><b className={m.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}>{m.quantity > 0 ? '+' : ''}{m.quantity}</b></Td><Td right>{m.balanceBefore}</Td><Td right>{m.balanceAfter}</Td><Td>{m.userName ?? '—'}</Td><Td>{m.saleNumber ? `#${m.saleNumber}` : '—'}</Td><Td className="max-w-xs truncate">{m.reason ?? ''}</Td></tr>))}
            </Table>
            <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>)}
      </Card>
    </>
  );
}
