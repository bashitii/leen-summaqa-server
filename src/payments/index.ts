import { env } from '../config';
import { HyperPayProvider } from './hyperpay';
import { MockProvider } from './mock';
import type { PaymentProvider } from './types';

// One place decides which gateway is live. Everything else calls getProvider().
const provider: PaymentProvider = env.PAYMENT_PROVIDER === 'hyperpay' ? new HyperPayProvider() : new MockProvider();
export const getProvider = () => provider;
