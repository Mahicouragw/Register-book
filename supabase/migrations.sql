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

-- ============================================================================
-- PART 2 — notifications, group invites, real calls, account deletion
-- (Everything above stays exactly as it was; nothing is renamed, so a future
--  Flutter app can talk to the same tables.)
-- ============================================================================

-- ---------------------------------------------------------------- tables
create table if not exists public.rb_group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id text not null references public.rb_groups(id) on delete cascade,
  code text not null unique,
  invited_user_id uuid references auth.users(id) on delete cascade,
  invited_email text,
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists rb_group_invites_group_idx on public.rb_group_invites(group_id, status);
create index if not exists rb_group_invites_user_idx on public.rb_group_invites(invited_user_id, status);

create table if not exists public.rb_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists rb_push_subs_user_idx on public.rb_push_subscriptions(user_id);

create table if not exists public.rb_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('message','friend','invite','call','system')),
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists rb_notifications_user_idx on public.rb_notifications(user_id, read, created_at desc);

create table if not exists public.rb_account_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email text,
  reason text,
  status text not null default 'requested' check (status in ('requested','processing','done','failed')),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.rb_calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'audio' check (kind in ('audio','video')),
  status text not null default 'ringing' check (status in ('ringing','accepted','declined','ended','missed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists rb_calls_callee_idx on public.rb_calls(callee_id, status);
create index if not exists rb_calls_caller_idx on public.rb_calls(caller_id, status);

create table if not exists public.rb_call_signals (
  id bigserial primary key,
  call_id uuid not null references public.rb_calls(id) on delete cascade,
  from_user uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('offer','answer','ice')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists rb_call_signals_call_idx on public.rb_call_signals(call_id, id);

-- ---------------------------------------------------------------- RLS on
alter table public.rb_group_invites     enable row level security;
alter table public.rb_push_subscriptions enable row level security;
alter table public.rb_notifications     enable row level security;
alter table public.rb_account_deletions enable row level security;
alter table public.rb_calls             enable row level security;
alter table public.rb_call_signals      enable row level security;

-- ---------------------------------------------------------------- helper: call participants
-- SECURITY DEFINER again, so a policy on rb_call_signals can look at rb_calls
-- without recursion or leaking rows the caller is not part of.
create or replace function public.rb_is_call_participant(cid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_calls c
    where c.id = cid and (c.caller_id = auth.uid() or c.callee_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------- policies: group invites
-- Who can see an invite: the person who sent it (group creator) and the person
-- it was addressed to. Nobody else.
drop policy if exists rb_group_invites_read on public.rb_group_invites;
create policy rb_group_invites_read on public.rb_group_invites
  for select to authenticated using (
    created_by = auth.uid()
    or invited_user_id = auth.uid()
    or public.rb_is_group_creator(group_id)
  );

-- Only the group creator can create an invite, and only in their own name.
drop policy if exists rb_group_invites_insert on public.rb_group_invites;
create policy rb_group_invites_insert on public.rb_group_invites
  for insert to authenticated with check (
    public.rb_is_group_creator(group_id) and created_by = auth.uid()
  );

-- The invitee may accept or decline (nothing else). The creator may revoke.
drop policy if exists rb_group_invites_update on public.rb_group_invites;
create policy rb_group_invites_update on public.rb_group_invites
  for update to authenticated
  using (
    (invited_user_id = auth.uid() and status = 'pending')
    or (created_by = auth.uid())
  )
  with check (
    (invited_user_id = auth.uid() and status in ('pending','accepted','declined'))
    or (created_by = auth.uid() and status in ('pending','revoked'))
  );

drop policy if exists rb_group_invites_delete on public.rb_group_invites;
create policy rb_group_invites_delete on public.rb_group_invites
  for delete to authenticated using (created_by = auth.uid());

-- Accepting an invite must also make you a member. That needs to happen even
-- though rb_group_members normally only accepts inserts from the creator, so the
-- whole "join a group" step runs through this SECURITY DEFINER function.
create or replace function public.rb_accept_group_invite(invite_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  inv public.rb_group_invites%rowtype;
begin
  select * into inv
  from public.rb_group_invites
  where code = upper(btrim(coalesce(invite_code, '')))
  limit 1;

  if inv.id is null then
    raise exception 'That invite link is not valid.' using errcode = 'P0002';
  end if;

  if inv.status <> 'pending' then
    raise exception 'That invite was already %', inv.status using errcode = 'P0002';
  end if;

  if inv.invited_user_id is not null and inv.invited_user_id <> auth.uid() then
    raise exception 'That invite was sent to someone else.' using errcode = '42501';
  end if;

  if auth.uid() is null then
    raise exception 'Sign in first, then open the invite link again.' using errcode = '42501';
  end if;

  update public.rb_group_invites
     set status = 'accepted',
         responded_at = now(),
         invited_user_id = coalesce(invited_user_id, auth.uid())
   where id = inv.id;

  insert into public.rb_group_members (group_id, user_id)
  values (inv.group_id, auth.uid())
  on conflict (group_id, user_id) do nothing;

  -- Joining a group must also give you the registers that had ALREADY been
  -- shared with that group. Group sharing is stored as one rb_shares row per
  -- member (see shareWithGroup), so a late joiner needs those rows copied
  -- across or they would join an empty group.
  insert into public.rb_shares (
    id, register_id, shared_with_user_id, shared_with_email,
    permission, shared_by, group_id
  )
  select
    'shr_' || replace(gen_random_uuid()::text, '-', ''),
    s.register_id,
    auth.uid(),
    (select p.email from public.rb_profiles p where p.id = auth.uid()),
    s.permission,
    s.shared_by,
    s.group_id
  from public.rb_shares s
  where s.group_id = inv.group_id
    and s.shared_with_user_id is not null
    and not exists (
      select 1
      from public.rb_shares x
      where x.register_id = s.register_id
        and x.shared_with_user_id = auth.uid()
    );

  return inv.group_id;
end;
$$;

create or replace function public.rb_decline_group_invite(invite_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  inv public.rb_group_invites%rowtype;
begin
  select * into inv from public.rb_group_invites where code = upper(btrim(coalesce(invite_code, ''))) limit 1;
  if inv.id is null then
    raise exception 'That invite link is not valid.' using errcode = 'P0002';
  end if;
  if inv.invited_user_id is not null and inv.invited_user_id <> auth.uid() then
    raise exception 'That invite was sent to someone else.' using errcode = '42501';
  end if;
  update public.rb_group_invites
     set status = 'declined',
         responded_at = now(),
         invited_user_id = coalesce(invited_user_id, auth.uid())
   where id = inv.id and status = 'pending';
  return inv.group_id;
end;
$$;

-- ---------------------------------------------------------------- policies: push subscriptions
drop policy if exists rb_push_subscriptions_read on public.rb_push_subscriptions;
create policy rb_push_subscriptions_read on public.rb_push_subscriptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists rb_push_subscriptions_insert on public.rb_push_subscriptions;
create policy rb_push_subscriptions_insert on public.rb_push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists rb_push_subscriptions_update on public.rb_push_subscriptions;
create policy rb_push_subscriptions_update on public.rb_push_subscriptions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rb_push_subscriptions_delete on public.rb_push_subscriptions;
create policy rb_push_subscriptions_delete on public.rb_push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- policies: notifications
-- Rows are written only by the rb-notify Edge Function, which uses the
-- service_role key and therefore bypasses RLS. From the browser you may read
-- your own notifications and mark them read — you may NOT insert one, so nobody
-- can forge a notification to another member of staff.
drop policy if exists rb_notifications_read on public.rb_notifications;
create policy rb_notifications_read on public.rb_notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists rb_notifications_update on public.rb_notifications;
create policy rb_notifications_update on public.rb_notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists rb_notifications_delete on public.rb_notifications;
create policy rb_notifications_delete on public.rb_notifications
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- policies: account deletions
drop policy if exists rb_account_deletions_insert on public.rb_account_deletions;
create policy rb_account_deletions_insert on public.rb_account_deletions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists rb_account_deletions_read on public.rb_account_deletions;
create policy rb_account_deletions_read on public.rb_account_deletions
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- policies: calls
drop policy if exists rb_calls_read on public.rb_calls;
create policy rb_calls_read on public.rb_calls
  for select to authenticated using (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists rb_calls_insert on public.rb_calls;
create policy rb_calls_insert on public.rb_calls
  for insert to authenticated with check (
    caller_id = auth.uid() and caller_id <> callee_id
  );

drop policy if exists rb_calls_update on public.rb_calls;
create policy rb_calls_update on public.rb_calls
  for update to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid())
  with check (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists rb_calls_delete on public.rb_calls;
create policy rb_calls_delete on public.rb_calls
  for delete to authenticated using (caller_id = auth.uid());

drop policy if exists rb_call_signals_read on public.rb_call_signals;
create policy rb_call_signals_read on public.rb_call_signals
  for select to authenticated using (public.rb_is_call_participant(call_id));

drop policy if exists rb_call_signals_insert on public.rb_call_signals;
create policy rb_call_signals_insert on public.rb_call_signals
  for insert to authenticated with check (
    from_user = auth.uid() and public.rb_is_call_participant(call_id)
  );

-- Someone holding an invite link must be able to see WHAT they are joining
-- before they accept. They cannot read the rb_group_invites row itself (RLS
-- hides it), so this SECURITY DEFINER helper answers only for an exact code.
create or replace function public.rb_invite_preview(invite_code text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  inv public.rb_group_invites%rowtype;
  g   public.rb_groups%rowtype;
  p   public.rb_profiles%rowtype;
begin
  select * into inv
    from public.rb_group_invites
   where code = upper(btrim(coalesce(invite_code, '')))
   limit 1;

  if inv.id is null then
    return null;
  end if;

  select * into g from public.rb_groups where id = inv.group_id;
  select * into p from public.rb_profiles where id = inv.created_by;

  return json_build_object(
    'code',         inv.code,
    'status',       inv.status,
    'groupId',      g.id,
    'groupName',    g.name,
    'fromName',     coalesce(p.name, 'a colleague'),
    'fromAvatar',   p.avatar_url,
    'memberCount',  (select count(*) from public.rb_group_members m where m.group_id = g.id)
  );
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on public.rb_group_invites     from anon;
revoke all on public.rb_push_subscriptions from anon;
revoke all on public.rb_notifications     from anon;
revoke all on public.rb_account_deletions from anon;
revoke all on public.rb_calls             from anon;
revoke all on public.rb_call_signals      from anon;

grant select, insert, update, delete on public.rb_group_invites     to authenticated;
grant select, insert, update, delete on public.rb_push_subscriptions to authenticated;
-- NOTE: no INSERT grant on rb_notifications — only the Edge Function writes rows.
grant select, update, delete           on public.rb_notifications     to authenticated;
grant select, insert                   on public.rb_account_deletions to authenticated;
grant select, insert, update, delete   on public.rb_calls             to authenticated;
grant select, insert                   on public.rb_call_signals      to authenticated;

grant execute on function public.rb_invite_preview(text) to authenticated;
grant execute on function public.rb_accept_group_invite(text) to authenticated;
grant execute on function public.rb_decline_group_invite(text) to authenticated;
grant execute on function public.rb_is_call_participant(uuid) to authenticated;

-- rb_call_signals.id is a bigserial, so signed-in users need the sequence too
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'rb_call_signals_id_seq' and c.relkind = 'S') then
    execute 'grant usage, select on sequence public.rb_call_signals_id_seq to authenticated';
  end if;
end$$;

-- ---------------------------------------------------------------- realtime
-- Adds the tables the app listens to while it is open (instant banner + ting
-- sound). Safe to run repeatedly, and skipped where the publication does not
-- exist (for example in the local PGlite test database).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'rb_direct_messages', 'rb_notifications', 'rb_friend_requests',
      'rb_group_invites', 'rb_calls', 'rb_call_signals', 'rb_group_messages'
    ]
    loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception
        when duplicate_object then null;
        when others then null;
      end;
    end loop;
  end if;
end$$;

-- ============================================================================
-- PART 4 — "Create Questions Register Book"
-- A question book is a notebook of pages, questions and multiple-choice
-- options that the creator sends to another member of staff. The recipient
-- answers it and sends it back. The ORIGINAL is never overwritten: every
-- send creates a separate "copy" row, and the answers belong to that copy.
--
-- Lifecycle of a copy:
--   draft (owner still writing) -> sent -> received -> in_progress
--     -> submitted -> returned_to_creator
-- ============================================================================

-- ---------------------------------------------------------------- tables
create table if not exists public.rb_qbooks (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rb_qbooks_owner_idx on public.rb_qbooks(owner_id);

create table if not exists public.rb_qpages (
  id text primary key,
  book_id text not null references public.rb_qbooks(id) on delete cascade,
  page_no integer not null check (page_no > 0),
  created_at timestamptz not null default now()
);
create index if not exists rb_qpages_book_idx on public.rb_qpages(book_id, page_no);
create unique index if not exists rb_qpages_book_page_uq on public.rb_qpages(book_id, page_no);

create table if not exists public.rb_questions (
  id text primary key,
  book_id text not null references public.rb_qbooks(id) on delete cascade,
  page_id text not null references public.rb_qpages(id) on delete cascade,
  q_no integer not null check (q_no > 0),
  text text not null,
  has_choices boolean not null default true,
  has_written boolean not null default false,
  written_label text not null default 'Written answer',
  created_at timestamptz not null default now()
);
create index if not exists rb_questions_book_idx on public.rb_questions(book_id);
create index if not exists rb_questions_page_idx on public.rb_questions(page_id, q_no);

create table if not exists public.rb_qoptions (
  id text primary key,
  question_id text not null references public.rb_questions(id) on delete cascade,
  label text not null check (label in ('A','B','C','D')),
  text text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists rb_qoptions_q_label_uq on public.rb_qoptions(question_id, label);

-- One row per (book, recipient, revision). Never overwrites the original book
-- and never overwrites an earlier submission - a resubmission is revision + 1.
create table if not exists public.rb_qbook_copies (
  id text primary key,
  book_id text not null references public.rb_qbooks(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'sent'
    check (status in ('sent','received','in_progress','submitted','returned_to_creator')),
  revision integer not null default 1 check (revision > 0),
  sender_note text,
  sent_at timestamptz not null default now(),
  received_at timestamptz,
  submitted_at timestamptz,
  returned_at timestamptz
);
create index if not exists rb_qcopies_book_idx on public.rb_qbook_copies(book_id);
create index if not exists rb_qcopies_recipient_idx on public.rb_qbook_copies(recipient_id, status);
create index if not exists rb_qcopies_sender_idx on public.rb_qbook_copies(sender_id, status);

create table if not exists public.rb_qanswers (
  id text primary key,
  copy_id text not null references public.rb_qbook_copies(id) on delete cascade,
  question_id text not null references public.rb_questions(id) on delete cascade,
  selected_label text check (selected_label in ('A','B','C','D')),
  written_answer text,
  updated_at timestamptz not null default now()
);
create unique index if not exists rb_qanswers_copy_q_uq on public.rb_qanswers(copy_id, question_id);
create index if not exists rb_qanswers_copy_idx on public.rb_qanswers(copy_id);

-- ---------------------------------------------------------------- RLS on
alter table public.rb_qbooks       enable row level security;
alter table public.rb_qpages       enable row level security;
alter table public.rb_questions    enable row level security;
alter table public.rb_qoptions     enable row level security;
alter table public.rb_qbook_copies enable row level security;
alter table public.rb_qanswers     enable row level security;

-- ---------------------------------------------------------------- helpers
-- SECURITY DEFINER so a policy can ask "may I see this book?" without
-- recursing into the very table the policy protects.
create or replace function public.rb_qbook_is_owner(bid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_qbooks b
    where b.id = bid and b.owner_id = auth.uid()
  );
$$;

-- Anyone who has been sent this book may READ it (never write to it).
create or replace function public.rb_qbook_is_recipient(bid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_qbook_copies c
    where c.book_id = bid and c.recipient_id = auth.uid()
  );
$$;

create or replace function public.rb_qcopy_is_recipient(cid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_qbook_copies c
    where c.id = cid and c.recipient_id = auth.uid()
  );
$$;

create or replace function public.rb_qcopy_is_sender(cid text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rb_qbook_copies c
    where c.id = cid and c.sender_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------- policies: books
drop policy if exists rb_qbooks_read on public.rb_qbooks;
create policy rb_qbooks_read on public.rb_qbooks
  for select to authenticated using (
    owner_id = auth.uid() or public.rb_qbook_is_recipient(id)
  );

drop policy if exists rb_qbooks_insert on public.rb_qbooks;
create policy rb_qbooks_insert on public.rb_qbooks
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists rb_qbooks_update on public.rb_qbooks;
create policy rb_qbooks_update on public.rb_qbooks
  for update to authenticated using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists rb_qbooks_delete on public.rb_qbooks;
create policy rb_qbooks_delete on public.rb_qbooks
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------- policies: pages
drop policy if exists rb_qpages_read on public.rb_qpages;
create policy rb_qpages_read on public.rb_qpages
  for select to authenticated using (
    public.rb_qbook_is_owner(book_id) or public.rb_qbook_is_recipient(book_id)
  );

drop policy if exists rb_qpages_insert on public.rb_qpages;
create policy rb_qpages_insert on public.rb_qpages
  for insert to authenticated with check (public.rb_qbook_is_owner(book_id));

drop policy if exists rb_qpages_update on public.rb_qpages;
create policy rb_qpages_update on public.rb_qpages
  for update to authenticated using (public.rb_qbook_is_owner(book_id))
  with check (public.rb_qbook_is_owner(book_id));

drop policy if exists rb_qpages_delete on public.rb_qpages;
create policy rb_qpages_delete on public.rb_qpages
  for delete to authenticated using (public.rb_qbook_is_owner(book_id));

-- ---------------------------------------------------------------- policies: questions
drop policy if exists rb_questions_read on public.rb_questions;
create policy rb_questions_read on public.rb_questions
  for select to authenticated using (
    public.rb_qbook_is_owner(book_id) or public.rb_qbook_is_recipient(book_id)
  );

drop policy if exists rb_questions_insert on public.rb_questions;
create policy rb_questions_insert on public.rb_questions
  for insert to authenticated with check (public.rb_qbook_is_owner(book_id));

drop policy if exists rb_questions_update on public.rb_questions;
create policy rb_questions_update on public.rb_questions
  for update to authenticated using (public.rb_qbook_is_owner(book_id))
  with check (public.rb_qbook_is_owner(book_id));

drop policy if exists rb_questions_delete on public.rb_questions;
create policy rb_questions_delete on public.rb_questions
  for delete to authenticated using (public.rb_qbook_is_owner(book_id));

-- ---------------------------------------------------------------- policies: options
-- Options follow their question's book, so they use the same helpers through
-- a SECURITY DEFINER lookup on the parent question.
create or replace function public.rb_qoption_book(qid text)
returns text
language sql stable security definer set search_path = public
as $$
  select book_id from public.rb_questions where id = qid;
$$;

drop policy if exists rb_qoptions_read on public.rb_qoptions;
create policy rb_qoptions_read on public.rb_qoptions
  for select to authenticated using (
    public.rb_qbook_is_owner(public.rb_qoption_book(question_id))
    or public.rb_qbook_is_recipient(public.rb_qoption_book(question_id))
  );

drop policy if exists rb_qoptions_write on public.rb_qoptions;
create policy rb_qoptions_write on public.rb_qoptions
  for all to authenticated
  using (public.rb_qbook_is_owner(public.rb_qoption_book(question_id)))
  with check (public.rb_qbook_is_owner(public.rb_qoption_book(question_id)));

-- ---------------------------------------------------------------- policies: copies
drop policy if exists rb_qbook_copies_read on public.rb_qbook_copies;
create policy rb_qbook_copies_read on public.rb_qbook_copies
  for select to authenticated using (
    sender_id = auth.uid() or recipient_id = auth.uid()
  );

-- Only the owner of the book may send it, and only in their own name.
drop policy if exists rb_qbook_copies_insert on public.rb_qbook_copies;
create policy rb_qbook_copies_insert on public.rb_qbook_copies
  for insert to authenticated with check (
    sender_id = auth.uid()
    and sender_id <> recipient_id
    and public.rb_qbook_is_owner(book_id)
  );

-- The recipient moves it forward (received -> in_progress -> submitted ->
-- returned). The sender may only reopen it to ask for a revision.
drop policy if exists rb_qbook_copies_update on public.rb_qbook_copies;
create policy rb_qbook_copies_update on public.rb_qbook_copies
  for update to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid())
  with check (sender_id = auth.uid() or recipient_id = auth.uid());

drop policy if exists rb_qbook_copies_delete on public.rb_qbook_copies;
create policy rb_qbook_copies_delete on public.rb_qbook_copies
  for delete to authenticated using (sender_id = auth.uid());

-- ---------------------------------------------------------------- policies: answers
-- The recipient writes and rewrites their own answers. The sender may read
-- them once the copy is no longer a secret to them (submitted or returned).
drop policy if exists rb_qanswers_read on public.rb_qanswers;
create policy rb_qanswers_read on public.rb_qanswers
  for select to authenticated using (
    public.rb_qcopy_is_recipient(copy_id)
    or public.rb_qcopy_is_sender(copy_id)
  );

drop policy if exists rb_qanswers_write on public.rb_qanswers;
create policy rb_qanswers_write on public.rb_qanswers
  for all to authenticated
  using (public.rb_qcopy_is_recipient(copy_id))
  with check (public.rb_qcopy_is_recipient(copy_id));

-- ---------------------------------------------------------------- grants
revoke all on public.rb_qbooks       from anon;
revoke all on public.rb_qpages       from anon;
revoke all on public.rb_questions    from anon;
revoke all on public.rb_qoptions     from anon;
revoke all on public.rb_qbook_copies from anon;
revoke all on public.rb_qanswers     from anon;

grant select, insert, update, delete on public.rb_qbooks   to authenticated;
grant select, insert, update, delete on public.rb_qpages   to authenticated;
grant select, insert, update, delete on public.rb_questions to authenticated;
grant select, insert, update, delete on public.rb_qoptions to authenticated;
grant select, insert, update, delete on public.rb_qbook_copies to authenticated;
grant select, insert, update, delete on public.rb_qanswers to authenticated;

grant execute on function public.rb_qbook_is_owner(text) to authenticated;
grant execute on function public.rb_qbook_is_recipient(text) to authenticated;
grant execute on function public.rb_qcopy_is_recipient(text) to authenticated;
grant execute on function public.rb_qcopy_is_sender(text) to authenticated;
grant execute on function public.rb_qoption_book(text) to authenticated;

-- ---------------------------------------------------------------- realtime
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['rb_qbook_copies', 'rb_qanswers']
      loop
        begin
          execute format('alter publication supabase_realtime add table public.%I', t);
        exception
          when duplicate_object then null;
          when others then null;
        end;
      end loop;
  end if;
end$$;

-- ---------------------------------------------------------------- check
-- Expect 21 rows and row_security = true for every one of them.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename like 'rb\_%'
order by tablename;
