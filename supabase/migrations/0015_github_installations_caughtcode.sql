-- ============================================================================
-- caughtcode · 0015 · Cada instalación de la GitHub App pertenece a UNA organización
-- ----------------------------------------------------------------------------
-- EL AGUJERO QUE CIERRA
-- --------------------
-- `listInstallations()` (src/server/ingest/github.ts) llamaba a
-- `apps.listInstallations()` y devolvía TODAS las instalaciones de la GitHub App,
-- sin filtro. Lo consumía el asistente de "proyecto nuevo". Con una sola cuenta
-- registrada no se notaba; con dos, la segunda persona veía en su desplegable las
-- instalaciones de la primera y podía listar y auditar repositorios privados
-- ajenos. Es, literalmente, el hallazgo que este producto busca en apps de otros:
-- "un usuario puede ver los datos de otro".
--
-- Nada en la base registraba quién había instalado qué. GitHub tampoco lo dice:
-- su API contesta "estas son las instalaciones de la App", no "estas son las
-- instalaciones de esta persona". El dato que faltaba es nuestro y hay que
-- guardarlo nosotros. Esta tabla es ese dato.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `project_connections_caughtcode`
-- -------------------------------------------------------------
-- Esa tabla cuelga de un PROYECTO, y acá hacen falta las dos cosas que no puede dar:
--
--   1. La instalación se necesita ANTES de que exista el proyecto. El asistente
--      lista instalaciones para poder listar repositorios para recién después
--      crear el proyecto. Colgarla de un proyecto que todavía no existe es
--      imposible sin invertir el flujo entero.
--   2. Una instalación sirve para MUCHOS proyectos. Guardarla por proyecto la
--      duplica N veces, y N copias de un vínculo de permisos es N lugares donde
--      pueden desincronizarse. `project_connections_caughtcode` sigue existiendo y
--      sigue guardando la credencial cifrada de cada proyecto: es la respuesta a
--      "¿con qué entro a ESTE repositorio?". Esta tabla responde otra pregunta,
--      "¿de quién es esta instalación?", y esa es de la organización.
--
-- POR QUÉ LA CLAVE PRIMARIA ES `installation_id`
-- ----------------------------------------------
-- No es una decisión de comodidad: es la regla de "no se roba una instalación
-- ajena", puesta en el motor y no en el código. El id de instalación es único en
-- todo GitHub. Si es la clave primaria, una instalación no puede estar atada a
-- dos organizaciones ni aunque alguien encuentre el modo de llamar dos veces a la
-- ruta que la registra: el segundo intento choca contra la restricción. La
-- verificación en la aplicación (0015 + github.ts) es la primera capa; esta es la
-- que no depende de que la primera esté bien escrita.
--
-- QUIÉN ESCRIBE ACÁ
-- -----------------
-- Solo el servidor (service_role), desde la ruta que recibe la vuelta de GitHub,
-- y únicamente después de haberle preguntado a la API de GitHub que esa
-- instalación existe y de qué cuenta es. El `installation_id` llega por la barra
-- de direcciones del navegador: es un número que escribe cualquiera. Si
-- `authenticated` pudiera insertar acá, atarse la instalación de otro sería
-- escribir una fila.
--
-- QUIÉN LEE
-- ---------
-- Todos los miembros de la organización, y ese es el requisito, no un descuido:
-- el equipo que trabaja sobre esos repositorios tiene que poder auditarlos sin
-- que cada persona instale la App por su cuenta. Alguien de otra organización no
-- ve nada — no una versión recortada: nada.
-- ============================================================================


create table public.github_installations_caughtcode (
  installation_id   bigint primary key,
  org_id            uuid not null references public.organizations_caughtcode (id) on delete cascade,
  account_login     text not null check (length(btrim(account_login)) between 1 and 120),
  account_type      text not null default 'User',
  account_id        bigint,
  all_repositories  boolean not null default false,
  installed_by      uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  removed_at        timestamptz
);

comment on table public.github_installations_caughtcode is
  'Qué instalación de la GitHub App pertenece a qué organización. Sin esto, el asistente de proyecto nuevo lista las instalaciones de todo el mundo (ver el encabezado de esta migración).';
comment on column public.github_installations_caughtcode.installation_id is
  'Id de la instalación en GitHub. Es la clave primaria a propósito: hace imposible, a nivel motor, que una instalación quede atada a dos organizaciones.';
comment on column public.github_installations_caughtcode.account_id is
  'Id numérico de la cuenta dueña en GitHub. Sobrevive a que la cuenta se renombre; `account_login` no.';
comment on column public.github_installations_caughtcode.installed_by is
  'Quién completó la instalación. Informativo: el permiso lo da la organización, no la persona. Si esa persona se va, la instalación sigue siendo del equipo.';
comment on column public.github_installations_caughtcode.removed_at is
  'Fecha en que la instalación se desinstaló o dejó de estar viva. Baja lógica: se deja de listar pero queda el registro de que existió y de quién era.';

create index github_installations_org_id_idx_caughtcode
  on public.github_installations_caughtcode (org_id);

-- Camino caliente del asistente: "las instalaciones vivas de esta organización".
create index github_installations_activas_idx_caughtcode
  on public.github_installations_caughtcode (org_id)
  where removed_at is null;

-- La clave foránea a `auth.users` necesita su propio índice: cuando se borra una
-- cuenta (public.delete_account_caughtcode), Postgres tiene que buscar acá las
-- filas que la referencian para poner `installed_by` en null. Sin índice, eso es
-- un recorrido completo de la tabla por cada usuario borrado. Lo marca el advisor
-- de performance como `unindexed_foreign_keys`.
create index github_installations_installed_by_idx_caughtcode
  on public.github_installations_caughtcode (installed_by);

create trigger github_installations_set_updated_at_caughtcode
before update on public.github_installations_caughtcode
for each row execute function public.set_updated_at_caughtcode();

alter table public.github_installations_caughtcode enable row level security;
alter table public.github_installations_caughtcode force row level security;


-- ── Privilegios de tabla ───────────────────────────────────────────────────
-- Explícito y no heredado. La migración 0005 hizo `alter default privileges ...
-- revoke all on tables from anon`, pero eso solo alcanza a las tablas que crea el
-- mismo rol que corrió aquella sentencia. No se apuesta a eso: se nombra a los
-- dos roles, igual que 0014 tuvo que nombrarlos para las funciones.
revoke all on public.github_installations_caughtcode from anon, authenticated;
grant select on public.github_installations_caughtcode to authenticated;
grant all    on public.github_installations_caughtcode to service_role;


-- ── Policies ───────────────────────────────────────────────────────────────
-- Una por comando, nunca `for all`: el criterio de 0005.
--
-- SELECT es de toda la organización. Es el requisito explícito del producto: el
-- equipo que tiene acceso a esos repositorios en GitHub tiene que poder verlos
-- acá. INSERT/UPDATE/DELETE no existen para `authenticated` — ni siquiera para el
-- dueño de la organización. Atar una instalación exige haberla verificado contra
-- la API de GitHub, y eso solo lo puede hacer el servidor.
create policy github_installations_select_caughtcode on public.github_installations_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy github_installations_insert_caughtcode on public.github_installations_caughtcode
  for insert to service_role with check ( true );

create policy github_installations_update_caughtcode on public.github_installations_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy github_installations_delete_caughtcode on public.github_installations_caughtcode
  for delete to service_role using ( true );


-- ── Backfill: la instalación que ya está en uso ────────────────────────────
-- Hay una instalación real trabajando hoy (152524864, cuenta `developers-insights`,
-- con acceso a todos los repositorios) y dos proyectos activos que dependen de
-- ella. Si esta migración la dejara afuera, el filtro nuevo la escondería y el
-- asistente diría "no encontramos ninguna instalación" sobre una que funciona.
--
-- La organización dueña es la única que existe en la base. La condición
-- `where exists` no es decorativa: si esta migración se corre contra una base
-- donde esa organización no está (una copia limpia, un entorno nuevo), no inserta
-- nada en vez de romper por clave foránea.
-- Los valores salen de la API de GitHub, consultada antes de escribir esto
-- (`GET /app/installations` → id 152524864, cuenta `developers-insights`,
-- account_id 305118073, tipo `User`, repository_selection `all`).
insert into public.github_installations_caughtcode
  (installation_id, org_id, account_login, account_type, account_id, all_repositories)
select 152524864,
       '99bc0b30-1401-4891-bc2d-1f7e74c2bf1b'::uuid,
       'developers-insights',
       'User',
       305118073,
       true
where exists (
  select 1 from public.organizations_caughtcode o
  where o.id = '99bc0b30-1401-4891-bc2d-1f7e74c2bf1b'::uuid
)
on conflict (installation_id) do nothing;
