// Two kinds of Supabase clients:
//  - `db`        : SERVICE-ROLE key. Bypasses RLS. Used for all data access, AFTER our own
//                  middleware has checked who the caller is. Never leaves the server.
//  - `anonClient`: ANON key. Used only to sign users up/in (Supabase Auth does the password hashing).
import { createClient } from '@supabase/supabase-js';
import { env } from './config';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
// A fresh client per call so one user's session can never leak into another's.
export const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);
