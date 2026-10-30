import { z } from 'zod';
import { AppError } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(400, 'VALIDATION', 'Dados inválidos.', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const uuid = z.uuid({ message: 'Identificador inválido.' });
export const cents = z.number().int().min(0).max(100_000_000);
export const trimmed = (min = 1, max = 200) => z.string().trim().min(min).max(max);
export const optText = (max = 1000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v));
export const password = z
  .string()
  .min(8, 'A senha deve ter pelo menos 8 caracteres.')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'A senha deve ter letras e números.');
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');
