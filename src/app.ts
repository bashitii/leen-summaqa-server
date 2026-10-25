// Express app = a pipeline of middleware. Order matters: security first, routes, then error handler last.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config';
import { api } from './routes';
import { seoRouter } from './routes/seo';
import { errorHandler, notFound } from './middleware/error';

export const app = express();
app.set('trust proxy', 1);                                  // behind a host's proxy: use the real client IP for rate limits
app.use(helmet());                                          // secure HTTP headers
app.use(cors({ origin: env.CLIENT_URL }));                  // only OUR frontend may call the API from a browser
app.use(express.json({ limit: '100kb' }));                  // cap body size
// Global limiter, plus a much stricter one on login/register (slows password guessing).
app.use('/api', rateLimit({ windowMs: 60_000, limit: env.RATE_LIMIT_PER_MINUTE, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: env.AUTH_RATE_LIMIT_PER_15_MIN, standardHeaders: true, legacyHeaders: false }));
app.use('/api', api);
app.use(seoRouter);                                        // /sitemap.xml
app.use(notFound);
app.use(errorHandler);
