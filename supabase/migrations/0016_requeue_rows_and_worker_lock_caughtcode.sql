-- ============================================================================
-- caughtcode · 0016 · La cola dice QUÉ tocó, y un solo tick a la vez
-- ----------------------------------------------------------------------------
-- Dos arreglos de producción, con evidencia:
--
-- 1) requeue_expired_jobs_caughtcode() devolvía un `int` y nada más.
--    Cuando un trabajo con `attempts >= max_attempts` perdía el lease, esta
--    función lo dejaba en 'failed' **directamente en SQL**, sin pasar nunca por
--    reconcileRunStatus() (src/server/jobs/reconcile.ts). Resultado medido hoy:
--    trabajos en 'failed' con su analysis_runs_caughtcode en 'running' para
--    siempre, y la pantalla de hallazgos mostrando "Estamos revisando tu app"
--    eternamente. Dos corridas así:
--        7713e31f-c789-4002-8421-0044be7644c5
--        4f81ed96-21c2-4454-9909-26b105043708
--    Con solo un contador, el servidor no tenía cómo saber a qué corrida
--    avisarle. Ahora devuelve las filas que tocó: id, analysis_run_id y el
--    estado en que quedaron.
--
-- 2) El cron de Vercel dispara /api/worker/tick cada 60 s sin ninguna
--    coordinación. Los trabajos tardan minutos, así que las invocaciones se
--    apilan y —con Fluid Compute, donde varias invocaciones comparten los 2 GB
--    de UNA instancia— Vercel mata la instancia entera:
--        "Vercel Runtime Error: instance was killed because it ran out of
--         available memory"
--    matando de paso el trabajo en curso. Este archivo agrega el candado que
--    hace que haya un tick a la vez.
--
-- Aditiva salvo el reemplazo declarado de requeue_expired_jobs_caughtcode().
-- ============================================================================


-- ============================================================================
-- 1 · requeue_expired_jobs_caughtcode() devuelve filas, no un número
-- ============================================================================
--
-- ⚠️ `create or replace` NO puede cambiar el tipo de retorno de una función que
-- ya existe ("cannot change return type of existing function"). Hay que soltarla
-- primero. Nadie depende de ella salvo el worker por RPC; los grants se reponen
-- más abajo (el drop se los lleva).
drop function if exists public.requeue_expired_jobs_caughtcode();

-- ⚠️ `language sql`, no `plpgsql`, a propósito.
--
-- Con `returns table (...)` en plpgsql, cada columna de salida se convierte en
-- una VARIABLE del bloque, y una variable llamada `status` o `id` colisiona con
-- las columnas homónimas de jobs_caughtcode adentro del cuerpo. En `language sql`
-- los nombres de `returns table` son solo nombres de columna del resultado: no
-- hay variables, no hay colisión posible, y de paso no hace falta `return query`.
--
-- Lo demás es idéntico a 0006 a propósito: el `for update skip locked` que
-- permite N workers en paralelo, el criterio de vencimiento (lease pasado, o
-- running sin lease hace más de una hora), el `failed` definitivo al agotar
-- max_attempts y el backoff con techo de 5 minutos para los que se reencolan.
create function public.requeue_expired_jobs_caughtcode()
returns table (
  id              uuid,
  analysis_run_id uuid,
  status          text
)
language sql
security definer
set search_path = ''
as $$
  with vencidos as (
    select j.id
    from public.jobs_caughtcode j
    where j.status = 'running'
      and (
        (j.lease_until is not null and j.lease_until < now())
        -- Cinturón y tiradores: un running sin lease es un bug de algún worker;
        -- igual no puede quedarse trabado para siempre.
        or (j.lease_until is null and j.updated_at < now() - interval '1 hour')
      )
    for update skip locked
  ),
  devueltos as (
    update public.jobs_caughtcode j
       set status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
           lease_until = null,
           last_error = case
             when j.attempts >= j.max_attempts
               then coalesce(j.last_error, 'El trabajo dejó de responder y se agotaron los reintentos.')
             else j.last_error
           end,
           -- Reintento con espera creciente, con techo de 5 minutos.
           run_after = case
             when j.attempts >= j.max_attempts then j.run_after
             else now() + make_interval(secs => least(300, 15 * (2 ^ j.attempts))::double precision)
           end,
           updated_at = now()
      from vencidos v
     where j.id = v.id
    returning j.id, j.analysis_run_id, j.status
  )
  select d.id, d.analysis_run_id, d.status::text
  from devueltos d;
$$;

comment on function public.requeue_expired_jobs_caughtcode() is
  'Devuelve a la cola los trabajos running con lease vencido; los que agotaron max_attempts quedan failed. Devuelve UNA FILA POR TRABAJO TOCADO (id, analysis_run_id, status) para que el servidor pueda reconciliar la corrida de los que quedaron failed: ver migración 0016.';


-- ============================================================================
-- 2 · Candado de worker: que no corran dos ticks en paralelo
-- ============================================================================
--
-- POR QUÉ UNA FILA CON VENCIMIENTO Y NO UN ADVISORY LOCK
-- -----------------------------------------------------
-- La opción "obvia" era `pg_try_advisory_xact_lock`. No sirve acá, y no es
-- cuestión de gusto:
--
--   · `pg_try_advisory_xact_lock` es de TRANSACCIÓN. PostgREST envuelve cada
--     RPC en su propia transacción y la cierra al responder, así que el candado
--     se soltaría en el mismo milisegundo en que la función devuelve — mucho
--     antes de que el tick empiece a trabajar. Protegería exactamente nada.
--
--   · `pg_try_advisory_lock` (de sesión) sí sobrevive a la llamada, pero
--     PostgREST usa un POOL de conexiones: el candado queda pegado a una sesión
--     que no controlamos y que se reutiliza para otros clientes. Si el tick se
--     muere por OOM, nadie llama a `pg_advisory_unlock` y el candado queda
--     tomado hasta que esa conexión del pool se recicle. O sea: exactamente el
--     modo de falla que hay que evitar — la cola parada para siempre.
--
-- Una fila con `expires_at` no tiene ninguno de los dos problemas: dura lo que
-- tiene que durar, la libera el titular al terminar, y si el titular se muere
-- vence sola. No hay estado que se pueda quedar trabado sin que el reloj lo
-- desarme.
create table public.worker_locks_caughtcode (
  -- Nombre del candado. Hoy hay uno solo ('worker_tick'), pero la tabla no
  -- cuesta nada de más y evita inventar otra cuando aparezca el segundo.
  name        text primary key,
  -- Quién lo tiene. Solo el titular puede soltarlo: así un tick que se pasó de
  -- tiempo y ya perdió el candado no le suelta el candado al que vino después.
  holder      text        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.worker_locks_caughtcode is
  'Candados de exclusión mutua del worker, con vencimiento. Un candado vencido se puede robar: es lo que hace que la cola no quede trabada si el que lo tenía se murió. Ver migración 0016.';
comment on column public.worker_locks_caughtcode.holder is
  'Identificador de la invocación que lo tomó. Solo ella puede soltarlo.';
comment on column public.worker_locks_caughtcode.expires_at is
  'A partir de acá cualquiera puede quedárselo. Es la red que cubre el caso "el titular se murió sin soltarlo".';

-- Solo el worker. Nadie desde el navegador toca esto: quien controle el candado
-- controla si la cola de TODAS las organizaciones avanza o no.
alter table public.worker_locks_caughtcode enable row level security;
-- Sin policies a propósito: RLS prendido y cero policies = nadie ve nada, salvo
-- service_role, que tiene BYPASSRLS.
revoke all on table public.worker_locks_caughtcode from anon, authenticated;
grant all on table public.worker_locks_caughtcode to service_role;


-- ── Tomar el candado ───────────────────────────────────────────────────────
-- Atómico en una sola sentencia: el `on conflict ... do update ... where` deja
-- que Postgres resuelva la carrera. Si la condición del `where` no se cumple
-- (el candado está vigente y es de otro), el UPDATE no toca nada, el RETURNING
-- no devuelve fila, y `v_tomado` queda null → false. No hay ventana entre
-- "consultar" y "escribir" porque no hay dos pasos.
create function public.try_acquire_worker_lock_caughtcode(
  p_name        text,
  p_holder      text,
  p_ttl_seconds int default 300
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Topes de cordura: un TTL de 0 dejaría el candado siempre libre (o sea, sin
  -- candado) y uno de un día dejaría la cola muerta si algo sale mal.
  v_ttl int := greatest(5, least(coalesce(p_ttl_seconds, 300), 3600));
  v_tomado boolean;
begin
  if p_name is null or p_holder is null or btrim(p_holder) = '' then
    raise exception 'El candado necesita nombre y titular.';
  end if;

  insert into public.worker_locks_caughtcode as l (name, holder, acquired_at, expires_at)
  values (
    p_name,
    p_holder,
    now(),
    now() + make_interval(secs => v_ttl::double precision)
  )
  on conflict (name) do update
     set holder      = excluded.holder,
         acquired_at = excluded.acquired_at,
         expires_at  = excluded.expires_at
   where l.expires_at < now()          -- venció: el titular anterior se murió o se colgó
      or l.holder = excluded.holder    -- ya era nuestro: extenderlo no es robarlo
  returning true into v_tomado;

  return coalesce(v_tomado, false);
end;
$$;

comment on function public.try_acquire_worker_lock_caughtcode(text, text, int) is
  'Intenta tomar un candado de worker por p_ttl_seconds. true si quedó tuyo, false si lo tiene otro y todavía no venció. Atómico. Ver migración 0016.';


-- ── Soltar el candado ──────────────────────────────────────────────────────
-- El filtro por holder es el punto: un tick que se pasó de tiempo, perdió el
-- candado por vencimiento y recién entonces llega a su `finally`, NO puede
-- soltarle el candado al tick que ya lo tomó. Devuelve false y sigue de largo.
create function public.release_worker_lock_caughtcode(
  p_name   text,
  p_holder text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borradas int;
begin
  delete from public.worker_locks_caughtcode l
   where l.name = p_name
     and l.holder = p_holder;

  get diagnostics v_borradas = row_count;
  return v_borradas > 0;
end;
$$;

comment on function public.release_worker_lock_caughtcode(text, text) is
  'Suelta un candado de worker, pero solo si sos su titular. false si ya no era tuyo (te venció y se lo llevó otro). Ver migración 0016.';


-- ============================================================================
-- 3 · Permisos
-- ============================================================================
-- Recordatorio de 0013/0014: `revoke ... from public` NO alcanza. Supabase trae
-- `alter default privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, así que toda función nueva NACE con EXECUTE a
-- nombre propio para anon y authenticated. Hay que nombrarlos.
--
-- Estas tres son puro worker: nadie con sesión de usuario las llama nunca.
revoke all on function public.requeue_expired_jobs_caughtcode()                     from public, anon, authenticated;
revoke all on function public.try_acquire_worker_lock_caughtcode(text, text, int)   from public, anon, authenticated;
revoke all on function public.release_worker_lock_caughtcode(text, text)            from public, anon, authenticated;

grant execute on function public.requeue_expired_jobs_caughtcode()                   to service_role;
grant execute on function public.try_acquire_worker_lock_caughtcode(text, text, int) to service_role;
grant execute on function public.release_worker_lock_caughtcode(text, text)          to service_role;
