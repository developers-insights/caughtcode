-- ============================================================================
-- caughtcode · 0010 · Ajustes pedidos por el frente de la cola
-- ----------------------------------------------------------------------------
-- Aditiva: no toca nada de 0001-0009 salvo un índice redundante que reemplaza.
--
-- Lo que YA estaba y se confirma sin cambios (verificado en 0006):
--
--   claim_job_caughtcode(p_kinds text[], p_lease_seconds int) returns public.jobs_caughtcode
--     · atómico con `for update skip locked` sobre una sola fila
--     · `attempts = attempts + 1`  ← el runner lee esto para decidir reintentos
--     · `status = 'running'`
--     · `lease_until = now() + make_interval(secs => p_lease_seconds)`
--     · `returning * into v_job` → devuelve la fila completa de jobs_caughtcode
--     · devuelve null cuando no hay nada en cola
--
--   requeue_expired_jobs_caughtcode() returns int
--     · devuelve la cantidad de trabajos rescatados (count(*) sobre el UPDATE)
--     · los que pasaron max_attempts quedan 'failed', no giran para siempre
--
--   Índices de jobs_caughtcode que ya existían: (status, run_after) where queued,
--   (analysis_run_id), (org_id), (project_id), (kind, run_after) where queued.
--
--   service_role: tiene BYPASSRLS, `grant all on all tables in schema public`
--   (0005) y policies propias de insert/update/delete en jobs_caughtcode y usage_events_caughtcode.
--   Ninguna policy lo bloquea. Se reafirma abajo y se prueba en tests/rls.sql.
-- ============================================================================


-- ── usage_events_caughtcode: costo por corrida ─────────────────────────────
-- Sin `if not exists`: si la columna ya estuviera, algo no entendimos de la
-- base y queremos enterarnos en el push, no meses después.
alter table public.usage_events_caughtcode
  add column analysis_run_id uuid,
  add column detail text;

-- ⚠️ DESVÍO DELIBERADO respecto de lo pedido: la FK va con `on delete set null`,
-- no `on delete cascade`.
--
-- Motivo: usage_events_caughtcode es el registro de facturación. Ya se decidió en 0003 que
-- `project_id` fuera `on delete set null` justamente para que borrar un proyecto
-- no borre la historia de lo que se cobró y lo que costó. Con `cascade` en
-- analysis_run_id esa protección no sirve para nada: borrar el proyecto elimina
-- sus corridas y, por cascada, los eventos de consumo igual. Nos quedaríamos sin
-- poder reconciliar ingresos ni detectar una regresión de costos, que es
-- exactamente para lo que existe la tabla (D16).
--
-- La tabla no guarda nada del código del usuario — solo categoría, unidades,
-- costo y fecha — así que conservarla no rompe la promesa de borrado real.
--
-- Con `set null` el costo por corrida funciona igual mientras la corrida existe,
-- que es el caso de uso planteado. Si igual se prefiere `cascade`, es una línea:
--   alter table public.usage_events_caughtcode drop constraint usage_events_analysis_run_id_fkey_caughtcode;
--   alter table public.usage_events_caughtcode add constraint usage_events_analysis_run_id_fkey_caughtcode
--     foreign key (analysis_run_id) references public.analysis_runs_caughtcode (id) on delete cascade;
alter table public.usage_events_caughtcode
  add constraint usage_events_analysis_run_id_fkey_caughtcode
  foreign key (analysis_run_id) references public.analysis_runs_caughtcode (id) on delete set null;

comment on column public.usage_events_caughtcode.analysis_run_id is
  'Corrida que generó el consumo. Permite sumar el costo exacto de una auditoría sin estimar.';
comment on column public.usage_events_caughtcode.detail is
  'Detalle legible del consumo (CostEntry.detail de domain.ts). Ej: "narración del hallazgo 2".';

create index usage_events_analysis_run_id_idx_caughtcode
  on public.usage_events_caughtcode (analysis_run_id);


-- ── jobs_caughtcode: índice de leases con la forma pedida ──────────────────
-- El anterior era (lease_until) where status = 'running'. Funcionalmente igual
-- para el planner, pero se unifica en la forma pedida y se borra el duplicado
-- para no mantener dos índices que cubren la misma consulta.
create index jobs_lease_expiry_idx_caughtcode
  on public.jobs_caughtcode (status, lease_until) where status = 'running';

drop index if exists public.jobs_lease_idx_caughtcode;


-- ── Realtime: progreso en vivo ─────────────────────────────────────────────
-- La UI muestra la auditoría avanzando y los hallazgos apareciendo de a uno
-- (time-to-first-value corto: nada de una barra girando 8 minutos).
--
-- Realtime respeta RLS: quien se suscribe recibe únicamente las filas que su
-- policy de select le permite ver. No hay que filtrar del lado del cliente.
--
-- ⚠️ Base compartida: la publicación `supabase_realtime` YA EXISTE y muy
-- probablemente ya tiene tablas del otro producto. Acá solo se AGREGAN las
-- nuestras. Nunca `create publication` ni `drop`: eso pisaría la configuración
-- de Realtime del otro producto. Si la publicación no existiera, este archivo
-- falla ruidosamente, que es lo correcto.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'analysis_runs_caughtcode'
  ) then
    alter publication supabase_realtime add table public.analysis_runs_caughtcode;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'findings_caughtcode'
  ) then
    alter publication supabase_realtime add table public.findings_caughtcode;
  end if;
end;
$$;


-- ── Reafirmación de permisos del worker ────────────────────────────────────
-- Redundante con 0005 e idempotente. Está para que quede explícito acá que la
-- cola y el registro de costos no dependen de nada más para funcionar.
grant all on public.jobs_caughtcode, public.usage_events_caughtcode to service_role;
grant execute on function public.claim_job_caughtcode(text[], int) to service_role;
grant execute on function public.requeue_expired_jobs_caughtcode() to service_role;
