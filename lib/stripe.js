import Stripe from 'stripe';

let _stripe = null;
function get() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Missing env var: STRIPE_SECRET_KEY');
  }
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}

// Lazy proxy: throws a clear error on first use, not at module load.
export const stripe = new Proxy({}, {
  get(_, prop) {
    const inst = get();
    const v = inst[prop];
    return typeof v === 'function' ? v.bind(inst) : v;
  }
});
