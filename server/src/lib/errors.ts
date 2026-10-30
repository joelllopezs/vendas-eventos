export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new AppError(404, 'NOT_FOUND', `${what} não encontrado.`);
export const forbidden = (msg = 'Você não tem permissão para esta ação.') =>
  new AppError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string, details?: Record<string, unknown>) =>
  new AppError(409, code, msg, details);
export const badRequest = (code: string, msg: string, details?: Record<string, unknown>) =>
  new AppError(400, code, msg, details);
