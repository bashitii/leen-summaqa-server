// THE PAYMENT CONTRACT. The rest of the app only ever talks to this interface, never to a specific bank.
// The real gateway is ONE class that implements it (hyperpay.ts); the dev-only fake is mock.ts.
import type { Request } from 'express';
import { HttpError } from '../middleware/error';

export interface PayAddress { street: string; city: string; state: string; postcode: string; country: string; givenName: string; surname: string }
// amount/currency = what the customer saw (order currency). jodAmount = the same order converted to JOD (HyperPay's account charges JOD only).
export interface PaymentRequest { orderId: string; orderNumber: number; amount: number; currency: string; jodAmount: number; email: string; returnUrl: string; address: PayAddress }
export interface Verified { status: 'PAID' | 'FAILED' | 'PENDING'; amount: number; currency: string; paymentId?: string; merchantTransactionId?: string; raw?: unknown }
export interface CallbackResult { eventId: string; providerRef: string; status: 'PAID' | 'FAILED'; amount: number; payload: unknown }

export interface PaymentProvider {
  readonly name: string;
  /** Start a payment for an order. Returns where to send the customer + the gateway's reference for this attempt. */
  createPayment(o: PaymentRequest): Promise<{ redirectUrl: string; providerRef: string }>;
  /** Ask the gateway server-to-server what really happened (never trust the browser's "success" page). */
  verifyPayment(providerRef: string): Promise<Verified>;
  /** The amount the gateway must report for this order (HyperPay: the JOD equivalent; mock: the order total). Used to reject tampered/short payments. */
  expectedAmount(o: { total: number; fxRate: number }): number;
  /** Parse AND authenticate (signature check) a callback from the gateway. Must throw if it isn't genuine. */
  handleCallback(req: Request): Promise<CallbackResult>;
  refundPayment(providerRef: string, amount: number): Promise<void>;
}

// 501 = "not implemented": for gateway features we deliberately do not offer (e.g. the webhook).
export class NotConfiguredError extends HttpError {
  constructor(what: string) { super(501, `${what} is not available`); }
}
