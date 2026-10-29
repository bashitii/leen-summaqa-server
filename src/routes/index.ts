import { Router } from 'express';
import { authRouter } from './auth';
import { meRouter } from './me';
import { catalogRouter } from './catalog';
import { contentRouter } from './content';
import { adminRouter } from './admin';
import { cartRouter } from './cart';
import { checkoutRouter } from './checkout';
import { paymentsRouter } from './payments';
import { adminSalesRouter } from './adminSales';
import { adminContentRouter } from './adminContent';
import { env } from '../config';
import { HttpError } from '../middleware/error';

export const api = Router();
api.get('/health', (_req, res) => res.json({ ok: true }));
// The website asks this on load: true = show the "Back soon" page.
api.get('/maintenance', (_req, res) => res.json({ on: env.MAINTENANCE_MODE }));
// While closed, the server itself refuses to create orders or start payments (hiding the page alone would not stop someone calling the API).
// Reading orders and /payments/confirm stay open, so a payment already in progress can still finish.
api.use((req, _res, next) => {
  if (env.MAINTENANCE_MODE && req.method !== 'GET' && (req.path.startsWith('/checkout') || req.path === '/payments/start'))
    return next(new HttpError(503, 'The shop is temporarily closed. Please come back soon'));
  next();
});
api.use('/auth', authRouter);
api.use('/me', meRouter);
api.use('/', catalogRouter);       // /products, /collections, /search, /countries
api.use('/content', contentRouter);
api.use('/cart', cartRouter);
api.use('/checkout', checkoutRouter);
api.use('/payments', paymentsRouter);
api.use('/admin', adminRouter);
api.use('/admin', adminSalesRouter);
api.use('/admin', adminContentRouter);
