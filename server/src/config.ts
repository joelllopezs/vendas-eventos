function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Variável ${name} inválida: ${raw}`);
  return n;
}

export const isProd = process.env.NODE_ENV === 'production';
export const isTest = process.env.NODE_ENV === 'test';

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://pdv:pdv_dev_pw@127.0.0.1:5432/pdv_eventos',
  dbPoolMax: num('DB_POOL_MAX', 10),
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'pdv_session',
  // Em produção o cookie é Secure; defina COOKIE_SECURE=false só se publicar em HTTP puro (não recomendado).
  // 'auto' (padrão): Secure somente quando a requisição chegou por HTTPS (use TRUST_PROXY=true atrás de proxy).
  // 'true' força Secure; 'false' nunca usa Secure.
  cookieSecure: ((v) => (v === 'true' ? true : v === 'false' ? false : 'auto'))(process.env.COOKIE_SECURE ?? 'auto') as boolean | 'auto',
  sessionIdleHours: num('SESSION_IDLE_HOURS', 12),
  sessionAbsoluteHours: num('SESSION_ABSOLUTE_HOURS', 72),
  maxFailedLogins: num('MAX_FAILED_LOGINS', 5),
  lockMinutes: num('LOCK_MINUTES', 10),
  // Origens permitidas para requisições que alteram estado (além da própria origem do servidor).
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  expiryJobIntervalMs: num('EXPIRY_JOB_INTERVAL_MS', 10_000),
  cartMaxLifetimeMinutes: num('CART_MAX_LIFETIME_MINUTES', 60),
  rateLimitLoginMax: num('RATE_LIMIT_LOGIN_MAX', 20),
  webDistDir: process.env.WEB_DIST_DIR ?? '',
  timezone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
} as const;
