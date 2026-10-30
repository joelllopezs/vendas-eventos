import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { ApiError } from '../lib/api';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const V: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300',
  ghost: 'text-slate-700 hover:bg-slate-200/70 disabled:text-slate-400',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300',
};
export function Button({ variant = 'primary', loading, className, children, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...p}
      disabled={disabled || loading}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed', V[variant], className)}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}

export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">{label}</label>
      {children(id)}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-500 disabled:bg-slate-100';
export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...p} className={cx(inputCls, className)} />;
}
export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(inputCls, className)} />;
}
export function TextField({ label, error, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{(id) => <Input id={id} {...p} />}</Field>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONE: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  slate: 'bg-slate-100 text-slate-700',
  blue: 'bg-sky-100 text-sky-800',
};
export const Badge = ({ tone = 'slate', children }: { tone?: keyof typeof TONE; children: ReactNode }) => (
  <span className={cx('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone])}>{children}</span>
);

export function Modal({ open, onClose, title, children, wide, footer, locked }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode; locked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !locked && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, onClose, locked]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-md')}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {!locked && <button onClick={onClose} aria-label="Fechar" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">✕</button>}
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts
type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { id, kind, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {list.map((t) => (
          <div key={t.id} role={t.kind === 'err' ? 'alert' : 'status'}
            className={cx('pointer-events-auto max-w-md rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg', t.kind === 'err' ? 'bg-red-600' : 'bg-emerald-600')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Erro inesperado. Tente novamente.');
export const fieldErrors = (e: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && e.code === 'VALIDATION') for (const i of e.details?.issues ?? []) out[i.path] ??= i.message;
  return out;
};

export function Loading({ text = 'Carregando…' }: { text?: string }) {
  return <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Spinner /> {text}</div>;
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {errMsg(error)} {retry && <button className="ml-2 font-semibold underline" onClick={retry}>Tentar de novo</button>}
    </div>
  );
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="p-6 text-center text-sm text-slate-500">{children}</p>;

export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full min-w-max text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>{head.map((h, i) => <th key={i} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <td className={cx('px-3 py-2 align-middle', right && 'text-right money', className)}>{children}</td>
);

export function Confirm({ open, title, message, confirmLabel = 'Confirmar', danger, onConfirm, onClose, loading }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void; loading?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Voltar</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="text-sm text-slate-700">{message}</div>
    </Modal>
  );
}
