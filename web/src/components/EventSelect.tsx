import type { EventRow } from '../lib/hooks';
import { EVENT_STATUS } from '../lib/format';
import { Select } from './ui';

export function EventSelect({ events, value, onChange, allowAll }: { events: EventRow[]; value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Evento" className="!w-auto min-w-56">
      {allowAll && <option value="">Todos os eventos</option>}
      {events.map((e) => <option key={e.id} value={e.id}>{e.name} ({EVENT_STATUS[e.status]})</option>)}
    </Select>
  );
}

export const Pager = ({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) => {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-2 pt-3 text-sm text-slate-600">
      <span>{total} registro(s)</span>
      <div className="flex items-center gap-2">
        <button className="rounded-lg border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
        <span>Página {page} de {pages}</span>
        <button className="rounded-lg border px-3 py-1 disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</button>
      </div>
    </div>
  );
};
