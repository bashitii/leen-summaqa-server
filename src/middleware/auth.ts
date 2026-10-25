// AUTHENTICATION = "who are you?"  AUTHORIZATION = "are you allowed?"
// Flow: browser sends `Authorization: Bearer <JWT>` -> we ask Supabase to verify it ->
// we load the user's ROLE from OUR database (never trust a role sent by the browser).
import { NextFunction, Request, Response } from 'express';
import { db } from '../supabase';
import { HttpError } from './error';

export interface AuthUser { id: string; email: string; role: 'CUSTOMER' | 'ADMIN' }
declare global { namespace Express { interface Request { user?: AuthUser } } }

async function resolveUser(req: Request): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const { data, error } = await db.auth.getUser(header.slice(7));   // Supabase verifies signature + expiry
  if (error || !data.user) return null;
  const { data: row } = await db.from('users').select('id,email,role').eq('id', data.user.id).single();
  return row as AuthUser | null;
}

// Must be logged in.
export const requireAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try { const u = await resolveUser(req); if (!u) throw new HttpError(401, 'Please sign in'); req.user = u; next(); }
  catch (e) { next(e); }
};
// Must be logged in AND be an admin. Enforced on the server for every /api/admin route.
export const requireAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const u = await resolveUser(req);
    if (!u) throw new HttpError(401, 'Please sign in');
    if (u.role !== 'ADMIN') throw new HttpError(403, 'Admins only');
    req.user = u; next();
  } catch (e) { next(e); }
};
// Logged in is optional (guest checkout later).
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try { req.user = (await resolveUser(req)) ?? undefined; next(); } catch (e) { next(e); }
};
