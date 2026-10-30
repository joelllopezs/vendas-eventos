import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// argon2id (padrão do @node-rs/argon2 = Argon2id)
export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

let dummy: string | undefined;
/** Hash "fantasma": igualar o tempo de resposta quando o usuário não existe. */
export async function dummyVerify(pw: string) {
  dummy ??= await hashPassword('senha-fantasma-1');
  await verifyPassword(dummy, pw);
}
