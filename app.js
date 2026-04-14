// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// GoElev8.ai Portal — vanilla JS SPA
// State + router + views.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
};

const state = {
  token: localStorage.getItem('ge8_token') || null,
  user: null,
  client: null,
  isAdmin: false,
  impersonating: localStorage.getItem('ge8_impersonate') || null,
  view: 'overview',
  // Non-null when the authed client (or impersonated client) has an active
  // booking_calendars row. Drives whether the Bookings tab appears in the
  // sidebar and feeds the booking link widget on the Bookings view.
  bookingCalendar: null
};

function toast(msg, isError = false) {
  const t = el('div', { class: 'toast' + (isError ? ' err' : '') }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (state.isAdmin && state.impersonating) headers['x-admin-as-client'] = state.impersonating;
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
  });
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function logout() {
  localStorage.removeItem('ge8_token');
  localStorage.removeItem('ge8_impersonate');
  state.token = null; state.user = null; state.client = null;
  state.isAdmin = false; state.impersonating = null;
  render();
}

function setImpersonation(clientId) {
  if (clientId) {
    state.impersonating = clientId;
    localStorage.setItem('ge8_impersonate', clientId);
  } else {
    state.impersonating = null;
    localStorage.removeItem('ge8_impersonate');
  }
  state.client = null;
  state.view = 'overview';
}

// ============================================================
// LOGIN VIEW
// ============================================================
function renderLogin() {
  const box = el('div', { class: 'box' });
  const errBox = el('div');
  const emailInput = el('input', { type: 'email', placeholder: 'you@example.com', required: true });
  const pwInput = el('input', { type: 'password', placeholder: '••••••••', required: true });

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.innerHTML = '';
      try {
        const r = await api('/api/auth?action=login', {
          method: 'POST',
          body: { email: emailInput.value, password: pwInput.value }
        });
        localStorage.setItem('ge8_token', r.access_token);
        state.token = r.access_token;
        await loadMe();
        if (typeof gtag === 'function') gtag('event', 'client_login', { client_name: state.client?.name || '' });
        render();
      } catch (err) {
        errBox.innerHTML = `<div class="err">${err.message || 'Login failed'}</div>`;
      }
    }
  },
    el('div', { class: 'login-brand' },
      el('div', { class: 'logo' }, el('img', { src: '/logo.png', alt: '' })),
      el('div', {},
        el('h1', {}, 'Welcome back'),
        el('p', { style: 'margin:2px 0 0' }, 'Sign in to GoElev8.AI')
      )
    ),
    errBox,
    el('div', { class: 'field' }, el('label', {}, 'Email'), emailInput),
    el('div', { class: 'field' }, el('label', {}, 'Password'), pwInput),
    el('button', { class: 'btn', type: 'submit' }, 'Sign in →'),
    el('div', { class: 'footer' }, 'Powered by GoElev8 AI Infrastructure')
  );
  box.appendChild(form);
  return el('div', { class: 'login' }, box);
}

async function loadMe() {
  const r = await api('/api/portal/me');
  state.user = r.user;
  state.client = r.client;
  state.isAdmin = !!r.isAdmin;
  // Public Supabase config used by the Messages tab realtime channel.
  // Anon key is safe in the browser; RLS still enforces tenant isolation.
  state.supabaseConfig = r.supabase || null;

  // Fetch booking calendar for the current client context (if any). Used to
  // gate the Bookings tab and to render the link widget. Silent-fail so a
  // client without a calendar, or an admin not impersonating, just hides
  // the tab instead of breaking login.
  state.bookingCalendar = null;
  if (state.client || state.impersonating) {
    try {
      const cal = await api('/api/portal/bookings/calendar');
      state.bookingCalendar = cal?.calendar || null;
    } catch { /* no_calendar_for_client or no_client_assigned — hide tab */ }
  }
}

// ============================================================
// SHELL
// ============================================================
const TAB_LABELS = {
  overview:  'Overview',
  activity:  'Activity',
  messages:  'Messages',
  contacts:  'Contacts',
  leads:     'Leads',
  calls:     'Voice Calls',
  bookings:  'Bookings',
  billing:   'Credits & Billing',
  connect:   'Payments (Connect)',
  settings:  'Settings',
  blasts:    'SMS Blasts',
  nudges:    'Nudges',
  analytics: 'Analytics',
  admin:     'Master Admin',
  booking_admin: 'book.goelev8.ai'
};

const TAB_ICONS = {
  overview:  '📊',
  activity:  '🔔',
  messages:  '💬',
  contacts:  '📇',
  leads:     '👥',
  calls:     '📞',
  bookings:  '📅',
  billing:   '💳',
  connect:   '💰',
  settings:  '⚙️',
  blasts:    '📣',
  nudges:    '⚡',
  analytics: '📈',
  admin:     '🛡️',
  booking_admin: '🗓️'
};

const DEFAULT_TABS = ['overview','leads','messages','settings'];
const ADMIN_TABS = ['admin','booking_admin','activity','analytics'];

function shell(content) {
  const navBtn = (id, label) =>
    el('button', { class: state.view === id ? 'active' : '', onclick: () => { state.view = id; render(); } }, label);

  const adminSection = state.isAdmin && state.impersonating
    ? el('div', { class: 'admin-section' },
        el('button', { class: 'btn-stop-impersonate', onclick: () => { setImpersonation(null); render(); } },
          '× Stop impersonating')
      )
    : null;

  const banner = state.isAdmin && state.impersonating
    ? el('div', { class: 'impersonation-banner' },
        el('span', {}, 'Viewing as '),
        el('strong', {}, state.client?.name || '…'),
        el('button', { class: 'link', onclick: () => { setImpersonation(null); render(); } }, 'Exit'))
    : null;

  const isGlobalAdmin = state.user?.email === 'ab@goelev8.ai';
  // Insert Analytics before Settings so the two are side-by-side with
  // Settings last. If there's no Settings tab, append Analytics to the end.
  const withAnalytics = (baseTabs) => {
    const t = [...baseTabs];
    const settingsIdx = t.indexOf('settings');
    if (settingsIdx >= 0) t.splice(settingsIdx, 0, 'analytics');
    else t.push('analytics');
    return t;
  };
  // Insert Bookings when the current client has an active booking_calendars
  // row. Placed right before Settings/Analytics so it sits next to the other
  // tail tabs. No-op (returns input) if the client has no calendar, or if
  // bookings is already in the list.
  const withBookings = (baseTabs) => {
    if (!state.bookingCalendar) return baseTabs;
    if (baseTabs.includes('bookings')) return baseTabs;
    const t = [...baseTabs];
    const anchorIdx = t.indexOf('settings');
    const insertAt = anchorIdx >= 0 ? anchorIdx : t.length;
    t.splice(insertAt, 0, 'bookings');
    return t;
  };

  let tabs;
  if (state.isAdmin && !state.impersonating) {
    // Admin view — no client selected
    tabs = ADMIN_TABS;
  } else if (state.client?.portal_tabs) {
    // Client has custom tabs
    tabs = isGlobalAdmin ? withAnalytics(state.client.portal_tabs) : state.client.portal_tabs;
    tabs = withBookings(tabs);
  } else {
    // Default client tabs
    tabs = isGlobalAdmin ? withAnalytics(DEFAULT_TABS) : DEFAULT_TABS;
    tabs = withBookings(tabs);
  }
  const navButtons = tabs.map(id => navBtn(id, TAB_LABELS[id] || id));

  const logoSrc = state.client?.logo_url || '/logo.png';
  const brandName = state.client?.portal_tabs ? (state.client.name || 'Client Portal') : 'GoElev8.AI';

  // Bottom nav buttons for mobile
  const bottomNav = (state.client || state.isAdmin)
    ? el('nav', { class: 'bottom-nav' },
        ...tabs.map(id => {
          const label = TAB_LABELS[id] || id;
          const icon = TAB_ICONS[id] || '•';
          return el('button', {
            class: 'bnav-btn' + (state.view === id ? ' active' : ''),
            onclick: () => { state.view = id; render(); }
          }, el('span', { class: 'bnav-icon' }, icon), label);
        })
      )
    : null;

  // iOS install banner
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const installBanner = (isIOS && !isStandalone && !sessionStorage.getItem('pwa_dismissed'))
    ? el('div', { class: 'install-banner' },
        el('span', {}, 'Tap ', el('strong', {}, '⎙ Share'), ' then ', el('strong', {}, 'Add to Home Screen')),
        el('button', { class: 'btn', onclick: () => { sessionStorage.setItem('pwa_dismissed', '1'); render(); } }, '✕')
      )
    : null;

  const toggleNav = () => document.body.classList.toggle('nav-open');
  const closeNav = () => document.body.classList.remove('nav-open');

  // If we're showing a client's custom logo (not the default GoElev8 mark),
  // tag it with .client-logo so the CSS gives it a black background
  // instead of the default brand gradient.
  const isClientLogo = !!state.client?.logo_url;
  const logoClass = isClientLogo ? 'logo client-logo' : 'logo';

  // Mobile header (hamburger + brand)
  const mobileHeader = el('div', { class: 'mobile-header' },
    el('button', { class: 'nav-toggle', onclick: toggleNav },
      el('span'), el('span'), el('span')
    ),
    el('div', { class: 'mobile-brand' },
      el('div', { class: logoClass }, el('img', { src: logoSrc, alt: '' })),
      brandName
    )
  );

  // Backdrop behind slide-in nav drawer
  const navBackdrop = el('div', { class: 'nav-backdrop', onclick: closeNav });

  // Global footer (every page)
  const portalFooter = el('div', { class: 'portal-footer' },
    el('img', { src: '/logo.png', alt: 'GoElev8.AI' }),
    el('span', {}, 'Powered by GoElev8.AI')
  );

  return el('div', { class: 'app has-bottom-nav' + (state.isAdmin ? ' is-admin' : '') },
    el('aside', { class: 'sidebar' },
      el('div', { class: 'brand' },
        el('div', { class: logoClass }, el('img', { src: logoSrc, alt: '' })),
        el('div', { class: 'name' }, brandName,
          el('small', {}, state.isAdmin ? 'Master Admin' : 'Client Portal'))
      ),
      state.client
        ? el('div', { class: 'client-pill' },
            el('div', { class: 'name' }, state.client?.name || ''),
            el('div', { class: 'num' }, state.client?.twilio_phone_number || 'No number assigned')
          )
        : null,
      (state.client || state.isAdmin)
        ? el('div', { class: 'nav' }, ...navButtons)
        : null,
      adminSection,
      el('button', { class: 'signout', onclick: () => { closeNav(); logout(); } }, 'Sign out')
    ),
    navBackdrop,
    el('main', { class: 'main' }, mobileHeader, banner, content, portalFooter),
    bottomNav,
    installBanner
  );
}

// ============================================================
// OVERVIEW
// ============================================================
async function viewOverview() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Overview')));

  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  const lowBalance = (state.client?.credit_balance ?? 0) < 50;
  cards.appendChild(card('SMS Credits', state.client?.credit_balance ?? '—',
    lowBalance ? 'Low — top up soon' : 'Available to send', lowBalance ? 'warn' : 'accent'));

  try {
    const [b, c, bk, ld, vc] = await Promise.all([
      api('/api/portal/billing'),
      api('/api/portal/crm?action=contacts'),
      api('/api/portal/crm?action=bookings'),
      api('/api/portal/crm?action=leads').catch(() => ({ leads: [] })),
      api('/api/portal/crm?action=vapi_calls').catch(() => ({ vapi_calls: [] }))
    ]);
    cards.appendChild(card('Sent This Month', b.sent_this_month, 'Outbound SMS'));
    cards.appendChild(card('Contacts', c.contacts.length, 'Total in CRM'));
    const newLeads7d = (ld.leads || []).filter(l =>
      Date.now() - new Date(l.created_at).getTime() < 7 * 86400e3
    ).length;
    cards.appendChild(card('Leads', ld.leads?.length ?? 0,
      newLeads7d ? `${newLeads7d} new in last 7d` : 'All time'));
    const callsThisMonth = (vc.vapi_calls || []).filter(v => {
      const d = new Date(v.created_at);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    cards.appendChild(card('Voice Calls', callsThisMonth, 'This month'));
    cards.appendChild(card('Bookings', bk.bookings.length, 'Scheduled'));
  } catch (e) {}

  // Quick top-up panel
  const tu = el('div', { class: 'panel' });
  tu.appendChild(el('h2', {}, 'Buy SMS credits'));
  tu.appendChild(el('p', { class: 'muted' }, 'Pick a pack — credits are added instantly after payment.'));
  const packsRow = el('div', { class: 'cards' });
  const PACKS = [
    { id: 'starter', label: 'Starter', price: '$25', credits: 250, rate: '$0.10/SMS' },
    { id: 'growth',  label: 'Growth',  price: '$50', credits: 625, rate: '$0.08/SMS' },
    { id: 'pro',     label: 'Pro',     price: '$100', credits: 2000, rate: '$0.05/SMS' }
  ];
  for (const p of PACKS) {
    const btn = el('button', { class: 'btn',
      onclick: async () => {
        try {
          const r = await api('/api/portal/credits?action=checkout', { method: 'POST', body: { pack: p.id } });
          window.location.href = r.url;
        } catch (e) { toast(e.message, true); }
      }}, `Buy ${p.label} →`);
    const c = el('div', { class: 'pack-card' + (p.id === 'growth' ? ' featured' : '') },
      el('div', { class: 'pack-label' }, p.label),
      el('div', { class: 'pack-price' }, p.price),
      el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`),
      el('div', { class: 'pack-rate' }, p.rate),
      btn
    );
    packsRow.appendChild(c);
  }
  tu.appendChild(packsRow);
  wrap.appendChild(tu);
  return wrap;
}

function card(label, value, sub, cls = '') {
  return el('div', { class: 'card ' + cls },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, String(value)),
    sub ? el('div', { class: 'sub' }, sub) : null
  );
}

// ============================================================
// CONTACTS
// ============================================================
async function viewContacts() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Contacts'),
    el('button', { class: 'btn', onclick: () => openContactModal() }, '+ Add contact')
  ));

  const panel = el('div', { class: 'panel' });
  wrap.appendChild(panel);
  panel.appendChild(el('p', { class: 'muted' }, 'Loading...'));

  try {
    const r = await api('/api/portal/crm?action=contacts');
    panel.innerHTML = '';
    if (!r.contacts.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No contacts yet. Add your first one above.'));
      return wrap;
    }
    const tbl = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Phone'), el('th', {}, 'Email'),
        el('th', {}, 'Tags'), el('th', {}, 'Status'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.contacts.map(c =>
        el('tr', {},
          el('td', {}, c.name),
          el('td', {}, c.phone),
          el('td', {}, c.email || '—'),
          el('td', {}, (c.tags || []).join(', ') || '—'),
          el('td', {}, c.opted_out ? el('span', { class: 'badge red' }, 'Opted out') : el('span', { class: 'badge green' }, 'Active')),
          el('td', {},
            el('button', { class: 'btn sm', onclick: () => { state.view = 'messages'; state.activeContactId = c.id; render(); } }, 'Message'),
            ' ',
            el('button', { class: 'btn sm danger', onclick: async () => {
              if (!confirm('Delete contact?')) return;
              await api('/api/portal/crm?action=contacts', { method: 'DELETE', body: { id: c.id } });
              render();
            }}, 'Delete')
          )
        )
      ))
    );
    panel.appendChild(tbl);
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

function openContactModal(initial = null) {
  const name = el('input', { value: initial?.name || '' });
  const phone = el('input', { value: initial?.phone || '', placeholder: '+15551234567' });
  const email = el('input', { value: initial?.email || '' });
  const tags = el('input', { value: (initial?.tags || []).join(', '), placeholder: 'lead, vip' });
  const notes = el('textarea', {}, initial?.notes || '');

  const close = () => bg.remove();
  const save = async () => {
    try {
      const body = {
        name: name.value, phone: phone.value, email: email.value || null,
        tags: tags.value.split(',').map(s => s.trim()).filter(Boolean),
        notes: notes.value || null
      };
      await api('/api/portal/crm?action=contacts', { method: 'POST', body });
      close(); render();
    } catch (e) { toast(e.message, true); }
  };
  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'New contact'),
    el('div', { class: 'field' }, el('label', {}, 'Name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Phone (E.164)'), phone),
    el('div', { class: 'field' }, el('label', {}, 'Email'), email),
    el('div', { class: 'field' }, el('label', {}, 'Tags (comma separated)'), tags),
    el('div', { class: 'field' }, el('label', {}, 'Notes'), notes),
    el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
      el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      el('button', { class: 'btn', onclick: save }, 'Save')
    )
  );
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
}

// ============================================================
// BOOKINGS — full management UI for the per-tenant booking platform.
// Three sub-tabs: Appointments / Availability / Services. Sub-tab state
// is kept local to the view closure so switching doesn't rebuild the
// whole page. Data comes from /api/portal/bookings/* which are
// tenant-scoped via ctx.clientId (admin impersonation also works).
// ============================================================
const DAYS_OF_WEEK = [
  { dow: 1, label: 'Monday'    },
  { dow: 2, label: 'Tuesday'   },
  { dow: 3, label: 'Wednesday' },
  { dow: 4, label: 'Thursday'  },
  { dow: 5, label: 'Friday'    },
  { dow: 6, label: 'Saturday'  },
  { dow: 0, label: 'Sunday'    }
];

// Status label → CSS class on the global .badge system.
const STATUS_BADGE_CLASS = {
  pending:   'badge warn',
  confirmed: 'badge green',
  cancelled: 'badge',
  no_show:   'badge red'
};

async function viewBookings() {
  if (typeof gtag === 'function') gtag('event', 'booking_viewed', { client_name: state.client?.name || '' });

  const cal = state.bookingCalendar;
  if (!cal) {
    // Tab was somehow selected without a calendar (e.g. deep-link after the
    // calendar was just disabled). Show a clear message instead of crashing.
    return el('div', {},
      el('div', { class: 'topbar' }, el('h1', {}, 'Bookings')),
      el('div', { class: 'panel' },
        el('p', { class: 'muted' }, 'Booking calendar is not configured for this account.')
      )
    );
  }

  // ----- Booking link widget -----
  const bookingUrl = () => cal.custom_domain || ('book.goelev8.ai/' + cal.slug);
  const fullUrl = () => {
    const u = bookingUrl();
    return /^https?:\/\//.test(u) ? u : ('https://' + u);
  };

  const copyBtn = el('button', {
    class: 'btn sm',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(fullUrl());
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      } catch { toast('Copy failed', true); }
    }
  }, 'Copy Link');

  const linkWidget = el('div', {
    class: 'panel',
    style: 'background: linear-gradient(135deg, rgba(45,156,219,0.1), rgba(45,156,219,0.02)); border: 1px solid rgba(45,156,219,0.3)'
  },
    el('div', { class: 'field-label' }, 'YOUR BOOKING LINK'),
    el('div', { class: 'row', style: 'gap: 16px; flex-wrap: wrap; align-items: center' },
      el('div', {
        class: 'mono',
        style: 'flex: 1; min-width: 200px; font-size: 14px; color: #93c5fd; word-break: break-all'
      }, bookingUrl()),
      el('div', { class: 'row', style: 'gap: 8px; flex-wrap: wrap' },
        copyBtn,
        el('button', {
          class: 'btn sm ghost',
          onclick: () => { window.open(fullUrl(), '_blank', 'noopener'); }
        }, 'Open in new tab')
      )
    )
  );

  // ----- Sub-tab state + container -----
  let subTab = 'appointments';
  const subTabBar = el('div', { class: 'filter-bar' });
  const content = el('div', {});

  function renderSubTabBar() {
    const mk = (id, label) => el('button', {
      class: 'chip' + (subTab === id ? ' active' : ''),
      onclick: () => { if (subTab === id) return; subTab = id; renderAll(); }
    }, label);
    subTabBar.replaceChildren(
      mk('appointments', 'Appointments'),
      mk('availability', 'Availability'),
      mk('services',     'Services')
    );
  }

  function renderAll() {
    renderSubTabBar();
    content.replaceChildren();
    if (subTab === 'appointments') { renderAppointments(); renderGoelev8Bookings(); }
    else if (subTab === 'availability') renderAvailability();
    else renderServices();
  }


  // ----- book.goelev8.ai bookings (goelev8_bookings table) -----
  async function renderGoelev8Bookings() {
    const panel = el('div', { class: 'panel' });
    panel.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px' },
      el('h2', { style: 'margin:0' }, 'book.goelev8.ai Bookings'),
      el('div', { class: 'muted', style: 'font-size:11px' }, 'From your AI booking page')));
    panel.appendChild(el('p', { class: 'muted' }, 'Loading…'));
    content.appendChild(panel);
    try {
      const r = await api('/api/portal/goelev8-bookings');
      while (panel.childNodes.length > 1) panel.removeChild(panel.lastChild);
      if (!r.tenant) {
        panel.appendChild(el('p', { class: 'muted' }, 'No book.goelev8.ai page linked to this account.'));
        return;
      }
      const bkUrl = r.tenant.custom_domain ? 'https://' + r.tenant.custom_domain : 'https://book.goelev8.ai/' + r.tenant.slug;
      panel.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:16px;font-size:13px' },
        el('code', { style: 'color:#93c5fd' }, r.tenant.custom_domain || ('book.goelev8.ai/' + r.tenant.slug)),
        el('button', { class: 'btn sm ghost', onclick: () => window.open(bkUrl, '_blank') }, 'Open')));
      if (!r.bookings.length) {
        panel.appendChild(el('p', { class: 'muted' }, 'No bookings yet from this page.'));
        return;
      }
      panel.appendChild(el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Client'), el('th', {}, 'Phone'), el('th', {}, 'Service'),
          el('th', {}, 'Date'), el('th', {}, 'Time'), el('th', {}, 'Status'), el('th', {}, 'Booked At'))),
        el('tbody', {}, ...r.bookings.map(b =>
          el('tr', {},
            el('td', {}, el('strong', {}, b.client_name || '—')),
            el('td', { class: 'mono' }, b.client_phone || '—'),
            el('td', {}, b.service || '—'),
            el('td', { class: 'mono' }, b.booking_date || '—'),
            el('td', { class: 'mono' }, b.booking_time || '—'),
            el('td', {}, el('span', { class: 'badge' + (b.status === 'confirmed' ? ' green' : b.status === 'cancelled' ? ' red' : '') }, b.status || '—')),
            el('td', { class: 'muted' }, new Date(b.created_at).toLocaleString()))))));
    } catch (e) {
      while (panel.childNodes.length > 1) panel.removeChild(panel.lastChild);
      panel.appendChild(el('p', { class: 'err' }, 'Failed to load: ' + e.message));
    }
  }

  // ----- Appointments sub-view -----
  let apptFilter = 'upcoming';

  async function renderAppointments() {
    const filterBar = el('div', { class: 'filter-bar' });
    const listPanel = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Loading…'));
    content.appendChild(filterBar);
    content.appendChild(listPanel);

    const mkFilter = (id, label) => el('button', {
      class: 'chip' + (apptFilter === id ? ' active' : ''),
      onclick: () => { if (apptFilter === id) return; apptFilter = id; renderAppointments_reload(); }
    }, label);
    filterBar.replaceChildren(
      mkFilter('upcoming',  'Upcoming'),
      mkFilter('all',       'All'),
      mkFilter('past',      'Past'),
      mkFilter('cancelled', 'Cancelled')
    );

    async function renderAppointments_reload() {
      // Rebuild the filter bar so the active chip updates.
      filterBar.replaceChildren(
        mkFilter('upcoming',  'Upcoming'),
        mkFilter('all',       'All'),
        mkFilter('past',      'Past'),
        mkFilter('cancelled', 'Cancelled')
      );
      listPanel.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      let rows;
      try {
        const r = await api('/api/portal/bookings/appointments?filter=' + encodeURIComponent(apptFilter));
        rows = r.appointments || [];
      } catch (e) {
        listPanel.replaceChildren(el('p', { class: 'err' }, 'Failed to load appointments: ' + e.message));
        return;
      }
      if (!rows.length) {
        listPanel.replaceChildren(el('p', { class: 'muted' }, 'No appointments yet. Share your booking link to get started.'));
        return;
      }
      listPanel.replaceChildren(
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'When'),
            el('th', {}, 'Name'),
            el('th', {}, 'Service'),
            el('th', {}, 'Status'),
            el('th', {}, '')
          )),
          el('tbody', {}, ...rows.map(a => renderAppointmentRow(a, renderAppointments_reload)))
        )
      );
    }

    await renderAppointments_reload();
  }

  function renderAppointmentRow(a, reload) {
    const when = new Date(a.appointment_start);
    const whenStr = when.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    const contactStr = [a.lead_name, a.lead_phone].filter(Boolean).join(' · ') || '—';
    const badgeCls = STATUS_BADGE_CLASS[a.status] || 'badge';
    const statusText = (a.status || 'pending').replace('_', ' ');

    const actions = [];
    if (a.status !== 'confirmed' && a.status !== 'cancelled') {
      actions.push(el('button', {
        class: 'btn sm green',
        onclick: () => updateStatus(a.id, 'confirmed', reload)
      }, 'Confirm'));
    }
    if (a.status !== 'cancelled') {
      actions.push(el('button', {
        class: 'btn sm ghost',
        onclick: () => updateStatus(a.id, 'cancelled', reload)
      }, 'Cancel'));
    }
    if (a.status !== 'no_show' && a.status !== 'cancelled') {
      actions.push(el('button', {
        class: 'btn sm ghost',
        onclick: () => updateStatus(a.id, 'no_show', reload)
      }, 'No-show'));
    }

    return el('tr', {},
      el('td', {}, whenStr),
      el('td', {}, contactStr),
      el('td', {}, a.service_name || '—'),
      el('td', {}, el('span', { class: badgeCls }, statusText)),
      el('td', {}, el('div', { class: 'row', style: 'gap: 4px; flex-wrap: wrap; justify-content: flex-end' }, ...actions))
    );
  }

  async function updateStatus(id, status, reload) {
    try {
      const r = await api('/api/portal/bookings/appointments', {
        method: 'PATCH',
        body: { id, status }
      });
      // For cancellations the API delegates to the widget's /api/cancel
      // endpoint which sends the customer + Coach Kenny SMS. Surface
      // whether that succeeded so the operator knows if a manual call
      // is needed.
      let msg = 'Updated';
      if (status === 'cancelled') {
        msg = r?.sms_sent
          ? 'Cancelled — SMS sent to customer'
          : 'Cancelled — but SMS notification failed (check Vercel logs)';
      }
      toast(msg, status === 'cancelled' && !r?.sms_sent);
      await reload();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // The Availability and Services sub-tabs both write directly into the
  // tables that the public booking widget at book.theflexfacility.com
  // reads from (booking_services + availability_templates, set up in
  // migration 0018, consumed by flex-booking-calendar /api/services).
  // Edits here flow through to the live booking page within ~60s of save
  // (the widget endpoint has a 60s edge cache).
  const liveSyncNotice = () => el('div', {
    class: 'muted',
    style: 'font-size: 12px; margin-bottom: 12px'
  }, 'Changes save directly to the live booking page at ',
    el('span', { class: 'mono' }, cal.custom_domain || cal.slug),
    '.');

  // ----- Availability sub-view -----
  // The new schema has multiple slots per day per service, so the UI is
  // a service picker + per-day list of (start, end) pairs you can add or
  // remove individually. Switching services discards unsaved edits to the
  // previous service (with a confirm if there are pending changes).
  async function renderAvailability() {
    content.appendChild(liveSyncNotice());
    const panel = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Loading…'));
    content.appendChild(panel);

    let data;
    try {
      data = await api('/api/portal/bookings/availability');
    } catch (e) {
      panel.replaceChildren(el('p', { class: 'err' }, 'Failed to load availability: ' + e.message));
      return;
    }

    const services = (data.services || []).filter(s => s.is_active !== false);
    const tz = data.timezone || cal.timezone || '';

    if (!services.length) {
      panel.replaceChildren(
        el('p', { class: 'muted' }, 'No services yet. Add a service in the Services tab first, then come back here to set its availability.')
      );
      return;
    }

    // Local edit state — { dow: [{startInput, endInput, removeBtn, rowEl}, ...] }
    let activeServiceId = services[0].id;
    let dayRows = {}; // dow → array of slot row refs
    let dirty = false;

    const serviceSelect = el('select', {
      class: 'cta-select',
      style: 'flex: 1; min-width: 200px',
      onchange: (e) => {
        if (dirty && !confirm('You have unsaved changes. Switch services anyway?')) {
          e.target.value = activeServiceId;
          return;
        }
        activeServiceId = e.target.value;
        dirty = false;
        renderForActiveService();
      }
    },
      ...services.map(s => el('option', { value: s.id }, s.name))
    );

    const headerRow = el('div', { class: 'row', style: 'gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center' },
      el('div', { style: 'font-size: 13px; font-weight: 600; min-width: 80px' }, 'Service:'),
      serviceSelect,
      tz ? el('span', { class: 'muted', style: 'font-size: 12px' }, tz) : null
    );

    const dayContainer = el('div', {});
    const saveBtn = el('button', { class: 'btn', onclick: () => saveAvailability() }, 'Save changes');
    const footer = el('div', { class: 'row', style: 'justify-content: flex-end; margin-top: 16px' }, saveBtn);

    panel.replaceChildren(headerRow, dayContainer, footer);

    function renderForActiveService() {
      const svc = services.find(s => s.id === activeServiceId);
      if (!svc) return;
      // Group existing templates by day_of_week
      const byDow = {};
      for (const t of (svc.templates || [])) {
        if (!byDow[t.day_of_week]) byDow[t.day_of_week] = [];
        byDow[t.day_of_week].push(t);
      }
      dayRows = {};
      const dayBlocks = DAYS_OF_WEEK.map(d => {
        const slots = byDow[d.dow] || [];
        const slotsContainer = el('div', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 4px' });
        dayRows[d.dow] = [];
        slots.forEach(t => {
          slotsContainer.appendChild(makeSlotRow(d.dow, t.start_time.slice(0, 5), t.end_time.slice(0, 5), slotsContainer));
        });
        const addBtn = el('button', {
          class: 'btn sm ghost',
          style: 'align-self: flex-start; margin-top: 4px',
          onclick: () => {
            slotsContainer.appendChild(makeSlotRow(d.dow, '09:00', '10:00', slotsContainer));
            dirty = true;
          }
        }, '+ Add slot');
        return el('div', {
          style: 'padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.04)'
        },
          el('div', { class: 'row between', style: 'margin-bottom: 4px' },
            el('div', { style: 'font-weight: 600; font-size: 14px; min-width: 110px' }, d.label),
            addBtn
          ),
          slotsContainer
        );
      });
      dayContainer.replaceChildren(...dayBlocks);
    }

    function makeSlotRow(dow, startHHMM, endHHMM, container) {
      const startInput = el('input', { type: 'time', value: startHHMM, onchange: () => { dirty = true; } });
      const endInput   = el('input', { type: 'time', value: endHHMM,   onchange: () => { dirty = true; } });
      const removeBtn  = el('button', {
        class: 'btn sm ghost',
        title: 'Remove slot',
        onclick: () => {
          container.removeChild(slotEl);
          dayRows[dow] = dayRows[dow].filter(r => r.startInput !== startInput);
          dirty = true;
        }
      }, '×');
      const slotEl = el('div', {
        class: 'row',
        style: 'gap: 8px; align-items: center'
      },
        startInput,
        el('span', { class: 'muted', style: 'font-size: 12px' }, 'to'),
        endInput,
        removeBtn
      );
      dayRows[dow].push({ startInput, endInput });
      return slotEl;
    }

    async function saveAvailability() {
      // Collect all rows from the current edit state.
      const templates = [];
      for (const dowStr of Object.keys(dayRows)) {
        const dow = +dowStr;
        for (const r of dayRows[dow]) {
          const start = r.startInput.value;
          const end   = r.endInput.value;
          if (!start || !end) {
            toast('Every slot needs a start and end time', true);
            return;
          }
          if (end <= start) {
            toast('Slot end times must be after start times', true);
            return;
          }
          templates.push({ day_of_week: dow, start_time: start, end_time: end });
        }
      }
      saveBtn.disabled = true;
      try {
        const r = await api('/api/portal/bookings/availability', {
          method: 'PUT',
          body: { service_id: activeServiceId, templates }
        });
        // Refresh local cache so subsequent service-switches see saved state
        const svc = services.find(s => s.id === activeServiceId);
        if (svc) svc.templates = r.templates || [];
        dirty = false;
        toast('Availability saved · syncs to live booking page within 1 minute');
      } catch (e) {
        toast(e.message, true);
      } finally {
        saveBtn.disabled = false;
      }
    }

    renderForActiveService();
  }

  // ----- Services sub-view -----
  async function renderServices() {
    content.appendChild(liveSyncNotice());
    const header = el('div', { class: 'row between', style: 'margin-bottom: 12px' },
      el('div', { class: 'muted' }, 'Services leads can book on your page'),
      el('button', { class: 'btn sm', onclick: () => openServiceModal(null, renderServices_reload) }, '+ Add Service')
    );
    const listWrap = el('div', {});
    content.appendChild(header);
    content.appendChild(listWrap);

    async function renderServices_reload() {
      listWrap.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      let services;
      try {
        const r = await api('/api/portal/bookings/services');
        services = r.services || [];
      } catch (e) {
        listWrap.replaceChildren(el('p', { class: 'err' }, 'Failed to load services: ' + e.message));
        return;
      }
      if (!services.length) {
        listWrap.replaceChildren(el('p', { class: 'muted' }, 'No services yet. Click "+ Add Service" to create one.'));
        return;
      }
      listWrap.replaceChildren(...services.map(s => renderServiceRow(s, renderServices_reload)));
    }

    await renderServices_reload();
  }

  function renderServiceRow(s, reload) {
    const capStr  = s.max_per_slot != null ? (s.max_per_slot + ' per slot') : 'unlimited';
    const metaStr = s.full_name + ' · ' + capStr;

    const toggle = el('input', {
      type: 'checkbox',
      checked: !!s.is_active,
      onchange: async (e) => {
        try {
          await api('/api/portal/bookings/services', {
            method: 'PATCH',
            body: { id: s.id, is_active: e.target.checked }
          });
          row.style.opacity = e.target.checked ? '1' : '0.55';
          s.is_active = e.target.checked;
        } catch (err) {
          toast(err.message, true);
          e.target.checked = !e.target.checked;
        }
      }
    });

    const row = el('div', {
      class: 'panel',
      style: 'padding: 14px 16px; margin-bottom: 8px; cursor: pointer; display: flex; gap: 12px; align-items: center;'
            + (s.is_active ? '' : ' opacity: 0.55;'),
      onclick: (ev) => {
        if (ev.target.closest('input, button')) return;
        openServiceModal(s, reload);
      }
    },
      el('div', { style: 'flex: 1; min-width: 0' },
        el('div', { style: 'font-weight: 600; font-size: 14px' }, s.name),
        el('div', { class: 'muted', style: 'font-size: 12px; margin-top: 2px' }, metaStr)
      ),
      el('label', {
        class: 'toggle-row',
        style: 'padding: 0; margin: 0',
        title: s.is_active ? 'Active' : 'Inactive',
        onclick: (e) => e.stopPropagation()
      }, toggle),
      el('button', {
        class: 'btn sm ghost',
        onclick: (e) => { e.stopPropagation(); openServiceModal(s, reload); }
      }, 'Edit')
    );
    return row;
  }

  function openServiceModal(existing, reload) {
    const isEdit = !!existing;
    const nameIn      = el('input', { placeholder: 'Athlete Assessment',                  value: existing?.name      || '' });
    const fullNameIn  = el('input', { placeholder: 'Free Athlete Performance Assessment', value: existing?.full_name || '' });
    const btnTextIn   = el('input', { placeholder: 'CONFIRM SESSION',                      value: existing?.btn_text  || '' });
    const maxSlotIn   = el('input', { type: 'number', min: '1', step: '1', placeholder: 'unlimited', value: existing?.max_per_slot ?? '' });
    const infoTitleIn = el('input', { placeholder: 'ATHLETE ASSESSMENT SCHEDULE',          value: existing?.info_title || '' });
    const infoNoteIn  = el('textarea', { rows: 2, placeholder: 'Max 10 athletes per session…' });
    if (existing?.info_note) infoNoteIn.value = existing.info_note;
    const sortOrderIn = el('input', { type: 'number', min: '0', step: '1', value: existing?.sort_order ?? 0 });

    const close = () => bg.remove();
    const save = async () => {
      const name = nameIn.value.trim();
      if (!name) { toast('Name required', true); return; }
      const full_name = fullNameIn.value.trim() || name;
      const btn_text  = btnTextIn.value.trim();
      const info_title = infoTitleIn.value.trim();
      const info_note  = infoNoteIn.value.trim();
      const sort_order = parseInt(sortOrderIn.value, 10) || 0;
      const maxRaw = maxSlotIn.value.trim();
      const max_per_slot = maxRaw === '' ? null : parseInt(maxRaw, 10);
      if (max_per_slot != null && (!Number.isFinite(max_per_slot) || max_per_slot <= 0)) {
        toast('Capacity must be a positive number or blank', true);
        return;
      }

      const body = { name, full_name, btn_text, max_per_slot, info_title, info_note, sort_order };
      try {
        if (isEdit) {
          await api('/api/portal/bookings/services', {
            method: 'PATCH',
            body: { id: existing.id, ...body }
          });
          toast('Service updated · syncs to live booking page within 1 minute');
        } else {
          await api('/api/portal/bookings/services', {
            method: 'POST',
            body
          });
          toast('Service added · syncs to live booking page within 1 minute');
        }
        close();
        await reload();
      } catch (e) {
        toast(e.message, true);
      }
    };

    const modal = el('div', { class: 'modal' },
      el('h2', {}, isEdit ? 'Edit service' : 'New service'),
      el('div', { class: 'field' }, el('label', {}, 'Short name'), nameIn),
      el('div', { class: 'field' }, el('label', {}, 'Full name (shown on booking page)'), fullNameIn),
      el('div', { class: 'field' }, el('label', {}, 'Button text'), btnTextIn),
      el('div', { class: 'grid-2' },
        el('div', { class: 'field' }, el('label', {}, 'Max per slot (blank = unlimited)'), maxSlotIn),
        el('div', { class: 'field' }, el('label', {}, 'Sort order'), sortOrderIn)
      ),
      el('div', { class: 'field' }, el('label', {}, 'Info panel title'), infoTitleIn),
      el('div', { class: 'field' }, el('label', {}, 'Info panel note'), infoNoteIn),
      el('div', { class: 'row', style: 'justify-content: flex-end; gap: 8px; margin-top: 8px' },
        el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        el('button', { class: 'btn', onclick: save }, 'Save')
      )
    );
    const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
    document.body.appendChild(bg);
  }

  // ----- Assemble + initial render -----
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Bookings')));
  wrap.appendChild(linkWidget);
  wrap.appendChild(subTabBar);
  wrap.appendChild(content);
  renderAll();
  return wrap;
}

// ============================================================
// LEADS
// ============================================================
async function viewLeads() {
  if (typeof gtag === 'function') gtag('event', 'lead_viewed', { client_name: state.client?.name || '' });
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Leads'),
    el('div', { class: 'muted' }, 'Captured by Vapi voice agents and web forms')
  ));

  // --- Views vs Conversion metrics ---
  const metricsPanel = el('div', { class: 'leads-metrics' });
  wrap.appendChild(metricsPanel);
  loadLeadMetrics(metricsPanel);

  const panel = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(panel);
  try {
    const r = await api('/api/portal/crm?action=leads');
    panel.innerHTML = '';
    if (!r.leads.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No leads yet. They will appear here once a Vapi call ends or a form is submitted.'));
      return wrap;
    }
    panel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Name'), el('th', {}, 'Phone'),
        el('th', {}, 'Email'), el('th', {}, 'Source'), el('th', {}, 'Intent'),
        el('th', {}, 'Status'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.leads.map(l =>
        el('tr', {},
          el('td', {}, new Date(l.created_at).toLocaleString()),
          el('td', {}, l.name || '—'),
          el('td', {}, l.phone || '—'),
          el('td', {}, l.email || '—'),
          el('td', {}, el('span', { class: 'badge' }, l.source || 'manual')),
          el('td', {}, l.intent || '—'),
          el('td', {}, el('span', { class: 'badge' }, l.status || 'new')),
          el('td', {}, el('button', { class: 'btn sm danger', onclick: async () => {
            if (!confirm('Delete lead?')) return;
            try {
              await api('/api/portal/crm?action=leads', { method: 'DELETE', body: { id: l.id } });
              toast('Lead deleted');
              render();
            } catch (e) { toast('Delete failed: ' + e.message, true); }
          }}, 'Delete'))
        )
      ))
    ));
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

async function loadLeadMetrics(container) {
  try {
    const [ga, lr] = await Promise.all([
      api('/api/portal/ga4'),
      api('/api/portal/crm?action=leads')
    ]);
    const views = ga.page_views || ga.sessions || 0;
    const leads = (lr.leads || []).length;
    const rate = views > 0 ? ((leads / views) * 100).toFixed(1) : '0.0';

    container.innerHTML = '';
    container.appendChild(el('div', { class: 'leads-metrics-strip' },
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, String(views)),
        el('span', { class: 'metric-stat-label' }, 'Page Views (30d)')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, String(leads)),
        el('span', { class: 'metric-stat-label' }, 'Leads Captured')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat accent' },
        el('span', { class: 'metric-stat-value' }, `${rate}%`),
        el('span', { class: 'metric-stat-label' }, 'Conversion Rate')
      )
    ));
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'muted', style: 'padding:8px' }, 'Could not load conversion metrics.'));
  }
}

// ============================================================
// VOICE CALLS (Vapi)
// ============================================================
async function viewCalls() {
  if (typeof gtag === 'function') gtag('event', 'call_log_viewed', { client_name: state.client?.name || '' });
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Voice Calls'),
    el('div', { class: 'muted' }, 'Inbound & outbound AI voice calls handled by Vapi')
  ));
  const panel = el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(panel);
  try {
    const r = await api('/api/portal/crm?action=vapi_calls');
    panel.innerHTML = '';
    if (!r.vapi_calls.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No calls yet. Once your Vapi assistant runs, calls will land here in real time.'));
      return wrap;
    }
    const fmtDur = (s) => {
      if (!s && s !== 0) return '—';
      const m = Math.floor(s / 60), r = s % 60;
      return `${m}:${String(r).padStart(2, '0')}`;
    };
    const fmtCost = (c) => (c || c === 0) ? `$${(c / 100).toFixed(2)}` : '—';
    panel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Direction'), el('th', {}, 'From / To'),
        el('th', {}, 'Status'), el('th', {}, 'Duration'), el('th', {}, 'Cost'),
        el('th', {}, 'Summary'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.vapi_calls.map(v =>
        el('tr', {},
          el('td', {}, new Date(v.started_at || v.created_at).toLocaleString()),
          el('td', {}, el('span', { class: 'badge' }, v.direction || '—')),
          el('td', {}, v.customer_number || v.from_number || v.to_number || '—'),
          el('td', {}, el('span', { class: 'badge' }, v.status || '—')),
          el('td', {}, fmtDur(v.duration_seconds)),
          el('td', {}, fmtCost(v.cost_cents)),
          el('td', { style: 'max-width:340px' }, v.summary || '—'),
          el('td', {}, v.recording_url
            ? el('a', { class: 'btn sm', href: v.recording_url, target: '_blank' }, 'Recording')
            : '—')
        )
      ))
    ));
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

// ============================================================
// MESSAGES (SMS inbox + composer)
// ============================================================
//
// Full bidirectional thread view that mirrors a native SMS app:
//   • Threads are keyed by the OTHER party's phone number, so every
//     message — outbound nudges, welcome SMS, blasts, inbound replies —
//     ends up in the same thread regardless of whether a contact row
//     exists.
//   • Lead/contact lookup hydrates a friendly name on the header.
//   • Outbound bubbles render right-aligned, inbound left-aligned, with
//     a status badge on outbound (queued / sent / delivered / failed).
//   • Supabase Realtime subscribes to new messages.client_id=<id>
//     inserts and merges them in without a refetch.
//   • An "unread" indicator highlights any thread that received an
//     inbound message after we last viewed it (per-browser storage).
//   • Mobile: defaults to thread-list view; tapping a thread slides
//     full-width to the chat view; the back chevron returns to the list.
function normPhone(p) {
  if (!p) return '';
  return String(p).replace(/[^\d+]/g, '');
}

const UNREAD_LS_KEY = 'ge8_thread_lastseen';
function loadLastSeen() {
  try { return JSON.parse(localStorage.getItem(UNREAD_LS_KEY) || '{}'); }
  catch { return {}; }
}
function saveLastSeen(map) {
  try { localStorage.setItem(UNREAD_LS_KEY, JSON.stringify(map)); }
  catch {}
}
function markThreadSeen(phoneKey) {
  if (!phoneKey) return;
  const map = loadLastSeen();
  map[phoneKey] = Date.now();
  saveLastSeen(map);
}

async function openMessagesRealtime(onInsert) {
  // Lazy-load the Supabase JS client only when the Messages tab is
  // opened. The portal exposes the public URL + anon key on /api/portal/me;
  // RLS still enforces tenant isolation server-side.
  const cfg = state.supabaseConfig;
  if (!cfg?.url || !cfg?.anon_key) return null;
  let createClient;
  try {
    ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2'));
  } catch (e) {
    console.warn('[messages] supabase-js load failed, realtime disabled:', e.message);
    return null;
  }
  const sb = createClient(cfg.url, cfg.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} }
  });
  // Forward the portal user's JWT to the realtime websocket so RLS on
  // public.messages lets the channel see this client's rows. Without
  // this, postgres_changes runs as anon and the filter returns nothing.
  if (state.token) {
    try { sb.realtime.setAuth(state.token); } catch {}
  }
  const clientId = state.client?.id || state.impersonating;
  if (!clientId) return null;
  const channel = sb.channel(`messages:${clientId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `client_id=eq.${clientId}` },
      (payload) => {
        try { onInsert(payload.new); }
        catch (e) { console.warn('[messages] realtime handler error:', e.message); }
      })
    .subscribe();
  return channel;
}

async function viewMessages() {
  const wrap = el('div', { class: 'messages-tab' });
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Messages')));

  const layout = el('div', { class: 'chat-layout' });
  wrap.appendChild(layout);

  const list = el('div', { class: 'chat-list' });
  const pane = el('div', { class: 'chat-pane' });
  layout.appendChild(list);
  layout.appendChild(pane);

  // Start in thread-list view on mobile until the user picks a thread.
  // The .show-pane class flips to full-width chat view via CSS.
  if (state.activeThreadKey) layout.classList.add('show-pane');

  const [contactsR, msgsR, leadsR] = await Promise.all([
    api('/api/portal/crm?action=contacts'),
    api('/api/portal/messages'),
    api('/api/portal/leads?limit=500').catch(() => ({ leads: [] }))
  ]);
  const contacts = contactsR.contacts || [];
  const allMsgs  = (msgsR.messages || []).slice();
  const leads    = leadsR.leads || [];

  // ── Phone → contact / lead lookup tables ─────────────────────────
  const contactByPhone = {};
  for (const c of contacts) {
    const k = normPhone(c.phone);
    if (k) contactByPhone[k] = c;
  }
  const leadByPhone = {};
  const leadById = {};
  for (const l of leads) {
    if (l.id) leadById[l.id] = l;
    const k = normPhone(l.phone);
    if (k && !leadByPhone[k]) leadByPhone[k] = l;
  }
  const lastSeen = loadLastSeen();

  // Closure-mutable working set (so realtime can splice in new rows).
  let messages = allMsgs;
  let activeKey = state.activeThreadKey || null;

  function buildThreads() {
    const threads = {};
    for (const m of messages) {
      const otherRaw = m.direction === 'inbound' ? m.from_number : m.to_number;
      const phoneKey = normPhone(otherRaw);
      if (!phoneKey) continue;
      let t = threads[phoneKey];
      if (!t) {
        t = threads[phoneKey] = {
          phone: otherRaw,
          phoneKey,
          contact: contactByPhone[phoneKey] || null,
          lead: (m.lead_id && leadById[m.lead_id]) || leadByPhone[phoneKey] || null,
          messages: [],
          lastAt: 0,
          lastInboundAt: 0,
          outCount: 0,
          inCount: 0,
          segments: 0
        };
      }
      t.messages.push(m);
      const ts = new Date(m.created_at).getTime();
      if (ts > t.lastAt) t.lastAt = ts;
      if (m.direction === 'inbound') {
        t.inCount++;
        if (ts > t.lastInboundAt) t.lastInboundAt = ts;
      } else {
        t.outCount++;
      }
      t.segments += (m.segments || 0);
    }
    // Surface contacts with NO messages so users can start a thread.
    for (const c of contacts) {
      const k = normPhone(c.phone);
      if (!k || threads[k]) continue;
      threads[k] = {
        phone: c.phone, phoneKey: k, contact: c,
        lead: leadByPhone[k] || null,
        messages: [], lastAt: 0, lastInboundAt: 0,
        outCount: 0, inCount: 0, segments: 0
      };
    }
    return threads;
  }

  function threadDisplayName(t) {
    if (t.lead?.name) return t.lead.name;
    if (t.contact?.name) return t.contact.name;
    return t.phone || 'Unknown';
  }

  function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    let cls = 'msg-status';
    if (s === 'failed' || s === 'undelivered') cls += ' failed';
    else if (s === 'delivered' || s === 'read') cls += ' delivered';
    else if (s === 'sent' || s === 'sending' || s === 'queued') cls += ' sent';
    return el('span', { class: cls }, s || 'pending');
  }

  // Render: tear down list/pane and rebuild from current messages array.
  function rerender() {
    list.innerHTML = '';
    pane.innerHTML = '';
    const threads = buildThreads();
    const threadList = Object.values(threads).sort((a, b) => b.lastAt - a.lastAt);

    // Resolve active thread, with legacy state.activeContactId fallback.
    if (!activeKey && state.activeContactId) {
      const c = contacts.find(x => x.id === state.activeContactId);
      if (c) activeKey = normPhone(c.phone);
    }
    if (!activeKey && threadList[0]) activeKey = threadList[0].phoneKey;

    // Empty state.
    if (!threadList.length) {
      list.appendChild(el('div', { class: 'chat-empty-side' }, 'No threads yet.'));
      pane.appendChild(el('div', { class: 'chat-empty' },
        el('div', { class: 'chat-empty-title' }, 'No messages yet.'),
        el('div', { class: 'chat-empty-sub' }, 'Messages will appear here once leads enter your funnel.')
      ));
      return;
    }

    // Sidebar: thread rows.
    for (const t of threadList) {
      const last = t.messages.length
        ? t.messages.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b))
        : null;
      const label = threadDisplayName(t);
      const previewText = last?.body || t.phone || '';
      const lastTs = last ? new Date(last.created_at) : null;
      const previewTime = lastTs ? lastTs.toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const seenAt = lastSeen[t.phoneKey] || 0;
      const isUnread = t.lastInboundAt > seenAt && t.phoneKey !== activeKey;
      const item = el('div', {
        class: 'item' + (t.phoneKey === activeKey ? ' active' : '') + (isUnread ? ' unread' : ''),
        onclick: () => {
          activeKey = t.phoneKey;
          state.activeThreadKey = t.phoneKey;
          state.activeContactId = t.contact?.id || null;
          markThreadSeen(t.phoneKey);
          layout.classList.add('show-pane');
          rerender();
        }
      },
        isUnread ? el('span', { class: 'unread-dot', title: 'New message' }) : null,
        el('div', { class: 'item-main' },
          el('div', { class: 'name-row' },
            el('div', { class: 'name' }, label),
            previewTime ? el('div', { class: 'time' }, previewTime) : null
          ),
          el('div', { class: 'preview' }, previewText)
        )
      );
      list.appendChild(item);
    }

    // Active thread pane.
    const active = threads[activeKey];
    if (!active) {
      pane.appendChild(el('div', { class: 'chat-empty' },
        el('div', { class: 'chat-empty-title' }, 'Select a conversation to view the full thread.')
      ));
      return;
    }
    markThreadSeen(active.phoneKey);

    const headerLabel = threadDisplayName(active);
    const totalMsgs = active.messages.length;
    const totalCredits = active.outCount; // 1 credit per outbound send
    pane.appendChild(el('div', { class: 'chat-header' },
      el('button', {
        class: 'chat-back',
        onclick: () => {
          layout.classList.remove('show-pane');
          activeKey = null;
          state.activeThreadKey = null;
          state.activeContactId = null;
          rerender();
        }
      }, '←'),
      el('div', { class: 'chat-header-id' },
        el('strong', {}, headerLabel),
        active.phone && active.phone !== headerLabel
          ? el('span', { class: 'muted' }, active.phone)
          : null
      ),
      el('div', { class: 'chat-header-stats' },
        `${totalMsgs} msg${totalMsgs === 1 ? '' : 's'} · ${totalCredits} credit${totalCredits === 1 ? '' : 's'}`
      )
    ));

    const body = el('div', { class: 'chat-body' });
    const ordered = active.messages.slice().sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at));
    if (!ordered.length) {
      body.appendChild(el('div', { class: 'chat-thread-empty' }, 'No messages in this thread yet.'));
    }
    for (const m of ordered) {
      const ts = new Date(m.created_at).toLocaleString();
      const bubble = el('div', { class: 'bubble ' + (m.direction === 'inbound' ? 'in' : 'out') },
        el('div', { class: 'bubble-body' }, m.body),
        el('div', { class: 'ts' },
          ts,
          m.direction === 'outbound' ? el('span', { class: 'ts-spacer' }, ' · ') : null,
          m.direction === 'outbound' ? statusBadge(m.status) : null
        )
      );
      body.appendChild(bubble);
    }
    pane.appendChild(body);
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);

    // Composer.
    const ta = el('textarea', { placeholder: 'Type a message…' });
    const suggestionsRow = el('div', { class: 'suggestions' });
    const composer = el('div', { class: 'composer' },
      suggestionsRow,
      el('div', { class: 'composer-row' },
        ta,
        el('button', { class: 'btn ghost', onclick: async () => {
          if (!active.contact?.id) {
            toast('AI suggestions need a saved contact.', true);
            return;
          }
          suggestionsRow.innerHTML = '<span class="muted">Generating…</span>';
          try {
            const r = await api('/api/portal/ai-suggest', { method: 'POST', body: { contact_id: active.contact.id } });
            suggestionsRow.innerHTML = '';
            if (!r.suggestions?.length) {
              suggestionsRow.appendChild(el('span', { class: 'muted' }, 'No suggestions'));
            } else {
              for (const s of r.suggestions) {
                suggestionsRow.appendChild(el('button', { onclick: async () => {
                  ta.value = s; await send();
                }}, s));
              }
            }
          } catch (e) { suggestionsRow.innerHTML = ''; toast(e.message, true); }
        }}, '✨ AI suggest'),
        el('button', { class: 'btn', onclick: () => send() }, 'Send')
      )
    );
    pane.appendChild(composer);

    async function send() {
      const text = ta.value.trim();
      if (!text) return;
      try {
        const payload = active.contact?.id
          ? { contact_id: active.contact.id, body: text }
          : { to: active.phone, body: text };
        await api('/api/portal/messages', { method: 'POST', body: payload });
        ta.value = '';
        // Refetch the thread so the new outbound row + Twilio sid + status
        // appear immediately. Realtime will catch any inbound replies on
        // top of this without a manual refetch.
        const fresh = await api('/api/portal/messages');
        messages = fresh.messages || [];
        rerender();
      } catch (e) {
        if (e.message === 'insufficient_credits') toast('Out of credits — top up to send.', true);
        else toast(e.message, true);
      }
    }
  }

  rerender();

  // Realtime: merge inserts into the working set and re-render. We
  // dedupe by id so a refetch + realtime fire-back doesn't duplicate.
  openMessagesRealtime((row) => {
    if (!row || !row.id) return;
    if (messages.some(m => m.id === row.id)) return;
    messages = [row, ...messages];
    rerender();
  }).then((channel) => {
    state._messagesChannel = channel;
  });

  return wrap;
}

// ============================================================
// BILLING / CREDITS
// ============================================================
async function viewBilling() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Credits & Billing')));

  const b = await api('/api/portal/billing');

  const cards = el('div', { class: 'cards' });
  cards.appendChild(card('Credit Balance', b.credit_balance, 'SMS credits available', 'accent'));
  cards.appendChild(card('Sent This Month', b.sent_this_month, 'Outbound messages'));
  cards.appendChild(card('Auto-Reload', b.auto_reload.enabled ? 'ON' : 'OFF', `< ${b.auto_reload.threshold} → buy ${b.auto_reload.pack}`));
  wrap.appendChild(cards);

  // Top-up
  const tp = el('div', { class: 'panel' });
  tp.appendChild(el('h2', {}, 'Buy more credits'));
  const packsRow = el('div', { class: 'cards' });
  for (const p of Object.values(b.packs)) {
    packsRow.appendChild(el('div', { class: 'pack-card' + (p.id === 'growth' ? ' featured' : '') },
      el('div', { class: 'pack-label' }, p.label),
      el('div', { class: 'pack-price' }, '$' + (p.priceCents / 100)),
      el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`),
      el('button', { class: 'btn',
        onclick: async () => {
          try {
            const r = await api('/api/portal/credits?action=checkout', { method: 'POST', body: { pack: p.id } });
            window.location.href = r.url;
          } catch (e) { toast(e.message, true); }
        }}, `Buy ${p.label} →`)
    ));
  }
  tp.appendChild(packsRow);
  wrap.appendChild(tp);

  // Auto-reload settings
  const ar = el('div', { class: 'panel' });
  ar.appendChild(el('h2', {}, 'Auto-Reload Settings'));
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = b.auto_reload.enabled;
  const threshold = el('input', { type: 'number', value: b.auto_reload.threshold, min: 1 });
  const packSel = el('select', {},
    ...Object.values(b.packs).map(p => el('option', { value: p.id, selected: p.id === b.auto_reload.pack }, `${p.label} ($${p.priceCents/100} / ${p.credits} credits)`))
  );
  ar.appendChild(el('div', { class: 'row', style: 'gap:20px; margin-bottom:12px' },
    el('label', { style: 'display:flex; align-items:center; gap:8px; font-size:14px; color:var(--text)' }, enabled, 'Enable auto-reload'),
  ));
  ar.appendChild(el('div', { class: 'field' }, el('label', {}, 'Threshold (credits remaining)'), threshold));
  ar.appendChild(el('div', { class: 'field' }, el('label', {}, 'Pack to buy'), packSel));
  ar.appendChild(el('button', { class: 'btn', onclick: async () => {
    try {
      await api('/api/portal/credits?action=auto-reload', { method: 'POST', body: {
        enabled: enabled.checked,
        threshold: parseInt(threshold.value, 10),
        pack: packSel.value
      }});
      toast('Saved');
    } catch (e) { toast(e.message, true); }
  }}, 'Save settings'));
  wrap.appendChild(ar);

  // Ledger
  const led = el('div', { class: 'panel' });
  led.appendChild(el('h2', {}, 'Recent activity'));
  if (!b.ledger?.length) led.appendChild(el('p', { class: 'muted' }, 'No activity yet.'));
  else {
    led.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Type'), el('th', {}, 'Δ Credits'), el('th', {}, 'Amount')
      )),
      el('tbody', {}, ...b.ledger.map(r => el('tr', {},
        el('td', {}, new Date(r.created_at).toLocaleString()),
        el('td', {}, r.reason),
        el('td', {}, (r.delta > 0 ? '+' : '') + r.delta),
        el('td', {}, r.amount_cents ? '$' + (r.amount_cents/100).toFixed(2) : '—')
      )))
    ));
  }
  wrap.appendChild(led);

  return wrap;
}

// ============================================================
// CONNECT (Stripe Connect)
// ============================================================
async function viewConnect() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Accept Payments (Stripe Connect)')));

  const status = await api('/api/portal/connect?action=status');
  const panel = el('div', { class: 'panel' });

  if (!status.connected || !status.charges_enabled) {
    panel.appendChild(el('p', {}, 'Connect your Stripe account to start accepting payments from your customers. GoElev8 takes a 2.9% platform fee on each transaction.'));
    panel.appendChild(el('button', { class: 'btn', onclick: async () => {
      try {
        const r = await api('/api/portal/connect?action=start', { method: 'POST' });
        window.location.href = r.url;
      } catch (e) { toast(e.message, true); }
    }}, status.connected ? 'Continue Stripe onboarding' : 'Connect Stripe'));
  } else {
    panel.appendChild(el('p', {}, '✓ Stripe connected. You can now generate payment links for your customers.'));
    panel.appendChild(el('p', { class: 'muted' }, `Account: ${status.account_id}`));

    // Generate payment link form
    const amt = el('input', { type: 'number', placeholder: '50.00', step: '0.01' });
    const desc = el('input', { placeholder: 'What is this payment for?' });
    const email = el('input', { type: 'email', placeholder: 'customer@example.com' });
    const linkOut = el('div', { style: 'margin-top:10px' });
    panel.appendChild(el('h2', { style: 'margin-top:20px' }, 'Generate payment link'));
    panel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Amount (USD)'), amt));
    panel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Description'), desc));
    panel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Customer email (optional)'), email));
    panel.appendChild(el('button', { class: 'btn', onclick: async () => {
      try {
        const r = await api('/api/portal/connect?action=payment-link', { method: 'POST', body: {
          amount_cents: Math.round(parseFloat(amt.value) * 100),
          description: desc.value, customer_email: email.value || null
        }});
        linkOut.innerHTML = `<p class="muted">Platform fee: $${(r.application_fee_cents/100).toFixed(2)}</p><a href="${r.url}" target="_blank">${r.url}</a>`;
      } catch (e) { toast(e.message, true); }
    }}, 'Create link'));
    panel.appendChild(linkOut);
  }
  wrap.appendChild(panel);

  // Recent connect payments
  try {
    const b = await api('/api/portal/billing');
    if (b.connect_payments?.length) {
      const cp = el('div', { class: 'panel' });
      cp.appendChild(el('h2', {}, 'Recent payments'));
      cp.appendChild(el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'Customer'), el('th', {}, 'Amount'), el('th', {}, 'Platform fee'), el('th', {}, 'Status')
        )),
        el('tbody', {}, ...b.connect_payments.map(p => el('tr', {},
          el('td', {}, new Date(p.created_at).toLocaleString()),
          el('td', {}, p.customer_email || '—'),
          el('td', {}, '$' + (p.amount_cents/100).toFixed(2)),
          el('td', {}, '$' + (p.application_fee_cents/100).toFixed(2)),
          el('td', {}, p.status)
        )))
      ));
      wrap.appendChild(cp);
    }
  } catch {}
  return wrap;
}

// ============================================================
// SMS BLASTS
// ============================================================
async function viewBlasts() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'SMS Blasts'),
    el('div', { style: 'display:flex;gap:8px' },
      el('button', { class: 'btn', onclick: () => openContactImportModal(contactsBody) }, 'Import Contacts'),
      el('button', { class: 'btn primary', onclick: () => openBlastModal(wrap) }, '+ New Blast')
    )
  ));

  // --- Contacts list section ---
  const contactsPanel = el('div', { class: 'panel' });
  contactsPanel.appendChild(el('h2', {}, 'Contacts'));
  const contactsBody = el('div', {});
  contactsPanel.appendChild(contactsBody);
  wrap.appendChild(contactsPanel);
  loadBlastsContacts(contactsBody);

  // --- Past blasts section ---
  const table = el('div', { class: 'panel' });
  table.appendChild(el('h2', {}, 'Past Blasts'));
  const tbody = el('div', {});
  table.appendChild(tbody);
  wrap.appendChild(table);

  try {
    const data = await api('/api/portal/blasts');
    const blasts = data.blasts || [];
    if (!blasts.length) {
      tbody.appendChild(el('p', { class: 'muted' }, 'No blasts sent yet. Click "New Blast" to get started.'));
    } else {
      const tbl = el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Sent At'), el('th', {}, 'Name'), el('th', {}, 'Message'),
          el('th', {}, 'Recipients'), el('th', {}, 'Delivered'), el('th', {}, 'Failed'), el('th', {}, 'Status')
        )),
        el('tbody', {}, ...blasts.map(b => el('tr', {},
          el('td', {}, new Date(b.sent_at || b.created_at).toLocaleString()),
          el('td', {}, b.name || '—'),
          el('td', {}, (b.message || '').slice(0, 60) + ((b.message || '').length > 60 ? '…' : '')),
          el('td', {}, String(b.recipients ?? b.total_recipients ?? '—')),
          el('td', {}, String(b.delivered ?? b.delivered_count ?? '—')),
          el('td', {}, String(b.failed ?? b.failed_count ?? '—')),
          el('td', {}, b.status || 'pending')
        )))
      );
      tbody.appendChild(tbl);
    }
  } catch (e) {
    tbody.appendChild(el('p', { class: 'err' }, 'Failed to load blasts: ' + e.message));
  }
  return wrap;
}

async function loadBlastsContacts(container) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'muted' }, 'Loading contacts...'));
  try {
    const r = await api('/api/portal/crm?action=contacts');
    container.innerHTML = '';
    const contacts = r.contacts || [];
    if (!contacts.length) {
      container.appendChild(el('p', { class: 'muted' }, 'No contacts yet. Click "Import Contacts" to add from a file or spreadsheet.'));
      return;
    }
    container.appendChild(el('p', { class: 'muted', style: 'margin-bottom:8px' }, `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`));
    const tbl = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', {}, 'Phone'), el('th', {}, 'Email'),
        el('th', {}, 'Tags'), el('th', {}, 'Source'), el('th', {}, '')
      )),
      el('tbody', {}, ...contacts.map(c => el('tr', {},
        el('td', {}, c.name || '—'),
        el('td', {}, c.phone || '—'),
        el('td', {}, c.email || '—'),
        el('td', {}, (c.tags || []).join(', ') || '—'),
        el('td', {}, el('span', { class: 'badge' + (c.source === 'import' ? ' info' : '') }, c.source || 'manual')),
        el('td', {}, el('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm('Delete contact?')) return;
          try {
            await api('/api/portal/crm?action=contacts', { method: 'DELETE', body: { id: c.id } });
            toast('Contact deleted');
            loadBlastsContacts(container);
          } catch (e) { toast('Delete failed: ' + e.message, true); }
        } }, 'Delete'))
      )))
    );
    container.appendChild(tbl);
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'err' }, 'Failed to load contacts: ' + e.message));
  }
}

function openContactImportModal(contactsBody) {
  const existing = document.querySelector('.import-modal-bg');
  if (existing) existing.remove();

  let step = 1;
  let parsedRows = [];
  let headers = [];
  let mappings = {};
  const FIELD_OPTIONS = [
    { value: 'skip', label: 'Skip' },
    { value: 'name', label: 'Full Name' },
    { value: 'first_name', label: 'First Name' },
    { value: 'last_name', label: 'Last Name' },
    { value: 'phone', label: 'Phone' },
    { value: 'email', label: 'Email' },
    { value: 'tag', label: 'Tag' },
    { value: 'notes', label: 'Notes' }
  ];

  const GUESS_MAP = {
    phone: 'phone', mobile: 'phone', cell: 'phone', telephone: 'phone', 'phone number': 'phone', phone_number: 'phone', phonenumber: 'phone',
    first: 'first_name', 'first name': 'first_name', first_name: 'first_name', firstname: 'first_name', 'given name': 'first_name',
    last: 'last_name', 'last name': 'last_name', last_name: 'last_name', lastname: 'last_name', surname: 'last_name', 'family name': 'last_name',
    name: 'name', 'full name': 'name', fullname: 'name', 'contact name': 'name', 'client name': 'name', customer: 'name',
    email: 'email', 'e-mail': 'email', email_address: 'email', 'email address': 'email',
    tag: 'tag', tags: 'tag', group: 'tag', category: 'tag', segment: 'tag',
    notes: 'notes', note: 'notes', comment: 'notes', comments: 'notes', description: 'notes'
  };

  function guessMapping(header) {
    return GUESS_MAP[header.toLowerCase().trim()] || 'skip';
  }

  function parseInput(text) {
    const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: false });
    headers = result.meta.fields || [];
    parsedRows = result.data || [];
    mappings = {};
    headers.forEach(h => { mappings[h] = guessMapping(h); });
  }

  const content = el('div', {});
  const stepIndicator = el('div', { class: 'import-steps' });
  const footer = el('div', { class: 'import-footer' });

  function updateStepIndicator() {
    stepIndicator.innerHTML = '';
    ['Upload', 'Map Columns', 'Review & Import'].forEach((label, i) => {
      const n = i + 1;
      stepIndicator.appendChild(el('div', { class: 'import-step' + (n === step ? ' active' : '') + (n < step ? ' done' : '') },
        el('span', { class: 'import-step-num' }, n < step ? '\u2713' : String(n)),
        el('span', {}, label)
      ));
    });
  }

  // --- Step 1: Upload ---
  function renderStep1() {
    content.innerHTML = '';
    footer.innerHTML = '';

    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.tsv,.txt', style: 'display:none' });
    const pasteArea = el('textarea', { rows: '5', placeholder: 'Or paste rows here (tab or comma separated, first row = headers)...',
      style: 'width:100%;padding:10px;background:var(--bg-1,#0d1117);border:1px solid var(--border,#2a3a5c);border-radius:8px;color:var(--text,#e0e0e0);font-size:0.85rem;resize:vertical;margin-top:12px' });
    const statusMsg = el('div', { style: 'margin-top:8px;font-size:0.8rem;color:var(--muted,#888)' });

    const dropzone = el('div', { class: 'import-dropzone' },
      el('div', { style: 'font-size:2rem;margin-bottom:8px' }, '\uD83D\uDCC1'),
      el('div', {}, 'Drag & drop a file here'),
      el('div', { class: 'muted', style: 'font-size:0.8rem;margin:4px 0 12px' }, '.csv, .xlsx, .tsv, .txt'),
      el('button', { class: 'btn sm', onclick: () => fileInput.click() }, 'Browse Files'),
      fileInput
    );

    function handleFile(file) {
      statusMsg.textContent = `Reading ${file.name}...`;
      if (file.name.endsWith('.xlsx')) {
        statusMsg.textContent = 'XLSX files: please save as CSV first, then re-upload.';
        statusMsg.style.color = 'var(--warning,#f0ad4e)';
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        parseInput(e.target.result);
        if (!headers.length || !parsedRows.length) {
          statusMsg.textContent = 'Could not detect columns. Check your file format.';
          statusMsg.style.color = 'var(--danger,#e74c3c)';
          return;
        }
        statusMsg.textContent = `Detected ${headers.length} columns, ${parsedRows.length} rows.`;
        statusMsg.style.color = 'var(--success,#27ae60)';
        step = 2; renderCurrentStep();
      };
      reader.readAsText(file);
    }

    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

    const pasteBtn = el('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => {
      const text = pasteArea.value.trim();
      if (!text) { statusMsg.textContent = 'Paste some data first.'; statusMsg.style.color = 'var(--warning,#f0ad4e)'; return; }
      parseInput(text);
      if (!headers.length || !parsedRows.length) {
        statusMsg.textContent = 'Could not detect columns. Check your format.';
        statusMsg.style.color = 'var(--danger,#e74c3c)';
        return;
      }
      statusMsg.textContent = `Detected ${headers.length} columns, ${parsedRows.length} rows.`;
      statusMsg.style.color = 'var(--success,#27ae60)';
      step = 2; renderCurrentStep();
    } }, 'Parse Pasted Data');

    content.append(dropzone, pasteArea, pasteBtn, statusMsg);
    footer.appendChild(el('button', { class: 'btn', onclick: () => bg.remove() }, 'Cancel'));
  }

  // --- Step 2: Map Columns ---
  function renderStep2() {
    content.innerHTML = '';
    footer.innerHTML = '';

    const mappingErr = el('div', { style: 'color:var(--danger,#e74c3c);font-size:0.8rem;margin-top:8px' });

    const rows = headers.map(h => {
      const sel = el('select', {}, ...FIELD_OPTIONS.map(f =>
        el('option', { value: f.value, ...(mappings[h] === f.value ? { selected: 'selected' } : {}) }, f.label)
      ));
      sel.value = mappings[h] || 'skip';
      sel.addEventListener('change', () => { mappings[h] = sel.value; });
      const preview = parsedRows.slice(0, 3).map(r => r[h] || '').join(', ');
      return el('tr', {},
        el('td', { style: 'font-weight:600' }, h),
        el('td', {}, sel),
        el('td', { class: 'muted', style: 'font-size:0.8rem' }, preview || '—')
      );
    });

    const tbl = el('table', { class: 'import-map-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'File Column'), el('th', {}, 'Maps To'), el('th', {}, 'Preview')
      )),
      el('tbody', {}, ...rows)
    );

    content.append(
      el('p', { style: 'font-size:0.85rem;margin-bottom:12px;color:var(--muted,#888)' }, 'Map each file column to a contact field. Phone is required.'),
      tbl, mappingErr
    );

    footer.append(
      el('button', { class: 'btn', onclick: () => { step = 1; renderCurrentStep(); } }, 'Back'),
      el('button', { class: 'btn primary', onclick: () => {
        const vals = Object.values(mappings);
        if (!vals.includes('phone')) {
          mappingErr.textContent = 'You must map at least one column to Phone.';
          return;
        }
        step = 3; renderCurrentStep();
      } }, 'Next')
    );
  }

  // --- Step 3: Review & Import ---
  function renderStep3() {
    content.innerHTML = '';
    footer.innerHTML = '';

    let mapped = parsedRows.map((row, idx) => {
      const out = { _idx: idx };
      for (const h of headers) {
        const field = mappings[h];
        if (field && field !== 'skip') out[field] = (row[h] || '').trim();
      }
      return out;
    }).filter(r => r.phone);

    const countLabel = el('p', { style: 'font-size:0.85rem;margin-bottom:8px;color:var(--muted,#888)' },
      `${mapped.length} contacts ready to import (${parsedRows.length - mapped.length} skipped — missing phone).`
    );

    const listEl = el('div', { class: 'import-review-list' });
    function renderList() {
      listEl.innerHTML = '';
      mapped.forEach((r, i) => {
        const name = r.name || [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
        listEl.appendChild(el('div', { class: 'import-review-row' },
          el('span', { style: 'flex:1;min-width:0' },
            el('strong', {}, name), ' ',
            el('span', { class: 'muted' }, r.phone),
            r.email ? el('span', { class: 'muted' }, ` | ${r.email}`) : ''
          ),
          el('button', { class: 'btn sm danger', onclick: () => {
            mapped.splice(i, 1);
            countLabel.textContent = `${mapped.length} contacts ready to import.`;
            renderList();
          } }, '\u00D7')
        ));
      });
      if (!mapped.length) listEl.appendChild(el('p', { class: 'muted' }, 'No contacts to import.'));
    }
    renderList();

    const resultMsg = el('div', { style: 'margin-top:12px;font-size:0.85rem' });
    const importBtn = el('button', { class: 'btn primary', onclick: async () => {
      if (!mapped.length) return;
      importBtn.disabled = true; importBtn.textContent = 'Importing...';
      try {
        const payload = mapped.map(r => ({
          name: r.name || '', first_name: r.first_name || '', last_name: r.last_name || '',
          phone: r.phone, email: r.email || '', tag: r.tag || '', notes: r.notes || ''
        }));
        const res = await api('/api/portal/crm?action=contacts-import', { method: 'POST', body: { contacts: payload } });
        const errCount = (res.errors || []).length;
        resultMsg.style.color = errCount ? 'var(--warning,#f0ad4e)' : 'var(--success,#27ae60)';
        resultMsg.textContent = `Done! ${res.created || 0} contacts imported.` + (errCount ? ` ${errCount} batch error(s).` : '');
        toast(`${res.created || 0} contacts imported!`);
        if (contactsBody) loadBlastsContacts(contactsBody);
        setTimeout(() => bg.remove(), 1500);
      } catch (e) {
        resultMsg.textContent = 'Import failed: ' + e.message;
        resultMsg.style.color = 'var(--danger,#e74c3c)';
      } finally { importBtn.disabled = false; importBtn.textContent = 'Import Contacts'; }
    } }, 'Import Contacts');

    content.append(countLabel, listEl, resultMsg);
    footer.append(
      el('button', { class: 'btn', onclick: () => { step = 2; renderCurrentStep(); } }, 'Back'),
      importBtn
    );
  }

  function renderCurrentStep() {
    updateStepIndicator();
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else renderStep3();
  }

  const modal = el('div', { class: 'modal import-modal' },
    el('h2', {}, 'Import Contacts'),
    stepIndicator, content, footer
  );
  modal.style.maxWidth = '600px';

  const bg = el('div', { class: 'modal-bg import-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, modal);
  document.body.appendChild(bg);

  renderCurrentStep();
}

function openBlastModal(wrap) {
  const existing = document.querySelector('.blast-modal-bg');
  if (existing) existing.remove();

  const nameIn = el('input', { type: 'text', placeholder: 'e.g. Spring Promo' });
  const msgIn = el('textarea', { rows: '4', placeholder: 'Your message...' });
  const promoIn = el('input', { type: 'text', placeholder: 'e.g. SPRING25 (optional)' });
  const segSel = el('select', {},
    el('option', { value: 'all' }, 'All Leads'),
    el('option', { value: 'first_timers' }, 'First Timers'),
    el('option', { value: 'returning' }, 'Returning'),
    el('option', { value: 'no_shows' }, 'No Shows')
  );
  const result = el('div', {});
  const sendBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (!nameIn.value.trim() || !msgIn.value.trim()) { toast('Name and message are required', true); return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending...';
    try {
      const body = { name: nameIn.value.trim(), message: msgIn.value.trim(), segment: segSel.value };
      if (promoIn.value.trim()) body.promoCode = promoIn.value.trim();
      const data = await api('/api/portal/blasts', { method: 'POST', body });
      toast(`Blast sent! ${data.sent || 0} delivered, ${data.failed || 0} failed`);
      bg.remove();
      state.view = 'blasts'; render();
    } catch (e) {
      result.textContent = 'Error: ' + e.message;
      result.style.color = 'var(--error)';
    } finally { sendBtn.disabled = false; sendBtn.textContent = 'Send Blast'; }
  } }, 'Send Blast');

  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'New SMS Blast'),
    el('label', {}, 'Blast Name'), nameIn,
    el('label', {}, 'Message Body'), msgIn,
    el('label', {}, 'Promo Code'), promoIn,
    el('label', {}, 'Segment'), segSel,
    result,
    el('div', { style: 'display:flex;gap:12px;justify-content:flex-end;margin-top:16px' },
      el('button', { class: 'btn', onclick: () => bg.remove() }, 'Cancel'),
      sendBtn
    )
  );

  const bg = el('div', { class: 'blast-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, modal);
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.style.cssText = 'background:var(--card,#1a2236);border:1px solid var(--border,#2a3a5c);border-radius:12px;padding:24px;width:90%;max-width:480px';
  modal.querySelectorAll('input,textarea,select').forEach(i => {
    i.style.cssText = 'width:100%;padding:8px 12px;margin:4px 0 12px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem';
  });
  modal.querySelectorAll('label').forEach(l => l.style.cssText = 'font-size:0.8rem;color:var(--muted,#888)');
  document.body.appendChild(bg);
}

// ============================================================
// NUDGES
// ============================================================
const DELAY_OPTIONS = {
  1: [{ v: 0, l: 'Immediately' }],
  2: [{ v: 30, l: '30 min' }, { v: 60, l: '1 hour' }, { v: 120, l: '2 hours' }, { v: 240, l: '4 hours' }],
  3: [{ v: 720, l: '12 hours' }, { v: 1440, l: '1 day' }, { v: 2880, l: '2 days' }],
  4: [{ v: 1440, l: '1 day' }, { v: 2880, l: '2 days' }, { v: 4320, l: '3 days' }],
  5: [{ v: 4320, l: '3 days' }, { v: 7200, l: '5 days' }, { v: 10080, l: '7 days' }]
};

async function viewNudges() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Nudges'),
    el('div', { class: 'muted' }, 'Automated 5-message SMS drip for new leads')
  ));

  wrap.appendChild(el('p', { class: 'muted', style: 'font-size:0.8rem;margin-bottom:20px' },
    'When a new lead comes in, these messages are sent automatically. Variables: [first_name], [business_name], [funnel_url]'
  ));

  const slotsDiv = el('div', { id: 'nudge-slots' });
  wrap.appendChild(slotsDiv);

  let nudges = [];
  try {
    const data = await api('/api/portal/nudges');
    nudges = data.nudges || [];
  } catch (e) {
    slotsDiv.appendChild(el('p', { class: 'err' }, 'Failed to load nudges: ' + e.message));
    return wrap;
  }

  for (let i = 1; i <= 5; i++) {
    const n = nudges.find(x => x.message_number === i);
    const body = n ? n.message_body : '';
    const delay = n ? n.delay_minutes : 0;
    const active = n ? n.is_active !== false : true;

    const textarea = el('textarea', { rows: '3', style: 'width:100%;padding:10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:8px;color:var(--text,#e0e0e0);font-size:0.8rem;resize:none' }, body);
    textarea.dataset.num = i;

    const delaySel = el('select', { style: 'background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.75rem;padding:4px 8px' });
    delaySel.dataset.num = i;
    (DELAY_OPTIONS[i] || []).forEach(o => {
      const opt = el('option', { value: String(o.v) }, o.l);
      if (o.v === delay) opt.selected = true;
      delaySel.appendChild(opt);
    });

    const cb = el('input', { type: 'checkbox' });
    cb.checked = active;
    cb.dataset.num = i;

    const card = el('div', { class: 'panel', style: active ? '' : 'opacity:0.5' },
      el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px' },
        el('div', { style: 'width:28px;height:28px;border-radius:50%;background:var(--accent,#C9A84C);color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold' }, String(i)),
        el('div', { style: 'flex:1;font-weight:600;font-size:0.9rem' }, 'Message ' + i + (i === 1 ? ' — Welcome' : '')),
        el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--muted,#888);cursor:pointer' },
          cb, el('span', {}, active ? 'Active' : 'Off'))
      ),
      textarea,
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, delaySel)
    );
    slotsDiv.appendChild(card);
  }

  const saveBtn = el('button', { class: 'btn primary', style: 'margin-top:16px', onclick: async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    const payload = [];
    for (let i = 1; i <= 5; i++) {
      const ta = slotsDiv.querySelector(`textarea[data-num="${i}"]`);
      const sel = slotsDiv.querySelector(`select[data-num="${i}"]`);
      const chk = slotsDiv.querySelector(`input[data-num="${i}"]`);
      payload.push({
        message_number: i,
        message_body: ta.value,
        delay_minutes: parseInt(sel.value, 10),
        is_active: chk.checked
      });
    }
    try {
      await api('/api/portal/nudges', { method: 'PUT', body: { nudges: payload } });
      toast('Nudges saved');
    } catch (e) { toast(e.message, true); }
    finally { saveBtn.disabled = false; saveBtn.textContent = 'Save All Nudges'; }
  } }, 'Save All Nudges');
  wrap.appendChild(el('div', { style: 'text-align:right' }, saveBtn));

  return wrap;
}

// ============================================================
// SETTINGS
// ============================================================
async function loadIntegrationStatus(container) {
  const rows = el('div', {});
  container.appendChild(rows);

  // GA4 status
  const ga4Row = el('div', { class: 'integration-row' });
  ga4Row.appendChild(el('div', { class: 'integration-label' }, 'Google Analytics (GA4)'));
  const ga4Status = el('div', { class: 'integration-status' }, 'Checking...');
  ga4Row.appendChild(ga4Status);
  rows.appendChild(ga4Row);

  // Stripe Connect status
  const stripeRow = el('div', { class: 'integration-row' });
  stripeRow.appendChild(el('div', { class: 'integration-label' }, 'Stripe Payments'));
  const stripeStatus = el('div', { class: 'integration-status' }, 'Checking...');
  stripeRow.appendChild(stripeStatus);
  rows.appendChild(stripeRow);

  // Twilio status
  const twilioRow = el('div', { class: 'integration-row' });
  twilioRow.appendChild(el('div', { class: 'integration-label' }, 'Twilio SMS'));
  const twilioStatus = el('div', { class: 'integration-status' });
  twilioStatus.appendChild(state.client?.twilio_phone_number
    ? el('span', { class: 'badge green' }, state.client.twilio_phone_number)
    : el('span', { class: 'badge red' }, 'Not configured'));
  twilioRow.appendChild(twilioStatus);
  rows.appendChild(twilioRow);

  // Fetch GA4
  try {
    const ga = await api('/api/portal/ga4');
    ga4Status.innerHTML = '';
    if (ga.configured === false) {
      ga4Status.appendChild(el('span', { class: 'badge red' }, 'Not configured'));
      ga4Status.appendChild(el('p', { class: 'muted', style: 'font-size:0.75rem;margin-top:4px' },
        'Set ga4_property_id in Admin panel or contact GoElev8 support.'));
    } else {
      ga4Status.appendChild(el('span', { class: 'badge green' }, 'Connected'));
      ga4Status.appendChild(el('span', { class: 'muted', style: 'margin-left:8px;font-size:0.8rem' },
        `Property ${ga.property_id} · ${ga.property_label}`));
    }
  } catch { ga4Status.textContent = 'Error checking GA4'; }

  // Fetch Stripe Connect
  try {
    const sc = await api('/api/portal/connect?action=status');
    stripeStatus.innerHTML = '';
    if (!sc.connected) {
      stripeStatus.appendChild(el('span', { class: 'badge red' }, 'Not connected'));
      stripeStatus.appendChild(el('button', { class: 'btn sm', style: 'margin-left:8px', onclick: async () => {
        try {
          const r = await api('/api/portal/connect?action=start', { method: 'POST' });
          window.location.href = r.url;
        } catch (e) { toast('Stripe setup failed: ' + e.message, true); }
      } }, 'Connect Stripe'));
    } else {
      const statusBadge = sc.charges_enabled
        ? el('span', { class: 'badge green' }, 'Active')
        : el('span', { class: 'badge warn' }, 'Onboarding incomplete');
      stripeStatus.appendChild(statusBadge);
      stripeStatus.appendChild(el('span', { class: 'muted', style: 'margin-left:8px;font-size:0.8rem' },
        `Account ${sc.account_id}` + (sc.charges_enabled ? ' · Charges enabled' : '')));
    }
  } catch { stripeStatus.textContent = 'Error checking Stripe'; }
}

async function viewSettings() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Settings')));

  // ----- Credits ticker (live) -----
  const ticker = el('div', { class: 'panel credits-ticker' },
    el('div', { class: 'credits-ticker-row' },
      el('div', {},
        el('div', { class: 'credits-ticker-label' }, 'SMS CREDITS REMAINING'),
        el('div', { class: 'credits-ticker-value', id: 'credits-balance' }, '—')
      ),
      el('div', { class: 'credits-ticker-icon' }, '💬')
    )
  );
  wrap.appendChild(ticker);

  // Load billing data so we can show packs, ledger, auto-reload
  let b = null;
  try {
    b = await api('/api/portal/billing');
    const balanceEl = ticker.querySelector('#credits-balance');
    if (balanceEl) balanceEl.textContent = String(b.credit_balance ?? 0);
    if ((b.credit_balance ?? 0) < 50) ticker.classList.add('low');
  } catch (e) {
    const balanceEl = ticker.querySelector('#credits-balance');
    if (balanceEl) balanceEl.textContent = '—';
  }

  // ----- Credits & Billing -----
  if (b) {
    const billingPanel = el('div', { class: 'panel' });
    billingPanel.appendChild(el('h2', {}, '💳 Credits & Billing'));

    const stats = el('div', { class: 'cards' });
    stats.appendChild(card('Sent This Month', b.sent_this_month, 'Outbound messages'));
    stats.appendChild(card('Auto-Reload', b.auto_reload?.enabled ? 'ON' : 'OFF',
      b.auto_reload?.enabled ? `< ${b.auto_reload.threshold} → buy ${b.auto_reload.pack}` : 'Disabled'));
    billingPanel.appendChild(stats);

    // Top-up packs
    billingPanel.appendChild(el('h3', { style: 'margin-top:20px;font-size:14px;font-weight:600' }, 'Buy more credits'));
    const packsRow = el('div', { class: 'cards' });
    for (const p of Object.values(b.packs || {})) {
      packsRow.appendChild(el('div', { class: 'pack-card' + (p.id === 'growth' ? ' featured' : '') },
        el('div', { class: 'pack-label' }, p.label),
        el('div', { class: 'pack-price' }, '$' + (p.priceCents / 100)),
        el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`),
        el('button', { class: 'btn',
          onclick: async () => {
            try {
              const r = await api('/api/portal/credits?action=checkout', { method: 'POST', body: { pack: p.id } });
              window.location.href = r.url;
            } catch (e) { toast(e.message, true); }
          }}, `Buy ${p.label} →`)
      ));
    }
    billingPanel.appendChild(packsRow);

    // Auto-reload
    billingPanel.appendChild(el('h3', { style: 'margin-top:24px;font-size:14px;font-weight:600' }, 'Auto-Reload Settings'));
    const arEnabled = el('input', { type: 'checkbox' });
    arEnabled.checked = !!b.auto_reload?.enabled;
    const arThreshold = el('input', { type: 'number', value: b.auto_reload?.threshold ?? 50, min: 1 });
    const arPackSel = el('select', {},
      ...Object.values(b.packs || {}).map(p => el('option', { value: p.id, selected: p.id === b.auto_reload?.pack }, `${p.label} ($${p.priceCents/100} / ${p.credits} credits)`))
    );
    billingPanel.appendChild(el('div', { class: 'row', style: 'gap:20px; margin:12px 0' },
      el('label', { style: 'display:flex; align-items:center; gap:8px; font-size:14px; color:var(--text)' }, arEnabled, 'Enable auto-reload')
    ));
    billingPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Threshold (credits remaining)'), arThreshold));
    billingPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Pack to buy'), arPackSel));
    billingPanel.appendChild(el('button', { class: 'btn', onclick: async () => {
      try {
        await api('/api/portal/credits?action=auto-reload', { method: 'POST', body: {
          enabled: arEnabled.checked,
          threshold: parseInt(arThreshold.value, 10),
          pack: arPackSel.value
        }});
        toast('Auto-reload settings saved');
      } catch (e) { toast(e.message, true); }
    }}, 'Save settings'));

    // Recent activity ledger
    if (b.ledger?.length) {
      billingPanel.appendChild(el('h3', { style: 'margin-top:24px;font-size:14px;font-weight:600' }, 'Recent activity'));
      billingPanel.appendChild(el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'Type'), el('th', {}, 'Δ Credits'), el('th', {}, 'Amount')
        )),
        el('tbody', {}, ...b.ledger.slice(0, 10).map(r => el('tr', {},
          el('td', {}, new Date(r.created_at).toLocaleString()),
          el('td', {}, r.reason),
          el('td', {}, (r.delta > 0 ? '+' : '') + r.delta),
          el('td', {}, r.amount_cents ? '$' + (r.amount_cents/100).toFixed(2) : '—')
        )))
      ));
    }
    wrap.appendChild(billingPanel);
  }

  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('h2', {}, 'Account'));
  panel.appendChild(el('p', {}, `Email: ${state.user?.email || ''}`));
  panel.appendChild(el('p', {}, `Client: ${state.client?.name || ''}`));
  wrap.appendChild(panel);

  // ----- Integrations status -----
  const intPanel = el('div', { class: 'panel' });
  intPanel.appendChild(el('h2', {}, 'Integrations'));
  wrap.appendChild(intPanel);
  loadIntegrationStatus(intPanel);

  // ----- Welcome SMS -----
  const wsms = el('div', { class: 'panel' });
  wsms.appendChild(el('h2', {}, 'Welcome SMS'));
  wsms.appendChild(el('p', { class: 'muted' },
    'Automatically text new leads the moment a webhook event arrives from your client sites. ' +
    'A welcome SMS only fires when the event includes a phone number and you have credits.'));

  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = !!state.client?.welcome_sms_enabled;
  const enabledRow = el('label', { class: 'toggle-row' },
    enabled,
    el('span', {}, 'Send a welcome SMS automatically on new events')
  );
  wsms.appendChild(enabledRow);

  const tplLabel = el('label', { class: 'field-label' }, 'Message template');
  const tpl = el('textarea', {
    rows: 5, maxlength: 1600,
    placeholder: 'Hi {{first_name}}, thanks for reaching out to {{client_name}}!'
  });
  tpl.value = state.client?.welcome_sms_template || '';
  wsms.appendChild(tplLabel);
  wsms.appendChild(tpl);

  wsms.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
    'Variables: ',
    el('code', {}, '{{first_name}}'), ' ',
    el('code', {}, '{{name}}'), ' ',
    el('code', {}, '{{client_name}}'), ' ',
    el('code', {}, '{{source}}'), ' ',
    el('code', {}, '{{source_path}}')
  ));

  const previewLabel = el('div', { class: 'field-label', style: 'margin-top:14px' }, 'Preview');
  const preview = el('div', { class: 'sms-preview' });
  wsms.appendChild(previewLabel);
  wsms.appendChild(preview);

  const renderPreview = () => {
    const sample = {
      first_name: 'Jane',
      name: 'Jane Doe',
      client_name: state.client?.name || 'Your Business',
      source: 'theflexfacility.com',
      source_path: '/fit'
    };
    const out = (tpl.value || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => sample[k] ?? '');
    const segs = Math.max(1, Math.ceil((out.length || 1) / 160));
    preview.textContent = out || '(empty)';
    segCount.textContent = `${out.length} chars · ${segs} segment${segs === 1 ? '' : 's'} · ${segs} credit${segs === 1 ? '' : 's'} per send`;
  };
  const segCount = el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' });
  wsms.appendChild(segCount);
  tpl.addEventListener('input', renderPreview);
  renderPreview();

  const saveBtn = el('button', { class: 'btn', style: 'margin-top:14px' }, 'Save welcome SMS');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const r = await api('/api/portal/me', {
        method: 'PATCH',
        body: {
          welcome_sms_enabled: enabled.checked,
          welcome_sms_template: tpl.value
        }
      });
      state.client = r.client;
      toast('Welcome SMS saved');
    } catch (e) {
      toast(e.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  wsms.appendChild(saveBtn);
  wrap.appendChild(wsms);

  const pw = el('div', { class: 'panel' });
  pw.appendChild(el('h2', {}, 'Change password'));
  const np = el('input', { type: 'password', placeholder: 'New password (min 8 chars)' });
  pw.appendChild(el('div', { class: 'field' }, el('label', {}, 'New password'), np));
  pw.appendChild(el('button', { class: 'btn', onclick: async () => {
    try {
      await api('/api/auth?action=change-password', { method: 'POST', body: { new_password: np.value } });
      np.value = ''; toast('Password updated');
    } catch (e) { toast(e.message, true); }
  }}, 'Update password'));
  wrap.appendChild(pw);

  return wrap;
}

// ============================================================
// ACTIVITY (cross-project events from The-AI-Exit-Strategy)
// ============================================================
let activityPoll = null;
async function viewActivity() {
  if (activityPoll) { clearInterval(activityPoll); activityPoll = null; }

  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Activity'),
    el('div', { class: 'muted' }, 'Live form submissions, leads & bookings from your sites')
  ));

  const list = el('div', { class: 'panel' }, el('div', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(list);

  const fmt = (ts) => {
    const d = new Date(ts); const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleString();
  };

  const renderRows = (events) => {
    list.innerHTML = '';
    if (!events.length) {
      list.appendChild(el('div', { class: 'muted', style: 'padding:24px;text-align:center' },
        'No activity yet. Webhook events from your client sites will appear here.'));
      return;
    }
    const table = el('div', { class: 'event-list' });
    for (const ev of events) {
      const meta = [ev.source, ev.source_path].filter(Boolean).join('');
      const who = ev.contact_name || ev.contact_email || ev.contact_phone || '—';
      const row = el('div', { class: 'event-row' },
        el('div', { class: 'event-type' }, ev.event_type),
        el('div', { class: 'event-body' },
          el('div', { class: 'event-title' }, ev.title || who),
          el('div', { class: 'event-meta muted' }, meta + (who && (ev.title) ? ' · ' + who : ''))
        ),
        el('div', { class: 'event-time muted' }, fmt(ev.occurred_at))
      );
      row.addEventListener('click', () => {
        const pre = el('pre', { class: 'event-payload' }, JSON.stringify(ev.payload, null, 2));
        if (row.nextSibling && row.nextSibling.classList?.contains('event-payload')) {
          row.nextSibling.remove();
        } else {
          row.after(pre);
        }
      });
      table.appendChild(row);
    }
    list.appendChild(table);
  };

  const load = async () => {
    try {
      const r = await api('/api/events?action=list&limit=100');
      renderRows(r.events || []);
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'err' }, 'Failed to load: ' + e.message));
    }
  };
  await load();
  activityPoll = setInterval(load, 5000);
  return wrap;
}

// ============================================================
// MASTER ADMIN VIEW
// ============================================================
async function viewAdmin() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Master Admin'),
    el('div', { class: 'muted' }, 'Cross-tenant operations · only visible to platform admins')));

  // ----- Analytics cards -----
  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  cards.appendChild(el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Loading…')));
  try {
    const a = await api('/api/admin?action=analytics');
    cards.innerHTML = '';
    const card = (label, value, sub) => el('div', { class: 'card' },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(value)),
      sub ? el('div', { class: 'sub muted' }, sub) : null);
    cards.appendChild(card('Total clients', a.total_clients, `${a.new_clients_30d} new in 30d`));
    cards.appendChild(card('Active 7d', a.active_clients_7d, 'sent SMS in last 7 days'));
    cards.appendChild(card('SMS this month', a.sms_this_month, 'outbound across all clients'));
    cards.appendChild(card('Purchases this month', a.purchases_this_month, 'credit pack buys'));
  } catch (e) { cards.innerHTML = ''; cards.appendChild(el('div', { class: 'err' }, e.message)); }

  // ----- Clients table -----
  const tablePanel = el('div', { class: 'panel' });
  tablePanel.appendChild(el('h2', {}, 'All clients'));
  const tableHost = el('div', {}, el('div', { class: 'muted' }, 'Loading…'));
  tablePanel.appendChild(tableHost);
  wrap.appendChild(tablePanel);

  let allClients = [];
  const onClientsLoaded = [];
  const refresh = async () => {
    const r = await api('/api/admin?action=list-clients');
    allClients = r.clients || [];
    for (const fn of onClientsLoaded) { try { fn(allClients); } catch {} }
    tableHost.innerHTML = '';
    if (!allClients.length) {
      tableHost.appendChild(el('div', { class: 'muted' }, 'No clients yet.'));
      return;
    }
    const table = el('table', { class: 'admin-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Client'),
        el('th', {}, 'Slug'),
        el('th', {}, 'Twilio'),
        el('th', {}, 'Credits'),
        el('th', {}, 'Sent 30d'),
        el('th', {}, 'Status'),
        el('th', {}, 'Actions')
      )),
      el('tbody', {}, ...allClients.map((c) => {
        const amountInput = el('input', { type: 'number', min: '1', value: '20', style: 'width:70px' });
        const noteInput   = el('input', { type: 'text', placeholder: 'note (optional)', style: 'width:140px' });
        const ga4Input    = el('input', { type: 'text', placeholder: 'GA4 property ID', value: c.ga4_property_id || '', style: 'width:140px' });
        const saveGa4 = async () => {
          try {
            await api('/api/admin?action=set-ga4', {
              method: 'POST', body: { client_id: c.id, ga4_property_id: ga4Input.value.trim() }
            });
            toast('GA4 property saved for ' + c.name);
            await refresh();
          } catch (e) { toast(e.message, true); }
        };
        const adjust = async (sign) => {
          const raw = parseInt(amountInput.value, 10);
          if (!Number.isFinite(raw) || raw <= 0) { toast('Enter a positive amount', true); return; }
          const delta = sign * Math.abs(raw);
          try {
            const r = await api('/api/admin?action=set-credits', {
              method: 'POST', body: { client_id: c.id, delta, note: noteInput.value }
            });
            toast(`${c.name}: ${r.client.credit_balance} credits`);
            await refresh();
          } catch (e) { toast(e.message, true); }
        };
        return el('tr', {},
          el('td', {}, el('strong', {}, c.name || '—')),
          el('td', {}, el('code', {}, c.slug)),
          el('td', { class: 'muted mono' }, c.twilio_phone_number || '—'),
          el('td', {}, String(c.credit_balance ?? 0)),
          el('td', { class: 'muted' }, String(c.sent_30d || 0)),
          el('td', {}, c.billing_paused
              ? el('span', { class: 'pill warn' }, 'PAUSED')
              : el('span', { class: 'pill ok' }, 'active')),
          el('td', { class: 'actions' },
            el('button', { class: 'btn sm', onclick: () => {
              setImpersonation(c.id); render();
            }}, 'View as'),
            amountInput, noteInput,
            el('button', { class: 'btn sm btn-success', onclick: () => adjust(+1) }, '+ Add'),
            el('button', { class: 'btn sm btn-warn',    onclick: () => adjust(-1) }, '− Remove'),
            el('button', { class: 'btn sm ' + (c.billing_paused ? 'btn-success' : 'btn-warn'), onclick: async () => {
              try {
                await api('/api/admin?action=billing-pause', {
                  method: 'POST', body: { client_id: c.id, paused: !c.billing_paused }
                });
                toast(c.billing_paused ? 'Billing resumed' : 'Billing paused');
                await refresh();
              } catch (e) { toast(e.message, true); }
            }}, c.billing_paused ? 'Resume billing' : 'Pause billing'),
            el('div', { style: 'display:flex;gap:4px;align-items:center;margin-top:6px' },
              el('span', { class: 'muted', style: 'font-size:0.7rem' }, 'GA4:'),
              ga4Input,
              el('button', { class: 'btn sm', onclick: saveGa4 }, 'Save')
            ),
            (() => {
              const skInput = el('input', { type: 'password', placeholder: 'sk_live_...', value: c.stripe_secret_key ? '••••••••' : '', style: 'width:160px' });
              const saveKey = async () => {
                const val = skInput.value.trim();
                if (val === '••••••••') return;
                try {
                  await api('/api/admin?action=set-stripe-key', {
                    method: 'POST', body: { client_id: c.id, stripe_secret_key: val }
                  });
                  toast('Stripe key saved for ' + c.name);
                  skInput.value = val ? '••••••••' : '';
                } catch (e) { toast(e.message, true); }
              };
              return el('div', { style: 'display:flex;gap:4px;align-items:center;margin-top:4px' },
                el('span', { class: 'muted', style: 'font-size:0.7rem' }, 'Stripe:'),
                skInput,
                el('button', { class: 'btn sm', onclick: saveKey }, 'Save')
              );
            })()
          )
        );
      }))
    );
    tableHost.appendChild(table);
  };
  refresh().catch((e) => { tableHost.innerHTML = ''; tableHost.appendChild(el('div', { class: 'err' }, e.message)); });

  // ----- Send free SMS as any client -----
  const sendPanel = el('div', { class: 'panel' });
  sendPanel.appendChild(el('h2', {}, 'Send free SMS as any client'));
  sendPanel.appendChild(el('p', { class: 'muted' }, 'Bypasses credits and Stripe billing. Logged with credits_charged = 0.'));
  const clientSel = el('select', {}, el('option', { value: '' }, 'Loading clients…'));
  const toIn      = el('input', { type: 'tel', placeholder: '+15551234567' });
  const bodyIn    = el('textarea', { rows: 3, placeholder: 'Message…' });
  const fillSel = (clients) => {
    clientSel.innerHTML = '';
    if (!clients.length) {
      clientSel.appendChild(el('option', { value: '' }, 'No clients'));
      return;
    }
    clientSel.appendChild(el('option', { value: '' }, '— Pick a client —'));
    for (const c of clients) {
      clientSel.appendChild(el('option', { value: c.id }, `${c.name} (${c.slug})`));
    }
  };
  // Hook into refresh — fires now if data already loaded, or whenever refresh resolves.
  onClientsLoaded.push(fillSel);
  if (allClients.length) fillSel(allClients);
  sendPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Client'), clientSel));
  sendPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'To'), toIn));
  sendPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Body'), bodyIn));
  sendPanel.appendChild(el('button', { class: 'btn', onclick: async () => {
    if (!clientSel.value) { toast('Pick a client first', true); return; }
    if (!toIn.value || !bodyIn.value) { toast('Enter a destination and message', true); return; }
    try {
      const r = await api('/api/admin?action=send-as-client', {
        method: 'POST',
        body: { client_id: clientSel.value, to: toIn.value, body: bodyIn.value }
      });
      toast('Sent · sid ' + r.sid + ' (free)');
      bodyIn.value = '';
    } catch (e) { toast(e.message, true); }
  }}, 'Send free SMS'));
  wrap.appendChild(sendPanel);

  // ----- Create new client -----
  const createPanel = el('div', { class: 'panel' });
  createPanel.appendChild(el('h2', {}, 'Onboard new client'));
  const fSlug = el('input', { placeholder: 'acme-fitness' });
  const fName = el('input', { placeholder: 'Acme Fitness' });
  const fNum  = el('input', { placeholder: '+18005550123 (optional)' });
  const fEmail = el('input', { type: 'email', placeholder: 'owner@acmefitness.com' });
  const fPw    = el('input', { type: 'text', placeholder: 'Initial password' });
  createPanel.appendChild(el('div', { class: 'grid-2' },
    el('div', { class: 'field' }, el('label', {}, 'Slug'), fSlug),
    el('div', { class: 'field' }, el('label', {}, 'Name'), fName),
    el('div', { class: 'field' }, el('label', {}, 'Twilio number'), fNum),
    el('div', { class: 'field' }, el('label', {}, 'Owner email'), fEmail),
    el('div', { class: 'field' }, el('label', {}, 'Owner password'), fPw)
  ));
  createPanel.appendChild(el('button', { class: 'btn', onclick: async () => {
    try {
      await api('/api/admin?action=create-client', {
        method: 'POST',
        body: {
          slug: fSlug.value.trim(),
          name: fName.value.trim(),
          twilio_phone_number: fNum.value.trim() || null,
          users: fEmail.value ? [{ email: fEmail.value.trim(), password: fPw.value, role: 'owner' }] : [],
          grant_credits: 20
        }
      });
      toast('Client created with 20 free credits');
      fSlug.value = fName.value = fNum.value = fEmail.value = fPw.value = '';
      await refresh();
    } catch (e) { toast(e.message, true); }
  }}, 'Create client'));
  wrap.appendChild(createPanel);

  return wrap;
}

// ============================================================
// BOOKING CALENDAR ADMIN (book.goelev8.ai management)
// ============================================================
async function viewBookingAdmin() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'book.goelev8.ai'),
    el('div', { class: 'muted' }, 'AI Booking Platform · all signups, tenants, bookings, and revenue across every client')));

  // ----- Sub-tab state -----
  let subTab = 'dashboard';
  let detailSlug = null;

  const subNav = el('div', { class: 'filter-bar' });
  const content = el('div', {});
  wrap.appendChild(subNav);
  wrap.appendChild(content);

  function renderSubNav() {
    subNav.innerHTML = '';
    const tabs = [
      ['dashboard', 'Dashboard'],
      ['tenants', 'All Tenants'],
      ['bookings', 'All Bookings'],
    ];
    if (detailSlug) tabs.push(['detail', detailSlug]);
    for (const [id, label] of tabs) {
      subNav.appendChild(el('button', {
        class: 'chip' + (subTab === id ? ' active' : ''),
        onclick: () => { subTab = id; renderContent(); }
      }, label));
    }
  }

  // ----- Dashboard -----
  async function renderDashboard() {
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'muted' }, 'Loading book.goelev8.ai data...'));
    try {
      const d = await api('/api/admin-booking?action=dashboard');
      content.innerHTML = '';

      // Stat cards
      const cards = el('div', { class: 'cards' });
      const card = (label, value, sub) => el('div', { class: 'card' },
        el('div', { class: 'label' }, label),
        el('div', { class: 'value' }, String(value)),
        sub ? el('div', { class: 'sub muted' }, sub) : null);
      cards.appendChild(card('Total Tenants', d.total_tenants, `${d.new_tenants_30d} new in 30d`));
      cards.appendChild(card('Total Bookings', d.total_bookings, `${d.bookings_7d} in last 7d`));
      cards.appendChild(card('Bookings Today', d.bookings_today, new Date().toLocaleDateString()));
      content.appendChild(cards);

      // Recent signups
      const signupPanel = el('div', { class: 'panel' });
      signupPanel.appendChild(el('h2', {}, 'Recent Signups'));
      if (!d.recent_tenants.length) {
        signupPanel.appendChild(el('div', { class: 'muted' }, 'No tenants yet.'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Business'),
            el('th', {}, 'Slug'),
            el('th', {}, 'Plan'),
            el('th', {}, 'Signed Up'),
          )),
          el('tbody', {}, ...d.recent_tenants.map(t =>
            el('tr', { style: 'cursor:pointer', onclick: () => { detailSlug = t.slug; subTab = 'detail'; renderContent(); } },
              el('td', {},
                el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${t.brand_color || '#c8a96e'};margin-right:8px;vertical-align:middle` }),
                el('strong', {}, t.business_name)),
              el('td', {}, el('code', {}, t.slug)),
              el('td', {}, el('span', { class: 'badge' + (t.plan === 'free' ? '' : ' green') }, t.plan || 'free')),
              el('td', { class: 'muted' }, new Date(t.created_at).toLocaleDateString()),
            )
          ))
        );
        signupPanel.appendChild(table);
      }
      content.appendChild(signupPanel);

      // Recent bookings
      const bookPanel = el('div', { class: 'panel' });
      bookPanel.appendChild(el('h2', {}, 'Recent Bookings'));
      if (!d.recent_bookings.length) {
        bookPanel.appendChild(el('div', { class: 'muted' }, 'No bookings yet.'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Client'),
            el('th', {}, 'Tenant'),
            el('th', {}, 'Service'),
            el('th', {}, 'Date / Time'),
            el('th', {}, 'Status'),
          )),
          el('tbody', {}, ...d.recent_bookings.map(b =>
            el('tr', {},
              el('td', {}, el('strong', {}, b.client_name || '—')),
              el('td', {}, el('code', {}, b.tenant_slug)),
              el('td', {}, b.service || '—'),
              el('td', { class: 'mono' }, `${b.booking_date || '—'} ${b.booking_time || ''}`),
              el('td', {}, el('span', { class: 'badge' + (b.status === 'confirmed' ? ' green' : b.status === 'cancelled' ? ' red' : '') }, b.status || '—')),
            )
          ))
        );
        bookPanel.appendChild(table);
      }
      content.appendChild(bookPanel);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'err' }, e.message));
    }
  }

  // ----- All Tenants -----
  async function renderTenants() {
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'muted' }, 'Loading...'));
    try {
      const d = await api('/api/admin-booking?action=tenants');
      content.innerHTML = '';

      const panel = el('div', { class: 'panel' });
      panel.appendChild(el('h2', {}, `All Tenants (${d.tenants.length})`));

      if (!d.tenants.length) {
        panel.appendChild(el('div', { class: 'muted' }, 'No tenants.'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Business'),
            el('th', {}, 'Slug'),
            el('th', {}, 'Owner'),
            el('th', {}, 'Services'),
            el('th', {}, 'Bookings'),
            el('th', {}, 'Plan'),
            el('th', {}, 'Payment'),
            el('th', {}, 'Created'),
            el('th', {}, ''),
          )),
          el('tbody', {}, ...d.tenants.map(t =>
            el('tr', {},
              el('td', {},
                el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${t.brand_color || '#c8a96e'};margin-right:8px;vertical-align:middle` }),
                el('strong', {}, t.business_name)),
              el('td', {}, el('a', { href: `https://book.goelev8.ai/${t.slug}`, target: '_blank', class: 'link' }, t.slug)),
              el('td', { class: 'muted' }, t.owner_email || '—'),
              el('td', {}, String(t.service_count)),
              el('td', {}, el('strong', {}, String(t.booking_count))),
              el('td', {}, el('span', { class: 'badge' + (t.plan === 'free' ? '' : ' green') }, t.plan || 'free')),
              el('td', { class: 'muted' }, t.payment_preference || '—'),
              el('td', { class: 'muted' }, new Date(t.created_at).toLocaleDateString()),
              el('td', {},
                el('button', { class: 'btn sm ghost', onclick: () => { detailSlug = t.slug; subTab = 'detail'; renderContent(); } }, 'View'),
              ),
            )
          ))
        );
        panel.appendChild(table);
      }
      content.appendChild(panel);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'err' }, e.message));
    }
  }

  // ----- All Bookings -----
  async function renderBookings() {
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'muted' }, 'Loading...'));
    try {
      const d = await api('/api/admin-booking?action=bookings');
      content.innerHTML = '';

      const panel = el('div', { class: 'panel' });
      panel.appendChild(el('h2', {}, `All Bookings (${d.bookings.length})`));

      if (!d.bookings.length) {
        panel.appendChild(el('div', { class: 'muted' }, 'No bookings yet.'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Client Name'),
            el('th', {}, 'Phone'),
            el('th', {}, 'Email'),
            el('th', {}, 'Tenant'),
            el('th', {}, 'Service'),
            el('th', {}, 'Date'),
            el('th', {}, 'Time'),
            el('th', {}, 'Status'),
            el('th', {}, 'Booked At'),
          )),
          el('tbody', {}, ...d.bookings.map(b =>
            el('tr', {},
              el('td', {}, el('strong', {}, b.client_name || '—')),
              el('td', { class: 'mono' }, b.client_phone || '—'),
              el('td', { class: 'muted' }, b.client_email || '—'),
              el('td', {}, el('code', {}, b.tenant_slug)),
              el('td', {}, b.service || '—'),
              el('td', { class: 'mono' }, b.booking_date || '—'),
              el('td', { class: 'mono' }, b.booking_time || '—'),
              el('td', {}, el('span', { class: 'badge' + (b.status === 'confirmed' ? ' green' : b.status === 'cancelled' ? ' red' : '') }, b.status || '—')),
              el('td', { class: 'muted' }, new Date(b.created_at).toLocaleString()),
            )
          ))
        );
        panel.appendChild(table);
      }
      content.appendChild(panel);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'err' }, e.message));
    }
  }

  // ----- Tenant Detail -----
  async function renderDetail() {
    if (!detailSlug) { subTab = 'dashboard'; renderContent(); return; }
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'muted' }, 'Loading...'));
    try {
      const d = await api(`/api/admin-booking?action=tenant-detail&slug=${encodeURIComponent(detailSlug)}`);
      content.innerHTML = '';
      const t = d.tenant;

      // Tenant info panel
      const infoPanel = el('div', { class: 'panel' });
      infoPanel.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px' },
        el('h2', { style: 'margin:0' }, t.business_name),
        el('div', { style: 'display:flex;gap:8px;align-items:center' },
          el('a', { href: `https://book.goelev8.ai/${t.slug}`, target: '_blank', class: 'btn sm' }, 'View Booking Page'),
          el('button', { class: 'btn sm danger', onclick: async () => {
            if (!confirm(`Delete tenant "${t.business_name}" and all their bookings? This cannot be undone.`)) return;
            try {
              await api('/api/admin-booking?action=delete-tenant', { method: 'POST', body: { slug: t.slug } });
              toast(`Deleted ${t.business_name}`);
              detailSlug = null; subTab = 'tenants'; renderContent();
            } catch (e) { toast(e.message, true); }
          }}, 'Delete'),
        )
      ));

      const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px' });
      const row = (label, value) => el('div', {},
        el('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px' }, label),
        el('div', {}, value || '—'));

      grid.appendChild(row('Slug', el('code', {}, t.slug)));
      grid.appendChild(row('Email', t.owner_email));
      grid.appendChild(row('Phone', t.owner_phone || '—'));
      grid.appendChild(row('Plan', t.plan || 'free'));
      grid.appendChild(row('Brand Color', el('span', {},
        el('span', { style: `display:inline-block;width:12px;height:12px;border-radius:50%;background:${t.brand_color};margin-right:6px;vertical-align:middle` }),
        t.brand_color)));
      grid.appendChild(row('Staff', t.staff_count || '1'));
      grid.appendChild(row('Payments', t.payment_preference || 'none'));
      grid.appendChild(row('Stripe ID', t.stripe_customer_id || '—'));

      const avail = t.availability || {};
      grid.appendChild(row('Availability', `${(avail.days || []).join(', ')} · ${avail.open || '?'} – ${avail.close || '?'}`));
      grid.appendChild(row('Created', new Date(t.created_at).toLocaleString()));
      infoPanel.appendChild(grid);

      // Services
      const services = Array.isArray(t.services) ? t.services : [];
      if (services.length) {
        infoPanel.appendChild(el('h3', { style: 'margin-top:20px;margin-bottom:8px' }, 'Services'));
        const svcTable = el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Duration'), el('th', {}, 'Price'))),
          el('tbody', {}, ...services.map(s => el('tr', {},
            el('td', {}, s.name),
            el('td', {}, `${s.duration} min`),
            el('td', {}, `$${s.price}`),
          )))
        );
        infoPanel.appendChild(svcTable);
      }
      content.appendChild(infoPanel);

      // Bookings panel
      const bookPanel = el('div', { class: 'panel' });
      bookPanel.appendChild(el('h2', {}, `Bookings (${d.bookings.length})`));
      if (!d.bookings.length) {
        bookPanel.appendChild(el('div', { class: 'muted' }, 'No bookings for this tenant.'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Client'),
            el('th', {}, 'Phone'),
            el('th', {}, 'Service'),
            el('th', {}, 'Date'),
            el('th', {}, 'Time'),
            el('th', {}, 'Status'),
            el('th', {}, 'Booked At'),
          )),
          el('tbody', {}, ...d.bookings.map(b =>
            el('tr', {},
              el('td', {}, el('strong', {}, b.client_name || '—')),
              el('td', { class: 'mono' }, b.client_phone || '—'),
              el('td', {}, b.service || '—'),
              el('td', { class: 'mono' }, b.booking_date || '—'),
              el('td', { class: 'mono' }, b.booking_time || '—'),
              el('td', {}, el('span', { class: 'badge' + (b.status === 'confirmed' ? ' green' : b.status === 'cancelled' ? ' red' : '') }, b.status || '—')),
              el('td', { class: 'muted' }, new Date(b.created_at).toLocaleString()),
            )
          ))
        );
        bookPanel.appendChild(table);
      }
      content.appendChild(bookPanel);
    } catch (e) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'err' }, e.message));
    }
  }

  // ----- Render router -----
  async function renderContent() {
    renderSubNav();
    try {
      switch (subTab) {
        case 'dashboard': await renderDashboard(); break;
        case 'tenants':   await renderTenants(); break;
        case 'bookings':  await renderBookings(); break;
        case 'detail':    await renderDetail(); break;
      }
    } catch (e) {
      console.error('[BookingAdmin] renderContent error:', e);
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'panel' },
        el('div', { class: 'err' }, 'Error loading booking data: ' + e.message),
        el('pre', { style: 'color:#e05252;font-size:12px;margin-top:8px;white-space:pre-wrap' }, e.stack || '')));
    }
  }

  await renderContent();
  return wrap;
}

// ============================================================
// ANALYTICS (admin-only — ab@goelev8.ai)
// ============================================================
async function viewAnalytics() {
  const wrap = el('div', {});
  const topbar = el('div', { class: 'topbar' },
    el('h1', {}, 'Analytics'),
    el('div', { class: 'muted', id: 'ga-subtitle' }, 'Loading live Google Analytics data…')
  );
  wrap.appendChild(topbar);

  const cards = el('div', { class: 'cards' });
  cards.appendChild(el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Loading live data from Google Analytics…')));
  wrap.appendChild(cards);

  const restOfPage = el('div', {});
  wrap.appendChild(restOfPage);

  const card = (icon, label, value, sub) => el('div', { class: 'card' },
    el('div', { class: 'label' }, icon + ' ' + label),
    el('div', { class: 'value' }, String(value)),
    sub ? el('div', { class: 'sub muted' }, sub) : null
  );

  let ga;
  try {
    ga = await api('/api/portal/ga4');
  } catch (e) {
    cards.innerHTML = '';
    cards.appendChild(el('div', { class: 'card' }, el('div', { class: 'err' }, 'Failed to load GA4: ' + e.message)));
    return wrap;
  }

  if (ga.configured === false) {
    cards.innerHTML = '';
    const setupPanel = el('div', { class: 'panel' });
    setupPanel.appendChild(el('h2', {}, '⚠️ Google Analytics Not Configured'));
    setupPanel.appendChild(el('p', { class: 'muted' }, 'To pull live data into this dashboard, set the following environment variables in Vercel:'));
    setupPanel.appendChild(el('div', { style: 'background:#0d1117;padding:14px;border-radius:8px;margin:12px 0;font-family:monospace;font-size:0.8rem;color:#94a3b8' },
      el('div', {}, 'GA4_PROPERTY_ID=123456789'),
      el('div', { style: 'margin-top:6px' }, 'GA4_SERVICE_ACCOUNT_JSON={"type":"service_account",...}')
    ));
    setupPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.8rem' },
      el('strong', {}, 'Setup steps: '),
      '1) Google Cloud Console → enable Google Analytics Data API · 2) Create a service account & download JSON key · 3) GA4 Admin → Property Access Management → add the service account email as a Viewer · 4) Paste credentials into Vercel env vars · 5) Redeploy'
    ));
    wrap.appendChild(setupPanel);
    return wrap;
  }

  if (ga.error) {
    cards.innerHTML = '';
    cards.appendChild(el('div', { class: 'card' }, el('div', { class: 'err' }, 'GA4 error: ' + ga.error)));
    return wrap;
  }

  // Update subtitle with property label
  const sub = wrap.querySelector('#ga-subtitle');
  if (sub) sub.textContent = (ga.property_label || 'Platform-wide') + ' · Property ' + ga.property_id + ' · Last 30 days';

  // Render summary cards
  cards.innerHTML = '';
  cards.appendChild(card('👁️', 'Sessions', ga.sessions, 'Last 30 days'));
  cards.appendChild(card('📄', 'Page Views', ga.page_views, 'Last 30 days'));
  cards.appendChild(card('👥', 'Users', ga.users, 'Unique visitors'));
  const engagementRate = ga.sessions > 0 ? ((ga.engaged_sessions / ga.sessions) * 100).toFixed(1) + '%' : '—';
  cards.appendChild(card('🎯', 'Engagement', engagementRate, 'Engaged sessions'));

  // Sessions over time chart
  const chartPanel = el('div', { class: 'panel' });
  chartPanel.appendChild(el('h2', {}, '📈 Sessions Over Time'));
  const days = Object.entries(ga.by_day || {});
  if (days.length && days.some(([_, v]) => v.sessions > 0)) {
    const max = Math.max(...days.map(([_, v]) => v.sessions), 1);
    const chart = el('div', { class: 'view-chart' });
    days.forEach(([date, vals]) => {
      const bar = el('div', { class: 'view-bar', title: date + ': ' + vals.sessions + ' sessions, ' + vals.page_views + ' views' },
        el('div', { class: 'view-bar-fill', style: 'height:' + Math.max(2, (vals.sessions / max) * 100) + '%' }),
        el('div', { class: 'view-bar-label' }, new Date(date).getDate())
      );
      chart.appendChild(bar);
    });
    chartPanel.appendChild(chart);
  } else {
    chartPanel.appendChild(el('p', { class: 'muted' }, 'No GA4 sessions recorded in the last 30 days.'));
  }
  restOfPage.appendChild(chartPanel);

  // Top traffic sources
  const srcPanel = el('div', { class: 'panel' });
  srcPanel.appendChild(el('h2', {}, '🌐 Top Traffic Sources'));
  if ((ga.top_sources || []).length) {
    const totalSrc = ga.top_sources.reduce((s, x) => s + x.sessions, 0);
    srcPanel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Source'), el('th', {}, 'Sessions'), el('th', {}, 'Users'), el('th', {}, '%')
      )),
      el('tbody', {}, ...ga.top_sources.map(s => el('tr', {},
        el('td', {}, s.source),
        el('td', {}, String(s.sessions)),
        el('td', {}, String(s.users)),
        el('td', {}, ((s.sessions / totalSrc) * 100).toFixed(1) + '%')
      )))
    ));
  } else {
    srcPanel.appendChild(el('p', { class: 'muted' }, 'No traffic sources yet.'));
  }
  restOfPage.appendChild(srcPanel);

  // Top pages (show first 15 in main table)
  const pagePanel = el('div', { class: 'panel' });
  pagePanel.appendChild(el('h2', {}, '📄 Top Pages'));
  if ((ga.top_pages || []).length) {
    pagePanel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Page'), el('th', {}, 'Views'), el('th', {}, 'Sessions')
      )),
      el('tbody', {}, ...ga.top_pages.slice(0, 15).map(p => el('tr', {},
        el('td', {}, el('code', {}, p.path)),
        el('td', {}, String(p.views)),
        el('td', {}, String(p.sessions))
      )))
    ));
  } else {
    pagePanel.appendChild(el('p', { class: 'muted' }, 'No page data yet.'));
  }
  restOfPage.appendChild(pagePanel);

  // Funnel page performance
  const funnelPanel = el('div', { class: 'panel' });
  funnelPanel.appendChild(el('h2', {}, '🔗 Funnel Page Performance'));
  const funnelPages = (ga.top_pages || []).filter(p =>
    p.path && (p.path.startsWith('/r') || p.path.startsWith('/fit') || p.path === '/' || p.path.startsWith('/book'))
  );
  if (funnelPages.length) {
    const totalPageViews = (ga.top_pages || []).reduce((s, p) => s + p.views, 0);
    funnelPanel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Page'), el('th', {}, 'Views'), el('th', {}, 'Sessions'), el('th', {}, '% of Traffic')
      )),
      el('tbody', {}, ...funnelPages.map(p => el('tr', {},
        el('td', {}, el('code', {}, p.path)),
        el('td', {}, String(p.views)),
        el('td', {}, String(p.sessions)),
        el('td', {}, totalPageViews > 0 ? ((p.views / totalPageViews) * 100).toFixed(1) + '%' : '—')
      )))
    ));
  } else {
    funnelPanel.appendChild(el('p', { class: 'muted' }, 'No funnel page data yet. Funnel pages like /r2s, /fit, /book will appear here once they receive traffic.'));
  }
  restOfPage.appendChild(funnelPanel);

  // Sales tracking section
  const salesPanel = el('div', { class: 'panel' });
  salesPanel.appendChild(el('h2', {}, '💰 Sales'));
  restOfPage.appendChild(salesPanel);
  loadSalesSection(salesPanel);

  // Custom portal events
  const eventPanel = el('div', { class: 'panel' });
  eventPanel.appendChild(el('h2', {}, '⚡ Portal Events'));
  const eventLabels = {
    lead_viewed:    'Leads Viewed',
    booking_viewed: 'Bookings Viewed',
    call_log_viewed: 'Call Logs Viewed',
    client_login:   'Client Logins'
  };
  const eventCards = el('div', { class: 'cards', style: 'margin-top:8px' });
  Object.entries(eventLabels).forEach(([key, label]) => {
    eventCards.appendChild(card('📊', label, ga.events?.[key] || 0, 'Last 30 days'));
  });
  eventPanel.appendChild(eventCards);
  restOfPage.appendChild(eventPanel);

  return wrap;
}

async function loadSalesSection(container) {
  // Sync from Stripe button
  const syncBtn = el('button', { class: 'btn sm', style: 'margin-bottom:12px', onclick: async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing from Stripe...';
    try {
      const r = await api('/api/portal/sync-sales', { method: 'POST' });
      toast(`Synced ${r.synced} new sales (${r.skipped} already imported)`);
      // Refresh the section
      container.innerHTML = '';
      container.appendChild(el('h2', {}, '💰 Sales'));
      loadSalesSection(container);
    } catch (e) {
      toast('Sync failed: ' + e.message, true);
    } finally { syncBtn.disabled = false; syncBtn.textContent = 'Sync Sales from Stripe'; }
  } }, 'Sync Sales from Stripe');

  const statsEl = el('div', {});
  const listEl = el('div', {});
  container.append(syncBtn, statsEl, listEl);

  try {
    const [stats, list] = await Promise.all([
      api('/api/portal/sales?action=stats'),
      api('/api/portal/sales?action=list')
    ]);

    // Revenue stat strip
    const changeDir = stats.month_change > 0 ? '+' : '';
    statsEl.appendChild(el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:16px' },
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, `$${(stats.total_revenue / 100).toFixed(2)}`),
        el('span', { class: 'metric-stat-label' }, 'Total Revenue')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, `$${(stats.this_month_revenue / 100).toFixed(2)}`),
        el('span', { class: 'metric-stat-label' }, `This Month (${changeDir}${stats.month_change}%)`)
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, `$${(stats.today_revenue / 100).toFixed(2)}`),
        el('span', { class: 'metric-stat-label' }, `Today (${stats.today_count} sales)`)
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat accent' },
        el('span', { class: 'metric-stat-value' }, String(stats.total_count)),
        el('span', { class: 'metric-stat-label' }, 'Total Sales')
      )
    ));

    // Sales list table
    const sales = list.sales || [];
    if (!sales.length) {
      listEl.appendChild(el('p', { class: 'muted' }, 'No sales recorded yet. Sales from Stripe will appear here automatically.'));
      return;
    }
    listEl.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Customer'), el('th', {}, 'Product'),
        el('th', {}, 'Amount'), el('th', {}, 'Status')
      )),
      el('tbody', {}, ...sales.map(s => el('tr', {},
        el('td', {}, new Date(s.created_at).toLocaleDateString()),
        el('td', {}, s.customer_name || s.customer_email || '—'),
        el('td', {}, s.products?.name || '—'),
        el('td', { style: 'font-weight:600' }, `$${(Number(s.amount) / 100).toFixed(2)}`),
        el('td', {}, el('span', { class: 'badge' + (s.payment_status === 'paid' ? ' green' : s.payment_status === 'refunded' ? ' red' : '') }, s.payment_status || '—'))
      )))
    ));
    if (list.pages > 1) {
      listEl.appendChild(el('p', { class: 'muted', style: 'margin-top:8px;font-size:0.8rem' },
        `Showing ${sales.length} of ${list.total} sales`
      ));
    }
  } catch (e) {
    statsEl.appendChild(el('p', { class: 'muted' }, 'Could not load sales data.'));
  }
}

// ============================================================
// ROUTER / RENDER
// ============================================================
async function render() {
  const root = $('#app');
  if (activityPoll && state.view !== 'activity') { clearInterval(activityPoll); activityPoll = null; }
  // Tear down the Messages realtime channel any time we leave the
  // Messages tab (or before re-rendering it). The viewMessages() body
  // re-creates the channel on each render so we don't leak handlers.
  if (state._messagesChannel) {
    try { state._messagesChannel.unsubscribe(); } catch {}
    state._messagesChannel = null;
  }
  root.innerHTML = '';
  if (!state.token) { root.appendChild(renderLogin()); return; }
  if (!state.user) {
    try { await loadMe(); } catch { logout(); return; }
  }
  // Client-specific portal redirect: send branded clients to their portal
  const CLIENT_PORTALS = { 'islay-studios': '/islaystudios/leads' };
  if (!state.isAdmin && state.client?.slug && CLIENT_PORTALS[state.client.slug]) {
    window.location.replace(CLIENT_PORTALS[state.client.slug]);
    return;
  }
  // Admins land on the admin view by default — but allow switching to
  // other admin-accessible tabs (activity, analytics).
  const ADMIN_VIEWS = ['admin', 'activity', 'analytics', 'booking_admin'];
  if (state.isAdmin && !state.impersonating && !ADMIN_VIEWS.includes(state.view)) {
    state.view = 'admin';
  }
  // Reload client context when impersonation toggles.
  if (state.isAdmin && state.impersonating && !state.client) {
    try { await loadMe(); } catch (e) { toast('Impersonation failed: ' + e.message, true); }
    // Navigate to the client's first tab if they have custom portal_tabs
    if (state.client?.portal_tabs?.length) {
      state.view = state.client.portal_tabs[0];
    }
  }
  let view;
  try {
    switch (state.view) {
      case 'admin':     view = await viewAdmin(); break;
      case 'overview':  view = await viewOverview(); break;
      case 'activity':  view = await viewActivity(); break;
      case 'contacts':  view = await viewContacts(); break;
      case 'leads':     view = await viewLeads(); break;
      case 'calls':     view = await viewCalls(); break;
      case 'bookings':  view = await viewBookings(); break;
      case 'messages':  view = await viewMessages(); break;
      case 'billing':   view = await viewBilling(); break;
      case 'connect':   view = await viewConnect(); break;
      case 'blasts':    view = await viewBlasts(); break;
      case 'nudges':    view = await viewNudges(); break;
      case 'settings':  view = await viewSettings(); break;
      case 'booking_admin': view = state.isAdmin ? await viewBookingAdmin() : await viewOverview(); break;
      case 'analytics': view = state.user?.email === 'ab@goelev8.ai' ? await viewAnalytics() : await viewOverview(); break;
      default:          view = await viewOverview();
    }
  } catch (e) {
    view = el('div', { class: 'panel' }, el('p', { class: 'err' }, 'Error: ' + e.message));
  }
  root.appendChild(shell(view));
}

// Handle credits=success redirect
const params = new URLSearchParams(window.location.search);
if (params.get('credits') === 'success') {
  toast('Payment received! Credits will appear shortly.');
  history.replaceState({}, '', '/');
}
if (params.get('connect') === 'done') {
  toast('Stripe Connect onboarding complete!');
  history.replaceState({}, '', '/');
}

render();
