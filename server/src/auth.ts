import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Pool } from './db/pool.js';
import { AppError, forbidden } from './lib/errors.js';
import { newToken, sha256 } from './lib/security.js';

export type Role = 'COMPANY_ADMIN' | 'SELLER';

export interface CompanyAuth {
  kind: 'COMPANY';
  sessionId: string;
  userId: string;
  userName: string;
  login: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  role: Role;
  mustChangePassword: boolean;
  cartTtlSeconds: number;
  cancelPolicy: 'ADMIN_ONLY' | 'SELLER_REQUEST' | 'SELLER_OWN';
}
export interface PlatformAuth {
  kind: 'PLATFORM';
  sessionId: string;
  adminId: string;
  name: string;
}
export type Auth = CompanyAuth | PlatformAuth;

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Auth;
  }
}

const secureFor = (req: FastifyRequest) => (config.cookieSecure === 'auto' ? req.protocol === 'https' : config.cookieSecure);

export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string) {
  reply.setCookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureFor(req),
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3600,
  });
}
export function clearSessionCookie(reply: FastifyReply, req: FastifyRequest) {
  reply.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureFor(req) });
}

export async function createSession(
  pool: Pool,
  who: { kind: 'COMPANY'; userId: string; companyId: string } | { kind: 'PLATFORM'; adminId: string },
  req: FastifyRequest,
): Promise<string> {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, kind, platform_admin_id, user_id, company_id, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), now() + make_interval(hours => $7), $8, $9)`,
    [
      sha256(token),
      who.kind,
      who.kind === 'PLATFORM' ? who.adminId : null,
      who.kind === 'COMPANY' ? who.userId : null,
      who.kind === 'COMPANY' ? who.companyId : null,
      config.sessionIdleHours,
      config.sessionAbsoluteHours,
      req.ip,
      (req.headers['user-agent'] ?? '').slice(0, 300),
    ],
  );
  return token;
}

interface SessionRow {
  id: string;
  kind: 'PLATFORM' | 'COMPANY';
  platform_admin_id: string | null;
  user_id: string | null;
  company_id: string | null;
  last_seen_at: Date;
  u_name: string | null;
  u_login: string | null;
  u_role: Role | null;
  u_active: boolean | null;
  must_change_password: boolean | null;
  c_status: string | null;
  c_slug: string | null;
  c_name: string | null;
  cart_ttl_seconds: number | null;
  cancel_policy: CompanyAuth['cancelPolicy'] | null;
  pa_name: string | null;
  pa_active: boolean | null;
}

export async function loadAuth(pool: Pool, token: string | undefined): Promise<Auth | null> {
  if (!token) return null;
  const { rows } = await pool.query<SessionRow>(
    `SELECT s.id, s.kind, s.platform_admin_id, s.user_id, s.company_id, s.last_seen_at,
            u.name u_name, u.login u_login, u.role u_role, u.active u_active, u.must_change_password,
            c.status c_status, c.slug c_slug, c.trade_name c_name, c.cart_ttl_seconds, c.cancel_policy,
            pa.name pa_name, pa.active pa_active
       FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN companies c ON c.id = s.company_id
       LEFT JOIN platform_admins pa ON pa.id = s.platform_admin_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        AND s.expires_at > now() AND s.absolute_expires_at > now()`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  // expiração deslizante (atualiza no máximo 1x/min)
  if (Date.now() - r.last_seen_at.getTime() > 60_000) {
    await pool.query(
      `UPDATE sessions SET last_seen_at = now(),
              expires_at = LEAST(now() + make_interval(hours => $2), absolute_expires_at)
        WHERE id = $1`,
      [r.id, config.sessionIdleHours],
    );
  }
  if (r.kind === 'PLATFORM') {
    if (!r.pa_active) return null;
    return { kind: 'PLATFORM', sessionId: r.id, adminId: r.platform_admin_id!, name: r.pa_name! };
  }
  if (!r.u_active || r.c_status !== 'ACTIVE') return null;
  return {
    kind: 'COMPANY',
    sessionId: r.id,
    userId: r.user_id!,
    userName: r.u_name!,
    login: r.u_login!,
    companyId: r.company_id!,
    companySlug: r.c_slug!,
    companyName: r.c_name!,
    role: r.u_role!,
    mustChangePassword: r.must_change_password!,
    cartTtlSeconds: r.cart_ttl_seconds!,
    cancelPolicy: r.cancel_policy!,
  };
}

const unauthorized = () => new AppError(401, 'UNAUTHENTICATED', 'Sessão inválida ou expirada. Entre novamente.');

export function companyGuard(pool: Pool, roles?: Role[]) {
  return async (req: FastifyRequest) => {
    const auth = await loadAuth(pool, req.cookies[config.cookieName]);
    if (!auth || auth.kind !== 'COMPANY') throw unauthorized();
    if (auth.mustChangePassword && !req.routeOptions.config?.allowMustChange) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Defina uma nova senha para continuar.');
    }
    if (roles && !roles.includes(auth.role)) throw forbidden();
    req.auth = auth;
  };
}

export function platformGuard(pool: Pool) {
  return async (req: FastifyRequest) => {
    const auth = await loadAuth(pool, req.cookies[config.cookieName]);
    if (!auth || auth.kind !== 'PLATFORM') throw unauthorized();
    req.auth = auth;
  };
}

export const co = (req: FastifyRequest) => req.auth as CompanyAuth;
export const plat = (req: FastifyRequest) => req.auth as PlatformAuth;

declare module 'fastify' {
  interface FastifyContextConfig {
    allowMustChange?: boolean;
  }
}
