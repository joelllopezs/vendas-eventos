export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, any>) {
    super(message);
  }
}

type Listener = () => void;
const onUnauth = new Set<Listener>();
export const onUnauthenticated = (fn: Listener) => (onUnauth.add(fn), () => { onUnauth.delete(fn); });

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Verifique a rede e tente novamente.');
  }
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && e?.code === 'UNAUTHENTICATED') onUnauth.forEach((f) => f());
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Erro inesperado.', e?.details);
  }
  return json as T;
}
function safeJson(t: string) {
  try { return JSON.parse(t); } catch { return null; }
}
export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});
export const patch = <T = any>(u: string, b: unknown) => api<T>('PATCH', u, b);
export const del = <T = any>(u: string) => api<T>('DELETE', u);

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
