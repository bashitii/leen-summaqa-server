import { Router } from 'express';
import { z } from 'zod';
import { anonClient, db } from '../supabase';
import { env } from '../config';
import { asyncHandler, HttpError, validate } from '../middleware/error';

export const authRouter = Router();

const register = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(72),                 // bcrypt (used by Supabase) caps at 72 bytes
  first_name: z.string().trim().min(1).max(60),
  last_name: z.string().trim().min(1).max(60),
  phone: z.string().trim().max(30).optional(),
});
// Supabase hashes the password. Our DB trigger then creates the users + customer_profiles rows.
authRouter.post('/register', validate(register), asyncHandler(async (req, res) => {
  const { email, password, ...meta } = req.body;
  const { data, error } = await anonClient().auth.signUp({ email, password, options: { data: meta } });
  if (error) throw new HttpError(400, error.message);
  res.status(201).json({ user: { id: data.user?.id, email }, session: data.session });
}));

const login = z.object({ email: z.string().email(), password: z.string().min(1).max(72) });
authRouter.post('/login', validate(login), asyncHandler(async (req, res) => {
  const { data, error } = await anonClient().auth.signInWithPassword(req.body);
  if (error || !data.session) throw new HttpError(401, 'Invalid email or password');  // same message either way
  const s = data.session;
  res.json({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at });
}));

authRouter.post('/refresh', validate(z.object({ refresh_token: z.string().min(10) })), asyncHandler(async (req, res) => {
  const { data, error } = await anonClient().auth.refreshSession(req.body);
  if (error || !data.session) throw new HttpError(401, 'Session expired');
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at });
}));
// Logout = the browser deletes its tokens (JWTs are stateless).

// FORGOT PASSWORD, step 1: Supabase emails a one-time link that opens /account/reset on our site.
// We always answer "ok", whether or not the email has an account, so nobody can use this to find out who is registered.
authRouter.post('/forgot', validate(z.object({ email: z.string().email().max(254) })), asyncHandler(async (req, res) => {
  try {
    const { error } = await anonClient().auth.resetPasswordForEmail(req.body.email, { redirectTo: `${env.CLIENT_URL.replace(/\/$/, '')}/account/reset` });
    if (error) console.error('password reset email failed:', error.message);
  } catch (e) { console.error('password reset email failed:', (e as Error).message); }
  res.json({ ok: true });
}));

// Step 2: the reset page sends the one-time token from the link plus the new password. Supabase verifies the token; we set the password.
authRouter.post('/reset', validate(z.object({ access_token: z.string().min(20).max(4000), password: z.string().min(10).max(72) })), asyncHandler(async (req, res) => {
  const { data, error } = await db.auth.getUser(req.body.access_token);
  if (error || !data.user) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one');
  const { error: e2 } = await db.auth.admin.updateUserById(data.user.id, { password: req.body.password });
  if (e2) throw new HttpError(400, e2.message);
  res.json({ ok: true });
}));
