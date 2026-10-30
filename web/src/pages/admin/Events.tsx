import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Loading, Modal, Select, Table, Td, TextField, errMsg, fieldErrors, useToast } from '../../components/ui';
import { patch, post } from '../../lib/api';
import { dateBr, EVENT_STATUS, EVENT_TYPE } from '../../lib/format';
import { useEvents, type EventRow } from '../../lib/hooks';

const UF = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

export default function Events() {
  const q = useEvents(); const qc = useQueryClient(); const toast = useToast();
  const [edit, setEdit] = useState<EventRow | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ e: EventRow; status: 'ACTIVE' | 'ENDED' } | null>(null);
  const setStatus = useMutation({
    mutationFn: ({ e, status }: { e: EventRow; status: string }) => patch(`/admin/events/${e.id}`, { status }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setConfirm(null); toast('ok', 'Status do evento atualizado.'); }, onError: (e) => { toast('err', errMsg(e)); setConfirm(null); },
  });
  return (
    <>
      <div className="flex items-center justify-between"><h1 className="text-xl font-bold">Eventos</h1><Button onClick={() => setEdit('new')}>Novo evento</Button></div>
      <p className="text-sm text-slate-600">Cada evento tem seus próprios produtos, estoque, vendas e relatórios. Apenas um evento pode estar ativo por vez — é nele que o PDV vende.</p>
      <Card>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : (
          <Table head={['Evento', 'Tipo', 'Local', 'Período', 'Status', '']}>
            {(q.data?.events ?? []).map((e) => (
              <tr key={e.id}><Td><b>{e.name}</b></Td><Td>{EVENT_TYPE[e.type]}</Td><Td>{e.city}/{e.state}</Td><Td>{dateBr(e.startsOn)}{e.endsOn ? ` a ${dateBr(e.endsOn)}` : ''}</Td>
                <Td><Badge tone={e.status === 'ACTIVE' ? 'green' : e.status === 'ENDED' ? 'slate' : 'blue'}>{EVENT_STATUS[e.status]}</Badge></Td>
                <Td><div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setEdit(e)}>Editar</Button>
                  {e.status !== 'ACTIVE' && <Button variant="secondary" onClick={() => setConfirm({ e, status: 'ACTIVE' })}>Ativar</Button>}
                  {e.status === 'ACTIVE' && <Button variant="danger" onClick={() => setConfirm({ e, status: 'ENDED' })}>Encerrar</Button>}
                </div></Td></tr>
            ))}
            {q.data?.events.length === 0 && <tr><Td>Nenhum evento. Cadastre o primeiro.</Td></tr>}
          </Table>
        )}
      </Card>
      {edit && <EventForm ev={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); qc.invalidateQueries({ queryKey: ['events'] }); toast('ok', 'Evento salvo.'); }} />}
      <Confirm open={!!confirm} onClose={() => setConfirm(null)} danger={confirm?.status === 'ENDED'} loading={setStatus.isPending}
        title={confirm?.status === 'ACTIVE' ? 'Ativar evento' : 'Encerrar evento'} confirmLabel={confirm?.status === 'ACTIVE' ? 'Ativar' : 'Encerrar evento'}
        message={confirm?.status === 'ACTIVE' ? <>O PDV passará a vender no evento <b>{confirm.e.name}</b>.</> : <>Encerrar <b>{confirm?.e.name}</b>? As vendas deixam de ser possíveis e as reservas dos carrinhos abertos serão liberadas.</>}
        onConfirm={() => confirm && setStatus.mutate(confirm)} />
    </>
  );
}

function EventForm({ ev, onClose, onSaved }: { ev: EventRow | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: ev?.name ?? '', type: ev?.type ?? 'PARTY', city: ev?.city ?? '', state: ev?.state ?? 'SP', startsOn: ev?.startsOn ?? '', endsOn: ev?.endsOn ?? '', description: ev?.description ?? '', status: ev?.status ?? 'PLANNED' });
  const [fe, setFe] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFe({});
    const body = { ...f, endsOn: f.endsOn || null, description: f.description || null };
    try { ev ? await patch(`/admin/events/${ev.id}`, body) : await post('/admin/events', body); onSaved(); }
    catch (x) { setFe(fieldErrors(x)); setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={ev ? 'Editar evento' : 'Novo evento'} wide>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><TextField label="Nome do evento" value={f.name} onChange={set('name')} error={fe.name} required /></div>
        <Field label="Tipo">{(id) => <Select id={id} value={f.type} onChange={set('type')}>{Object.entries(EVENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="Status">{(id) => <Select id={id} value={f.status} onChange={set('status')}>{Object.entries(EVENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <TextField label="Cidade" value={f.city} onChange={set('city')} error={fe.city} required />
        <Field label="Estado">{(id) => <Select id={id} value={f.state} onChange={set('state')}>{UF.map((u) => <option key={u}>{u}</option>)}</Select>}</Field>
        <TextField label="Data de início" type="date" value={f.startsOn} onChange={set('startsOn')} error={fe.startsOn} required />
        <TextField label="Data de término (opcional)" type="date" value={f.endsOn} onChange={set('endsOn')} error={fe.endsOn} />
        <div className="sm:col-span-2"><Field label="Descrição (opcional)">{(id) => <textarea id={id} value={f.description} onChange={set('description')} rows={3} className="w-full rounded-lg border border-slate-300 p-2 text-sm" />}</Field></div>
        {err && <p role="alert" className="sm:col-span-2 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
        <div className="sm:col-span-2 flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Salvar</Button></div>
      </form>
    </Modal>
  );
}
