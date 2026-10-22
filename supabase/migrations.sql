-- RegisterBook Community — Supabase schema with prefix rb_ and RLS
-- Run in Supabase Dashboard → SQL Editor (new RegisterBook project, NOT Blind-Quiz)
-- This enforces view-only sharing at database level.

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- 1. Profiles (id = auth.users.id)
create table if not exists public.rb_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text,
  avatar_url text,
  created_at timestamptz default now()
);

-- 2. Registers
create table if not exists public.rb_registers (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null,
  created_at timestamptz default now()
);

-- 3. Entries (lines inside a register)
create table if not exists public.rb_entries (
  id text primary key,
  register_id text not null references public.rb_registers(id) on delete cascade,
  entry_date date,
  text text not null,
  note text,
  qty int,
  amount numeric,
  done boolean default false,
  seq int not null,
  created_at timestamptz default now()
);
create index if not exists idx_rb_entries_register on public.rb_entries(register_id, seq);

-- 4. Shares (view only)
create table if not exists public.rb_shares (
  id text primary key default gen_random_uuid()::text,
  register_id text not null references public.rb_registers(id) on delete cascade,
  shared_with_user_id uuid references auth.users(id) on delete cascade,
  shared_with_email text,
  permission text not null default 'view' check (permission = 'view'),
  shared_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists idx_rb_shares_user on public.rb_shares(shared_with_user_id);
create index if not exists idx_rb_shares_register on public.rb_shares(register_id);

-- 5. Groups
create table if not exists public.rb_groups (
  id text primary key,
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create table if not exists public.rb_group_members (
  group_id text not null references public.rb_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (group_id, user_id)
);
create table if not exists public.rb_group_messages (
  id text primary key,
  group_id text not null references public.rb_groups(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  text text not null,
  created_at timestamptz default now()
);
create index if not exists idx_rb_group_messages_group on public.rb_group_messages(group_id, created_at);

-- 6. Friend requests
create table if not exists public.rb_friend_requests (
  id text primary key,
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz default now()
);
create index if not exists idx_rb_friend_to on public.rb_friend_requests(to_user, status);

-- 7. Direct messages
create table if not exists public.rb_direct_messages (
  id text primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  created_at timestamptz default now()
);
create index if not exists idx_rb_dm_pair on public.rb_direct_messages(sender_id, receiver_id, created_at);

-- Enable RLS
alter table public.rb_profiles enable row level security;
alter table public.rb_registers enable row level security;
alter table public.rb_entries enable row level security;
alter table public.rb_shares enable row level security;
alter table public.rb_groups enable row level security;
alter table public.rb_group_members enable row level security;
alter table public.rb_group_messages enable row level security;
alter table public.rb_friend_requests enable row level security;
alter table public.rb_direct_messages enable row level security;

-- Policies
-- Profiles: anyone can read, users can upsert own
drop policy if exists "rb_profiles_select_all" on public.rb_profiles;
create policy "rb_profiles_select_all" on public.rb_profiles for select using (true);
drop policy if exists "rb_profiles_insert_own" on public.rb_profiles;
create policy "rb_profiles_insert_own" on public.rb_profiles for insert with check (auth.uid() = id);
drop policy if exists "rb_profiles_update_own" on public.rb_profiles;
create policy "rb_profiles_update_own" on public.rb_profiles for update using (auth.uid() = id);

-- Registers: owners can crud; shared users can SELECT only
drop policy if exists "rb_registers_select_own_or_shared" on public.rb_registers;
create policy "rb_registers_select_own_or_shared" on public.rb_registers for select using (
  owner_id = auth.uid()
  or exists (select 1 from public.rb_shares s where s.register_id = rb_registers.id and s.shared_with_user_id = auth.uid())
  or exists (select 1 from public.rb_group_members gm join public.rb_shares s2 on s2.shared_with_user_id = gm.user_id where s2.register_id = rb_registers.id and gm.user_id = auth.uid())
);
drop policy if exists "rb_registers_insert_own" on public.rb_registers;
create policy "rb_registers_insert_own" on public.rb_registers for insert with check (owner_id = auth.uid());
drop policy if exists "rb_registers_update_own" on public.rb_registers;
create policy "rb_registers_update_own" on public.rb_registers for update using (owner_id = auth.uid());
drop policy if exists "rb_registers_delete_own" on public.rb_registers;
create policy "rb_registers_delete_own" on public.rb_registers for delete using (owner_id = auth.uid());

-- Entries: same logic via register ownership/sharing — need function helper inline
drop policy if exists "rb_entries_select" on public.rb_entries;
create policy "rb_entries_select" on public.rb_entries for select using (
  exists (select 1 from public.rb_registers r where r.id = rb_entries.register_id and (
    r.owner_id = auth.uid()
    or exists (select 1 from public.rb_shares s where s.register_id = r.id and s.shared_with_user_id = auth.uid())
  ))
);
drop policy if exists "rb_entries_insert_owner" on public.rb_entries;
create policy "rb_entries_insert_owner" on public.rb_entries for insert with check (
  exists (select 1 from public.rb_registers r where r.id = register_id and r.owner_id = auth.uid())
);
drop policy if exists "rb_entries_update_owner" on public.rb_entries;
create policy "rb_entries_update_owner" on public.rb_entries for update using (
  exists (select 1 from public.rb_registers r where r.id = rb_entries.register_id and r.owner_id = auth.uid())
);
drop policy if exists "rb_entries_delete_owner" on public.rb_entries;
create policy "rb_entries_delete_owner" on public.rb_entries for delete using (
  exists (select 1 from public.rb_registers r where r.id = rb_entries.register_id and r.owner_id = auth.uid())
);

-- Shares: owner can manage; recipient can select
drop policy if exists "rb_shares_select" on public.rb_shares;
create policy "rb_shares_select" on public.rb_shares for select using (
  shared_with_user_id = auth.uid() or shared_by = auth.uid() or exists (select 1 from public.rb_registers r where r.id = rb_shares.register_id and r.owner_id = auth.uid())
);
drop policy if exists "rb_shares_insert" on public.rb_shares;
create policy "rb_shares_insert" on public.rb_shares for insert with check (
  exists (select 1 from public.rb_registers r where r.id = register_id and r.owner_id = auth.uid())
);
drop policy if exists "rb_shares_delete" on public.rb_shares;
create policy "rb_shares_delete" on public.rb_shares for delete using (
  exists (select 1 from public.rb_registers r where r.id = rb_shares.register_id and r.owner_id = auth.uid())
);

-- Groups: members can select, creator can create
drop policy if exists "rb_groups_select" on public.rb_groups;
create policy "rb_groups_select" on public.rb_groups for select using (
  created_by = auth.uid() or exists (select 1 from public.rb_group_members gm where gm.group_id = rb_groups.id and gm.user_id = auth.uid())
);
drop policy if exists "rb_groups_insert" on public.rb_groups;
create policy "rb_groups_insert" on public.rb_groups for insert with check (auth.uid() = created_by);
drop policy if exists "rb_groups_delete" on public.rb_groups;
create policy "rb_groups_delete" on public.rb_groups for delete using (created_by = auth.uid());

drop policy if exists "rb_group_members_select" on public.rb_group_members;
create policy "rb_group_members_select" on public.rb_group_members for select using (
  user_id = auth.uid() or exists (select 1 from public.rb_groups g where g.id = group_id and g.created_by = auth.uid()) or exists (select 1 from public.rb_group_members gm2 where gm2.group_id = rb_group_members.group_id and gm2.user_id = auth.uid())
);
drop policy if exists "rb_group_members_insert" on public.rb_group_members;
create policy "rb_group_members_insert" on public.rb_group_members for insert with check (
  exists (select 1 from public.rb_groups g where g.id = group_id and (g.created_by = auth.uid() or exists (select 1 from public.rb_group_members gm where gm.group_id = g.id and gm.user_id = auth.uid())))
  or auth.uid() = user_id
);
drop policy if exists "rb_group_members_delete" on public.rb_group_members;
create policy "rb_group_members_delete" on public.rb_group_members for delete using (
  exists (select 1 from public.rb_groups g where g.id = group_id and g.created_by = auth.uid()) or user_id = auth.uid()
);

drop policy if exists "rb_group_messages_select" on public.rb_group_messages;
create policy "rb_group_messages_select" on public.rb_group_messages for select using (
  exists (select 1 from public.rb_group_members gm where gm.group_id = rb_group_messages.group_id and gm.user_id = auth.uid())
);
drop policy if exists "rb_group_messages_insert" on public.rb_group_messages;
create policy "rb_group_messages_insert" on public.rb_group_messages for insert with check (
  exists (select 1 from public.rb_group_members gm where gm.group_id = group_id and gm.user_id = auth.uid())
);

-- Friend requests
drop policy if exists "rb_friend_select" on public.rb_friend_requests;
create policy "rb_friend_select" on public.rb_friend_requests for select using (from_user = auth.uid() or to_user = auth.uid());
drop policy if exists "rb_friend_insert" on public.rb_friend_requests;
create policy "rb_friend_insert" on public.rb_friend_requests for insert with check (from_user = auth.uid());
drop policy if exists "rb_friend_update" on public.rb_friend_requests;
create policy "rb_friend_update" on public.rb_friend_requests for update using (to_user = auth.uid() or from_user = auth.uid());

-- Direct messages
drop policy if exists "rb_dm_select" on public.rb_direct_messages;
create policy "rb_dm_select" on public.rb_direct_messages for select using (sender_id = auth.uid() or receiver_id = auth.uid());
drop policy if exists "rb_dm_insert" on public.rb_direct_messages;
create policy "rb_dm_insert" on public.rb_direct_messages for insert with check (sender_id = auth.uid());

-- Helper: auto-create profile on signup (optional trigger)
-- Note: Supabase Auth handles users; first login will upsert profile via app.js

