// WHO GETS TOLD WHEN. Called from the payment, admin and contact code. Each function swallows its own errors.
import { db } from '../supabase';
import { env } from '../config';
import { sendMail } from './index';
import { adminContact, adminNewOrder, adminPaidButCancelled, orderConfirmation, orderShipped, OrderForEmail } from './templates';

const owner = () => (env.ADMIN_NOTIFY_EMAIL || '').trim();
async function loadOrder(id: string) {
  const { data } = await db.from('orders').select('*, order_items(*)').eq('id', id).maybeSingle();
  return data as (OrderForEmail & { status: string }) | null;
}

// Called ONLY the first time an order turns paid (mark_order_paid returns true once), so each order gets exactly one set of emails.
export async function notifyOrderPaid(orderId: string) {
  try {
    const o = await loadOrder(orderId); if (!o) return;
    if (o.status === 'CANCELLED') { if (owner()) await sendMail(adminPaidButCancelled(owner(), o)); return; }   // late payment: tell the owner to refund
    await sendMail(orderConfirmation(o));
    if (owner()) await sendMail(adminNewOrder(owner(), o));
  } catch (e) { console.error('notifyOrderPaid failed', (e as Error).message); }
}
export async function notifyOrderShipped(orderId: string) {
  try { const o = await loadOrder(orderId); if (o) await sendMail(orderShipped(o)); } catch (e) { console.error('notifyOrderShipped failed', (e as Error).message); }
}
export async function notifyContact(m: { name?: string; email: string; phone?: string; message: string }) {
  try { if (owner()) await sendMail(adminContact(owner(), m)); } catch (e) { console.error('notifyContact failed', (e as Error).message); }
}
