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

### 2026-10-14 — Supabase durability layer: full game state in public.app_state
- Problem: in `DATABASE_MODE=supabase` only auth/managers used Supabase;
  worlds/auctions/everything else still lived in the local JSON file,
  so every Render restart/redeploy wiped live worlds.
- Fix (src/db.js): a state-table durability layer. New table
  `public.app_state` (single row, id = 1, `state` jsonb; RLS enabled
  with NO policies — only the server's service-role key can touch it;
  SQL added to supabase/schema.sql). At boot the server awaits
  `db.init()` before listening: in supabase mode it GETs the app_state
  row via the service-role REST API and uses its `state` as the store
  (starting from a fresh default state — persisted once — when no row
  exists). Every `save()` still writes the local file (now the
  fallback cache) and mirrors the newest state to app_state with
  write coalescing (identical snapshots skipped, in-flight snapshots
  collapsed); SIGTERM/SIGINT flush the final state before exit. If
  Supabase is unreachable at boot, the server logs it and falls back
  to the local file instead of crashing; a failed save logs and keeps
  the state in memory. Local mode is behaviour-identical.
- Docs: .env.example + README document the layer and the one-time
  app_state SQL (already in schema.sql for new projects).
- Scope note: this is a durability layer, NOT the normalised per-table
  migration — worlds/memberships/auctions as their own Supabase rows
  (with the atomic `place_bid()`) remains roadmap step 2 future work.
- Verified: `npm test` 18/18; local-mode boot smoke; and a supabase
  mode smoke against a local mock of the Supabase REST/Auth endpoints
  — register + create world, restart the server, world still there
  (loaded from app_state), again across a second restart.

### 2026-10-14 — Free public website: Render blueprint added
- Hosting decision: Oracle Cloud Always Free is not possible (its
  signup requires a bank card; the user has none). Render free tier
  needs no card — GitHub sign-in only.
- Added `render.yaml` (free web service, `npm install` / `npm start`,
  health check `/api/server-time`, SESSION_SECRET generated,
  DATABASE_MODE=local for the first deploy). Known free-tier limits,
  documented in the file: sleeps when idle and ephemeral filesystem
  until Supabase migration step 2 (worlds) makes state durable.

### 2026-10-14 — Real player photos wired in (Wikimedia Commons)
- The user asked for original player photos instead of generated art.
  A verified manifest (research: every URL HEAD-checked, free licenses
  only — CC BY / CC BY-SA / CC0 / public domain / GODL-India) covers
  **95 of the 409** pool players; the other 314 have no freely licensed
  Commons photo (non-free article images or no article), so nothing
  unverified was substituted.
- `src/photos.json` (name → photoUrl/filePage/license/credit) is loaded
  by the server at boot (tolerant if missing) and never served as a
  route. The shared player builders in `src/server.js` (auction view,
  player detail, squad) now add `photoUrl`, `photoCredit`,
  `photoLicense` and `photoPage` — real values for manifest players,
  null otherwise.
- Client: `portraitFor()` resolves real photo first, then the
  generated role portraits in `/assets/`, then the initials avatar.
  The player detail page shows a "Photo: <credit> · <license>" line
  linking to the Commons file page; the Player Database footer credits
  Wikimedia Commons for photos and notes generated artwork for others.
- Tests: 19/19 — new test pins Kohli's photoUrl (upload.wikimedia.org)
  in the auction list + player detail, and photoUrl null for a
  non-manifest player (Klaasen).

### 2026-10-14 — Three live bug fixes: AI freeze after undisclosed bids, Google redirect http, refresh logout
- **Bug 1 — AI stops bidding after an undisclosed bid (root cause
  found by reproduction, and it was NOT the masking).** The AI tick
  path (`scheduler.aiTakeTurn` → `src/bids.js`) reads raw `db.bids`
  throughout (`topBid`/`validBids`/`leadingList`); `bidView`/
  `auctionView` masking lives only in HTTP serialization in
  server.js and never feeds server logic — proven by repro: on a
  fresh world the AI happily counter-bids undisclosed bids. The real
  mechanism was economic: the AI opened up to 2 new fronts per tick,
  highest-rated first, with no cap on total commitments. Within ~10
  ticks it led ~18 star-heavy auctions totalling ₹99.95 Cr of its
  ₹100 Cr (measured in a live-style repro), after which the shared
  `validateBid()` budget guard rejected every further bid
  ("Insufficient transfer funds." — re-contesting a ₹15 Cr star
  needed ₹16.8 Cr while its other leads still committed ≈₹85 Cr)
  and the squad-target count (20) was saturated too. The AI was
  frozen for the rest of the auction; when the user outbid it on a
  star — with an undisclosed bid, the case reported, though
  disclosed bids froze identically — it could never respond, and no
  other AI reached that auction (fixed per-AI scan offsets, 2-bid
  quota spent earlier). Fix (`src/scheduler.js`): each AI's
  candidate order is now defend-first (auctions where it holds a
  live bid but no longer leads, before new fronts), and it only
  opens a NEW front while its live commitments are under a
  war-chest ceiling (`AI_WARCHEST_FRACTION = 0.6` of budget), so it
  always keeps headroom to defend its targets; `validateBid()` still
  guards every bid. Verified: the repro's phases B/C went from 0 AI
  counter-bids to immediate counter-bids (₹16.8 / ₹12.81), and a new
  suite regression test saturates an AI via admin ticks, outbids its
  star with an undisclosed bid, and asserts the AI counter-bids.
- **Bug 2 — Google sign-in redirected to http://.** In supabase
  mode, `/api/auth/google` built `redirect_to` from `req.protocol`,
  which is `http` behind Render's TLS-terminating proxy. Fix:
  `PUBLIC_URL` env var now feeds `publicOrigin()` — every
  externally-facing URL the server builds uses it when set (the
  Supabase `redirect_to` and the local-mode Google callback
  default); when unset, the origin comes from the request with
  `app.set('trust proxy', true)` so `X-Forwarded-Proto` keeps it
  https behind proxies. `GOOGLE_CALLBACK_URL` still overrides in
  local mode. Documented in `.env.example`, the README env table +
  Google section, and `render.yaml` (production value
  `https://cricket-manager-worlds.onrender.com`). Tests spawn real
  servers in both modes and pin the 302 Locations, plus the
  forwarded-proto fallback.
- **Bug 3 — refresh logged the user out / lost their place.** Two
  layers. Server: the JWT was already stateless/30-day, but the
  cookie attributes were implicit — all six cookie-setting sites now
  share `COOKIE_OPTS` (`httpOnly`, `SameSite=Lax`, explicit
  `Path=/`, `Max-Age` 30 days) and logout clears with the matching
  path, so the session provably survives restarts in both modes (a
  suite test presents a cookie to a second instance over the same
  DB and gets 200 from `/api/auth/me`). SPA (`public/app.js`): the
  current tab + world id + player page are persisted to
  localStorage on every render (`saveNav`/`loadNav`/`clearNav`,
  key `cmw.nav.v1`); on boot, after the `/api/auth/me` session
  restore, `restoreNav()` re-validates the saved world (and player)
  over the API and returns the user to the same screen — falling
  back player → back tab → Lobby when anything is stale; logout
  clears the saved view. The persistence helpers are exercised
  directly by a suite test (round-trip + corrupt-data fallback).
- Tests: suite extended 19 → **26 tests, all passing** (`npm test`),
  `npm run check` clean. Boot smoke (local mode, PUBLIC_URL set):
  register sets `Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`,
  the Google 302 carries the https PUBLIC_URL callback, and after a
  full process restart the same cookie passes `/api/auth/me` and the
  world-restore fetch — the exact calls `boot()`/`restoreNav()` make.

### 2026-10-14 — Detailed tactics: player preferences, batting order, bowling phases, per-player approach, home pitch
- **Player preferences (derived on the templates, `src/players.js`)**:
  every one of the 409 templates now carries `prefBatPos` (1–11, from
  role + batting rating: top-order stars 1–3, middle order 3–6,
  finishers/lower order and tail-end bowlers 7–11), `prefOvers`
  (bowlers/all-rounders only: strike bowlers get powerplay+death,
  others middle-phase mixes) and a default `approach`
  (aggressive/balanced/defensive from batting rating). Deterministic
  per player; shown on the player page, the squad panel and as a
  "Pref #N · PP/Mid/Death" line in the squad table. (Derived in
  players.js like the runtime ratings — no schema/seed change.)
- **Manager tactics (per membership, `src/tactics.js` + the existing
  `POST /api/worlds/:id/xi`, same 30-minute tactical lock)**:
  `tactics.battingOrder` (the XI ordered 1–11), `tactics.bowlingPlan`
  ({playerId: {pp, mid, death}} overs per phase), `tactics.
  playerApproach` (per-XI-player approach) and `tactics.homePitch`.
  Server validation (`validateTactics`): order/plan/approach entries
  must belong to the effective XI; only eligible bowlers (role
  Bowler/All-Rounder or bowling ≥ 60) may be given overs; phase
  totals capped at powerplay 6 / middle 9 / death 5, per-bowler ≤ 4,
  innings ≤ 20. Partial plans are allowed — the engine bowls the rest
  with the best available bowlers. Only known tactics keys are merged.
- **Simulation (`src/matchEngine.js`)**: the sim now bats the XI in
  the manager's order (top scorers come from the top of the order),
  computes a bowling attack rating from the plan (overs-weighted,
  misuse-penalised; unset plans use a preference-aware auto-plan),
  and applies per-player approach (aggressive: stronger/faster but
  more wickets; defensive: the reverse). **Preference fit**: batting
  within ±1 of prefBatPos or ≥ half a bowler's overs in preferred
  phases = happy (+2 morale); 2–3 positions away or a minority of
  overs in preferred phases = mild misuse (−6 morale, −3 form,
  −3 effective rating); 4+ away / almost no preferred-phase overs =
  severe (−12/−10 morale, −6/−5 form, −6 rating); a first-choice
  bowler (top-4 eligible, bowling 78+) left completely unused in a
  set plan = −5 morale. Deltas are clamped (−12…+2 per match) and the
  scheduler persists them on worldPlayers in `applyResult`, next to
  the existing form/fitness drift. Results carry `tactics` misuse
  counts and `moraleEffects`; the match report gains a "Pitch: …"
  line and a per-team "Tactics report: …" line (which also flows into
  the news feed).
- **Home pitch**: `fixture.pitch` (per match) overrides the home
  manager's standing `tactics.homePitch` (default 'balanced').
  Routes: `POST /api/worlds/:id/pitch` (standing default) and
  `POST /api/worlds/:id/fixtures/:fid/pitch` (home manager only —
  403 for the away manager, 404 unknown fixture, 409 once played,
  423 after the tactical lock). Sim effect: batting pitch ×1.12 runs
  and −1 wicket, bowling pitch ×0.88 runs and +1.5 wickets. The
  fixtures API returns the effective pitch (+ `pitchSet` / `isHome`)
  and the Fixtures screen shows it, with an inline setter for the
  home manager before the lock.
- **AI managers**: `aiPickTeams` (now exported) also writes full
  tactics at season start — batting order by prefBatPos, a 20-over
  plan from the shared `buildAutoBowlingPlan`, each XI player's
  default approach, and a fixed per-club home pitch.
- **UI (Captain & Tactics screen, split from Squad)**: XI table plus
  three editors — batting-order list with ▲▼ steppers, a happy/
  prefers badge per player and a per-player approach select; bowling
  plan steppers per eligible bowler with live phase totals
  (PP x/6 · Mid x/9 · Death x/5 · total x/20); home-pitch select.
  Squad screen keeps XI + captaincy + team approach. Phone-usable:
  plain buttons/selects, no drag-and-drop.
- Tests: suite extended 26 → **32 tests, all passing** (`npm test`),
  `npm run check` clean (now also checks `src/tactics.js`). New:
  preferences exist and are sane on all 409 templates; engine unit
  tests (fabricated db) — a reversed order + Bumrah given only middle
  overs cuts team strength/attack, misuses more players and costs
  Bumrah −12 morale vs a sensible setup, and the same fixture scores
  more on a batting pitch than a bowling pitch; aiPickTeams produces
  a valid 20-over plan/order/approaches/pitch; API tests against
  pre-seeded servers (db.json with squads + a fixture written before
  boot) — happy-path save + persistence, 400s for powerplay overflow,
  a 5-over bowler, non-XI entries in plan/order, an ineligible
  bowler (bowling 42) and a bad approach value; pitch default +
  per-fixture override + away-manager 403 + unknown fixture 404; and
  the 30-minute lock rejecting both tactics saves and pitch changes
  with 423.
- Simplifications vs the original ask: bowling fit is judged on
  phase shares (not exact over numbers per spell), and fit is only
  judged on tactics the manager actually saved — with nothing saved
  the engine's defaults apply and nobody gains or loses morale,
  so new/casual managers are never punished for not micro-managing.

### 2026-10-14 — World Mode 2: draft squad mode + transfer market
- **Squad mode at creation**: `POST /api/worlds` accepts `squadMode`
  — `'auction'` (default; behaviour byte-for-byte unchanged) or
  `'draft'`. Stored on the world, exposed in every world payload
  (`pubWorld`), shown as a ⚖️ Draft tag in the Lobby, and selectable
  in the create-world form ("Auction — empty squads, bid for players"
  / "Draft — squads distributed equally, then trade"). Waiting Room
  rules text is mode-aware.
- **Draft start path** (`startWorld()` and the scheduler's scheduled
  RECRUITING→start transition both branch on `squadMode`): draft
  worlds SKIP `openAuctions` and go straight to `SQUAD_BUILDING`;
  season timing is untouched. `distributeDraft()` (src/scheduler.js)
  deals every club exactly **20 players** from the 409 templates:
  the pool is rating-sorted with a seeded shuffle inside equal-rating
  groups (seeded by world id + createdAt, so worlds differ), dealt
  quota-first — ≥2 wicket-keepers, ≥6 bowling options (Bowler/
  All-Rounder), ≥7 batting-capable (Batsman/AR/WK) per club — always
  to the club that needs the category most (then the lowest total
  rating), filled to 20 rating-first, and finished with a same-role
  swap repair pass that pulls club TOTAL ratings inside tolerance
  (same-role swaps preserve every quota). Assigned players are
  worldPlayers rows with `ownerMembershipId` set and status `OWNED`
  at no cost — budgets stay ₹100 Cr; unassigned templates stay in the
  central market; AI-filled clubs are distributed identically.
  Emits a `SQUADS_DISTRIBUTED` event + "Squads distributed" news.
  **Measured balance** (unit test, deterministic): 2 clubs — totals
  min 1787 / max 1788 (mean 1787.5); 4 clubs — min 1752 / max 1756
  (mean 1753.5); 10 clubs — min 1595 / max 1610 (mean 1602.0) —
  spreads of 0.06% / 0.23% / 0.94%, all far inside the ~2% target.
- **Transfer market** (new `src/offers.js`; offers live in the new
  `db.offers` collection, back-filled for old saves by `normalize`).
  Available in BOTH modes once squads exist. Routes:
  `POST /api/worlds/:id/offers` (member-only; target must be owned by
  the target club — own player 400; swap player must be the caller's;
  fee/bonus ≥ 0; duplicate PENDING offer for the same player 409),
  `GET /api/worlds/:id/offers` (offers involving the caller, player
  and club names resolved, plus every club's squad list for the form),
  `POST /api/offers/:id/accept` (seller only), `.../reject` (seller),
  `.../withdraw` (buyer). An offer carries fee + optional bonus,
  optional player swap and an optional captaincy promise
  (`captain`/`vice_captain`), and expires after 72h. **Acceptance
  re-validates everything** — buyer funds ≥ fee+bonus, both squads
  stay within 18–25 after the exchange, ownership unchanged — and
  only then applies atomically: budgets move, ownership swaps, the
  promise points the buyer's captain/vice-captain at the incoming
  player, and departed players are scrubbed from the old club's XI,
  tactics and captaincy. Events, notifications and a
  "TRANSFER COMPLETED" news item are written. The scheduler tick
  expires stale PENDING offers.
- **AI managers in the market** (tick-driven, bounded): an AI seller
  auto-accepts iff fee+bonus ≥ 1.15× the target's base value AND its
  squad stays ≥19 after AND (no swap, or the incoming swap player is
  rated at most 2 below the outgoing one); otherwise it auto-rejects.
  AI buyers make at most one offer per world per tick — for the
  highest-rated player filling the AI's weakest role, at 1.1× base
  value, no swap.
- **UI**: new "Transfers & Offers" screen (Manage section): create-
  offer form (target club → their players → fee/bonus/swap/promise),
  Incoming list with Accept/Reject, Outgoing list with Withdraw,
  status chips and expiry times; plus a "Make Offer" button on the
  player detail page when the player is owned by another club in
  your world, jumping to the form prefilled with that club + player.
  The player detail API now also returns `ownerMembershipId`.
- Tests: suite extended 32 → **38 tests, all passing** (`npm test`),
  `npm run check` clean (now also checks `src/offers.js`). New:
  draft distribution unit test (20/club, quotas, totals within 2%,
  budgets 100, event + news) at 2/4/10 clubs; draft-world API test
  (squadMode exposed, start → SQUAD_BUILDING, zero auctions, squads
  of 20, budgets 100); offer API test (own player 400, duplicate 409,
  non-seller accept 403, accept happy path — budgets 100→94/106,
  ownership, captain promise — reject and withdraw statuses, list
  directions); unit tests for accept re-validation (buyer funds
  dropped → 409, nothing moves, offer stays PENDING), squad bounds
  (seller at 18 / buyer at 25 blocked, swap at the bounds accepted),
  and the AI rules (1.2× accepted, 1.0× rejected, weak-swap rejected,
  AI buyer picks its weakest role at 1.1× base, ≤1 offer per tick).
- Simplifications vs the original ask: the bonus is a flat amount
  paid together with the fee at acceptance (not appearance- or
  performance-based); the draft's "snake draft by tiers" is realised
  as need-first dealing over rating tiers plus the balance repair
  pass (measured spreads above show it lands far inside tolerance);
  unassigned pool players in draft mode simply remain in the central
  market (no auctions exist to sell them through).
