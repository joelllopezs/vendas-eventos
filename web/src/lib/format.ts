const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = (cents: number) => brlFmt.format(cents / 100);

/** "37,50" | "37.5" | "1.234,56" → centavos (inteiro) ou null se inválido. Sem ponto flutuante. */
export function parseMoney(input: string): number | null {
  let s = input.trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}
export const centsToInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export const dt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
export const dateBr = (d: string) => d.split('-').reverse().join('/');

export const METHOD: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', DEBIT: 'Débito', CREDIT: 'Crédito' };
export const EVENT_TYPE: Record<string, string> = { PARTY: 'Festa', SHOW: 'Show', FESTIVAL: 'Festival', CORPORATE: 'Corporativo', SPORTS: 'Esportivo', OTHER: 'Outro' };
export const EVENT_STATUS: Record<string, string> = { PLANNED: 'Planejado', ACTIVE: 'Ativo', ENDED: 'Encerrado' };
export const MOVE_TYPE: Record<string, string> = { INITIAL: 'Estoque inicial', ENTRY: 'Entrada', ADJUSTMENT: 'Ajuste', SALE: 'Venda', SALE_CANCEL_RETURN: 'Devolução (cancelamento)' };

/** Início do dia local (AAAA-MM-DD) em ISO UTC; end = início do dia seguinte. */
export const dayStartISO = (d: string) => new Date(`${d}T00:00:00`).toISOString();
export const dayEndISO = (d: string) => {
  const x = new Date(`${d}T00:00:00`);
  x.setDate(x.getDate() + 1);
  return x.toISOString();
};
export const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
