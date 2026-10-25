-- LIVE EXCHANGE RATES. The server refreshes every non-JOD rate from a free rates API (server/src/fxSync.ts); nobody types rates.
-- rate_updated_at = when the rate was last checked (shown in Admin).
alter table currencies add column if not exists rate_updated_at timestamptz;
-- (An earlier draft also added an `auto_rate` column. The code no longer uses it; it is harmless and can be dropped any time.)
alter table currencies add column if not exists auto_rate boolean not null default true;
