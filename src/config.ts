// Reads + VALIDATES environment variables once at startup. If a secret is missing
// the server refuses to boot (fail fast) instead of failing mysteriously later.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().url(),
  SITE_URL: z.string().url().default('https://leensummaqa.com'),   // the public website address, used in sitemap.xml                 // the only origin allowed by CORS
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // 'mock' = development-only fake gateway. 'hyperpay' = the real gateway (HyperPay COPYandPAY, see payments/hyperpay.ts).
  PAYMENT_PROVIDER: z.enum(['mock', 'hyperpay']).default('mock'),
  // Email (all optional). Without BREVO_API_KEY, emails are only printed in the server console, so nothing breaks in development.
  BREVO_API_KEY: z.string().optional(),
  BREVO_API_URL: z.string().default('https://api.brevo.com/v3/smtp/email'),   // only changed by automated tests
  EMAIL_FROM: z.string().optional(),          // e.g. Leen Summaqa <orders@leensummaqa.com>
  ADMIN_NOTIFY_EMAIL: z.string().optional(),  // who is told about new orders and contact messages
  // Anti-abuse limits per visitor (IP). The defaults suit a live shop; raise them only for automated testing.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(20).default(120), AUTH_RATE_LIMIT_PER_15_MIN: z.coerce.number().int().min(5).default(20),
  UNPAID_ORDER_TTL_MINUTES: z.coerce.number().int().min(5).default(30),   // unpaid orders are cancelled after this, releasing their stock
  // Provided by HyperPay for your merchant account (test values first, live values later). Server-side only.
  HYPERPAY_BASE_URL: z.string().optional(), HYPERPAY_ENTITY_ID: z.string().optional(),
  HYPERPAY_ACCESS_TOKEN: z.string().optional(), HYPERPAY_WEBHOOK_KEY: z.string().optional(),
  // true on the TEST server only: adds HyperPay's testMode/3DS test parameters and sends whole-number amounts (xx.00), as the test server requires.
  HYPERPAY_TEST_MODE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  HYPERPAY_AMOUNT_DECIMALS: z.coerce.number().int().min(0).max(3).default(3),   // decimals sent to the LIVE server for JOD (confirm with HyperPay)
}).refine((e) => !(e.NODE_ENV === 'production' && e.PAYMENT_PROVIDER === 'mock'),
  { message: 'PAYMENT_PROVIDER=mock is not allowed in production', path: ['PAYMENT_PROVIDER'] })
  // HyperPay needs its three settings, or the server refuses to start (instead of failing at the first customer's payment).
  .refine((e) => e.PAYMENT_PROVIDER !== 'hyperpay' || !!(e.HYPERPAY_BASE_URL && e.HYPERPAY_ENTITY_ID && e.HYPERPAY_ACCESS_TOKEN),
    { message: 'PAYMENT_PROVIDER=hyperpay needs HYPERPAY_BASE_URL, HYPERPAY_ENTITY_ID and HYPERPAY_ACCESS_TOKEN', path: ['PAYMENT_PROVIDER'] })
  // Safety: test mode on the LIVE server would approve fake payments. Test mode is only allowed with a "test" server address.
  .refine((e) => !(e.PAYMENT_PROVIDER === 'hyperpay' && e.HYPERPAY_TEST_MODE && e.HYPERPAY_BASE_URL && !/test/i.test(e.HYPERPAY_BASE_URL)),
    { message: 'HYPERPAY_TEST_MODE must be false when HYPERPAY_BASE_URL is the live server', path: ['HYPERPAY_TEST_MODE'] });
export const env = schema.parse(process.env);
