# PDV Eventos — PDV multiempresa para eventos

Sistema web de ponto de venda para eventos: várias empresas isoladas, usuários (administrador/vendedor), estoque com **reserva no carrinho**, vendas, cancelamentos e relatórios. Backend Node/Fastify + PostgreSQL; frontend React/Tailwind servido pelo próprio backend.

Documentação técnica (arquitetura, modelo de dados, fluxos, riscos): [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Requisitos
Node 20+ (testado em 22), PostgreSQL 14+.

## Rodar com Docker (mais fácil)
```bash
docker compose up --build            # sobe banco + app; http://localhost:3000
# em outro terminal, crie o administrador da plataforma (pede a senha, mín. 10 caracteres):
docker compose exec -it app node server/dist/scripts/create-platform-admin.js --email voce@exemplo.com --name "Seu Nome"
```
Depois abra `http://localhost:3000/plataforma`, entre e cadastre sua primeira empresa (veja "Primeiro uso"). Os dados ficam no volume `pdvdata`; `docker compose down -v` apaga tudo.

## Executar localmente (sem Docker)
```bash
# 1) Banco
createdb pdv_eventos                  # e um usuário com senha; ajuste DATABASE_URL
cp server/.env.example server/.env    # edite DATABASE_URL (e COOKIE_SECURE=false para http://localhost)

# 2) Dependências e build
npm install
npm run build                         # compila web e server

# 3) Primeiro administrador DA PLATAFORMA (senha pedida no terminal, sem eco)
npm run create-platform-admin -- --email voce@exemplo.com --name "Seu Nome"

# 4) Subir (aplica as migrações sozinho)
npm start                             # http://localhost:3000
```
Desenvolvimento com recarga: `npm run dev:server` (porta 3000) e `npm run dev:web` (porta 5173, com proxy para `/api`).

## Primeiro uso
1. Acesse `/plataforma`, entre com o administrador da plataforma e **cadastre a empresa** (identificador de login + administrador inicial). Não existe cadastro público.
2. Na tela de login principal informe *código da empresa*, usuário e senha. A senha inicial deve ser trocada no primeiro acesso.
3. Como administrador: crie o **evento** (e ative-o), os **produtos** (com estoque inicial) e os **usuários vendedores**.
4. Vendedores entram no mesmo login e vão direto ao **PDV**. Administradores têm o botão "Abrir PDV".

## Publicar com Neon (banco) + Vercel (app)

O mesmo código roda como função serverless da Vercel (`api/index.mjs`, configurada em `vercel.json`). Sem processo em segundo plano: reservas vencidas são liberadas **sob demanda** (ao listar produtos, reservar, ver o dashboard) e também ao acessar o próprio carrinho, então o estoque nunca fica preso. Opcionalmente, no plano Pro, um Vercel Cron pode chamar `/api/internal/expire-carts` (defina `CRON_SECRET`).

**1. Neon**
1. Crie um projeto no Neon (região **AWS São Paulo – sa-east-1**, a mais próxima do evento) e um banco (ex.: `pdv_eventos`).
2. Em *Connect*, copie **duas** strings de conexão: a **Pooled** (host com `-pooler`) para o app e a **Direct** (sem `-pooler`) para migrações.
3. Aplique o esquema **uma vez**, do seu computador, usando a conexão **Direct** (as migrações usam trava de sessão, que não funciona no pooler). Crie `server/.env` com:
   ```
   DATABASE_URL=postgresql://USUARIO:SENHA@ep-xxxx.sa-east-1.aws.neon.tech/pdv_eventos?sslmode=require
   ```
   e rode `npm install`, `npm run migrate -w server` e `npm run create-platform-admin -- --email voce@exemplo.com --name "Seu Nome"`.

**2. Vercel**
1. Envie o projeto para um repositório no GitHub (o `.gitignore` já exclui `node_modules`, `dist` e `.env`) e importe-o na Vercel — ou use `npx vercel --prod` na pasta do projeto.
2. Em *Project Settings → General*, deixe **Root Directory** na raiz do projeto e o *Framework Preset* em **Other** (o `vercel.json` já define build, saída e rotas).
3. Em *Environment Variables* defina: `DATABASE_URL` = string **Pooled** do Neon (com `?sslmode=require`) e `DB_POOL_MAX` = `3`. Não é preciso definir `COOKIE_SECURE` (padrão `auto` já usa cookie Secure em HTTPS).
4. Faça o deploy e abra `https://SEU-PROJETO.vercel.app/plataforma`.

**Atenção:** o plano Hobby da Vercel é só para uso pessoal/não comercial; para uso comercial use o Pro. O limite de tentativas de login em memória vale por instância (o bloqueio de conta por tentativas é no banco e vale sempre).

## Testes
```bash
createdb pdv_test   # banco exclusivo de testes (as tabelas são esvaziadas a cada teste!)
TEST_DATABASE_URL=postgresql://usuario:senha@127.0.0.1:5432/pdv_test npm test
```
30 testes de integração contra PostgreSQL real cobrem os 18 itens exigidos (login, permissões, isolamento entre empresas, reservas, expiração, concorrência com 25 operadores, venda atômica, idempotência, troco, pagamentos, cancelamento e duplicidade, relatórios, recuperação de falhas).

## Publicação
- Rode atrás de **HTTPS** (Caddy/Nginx/plataforma gerenciada) com `COOKIE_SECURE=true` e `TRUST_PROXY=true`.
- `npm run build && npm start` — um único processo serve API e frontend; migrações rodam na partida (com trava, seguras com mais de uma instância).
- O job de expiração de reservas roda no servidor a cada 10 s; é seguro com várias instâncias (`SKIP LOCKED`).
- Faça backup do PostgreSQL (`pg_dump`) — vendas e estoque vivem apenas nele.

## Funcionalidades concluídas
Multiempresa com isolamento por `company_id` + FKs compostas · login com código da empresa, sessão no servidor, bloqueio por tentativas, troca obrigatória de senha · cadastro de empresas (somente plataforma) · eventos (um ativo por vez) · usuários e perfis · produtos, entradas, ajustes com justificativa, estoque baixo · PDV (busca, leitor de código de barras, carrinho, reserva no servidor com prazo configurável e renovação por atividade, expiração por job + lazy, aviso ao operador) · pagamento dinheiro (troco em centavos)/PIX/débito/crédito com confirmação manual · venda atômica e idempotente · cancelamento (3 políticas: só admin, solicitação, próprio vendedor) com devolução ao estoque · dashboard e relatórios com filtros · histórico de vendas e de movimentações (imutáveis) · auditoria · reconciliação de estoque.

## Limitações conhecidas
- **Sem integração de pagamento**: PIX/cartão são só registro manual informado pelo operador; o estorno de PIX/cartão no cancelamento é feito fora do sistema (o sistema marca "estorno externo obrigatório").
- Sem modo offline: se a internet cair no evento, não há venda (a tela mostra o erro; o reenvio é seguro pela chave de idempotência).
- Sem impressão de cupom/nota fiscal e sem emissão fiscal.
- Um único evento ativo por empresa por vez.
- Sem recuperação de senha por e-mail; o administrador redefine a senha do usuário. O administrador da plataforma é criado apenas por script.
- Relatórios exibem na tela (sem exportação CSV/PDF) e a competência é a data da venda.
- Não houve teste de carga em hardware de produção; a concorrência foi validada com 25 operadores simultâneos.
# vendas-eventos
