import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../auth';
import { get, post } from '../lib/api';
import { brl, centsToInput, dt, METHOD, parseMoney } from '../lib/format';
import { Badge, Button, ErrorBox, Field, Input, Loading, Modal, Table, Td, errMsg, useToast } from './ui';

export const StatusBadge = ({ status }: { status: string }) =>
  status === 'CANCELLED' ? <Badge tone="red">Cancelada</Badge> : <Badge tone="green">Concluída</Badge>;

export function SaleDetail({ saleId, me, scope, onClose, onChanged }: { saleId: string; me: Me; scope: 'admin' | 'pdv'; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sale', scope, saleId], queryFn: () => get(`/${scope}/sales/${saleId}`) });
  const [mode, setMode] = useState<null | 'cancel' | 'request'>(null);
  const s = q.data;
  const isAdmin = me.user.role === 'COMPANY_ADMIN';
  const canCancel = s?.status === 'COMPLETED' && (isAdmin || (scope === 'pdv' && me.cancelPolicy === 'SELLER_OWN'));
  const canRequest = s?.status === 'COMPLETED' && !isAdmin && scope === 'pdv' && me.cancelPolicy === 'SELLER_REQUEST';
  const done = () => { setMode(null); qc.invalidateQueries({ queryKey: ['sale', scope, saleId] }); onChanged(); };

  return (
    <>
      <Modal open onClose={onClose} title={s ? `Venda nº ${s.saleNumber}` : 'Venda'} wide
        footer={<>
          {canRequest && <Button variant="secondary" onClick={() => setMode('request')}>Solicitar cancelamento</Button>}
          {canCancel && <Button variant="danger" onClick={() => setMode('cancel')}>Cancelar venda</Button>}
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </>}>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : s && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <Info k="Status"><StatusBadge status={s.status} /></Info>
              <Info k="Data e hora">{dt(s.createdAt)}</Info>
              <Info k="Operador">{s.operatorName}</Info>
              <Info k="Pagamento">{METHOD[s.method]}</Info>
              <Info k="Total"><b className="money">{brl(s.totalCents)}</b></Info>
              {s.method === 'CASH' && <Info k="Recebido / troco"><span className="money">{brl(s.receivedCents)} / {brl(s.changeCents)}</span></Info>}
            </dl>
            <Table head={['Produto', 'Qtd.', 'Preço un. (na venda)', 'Subtotal']}>
              {s.items.map((i: any) => (
                <tr key={i.productId}><Td>{i.name} <span className="text-xs text-slate-500">{i.code}</span></Td><Td right>{i.quantity}</Td><Td right>{brl(i.unitPriceCents)}</Td><Td right>{brl(i.subtotalCents)}</Td></tr>
              ))}
            </Table>
            {s.status === 'CANCELLED' && (
              <div className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
                <p><b>Cancelada</b> em {dt(s.cancelledAt)} por {s.cancelledByName}.</p>
                <p>Motivo: {s.cancelReason}</p>
                {s.requiresExternalRefund
                  ? <p className="font-semibold">Atenção: o estorno do pagamento ({METHOD[s.method]}) precisa ser feito separadamente, fora do sistema. O cancelamento aqui só devolveu os itens ao estoque.</p>
                  : <p>Reembolso em dinheiro informado: <b className="money">{brl(s.cashRefundCents ?? 0)}</b> (pagamento original {brl(s.totalCents)}).</p>}
              </div>
            )}
          </div>
        )}
      </Modal>
      {s && mode && <CancelDialog sale={s} request={mode === 'request'} scope={scope} onClose={() => setMode(null)} onDone={() => { toast('ok', mode === 'request' ? 'Solicitação enviada ao administrador.' : 'Venda cancelada e itens devolvidos ao estoque.'); done(); }} me={me} />}
    </>
  );
}

const Info = ({ k, children }: { k: string; children: React.ReactNode }) => (<div><dt className="text-xs text-slate-500">{k}</dt><dd>{children}</dd></div>);

function CancelDialog({ sale, request, scope, me, onClose, onDone }: { sale: any; request: boolean; scope: 'admin' | 'pdv'; me: Me; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [refund, setRefund] = useState(centsToInput(sale.totalCents));
  const [err, setErr] = useState<string | null>(null);
  const cash = sale.method === 'CASH';
  const m = useMutation({
    mutationFn: () => {
      if (request) return post(`/pdv/sales/${sale.id}/cancel-request`, { reason });
      const cents = cash ? parseMoney(refund) : null;
      if (cash && (cents === null || cents > sale.totalCents)) throw new Error('Reembolso inválido');
      return post(`/${scope}/sales/${sale.id}/cancel`, { confirm: true, reason, ...(cash ? { cashRefundCents: cents } : {}) });
    },
    onSuccess: onDone,
    onError: (e) => setErr(e instanceof Error && !('status' in e) ? 'Informe um valor de reembolso válido (até o total da venda).' : errMsg(e)),
  });
  return (
    <Modal open onClose={onClose} title={request ? 'Solicitar cancelamento' : 'Cancelar venda'}
      footer={<><Button variant="secondary" onClick={onClose}>Voltar</Button>
        <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3 || (!request && !confirm)} onClick={() => { setErr(null); m.mutate(); }}>{request ? 'Enviar solicitação' : 'Confirmar cancelamento'}</Button></>}>
      <div className="space-y-3 text-sm">
        <p>Venda nº <b>{sale.saleNumber}</b> — <b className="money">{brl(sale.totalCents)}</b> ({METHOD[sale.method]}).</p>
        {!request && <p>Responsável pelo cancelamento: <b>{me.user.name}</b></p>}
        <Field label="Motivo (obrigatório)">{(id) => <textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} className="w-full rounded-lg border border-slate-300 p-2" />}</Field>
        {!request && cash && <Field label="Valor devolvido ao cliente em dinheiro (R$)">{(id) => <Input id={id} inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />}</Field>}
        {!request && !cash && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">O cancelamento no PDV <b>não devolve o dinheiro</b> ao cliente. O estorno de {METHOD[sale.method]} deve ser feito separadamente, fora do sistema.</p>}
        {!request && <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 size-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>Confirmo o cancelamento. Os itens voltarão ao estoque do evento.</span></label>}
        {err && <p role="alert" className="font-medium text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}
