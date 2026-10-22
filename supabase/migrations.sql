-- ============================================================================
-- RegisterBook Community — Supabase schema (all tables prefixed rb_)
-- Run in the NEW "RegisterBook" Supabase project → SQL Editor → Run.
-- NEVER run this in the Blind-Quiz project.
--
-- Security model (the core story):
--   • Only a register's creator (owner_id) can insert / update / delete lines.
--   • People in rb_shares can SELECT the register + its lines, nothing else.
--   • Group shares are stored as one rb_shares row per member.
--   • Row Level Security is ON for every table, so this is enforced by the
--     database, not just by hiding buttons in the browser.
--
-- This script is safe to run more than once.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables
create table if not exists public.rb_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.rb_registers (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,
  created_at timestamptz not null default now()
);
create index if not exists rb_registers_owner_idx on public.rb_registers(owner_id);

create table if not exists public.rb_entries (
  id text primary key,
  register_id text not null references public.rb_registers(id) on delete cascade,
  entry_date date,
  text text not null,
  note text default '',
  qty int,
  amount numeric,
  done boolean not null default false,
  seq int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists rb_entries_register_idx on public.rb_entries(register_id, seq);

create table if not exists public.rb_groups (
  id text primary key,
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.rb_group_members (
  group_id text not null references public.rb_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists rb_group_members_user_idx on public.rb_group_members(user_id);

create table if not exists public.rb_shares (
  id text primary key default gen_random_uuid()::text,
  register_id text not null references public.rb_registers(id) on delete cascade,
  shared_with_user_id uuid not null references auth.users(id) on delete cascade,
  shared_with_email text,
  permission text not null default 'view' check (permission = 'view'),
  shared_by uuid references auth.users(id) on delete set null,
  group_id text references public.rb_groups(id) on delete set null,
  created_at timestamptz not null default now()
);
-- If an older draft of this file was already run, add the new column safely:
alter table public.rb_shares add column if not exists group_id text references public.rb_groups(id) on delete set null;
create index if not exists rb_shares_register_idx on public.rb_shares(register_id);
create index if not exists rb_shares_user_idx on public.rb_shares(shared_with_user_id);

create table if not exists public.rb_group_messages (
  id text primary key,
  group_id text not null references public.rb_groups(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists rb_group_messages_idx on public.rb_group_messages(group_id, created_at);

create table if not exists public.rb_friend_requests (
  id text primary key,
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now()
);
create index if not exists rb_friend_requests_to_idx on public.rb_friend_requests(to_user, status);
create index if not exists rb_friend_requests_from_idx on public.rb_friend_requests(from_user, status);

create table if not exists public.rb_direct_messages (
  id text primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists rb_dm_pair_idx on public.rb_direct_messages(sender_id, receiver_id, created_at);

-- ---------------------------------------------------------------- RLS on
alter table public.rb_profiles         enable row level security;
alter table public.rb_registers        enable row level security;
alter table public.rb_entries          enable row level security;
alter table public.rb_groups           enable row level security;
alter table public.rb_group_members    enable row level security;
alter table public.rb_shares           enable row level security;
alter table public.rb_group_messages   enable row level security;
alter table public.rb_friend_requests  enable row level security;
alter table public.rb_direct_messages  enable row level security;

-- ---------------------------------------------------------------- helper functions
-- SECURITY DEFINER avoids recursive RLS lookups (a policy on rb_group_members
-- that selects from rb_group_members would otherwise error with
-- "infinite recursion detected in policy").
create or replace function public.rb_owns_register(reg_id text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_registers r
    where r.id = reg_id and r.owner_id = auth.uid()
  );
$$;

create or replace function public.rb_can_read_register(reg_id text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_registers r
    where r.id = reg_id and r.owner_id = auth.uid()
  ) or exists (
    select 1 from public.rb_shares s
    where s.register_id = reg_id and s.shared_with_user_id = auth.uid()
  );
$$;

create or replace function public.rb_is_group_member(gid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_group_members m
    where m.group_id = gid and m.user_id = auth.uid()
  );
$$;

create or replace function public.rb_is_group_creator(gid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_groups g
    where g.id = gid and g.created_by = auth.uid()
  );
$$;

-- ---------------------------------------------------------------- policies: profiles
drop policy if exists rb_profiles_read on public.rb_profiles;
create policy rb_profiles_read on public.rb_profiles
  for select to authenticated using (true);

drop policy if exists rb_profiles_insert on public.rb_profiles;
create policy rb_profiles_insert on public.rb_profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists rb_profiles_update on public.rb_profiles;
create policy rb_profiles_update on public.rb_profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------- policies: registers
drop policy if exists rb_registers_read on public.rb_registers;
create policy rb_registers_read on public.rb_registers
  for select to authenticated using (public.rb_can_read_register(id));

drop policy if exists rb_registers_insert on public.rb_registers;
create policy rb_registers_insert on public.rb_registers
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists rb_registers_update on public.rb_registers;
create policy rb_registers_update on public.rb_registers
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists rb_registers_delete on public.rb_registers;
create policy rb_registers_delete on public.rb_registers
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------- policies: entries
drop policy if exists rb_entries_read on public.rb_entries;
create policy rb_entries_read on public.rb_entries
  for select to authenticated using (public.rb_can_read_register(register_id));

drop policy if exists rb_entries_insert on public.rb_entries;
create policy rb_entries_insert on public.rb_entries
  for insert to authenticated with check (public.rb_owns_register(register_id));

drop policy if exists rb_entries_update on public.rb_entries;
create policy rb_entries_update on public.rb_entries
  for update to authenticated
  using (public.rb_owns_register(register_id))
  with check (public.rb_owns_register(register_id));

drop policy if exists rb_entries_delete on public.rb_entries;
create policy rb_entries_delete on public.rb_entries
  for delete to authenticated using (public.rb_owns_register(register_id));

-- ---------------------------------------------------------------- policies: shares
drop policy if exists rb_shares_read on public.rb_shares;
create policy rb_shares_read on public.rb_shares
  for select to authenticated using (
    shared_with_user_id = auth.uid()
    or shared_by = auth.uid()
    or public.rb_owns_register(register_id)
  );

drop policy if exists rb_shares_insert on public.rb_shares;
create policy rb_shares_insert on public.rb_shares
  for insert to authenticated with check (
    public.rb_owns_register(register_id) and shared_by = auth.uid()
  );

drop policy if exists rb_shares_delete on public.rb_shares;
create policy rb_shares_delete on public.rb_shares
  for delete to authenticated using (public.rb_owns_register(register_id));

-- ---------------------------------------------------------------- policies: groups
drop policy if exists rb_groups_read on public.rb_groups;
create policy rb_groups_read on public.rb_groups
  for select to authenticated using (
    created_by = auth.uid() or public.rb_is_group_member(id)
  );

drop policy if exists rb_groups_insert on public.rb_groups;
create policy rb_groups_insert on public.rb_groups
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists rb_groups_update on public.rb_groups;
create policy rb_groups_update on public.rb_groups
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists rb_groups_delete on public.rb_groups;
create policy rb_groups_delete on public.rb_groups
  for delete to authenticated using (created_by = auth.uid());

drop policy if exists rb_group_members_read on public.rb_group_members;
create policy rb_group_members_read on public.rb_group_members
  for select to authenticated using (
    user_id = auth.uid() or public.rb_is_group_member(group_id)
  );

drop policy if exists rb_group_members_insert on public.rb_group_members;
create policy rb_group_members_insert on public.rb_group_members
  for insert to authenticated with check (public.rb_is_group_creator(group_id));

drop policy if exists rb_group_members_delete on public.rb_group_members;
create policy rb_group_members_delete on public.rb_group_members
  for delete to authenticated using (
    user_id = auth.uid() or public.rb_is_group_creator(group_id)
  );

drop policy if exists rb_group_messages_read on public.rb_group_messages;
create policy rb_group_messages_read on public.rb_group_messages
  for select to authenticated using (public.rb_is_group_member(group_id));

drop policy if exists rb_group_messages_insert on public.rb_group_messages;
create policy rb_group_messages_insert on public.rb_group_messages
  for insert to authenticated with check (
    sender_id = auth.uid() and public.rb_is_group_member(group_id)
  );

drop policy if exists rb_group_messages_delete on public.rb_group_messages;
create policy rb_group_messages_delete on public.rb_group_messages
  for delete to authenticated using (sender_id = auth.uid());

-- ---------------------------------------------------------------- policies: friend requests
drop policy if exists rb_friend_requests_read on public.rb_friend_requests;
create policy rb_friend_requests_read on public.rb_friend_requests
  for select to authenticated using (
    from_user = auth.uid() or to_user = auth.uid()
  );

drop policy if exists rb_friend_requests_insert on public.rb_friend_requests;
create policy rb_friend_requests_insert on public.rb_friend_requests
  for insert to authenticated with check (
    from_user = auth.uid() and from_user <> to_user
  );

-- only the recipient can accept / decline
drop policy if exists rb_friend_requests_update on public.rb_friend_requests;
create policy rb_friend_requests_update on public.rb_friend_requests
  for update to authenticated using (to_user = auth.uid()) with check (to_user = auth.uid());

drop policy if exists rb_friend_requests_delete on public.rb_friend_requests;
create policy rb_friend_requests_delete on public.rb_friend_requests
  for delete to authenticated using (from_user = auth.uid() or to_user = auth.uid());

-- ---------------------------------------------------------------- policies: direct messages
drop policy if exists rb_direct_messages_read on public.rb_direct_messages;
create policy rb_direct_messages_read on public.rb_direct_messages
  for select to authenticated using (
    sender_id = auth.uid() or receiver_id = auth.uid()
  );

drop policy if exists rb_direct_messages_insert on public.rb_direct_messages;
create policy rb_direct_messages_insert on public.rb_direct_messages
  for insert to authenticated with check (sender_id = auth.uid());

drop policy if exists rb_direct_messages_delete on public.rb_direct_messages;
create policy rb_direct_messages_delete on public.rb_direct_messages
  for delete to authenticated using (sender_id = auth.uid());

-- ---------------------------------------------------------------- grants
-- Signed-out visitors get no data at all; signed-in users get the rb_ tables
-- and RLS decides every row.
revoke all on public.rb_profiles        from anon;
revoke all on public.rb_registers       from anon;
revoke all on public.rb_entries         from anon;
revoke all on public.rb_groups          from anon;
revoke all on public.rb_group_members   from anon;
revoke all on public.rb_shares          from anon;
revoke all on public.rb_group_messages  from anon;
revoke all on public.rb_friend_requests from anon;
revoke all on public.rb_direct_messages from anon;

grant select, insert, update, delete on public.rb_profiles        to authenticated;
grant select, insert, update, delete on public.rb_registers       to authenticated;
grant select, insert, update, delete on public.rb_entries         to authenticated;
grant select, insert, update, delete on public.rb_groups          to authenticated;
grant select, insert, update, delete on public.rb_group_members   to authenticated;
grant select, insert, update, delete on public.rb_shares          to authenticated;
grant select, insert, update, delete on public.rb_group_messages  to authenticated;
grant select, insert, update, delete on public.rb_friend_requests to authenticated;
grant select, insert, update, delete on public.rb_direct_messages to authenticated;

-- ---------------------------------------------------------------- profile auto-create
create or replace function public.rb_handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.rb_profiles (id, name, email, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      split_part(coalesce(new.email, 'staff'), '@', 1)
    ),
    new.email,
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do update
    set email = excluded.email,
        avatar_url = coalesce(excluded.avatar_url, public.rb_profiles.avatar_url),
        name = coalesce(public.rb_profiles.name, excluded.name);
  return new;
end;
$$;

drop trigger if exists rb_auth_user_created on auth.users;
create trigger rb_auth_user_created
  after insert on auth.users
  for each row execute function public.rb_handle_new_user();

-- Backfill profiles for anyone who signed in before this script ran
insert into public.rb_profiles (id, name, email, avatar_url)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data->>'full_name', ''),
    nullif(u.raw_user_meta_data->>'name', ''),
    split_part(coalesce(u.email, 'staff'), '@', 1)
  ),
  u.email,
  coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------- check
-- Expect 9 rows and row_security = true for every one of them.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename like 'rb\_%'
order by tablename;
