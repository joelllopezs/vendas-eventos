import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorBox, Field, Loading, Select, TextField, errMsg, useToast } from '../../components/ui';
import { get, patch, post } from '../../lib/api';

const POLICY = { ADMIN_ONLY: 'Somente administradores cancelam vendas', SELLER_REQUEST: 'Vendedor solicita; administrador aprova', SELLER_OWN: 'Vendedor cancela as próprias vendas' };

export default function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get('/admin/settings') });
  const qc = useQueryClient(); const toast = useToast();
  const [ttl, setTtl] = useState('5'); const [policy, setPolicy] = useState('ADMIN_ONLY');
  useEffect(() => { if (q.data) { setTtl(String(q.data.cartTtlSeconds / 60)); setPolicy(q.data.cancelPolicy); } }, [q.data]);
  const save = useMutation({
    mutationFn: () => patch('/admin/settings', { cartTtlSeconds: Math.round(Number(ttl) * 60), cancelPolicy: policy }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['me'] }); toast('ok', 'Configurações salvas.'); }, onError: (e) => toast('err', errMsg(e)),
  });
  const rec = useMutation({ mutationFn: () => post('/admin/maintenance/reconcile-stock'), onSuccess: (r: any) => toast('ok', r.mismatches.length || r.orphanReservations ? `Corrigido: ${r.mismatches.length} contador(es) e ${r.orphanReservations} reserva(s) órfã(s).` : 'Nenhuma inconsistência encontrada.'), onError: (e) => toast('err', errMsg(e)) });
  return (
    <>
      <h1 className="text-xl font-bold">Configurações</h1>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : (
        <div className="grid max-w-3xl gap-4">
          <Card title="Reservas e cancelamentos">
            <div className="space-y-4">
              <TextField label="Tempo da reserva do carrinho (minutos)" type="number" min={0.5} max={60} step={0.5} value={ttl} onChange={(e) => setTtl(e.target.value)} hint="Renovado a cada atividade do operador. Entre 0,5 e 60 minutos." />
              <Field label="Política de cancelamento de vendas">{(id) => <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value)}>{Object.entries(POLICY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
              <Button loading={save.isPending} onClick={() => save.mutate()}>Salvar</Button>
            </div>
          </Card>
          <Card title="Manutenção do estoque">
            <p className="mb-3 text-sm text-slate-600">Recalcula as quantidades reservadas a partir das reservas ativas e encerra reservas órfãs. Use somente se notar divergência; é seguro executar.</p>
            <Button variant="secondary" loading={rec.isPending} onClick={() => rec.mutate()}>Verificar e corrigir reservas</Button>
          </Card>
        </div>)}
    </>
  );
}
