import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, get, onUnauthenticated } from './lib/api';

export interface Me {
  user: { id: string; name: string; login: string; role: 'COMPANY_ADMIN' | 'SELLER' };
  company: { id: string; slug: string; name: string };
  mustChangePassword: boolean;
  cancelPolicy: 'ADMIN_ONLY' | 'SELLER_REQUEST' | 'SELLER_OWN';
  cartTtlSeconds: number;
}

export function useMe() {
  const qc = useQueryClient();
  useEffect(() => onUnauthenticated(() => { qc.setQueryData(['me'], null); }), [qc]);
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try { return await get<Me>('/auth/me'); } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
export const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* indisponível */ } };
