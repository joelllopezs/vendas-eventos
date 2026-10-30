-- 0001_init.sql — esquema inicial do PDV multiempresa para eventos
-- Valores monetários: inteiros em centavos. Datas/horas: timestamptz (UTC).
-- Isolamento multiempresa: toda tabela de negócio carrega company_id e os vínculos entre
-- tabelas usam chaves estrangeiras COMPOSTAS, para que o próprio banco impeça ligar
-- registros de empresas diferentes.

-- ---------------------------------------------------------------------------
-- Plataforma
-- ---------------------------------------------------------------------------
CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

CREATE TABLE companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  trade_name        text NOT NULL CHECK (length(btrim(trade_name)) > 0),
  legal_name        text,
  cnpj              text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  contact_email     text NOT NULL,
  phone             text NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  cart_ttl_seconds  int  NOT NULL DEFAULT 300 CHECK (cart_ttl_seconds BETWEEN 30 AND 3600),
  cancel_policy     text NOT NULL DEFAULT 'ADMIN_ONLY'
                    CHECK (cancel_policy IN ('ADMIN_ONLY', 'SELLER_REQUEST', 'SELLER_OWN')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_cnpj_uq ON companies (cnpj) WHERE cnpj IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Usuários e sessões
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  name                 text NOT NULL CHECK (length(btrim(name)) > 0),
  login                text NOT NULL CHECK (login ~ '^[a-z0-9._@+-]{3,60}$'),
  email                text,
  password_hash        text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('COMPANY_ADMIN', 'SELLER')),
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, login)
);
CREATE UNIQUE INDEX users_company_email_uq ON users (company_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_company_idx ON users (company_id);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          text NOT NULL UNIQUE,
  kind                text NOT NULL CHECK (kind IN ('PLATFORM', 'COMPANY')),
  platform_admin_id   uuid REFERENCES platform_admins (id),
  user_id             uuid,
  company_id          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip                  text,
  user_agent          text,
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id),
  CHECK (
    (kind = 'PLATFORM' AND platform_admin_id IS NOT NULL AND user_id IS NULL AND company_id IS NULL)
    OR
    (kind = 'COMPANY' AND platform_admin_id IS NULL AND user_id IS NOT NULL AND company_id IS NOT NULL)
  )
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_platform_idx ON sessions (platform_admin_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Eventos
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  type             text NOT NULL CHECK (type IN ('PARTY', 'SHOW', 'FESTIVAL', 'CORPORATE', 'SPORTS', 'OTHER')),
  city             text NOT NULL,
  state            char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  starts_on        date NOT NULL,
  ends_on          date,
  description      text,
  status           text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'ACTIVE', 'ENDED')),
  next_sale_number int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  UNIQUE (id, company_id)
);
CREATE INDEX events_company_idx ON events (company_id, starts_on DESC);
-- No máximo um evento ATIVO por empresa: o PDV sabe sempre em qual evento vender.
CREATE UNIQUE INDEX events_one_active_per_company ON events (company_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Produtos e estoque (por evento)
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  event_id      uuid NOT NULL,
  internal_code text NOT NULL CHECK (length(btrim(internal_code)) > 0),
  barcode       text CHECK (barcode IS NULL OR length(btrim(barcode)) > 0),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  category      text,
  description   text,
  price_cents   int NOT NULL CHECK (price_cents > 0 AND price_cents <= 100000000),
  cost_cents    int CHECK (cost_cents IS NULL OR cost_cents >= 0),
  min_stock     int NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, company_id) REFERENCES events (id, company_id),
  UNIQUE (id, company_id, event_id),
  UNIQUE (event_id, internal_code)
);
CREATE UNIQUE INDEX products_barcode_uq ON products (event_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_event_name_idx ON products (event_id, lower(name));

CREATE TABLE stock (
  product_id   uuid PRIMARY KEY,
  company_id   uuid NOT NULL,
  event_id     uuid NOT NULL,
  physical_qty int NOT NULL DEFAULT 0,
  reserved_qty int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, company_id, event_id) REFERENCES products (id, company_id, event_id),
  CONSTRAINT stock_non_negative CHECK (physical_qty >= 0 AND reserved_qty >= 0),
  CONSTRAINT stock_reserved_le_physical CHECK (reserved_qty <= physical_qty)
);
CREATE INDEX stock_event_idx ON stock (company_id, event_id);

-- ---------------------------------------------------------------------------
-- Carrinhos e reservas
-- ---------------------------------------------------------------------------
CREATE TABLE carts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL,
  event_id              uuid NOT NULL,
  user_id               uuid NOT NULL,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED')),
  expires_at            timestamptz NOT NULL,
  expiry_notice_pending boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  FOREIGN KEY (event_id, company_id) REFERENCES events (id, company_id),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id),
  UNIQUE (id, company_id),
  UNIQUE (id, company_id, event_id)
);
-- Um carrinho ativo por operador (impede duplicidade por cliques repetidos).
CREATE UNIQUE INDEX carts_one_active_per_user ON carts (user_id) WHERE status = 'ACTIVE';
CREATE INDEX carts_expiry_idx ON carts (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX carts_user_idx ON carts (user_id, created_at DESC);

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id    uuid NOT NULL,
  company_id uuid NOT NULL,
  event_id   uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity   int NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cart_id, company_id, event_id) REFERENCES carts (id, company_id, event_id),
  FOREIGN KEY (product_id, company_id, event_id) REFERENCES products (id, company_id, event_id),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE stock_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  event_id    uuid NOT NULL,
  cart_id     uuid NOT NULL,
  product_id  uuid NOT NULL,
  quantity    int NOT NULL CHECK (quantity > 0),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (cart_id, company_id, event_id) REFERENCES carts (id, company_id, event_id),
  FOREIGN KEY (product_id, company_id, event_id) REFERENCES products (id, company_id, event_id),
  CHECK ((status = 'ACTIVE' AND resolved_at IS NULL) OR (status <> 'ACTIVE' AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX stock_reservations_one_active ON stock_reservations (cart_id, product_id) WHERE status = 'ACTIVE';
CREATE INDEX stock_reservations_active_product_idx ON stock_reservations (product_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Vendas
-- ---------------------------------------------------------------------------
CREATE TABLE sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  event_id        uuid NOT NULL,
  sale_number     int  NOT NULL CHECK (sale_number > 0),
  cart_id         uuid,
  operator_id     uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  status          text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'CANCELLED')),
  total_cents     int  NOT NULL CHECK (total_cents > 0),
  items_count     int  NOT NULL CHECK (items_count > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  cancelled_by_id uuid,
  cancel_reason   text,
  FOREIGN KEY (event_id, company_id) REFERENCES events (id, company_id),
  FOREIGN KEY (operator_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (cancelled_by_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (cart_id, company_id) REFERENCES carts (id, company_id),
  UNIQUE (id, company_id),
  UNIQUE (id, company_id, event_id),
  UNIQUE (event_id, sale_number),
  UNIQUE (operator_id, idempotency_key),
  UNIQUE (cart_id),
  CHECK (
    (status = 'COMPLETED' AND cancelled_at IS NULL AND cancelled_by_id IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);
CREATE INDEX sales_event_created_idx ON sales (company_id, event_id, created_at DESC);
CREATE INDEX sales_operator_idx ON sales (operator_id, created_at DESC);

CREATE TABLE sale_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id          uuid NOT NULL,
  company_id       uuid NOT NULL,
  event_id         uuid NOT NULL,
  product_id       uuid NOT NULL,
  product_name     text NOT NULL,
  product_code     text NOT NULL,
  unit_price_cents int NOT NULL CHECK (unit_price_cents > 0),
  quantity         int NOT NULL CHECK (quantity > 0),
  subtotal_cents   int NOT NULL,
  FOREIGN KEY (sale_id, company_id, event_id) REFERENCES sales (id, company_id, event_id),
  FOREIGN KEY (product_id, company_id, event_id) REFERENCES products (id, company_id, event_id),
  CHECK (subtotal_cents = unit_price_cents * quantity),
  UNIQUE (sale_id, product_id)
);
CREATE INDEX sale_items_event_product_idx ON sale_items (event_id, product_id);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             uuid NOT NULL UNIQUE,
  company_id          uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('CASH', 'PIX', 'DEBIT', 'CREDIT')),
  amount_cents        int  NOT NULL CHECK (amount_cents > 0),
  received_cents      int,
  change_cents        int,
  manual_confirmation boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, company_id) REFERENCES sales (id, company_id),
  CHECK (
    (method = 'CASH' AND received_cents IS NOT NULL AND change_cents IS NOT NULL
       AND received_cents >= amount_cents AND change_cents = received_cents - amount_cents)
    OR
    (method <> 'CASH' AND received_cents IS NULL AND change_cents IS NULL AND manual_confirmation = true)
  )
);

CREATE TABLE sale_cancellations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id                 uuid NOT NULL UNIQUE, -- garante no banco: uma venda só é cancelada uma vez
  company_id              uuid NOT NULL,
  event_id                uuid NOT NULL,
  cancelled_by_id         uuid NOT NULL,
  requested_by_id         uuid,
  reason                  text NOT NULL CHECK (length(btrim(reason)) >= 3),
  original_method         text NOT NULL CHECK (original_method IN ('CASH', 'PIX', 'DEBIT', 'CREDIT')),
  original_amount_cents   int  NOT NULL CHECK (original_amount_cents > 0),
  cash_refund_cents       int,
  requires_external_refund boolean NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, company_id, event_id) REFERENCES sales (id, company_id, event_id),
  FOREIGN KEY (cancelled_by_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (requested_by_id, company_id) REFERENCES users (id, company_id),
  CHECK (
    (original_method = 'CASH' AND cash_refund_cents IS NOT NULL
       AND cash_refund_cents BETWEEN 0 AND original_amount_cents AND requires_external_refund = false)
    OR
    (original_method <> 'CASH' AND cash_refund_cents IS NULL AND requires_external_refund = true)
  )
);

CREATE TABLE cancellation_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  sale_id         uuid NOT NULL,
  requested_by_id uuid NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 3),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by_id   uuid,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sale_id, company_id) REFERENCES sales (id, company_id),
  FOREIGN KEY (requested_by_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (decided_by_id, company_id) REFERENCES users (id, company_id),
  CHECK ((status = 'PENDING' AND decided_at IS NULL) OR (status <> 'PENDING' AND decided_at IS NOT NULL AND decided_by_id IS NOT NULL))
);
CREATE UNIQUE INDEX cancellation_requests_one_pending ON cancellation_requests (sale_id) WHERE status = 'PENDING';
CREATE INDEX cancellation_requests_company_idx ON cancellation_requests (company_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Movimentações de estoque (físico) e auditoria — somente inserção
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     uuid NOT NULL,
  event_id       uuid NOT NULL,
  product_id     uuid NOT NULL,
  type           text NOT NULL CHECK (type IN ('INITIAL', 'ENTRY', 'ADJUSTMENT', 'SALE', 'SALE_CANCEL_RETURN')),
  quantity       int  NOT NULL CHECK (quantity <> 0),
  balance_before int  NOT NULL CHECK (balance_before >= 0),
  balance_after  int  NOT NULL CHECK (balance_after >= 0),
  user_id        uuid,
  sale_id        uuid,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, company_id, event_id) REFERENCES products (id, company_id, event_id),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (sale_id, company_id) REFERENCES sales (id, company_id),
  CHECK (balance_after = balance_before + quantity),
  CHECK (type <> 'ADJUSTMENT' OR (reason IS NOT NULL AND length(btrim(reason)) >= 3)),
  CHECK (type NOT IN ('SALE', 'SALE_CANCEL_RETURN') OR sale_id IS NOT NULL)
);
CREATE INDEX stock_movements_event_idx ON stock_movements (company_id, event_id, id DESC);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, id DESC);

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  uuid REFERENCES companies (id),
  actor_type  text NOT NULL CHECK (actor_type IN ('PLATFORM_ADMIN', 'USER', 'SYSTEM')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_company_idx ON audit_logs (company_id, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (company_id, actor_id, id DESC);

-- ---------------------------------------------------------------------------
-- Imutabilidade (o histórico não pode ser editado nem apagado, nem por engano)
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A tabela % é imutável (somente inserção)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_items_immutable BEFORE UPDATE OR DELETE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sale_cancellations_immutable BEFORE UPDATE OR DELETE ON sale_cancellations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Venda: nunca é excluída; a única alteração permitida é COMPLETED -> CANCELLED,
-- preenchendo os campos de cancelamento, sem tocar em valores, itens, operador ou datas.
CREATE FUNCTION sales_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Vendas não podem ser excluídas' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'COMPLETED' OR NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Transição de status de venda inválida: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.id, NEW.company_id, NEW.event_id, NEW.sale_number, NEW.cart_id, NEW.operator_id,
         NEW.idempotency_key, NEW.total_cents, NEW.items_count, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.event_id, OLD.sale_number, OLD.cart_id, OLD.operator_id,
         OLD.idempotency_key, OLD.total_cents, OLD.items_count, OLD.created_at) THEN
    RAISE EXCEPTION 'Os dados originais da venda são imutáveis' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_guard_trg BEFORE UPDATE OR DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION sales_guard();
