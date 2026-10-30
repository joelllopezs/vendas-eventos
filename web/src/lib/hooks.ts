import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get } from './api';

export interface EventRow { id: string; name: string; type: string; city: string; state: string; startsOn: string; endsOn: string | null; description: string | null; status: 'PLANNED' | 'ACTIVE' | 'ENDED' }

export function useEvents() {
  return useQuery({ queryKey: ['events'], queryFn: () => get<{ events: EventRow[] }>('/admin/events') });
}

/** Evento selecionado (padrão: o ativo; senão o mais recente). */
export function useEventSelection(allowAll = false) {
  const ev = useEvents();
  const [id, setId] = useState<string>('');
  useEffect(() => {
    if (id || !ev.data) return;
    const list = ev.data.events;
    setId(list.find((e) => e.status === 'ACTIVE')?.id ?? (allowAll ? '' : list[0]?.id ?? ''));
  }, [ev.data, id, allowAll]);
  return { events: ev.data?.events ?? [], eventId: id, setEventId: setId, loading: ev.isLoading, query: ev };
}

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: () => get<{ users: any[] }>('/admin/users') });
}
