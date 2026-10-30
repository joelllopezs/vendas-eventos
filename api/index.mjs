// Função serverless da Vercel: reaproveita o mesmo app Fastify do servidor tradicional.
// (O servidor contínuo continua em server/dist/server.js para uso local/Docker/VPS.)
import { buildApp } from '../server/dist/app.js';
import { createPool } from '../server/dist/db/pool.js';

let appPromise;
function getApp() {
  appPromise ??= (async () => {
    // Em serverless mantenha poucas conexões por instância (use a URL "pooler" do Neon).
    const pool = createPool(process.env.DATABASE_URL, Number(process.env.DB_POOL_MAX ?? 3));
    const app = await buildApp(pool);
    await app.ready();
    return app;
  })().catch((err) => {
    appPromise = undefined; // permite nova tentativa na próxima requisição
    throw err;
  });
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  app.server.emit('request', req, res);
}
