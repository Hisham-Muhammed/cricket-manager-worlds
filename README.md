# Cricket Manager Worlds

A persistent multiplayer cricket management game. The world continues even
when a manager is offline: 24-hour auctions expire on their own, fixtures are
scheduled days apart and **auto-simulate at their scheduled server time** —
there is deliberately **no "Play Match" button** and no fake countdowns.

Theme: a classic professional sports-manager look (boxed login, top header
bar, dense tables) in the spirit of Soccer Manager's login page. All CSS and
layout here are original; no third-party logos/assets are copied.

## Quick start

```bash
npm install
cp .env.example .env   # edit SESSION_SECRET
npm start              # http://localhost:3000
```

First screen is the authentication page → after login you land in the
**Game World Lobby** (never straight into a club dashboard).

This quick start runs on the local-dev fallback store. For production,
Supabase is the database/auth backend — see
[Database: Supabase (production)](#database-supabase-production--local-file-dev).

## Tests

```bash
npm test
```

Runs the local-mode API test suite (`test/api.test.js`, Node's built-in
test runner, no extra dependencies). It boots the real server against a
throwaway database and pins the game's trust rules: password validation,
duplicate accounts, the exact "Incorrect world password." rejection,
empty starting squads with the shared ₹100 Cr budget, and that password
hashes are never exposed in API responses.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `3000`) |
| `SESSION_SECRET` | Signs session JWTs and guards `POST /api/admin/tick`. Use a long random string in production. |
| `DATABASE_MODE` | `supabase` for production, `local` for the dev-only JSON fallback |
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Public/anon key — the only Supabase key a browser may see; limited by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret**, server only — bypasses RLS; used by the API/scheduler after server-side validation. Never commit a real value or put it in frontend code |
| `DATABASE` | Local-dev fallback only: path to the JSON DB file (default `./data/db.json`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Local-mode Google OAuth only — in supabase mode the credentials live in the Supabase provider settings (see below) |
| `GOOGLE_CALLBACK_URL` | e.g. `http://localhost:3000/api/auth/google/callback` |
| `SCHEDULER_INTERVAL_MS` | Scheduler tick interval (default `10000`) |

### Google sign-in
Two real implementations, selected by `DATABASE_MODE` — neither ever
fake-logs anyone in:

**Supabase mode (production).** Google is enabled as a provider in
Supabase Auth (Dashboard → Authentication → Providers → Google, with
the OAuth client's ID + secret stored there — not in this repo's
`.env`). "Sign in with Google" sends the browser to Supabase's
authorize URL; Google redirects back to the site root, the frontend
hands the access token to `POST /api/auth/google/session`, and the
server verifies it against Supabase Auth and links/creates the manager
profile in `public.managers` (`auth_user_id`). In the Google Cloud
Console the OAuth client needs the Supabase callback
`https://<project-ref>.supabase.co/auth/v1/callback` as an authorised
redirect URI, and the consent screen published (this project's setup
was completed and verified on 2026-10-13).

**Local mode (dev).** Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
/ `GOOGLE_CALLBACK_URL` in `.env` (create the client at
<https://console.cloud.google.com/apis/credentials>, authorised
redirect URI `http://localhost:3000/api/auth/google/callback`). The
server runs the standard OAuth code exchange itself. Without those
values the Google button returns a clear "Google OAuth needs
configuration" message.

Email register/login (bcrypt-hashed passwords, `bcryptjs`, cost 12)
works with no external configuration.

## How the game works

1. **Auth** — email/Google account = a persistent manager profile (id, name,
   email, provider, joined/created worlds, current club, stats, trophies,
   history). Logout and returning to your club/world are supported.
2. **Game World Lobby** — lists every world: creator, managers `x / clubs`,
   state, start date, format, 🔒 if password-protected.
3. **Create World** — name, description, number of clubs, format, match
   interval (default 3 days), match time, timezone, season length, auction /
   season start times, optional password. The password is **bcrypt-hashed,
   never stored or shown in plain text**; a wrong join password returns
   exactly `Incorrect world password.`
4. **Join World** — view details → enter password if private → **choose an
   available club** — the original IPL franchises (Chennai Super Kings,
   Mumbai Indians, Royal Challengers Bengaluru, Kolkata Knight Riders,
   Rajasthan Royals, Sunrisers Hyderabad, Delhi Capitals, Punjab Kings,
   Lucknow Super Giants, Gujarat Titans) → **Waiting Room** (managers
   x/y, rules, auction/season start times).
5. **No initial squads.** Every manager starts with an empty squad and the
   same **₹100 Cr** budget.
6. **Player Auction Market** — seeded with the real player database (Virat
   Kohli, Rohit Sharma, Jasprit Bumrah, MS Dhoni, Hardik Pandya, KL Rahul,
   Rishabh Pant, Shubman Gill, Ravindra Jadeja, Suryakumar Yadav, Mohammed
   Siraj, Kuldeep Yadav, Pat Cummins, Steve Smith, Joe Root, Ben Stokes,
   Jos Buttler, Kane Williamson, Trent Boult, Rashid Khan, Babar Azam,
   Shaheen Afridi, and more) with age, role, nationality, rating and base
   value (₹ Cr). Each auction stores `auctionEndsAt = start + 24h` on the
   **server**; countdowns are rendered from that timestamp and `serverNow`.
   Bids are validated server-side (world membership, auction open, higher
   than current top bid, base value, and budget — *"Insufficient transfer
   funds."*), ties break to the **earliest** valid bid. Watchlist and
   outbid notifications included.
7. **Squad / Tactics** — appoint Captain / Vice-Captain (leadership lifts
   the player's morale and adds a chemistry/performance modifier in the
   match engine), pick a Playing XI (max 11, only your own players) and
   tactics. XI/tactics **lock 30 minutes before** your next fixture.
8. **Fixtures & Match Centre** — when a world's season start arrives, the
   scheduler generates a round-robin (home & away) fixture list; a club is
   never double-booked in a round. Matches auto-simulate at their scheduled
   time from the *current* squad/XI/captain/tactics/fitness/form of both
   clubs, produce a scorecard + report, update the league table, finances,
   form/fitness, and create `MATCH_STARTED` / `MATCH_COMPLETED` events and
   notifications — including a "you missed this match" note if you were
   offline.

### World state machine
`CREATED → RECRUITING → AUCTION → SQUAD_BUILDING → PRE_SEASON →
ACTIVE_SEASON → SEASON_FINISHED → OFF_SEASON → NEXT_SEASON`
(transitions are time/state driven in the scheduler; the later states are
declared in the model for the next-season rollover.)

### Scheduler
`src/scheduler.js` runs on `setInterval` (server time is the only source of
truth) and on each tick: advances world states, opens auctions, **settles
expired auctions atomically** (winner pays, ownership moves, losing bids are
marked `UNSUCCESSFUL`, no-bid players are relisted for 24h, a
`TRANSFER_COMPLETED` news item + notifications are created), generates
fixtures at season start, and simulates due matches. For hosted deployments
you can also call it from system cron:

```bash
curl -X POST -H "x-admin-key: $SESSION_SECRET" http://localhost:3000/api/admin/tick
```

### Player ownership & anti-cheat
A player copy belongs to exactly one club per world; ownership changes only
inside auction settlement. Money, ratings, auction end times, results and
ownership are never accepted from the client — all mutations are validated
in `src/server.js` / `src/scheduler.js`.

## Folder structure

```
.
├── package.json
├── .env.example
├── public/            # frontend (login, lobby, auction, squad, fixtures…)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── supabase/
│   ├── schema.sql     # PRODUCTION schema: all tables, place_bid(), RLS policies
│   └── seed.sql       # real player pool (409 players, mirrors src/players.js)
├── src/
│   ├── server.js      # Express API: auth, worlds, join, bids, XI, league
│   ├── supabase.js    # Supabase service-role client + DATABASE_MODE switch
│   ├── db.js          # local-dev JSON fallback store (NOT production)
│   ├── players.js     # real player database seed
│   ├── fixtures.js    # round-robin schedule generator
│   ├── matchEngine.js # deterministic simulation from current team state
│   └── scheduler.js   # persistent-world tick: auctions, states, matches
└── data/              # db.json local-dev fallback (created on first run, git-ignored)
```

## Database: Supabase (production) / local file (dev)

**Production database and auth backend: Supabase** (hosted Postgres +
Supabase Auth) — chosen for this project over Firebase because the game is
inherently relational: worlds → memberships → auctions → bids → fixtures,
with joins, unique constraints and atomic settlement.

**Free tier:** Supabase has a free plan that needs no credit card and is
enough to launch and test this game with real managers — a Postgres
database, Auth (email + social providers such as Google), Row Level
Security and an API. Quotas and inactivity-pausing rules for free projects
change over time, so check the current limits at
<https://supabase.com/pricing> before a public launch, and upgrade only
when you outgrow them.

### Supabase setup steps
1. Go to <https://supabase.com> → **New project** (free plan). Pick a name
   and region close to your players (e.g. Mumbai / Singapore for India),
   and save the database password somewhere safe.
2. Wait for the project to finish provisioning, then open
   **SQL Editor → New query**, paste the whole of
   [`supabase/schema.sql`](supabase/schema.sql) and **Run**. This creates
   all tables (`managers`, `worlds`, `clubs`, `memberships`, `players`,
   `world_players`, `auctions`, `bids`, `fixtures`, `league_standings`,
   `events`, `notifications`, `news`, `watchlist`), indexes, the atomic
   `place_bid()` function, and the RLS policies.
3. Run [`supabase/seed.sql`](supabase/seed.sql) the same way to load the
   real player pool (44 players, same data as `src/players.js`).
4. **Authentication → Providers:** enable **Email**. For Google sign-in,
   enable **Google** there and paste your Google Cloud OAuth client ID /
   secret (Google Cloud Console → APIs & Services → Credentials → OAuth
   client), using the redirect URL Supabase shows you on that page.
   Also set **Authentication → URL Configuration** (Site URL + redirect
   URLs) to your deployed app URL.
5. **Project Settings → API:** copy the **Project URL** and keys into your
   host's environment variables (never into Git):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   and set `DATABASE_MODE=supabase`.
6. Deploy the server (below), open the app, register — then confirm your
   manager row appears in **Table Editor → managers**.

### RLS notes
`schema.sql` enables Row Level Security on every table. The browser
(anon key) is read-mostly and can only touch its own manager profile,
notifications and watchlist. There are deliberately **no client write
policies** for bids, money, ownership, auction times or results: trusted
writes go through the Node server using the **service-role key** (which
bypasses RLS) after server-side validation, and bidding can use the
`place_bid()` Postgres function so budget/highest-bid checks happen in
one transaction. `worlds.password_hash` must never be selected by client
queries — it is a bcrypt hash, compared only on the server.

### Local-dev fallback
With `DATABASE_MODE=local` (or no Supabase env vars) the app runs on the
JSON file store in `src/db.js`, so `npm install && npm start` works with
zero external accounts. That store is for development only — it is
single-process and is **not** the production database. Its collections map
1:1 to the Supabase tables (`users` → `managers`, `worldPlayers` →
`world_players`, `league` → `league_standings`, the rest keep their names),
and `src/supabase.js` provides the service-role client for the production
switch.

## Deploying to GitHub / a host
Push this folder to GitHub, then deploy on Render/Railway/a VPS with
`npm install && npm start`, complete the Supabase setup steps above, and
set the env vars (including `DATABASE_MODE=supabase` and the three
Supabase values) in the host — never commit a real `.env` or the
service-role key to Git.
