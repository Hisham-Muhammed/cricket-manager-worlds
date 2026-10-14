'use strict';
/**
 * Supabase = the PRODUCTION database / auth backend for this project.
 *
 * Modes (DATABASE_MODE env):
 *   - "supabase" (or unset with SUPABASE_URL set): production target.
 *     Run supabase/schema.sql + supabase/seed.sql in your Supabase project.
 *     The server must use SUPABASE_SERVICE_ROLE_KEY (server-only, bypasses
 *     RLS after our own server-side validation) and Supabase Auth for users.
 *   - "local": local-dev fallback only — the JSON file store in src/db.js,
 *     so `npm install && npm start` works with zero external accounts.
 *
 * Migration status: step 1 (auth/managers) is DONE — in supabase mode
 * register/login/Google sign-in verify identity with Supabase Auth and
 * the game profile lives in public.managers (see src/server.js). The
 * remaining routes still run on the store interface in src/db.js,
 * whose collections map 1:1 to the Supabase tables (see README mapping);
 * in supabase mode that store is durable — src/db.js mirrors the whole
 * state to the single-row public.app_state table on every save and
 * loads it on boot, so restarts/redeploys no longer wipe worlds.
 * To switch a route to Supabase, use getServiceClient() below and the
 * place_bid() Postgres function for atomic bidding; the scheduler must run
 * with the service-role client so auction settlement / match simulation
 * are never blocked by RLS.
 *
 * SECURITY: SUPABASE_SERVICE_ROLE_KEY is a secret. Never put it in the
 * browser, in public/ files, or in a Git commit. SUPABASE_ANON_KEY is the
 * only key a client may see, and it is constrained by RLS policies.
 */
let cached = null;
function mode() {
  if (process.env.DATABASE_MODE) return process.env.DATABASE_MODE;
  return process.env.SUPABASE_URL ? 'supabase' : 'local';
}
function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
function getServiceClient() {
  if (!isConfigured()) return null;
  if (cached) return cached;
  let createClient;
  try { ({ createClient } = require('@supabase/supabase-js')); }
  catch { console.warn('[supabase] @supabase/supabase-js not installed — run npm install. Falling back to local store.'); return null; }
  cached = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } });
  return cached;
}
function getAnonClient() {
  // Fresh client per call on purpose: a sign-in stores its session on the
  // client object, and concurrent logins must never share one. The app's
  // own JWT cookie stays the session — Supabase only verifies identity.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  let createClient;
  try { ({ createClient } = require('@supabase/supabase-js')); }
  catch { return null; }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } });
}
module.exports = { mode, isConfigured, getServiceClient, getAnonClient };
