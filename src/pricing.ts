// CURRENCY RULES, in one place. All catalog / shipping / discount amounts are stored in JOD. For a customer paying in another
// currency we multiply by that currency's rate and round to its step. The browser has an identical copy (client/src/lib/convert.ts)
// and the database has the same rule in convert_price(), so the price you see is always the price you are charged.
// Integer arithmetic is used on purpose: floating-point numbers can be off by a hair exactly at .5, which would change a rounded price.
import { db } from './supabase';

export interface Currency { code: string; name: string; symbol: string; rate: number; decimals: number; round_step: number }
export const BASE = 'JOD';
export const FALLBACK: Currency = { code: BASE, name: 'Jordanian dinar', symbol: 'JOD', rate: 1, decimals: 3, round_step: 0.001 };

type Rule = Pick<Currency, 'rate' | 'round_step' | 'decimals'>;
export function convert(base: number, c: Rule): number {
  const baseMilli = Math.round(base * 1000), rateMicro = Math.round(c.rate * 1e6), stepMilli = Math.round(c.round_step * 1000);
  const units = Math.round((baseMilli * rateMicro) / (1e6 * stepMilli));            // exact: no floating-point drift
  return Number(((units * stepMilli) / 1000).toFixed(c.decimals));
}
/** `percent`% of an amount already in the customer's currency (mirrors round(subtotal * value / 100, decimals) in SQL). */
export function percentOff(amount: number, percent: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round((Math.round(amount * 1000) * Math.round(percent * 1000) * scale) / 1e8) / scale;
}

let cache: { at: number; list: Currency[] } | null = null;
export async function activeCurrencies(): Promise<Currency[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.list;       // rates rarely change: ask the database at most every 30 s
  const { data } = await db.from('currencies').select('code,name,symbol,rate,decimals,round_step').eq('is_active', true).order('sort_order');
  const list = (data ?? []).map((r) => ({ ...r, code: String(r.code).trim(), rate: Number(r.rate), decimals: Number(r.decimals), round_step: Number(r.round_step) }));
  cache = { at: Date.now(), list: list.length ? list : [FALLBACK] };
  return cache.list;
}
export const clearCurrencyCache = () => { cache = null; };
/** The currency if it exists AND is switched on, otherwise null. */
export async function getCurrency(code: string): Promise<Currency | null> { return (await activeCurrencies()).find((c) => c.code === code) ?? null; }
