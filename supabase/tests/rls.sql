-- ============================================================================
-- caughtcode · Prueba de aislamiento entre organizaciones
-- ----------------------------------------------------------------------------
-- Sería vergonzoso que el auditor de RLS filtre datos entre clientes. Esto lo
-- verifica de verdad: simula los claims del JWT de dos personas de dos
-- organizaciones distintas y comprueba que ninguna ve una sola fila de la otra.
--
-- Cómo correrlo (contra la base local o contra una rama, NUNCA contra la de un
-- usuario):
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
--
-- Todo pasa dentro de una transacción que termina en ROLLBACK: no deja nada.
-- Si algo falla, la transacción aborta con el mensaje del chequeo que falló.
-- Si termina sin errores, pasó.
-- ============================================================================

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. La base es COMPARTIDA: caughtcode no puede tener nada colgado de auth.users.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal
  ) then
    raise exception 'PELIGRO: hay un trigger sobre auth.users. En una base compartida, un error nuestro ahí rompe el registro del otro producto.';
  end if;
  raise notice 'OK · auth.users sin triggers nuestros: no tocamos el otro producto.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1. Semilla. Corre como postgres, que no pasa por RLS.
--    El espacio de trabajo lo crea el código llamando a ensure_org_caughtcode,
--    no un trigger. Esto prueba también que esa función es idempotente.
-- ────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'ana@ejemplo.test',  '{"full_name":"Ana"}'::jsonb),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bruno@ejemplo.test', '{"full_name":"Bruno"}'::jsonb);

-- Así lo llama el servidor en el primer ingreso.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_org_a uuid;
  v_org_b uuid;
  v_otra_vez uuid;
  v_proj_a uuid;
  v_proj_b uuid;
  v_run_a uuid;
  v_run_b uuid;
  v_thread_b uuid;
begin
  v_org_a := public.ensure_org_caughtcode('aaaaaaaa-0000-4000-8000-00000000000a');
  v_org_b := public.ensure_org_caughtcode('bbbbbbbb-0000-4000-8000-00000000000b');

  if v_org_a is null or v_org_b is null then
    raise exception 'FALLÓ: ensure_org_caughtcode no creó el espacio de trabajo.';
  end if;
  if v_org_a = v_org_b then
    raise exception 'FALLÓ: dos personas distintas terminaron en la misma organización.';
  end if;

  -- Llamarla de nuevo (cada ingreso lo hace) no puede duplicar nada.
  v_otra_vez := public.ensure_org_caughtcode('aaaaaaaa-0000-4000-8000-00000000000a');
  if v_otra_vez <> v_org_a then
    raise exception 'FALLÓ: ensure_org_caughtcode no es idempotente, creó una segunda organización.';
  end if;
  if (select count(*) from public.organizations_caughtcode
        where owner_user_id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b')) <> 2 then
    raise exception 'FALLÓ: quedaron % organizaciones de los usuarios sembrados en vez de 2.',
      (select count(*) from public.organizations_caughtcode
        where owner_user_id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b'));
  end if;

  if not exists (
    select 1 from public.org_members_caughtcode
    where org_id = v_org_a and user_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and role = 'owner'
  ) then
    raise exception 'FALLÓ: quien crea la organización no quedó como owner en org_members_caughtcode.';
  end if;

  v_proj_a := '11111111-0000-4000-8000-000000000001';
  v_proj_b := '22222222-0000-4000-8000-000000000002';

  insert into public.projects_caughtcode (id, org_id, name, source_type, storage_path)
  values
    (v_proj_a, v_org_a, 'App de Ana',   'github', 'repos/a/1.zip'),
    (v_proj_b, v_org_b, 'App de Bruno', 'zip',    'repos/b/2.zip');

  insert into public.analysis_runs_caughtcode (id, project_id, status)
  values
    ('33333333-0000-4000-8000-000000000003', v_proj_a, 'succeeded'),
    ('44444444-0000-4000-8000-000000000004', v_proj_b, 'succeeded');

  v_run_a := '33333333-0000-4000-8000-000000000003';
  v_run_b := '44444444-0000-4000-8000-000000000004';

  insert into public.code_index_caughtcode (analysis_run_id) values (v_run_a), (v_run_b);

  insert into public.findings_caughtcode (
    id, analysis_run_id, project_id, pillar, check_id, severity, confidence,
    title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank
  )
  values
    ('55555555-0000-4000-8000-000000000005', v_run_a, v_proj_a, 'security', 'rls_abierta',
     'critical', 'confirmed',
     'Cualquiera puede leer los datos de tus clientes',
     'Las reglas que definen quién ve qué están apagadas en una tabla.',
     'Alguien con la dirección de tu app puede descargarse la lista completa.',
     'Activá las reglas de acceso en la tabla clientes y limitá la lectura al dueño de cada fila.',
     '[{"kind":"database","object":"public.clientes","detail":"sin RLS"}]'::jsonb, 1),
    ('66666666-0000-4000-8000-000000000006', v_run_b, v_proj_b, 'security', 'rls_abierta',
     'critical', 'confirmed',
     'Secreto de Bruno',
     'Esto no lo tiene que ver Ana jamás.',
     'Si Ana ve esta fila, el producto está roto.',
     'No aplica: es una fila de prueba.',
     '[{"kind":"database","object":"public.secreto","detail":"privado"}]'::jsonb, 1);

  insert into public.agent_sessions_caughtcode (analysis_run_id, task_id, outcome, conclusion_plain, recording_url)
  values
    (v_run_a, 'login', 'completed', 'Pude entrar sin problemas.', 'recordings/a/1.webm'),
    (v_run_b, 'login', 'completed', 'Grabación privada de Bruno.', 'recordings/b/2.webm');

  insert into public.videos_caughtcode (finding_id, project_id, kind, status, url)
  values
    ('55555555-0000-4000-8000-000000000005', v_proj_a, 'finding', 'ready', 'videos_caughtcode/a/1.mp4'),
    ('66666666-0000-4000-8000-000000000006', v_proj_b, 'finding', 'ready', 'videos_caughtcode/b/2.mp4');

  insert into public.comment_scans_caughtcode (project_id, analysis_run_id, hits)
  values (v_proj_a, v_run_a, '[]'::jsonb), (v_proj_b, v_run_b, '[]'::jsonb);

  insert into public.chat_threads_caughtcode (id, project_id, user_id, title)
  values
    ('77777777-0000-4000-8000-000000000007', v_proj_a, 'aaaaaaaa-0000-4000-8000-00000000000a', 'Dudas de Ana'),
    ('88888888-0000-4000-8000-000000000008', v_proj_b, 'bbbbbbbb-0000-4000-8000-00000000000b', 'Dudas de Bruno');

  v_thread_b := '88888888-0000-4000-8000-000000000008';

  insert into public.chat_messages_caughtcode (thread_id, role, content)
  values
    ('77777777-0000-4000-8000-000000000007', 'user', 'Hola'),
    (v_thread_b, 'user', 'Esto es privado de Bruno');

  insert into public.usage_events_caughtcode (org_id, project_id, analysis_run_id, kind, units, unit_label, cost_usd, detail)
  values
    (v_org_a, v_proj_a, v_run_a, 'llm', 1000, 'tokens', 0.01, 'análisis del repo de Ana'),
    (v_org_b, v_proj_b, v_run_b, 'llm', 1000, 'tokens', 0.01, 'análisis del repo de Bruno');

  insert into public.subscriptions_caughtcode (org_id, stripe_customer_id, plan, status)
  values (v_org_a, 'cus_a', 'monitoring', 'active'), (v_org_b, 'cus_b', 'monitoring', 'active');

  insert into public.jobs_caughtcode (id, org_id, project_id, analysis_run_id, kind, payload)
  values
    ('99999999-0000-4000-8000-000000000009', v_org_a, v_proj_a, v_run_a, 'run_checks', '{"quien":"ana"}'::jsonb),
    ('99999999-0000-4000-8000-00000000000b', v_org_b, v_proj_b, v_run_b, 'run_checks', '{"quien":"bruno"}'::jsonb);

  -- Se guardan los ids ahora: después, con RLS puesta, Ana no va a poder
  -- resolver el de Bruno ni con el nombre ni con el owner (que es justamente
  -- lo que verifica el bloque siguiente).
  perform set_config('test.org_a', v_org_a::text, true);
  perform set_config('test.org_b', v_org_b::text, true);

  raise notice 'Semilla lista. Org A = %, Org B = %', v_org_a, v_org_b;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2. Nos hacemos pasar por Ana.
-- ────────────────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  'aaaaaaaa-0000-4000-8000-00000000000a',
    'role', 'authenticated',
    'aud',  'authenticated'
  )::text,
  true
);

do $$
declare
  v_org_b uuid;
begin
  -- Lo propio se ve.
  if (select count(*) from public.projects_caughtcode) <> 1 then
    raise exception 'FALLÓ: Ana debería ver exactamente 1 proyecto, ve %.',
      (select count(*) from public.projects_caughtcode);
  end if;

  if not exists (select 1 from public.projects_caughtcode where id = '11111111-0000-4000-8000-000000000001') then
    raise exception 'FALLÓ: Ana no ve su propio proyecto.';
  end if;

  -- Lo ajeno, ni una fila. Tabla por tabla, sin excepciones.
  if exists (select 1 from public.projects_caughtcode        where id = '22222222-0000-4000-8000-000000000002') then
    raise exception 'FILTRACIÓN: Ana ve el proyecto de Bruno.'; end if;
  if exists (select 1 from public.analysis_runs_caughtcode   where id = '44444444-0000-4000-8000-000000000004') then
    raise exception 'FILTRACIÓN: Ana ve la corrida de Bruno.'; end if;
  if exists (select 1 from public.code_index_caughtcode      where analysis_run_id = '44444444-0000-4000-8000-000000000004') then
    raise exception 'FILTRACIÓN: Ana ve el índice de código de Bruno.'; end if;
  if exists (select 1 from public.findings_caughtcode        where id = '66666666-0000-4000-8000-000000000006') then
    raise exception 'FILTRACIÓN: Ana ve un hallazgo de Bruno.'; end if;
  if exists (select 1 from public.agent_sessions_caughtcode  where recording_url = 'recordings/b/2.webm') then
    raise exception 'FILTRACIÓN: Ana ve la grabación de Bruno.'; end if;
  if exists (select 1 from public.videos_caughtcode          where url = 'videos_caughtcode/b/2.mp4') then
    raise exception 'FILTRACIÓN: Ana ve el video de Bruno.'; end if;
  if exists (select 1 from public.comment_scans_caughtcode   where project_id = '22222222-0000-4000-8000-000000000002') then
    raise exception 'FILTRACIÓN: Ana ve el escaneo de comentarios de Bruno.'; end if;
  if exists (select 1 from public.chat_threads_caughtcode    where id = '88888888-0000-4000-8000-000000000008') then
    raise exception 'FILTRACIÓN: Ana ve el hilo de chat de Bruno.'; end if;
  if exists (select 1 from public.chat_messages_caughtcode   where content = 'Esto es privado de Bruno') then
    raise exception 'FILTRACIÓN: Ana ve un mensaje de Bruno.'; end if;
  if exists (select 1 from public.usage_events_caughtcode    where project_id = '22222222-0000-4000-8000-000000000002') then
    raise exception 'FILTRACIÓN: Ana ve el consumo de Bruno.'; end if;
  if exists (select 1 from public.subscriptions_caughtcode   where stripe_customer_id = 'cus_b') then
    raise exception 'FILTRACIÓN: Ana ve la suscripción de Bruno.'; end if;
  if exists (select 1 from public.jobs_caughtcode            where id = '99999999-0000-4000-8000-00000000000b') then
    raise exception 'FILTRACIÓN: Ana ve un trabajo en cola de Bruno.'; end if;

  -- Ni la organización ni sus miembros.
  if (select count(*) from public.organizations_caughtcode) <> 1 then
    raise exception 'FILTRACIÓN: Ana ve % organizaciones en vez de 1.',
      (select count(*) from public.organizations_caughtcode); end if;
  if (select count(*) from public.org_members_caughtcode) <> 1 then
    raise exception 'FILTRACIÓN: Ana ve % membresías en vez de 1.',
      (select count(*) from public.org_members_caughtcode); end if;

  -- El helper tampoco miente.
  select id into v_org_b from public.organizations_caughtcode where name = 'Espacio de Bruno';
  if v_org_b is not null then
    raise exception 'FILTRACIÓN: Ana resuelve la organización de Bruno por nombre.';
  end if;

  raise notice 'OK · Ana no ve absolutamente nada de Bruno.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Escritura: lo que Ana no puede hacer.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_org_b uuid := current_setting('test.org_b')::uuid;
begin
  -- Ana conoce el id de la organización de Bruno (se lo pasamos a mano, como
  -- haría alguien que lo vio en una URL). Aun así no puede escribir en ella.
  begin
    insert into public.projects_caughtcode (org_id, name, source_type)
    values (v_org_b, 'Proyecto colado', 'zip');
    raise exception 'FILTRACIÓN: Ana pudo crear un proyecto dentro de la organización de Bruno.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  begin
    insert into public.findings_caughtcode (
      analysis_run_id, project_id, pillar, check_id, severity, confidence,
      title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank
    ) values (
      '33333333-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000001',
      'security', 'inventado', 'low', 'confirmed', 'x', 'x', 'x', 'x',
      '[{"kind":"code","file":"a.ts","line":1}]'::jsonb, 9
    );
    raise exception 'FALLÓ: Ana pudo fabricar un hallazgo. findings_caughtcode es tabla de sistema.';
  exception
    when insufficient_privilege then null;  -- esperado: sin GRANT de insert
  end;

  begin
    update public.findings_caughtcode set severity = 'low'
    where id = '55555555-0000-4000-8000-000000000005';
    raise exception 'FALLÓ: Ana pudo editar un hallazgo por UPDATE directo.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  begin
    insert into public.chat_messages_caughtcode (thread_id, role, content)
    values ('77777777-0000-4000-8000-000000000007', 'assistant', 'Respuesta falsa con citas inventadas');
    raise exception 'FALLÓ: Ana pudo insertar un mensaje como si fuera el asistente.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  begin
    perform public.delete_project_cascade_caughtcode('22222222-0000-4000-8000-000000000002');
    raise exception 'FILTRACIÓN: Ana pudo borrar el proyecto de Bruno.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  begin
    perform public.set_finding_status_caughtcode('66666666-0000-4000-8000-000000000006', 'dismissed');
    raise exception 'FILTRACIÓN: Ana pudo cambiar el estado de un hallazgo de Bruno.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  -- Guarda de columnas de projects_caughtcode (migración 0019). RLS filtra
  -- filas, no columnas: sin el trigger, Ana edita su propio proyecto —cosa que
  -- puede— y de paso se lleva puesto de quién es y de dónde baja el worker el
  -- código.
  begin
    update public.projects_caughtcode set org_id = v_org_b
    where id = '11111111-0000-4000-8000-000000000001';
    raise exception 'FALLÓ: Ana pudo mudar su proyecto a la organización de Bruno.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  -- El caso que importa: apuntar la copia al .zip de Bruno para que el worker
  -- —que baja con service_role y no pasa por las policies del bucket— se lo
  -- descomprima a Ana y publique hallazgos con código ajeno.
  begin
    update public.projects_caughtcode
    set storage_path = v_org_b || '/22222222-0000-4000-8000-000000000002/source.zip'
    where id = '11111111-0000-4000-8000-000000000001';
    raise exception 'FILTRACIÓN: Ana pudo apuntar la copia de su proyecto al código de Bruno.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  -- Y por arriba tampoco: `..` se normaliza del otro lado y se escapa de la
  -- carpeta aunque la ruta empiece bien.
  begin
    update public.projects_caughtcode
    set storage_path = current_setting('test.org_a') ||
                       '/11111111-0000-4000-8000-000000000001/../../otra/cosa.zip'
    where id = '11111111-0000-4000-8000-000000000001';
    raise exception 'FILTRACIÓN: Ana pudo salirse de su carpeta con "..".';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  raise notice 'OK · Ana no puede escribir nada ajeno ni fabricar datos de sistema.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 4. Lo que Ana sí puede hacer.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_row public.findings_caughtcode;
begin
  v_row := public.set_finding_status_caughtcode('55555555-0000-4000-8000-000000000005', 'fixed');
  if v_row.status <> 'fixed' or v_row.resolved_at is null then
    raise exception 'FALLÓ: marcar como resuelto no funcionó sobre un hallazgo propio.';
  end if;

  insert into public.chat_messages_caughtcode (thread_id, role, content)
  values ('77777777-0000-4000-8000-000000000007', 'user', 'Mensaje propio');

  update public.projects_caughtcode set name = 'App de Ana (renombrada)'
  where id = '11111111-0000-4000-8000-000000000001';

  -- La otra mitad de la guarda de 0019: el onboarding escribe `storage_path`
  -- con la sesión de la persona, no con el service_role. Si el trigger
  -- bloqueara la columna en vez de validarla, no se podría crear un proyecto.
  update public.projects_caughtcode
  set storage_path = current_setting('test.org_a') ||
                     '/11111111-0000-4000-8000-000000000001/source.zip'
  where id = '11111111-0000-4000-8000-000000000001';

  raise notice 'OK · Ana sí puede operar sobre lo suyo.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5. Ahora Bruno. Espejo exacto: no ve nada de Ana.
-- ────────────────────────────────────────────────────────────────────────────
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  'bbbbbbbb-0000-4000-8000-00000000000b',
    'role', 'authenticated',
    'aud',  'authenticated'
  )::text,
  true
);

do $$
begin
  if (select count(*) from public.projects_caughtcode) <> 1 then
    raise exception 'FALLÓ: Bruno debería ver 1 proyecto, ve %.',
      (select count(*) from public.projects_caughtcode); end if;
  if exists (select 1 from public.projects_caughtcode where id = '11111111-0000-4000-8000-000000000001') then
    raise exception 'FILTRACIÓN: Bruno ve el proyecto de Ana.'; end if;
  if exists (select 1 from public.findings_caughtcode where id = '55555555-0000-4000-8000-000000000005') then
    raise exception 'FILTRACIÓN: Bruno ve un hallazgo de Ana.'; end if;
  if exists (select 1 from public.chat_messages_caughtcode where content = 'Mensaje propio') then
    raise exception 'FILTRACIÓN: Bruno ve un mensaje de Ana.'; end if;

  raise notice 'OK · El aislamiento es simétrico.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6. Sin sesión (rol anon): cero acceso, ni siquiera al catálogo de filas.
-- ────────────────────────────────────────────────────────────────────────────
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);

do $$
begin
  begin
    perform 1 from public.projects_caughtcode;
    raise exception 'FILTRACIÓN: anon pudo consultar public.projects_caughtcode.';
  exception
    when insufficient_privilege then null;  -- esperado: sin GRANT de select
  end;

  begin
    perform 1 from public.findings_caughtcode;
    raise exception 'FILTRACIÓN: anon pudo consultar public.findings_caughtcode.';
  exception
    when insufficient_privilege then null;  -- esperado
  end;

  raise notice 'OK · Sin sesión no hay acceso a nada.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 7. La cola: tomar un trabajo y recuperarlo si el worker se cae.
-- ────────────────────────────────────────────────────────────────────────────
reset role;

do $$
declare
  v_job public.jobs_caughtcode;
  v_recuperados int;
begin
  v_job := public.claim_job_caughtcode(array['run_checks'], 60);

  if v_job.id is null then
    raise exception 'FALLÓ: claim_job_caughtcode no devolvió ningún trabajo habiendo dos en cola.';
  end if;
  if v_job.status <> 'running' then
    raise exception 'FALLÓ: el trabajo tomado quedó en % en vez de running.', v_job.status; end if;
  if v_job.attempts <> 1 then
    raise exception 'FALLÓ: attempts quedó en % en vez de 1.', v_job.attempts; end if;
  if v_job.lease_until is null then
    raise exception 'FALLÓ: el trabajo tomado quedó sin lease.'; end if;
  -- Devuelve la fila completa, no solo el id: el runner necesita payload y kind.
  if v_job.org_id is null or v_job.payload is null or v_job.kind is null
     or v_job.max_attempts is null or v_job.run_after is null then
    raise exception 'FALLÓ: claim_job_caughtcode no devolvió la fila completa de jobs_caughtcode.'; end if;

  -- Se cayó el worker: el lease vence y nadie terminó el trabajo.
  update public.jobs_caughtcode set lease_until = now() - interval '1 minute' where id = v_job.id;

  v_recuperados := public.requeue_expired_jobs_caughtcode();
  if v_recuperados <> 1 then
    raise exception 'FALLÓ: requeue_expired_jobs_caughtcode recuperó % trabajos en vez de 1.', v_recuperados; end if;

  if (select status from public.jobs_caughtcode where id = v_job.id) <> 'queued' then
    raise exception 'FALLÓ: el trabajo abandonado no volvió a la cola.'; end if;

  -- Agotados los reintentos, queda failed en vez de girar para siempre.
  update public.jobs_caughtcode
     set status = 'running', attempts = max_attempts, lease_until = now() - interval '1 minute'
   where id = v_job.id;

  perform public.requeue_expired_jobs_caughtcode();

  if (select status from public.jobs_caughtcode where id = v_job.id) <> 'failed' then
    raise exception 'FALLÓ: un trabajo sin reintentos disponibles debería quedar failed.'; end if;

  raise notice 'OK · La cola sobrevive a que se caiga el worker.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8. Borrado real: se lleva los datos y devuelve los archivos pendientes.
--    Se prueba por el camino de verdad: Ana borrando su propio proyecto.
-- ────────────────────────────────────────────────────────────────────────────
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  'aaaaaaaa-0000-4000-8000-00000000000a',
    'role', 'authenticated',
    'aud',  'authenticated'
  )::text,
  true
);

do $$
declare
  v_resultado jsonb;
begin
  v_resultado := public.delete_project_cascade_caughtcode('11111111-0000-4000-8000-000000000001');

  if exists (select 1 from public.findings_caughtcode where project_id = '11111111-0000-4000-8000-000000000001') then
    raise exception 'FALLÓ: quedaron hallazgos después de borrar el proyecto.'; end if;
  if exists (select 1 from public.analysis_runs_caughtcode where project_id = '11111111-0000-4000-8000-000000000001') then
    raise exception 'FALLÓ: quedaron corridas después de borrar el proyecto.'; end if;

  if not (v_resultado -> 'storage_objects' @> '"repos/a/1.zip"'::jsonb) then
    raise exception 'FALLÓ: el borrado no informó el código a eliminar del storage. Devolvió %', v_resultado;
  end if;
  if not (v_resultado -> 'storage_objects' @> '"recordings/a/1.webm"'::jsonb) then
    raise exception 'FALLÓ: el borrado no informó la grabación a eliminar del storage.';
  end if;

  raise notice 'OK · El borrado es real y avisa qué archivos hay que sacar del storage.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9. Las reglas duras del producto, verificadas por la base.
--    Corre con permisos plenos a propósito: se prueba que ni siquiera el worker
--    puede saltearse estas reglas.
-- ────────────────────────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  -- Ningún hallazgo sin evidencia.
  begin
    insert into public.findings_caughtcode (
      analysis_run_id, project_id, pillar, check_id, severity, confidence,
      title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank
    ) values (
      '44444444-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000002',
      'security', 'sin_evidencia', 'low', 'to_review', 'x', 'x', 'x', 'x', '[]'::jsonb, 8
    );
    raise exception 'FALLÓ: entró un hallazgo sin evidencia.';
  exception
    when check_violation then null;  -- esperado
  end;

  -- Como mucho 3 destacados por corrida.
  begin
    insert into public.findings_caughtcode (
      analysis_run_id, project_id, pillar, check_id, severity, confidence,
      title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank
    ) values (
      '44444444-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000002',
      'security', 'segundo_rank_1', 'low', 'confirmed', 'x', 'x', 'x', 'x',
      '[{"kind":"code","file":"a.ts","line":1}]'::jsonb, 1
    );
    raise exception 'FALLÓ: entraron dos hallazgos con el mismo puesto destacado.';
  exception
    when unique_violation then null;  -- esperado
  end;

  -- Un video que no cuelga de nada sería invisible para todos.
  begin
    insert into public.videos_caughtcode (kind, status) values ('tutorial', 'queued');
    raise exception 'FALLÓ: entró un video sin dueño.';
  exception
    when check_violation then null;  -- esperado
  end;

  raise notice 'OK · Las reglas duras las hace cumplir la base, no la buena voluntad.';
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. Lo que pidió el frente de la cola (migración 0010).
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  -- Costo por corrida, sin caminos de respaldo imprecisos.
  if (select coalesce(sum(cost_usd), 0)
        from public.usage_events_caughtcode
       where analysis_run_id = '44444444-0000-4000-8000-000000000004') <= 0 then
    raise exception 'FALLÓ: no se puede sumar el costo de una corrida por analysis_run_id.';
  end if;

  if (select detail from public.usage_events_caughtcode
       where analysis_run_id = '44444444-0000-4000-8000-000000000004') is null then
    raise exception 'FALLÓ: usage_events_caughtcode.detail no guardó nada.';
  end if;

  -- Realtime: sin esto el progreso en vivo nunca llega a la pantalla.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'analysis_runs_caughtcode'
  ) then
    raise exception 'FALLÓ: analysis_runs_caughtcode no está en la publicación supabase_realtime.';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'findings_caughtcode'
  ) then
    raise exception 'FALLÓ: findings_caughtcode no está en la publicación supabase_realtime.';
  end if;

  -- Los índices que pidió el frente de la cola.
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'jobs_cola_idx_caughtcode') then
    raise exception 'FALLÓ: falta el índice parcial de la cola (status, run_after) where queued.'; end if;
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'jobs_lease_expiry_idx_caughtcode') then
    raise exception 'FALLÓ: falta el índice (status, lease_until) where running.'; end if;
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'jobs_analysis_run_id_idx_caughtcode') then
    raise exception 'FALLÓ: falta el índice de jobs_caughtcode por analysis_run_id.'; end if;
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'usage_events_analysis_run_id_idx_caughtcode') then
    raise exception 'FALLÓ: falta el índice de usage_events_caughtcode por analysis_run_id.'; end if;

  raise notice 'OK · Costo por corrida, realtime e índices de la cola en su lugar.';
end;
$$;

-- El worker escribe sin que ninguna policy lo frene.
set local role service_role;

do $$
declare
  v_org_b uuid := current_setting('test.org_b')::uuid;
  v_job_id uuid;
begin
  insert into public.jobs_caughtcode (org_id, project_id, analysis_run_id, kind, payload)
  values (v_org_b, '22222222-0000-4000-8000-000000000002',
          '44444444-0000-4000-8000-000000000004', 'generate_video', '{"desde":"worker"}'::jsonb)
  returning id into v_job_id;

  update public.jobs_caughtcode set stage = 'renderizando', progress = 40 where id = v_job_id;

  insert into public.usage_events_caughtcode (org_id, project_id, analysis_run_id, kind, units, unit_label, cost_usd, detail)
  values (v_org_b, '22222222-0000-4000-8000-000000000002',
          '44444444-0000-4000-8000-000000000004', 'render', 1.5, 'minutos de video', 0.02,
          'render del hallazgo destacado');

  update public.analysis_runs_caughtcode set stage = 'generando videos_caughtcode', progress = 80
   where id = '44444444-0000-4000-8000-000000000004';

  if (select progress from public.jobs_caughtcode where id = v_job_id) <> 40 then
    raise exception 'FALLÓ: el service_role no pudo actualizar el progreso del job.'; end if;

  raise notice 'OK · El service_role escribe en jobs_caughtcode, usage_events_caughtcode y analysis_runs_caughtcode sin trabas.';
end;
$$;

reset role;

do $$ begin raise notice '=== TODO EN VERDE ==='; end; $$;

rollback;
