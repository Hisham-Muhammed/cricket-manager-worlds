# Work Log — Cricket Manager Worlds

Real development log for this project. Each entry is work that was
actually done and reviewed, in the order it happened.

## Roadmap (in order)

1. Initial release: auth, game world lobby, create/join worlds,
   waiting room, 24-hour auctions, scheduled auto-simulated matches.
2. Supabase migration: move API routes from the local file store to
   Supabase (auth/managers → worlds/memberships → auctions/bids via
   the atomic `place_bid()` function → scheduler → read routes).
3. Google sign-in end-to-end test against the live Supabase project.
4. Test suite: auth, world password, auction settlement, fixtures.
5. UI polish pass (Soccer Manager-style manager theme).
6. Deployment guide (Render/Railway) + production checklist
   (secret rotation, DATABASE_MODE=supabase).

## Log

### 2026-10-10 — Project created
- Persistent multiplayer design fixed: no pre-built squads, ₹100 Cr
  starting budget, real 24-hour auctions with stored server expiry,
  matches scheduled every 3–4 days and auto-simulated at their
  scheduled time — no "Play Match" button.
- Node.js + Supabase codebase built; schema for 14 tables with RLS;
  44 real players seeded in Supabase (project verified live).
- Google OAuth client created; Supabase/Google setup documented.

### 2026-10-13 — GitHub phase started
- Repository prepared for upload (secret scan: no keys in source).
- This work log + roadmap added.
- Repository published and the full codebase pushed.
- Next: Supabase migration step 1 (auth/managers routes).

### 2026-10-13 — Local-mode API test suite (roadmap step 4, pulled forward)
- Added `test/api.test.js` using Node's built-in test runner — the
  suite boots the real server against a throwaway JSON database, so
  it never touches real data and needs no extra dependencies.
- 11 tests, all passing (`npm test`). They pin the trust rules, not
  just the happy paths: 6+ character passwords (400), duplicate email
  (409), wrong login password (401), session required (401), wrong
  world password → 403 with exactly "Incorrect world password.",
  joining starts with an empty squad and budget 100 (₹100 Cr),
  no double-join, no taking a club twice, and the world password hash
  is never exposed in API responses.
- Auction/fixture tests stay with roadmap step 4 proper, once the
  Supabase migration lands.

### 2026-10-13 — Google sign-in setup completed + Supabase migration step 1 (auth/managers)
- Google Cloud: OAuth client verified (JS origin + both redirect
  URIs), consent screen published — status "In production", so the
  test-user restriction is gone. Supabase: Google provider ENABLED,
  Site URL confirmed as http://localhost:3000. (A new client secret
  was created in the console during setup — Google no longer shows
  existing secrets — and is the one now stored in Supabase.)
- Migration step 1 implemented, following the schema's design
  (Supabase Auth = identity provider, `public.managers` = game
  profile linked by `auth_user_id`):
  - In `DATABASE_MODE=supabase`, register creates the Supabase Auth
    user + managers row (duplicate email still returns the same 409),
    login verifies credentials through Supabase Auth (wrong password
    still 401 with the same message), and `/api/auth/me` resolves the
    manager profile from the session cookie.
  - The app session stays our own JWT cookie whose uid is now the
    managers uuid, so all other routes keep the same `req.user`
    shape; worlds/auctions still run on the local store until their
    migration steps.
  - Google sign-in in supabase mode goes through Supabase's OAuth
    redirect; the frontend hands the returned access token to
    `POST /api/auth/google/session`, which verifies it against
    Supabase Auth and links/creates the manager — a bare name/email
    is never trusted.
  - Local mode is unchanged: the existing test suite still passes
    11/11, and without full Supabase config the server falls back to
    the local store instead of crashing.
- Next: live end-to-end test of supabase mode against the real
  project, then migration step 2 (worlds/memberships).

### 2026-10-13 — Original IPL team names (GitHub codebase)
- The invented club names are replaced with the 10 original IPL
  franchises: Chennai Super Kings, Mumbai Indians, Royal Challengers
  Bengaluru, Kolkata Knight Riders, Rajasthan Royals, Sunrisers
  Hyderabad, Delhi Capitals, Punjab Kings, Lucknow Super Giants,
  Gujarat Titans. World size now clamps to the club list (max 10).
- Tests updated and passing 11/11.
- Queued for this codebase (landing first in the hosted game): AI
  managers to fill empty clubs so a world is playable solo, and a
  creator "start anytime" control for worlds.

### 2026-10-14 — IPL 2026 player pool added (GitHub codebase)
- Player database expanded from 44 to 409: the original star set
  (retained-player names like Kohli/Rohit/Bumrah, who are not in any
  auction list) merged with the published IPL 2026 final auction
  list (350) + 19 reported late additions. Auction duplicates of
  existing stars (Hasaranga, Ravindra, de Kock, Smith) keep the
  original tuned entries.
- For auction players, name/nationality/role/base price are the real
  published data (base price = in-game base value in ₹ Cr, ₹2 Cr
  down to ₹30 L). Ratings are game-balancing estimates derived from
  the price bracket + capped status — the same convention the star
  set already used, and labelled as such in players.js.
- Ages are not published in the auction list, so auction players
  carry age NULL: schema.sql now allows it, seed.sql documents the
  one-line ALTER for existing projects, and the UI shows '—'.
- seed.sql regenerated from players.js (409 rows).

### 2026-10-14 — Google sign-in in this codebase: documented + redirect legs verified
- Confirmed both real Google flows are in the code and documented
  them properly in the README (the old text only covered local
  mode): supabase mode goes through the Supabase Auth Google provider
  (enabled 2026-10-13) with the token verified at
  `POST /api/auth/google/session`; local mode runs the standard
  OAuth code exchange with `GOOGLE_*` env values.
- Live boot tests (placeholder keys, real URLs): local mode returns
  302 to accounts.google.com with the correct client_id and
  `/api/auth/google/callback` redirect URI; supabase mode returns
  302 to the project's `/auth/v1/authorize?provider=google`. The
  final leg (a real Google account completing sign-in) needs the
  server running with the project's real keys — deployment-time
  verification, like the rest of supabase mode.

### 2026-10-14 — Live-site feedback round: AI managers + creator start, player pages, undisclosed bids + withdraw, squad/budget guards, UI polish
First feedback from playing the live Render site, four features:

- **AI managers + creator start-anytime** (was queued for this codebase;
  now implemented): world creation accepts `aiFill` (default true,
  stored on the world, checkbox on the create form). New route
  `POST /api/worlds/:id/start` — creator only (403 for anyone else,
  409 once started, 400 if the creator hasn't joined a club or, with
  aiFill off, fewer than 2 managers). It fills every unclaimed club
  with an AI manager (manager record flagged `ai:true`, synthetic
  name/email, random unusable password hash, ₹100 Cr + empty squad
  exactly like a human; the login route refuses AI accounts) and then
  starts the world through the scheduler's new `startWorld()` — the
  same `openAuctions()` path as the scheduled start. Waiting Room
  shows the creator a gold "▶ Start World Now" panel. In the world
  tick, AI managers bid during the AUCTION phase under the exact same
  rules as humans (shared guard, below): ≤2 bids per tick each,
  highest-rated targets first, modest ~5% increments, never in the
  final 10 minutes, stopping at a squad + live-leads target of 20;
  at season start they auto-pick an XI and captain/vice-captain.
- **Player detail page + bid history + undisclosed bids + withdraw**:
  new route `GET /api/worlds/:wid/players/:pid` returns the full
  player (ratings, base price, form/fitness/morale, owner), its
  auction, and the complete bid history. Clicking a player in the
  Auction list, Player Database or Squad opens that page in the SPA,
  with the bid form on it. Bids accept `undisclosed:true` — for
  everyone except the bidder, that bid's amount and identity are
  masked (`amount:null`, "Undisclosed"); the auction's current price
  stays public (you must be able to bid against it) while an
  undisclosed leader shows as "Undisclosed", and undisclosed bids
  never leak amount/club into the world event feed. Settlement still
  uses the real amounts. New route `POST /api/auctions/:id/withdraw`
  removes the caller's own highest live bid — allowed even when
  leading — and recomputes leader/price from the remaining bids
  (400 if the caller has no bid); the caller may bid again.
- **Squad size + budget guard** (server-side, humans and AI share it
  via the new `src/bids.js`): squads are 18–25 players. A bid that
  would add a 26th squad/leading commitment is rejected
  "Squad is full (max 25 players)."; and a bid is rejected with
  "Bid too high — you must keep enough budget to complete a minimum
  18-player squad." when the manager's live commitments plus a
  reserve (slots still needed to reach 18 × the pool's cheapest base
  price, ₹0.3 Cr in the IPL pool, computed from the world's own
  auctions) would exceed their budget — so nobody can blow ₹100 Cr
  on one player and be unable to field a squad. A raise on an auction
  you already lead replaces its commitment.
- **UI/menu polish**: the top tab bar is now a navy left sidebar —
  club crest block (initials crest, club name, budget) over grouped
  menu sections (Home / Manage / World) with icons and active-state
  highlighting for Home/Lobby, Waiting Room, Auction, Player
  Database (new screen), Squad, Captain & Tactics, Fixtures, League,
  Finance, News, History and Messages. The Auction screen is a dense
  Soccer Manager-style table (price, leader incl. Undisclosed,
  time-left, inline bid + undisclosed tick + watchlist) with a name
  filter; player rows everywhere are clickable through to the player
  page. Dark theme kept, gold reserved for primary/creator actions.
- Tests: suite extended 11 → **18 tests, all passing** (`npm test`):
  non-creator start 403, creator start below full with AI fill
  (aiAdded/memberships/budget), double-start 409, undisclosed bid
  masked for others but visible to the bidder (price stays public),
  withdraw of the leading bid recomputing leader/price (+ 400 with no
  bid), budget-guard 400 (₹95 Cr on one player leaves < 18 × ₹0.3 Cr)
  with a sane bid still accepted, and the 25-player squad cap 400 on
  a 26th leading bid. Boot smoke (local mode, fast scheduler) also
  verified live AI bidding on the tick and that AI accounts cannot
  log in.

### 2026-10-14 — Free public website: Render blueprint added
- Hosting decision: Oracle Cloud Always Free is not possible (its
  signup requires a bank card; the user has none). Render free tier
  needs no card — GitHub sign-in only.
- Added `render.yaml` (free web service, `npm install` / `npm start`,
  health check `/api/server-time`, SESSION_SECRET generated,
  DATABASE_MODE=local for the first deploy). Known free-tier limits,
  documented in the file: sleeps when idle and ephemeral filesystem
  until Supabase migration step 2 (worlds) makes state durable.
