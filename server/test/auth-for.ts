import type { CompanyAuth } from '../src/auth.js';
export function companyAuthFor(a: Partial<CompanyAuth> & Pick<CompanyAuth, 'userId' | 'companyId'>): CompanyAuth {
  return {
    kind: 'COMPANY', sessionId: 's', userName: 'u', login: 'u', companySlug: 'c', companyName: 'C',
    role: 'SELLER', mustChangePassword: false, cartTtlSeconds: 300, cancelPolicy: 'ADMIN_ONLY', ...a,
  };
}
