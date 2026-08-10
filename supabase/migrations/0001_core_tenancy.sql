-- ============================================================================
-- caughtcode · 0001 · Núcleo multi-tenant
-- ----------------------------------------------------------------------------
-- Una persona gestiona N proyectos, potencialmente de N clientes distintos
-- (DECISIONS.md D17). El aislamiento es por `org_id` y se aplica en TODAS las
-- tablas con RLS habilitada Y forzada.
--
-- `force row level security` existe porque, sin él, el dueño de la tabla lee
-- todo. Somos el producto que audita RLS ajena: no podemos filtrar la propia.
-- ============================================================================

-- ── Utilidad: mantener `updated_at` al día ─────────────────────────────────
create or replace function public.set_updated_at_caughtcode()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at_caughtcode() is
  'Trigger genérico: pone updated_at = now() en cada UPDATE.';


-- ── organizations_caughtcode ──────────────────────────────────────────────────────────
create table public.organizations_caughtcode (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 120),
  owner_user_id  uuid not null references auth.users (id) on delete cascade,
  plan           text not null default 'free',
  created_at     timestamptz not null default now()
);

comment on table public.organizations_caughtcode is
  'Espacio de trabajo. Cada usuario recibe uno personal al registrarse; una agencia puede tener varios.';
comment on column public.organizations_caughtcode.plan is
  'Plan comercial vigente. Sin CHECK a propósito: el vocabulario lo define el frente de monetización (ver supabase/README.md).';
comment on column public.organizations_caughtcode.owner_user_id is
  'Si se borra el usuario en auth.users, la organización y todo lo que cuelga de ella desaparecen (borrado real, ver 0008).';

create index organizations_owner_user_id_idx_caughtcode on public.organizations_caughtcode (owner_user_id);

alter table public.organizations_caughtcode enable row level security;
alter table public.organizations_caughtcode force row level security;


-- ── org_members_caughtcode ────────────────────────────────────────────────────────────
create table public.org_members_caughtcode (
  org_id      uuid not null references public.organizations_caughtcode (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

comment on table public.org_members_caughtcode is
  'Quién pertenece a qué organización. Fuente de verdad de public.is_org_member_caughtcode().';

-- La PK (org_id, user_id) ya cubre el lookup de membresía.
-- Este índice cubre el camino inverso: "¿a qué organizaciones pertenezco?".
create index org_members_user_id_idx_caughtcode on public.org_members_caughtcode (user_id);

alter table public.org_members_caughtcode enable row level security;
alter table public.org_members_caughtcode force row level security;


-- ── Toda organización nace con su dueño adentro ────────────────────────────
-- Sin esto, quien crea una organización queda afuera de sus propias policies.
create or replace function public.add_owner_membership_caughtcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_members_caughtcode (org_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner')
  on conflict (org_id, user_id) do nothing;
  return new;
end;
$$;

comment on function public.add_owner_membership_caughtcode() is
  'Da de alta al dueño como miembro owner apenas se crea la organización.';

create trigger organizations_add_owner_membership_caughtcode
after insert on public.organizations_caughtcode
for each row execute function public.add_owner_membership_caughtcode();


-- ── projects_caughtcode ───────────────────────────────────────────────────────────────
create table public.projects_caughtcode (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations_caughtcode (id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 120),
  client_name     text,
  source_type     text not null check (source_type in ('github', 'zip')),
  repo_url        text,
  repo_ref        text,
  deployed_url    text,
  stack_detected  jsonb,
  storage_path    text,
  retention_days  int not null default 30 check (retention_days between 1 and 365),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.projects_caughtcode is
  'La app auditada. `client_name` es para agencias que auditan apps de terceros.';
comment on column public.projects_caughtcode.storage_path is
  'Prefijo del código dentro del bucket `repos`. Borrar la fila NO borra los objetos: ver public.delete_project_cascade_caughtcode().';
comment on column public.projects_caughtcode.deleted_at is
  'Baja lógica para la papelera de la UI. El borrado real lo hace public.delete_project_cascade_caughtcode().';

create index projects_org_id_idx_caughtcode on public.projects_caughtcode (org_id);
create index projects_org_id_created_at_idx_caughtcode on public.projects_caughtcode (org_id, created_at desc);
create index projects_activos_idx_caughtcode on public.projects_caughtcode (org_id) where deleted_at is null;

alter table public.projects_caughtcode enable row level security;
alter table public.projects_caughtcode force row level security;


-- ── project_connections_caughtcode ────────────────────────────────────────────────────
create table public.project_connections_caughtcode (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects_caughtcode (id) on delete cascade,
  provider         text not null check (provider in ('github', 'supabase')),
  credentials_ref  text not null,
  scopes           text[] not null default '{}',
  created_at       timestamptz not null default now()
);

comment on table public.project_connections_caughtcode is
  'Credenciales de solo lectura hacia GitHub o hacia el Supabase del usuario.';
comment on column public.project_connections_caughtcode.credentials_ref is
  'REFERENCIA al secreto cifrado (src/lib/crypto.ts). Prohibido guardar tokens en claro acá.';

create index project_connections_project_id_idx_caughtcode on public.project_connections_caughtcode (project_id);
create unique index project_connections_project_provider_key_caughtcode
  on public.project_connections_caughtcode (project_id, provider);

alter table public.project_connections_caughtcode enable row level security;
alter table public.project_connections_caughtcode force row level security;
