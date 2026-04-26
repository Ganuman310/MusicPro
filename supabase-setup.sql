-- ══════════════════════════════════════
-- MusicPro — Supabase Database Setup
-- Run this in your Supabase SQL Editor
-- ══════════════════════════════════════

-- 1. PROFILES (auto-created from auth)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz default now()
);

-- 2. PLAYLISTS
create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  emoji       text default '📚',
  created_at  timestamptz default now()
);

-- 3. PLAYLIST TRACKS
create table if not exists public.playlist_tracks (
  id          uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  filename    text not null,
  position    integer default 0,
  added_at    timestamptz default now()
);

-- 4. FAVOURITES
create table if not exists public.favourites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  filename    text not null,
  added_at    timestamptz default now(),
  unique(user_id, filename)
);

-- 5. PREFERENCES
create table if not exists public.preferences (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade unique,
  volume       float default 1,
  speed_index  integer default 2,
  shuffle      boolean default false,
  repeat       integer default 0,
  gh_user      text default '',
  gh_repo      text default '',
  enc_password text default '',   -- Encryption password stored server-side. RLS ensures only the owner can read it.
  updated_at   timestamptz default now()
);

-- ══════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ══════════════════════════════════════

alter table public.profiles        enable row level security;
alter table public.playlists       enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.favourites      enable row level security;
alter table public.preferences     enable row level security;

-- PROFILES policies
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);
create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- PLAYLISTS policies
create policy "Users can manage own playlists"
  on public.playlists for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- PLAYLIST_TRACKS policies
create policy "Users can manage tracks in own playlists"
  on public.playlist_tracks for all
  using (exists (select 1 from public.playlists where id = playlist_id and user_id = auth.uid()))
  with check (exists (select 1 from public.playlists where id = playlist_id and user_id = auth.uid()));

-- FAVOURITES policies
create policy "Users can manage own favourites"
  on public.favourites for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- PREFERENCES policies
create policy "Users can manage own preferences"
  on public.preferences for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ══════════════════════════════════════
-- AUTO-CREATE PROFILE ON SIGNUP
-- ══════════════════════════════════════

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
