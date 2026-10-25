// The wording and layout of every email. Plain-text and HTML versions are both sent (some phones show only text).
// Everything a customer typed (names, addresses, messages) goes through esc() so it can never inject HTML into an email.
import { env } from '../config';

export const CONTACT_EMAIL = 'mgmt@leensummaqa.com';
export interface OrderForEmail { id: string; order_number: number; email: string; currency: string; subtotal: number | string; shipping_total: number | string;
  discount_total: number | string; total: number | string; public_token: string; is_preorder: boolean; shipping_address: Record<string, string> | null;
  order_items: { product_name: string; variant_label: string | null; quantity: number; line_total: number | string }[] }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: number | string, c: string) => `${Number(n)} ${c}`;
const orderLink = (o: OrderForEmail) => `${env.CLIENT_URL.replace(/\/$/, '')}/checkout/complete?order=${o.id}&token=${o.public_token}`;
const addressLines = (a: OrderForEmail['shipping_address']) => a ? [a.recipient, a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(' '), a.country_code].filter(Boolean) as string[] : [];

function shell(bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:Helvetica,Arial,sans-serif;color:#111"><div style="max-width:560px;margin:0 auto;padding:32px 24px">
<div style="font:24px Georgia,serif;margin-bottom:28px">Leen Summaqa</div>${bodyHtml}
<p style="color:#7b7770;font-size:12px;margin-top:36px">Questions? Reply to this email or write to ${CONTACT_EMAIL}.</p></div></body></html>`;
}
function orderBlock(o: OrderForEmail) {
  const rows = o.order_items.map((i) => ({ name: `${i.product_name}${i.variant_label ? ` · ${i.variant_label}` : ''}`, qty: i.quantity, total: money(i.line_total, o.currency) }));
  const totals: [string, string][] = [['Subtotal', money(o.subtotal, o.currency)], ...(Number(o.discount_total) > 0 ? [['Discount', `– ${money(o.discount_total, o.currency)}`] as [string, string]] : []),
    ['Shipping', money(o.shipping_total, o.currency)], ['Total', money(o.total, o.currency)]];
  const text = [...rows.map((r) => `${r.name} × ${r.qty}   ${r.total}`), '', ...totals.map(([k, v]) => `${k}: ${v}`), '', 'Shipping to:', ...addressLines(o.shipping_address)].join('\n');
  const html = `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map((r) => `<tr><td style="padding:8px 0;border-bottom:1px solid #d9d5cd">${esc(r.name)} × ${r.qty}</td><td style="padding:8px 0;border-bottom:1px solid #d9d5cd;text-align:right">${esc(r.total)}</td></tr>`).join('')}
${totals.map(([k, v], i) => `<tr><td style="padding:6px 0;${i === totals.length - 1 ? 'font-weight:bold;' : ''}">${k}</td><td style="padding:6px 0;text-align:right;${i === totals.length - 1 ? 'font-weight:bold;' : ''}">${esc(v)}</td></tr>`).join('')}</table>
<p style="font-size:14px;margin-top:20px"><strong>Shipping to</strong><br>${addressLines(o.shipping_address).map(esc).join('<br>')}</p>`;
  return { text, html };
}

export const orderConfirmation = (o: OrderForEmail) => {
  const b = orderBlock(o), pre = o.is_preorder ? 'This order includes a pre-order: 2 weeks production + shipping time applies.' : '';
  return { to: o.email, subject: `Your Leen Summaqa order #${o.order_number}`,
    text: `Thank you for your order #${o.order_number}. We have received your payment.\n\n${b.text}\n\n${pre ? pre + '\n\n' : ''}View your order: ${orderLink(o)}`,
    html: shell(`<h1 style="font:28px Georgia,serif;margin:0 0 12px">Thank you</h1><p style="font-size:14px">Your order <strong>#${o.order_number}</strong> is confirmed and your payment has been received.</p>${b.html}
${pre ? `<p style="font-size:14px">${esc(pre)}</p>` : ''}<p style="margin-top:24px"><a href="${esc(orderLink(o))}" style="background:#111;color:#f4f2ee;padding:12px 20px;text-decoration:none;font-size:13px">View your order</a></p>`) };
};
export const orderShipped = (o: OrderForEmail) => ({ to: o.email, subject: `Your order #${o.order_number} is on its way`,
  text: `Good news: your order #${o.order_number} has been shipped.\n\n${orderBlock(o).text}\n\nView your order: ${orderLink(o)}`,
  html: shell(`<h1 style="font:28px Georgia,serif;margin:0 0 12px">On its way</h1><p style="font-size:14px">Your order <strong>#${o.order_number}</strong> has been shipped.</p>${orderBlock(o).html}
<p style="margin-top:24px"><a href="${esc(orderLink(o))}" style="background:#111;color:#f4f2ee;padding:12px 20px;text-decoration:none;font-size:13px">View your order</a></p>`) });

// ---- emails to the shop owner ----
export const adminNewOrder = (to: string, o: OrderForEmail) => ({ to, subject: `New order #${o.order_number}: ${money(o.total, o.currency)}`,
  text: `New PAID order #${o.order_number} from ${o.email}${o.is_preorder ? ' (includes pre-order)' : ''}.\n\n${orderBlock(o).text}\n\nOpen the admin to process it.`,
  html: shell(`<h1 style="font:26px Georgia,serif;margin:0 0 12px">New order #${o.order_number}</h1><p style="font-size:14px">${esc(o.email)}${o.is_preorder ? ' · includes a pre-order' : ''}</p>${orderBlock(o).html}`) });
export const adminPaidButCancelled = (to: string, o: OrderForEmail) => ({ to, subject: `ACTION NEEDED: payment received for cancelled order #${o.order_number}`,
  text: `A payment of ${money(o.total, o.currency)} arrived for order #${o.order_number}, which was already cancelled (its stock was released).\nPlease refund the customer (${o.email}) from the admin.`,
  html: shell(`<h1 style="font:26px Georgia,serif;margin:0 0 12px;color:#e0245e">Refund needed</h1><p style="font-size:14px">A payment of <strong>${esc(money(o.total, o.currency))}</strong> arrived for order <strong>#${o.order_number}</strong>, which was already cancelled.<br>Please refund the customer (${esc(o.email)}) from the admin.</p>`) });
export const adminContact = (to: string, m: { name?: string; email: string; phone?: string; message: string }) => ({ to, subject: `New message from ${m.name || m.email}`,
  text: `${m.name || 'No name'} <${m.email}>${m.phone ? ` · ${m.phone}` : ''}\n\n${m.message}\n\nIt is also saved in Admin > Messages.`,
  html: shell(`<h1 style="font:26px Georgia,serif;margin:0 0 12px">New message</h1><p style="font-size:14px">${esc(m.name || 'No name')} · ${esc(m.email)}${m.phone ? ` · ${esc(m.phone)}` : ''}</p><p style="font-size:14px;white-space:pre-line">${esc(m.message)}</p>`) });
