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
- Next: repository upload, then Supabase migration step 1
  (auth/managers routes).
