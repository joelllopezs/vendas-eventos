# Arquitetura — PDV Multiempresa para Eventos

## 1. Ambiente analisado

- Diretório vazio (sem projeto prévio). Node 22, npm 10, PostgreSQL 16 disponível.
- O download dos binários do Prisma (`binaries.prisma.sh`) é bloqueado no ambiente de desenvolvimento
  (403), então `prisma generate/migrate` não executam. Conforme o prompt ("Prisma ou alternativa
  equivalente"), a camada de dados usa **`pg` com SQL explícito + migrações SQL versionadas**. Não há binários
  externos para baixar, e a lógica crítica de estoque é SQL atômico explícito.

## 2. Stack

| Camada | Escolha |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS 4 + React Query + React Router |
| Backend | Node 22 + TypeScript + Fastify 5 |
| Banco | PostgreSQL 16 |
| Acesso a dados | `pg` com SQL parametrizado explícito (sem ORM); migrações `.sql` próprias com checksum (`server/migrations`) |
| Validação | Zod (backend é a autoridade; o frontend reaproveita as mesmas regras de negócio simples) |
| Senhas | argon2id (`@node-rs/argon2`) |
| Testes | Vitest contra um PostgreSQL real (banco `pdv_test`) |

Em produção o próprio Fastify serve o build do frontend (mesma origem → cookie de sessão
`HttpOnly; SameSite=Lax; Secure`, sem CORS aberto).

## 3. Multiempresa (multi-tenant)

- **Isolamento lógico:** toda tabela de negócio tem `company_id`. O `company_id` **vem sempre da
  sessão no servidor**, nunca do corpo/URL da requisição. Toda consulta filtra por ele.
- **Isolamento no banco (defesa em profundidade):** chaves estrangeiras **compostas**
  (`(event_id, company_id)`, `(product_id, company_id, event_id)`, …). Mesmo um bug no código não
  consegue ligar um registro de uma empresa a um evento/produto/usuário de outra.
- IDs de outra empresa respondem **404** (não 403), para não revelar existência.
- Administrador da **plataforma** é outra entidade (`platform_admins`), com login próprio e sem
  empresa. Só ele cria empresas. Não existe cadastro público. O primeiro é criado por script CLI.

## 4. Autenticação e permissões

- Sessão **no servidor** (tabela `sessions`): cookie opaco aleatório de 256 bits; o banco guarda só o
  SHA-256 do token. Desativar usuário/empresa ou trocar senha revoga na hora.
- Expiração por inatividade (12 h, deslizante) e limite absoluto (3 dias). Logout revoga.
- Login: `empresa (slug) + usuário/e-mail + senha`. Mensagem genérica para credenciais inválidas;
  bloqueio temporário após 5 falhas; rate limit por IP. Hash "fantasma" para igualar tempo quando o
  usuário não existe.
- Perfis: `COMPANY_ADMIN` e `SELLER`. Guardas por rota no backend (`requireRole`). O administrador da
  empresa também pode operar o PDV (decisão: superconjunto do vendedor).
- Senha inicial/redefinida → `must_change_password`: o backend bloqueia todo o resto até a troca.
- CSRF: `SameSite=Lax` + verificação de `Origin` em métodos que alteram estado.

## 5. Modelo de dados (resumo)

Valores monetários: **inteiros em centavos** (`INTEGER`/`BIGINT`), nunca ponto flutuante.

```
platform_admins   sessions   audit_logs(append-only)
companies ──< users
          ──< events ──< products ──1:1── stock (physical_qty, reserved_qty)
                    │                         │
                    ├──< carts ──< cart_items │
                    │        └──< stock_reservations (ACTIVE/CONSUMED/RELEASED/EXPIRED)
                    ├──< sales ──< sale_items (snapshot de preço/nome)
                    │        ├──1 payments (método, recebido, troco)
                    │        └──0..1 sale_cancellations (UNIQUE sale_id)
                    │   cancellation_requests
                    └──< stock_movements(append-only: saldo antes/depois)
```

Garantias **no banco** (não só no código):
- `stock`: `CHECK (physical_qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= physical_qty)` →
  estoque negativo ou venda de unidade reservada por outro é impossível mesmo com bug.
- Um carrinho `ACTIVE` por usuário (índice único parcial); um evento `ACTIVE` por empresa.
- `sales (operator_id, idempotency_key)` único → venda duplicada impossível.
- `sale_cancellations.sale_id` único → cancelamento duplicado impossível.
- Triggers de imutabilidade: `stock_movements`, `audit_logs`, `sale_items`, `payments` não aceitam
  UPDATE/DELETE; `sales` só aceita a transição `COMPLETED → CANCELLED` sem alterar valores; DELETE
  proibido.

## 6. Estoque: três números

`disponível = físico − reservado`.

- **Reservar** (ao adicionar/aumentar no carrinho): um único `UPDATE … SET reserved_qty = reserved_qty + n
  WHERE physical_qty − reserved_qty >= n RETURNING …`. Atômico: com 2 operadores disputando a última
  unidade, exatamente um UPDATE afeta a linha. Zero linhas = indisponível.
- **Liberar** (diminuir/remover/limpar/expirar): decrementa `reserved_qty`; físico intocado.
- **Vender**: baixa `physical_qty` **e** `reserved_qty` juntos, consome a reserva, grava movimento
  `SALE` (saldo antes/depois).
- **Cancelar venda**: soma ao `physical_qty`, grava movimento `SALE_CANCEL_RETURN`.
- Reservas **não** são movimentos físicos: o rastro delas é a tabela `stock_reservations` (com status e
  horários). Movimentos físicos ficam em `stock_movements`.
- Ordem de travamento sempre por `product_id` crescente (evita deadlock).
- `reconcileStock()` recalcula `reserved_qty` a partir das reservas ativas e corrige/reporta desvios.

## 7. Expiração de reservas

- A validade é do **carrinho**: `carts.expires_at = agora + TTL` (TTL da empresa, padrão 300 s).
- **Regra única de renovação:** cada alteração do carrinho e cada "toque" de atividade do operador
  (frontend, só com interação real, limitado a 1 a cada 30 s) renova para `agora + TTL`, sem passar de
  60 min desde a criação do carrinho (evita aba esquecida segurar estoque).
- **Mecanismo no servidor (não depende do navegador):**
  1. Job periódico (10 s) libera carrinhos vencidos com `FOR UPDATE SKIP LOCKED` (seguro com várias
     instâncias).
  2. Expiração *lazy*: qualquer operação/leitura do carrinho, e o checkout, verificam `expires_at` e
     expiram na hora, mesmo que o job ainda não tenha rodado. O resultado não depende do timing do job.
- O operador é avisado: o próximo `GET /pdv/cart` devolve o aviso de expiração (uma vez) com os itens.

## 8. Fluxo de finalização (uma transação)

`POST /pdv/cart/checkout` com `idempotencyKey` (gerada pelo cliente por tentativa) e `expectedTotalCents`.

1. Trava a linha do carrinho (`FOR UPDATE`). Se já `COMPLETED` e há venda com a mesma chave → devolve a
   venda existente (reenvio/duplo clique **não** duplica).
2. Valida sessão, empresa, evento `ACTIVE`, operador, carrinho `ACTIVE` e não expirado, produtos
   ativos, reservas íntegras.
3. Recalcula preços/total **no servidor**; se diferir de `expectedTotalCents` → `PRICE_CHANGED`.
4. Valida pagamento: dinheiro (recebido ≥ total, troco em centavos) ou PIX/débito/crédito com
   confirmação manual do operador (sem integração externa; o sistema não afirma cobrança).
5. Número sequencial da venda por evento; insere `sales`, `sale_items` (snapshot), `payments`.
6. Trava `stock` ordenado; baixa físico+reservado; consome reservas; grava `stock_movements`.
7. Fecha carrinho; grava auditoria. **Commit.** Qualquer falha → rollback total.

## 9. Fluxo de cancelamento (uma transação)

Política por empresa: `ADMIN_ONLY` (padrão), `SELLER_REQUEST` (vendedor solicita, admin aprova) ou
`SELLER_OWN` (vendedor cancela só as próprias vendas).
Exige confirmação + motivo. Trava a venda, exige `COMPLETED`, marca `CANCELLED`, devolve itens ao
estoque do evento correto, grava movimentos e `sale_cancellations`. Para PIX/crédito/débito registra
`requires_external_refund = true` (estorno financeiro é feito fora do sistema). Para dinheiro grava o
valor original e o reembolso informado. A venda nunca é apagada.

## 10. Relatórios (regra de competência)

Competência = **data da venda**. Faturamento bruto = soma das vendas feitas no período
(`COMPLETED` + `CANCELLED`); vendas canceladas = valor original das `CANCELLED`; líquido = bruto −
canceladas. Carrinhos e reservas nunca entram. Tudo calculado por SQL no momento da consulta.

## 11. Riscos de concorrência/inconsistência e mitigação

| Risco | Mitigação |
|---|---|
| Duas reservas disputando a última unidade | UPDATE condicional atômico + CHECK no banco |
| Duplo clique/reenvio no checkout | Trava do carrinho + `idempotencyKey` único |
| Cancelamento simultâneo da mesma venda | Trava da venda + UNIQUE em `sale_cancellations.sale_id` |
| Deadlock entre transações | Ordem fixa de travamento (carrinho/venda → evento → estoque por `product_id`) |
| Navegador fechado com reserva aberta | Job no servidor + expiração lazy |
| Deriva do contador `reserved_qty` | `reconcileStock()` + invariantes verificadas nos testes |
| Preço alterado com item no carrinho | `expectedTotalCents` no checkout |
| Administração apagando histórico | Triggers de imutabilidade no banco |
| Acesso cruzado entre empresas | `company_id` da sessão + FKs compostas + 404 |
