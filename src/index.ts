import { app } from './app';
import { env } from './config';
import { expireUnpaidOrders } from './payments/service';
import { syncRates } from './fxSync';

app.listen(env.PORT, () => console.log(`Leen Summaqa API on http://localhost:${env.PORT}  (payments: ${env.PAYMENT_PROVIDER})`));

// Housekeeping: every 5 minutes, cancel orders nobody paid for so their stock goes back on sale.
// Safe if several servers run it: cancelling is idempotent.
const sweep = () => expireUnpaidOrders().then((n) => n && console.log(`Expired ${n} unpaid order(s)`)).catch((e) => console.error('expire job failed', e));
sweep(); setInterval(sweep, 5 * 60_000).unref();

// Live exchange rates: refresh now and then every 6 hours (the rates API itself updates once a day).
const fx = () => syncRates().then((r) => console.log(r.error ? `rates refresh failed (keeping old rates): ${r.error}` : `Rates refreshed: ${r.updated.join(', ') || 'none'}${r.skipped.length ? ` | skipped: ${r.skipped.join(', ')}` : ''}`));
fx(); setInterval(fx, 6 * 60 * 60_000).unref();
