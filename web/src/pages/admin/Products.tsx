import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { EventSelect } from '../../components/EventSelect';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Select, Table, Td, TextField, Empty, errMsg, fieldErrors, useToast } from '../../components/ui';
import { get, patch, post, qs } from '../../lib/api';
import { brl, centsToInput, parseMoney } from '../../lib/format';
import { useEventSelection } from '../../lib/hooks';

export default function Products() {
  const sel = useEventSelection();
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const [category, setCategory] = useState(''); const [low, setLow] = useState(false);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [stock, setStock] = useState<{ p: any; kind: 'entry' | 'adjust' } | null>(null);
  const key = ['admin-products', sel.eventId, q, category, low];
  const list = useQuery({ queryKey: key, queryFn: () => get(`/admin/events/${sel.eventId}/products${qs({ q, category, lowStock: low ? '1' : '' })}`), enabled: !!sel.eventId, refetchInterval: 10_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-products'] });
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-bold">Produtos e estoque</h1>
        <div className="flex gap-2"><EventSelect events={sel.events} value={sel.eventId} onChange={sel.setEventId} /><Button disabled={!sel.eventId} onClick={() => setEdit('new')}>Novo produto</Button></div></div>
      {!sel.loading && sel.events.length === 0 && <Card><Empty>Cadastre um evento primeiro (menu Eventos).</Empty></Card>}
      {sel.eventId && (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, código ou código de barras" className="max-w-xs" aria-label="Buscar" />
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="!w-auto" aria-label="Categoria"><option value="">Todas as categorias</option>{list.data?.categories.map((c: string) => <option key={c}>{c}</option>)}</Select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={low} onChange={(e) => setLow(e.target.checked)} /> Somente estoque baixo</label>
          </div>
          {list.isLoading ? <Loading /> : list.isError ? <ErrorBox error={list.error} /> : list.data.products.length === 0 ? <Empty>Nenhum produto.</Empty> : (
            <Table head={['Código', 'Produto', 'Categoria', 'Preço', 'Custo', 'Físico', 'Reservado', 'Disponível', 'Mín.', 'Status', '']}>
              {list.data.products.map((p: any) => (
                <tr key={p.id} className={p.active ? '' : 'text-slate-400'}>
                  <Td>{p.internalCode}</Td><Td><b>{p.name}</b></Td><Td>{p.category ?? '—'}</Td><Td right>{brl(p.priceCents)}</Td><Td right>{p.costCents != null ? brl(p.costCents) : '—'}</Td>
                  <Td right>{p.physicalQty}</Td><Td right>{p.reservedQty}</Td><Td right><Badge tone={p.availableQty <= 0 ? 'red' : p.availableQty <= p.minStock ? 'amber' : 'green'}>{p.availableQty}</Badge></Td><Td right>{p.minStock}</Td>
                  <Td>{p.active ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>}</Td>
                  <Td><div className="flex gap-1"><Button variant="ghost" onClick={() => setEdit(p)}>Editar</Button><Button variant="secondary" onClick={() => setStock({ p, kind: 'entry' })}>Entrada</Button><Button variant="ghost" onClick={() => setStock({ p, kind: 'adjust' })}>Ajustar</Button></div></Td>
                </tr>))}
            </Table>)}
        </Card>
      )}
      {edit && <ProductForm eventId={sel.eventId} p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {stock && <StockForm {...stock} onClose={() => setStock(null)} onSaved={() => { setStock(null); refresh(); qc.invalidateQueries({ queryKey: ['movements'] }); }} />}
    </>
  );
}

function ProductForm({ eventId, p, onClose, onSaved }: { eventId: string; p: any | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: p?.name ?? '', internalCode: p?.internalCode ?? '', barcode: p?.barcode ?? '', category: p?.category ?? '', description: p?.description ?? '', price: p ? centsToInput(p.priceCents) : '', cost: p?.costCents != null ? centsToInput(p.costCents) : '', minStock: String(p?.minStock ?? 0), initialQty: '0', active: p?.active ?? true });
  const [fe, setFe] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const price = parseMoney(f.price); const cost = f.cost.trim() ? parseMoney(f.cost) : null;
      const errs: Record<string, string> = {};
      if (!price || price <= 0) errs.priceCents = 'Informe um preço maior que zero.';
      if (f.cost.trim() && cost === null) errs.costCents = 'Custo inválido.';
      if (Object.keys(errs).length) { setFe(errs); throw Object.assign(new Error('local'), { local: true }); }
      const body: any = { name: f.name, internalCode: f.internalCode, barcode: f.barcode || null, category: f.category || null, description: f.description || null, priceCents: price, costCents: cost, minStock: Number(f.minStock) || 0, active: f.active };
      if (!p) body.initialQty = Number(f.initialQty) || 0;
      return p ? patch(`/admin/products/${p.id}`, body) : post(`/admin/events/${eventId}/products`, body);
    },
    onSuccess: () => { toast('ok', 'Produto salvo.'); onSaved(); },
    onError: (x: any) => { if (!x.local) { setFe(fieldErrors(x)); setErr(errMsg(x)); } },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setErr(null); setFe({}); m.mutate(); };
  return (
    <Modal open onClose={onClose} title={p ? 'Editar produto' : 'Novo produto'} wide>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nome" value={f.name} onChange={set('name')} error={fe.name} required />
        <TextField label="Código interno" value={f.internalCode} onChange={set('internalCode')} error={fe.internalCode} required />
        <TextField label="Código de barras (opcional)" value={f.barcode} onChange={set('barcode')} inputMode="numeric" />
        <TextField label="Categoria (opcional)" value={f.category} onChange={set('category')} />
        <TextField label="Preço de venda (R$)" value={f.price} onChange={set('price')} error={fe.priceCents} inputMode="decimal" required hint="Alterar o preço não muda vendas anteriores." />
        <TextField label="Custo (R$, opcional — só o administrador vê)" value={f.cost} onChange={set('cost')} error={fe.costCents} inputMode="decimal" />
        {!p && <TextField label="Quantidade inicial em estoque" type="number" min={0} value={f.initialQty} onChange={set('initialQty')} />}
        <TextField label="Quantidade mínima para alerta" type="number" min={0} value={f.minStock} onChange={set('minStock')} />
        <div className="sm:col-span-2"><TextField label="Descrição (opcional)" value={f.description} onChange={set('description')} /></div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4" checked={f.active} onChange={(e) => setF((s) => ({ ...s, active: e.target.checked }))} /> Produto ativo (inativos não podem ser vendidos)</label>
        {err && <p role="alert" className="sm:col-span-2 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
        <div className="sm:col-span-2 flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={m.isPending}>Salvar</Button></div>
      </form>
    </Modal>
  );
}

function StockForm({ p, kind, onClose, onSaved }: { p: any; kind: 'entry' | 'adjust'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState(kind === 'adjust' ? String(p.physicalQty) : ''); const [reason, setReason] = useState(''); const [err, setErr] = useState<string | null>(null);
  const n = Number(qty);
  const m = useMutation({
    mutationFn: () => kind === 'entry' ? post(`/admin/products/${p.id}/stock/entry`, { quantity: n, reason: reason || null }) : post(`/admin/products/${p.id}/stock/adjust`, { newPhysicalQty: n, reason }),
    onSuccess: () => { toast('ok', 'Estoque atualizado.'); onSaved(); }, onError: (e) => setErr(errMsg(e)),
  });
  const valid = Number.isInteger(n) && n >= (kind === 'entry' ? 1 : 0) && (kind === 'entry' || reason.trim().length >= 3);
  return (
    <Modal open onClose={onClose} title={`${kind === 'entry' ? 'Entrada de mercadoria' : 'Ajuste de estoque'} — ${p.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={m.isPending} disabled={!valid} onClick={() => { setErr(null); m.mutate(); }}>Confirmar</Button></>}>
      <div className="space-y-3 text-sm">
        <p>Físico atual: <b>{p.physicalQty}</b> · Reservado: <b>{p.reservedQty}</b> · Disponível: <b>{p.availableQty}</b></p>
        <Field label={kind === 'entry' ? 'Quantidade recebida' : 'Nova quantidade física'}>{(id) => <Input id={id} type="number" min={kind === 'entry' ? 1 : 0} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />}</Field>
        {kind === 'entry' && Number.isInteger(n) && n > 0 && <p className="text-slate-600">Novo físico: <b>{p.physicalQty + n}</b></p>}
        <Field label={kind === 'adjust' ? 'Justificativa (obrigatória)' : 'Observação (opcional)'}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
        <p className="text-xs text-slate-500">Todo ajuste gera uma movimentação permanente com saldo anterior e posterior; o histórico não pode ser apagado.</p>
        {err && <p role="alert" className="font-medium text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}
