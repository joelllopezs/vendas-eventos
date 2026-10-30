import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AuthShell, COOKIE_MSG, PasswordInput } from './Login';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, Table, Td, TextField, errMsg, fieldErrors, useToast } from '../components/ui';
import { ApiError, get, patch, post } from '../lib/api';
import { dt } from '../lib/format';

export default function Platform() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['platform-me'],
    queryFn: async () => { try { return await get('/platform/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } },
  });
  if (me.isLoading) return <Loading />;
  if (!me.data) return <PlatformLogin onDone={() => qc.invalidateQueries({ queryKey: ['platform-me'] })} />;
  return <Companies name={me.data.admin.name} onLogout={async () => { await post('/platform/logout'); qc.setQueryData(['platform-me'], null); }} />;
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post('/platform/login', { email, password: pw }); await get('/platform/me').catch(() => { throw new Error(COOKIE_MSG); }); onDone(); } catch (x) { setErr(x instanceof Error && x.message === COOKIE_MSG ? COOKIE_MSG : errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Administração da plataforma" subtitle="Acesso restrito para cadastro de empresas.">
      <form onSubmit={submit} className="space-y-4">
        <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <Field label="Senha">{(id) => <PasswordInput id={id} value={pw} onChange={setPw} autoComplete="current-password" />}</Field>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
        <Button type="submit" loading={busy} className="w-full py-3">Entrar</Button>
      </form>
    </AuthShell>
  );
}

function Companies({ name, onLogout }: { name: string; onLogout: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const list = useQuery({ queryKey: ['companies'], queryFn: () => get('/platform/companies') });
  const [open, setOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: (c: any) => patch(`/platform/companies/${c.id}`, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['companies'] }), onError: (e) => toast('err', errMsg(e)),
  });
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex items-center justify-between"><h1 className="text-xl font-bold">Empresas</h1><div className="flex items-center gap-2"><span className="text-sm text-slate-600">{name}</span><Button variant="secondary" onClick={onLogout}>Sair</Button></div></header>
      <Card title="Empresas cadastradas" actions={<Button onClick={() => setOpen(true)}>Nova empresa</Button>}>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorBox error={list.error} /> : (
          <Table head={['Código de login', 'Nome fantasia', 'Contato', 'Usuários', 'Eventos', 'Status', 'Criada em', '']}>
            {list.data.companies.map((c: any) => (
              <tr key={c.id}><Td><code className="rounded bg-slate-100 px-1.5 py-0.5">{c.slug}</code></Td><Td>{c.tradeName}</Td><Td>{c.contactEmail}<br /><span className="text-xs text-slate-500">{c.phone}</span></Td><Td right>{c.usersCount}</Td><Td right>{c.eventsCount}</Td>
                <Td><Badge tone={c.status === 'ACTIVE' ? 'green' : 'slate'}>{c.status === 'ACTIVE' ? 'Ativa' : 'Inativa'}</Badge></Td><Td>{dt(c.createdAt)}</Td>
                <Td><Button variant="ghost" onClick={() => toggle.mutate(c)}>{c.status === 'ACTIVE' ? 'Desativar' : 'Ativar'}</Button></Td></tr>
            ))}
          </Table>
        )}
      </Card>
      <NewCompany open={open} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); qc.invalidateQueries({ queryKey: ['companies'] }); toast('ok', 'Empresa cadastrada.'); }} />
    </div>
  );
}

function NewCompany({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const empty = { tradeName: '', legalName: '', cnpj: '', contactEmail: '', phone: '', slug: '', status: 'ACTIVE', adminName: '', adminLogin: '', adminPassword: '' };
  const [f, setF] = useState(empty); const [fe, setFe] = useState<Record<string, string>>({}); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFe({});
    try {
      await post('/platform/companies', { tradeName: f.tradeName, legalName: f.legalName || null, cnpj: f.cnpj || null, contactEmail: f.contactEmail, phone: f.phone, slug: f.slug, status: f.status,
        admin: { name: f.adminName, login: f.adminLogin, password: f.adminPassword } });
      setF(empty); onCreated();
    } catch (x) { setFe(fieldErrors(x)); setErr(errMsg(x)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Nova empresa" wide>
      <form id="newco" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nome fantasia" value={f.tradeName} onChange={set('tradeName')} error={fe.tradeName} required />
        <TextField label="Razão social (opcional)" value={f.legalName} onChange={set('legalName')} />
        <TextField label="CNPJ (opcional)" value={f.cnpj} onChange={set('cnpj')} error={fe.cnpj} inputMode="numeric" />
        <TextField label="Telefone" value={f.phone} onChange={set('phone')} error={fe.phone} required />
        <TextField label="E-mail de contato" type="email" value={f.contactEmail} onChange={set('contactEmail')} error={fe.contactEmail} required />
        <TextField label="Identificador de login" value={f.slug} onChange={set('slug')} error={fe.slug} hint="Usado na tela de login (a-z, 0-9, hífen)." autoCapitalize="none" required />
        <Field label="Status">{(id) => <select id={id} value={f.status} onChange={set('status')} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"><option value="ACTIVE">Ativa</option><option value="INACTIVE">Inativa</option></select>}</Field>
        <div className="sm:col-span-2 border-t pt-3 text-sm font-semibold text-slate-700">Administrador inicial</div>
        <TextField label="Nome" value={f.adminName} onChange={set('adminName')} error={fe['admin.name']} required />
        <TextField label="Login" value={f.adminLogin} onChange={set('adminLogin')} error={fe['admin.login']} autoCapitalize="none" required />
        <TextField label="Senha inicial" type="text" value={f.adminPassword} onChange={set('adminPassword')} error={fe['admin.password']} hint="Será obrigatório trocar no primeiro acesso." required />
        {err && <p role="alert" className="sm:col-span-2 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{err}</p>}
        <div className="sm:col-span-2 flex justify-end gap-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" loading={busy}>Cadastrar empresa</Button></div>
      </form>
    </Modal>
  );
}
