-- ============================================================================
-- caughtcode · 0002 · Corridas de análisis, hallazgos, agente y video
-- ----------------------------------------------------------------------------
-- Todas estas tablas las escribe el worker (service_role). El usuario las lee.
-- Los CHECK de enums replican exactamente las uniones de src/lib/types/domain.ts.
-- ============================================================================

-- ── analysis_runs_caughtcode ──────────────────────────────────────────────────────────
create table public.analysis_runs_caughtcode (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects_caughtcode (id) on delete cascade,
  -- RunStatus
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled')),
  stage           text,
  progress        int not null default 0 check (progress between 0 and 100),
  started_at      timestamptz,
  finished_at     timestamptz,
  cost_breakdown  jsonb,
  error           text,
  created_at      timestamptz not null default now()
);

comment on table public.analysis_runs_caughtcode is
  'Una auditoría completa de un proyecto. `stage` y `progress` alimentan el progreso en vivo.';
comment on column public.analysis_runs_caughtcode.cost_breakdown is
  'CostBreakdown de domain.ts. Se registra siempre: sin esto no se puede fijar precio ni detectar regresiones de costo.';
comment on column public.analysis_runs_caughtcode.status is
  'RunStatus. `partial` = terminó con etapas caídas pero con hallazgos utilizables.';

create index analysis_runs_project_id_idx_caughtcode on public.analysis_runs_caughtcode (project_id);
create index analysis_runs_project_created_idx_caughtcode on public.analysis_runs_caughtcode (project_id, created_at desc);
create index analysis_runs_activas_idx_caughtcode on public.analysis_runs_caughtcode (status) where status in ('queued', 'running');

alter table public.analysis_runs_caughtcode enable row level security;
alter table public.analysis_runs_caughtcode force row level security;


-- ── code_index_caughtcode ─────────────────────────────────────────────────────────────
create table public.code_index_caughtcode (
  id               uuid primary key default gen_random_uuid(),
  analysis_run_id  uuid not null references public.analysis_runs_caughtcode (id) on delete cascade,
  symbol_graph     jsonb not null default '{}'::jsonb,
  routes           jsonb not null default '[]'::jsonb,
  ranked_files     jsonb not null default '[]'::jsonb,
  db_schema        jsonb not null default '{}'::jsonb,
  stats            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table public.code_index_caughtcode is
  'Resultado del indexado estructural (tree-sitter + grafo + PageRank). Un índice por corrida.';

-- Único por corrida: permite que la etapa de indexado se reintente con UPSERT
-- sin duplicar (el pipeline tiene que ser resumible, ver MEMORY.md).
create unique index code_index_analysis_run_id_key_caughtcode on public.code_index_caughtcode (analysis_run_id);

alter table public.code_index_caughtcode enable row level security;
alter table public.code_index_caughtcode force row level security;


-- ── findings_caughtcode ───────────────────────────────────────────────────────────────
create table public.findings_caughtcode (
  id                 uuid primary key default gen_random_uuid(),
  analysis_run_id    uuid not null references public.analysis_runs_caughtcode (id) on delete cascade,
  project_id         uuid not null references public.projects_caughtcode (id) on delete cascade,
  -- Pillar
  pillar             text not null check (pillar in ('security', 'completeness', 'store_hygiene')),
  check_id           text not null,
  -- Severity
  severity           text not null check (severity in ('critical', 'high', 'medium', 'low')),
  -- Confidence
  confidence         text not null check (confidence in ('confirmed', 'likely', 'to_review')),
  -- FindingStatus
  status             text not null default 'open' check (status in ('open', 'fixed', 'dismissed')),
  title_plain        text not null check (length(btrim(title_plain)) > 0),
  explanation_plain  text not null check (length(btrim(explanation_plain)) > 0),
  impact_plain       text not null check (length(btrim(impact_plain)) > 0),
  fix_prompt         text not null check (length(btrim(fix_prompt)) > 0),
  -- REGLA DURA: ningún hallazgo sin evidencia (CLAUDE.md #1, DECISIONS.md D14).
  evidence           jsonb not null
                       check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0),
  rank               int not null default 999 check (rank >= 1),
  video_id           uuid,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);

comment on table public.findings_caughtcode is
  'Un hallazgo, ya traducido a lenguaje llano. Los textos *_plain son los que ve el usuario: cero jerga.';
comment on column public.findings_caughtcode.evidence is
  'Evidence[] de domain.ts. El CHECK garantiza que nunca haya un hallazgo sin respaldo verificable.';
comment on column public.findings_caughtcode.rank is
  'Orden dentro de la corrida. 1..3 son los destacados ("hacé esto ya"); el resto va colapsado (D15).';

create index findings_analysis_run_id_idx_caughtcode on public.findings_caughtcode (analysis_run_id);
create index findings_project_id_idx_caughtcode on public.findings_caughtcode (project_id);
create index findings_project_status_idx_caughtcode on public.findings_caughtcode (project_id, status);
create index findings_video_id_idx_caughtcode on public.findings_caughtcode (video_id) where video_id is not null;
create index findings_run_rank_idx_caughtcode on public.findings_caughtcode (analysis_run_id, rank);

-- Máximo 3 destacados por corrida, garantizado por la base y no por confianza
-- en el motor de ranking (D15).
create unique index findings_destacados_key_caughtcode
  on public.findings_caughtcode (analysis_run_id, rank) where rank <= 3;

alter table public.findings_caughtcode enable row level security;
alter table public.findings_caughtcode force row level security;


-- ── agent_sessions_caughtcode ─────────────────────────────────────────────────────────
create table public.agent_sessions_caughtcode (
  id                 uuid primary key default gen_random_uuid(),
  analysis_run_id    uuid not null references public.analysis_runs_caughtcode (id) on delete cascade,
  -- AgentTaskId
  task_id            text not null check (task_id in (
                       'signup', 'login', 'password_reset', 'logout', 'delete_account_caughtcode',
                       'edit_profile', 'cross_tenant_read', 'primary_flow',
                       'cookie_banner', 'privacy_terms')),
  -- AgentOutcome
  outcome            text not null check (outcome in ('completed', 'blocked', 'not_found', 'error', 'skipped')),
  conclusion_plain   text not null,
  recording_url      text,
  steps              jsonb not null default '[]'::jsonb,
  duration_ms        int not null default 0 check (duration_ms >= 0),
  cost_usd           numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at         timestamptz not null default now()
);

comment on table public.agent_sessions_caughtcode is
  'Cada intento del agente de navegación sobre la app desplegada. La grabación es la prueba del hallazgo (D2).';
comment on column public.agent_sessions_caughtcode.recording_url is
  'Objeto en el bucket `recordings`. Borrar la fila NO borra el archivo: ver public.delete_project_cascade_caughtcode().';

create index agent_sessions_analysis_run_id_idx_caughtcode on public.agent_sessions_caughtcode (analysis_run_id);

alter table public.agent_sessions_caughtcode enable row level security;
alter table public.agent_sessions_caughtcode force row level security;


-- ── videos_caughtcode ─────────────────────────────────────────────────────────────────
create table public.videos_caughtcode (
  id           uuid primary key default gen_random_uuid(),
  finding_id   uuid references public.findings_caughtcode (id) on delete cascade,
  -- DESVÍO DELIBERADO respecto de CONTRACTS.md §3: sin esta columna un video de
  -- tutorial (finding_id null) no tiene forma de pertenecer a nadie y RLS no
  -- puede decidir quién lo ve. Es aditiva y nullable.
  project_id   uuid references public.projects_caughtcode (id) on delete cascade,
  module_id    text,
  -- VideoKind
  kind         text not null check (kind in ('finding', 'tutorial')),
  status       text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed')),
  duration_s   numeric(8, 2) check (duration_s >= 0),
  url          text,
  transcript   text,
  script       jsonb,
  cost_usd     numeric(12, 6) not null default 0 check (cost_usd >= 0),
  error        text,
  created_at   timestamptz not null default now(),
  -- Un video que no cuelga ni de un hallazgo ni de un proyecto es invisible
  -- para todo el mundo. Eso es un bug, no un dato válido.
  constraint videos_tenencia_check_caughtcode check (finding_id is not null or project_id is not null)
);

comment on table public.videos_caughtcode is
  'Clip narrado de 60-90s (D12). `kind = finding` cuelga de un hallazgo; `kind = tutorial` cuelga del proyecto.';
comment on column public.videos_caughtcode.project_id is
  'Ancla de tenencia. Obligatoria en la práctica para tutoriales; conviene setearla también en videos_caughtcode de hallazgo.';
comment on column public.videos_caughtcode.status is
  'Estado del render. Vocabulario acordado con el frente de video: queued | rendering | ready | failed.';

create index videos_finding_id_idx_caughtcode on public.videos_caughtcode (finding_id);
create index videos_project_id_idx_caughtcode on public.videos_caughtcode (project_id);
create index videos_pendientes_idx_caughtcode on public.videos_caughtcode (status) where status in ('queued', 'rendering');

alter table public.videos_caughtcode enable row level security;
alter table public.videos_caughtcode force row level security;

-- Ciclo findings_caughtcode <-> videos_caughtcode: la FK se agrega recién ahora porque videos_caughtcode no
-- existía cuando se creó findings_caughtcode.
alter table public.findings_caughtcode
  add constraint findings_video_id_fkey_caughtcode
  foreign key (video_id) references public.videos_caughtcode (id) on delete set null;


-- ── comment_scans_caughtcode ──────────────────────────────────────────────────────────
create table public.comment_scans_caughtcode (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects_caughtcode (id) on delete cascade,
  analysis_run_id   uuid references public.analysis_runs_caughtcode (id) on delete set null,
  scanned_files     int not null default 0 check (scanned_files >= 0),
  exposed_count     int not null default 0 check (exposed_count >= 0),
  risky_count       int not null default 0 check (risky_count >= 0),
  removable_count   int not null default 0 check (removable_count >= 0),
  hits              jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

comment on table public.comment_scans_caughtcode is
  'Escaneo de comentarios en el código. `exposed_count` son los que llegan al navegador del visitante.';

create index comment_scans_project_id_idx_caughtcode on public.comment_scans_caughtcode (project_id);
create index comment_scans_analysis_run_id_idx_caughtcode on public.comment_scans_caughtcode (analysis_run_id);

alter table public.comment_scans_caughtcode enable row level security;
alter table public.comment_scans_caughtcode force row level security;


-- ── comment_cleanups_caughtcode ───────────────────────────────────────────────────────
create table public.comment_cleanups_caughtcode (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects_caughtcode (id) on delete cascade,
  scan_id           uuid not null references public.comment_scans_caughtcode (id) on delete cascade,
  -- CommentCleanPlan['mode']
  mode              text not null check (mode in ('safe', 'aggressive')),
  files_changed     int not null default 0 check (files_changed >= 0),
  comments_removed  int not null default 0 check (comments_removed >= 0),
  patch_path        text,
  status            text not null default 'pending'
                      check (status in ('pending', 'ready', 'applied', 'failed')),
  created_at        timestamptz not null default now()
);

comment on table public.comment_cleanups_caughtcode is
  'Plan de limpieza generado a partir de un escaneo. Produce un parche; nunca escribe en el repo del usuario.';
comment on column public.comment_cleanups_caughtcode.patch_path is
  'Objeto en el bucket `repos`. Borrar la fila NO borra el archivo.';

create index comment_cleanups_project_id_idx_caughtcode on public.comment_cleanups_caughtcode (project_id);
create index comment_cleanups_scan_id_idx_caughtcode on public.comment_cleanups_caughtcode (scan_id);

alter table public.comment_cleanups_caughtcode enable row level security;
alter table public.comment_cleanups_caughtcode force row level security;
