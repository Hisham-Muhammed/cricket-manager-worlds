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
