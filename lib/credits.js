// Credit pack catalog. Single source of truth.
export const PACKS = {
  starter: { id: 'starter', label: 'Starter', priceCents: 2500,  credits: 250  },
  growth:  { id: 'growth',  label: 'Growth',  priceCents: 5000,  credits: 625  },
  pro:     { id: 'pro',     label: 'Pro',     priceCents: 10000, credits: 2000 }
};

export function getPack(id) {
  return PACKS[id] || null;
}
