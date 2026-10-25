// EMAIL SENDER. One function, sendMail(). It NEVER throws: a failed email must not break an order or a payment.
// Emails go out through Brevo's web API (an HTTPS request on port 443). We do NOT use SMTP any more because free hosts such as Render block the SMTP ports.
// Without BREVO_API_KEY the email is printed in the server console instead (handy while developing).
import { env } from '../config';

export interface Mail { to: string; subject: string; text: string; html: string }
export const emailEnabled = !!(env.BREVO_API_KEY && env.EMAIL_FROM);

// EMAIL_FROM looks like  Leen Summaqa <orders@leensummaqa.com>  or just  orders@leensummaqa.com . Brevo wants name and address separately.
function parseSender(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: from.trim() };
}

export async function sendMail(m: Mail): Promise<boolean> {
  if (!m.to) return false;
  if (!emailEnabled) { console.log(`\n[email not configured] to: ${m.to}\nsubject: ${m.subject}\n${m.text}\n`); return false; }
  try {
    const res = await fetch(env.BREVO_API_URL, {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: parseSender(env.EMAIL_FROM!), to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text }),
      signal: AbortSignal.timeout(15_000),             // never let a slow mail service hang an order
    });
    if (!res.ok) { console.error('email failed:', m.subject, '->', m.to, `Brevo answered ${res.status}`, (await res.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('email failed:', m.subject, '->', m.to, (e as Error).message); return false; }
}
