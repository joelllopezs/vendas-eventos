import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { Me } from '../../auth';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, Select, Table, Td, TextField, errMsg, fieldErrors, useToast } from '../../components/ui';
import { get, patch, post } from '../../lib/api';
import { brl, dt } from '../../lib/format';
import { useUsers } from '../../lib/hooks';

const ROLE = { COMPANY_ADMIN: 'Administrador', SELLER: 'Vendedor' } as const;

export default function Users({ me }: { me: Me }) {
  const q = useUsers(); const qc = useQueryClient(); const toast = useToast();
  const [edit, setEdit] = useState<any | 'new' | null>(null); const [reset, setReset] = useState<any>(null); const [hist, setHist] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const toggle = useMutation({ mutationFn: (u: any) => patch(`/admin/users/${u.id}`, { active: !u.active }), onSuccess: () => { refresh(); toast('ok', 'Usuário atualizado.'); }, onError: (e) => toast('err', errMsg(e)) });
  return (
    <>
      <div className="flex items-center justify-between"><h1 className="text-xl font-bold">Usuários</h1><Button onClick={() => setEdit('new')}>Novo usuário</Button></div>
      <Card>
        {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : (
          <Table head={['Nome', 'Login', 'Perfil', 'Status', 'Último acesso', '']}>
            {(q.data?.users ?? []).map((u: any) => (
              <tr key={u.id}><Td><b>{u.name}</b></Td><Td>{u.login}{u.email && <span className="block text-xs text-slate-500">{u.email}</span>}</Td><Td>{ROLE[u.role as keyof typeof ROLE]}</Td>
                <Td>{u.active ? <Badge tone="green">Ativo</Badge> : <Badge>Inativo</Badge>}{u.mustChangePassword && <Badge tone="amber">Troca de senha pendente</Badge>}</Td><Td>{u.lastLoginAt ? dt(u.lastLoginAt) : '—'}</Td>
                <Td><div className="flex flex-wrap gap-1"><Button variant="ghost" onClick={() => setEdit(u)}>Editar</Button><Button variant="ghost" onClick={() => setReset(u)}>Redefinir senha</Button><Button variant="ghost" onClick={() => setHist(u)}>Histórico</Button>
                  {u.id !== me.user.id && <Button variant="ghost" className={u.active ? '!text-red-600' : ''} onClick={() => toggle.mutate(u)}>{u.active ? 'Desativar' : 'Ativar'}</Button>}</div></Td></tr>))}
          </Table>)}
      </Card>
      {edit && <UserForm u={edit === 'new' ? null : edit} self={edit !== 'new' && edit.id === me.user.id} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); toast('ok', 'Usuário salvo.'); }} />}
      {reset && <ResetPw u={reset} onClose={() => setReset(null)} onDone={() => { setReset(null); refresh(); toast('ok', 'Senha redefinida. O usuário precisará trocá-la no próximo acesso.'); }} />}
      {hist && <History u={hist} onClose={() => setHist(null)} />}
    </>
  );
}

function UserForm({ u, self, onClose, onSaved }: { u: any | null; self: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: u?.name ?? '', login: u?.login ?? '', email: u?.email ?? '', role: u?.role ?? 'SELLER', password: '' });
  const [fe, setFe] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFe({});
    try {
      u ? await patch(`/admin/users/${u.id}`, { name: f.name, login: f.login, email: f.email || null, role: f.role })
        : await post('/admin/users', { name: f.name, login: f.login, email: f.email || null, role: f.role, password: f.password });
      onSaved();
    } catch (x) { setFe(fieldErrors(x)); setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={u ? 'Editar usuário' : 'Novo usuário'}>
      <form onSubmit={submit} className="space-y-3">
        <TextField label="Nome" value={f.name} onChange={set('name')} error={fe.name} required />
        <TextField label="Login" value={f.login} onChange={set('login')} error={fe.login} autoCapitalize="none" required />
        <TextField label="E-mail (opcional)" type="email" value={f.email} onChange={set('email')} error={fe.email} />
        <Field label="Perfil">{(id) => <Select id={id} value={f.role} onChange={set('role')} disabled={self}><option value="SELLER">Vendedor / operador de caixa</option><option value="COMPANY_ADMIN">Administrador</option></Select>}</Field>
        {!u && <TextField label="Senha inicial" value={f.password} onChange={set('password')} error={fe.password} hint="Mín. 8 caracteres, com letras e números. Será trocada no 1º acesso." required />}
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Salvar</Button></div>
      </form>
    </Modal>
  );
}

function ResetPw({ u, onClose, onDone }: { u: any; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => post(`/admin/users/${u.id}/reset-password`, { password: pw }), onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal open onClose={onClose} title={`Redefinir senha — ${u.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={m.isPending} disabled={pw.length < 8} onClick={() => m.mutate()}>Redefinir</Button></>}>
      <div className="space-y-3"><TextField label="Nova senha provisória" value={pw} onChange={(e) => setPw(e.target.value)} hint="Mín. 8 caracteres, com letras e números. As sessões abertas do usuário serão encerradas." autoFocus />{err && <p role="alert" className="text-sm font-medium text-red-600">{err}</p>}</div>
    </Modal>
  );
}

const ACTION: Record<string, string> = { 'auth.login': 'Login', 'auth.change_password': 'Troca de senha', 'sale.create': 'Venda', 'sale.cancel': 'Cancelamento de venda', 'sale.cancel_request': 'Solicitação de cancelamento', 'stock.entry': 'Entrada de estoque', 'stock.adjustment': 'Ajuste de estoque', 'product.create': 'Produto criado', 'product.update': 'Produto alterado', 'user.create': 'Usuário criado', 'user.update': 'Usuário alterado', 'user.reset_password': 'Senha redefinida', 'event.create': 'Evento criado', 'event.update': 'Evento alterado', 'settings.update': 'Configurações' };
function History({ u, onClose }: { u: any; onClose: () => void }) {
  const q = useQuery({ queryKey: ['user-history', u.id], queryFn: () => get(`/admin/users/${u.id}/history`) });
  return (
    <Modal open onClose={onClose} title={`Histórico — ${u.name}`} wide footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorBox error={q.error} /> : (
        <div className="space-y-3 text-sm">
          <p>Vendas concluídas: <b>{q.data.sales.completedCount}</b> · canceladas: <b>{q.data.sales.cancelledCount}</b> · total concluído: <b className="money">{brl(q.data.sales.netCents)}</b></p>
          <Table head={['Quando', 'Operação', 'Detalhes']}>
            {q.data.logs.map((l: any) => <tr key={l.id}><Td>{dt(l.createdAt)}</Td><Td>{ACTION[l.action] ?? l.action}</Td><Td className="max-w-xs truncate text-xs text-slate-500">{Object.keys(l.metadata).length ? JSON.stringify(l.metadata) : ''}</Td></tr>)}
          </Table>
        </div>)}
    </Modal>
  );
}
