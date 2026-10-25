// EMAIL SENDER. One function, sendMail(). It NEVER throws: a failed email must not break an order or a payment.
// With SMTP configured it sends for real; without it, the email is printed in the server console (handy while developing).
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config';

export interface Mail { to: string; subject: string; text: string; html: string }
export const emailEnabled = !!(env.SMTP_HOST && env.EMAIL_FROM);

let transport: Transporter | null = null;
export const __setTransport = (t: Transporter) => { transport = t; };   // used by tests only
const getTransport = () => transport ??= nodemailer.createTransport({
  host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 587, secure: Number(env.SMTP_PORT) === 465,   // 465 = TLS from the start, 587 = upgrade (STARTTLS)
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

export async function sendMail(m: Mail): Promise<boolean> {
  if (!m.to) return false;
  if (!emailEnabled && !transport) { console.log(`\n[email not configured] to: ${m.to}\nsubject: ${m.subject}\n${m.text}\n`); return false; }
  try { await getTransport().sendMail({ from: env.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html }); return true; }
  catch (e) { console.error('email failed:', m.subject, '->', m.to, (e as Error).message); return false; }
}
