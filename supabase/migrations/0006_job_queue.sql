-- ============================================================================
-- caughtcode · 0006 · Cola de trabajos
-- ----------------------------------------------------------------------------
-- Dos funciones y nada más:
--   claim_job_caughtcode()            → un worker toma un trabajo sin pisarse con otro.
--   requeue_expired_jobs_caughtcode() → lo que se quedó colgado vuelve a la cola.
--
-- La segunda es la que hace que un trabajo encolado sobreviva al reinicio del
-- worker: si el proceso muere a mitad, el lease vence y el trabajo se reparte
-- de nuevo. Conviene correrla desde un cron cada minuto.
--
-- `for update skip locked` es lo que permite tener N workers en paralelo sin
-- coordinación externa: cada uno se lleva una fila distinta y nadie espera.
-- ============================================================================

-- ── Tomar un trabajo ───────────────────────────────────────────────────────
create or replace function public.claim_job_caughtcode(
  p_kinds         text[] default null,
  p_lease_seconds int default 300
)
returns public.jobs_caughtcode
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs_caughtcode;
  v_lease int := coalesce(nullif(p_lease_seconds, 0), 300);
begin
  if v_lease < 0 then
    v_lease := 300;
  end if;

  select j.* into v_job
  from public.jobs_caughtcode j
  where j.status = 'queued'
    and j.run_after <= now()
    and (
      p_kinds is null
      or coalesce(array_length(p_kinds, 1), 0) = 0
      or j.kind = any (p_kinds)
    )
  order by j.run_after, j.created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.jobs_caughtcode
     set status      = 'running',
         attempts    = attempts + 1,
         lease_until = now() + make_interval(secs => v_lease::double precision),
         last_error  = null,
         updated_at  = now()
   where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;

comment on function public.claim_job_caughtcode(text[], int) is
  'Toma UN trabajo en cola cuyo run_after ya venció, lo pasa a running, suma un intento y le pone lease. Devuelve null si no hay nada para hacer.';


-- ── Devolver a la cola lo que se quedó colgado ──────────────────────────────
create or replace function public.requeue_expired_jobs_caughtcode()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
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
    returning j.id
  )
  select count(*)::int into v_count from devueltos;

  return v_count;
end;
$$;

comment on function public.requeue_expired_jobs_caughtcode() is
  'Devuelve a la cola los trabajos running con lease vencido. Los que agotaron max_attempts quedan failed. Devuelve cuántos tocó.';


-- ── Permisos ───────────────────────────────────────────────────────────────
-- Solo el worker. Nadie desde el navegador toca la cola: encolar y ejecutar
-- cuesta dinero, y el costo se muestra antes de gastarlo.
revoke all on function public.claim_job_caughtcode(text[], int)   from public;
revoke all on function public.requeue_expired_jobs_caughtcode()   from public;

grant execute on function public.claim_job_caughtcode(text[], int) to service_role;
grant execute on function public.requeue_expired_jobs_caughtcode() to service_role;
