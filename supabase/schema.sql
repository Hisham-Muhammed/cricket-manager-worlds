-- ============================================================================
-- Cricket Manager Worlds — Supabase (Postgres) production schema
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- Local development does NOT need this: the app falls back to data/db.json
-- (see README "Database: Supabase (production) / local file (dev)").
--
-- Design notes
-- * Supabase Auth is the identity provider in production (auth.users).
--   public.managers is the game profile linked 1:1 to an auth user.
-- * ALL game mutations that must be trusted (bids, auction settlement,
--   match simulation, budget changes) run server-side. The Node server /
--   scheduler connects with SUPABASE_SERVICE_ROLE_KEY, which BYPASSES
--   Row Level Security — never expose that key in the browser.
-- * The browser may use SUPABASE_ANON_KEY only, subject to the RLS
--   policies at the bottom of this file.
-- * Passwords: auth passwords are hashed by Supabase Auth. WORLD passwords
--   are stored only as a bcrypt hash in worlds.password_hash and are never
--   returned by any API/view. A wrong join password returns exactly
--   "Incorrect world password." from the server.
-- * Money is numeric(10,2) in ₹ Crore. Server time is now() (UTC) in the DB;
--   auction/match timestamps are timestamptz, never client-generated.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- managers
create table if not exists public.managers (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users(id) on delete cascade,
  name          text not null,
  email         text not null unique,
  provider      text not null default 'email' check (provider in ('email','google')),
  profile_image text default '',
  stats         jsonb not null default '{"matchesManaged":0,"wins":0,"auctionsWon":0}'::jsonb,
  trophies      jsonb not null default '[]'::jsonb,
  history       jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------- real player pool
create table if not exists public.players (
  id          text primary key,              -- e.g. 'player_1' (matches src/players.js)
  name        text not null,
  age         int,                            -- nullable: the published IPL auction list has no ages; auction-pool players ship age NULL (existing projects: alter table public.players alter column age drop not null;)
  role        text not null check (role in ('Batsman','Bowler','All-Rounder','Wicket-Keeper')),
  nationality text not null,
  rating      int  not null check (rating between 1 and 99),
  batting     int  not null,
  bowling     int  not null,
  leadership  int  not null,
  base_value  numeric(10,2) not null,        -- ₹ Cr
  created_at  timestamptz not null default now()
);
-- Seed rows: run supabase/seed.sql (generated from src/players.js).

-- ----------------------------------------------------------------- worlds
create table if not exists public.worlds (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  description           text default '',
  creator_id            uuid not null references public.managers(id) on delete cascade,
  number_of_clubs       int  not null default 12 check (number_of_clubs between 2 and 20),
  format                text not null default 'League (Home & Away)',
  competition_structure text not null default 'Round-robin league',
  match_interval_days   int  not null default 3 check (match_interval_days between 1 and 7),
  match_time            text not null default '20:00',
  timezone              text not null default 'Asia/Kolkata',
  season_length         text not null default '1 season',
  auction_settings      jsonb not null default '{"durationHours":24,"startingBudget":100}'::jsonb,
  start_date            timestamptz not null,
  auction_start_at      timestamptz,
  season_start_at       timestamptz,
  password_hash         text,                -- bcrypt hash only; NULL = public world
  state                 text not null default 'RECRUITING' check (state in
                          ('CREATED','RECRUITING','AUCTION','SQUAD_BUILDING','PRE_SEASON',
                           'ACTIVE_SEASON','SEASON_FINISHED','OFF_SEASON','NEXT_SEASON')),
  created_at            timestamptz not null default now()
);

-- ------------------------------------------------------------------ clubs
-- One row per selectable club slot inside a world (Kerala Kings, ...).
create table if not exists public.clubs (
  id          uuid primary key default gen_random_uuid(),
  world_id    uuid not null references public.worlds(id) on delete cascade,
  name        text not null,
  unique (world_id, name)
);

-- ------------------------------------------------------------ memberships
-- A manager in a world, playing as one club. Squads start EMPTY and the
-- budget starts at ₹100 Cr for everyone — enforced by the defaults here.
create table if not exists public.memberships (
  id              uuid primary key default gen_random_uuid(),
  world_id        uuid not null references public.worlds(id) on delete cascade,
  manager_id      uuid not null references public.managers(id) on delete cascade,
  club_id         uuid references public.clubs(id) on delete set null,
  club_name       text not null,
  budget          numeric(10,2) not null default 100,
  xi              jsonb not null default '[]'::jsonb,   -- array of world_players.id, max 11 (server-validated)
  tactics         jsonb not null default '{"formation":"Balanced","battingApproach":"Balanced","bowlingApproach":"Balanced"}'::jsonb,
  captain_id      uuid,   -- -> world_players.id (FK added after world_players exists in fresh installs; validated server-side)
  vice_captain_id uuid,
  last_seen_at    timestamptz,
  joined_at       timestamptz not null default now(),
  unique (world_id, manager_id),
  unique (world_id, club_name)
);

-- ----------------------------------------------------------- world_players
-- Per-world copy of a player from the pool. A player can be owned by at
-- most one membership in a world (single owner column + settlement in one
-- transaction is what enforces this).
create table if not exists public.world_players (
  id                 uuid primary key default gen_random_uuid(),
  world_id           uuid not null references public.worlds(id) on delete cascade,
  player_id          text not null references public.players(id),
  owner_membership_id uuid references public.memberships(id) on delete set null,
  status             text not null default 'IN_MARKET' check (status in ('IN_MARKET','OWNED','SOLD')),
  form               int not null default 50,
  fitness            int not null default 100,
  morale             int not null default 70,
  unique (world_id, player_id)
);

-- --------------------------------------------------------------- auctions
create table if not exists public.auctions (
  id               uuid primary key default gen_random_uuid(),
  world_id         uuid not null references public.worlds(id) on delete cascade,
  world_player_id  uuid not null references public.world_players(id) on delete cascade,
  base_value       numeric(10,2) not null,
  auction_starts_at timestamptz not null,
  auction_ends_at   timestamptz not null,    -- stored server timestamp; countdowns derive from this + server now()
  status           text not null default 'OPEN' check (status in ('OPEN','EXPIRED','SOLD','CANCELLED')),
  highest_bid_id   uuid,
  relist_count     int not null default 0,
  created_at       timestamptz not null default now(),
  unique (world_id, world_player_id)
);
create unique index if not exists one_open_auction_per_player
  on public.auctions (world_player_id) where status = 'OPEN';

-- ------------------------------------------------------------------- bids
create table if not exists public.bids (
  id            uuid primary key default gen_random_uuid(),
  auction_id    uuid not null references public.auctions(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  amount        numeric(10,2) not null check (amount > 0),
  status        text not null default 'VALID' check (status in ('VALID','WON','UNSUCCESSFUL','INVALID')),
  created_at    timestamptz not null default now()  -- earliest valid bid wins a tie
);
create index if not exists bids_auction_idx on public.bids (auction_id, amount desc, created_at asc);

-- --------------------------------------------------------------- fixtures
create table if not exists public.fixtures (
  id                  uuid primary key default gen_random_uuid(),
  world_id            uuid not null references public.worlds(id) on delete cascade,
  round               int  not null,
  home_membership_id  uuid not null references public.memberships(id) on delete cascade,
  away_membership_id  uuid not null references public.memberships(id) on delete cascade,
  competition         text not null default 'Premier League',
  scheduled_at        timestamptz not null,
  timezone            text not null default 'Asia/Kolkata',
  tactical_lock_at    timestamptz not null,  -- scheduled_at - 30 minutes
  status              text not null default 'SCHEDULED' check (status in
                        ('SCHEDULED','PREPARING','LIVE','COMPLETED','POSTPONED','CANCELLED')),
  result              jsonb,                 -- scorecard + report, written once by the scheduler
  completed_at        timestamptz,
  unique (world_id, round, home_membership_id, away_membership_id)
);

-- --------------------------------------------------------- league standings
create table if not exists public.league_standings (
  id            uuid primary key default gen_random_uuid(),
  world_id      uuid not null references public.worlds(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  played int not null default 0, won int not null default 0, lost int not null default 0,
  tied   int not null default 0, points int not null default 0,
  runs_for int not null default 0, runs_against int not null default 0,
  nrr numeric(8,3) not null default 0,
  unique (world_id, membership_id)
);

-- ------------------------------------------------------ events / news / inbox
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  world_id   uuid references public.worlds(id) on delete cascade,
  type       text not null,  -- AUCTION_STARTED, BID_PLACED, AUCTION_EXPIRED, PLAYER_SOLD,
                             -- TRANSFER_COMPLETED, MATCH_STARTED, MATCH_COMPLETED,
                             -- SEASON_STARTED, SEASON_COMPLETED, ...
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.news (
  id         uuid primary key default gen_random_uuid(),
  world_id   uuid not null references public.worlds(id) on delete cascade,
  type       text not null,
  headline   text not null,
  body       text default '',
  created_at timestamptz not null default now()
);
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.managers(id) on delete cascade,
  world_id   uuid references public.worlds(id) on delete cascade,
  type       text not null,
  message    text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.managers(id) on delete cascade,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  unique (manager_id, auction_id)
);

-- ------------------------------------------------------- atomic bid function
-- The Node API may call this instead of inserting directly, so budget /
-- highest-bid validation happens inside Postgres in one transaction.
-- Tie-break: amount DESC, created_at ASC (earliest valid bid wins).
create or replace function public.place_bid(p_auction uuid, p_membership uuid, p_amount numeric)
returns public.bids language plpgsql security definer set search_path = public as $$
declare a public.auctions; m public.memberships; top numeric; new_bid public.bids;
begin
  select * into a from auctions where id = p_auction for update;
  if not found or a.status <> 'OPEN' then raise exception 'This auction is closed / player already sold.'; end if;
  if now() >= a.auction_ends_at then raise exception 'This auction has expired.'; end if;
  select * into m from memberships where id = p_membership;
  if not found or m.world_id <> a.world_id then raise exception 'You are not a manager in this world.'; end if;
  select max(amount) into top from bids where auction_id = a.id and status = 'VALID';
  if p_amount < a.base_value or (top is not null and p_amount <= top) then
    raise exception 'Bid must be higher than the current highest bid.'; end if;
  if p_amount > m.budget then raise exception 'Insufficient transfer funds.'; end if;
  insert into bids (auction_id, membership_id, amount)
    values (p_auction, p_membership, p_amount) returning * into new_bid;
  update auctions set highest_bid_id = new_bid.id where id = a.id;
  return new_bid;
end $$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Enable RLS on every table. The service-role key (server/scheduler only)
-- bypasses RLS. Policies below are for the anon/authenticated browser client:
-- read-mostly, and a manager can only write their own profile / watchlist.
-- ============================================================================
alter table public.managers         enable row level security;
alter table public.players          enable row level security;
alter table public.worlds           enable row level security;
alter table public.clubs            enable row level security;
alter table public.memberships      enable row level security;
alter table public.world_players    enable row level security;
alter table public.auctions         enable row level security;
alter table public.bids             enable row level security;
alter table public.fixtures         enable row level security;
alter table public.league_standings enable row level security;
alter table public.events           enable row level security;
alter table public.news             enable row level security;
alter table public.notifications    enable row level security;
alter table public.watchlist        enable row level security;

-- Helper: the managers.id for the signed-in auth user.
create or replace function public.current_manager_id() returns uuid
language sql stable security definer set search_path = public as
$$ select id from public.managers where auth_user_id = auth.uid() $$;

drop policy if exists "read public game data" on public.players;
create policy "read public game data" on public.players for select to authenticated using (true);
drop policy if exists "read worlds" on public.worlds;
create policy "read worlds" on public.worlds for select to authenticated using (true);
-- NOTE: never select password_hash from the client; use a view without it for lobby listings.
drop policy if exists "read clubs" on public.clubs;
create policy "read clubs" on public.clubs for select to authenticated using (true);
drop policy if exists "read memberships" on public.memberships;
create policy "read memberships" on public.memberships for select to authenticated using (true);
drop policy if exists "read world players" on public.world_players;
create policy "read world players" on public.world_players for select to authenticated using (true);
drop policy if exists "read auctions" on public.auctions;
create policy "read auctions" on public.auctions for select to authenticated using (true);
drop policy if exists "read bids" on public.bids;
create policy "read bids" on public.bids for select to authenticated using (true);
drop policy if exists "read fixtures" on public.fixtures;
create policy "read fixtures" on public.fixtures for select to authenticated using (true);
drop policy if exists "read standings" on public.league_standings;
create policy "read standings" on public.league_standings for select to authenticated using (true);
drop policy if exists "read news" on public.news;
create policy "read news" on public.news for select to authenticated using (true);
drop policy if exists "read events" on public.events;
create policy "read events" on public.events for select to authenticated using (true);
drop policy if exists "own manager profile" on public.managers;
create policy "own manager profile" on public.managers for all to authenticated
  using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications for select to authenticated
  using (manager_id = public.current_manager_id());
drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist for all to authenticated
  using (manager_id = public.current_manager_id()) with check (manager_id = public.current_manager_id());
-- No INSERT/UPDATE/DELETE policies for bids, auctions, fixtures, worlds,
-- memberships etc.: writes happen only through the Node server using the
-- service-role key, after server-side validation. Do not add permissive
-- client write policies for money, ownership, results or auction times.
