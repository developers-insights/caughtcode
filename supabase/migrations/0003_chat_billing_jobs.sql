-- ============================================================================
-- caughtcode · 0003 · Chat, costos, suscripciones y cola de trabajos
-- ----------------------------------------------------------------------------
-- La cola es el corazón operativo: análisis de repo, corrida del agente y
-- render de video son minutos, no milisegundos. Nada de eso vive en un request.
-- ============================================================================

-- ── chat_threads_caughtcode ───────────────────────────────────────────────────────────
create table public.chat_threads_caughtcode (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects_caughtcode (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'Conversación nueva' check (length(btrim(title)) between 1 and 200),
  created_at  timestamptz not null default now()
);

comment on table public.chat_threads_caughtcode is
  'Preguntas del usuario sobre su propio proyecto. Reusa el índice estructural (D18).';

create index chat_threads_project_id_idx_caughtcode on public.chat_threads_caughtcode (project_id);
create index chat_threads_user_id_idx_caughtcode on public.chat_threads_caughtcode (user_id);
create index chat_threads_project_created_idx_caughtcode on public.chat_threads_caughtcode (project_id, created_at desc);

alter table public.chat_threads_caughtcode enable row level security;
alter table public.chat_threads_caughtcode force row level security;


-- ── chat_messages_caughtcode ──────────────────────────────────────────────────────────
create table public.chat_messages_caughtcode (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.chat_threads_caughtcode (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  citations   jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.chat_messages_caughtcode is
  'Mensajes del hilo. El usuario solo puede insertar los suyos (role = user); las respuestas las escribe el servidor.';
comment on column public.chat_messages_caughtcode.citations is
  'Referencias archivo:línea que respaldan la respuesta. Sin esto no se puede verificar lo que dijo el modelo (D14).';

create index chat_messages_thread_id_idx_caughtcode on public.chat_messages_caughtcode (thread_id);
create index chat_messages_thread_created_idx_caughtcode on public.chat_messages_caughtcode (thread_id, created_at);

alter table public.chat_messages_caughtcode enable row level security;
alter table public.chat_messages_caughtcode force row level security;


-- ── usage_events_caughtcode ───────────────────────────────────────────────────────────
create table public.usage_events_caughtcode (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations_caughtcode (id) on delete cascade,
  -- Se conserva el consumo aunque el proyecto se borre: es historia de facturación,
  -- no código del usuario.
  project_id  uuid references public.projects_caughtcode (id) on delete set null,
  -- CostCategory
  kind        text not null check (kind in ('llm', 'tts', 'browser_agent', 'render', 'storage')),
  units       numeric(16, 4) not null default 0 check (units >= 0),
  unit_label  text not null,
  cost_usd    numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at  timestamptz not null default now()
);

comment on table public.usage_events_caughtcode is
  'Consumo real, en dólares y en unidades concretas. Nada de "créditos" (D16).';
comment on column public.usage_events_caughtcode.unit_label is
  'Unidad legible por una persona: "minutos de video", "caracteres narrados", "tareas del agente".';

create index usage_events_org_created_idx_caughtcode on public.usage_events_caughtcode (org_id, created_at desc);
create index usage_events_project_id_idx_caughtcode on public.usage_events_caughtcode (project_id);

alter table public.usage_events_caughtcode enable row level security;
alter table public.usage_events_caughtcode force row level security;


-- ── subscriptions_caughtcode ──────────────────────────────────────────────────────────
create table public.subscriptions_caughtcode (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations_caughtcode (id) on delete cascade,
  stripe_customer_id      text not null,
  stripe_subscription_id  text,
  plan                    text not null default 'free',
  -- Vocabulario de Stripe, no nuestro.
  status                  text not null default 'incomplete' check (status in (
                            'incomplete', 'incomplete_expired', 'trialing', 'active',
                            'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end      timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.subscriptions_caughtcode is
  'Suscripción de monitoreo. La auditoría inicial es pago único y se registra en usage_events_caughtcode (D16).';

create unique index subscriptions_org_id_key_caughtcode on public.subscriptions_caughtcode (org_id);
create unique index subscriptions_stripe_subscription_id_key_caughtcode
  on public.subscriptions_caughtcode (stripe_subscription_id) where stripe_subscription_id is not null;

create trigger subscriptions_set_updated_at_caughtcode
before update on public.subscriptions_caughtcode
for each row execute function public.set_updated_at_caughtcode();

alter table public.subscriptions_caughtcode enable row level security;
alter table public.subscriptions_caughtcode force row level security;


-- ── jobs_caughtcode ───────────────────────────────────────────────────────────────────
create table public.jobs_caughtcode (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations_caughtcode (id) on delete cascade,
  project_id       uuid references public.projects_caughtcode (id) on delete cascade,
  analysis_run_id  uuid references public.analysis_runs_caughtcode (id) on delete cascade,
  -- JobKind
  kind             text not null check (kind in (
                     'ingest_repo', 'index_code', 'run_checks', 'run_browser_agent',
                     'generate_video', 'scan_comments', 'build_tutorials')),
  -- JobStatus
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload          jsonb not null default '{}'::jsonb,
  attempts         int not null default 0 check (attempts >= 0),
  max_attempts     int not null default 3 check (max_attempts >= 1),
  last_error       text,
  stage            text,
  progress         int not null default 0 check (progress between 0 and 100),
  lease_until      timestamptz,
  run_after        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.jobs_caughtcode is
  'Cola de trabajo persistida. Un job encolado sobrevive al reinicio del worker: ver public.requeue_expired_jobs_caughtcode().';
comment on column public.jobs_caughtcode.lease_until is
  'Hasta cuándo el worker que lo tomó tiene la posta. Vencido y sin terminar, vuelve a la cola.';
comment on column public.jobs_caughtcode.stage is
  'Etapa actual dentro del job. Permite reanudar sin rehacer todo (los repos grandes rompen los jobs_caughtcode monolíticos).';

create index jobs_org_id_idx_caughtcode on public.jobs_caughtcode (org_id);
create index jobs_project_id_idx_caughtcode on public.jobs_caughtcode (project_id);
create index jobs_analysis_run_id_idx_caughtcode on public.jobs_caughtcode (analysis_run_id);

-- Índice de la cola: el único que se toca en el camino caliente de claim_job_caughtcode().
create index jobs_cola_idx_caughtcode on public.jobs_caughtcode (status, run_after) where status = 'queued';
create index jobs_cola_kind_idx_caughtcode on public.jobs_caughtcode (kind, run_after) where status = 'queued';
-- Camino de requeue_expired_jobs_caughtcode().
create index jobs_lease_idx_caughtcode on public.jobs_caughtcode (lease_until) where status = 'running';

create trigger jobs_set_updated_at_caughtcode
before update on public.jobs_caughtcode
for each row execute function public.set_updated_at_caughtcode();

alter table public.jobs_caughtcode enable row level security;
alter table public.jobs_caughtcode force row level security;
