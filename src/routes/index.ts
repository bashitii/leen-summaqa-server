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

export const api = Router();
api.get('/health', (_req, res) => res.json({ ok: true }));
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
