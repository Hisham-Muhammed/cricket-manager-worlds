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
