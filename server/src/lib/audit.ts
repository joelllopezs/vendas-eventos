import type { Q } from '../db/pool.js';

export interface AuditEntry {
  companyId: string | null;
  actorType: 'PLATFORM_ADMIN' | 'USER' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(q: Q, e: AuditEntry) {
  await q.query(
    `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.companyId,
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      JSON.stringify(e.metadata ?? {}),
      e.ip ?? null,
    ],
  );
}
