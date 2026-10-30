import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import type { Me } from '../auth';
import { post } from '../lib/api';
import { cx } from './ui';

const NAV = [
  ['/admin', 'Dashboard', true],
  ['/admin/vendas', 'Vendas', false],
  ['/admin/produtos', 'Produtos e estoque', false],
  ['/admin/movimentacoes', 'Movimentações', false],
  ['/admin/eventos', 'Eventos', false],
  ['/admin/usuarios', 'Usuários', false],
  ['/admin/configuracoes', 'Configurações', false],
] as const;

export default function AdminLayout({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  async function logout() {
    try { await post('/auth/logout'); } finally { qc.clear(); qc.setQueryData(['me'], null); }
  }
  const nav = (
    <nav className="flex flex-col gap-1 p-3" aria-label="Principal">
      {NAV.map(([to, label, end]) => (
        <NavLink key={to} to={to} end={end} onClick={() => setOpen(false)}
          className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-slate-800')}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-full">
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 lg:flex">
        <div className="px-5 py-5"><p className="text-xs uppercase tracking-wider text-slate-400">Empresa</p><p className="truncate font-bold text-white">{me.company.name}</p></div>
        {nav}
        <div className="mt-auto space-y-2 p-3">
          <Link to="/pdv" className="block rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-emerald-700">Abrir PDV</Link>
          <button onClick={logout} className="w-full rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Sair ({me.user.name})</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white lg:hidden">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-slate-600">Menu</button>
          <span className="truncate px-2 text-sm font-semibold">{me.company.name}</span>
          <Link to="/pdv" className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold">PDV</Link>
        </header>
        {open && <div className="bg-slate-900 lg:hidden">{nav}<button onClick={logout} className="w-full px-6 py-3 text-left text-sm text-slate-300">Sair ({me.user.name})</button></div>}
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-4 p-4 lg:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
