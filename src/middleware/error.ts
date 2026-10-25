import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';

// Throw this anywhere; the error handler turns it into a clean JSON response.
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Express 4 doesn't catch rejected promises by itself — this wrapper forwards them to the error handler.
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

// Validates req.body/query against a zod schema and replaces it with the CLEANED value
// (unknown fields are stripped — this is what stops a client sending { role: 'ADMIN' }).
export const validate = <T extends ZodTypeAny>(schema: T, part: 'body' | 'query' = 'body'): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.safeParse(req[part]);
    if (!parsed.success) return next(parsed.error);
    (req as any)[part] = parsed.data as z.infer<T>;
    next();
  };

export const notFound: RequestHandler = (_req, res) => { res.status(404).json({ error: 'Not found' }); };

export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', details: err.flatten().fieldErrors });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);                                    // log details server-side only
  res.status(500).json({ error: 'Something went wrong' });  // never leak internals to the client
};
