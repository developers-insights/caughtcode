-- ============================================================================
-- caughtcode · 0013 · claim_job_caughtcode devuelve cero filas, no una fila vacía
-- ----------------------------------------------------------------------------
-- Arregla un bucle infinito real en el worker.
--
-- La versión de 0006 estaba declarada `returns public.jobs_caughtcode`: un TIPO
-- COMPUESTO, no `setof`. Una función así siempre devuelve exactamente una fila.
-- Cuando la cola está vacía y el cuerpo hace `return null`, Postgres no devuelve
-- "nada": devuelve una fila con TODAS las columnas en null, y PostgREST se la
-- entrega al cliente como `{ "id": null, "kind": null, ... }`.
--
-- Del otro lado, el worker veía un objeto donde esperaba `null`, lo tomaba como
-- un trabajo de verdad, y al intentar cerrarlo la base rechazaba el id:
--
--     Tomado: null null (intento 0/3)
--     invalid input syntax for type uuid: "null" [22P02]
--
-- ~2 intentos por segundo, indefinidamente, con la cola vacía.
--
-- La forma correcta de decir "no hay nada para hacer" es devolver CERO filas, y
-- para eso la función tiene que ser `returns setof`. Con `setof`, `return;` sin
-- valor devuelve el conjunto vacío y PostgREST responde `[]`.
--
-- Todo lo demás queda idéntico a 0006 a propósito: `security definer`,
-- `set search_path = ''`, el `for update skip locked` que permite N workers en
-- paralelo, el orden `run_after, created_at`, el `attempts + 1` del que depende
-- la lógica de reintentos, y el cálculo del lease.
--
-- Aditiva: no toca ninguna otra función, tabla ni política.
-- ============================================================================

-- `create or replace` NO puede cambiar el tipo de retorno de una función
-- existente ("cannot change return type of existing function"). Hay que soltarla
-- primero. Nadie depende de ella salvo el worker vía RPC, así que el drop es
-- seguro; los grants se reponen al final de este archivo.
drop function if exists public.claim_job_caughtcode(text[], int);

create function public.claim_job_caughtcode(
  p_kinds         text[] default null,
  p_lease_seconds int default 300
)
returns setof public.jobs_caughtcode
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

  -- Cero filas. NO `return null`: eso, en una función que devuelve filas,
  -- se materializa como una fila entera de nulls. Es el bug que arregla 0013.
  if not found then
    return;
  end if;

  update public.jobs_caughtcode
     set status      = 'running',
         attempts    = attempts + 1,
         lease_until = now() + make_interval(secs => v_lease::double precision),
         last_error  = null,
         updated_at  = now()
   where id = v_job.id
  returning * into v_job;

  return next v_job;
end;
$$;

comment on function public.claim_job_caughtcode(text[], int) is
  'Toma UN trabajo en cola cuyo run_after ya venció, lo pasa a running, suma un intento y le pone lease. Devuelve CERO filas si no hay nada para hacer (nunca una fila de nulls: ver migración 0013).';


-- ── Permisos ───────────────────────────────────────────────────────────────
-- El `drop` de arriba se llevó los grants: hay que reponerlos sí o sí.
--
-- Ojo con `revoke ... from public`: PUBLIC es el pseudo-rol, y NO alcanza. Supabase
-- tiene `alter default privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, así que toda función nueva nace con EXECUTE para
-- anon y authenticated. En una función `security definer` que reparte trabajos de
-- la cola eso es un agujero: cualquiera con la clave pública podría robar trabajos
-- de cualquier organización. Se revoca por nombre, explícito.
revoke all on function public.claim_job_caughtcode(text[], int) from public;
revoke all on function public.claim_job_caughtcode(text[], int) from anon;
revoke all on function public.claim_job_caughtcode(text[], int) from authenticated;
grant execute on function public.claim_job_caughtcode(text[], int) to service_role;

-- Su gemela arrastra el mismo agujero desde 0006, por el mismo motivo: el
-- `revoke ... from public` de entonces no alcanzaba. Lo detectó `get_advisors`
-- (anon_security_definer_function_executable). Cualquiera con la clave pública
-- podía llamar /rest/v1/rpc/requeue_expired_jobs_caughtcode y soltarle el lease
-- a los trabajos en curso de todas las organizaciones. Se cierra acá porque es
-- la misma superficie: las dos funciones de la cola.
revoke all on function public.requeue_expired_jobs_caughtcode() from public;
revoke all on function public.requeue_expired_jobs_caughtcode() from anon;
revoke all on function public.requeue_expired_jobs_caughtcode() from authenticated;
grant execute on function public.requeue_expired_jobs_caughtcode() to service_role;
