import { useState, type FormEvent } from 'react';
import { lsGet, lsSet } from '../auth';
import { Button, Field, Input, errMsg, fieldErrors } from '../components/ui';
import { get, post } from '../lib/api';

export const COOKIE_MSG = 'Login aceito, mas o navegador não guardou a sessão (cookie bloqueado). Acesse por http://localhost:3000 (ou por HTTPS) e confira COOKIE_SECURE no servidor.';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center bg-gradient-to-br from-slate-900 via-slate-900 to-brand-700 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl sm:p-8">
        <div className="mb-6">
          <div className="mb-3 grid size-11 place-items-center rounded-xl bg-brand-600 text-xl font-black text-white" aria-hidden>PDV</div>
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

export function PasswordInput(p: { id: string; value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={p.id} type={show ? 'text' : 'password'} value={p.value} onChange={(e) => p.onChange(e.target.value)} autoComplete={p.autoComplete} className="pr-20" required />
      <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} className="absolute inset-y-0 right-2 my-auto h-7 rounded px-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">
        {show ? 'Ocultar' : 'Mostrar'}
      </button>
    </div>
  );
}

export default function Login({ onDone }: { onDone: () => void }) {
  const [company, setCompany] = useState(lsGet('pdv.company'));
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { company, login, password });
      lsSet('pdv.company', company.trim().toLowerCase());
      await get('/auth/me').catch(() => { throw new Error(COOKIE_MSG); });
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message === COOKIE_MSG ? COOKIE_MSG : errMsg(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthShell title="Entrar no PDV" subtitle="Informe o código da sua empresa e suas credenciais.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Empresa (código)">{(id) => <Input id={id} value={company} onChange={(e) => setCompany(e.target.value)} autoCapitalize="none" autoComplete="organization" placeholder="ex.: minha-empresa" required autoFocus={!company} />}</Field>
        <Field label="Usuário ou e-mail">{(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" autoComplete="username" required autoFocus={!!company} />}</Field>
        <Field label="Senha">{(id) => <PasswordInput id={id} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p>}
        <Button type="submit" loading={busy} className="w-full py-3" disabled={!company || !login || !password}>Entrar</Button>
      </form>
    </AuthShell>
  );
}

export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError('A confirmação não confere com a nova senha.');
    setBusy(true); setError(null); setFe({});
    try {
      await post('/auth/change-password', { currentPassword: cur, newPassword: next });
      onDone();
    } catch (err) {
      setFe(fieldErrors(err)); setError(errMsg(err));
    } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Defina uma nova senha" subtitle="Por segurança, troque a senha inicial antes de continuar.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Senha atual (inicial)">{(id) => <PasswordInput id={id} value={cur} onChange={setCur} autoComplete="current-password" />}</Field>
        <Field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números." error={fe.newPassword}>{(id) => <PasswordInput id={id} value={next} onChange={setNext} autoComplete="new-password" />}</Field>
        <Field label="Repita a nova senha">{(id) => <PasswordInput id={id} value={again} onChange={setAgain} autoComplete="new-password" />}</Field>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p>}
        <Button type="submit" loading={busy} className="w-full py-3">Salvar e continuar</Button>
      </form>
    </AuthShell>
  );
}
