// Uso: npm run create-platform-admin -- --email voce@exemplo.com --name "Seu Nome"
// A senha é pedida no terminal (sem eco) ou lida de PLATFORM_ADMIN_PASSWORD (automação).
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { config } from '../config.js';
import { hashPassword } from '../lib/security.js';
import { runMigrations } from '../db/migrate.js';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    return await new Promise((res) => rl.once('line', (l) => (rl.close(), res(l))));
  }
  process.stdout.write(prompt);
  return await new Promise((resolve) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', function onData(ch) {
      const s = ch.toString('utf8');
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    });
  });
}

// Aceita --email/--name, variáveis PLATFORM_ADMIN_EMAIL/NAME ou argumentos posicionais (npm aninhado perde as flags).
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const email = (arg('email') ?? process.env.PLATFORM_ADMIN_EMAIL ?? positional[0])?.trim().toLowerCase();
const name = (arg('name') ?? process.env.PLATFORM_ADMIN_NAME ?? positional[1])?.trim();
if (!email || !name) {
  console.error('Uso: npm run create-platform-admin -- --email <email> --name "<nome>"');
  process.exit(1);
}
const pw = process.env.PLATFORM_ADMIN_PASSWORD ?? (await askHidden('Senha (mín. 10 caracteres): '));
if (pw.length < 10) {
  console.error('A senha deve ter pelo menos 10 caracteres.');
  process.exit(1);
}
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  await runMigrations(pool);
  await pool.query(
    `INSERT INTO platform_admins (email, name, password_hash) VALUES ($1,$2,$3)
     ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, active = true, failed_logins = 0, locked_until = NULL`,
    [email, name, await hashPassword(pw)],
  );
  console.log(`Administrador da plataforma "${email}" criado/atualizado.`);
} finally {
  await pool.end();
}
