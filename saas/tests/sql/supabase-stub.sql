-- LOCAL ONLY (PGlite): minimal stand-in for the Supabase roles and auth schema used by the
-- migration. Never apply this to a Supabase project; the real auth schema already exists there.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- LOCAL ONLY (PGlite): minimal stand-in for Supabase Vault (vault.create_secret, vault.secrets,
-- vault.decrypted_secrets). The real extension encrypts at rest; this stub stores test values in clear
-- inside the disposable embedded database only.
create schema vault;
revoke all on schema vault from public;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now()
);
create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, created_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
revoke all on all tables in schema vault from public;
revoke all on function vault.create_secret(text, text, text) from public;
