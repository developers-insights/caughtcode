-- ============================================================================
-- caughtcode · La instalación de la GitHub App no se ve desde otra organización
-- ----------------------------------------------------------------------------
-- Este archivo prueba, contra la base de verdad, el agujero que cerró la
-- migración 0015: una segunda persona registrada veía en el asistente de
-- "proyecto nuevo" las instalaciones de la primera, y con eso podía listar y
-- auditar repositorios privados ajenos.
--
-- La técnica es la misma que usa el resto de supabase/tests: se simula la sesión
-- con `set local role authenticated` + `set local request.jwt.claims`, que es
-- exactamente lo que hace PostgREST cuando llega un pedido con un token. No se
-- escribe nada permanente: todo pasa dentro de una transacción que termina en
-- `rollback`.
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_github_installations.sql
--
-- Las tres cosas que tienen que valer, y las tres importan por separado:
--
--   1. Quien instaló la App la ve.
--   2. **Otra persona de la MISMA organización también la ve.** Es el requisito
--      explícito del producto, no un efecto colateral: el equipo que trabaja
--      sobre esos repositorios tiene que poder auditarlos. Un test que solo
--      probara aislamiento pasaría igual con la tabla vacía.
--   3. Alguien de otra organización no ve nada. Ni una fila recortada: nada.
--
-- Y una cuarta que es de motor, no de policy: una instalación ya atada no se
-- puede robar ni escribiendo directo en la tabla.
-- ============================================================================

begin;

-- ── Escenario ──────────────────────────────────────────────────────────────
-- Dos organizaciones. En la primera, dos personas (quien instaló y una compañera
-- de equipo). En la segunda, alguien que no tiene nada que ver.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'instalador@prueba.caughtcode', '', now(), now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'companera@prueba.caughtcode', '', now(), now(), now()),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ajeno@prueba.caughtcode', '', now(), now(), now());

insert into public.organizations_caughtcode (id, name, owner_user_id)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Equipo que instaló',
   '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Equipo ajeno',
   '33333333-3333-4333-8333-333333333333');

-- El trigger de 0001 ya metió a cada dueño como `owner`. Falta la compañera.
insert into public.org_members_caughtcode (org_id, user_id, role)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '22222222-2222-4222-8222-222222222222', 'member');

insert into public.github_installations_caughtcode
  (installation_id, org_id, account_login, account_type, all_repositories, installed_by)
values (999000001, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cuenta-de-prueba', 'User', true,
        '11111111-1111-4111-8111-111111111111');


-- ── 1 · Quien instaló la ve ────────────────────────────────────────────────
do $$
declare v_visibles int;
begin
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

  select count(*) into v_visibles from public.github_installations_caughtcode;

  if v_visibles <> 1 then
    raise exception 'Quien instaló la GitHub App no ve su propia instalación (ve % filas). El filtro quedó demasiado cerrado y el asistente va a decir "no encontramos ninguna instalación".', v_visibles;
  end if;
  raise notice 'OK · Quien instaló ve su instalación.';
end;
$$;
reset role;


-- ── 2 · Su compañera de equipo TAMBIÉN la ve ───────────────────────────────
-- Requisito del producto, escrito como test para que nadie lo "arregle" después
-- convirtiendo esto en "cada usuario ve solo lo suyo".
do $$
declare v_visibles int;
begin
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

  select count(*) into v_visibles from public.github_installations_caughtcode;

  if v_visibles <> 1 then
    raise exception 'Un miembro de la organización no ve la instalación del equipo (ve % filas). El acceso es por organización, no por persona.', v_visibles;
  end if;
  raise notice 'OK · El resto del equipo ve la instalación de la organización.';
end;
$$;
reset role;


-- ── 3 · Alguien de otra organización no ve nada ────────────────────────────
-- Este es el agujero. Antes de 0015 no había ni tabla ni filtro: la instalación
-- salía por la API de GitHub para cualquiera que abriera el asistente.
do $$
declare v_visibles int;
begin
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';

  select count(*) into v_visibles from public.github_installations_caughtcode;

  if v_visibles <> 0 then
    raise exception 'FUGA ENTRE ORGANIZACIONES: alguien de otra organización ve % instalación(es) ajena(s). Es el hallazgo que este producto busca en apps de terceros.', v_visibles;
  end if;
  raise notice 'OK · Desde otra organización no se ve ninguna instalación ajena.';
end;
$$;
reset role;


-- ── 4 · Una instalación atada no se roba ───────────────────────────────────
-- La clave primaria es `installation_id`. Aunque alguien encontrara el modo de
-- llegar al INSERT, la segunda atadura choca contra el motor. Esto no depende de
-- que la verificación de la aplicación esté bien escrita.
do $$
begin
  begin
    insert into public.github_installations_caughtcode
      (installation_id, org_id, account_login)
    values (999000001, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cuenta-de-prueba');
    raise exception 'SE PUDO ROBAR UNA INSTALACIÓN: quedó atada a dos organizaciones a la vez.';
  exception
    when unique_violation then
      raise notice 'OK · Una instalación ya atada no se puede reclamar desde otra organización.';
  end;
end;
$$;


-- ── 5 · `authenticated` no escribe acá ─────────────────────────────────────
-- Atar una instalación exige haberla verificado contra la API de GitHub, y eso
-- solo lo hace el servidor. Si el cliente pudiera insertar, atarse la instalación
-- de otro sería escribir una fila.
do $$
begin
  set local role authenticated;
  set local request.jwt.claims =
    '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';

  begin
    insert into public.github_installations_caughtcode
      (installation_id, org_id, account_login)
    values (999000002, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'inventada');
    raise exception 'Una persona con sesión pudo atarse una instalación a mano.';
  exception
    when insufficient_privilege or sqlstate '42501' then
      raise notice 'OK · Con sesión de usuario no se puede insertar una instalación.';
  end;
end;
$$;
reset role;

-- ── 6 · Y ninguna tabla nuestra queda sin RLS ──────────────────────────────
-- No es sobre la instalación de GitHub: es sobre la próxima tabla. `enable row
-- level security` sin `force` deja leer todo al dueño de la tabla, y una tabla
-- nueva sin ninguna de las dos no avisa — simplemente devuelve todas las filas.
-- Este bloque no depende de que alguien se acuerde de escribir el test.
do $$
declare
  v_sueltas text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_sueltas
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname like '%\_caughtcode'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if array_length(v_sueltas, 1) > 0 then
    raise exception
      'TABLAS SIN RLS ENABLED + FORCE: %. Somos el producto que audita RLS ajena: no podemos filtrar la propia.',
      array_to_string(v_sueltas, ', ');
  end if;

  raise notice 'OK · Todas las tablas _caughtcode tienen RLS habilitada y forzada.';
end;
$$;

do $$ begin raise notice 'RLS GITHUB INSTALLATIONS OK · Aislamiento por organización verificado.'; end; $$;

rollback;
