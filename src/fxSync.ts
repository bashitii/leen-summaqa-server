// LIVE EXCHANGE RATES. Fetches today's rates for 1 JOD from a free API (no key needed) and saves them in the `currencies` table.
// Why save instead of converting on every page view? (1) the price a customer sees must be the price they are charged, so every
// order stores the exact rate it used (orders.fx_rate); (2) the database function that creates orders reads the same rate;
// (3) the site keeps working if the rates API is down: it just keeps the last good rate.
import { z } from 'zod';
import { db } from './supabase';
import { clearCurrencyCache } from './pricing';

const URL = 'https://open.er-api.com/v6/latest/JOD';   // updates once a day; fixed-rate pairs (USD/SAR/AED) come back stable
const MAX_JUMP = 0.25;                                  // safety: ignore a new rate that differs from the old one by more than 25% (bad data)

const payload = z.object({ result: z.literal('success'), rates: z.record(z.number()) });

/** Refreshes the rate of EVERY currency except the base (JOD). There are no hand-typed rates anywhere. Never throws: on any problem the old rates stay and a message is returned. */
export async function syncRates(): Promise<{ updated: string[]; skipped: string[]; error?: string }> {
  const out = { updated: [] as string[], skipped: [] as string[] };
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`rates API answered ${res.status}`);
    const { rates } = payload.parse(await res.json());
    const { data: rows, error } = await db.from('currencies').select('code,rate').neq('code', 'JOD');
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      const code = String(r.code).trim(), next = rates[code], old = Number(r.rate);
      if (!next || !Number.isFinite(next) || next <= 0) { out.skipped.push(`${code} (not in API)`); continue; }
      if (old > 0 && Math.abs(next - old) / old > MAX_JUMP) { out.skipped.push(`${code} (jump too big)`); continue; }
      const rounded = Math.round(next * 1e6) / 1e6;                       // the table keeps 6 decimals
      if (rounded !== old) await db.from('currencies').update({ rate: rounded, rate_updated_at: new Date().toISOString() }).eq('code', code);
      else await db.from('currencies').update({ rate_updated_at: new Date().toISOString() }).eq('code', code);   // checked today, unchanged
      out.updated.push(code);
    }
    clearCurrencyCache();
    return out;
  } catch (e) { return { ...out, error: (e as Error).message }; }
}
