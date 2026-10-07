-- Dedicated internal pipeline identities. Passwords are provisioned separately
-- by the operator; never commit deployment credentials or password verifiers.
-- Existing deployment credentials are preserved on compatibility rehearsal.
DO $logins$
DECLARE
  login_name text;
  executor_name text;
  existing_role pg_catalog.pg_roles;
BEGIN
  FOR login_name,executor_name IN
    SELECT * FROM (VALUES
      ('myboon_v4_worker','myboon_knowledge_executor'),
      ('myboon_v4_research','myboon_knowledge_context_executor')
    ) AS identities(login_name,executor_name)
  LOOP
    SELECT * INTO existing_role FROM pg_catalog.pg_roles WHERE rolname=login_name;
    IF FOUND THEN
      IF NOT existing_role.rolcanlogin OR NOT existing_role.rolinherit
        OR existing_role.rolsuper OR existing_role.rolbypassrls
        OR existing_role.rolcreatedb OR existing_role.rolcreaterole OR existing_role.rolreplication
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
          WHERE m.member=existing_role.oid AND (parent.rolname<>executor_name OR m.admin_option)) THEN
        RAISE EXCEPTION 'existing internal login % is not a minimal dedicated identity',login_name USING ERRCODE='42501';
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',login_name);
    END IF;
    EXECUTE format('GRANT %I TO %I',executor_name,login_name);
  END LOOP;
END
$logins$;
