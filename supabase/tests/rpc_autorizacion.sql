-- ============================================================================
-- caughtcode · Las RPC no le contestan a quien no es de la casa
-- ----------------------------------------------------------------------------
-- `grants_rpc.sql` responde QUIÉN puede llamar a cada función. Este archivo
-- responde la otra mitad, que es la que se rompe en silencio: QUÉ hace la
-- función cuando la llama alguien con sesión que no tiene nada que ver con esos
-- datos.
--
-- Las diez funciones que mira este test son SECURITY DEFINER y `authenticated`
-- tiene EXECUTE sobre todas — a propósito: las evalúan las policies de RLS y las
-- llama el navegador. O sea que corren como `postgres`, ignorando RLS, con un
-- uuid que viene por parámetro desde el cliente. La única cosa entre eso y una
-- fuga es que la función valide al llamante ella misma. No hay segunda red.
--
-- Cuatro de ellas (`org_of_*`) traducen un id cualquiera a su organización, y esa
-- respuesta alimenta las policies de RLS. Si contestan sin validar membresía, un
-- uuid ajeno se convierte en una llave: ya pasó una vez, lo cerró la 0014. Este
-- archivo existe para enterarnos si vuelve a pasar, porque un `create or replace`
-- futuro puede sacar el chequeo sin que se note en el diff.
--
-- Es autónomo: arma sus propios datos, no depende de lo que haya en la base, y
-- termina en rollback. Se puede correr contra cualquier base, incluida la de
-- producción:
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rpc_autorizacion.sql
--
-- Necesita conectarse con un rol que pueda hacer `set role authenticated`
-- (`postgres` sirve) y que existan al menos dos personas en `auth.users`, porque
-- las tablas tienen FK contra esa tabla. Si no las hay, se saltea avisando en vez
-- de dar un falso OK.
--
-- Solo escribe en tablas `_caughtcode`. `auth.users` se LEE, nunca se toca: esta
-- base es compartida con otro producto y esa tabla es de ellos.
-- ============================================================================

begin;

-- -- 0. Escenario: una organizacion victima y una persona ajena --------------
-- La victima tiene de todo (proyecto, corrida, hallazgo, hilo) porque cada
-- `org_of_*` traduce un tipo de id distinto. El ajeno es un uuid que no figura
-- en ninguna tabla nuestra: es el caso mas adverso y el mas barato de simular.
--
-- Los dos uuids viajan en variables de sesion y no en una tabla temporal: la
-- seccion 1 corre como `authenticated`, que no tiene permiso sobre las tablas
-- temporales creadas por `postgres`.
do $$
declare
  v_duenio uuid;
  v_raso   uuid;
begin
  perform set_config('tc.saltado', '0', false);

  select id into v_duenio from auth.users order by created_at limit 1;
  select id into v_raso   from auth.users
   where id is distinct from v_duenio order by created_at limit 1;

  if v_duenio is null or v_raso is null then
    perform set_config('tc.saltado', '1', false);
    raise notice 'SALTEADO - Hacen falta dos personas en auth.users para armar el escenario. Esto NO es un OK.';
    return;
  end if;

  perform set_config('tc.duenio', v_duenio::text, false);
  perform set_config('tc.raso',   v_raso::text,   false);

  -- La organizacion victima. El trigger de la 0001 suma la membresia de dueno.
  insert into public.organizations_caughtcode (id, name, owner_user_id, plan)
  values ('cc000000-0000-4000-8000-000000000001', 'Org victima (test)', v_duenio, 'free');

  -- Alguien de la casa, pero sin galones: sirve para separar "es miembro" de
  -- "puede borrar", que no es lo mismo.
  insert into public.org_members_caughtcode (org_id, user_id, role)
  values ('cc000000-0000-4000-8000-000000000001', v_raso, 'member');

  insert into public.projects_caughtcode (id, org_id, name, source_type)
  values ('cc000000-0000-4000-8000-000000000002',
          'cc000000-0000-4000-8000-000000000001', 'Proyecto victima (test)', 'zip');

  insert into public.analysis_runs_caughtcode (id, project_id, status)
  values ('cc000000-0000-4000-8000-000000000003',
          'cc000000-0000-4000-8000-000000000002', 'succeeded');

  insert into public.findings_caughtcode (
    id, analysis_run_id, project_id, pillar, check_id, severity, confidence,
    status, title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank)
  values ('cc000000-0000-4000-8000-000000000004',
          'cc000000-0000-4000-8000-000000000003',
          'cc000000-0000-4000-8000-000000000002',
          'security', 'test.autorizacion', 'high', 'likely', 'open',
          'hallazgo de prueba', 'explicacion', 'impacto', 'arreglo',
          '[{"tipo":"test"}]'::jsonb, 1);

  insert into public.chat_threads_caughtcode (id, project_id, user_id, title)
  values ('cc000000-0000-4000-8000-000000000005',
          'cc000000-0000-4000-8000-000000000002', v_duenio, 'hilo de prueba');
end;
$$;


-- -- 1. Las llamadas, con sesion de usuario de verdad ------------------------
-- `set role authenticated` importa: es el rol con el que PostgREST atiende a
-- cualquier persona registrada. Las respuestas se guardan en variables de sesion
-- porque `authenticated` no escribe en las tablas temporales de este archivo.
set local role authenticated;

do $$
declare
  v_ajeno  uuid := '00000000-0000-4000-8000-0000000000aa';  -- nadie: no esta en ninguna tabla
  v_duenio uuid;
  v_raso   uuid;
  v        text;
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  v_duenio := current_setting('tc.duenio')::uuid;
  v_raso   := current_setting('tc.raso')::uuid;

  -- === llamante: ajeno total ===
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ajeno, 'role', 'authenticated')::text, true);

  perform set_config('tc.org_project', coalesce(
    public.org_of_project_caughtcode('cc000000-0000-4000-8000-000000000002')::text, 'NULO'), false);
  perform set_config('tc.org_run', coalesce(
    public.org_of_run_caughtcode('cc000000-0000-4000-8000-000000000003')::text, 'NULO'), false);
  perform set_config('tc.org_finding', coalesce(
    public.org_of_finding_caughtcode('cc000000-0000-4000-8000-000000000004')::text, 'NULO'), false);
  perform set_config('tc.org_thread', coalesce(
    public.org_of_thread_caughtcode('cc000000-0000-4000-8000-000000000005')::text, 'NULO'), false);
  perform set_config('tc.es_miembro',
    public.is_org_member_caughtcode('cc000000-0000-4000-8000-000000000001')::text, false);
  perform set_config('tc.es_admin',
    public.is_org_admin_caughtcode('cc000000-0000-4000-8000-000000000001')::text, false);

  begin
    select (public.set_finding_status_caughtcode(
              'cc000000-0000-4000-8000-000000000004', 'dismissed')).status into v;
    perform set_config('tc.estado_ajeno', 'PERMITIDO:' || coalesce(v, 'NULO'), false);
  exception when others then
    perform set_config('tc.estado_ajeno', 'RECHAZADO:' || sqlstate, false);
  end;

  begin
    select public.delete_project_cascade_caughtcode(
             'cc000000-0000-4000-8000-000000000002')::text into v;
    perform set_config('tc.borra_proy_ajeno', 'PERMITIDO', false);
  exception when others then
    perform set_config('tc.borra_proy_ajeno', 'RECHAZADO:' || sqlstate, false);
  end;

  begin
    select public.delete_account_caughtcode(v_duenio)::text into v;
    perform set_config('tc.borra_cuenta_ajena', 'PERMITIDO', false);
  exception when others then
    perform set_config('tc.borra_cuenta_ajena', 'RECHAZADO:' || sqlstate, false);
  end;

  begin
    select public.ensure_org_caughtcode(v_duenio)::text into v;
    perform set_config('tc.espacio_ajeno', 'PERMITIDO:' || coalesce(v, 'NULO'), false);
  exception when others then
    perform set_config('tc.espacio_ajeno', 'RECHAZADO:' || sqlstate, false);
  end;

  -- === llamante: miembro de la casa, sin galones ===
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_raso, 'role', 'authenticated')::text, true);

  begin
    select (public.set_finding_status_caughtcode(
              'cc000000-0000-4000-8000-000000000004', 'fixed')).status into v;
    perform set_config('tc.estado_raso', 'PERMITIDO:' || coalesce(v, 'NULO'), false);
  exception when others then
    perform set_config('tc.estado_raso', 'RECHAZADO:' || sqlstate, false);
  end;

  begin
    select public.delete_project_cascade_caughtcode(
             'cc000000-0000-4000-8000-000000000002')::text into v;
    perform set_config('tc.borra_proy_raso', 'PERMITIDO', false);
  exception when others then
    perform set_config('tc.borra_proy_raso', 'RECHAZADO:' || sqlstate, false);
  end;

  -- === llamante: la duena de la organizacion ===
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_duenio, 'role', 'authenticated')::text, true);

  perform set_config('tc.duenio_org_project', coalesce(
    public.org_of_project_caughtcode('cc000000-0000-4000-8000-000000000002')::text, 'NULO'), false);
  perform set_config('tc.duenio_es_admin',
    public.is_org_admin_caughtcode('cc000000-0000-4000-8000-000000000001')::text, false);

  begin
    select public.delete_project_cascade_caughtcode(
             'cc000000-0000-4000-8000-000000000002')::text into v;
    perform set_config('tc.borra_proy_duenio', 'PERMITIDO', false);
  exception when others then
    perform set_config('tc.borra_proy_duenio', 'RECHAZADO:' || sqlstate, false);
  end;
end;
$$;

reset role;


-- -- 2. Los cuatro traductores no traducen ids ajenos ------------------------
-- El agujero original: `org_of_*` devolvia la organizacion de cualquier uuid sin
-- preguntar quien estaba llamando. Como su respuesta es lo que las policies de
-- RLS comparan, alcanzaba con adivinar (o filtrar) un id para entrar.
do $$
declare
  v_filtrados text[] := '{}';
  v_par       text;
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  foreach v_par in array array[
    'org_of_project_caughtcode=tc.org_project',
    'org_of_run_caughtcode=tc.org_run',
    'org_of_finding_caughtcode=tc.org_finding',
    'org_of_thread_caughtcode=tc.org_thread'
  ] loop
    if current_setting(split_part(v_par, '=', 2), true) <> 'NULO' then
      v_filtrados := v_filtrados || split_part(v_par, '=', 1);
    end if;
  end loop;

  if array_length(v_filtrados, 1) > 0 then
    raise exception
      'FUGA DE TENENCIA: % le devolvio la organizacion a alguien que no es miembro. Con eso las policies de RLS lo dejan entrar a datos de otra empresa. La funcion tiene que exigir is_org_member_caughtcode(org) salvo para service_role. Ver migracion 0014.',
      array_to_string(v_filtrados, ', ');
  end if;

  raise notice 'OK - Los org_of_* no traducen ids de otra organizacion.';
end;
$$;


-- -- 3. Y los dos ayudantes no mienten a favor del que pregunta -------------
do $$
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  if current_setting('tc.es_miembro', true) <> 'false' then
    raise exception 'is_org_member_caughtcode dijo que si a alguien que no esta en org_members_caughtcode. Es la base de todas las policies de RLS: si miente, RLS no filtra nada.';
  end if;

  if current_setting('tc.es_admin', true) <> 'false' then
    raise exception 'is_org_admin_caughtcode dijo que si a alguien ajeno a la organizacion.';
  end if;

  raise notice 'OK - is_org_member/is_org_admin contestan por el llamante, no por el parametro.';
end;
$$;


-- -- 4. Las acciones destructivas piden permiso antes de destruir -----------
-- Estas tres reciben el id por parametro. Si no validan, el cuerpo del POST
-- decide de quien es la cuenta que se borra.
do $$
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  if current_setting('tc.borra_cuenta_ajena', true) not like 'RECHAZADO:%' then
    raise exception
      'CUALQUIERA BORRA LA CUENTA DE CUALQUIERA: delete_account_caughtcode acepto un p_user_id ajeno (resultado: %). Se lleva puestas las organizaciones de esa persona. Tiene que exigir auth.uid() = p_user_id salvo para service_role.',
      current_setting('tc.borra_cuenta_ajena', true);
  end if;

  if current_setting('tc.borra_proy_ajeno', true) not like 'RECHAZADO:%' then
    raise exception
      'CUALQUIERA BORRA PROYECTOS AJENOS: delete_project_cascade_caughtcode acepto un proyecto de otra organizacion (resultado: %). Tiene que exigir is_org_admin_caughtcode(org del proyecto).',
      current_setting('tc.borra_proy_ajeno', true);
  end if;

  if current_setting('tc.estado_ajeno', true) not like 'RECHAZADO:%' then
    raise exception
      'ESCRITURA CRUZADA: set_finding_status_caughtcode dejo a alguien de afuera cambiar un hallazgo (resultado: %). Tiene que exigir is_org_member_caughtcode sobre la organizacion del hallazgo.',
      current_setting('tc.estado_ajeno', true);
  end if;

  if current_setting('tc.espacio_ajeno', true) not like 'RECHAZADO:%' then
    raise exception
      'ensure_org_caughtcode acepto crear u obtener el espacio de otra persona (resultado: %). Devolver el org_id de alguien mas es entregar la llave de esa organizacion.',
      current_setting('tc.espacio_ajeno', true);
  end if;

  raise notice 'OK - delete_account, delete_project_cascade, set_finding_status y ensure_org validan al llamante.';
end;
$$;


-- -- 5. Ser miembro no es ser dueno -----------------------------------------
-- Borrar un proyecto se lleva corridas, hallazgos, videos e hilos de toda la
-- organizacion. No puede alcanzar con estar adentro.
do $$
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  if current_setting('tc.borra_proy_raso', true) not like 'RECHAZADO:%' then
    raise exception
      'ESCALADA DE PRIVILEGIO: un miembro con rol `member` borro un proyecto de su organizacion (resultado: %). delete_project_cascade_caughtcode pide is_org_admin, no is_org_member.',
      current_setting('tc.borra_proy_raso', true);
  end if;

  raise notice 'OK - Un miembro raso no borra proyectos.';
end;
$$;


-- -- 6. Y nada de esto rompio la app ----------------------------------------
-- El riesgo del otro lado: apretar tanto que la aplicacion deje de funcionar y
-- enterarnos en produccion. Estas tres son operaciones legitimas del dia a dia.
do $$
begin
  if current_setting('tc.saltado', true) = '1' then return; end if;

  if current_setting('tc.estado_raso', true) <> 'PERMITIDO:fixed' then
    raise exception
      'SE APRETO DE MAS: un miembro de la organizacion ya no puede marcar un hallazgo como resuelto (resultado: %). Es la accion principal de la pantalla de hallazgos.',
      current_setting('tc.estado_raso', true);
  end if;

  if current_setting('tc.duenio_org_project', true) = 'NULO'
     or current_setting('tc.duenio_es_admin', true) <> 'true' then
    raise exception
      'SE APRETO DE MAS: la duena de la organizacion dejo de ser reconocida (org_of_project=%, is_org_admin=%). Con esto RLS le esconde su propia empresa.',
      current_setting('tc.duenio_org_project', true),
      current_setting('tc.duenio_es_admin', true);
  end if;

  if current_setting('tc.borra_proy_duenio', true) <> 'PERMITIDO' then
    raise exception
      'SE APRETO DE MAS: la duena ya no puede borrar un proyecto propio (resultado: %).',
      current_setting('tc.borra_proy_duenio', true);
  end if;

  raise notice 'OK - Las operaciones legitimas siguen andando.';
  raise notice 'AUTORIZACION RPC OK - Ninguna funcion contesta por un uuid ajeno.';
end;
$$;

rollback;
