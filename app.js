// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
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
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

const state = {
  token: localStorage.getItem('ge8_token') || null,
  user: null,
  client: null,
  isAdmin: false,
  impersonating: localStorage.getItem('ge8_impersonate') || null,
  view: 'dashboard'
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

// Stash a tiny snapshot of the impersonated client's basic info so the
// header can render the right name + logo + Twilio number even when
// /api/portal/me hasn't returned yet (or returns null due to a transient
// error). Cleared on stop-impersonate.
function setImpersonation(clientId, clientObj) {
  if (clientId) {
    state.impersonating = clientId;
    localStorage.setItem('ge8_impersonate', clientId);
    if (clientObj) {
      try {
        localStorage.setItem('ge8_impersonate_meta', JSON.stringify({
          id: clientId,
          name: clientObj.name || null,
          twilio_phone_number: clientObj.twilio_phone_number || null,
          logo_url: clientObj.logo_url || null,
          brand_color: clientObj.brand_color || null
        }));
      } catch {}
    }
  } else {
    state.impersonating = null;
    localStorage.removeItem('ge8_impersonate');
    localStorage.removeItem('ge8_impersonate_meta');
  }
  state.client = null;
  state.view = 'dashboard';
}

function ge8ImpersonateMeta() {
  try {
    const raw = localStorage.getItem('ge8_impersonate_meta');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ============================================================
// LOGIN VIEW
// ============================================================
function renderLogin() {
  const box = el('div', { class: 'box' });
  const errBox = el('div');
  // iOS-friendly input attributes:
  //   - inputmode + autocapitalize/autocorrect avoid the keyboard
  //     fighting with the form
  //   - autocomplete hints let the keychain pre-fill
  //   - touch-action: manipulation turns off iOS double-tap-to-zoom
  //     delay so taps register on the first touch
  //   - NO autofocus: setting autofocus on a freshly-mounted input
  //     during page transition is exactly the race that makes the
  //     keyboard never appear on the first tap on iOS PWA standalone.
  const emailInput = el('input', {
    type: 'email',
    name: 'email',
    placeholder: 'you@example.com',
    required: true,
    autocomplete: 'username',
    inputmode: 'email',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    style: 'touch-action: manipulation;'
  });
  const pwInput = el('input', {
    type: 'password',
    name: 'password',
    placeholder: '••••••••',
    required: true,
    autocomplete: 'current-password',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    style: 'touch-action: manipulation;'
  });

  // Tapping anywhere on the email field group should focus the input.
  // Also catches the case where the field <label> is tapped.
  const focusEmail = () => { try { emailInput.focus(); } catch {} };
  const focusPw    = () => { try { pwInput.focus();    } catch {} };

  const form = el('form', {
    autocomplete: 'on',
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
    el('div', { class: 'field', onclick: focusEmail },
      el('label', { onclick: focusEmail }, 'Email'),
      emailInput
    ),
    el('div', { class: 'field', onclick: focusPw },
      el('label', { onclick: focusPw }, 'Password'),
      pwInput
    ),
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
  state.clientError = r.client_error || null;
  if (r.client_error) {
    console.warn('[portal/me] client_error:', r.client_error);
  }
}

// ============================================================
// SHELL
// ============================================================

// Inline SVG icons for the 5-tab nav. Stroke-only feather-style glyphs
// that inherit currentColor so the active-tab teal works automatically.
function tabIcon(name) {
  const svg = (paths, viewBox = '0 0 24 24') => {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('width', '22');
    s.setAttribute('height', '22');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    }
    return s;
  };
  switch (name) {
    case 'home':   return svg(['M3 12 12 4l9 8', 'M5 10v10h14V10']);
    case 'phone':  return svg(['M5 4h4l2 5-3 2a14 14 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 6a2 2 0 0 1 2-2z']);
    case 'chat':   return svg(['M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z']);
    case 'person': return svg(['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']);
    case 'gear':   return svg([
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'
    ]);
    case 'menu':   return svg(['M4 6h16', 'M4 12h16', 'M4 18h16']);
  }
  return svg([]);
}

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home'   },
  { id: 'calls',     label: 'Calls',     icon: 'phone'  },
  { id: 'messages',  label: 'Messages',  icon: 'chat'   },
  { id: 'contacts',  label: 'Contacts',  icon: 'person' },
  { id: 'settings',  label: 'Settings',  icon: 'gear'   }
];

function shell(content) {
  const closeNav = () => document.body.classList.remove('nav-open');

  // We're "in a client context" whenever either (a) state.client was
  // successfully fetched from /api/portal/me, or (b) admin has picked a
  // client to impersonate. The state.impersonating fallback keeps the
  // nav rendering even if /me returns null due to a schema or transient
  // DB issue.
  const inClientContext = !!(state.client || state.impersonating);

  // Per-client branding falls back to cached impersonation metadata if
  // /api/portal/me hasn't returned yet (or returned client: null).
  const meta = state.impersonating ? ge8ImpersonateMeta() : null;
  const clientName  = state.client?.name                || meta?.name                || (state.impersonating ? 'Switching client…' : '');
  const clientPhone = state.client?.twilio_phone_number || meta?.twilio_phone_number || '';
  const clientLogo  = state.client?.logo_url            || meta?.logo_url            || null;

  // Header brand: client logo when in a client context, GoElev8 logo otherwise.
  const makeBrandLogo = () => inClientContext && clientLogo
    ? el('div', { class: 'logo client-logo' }, el('img', { src: clientLogo, alt: clientName || 'Client logo' }))
    : el('div', { class: 'logo' }, el('img', { src: '/logo.png', alt: 'GoElev8.AI' }));
  const brandName = inClientContext ? (clientName || 'GoElev8.AI') : 'GoElev8.AI';

  // Install pill — sits in the mobile header next to the brand.
  const installState = window.ge8InstallState || { canInstall: false, mode: null };
  const installPill = installState.canInstall
    ? el('button', {
        class: 'install-pill',
        'aria-label': 'Install GoElev8 app',
        onclick: () => {
          if (installState.mode === 'native' && deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.finally(() => {
              deferredInstallPrompt = null;
              window.ge8InstallState = { canInstall: false, mode: null };
              render();
            });
          } else {
            ge8ShowIosSheet();
          }
        }
      }, 'Install')
    : null;

  // Mobile header — hamburger only for admins (regular clients have the
  // 5-tab bottom nav and don't need a drawer).
  const mobileHeader = el('div', { class: 'mobile-header' },
    state.isAdmin
      ? el('button', {
          class: 'nav-toggle',
          'aria-label': 'Menu',
          onclick: () => document.body.classList.toggle('nav-open')
        }, el('span', {}), el('span', {}), el('span', {}))
      : null,
    el('div', { class: 'mobile-brand' },
      makeBrandLogo(),
      el('span', {}, brandName)
    ),
    installPill
  );
  const navBackdrop = el('div', { class: 'nav-backdrop', onclick: closeNav });

  const tabBtn = (tab, extraClass) => el('button', {
    class: 'tab-btn ' + (extraClass || '') + (state.view === tab.id ? ' active' : ''),
    'aria-label': tab.label,
    onclick: () => { state.view = tab.id; closeNav(); render(); }
  },
    tabIcon(tab.icon),
    el('span', { class: 'tab-label' }, tab.label)
  );

  const sidebarTabs = inClientContext
    ? el('div', { class: 'nav' }, ...TABS.map((t) => tabBtn(t, 'sidebar-tab')))
    : null;

  const adminSection = state.isAdmin
    ? el('div', { class: 'admin-section' },
        el('div', { class: 'admin-label' }, 'ADMIN'),
        el('button', {
          class: 'tab-btn admin-master' + (state.view === 'admin' ? ' active' : ''),
          onclick: () => { state.view = 'admin'; closeNav(); render(); }
        }, tabIcon('gear'), el('span', { class: 'tab-label' }, 'Master Admin')),
        state.impersonating
          ? el('button', {
              class: 'btn-stop-impersonate',
              onclick: () => { setImpersonation(null); render(); }
            }, '× Stop impersonating')
          : null
      )
    : null;

  const banner = state.isAdmin && state.impersonating
    ? el('div', { class: 'impersonation-banner' },
        el('span', {}, 'Viewing as '),
        el('strong', {}, clientName || '…'),
        el('button', { class: 'link', onclick: () => { setImpersonation(null); render(); } }, 'Exit'))
    : null;

  // Bottom tab bar for mobile — always 5 tabs in client context.
  const bottomNav = inClientContext
    ? el('nav', { class: 'bottom-nav' }, ...TABS.map((t) => tabBtn(t, 'bnav-btn')))
    : null;

  // "Powered by GoElev8.AI" footer required on every page.
  const poweredFooter = el('div', { class: 'powered-footer' },
    'Powered by ',
    el('a', { href: 'https://goelev8.ai', target: '_blank', rel: 'noopener' }, 'GoElev8.AI')
  );

  return el('div', { class: 'app' + (state.isAdmin ? ' is-admin' : '') + (inClientContext ? ' has-bottom-nav' : '') },
    el('aside', { class: 'sidebar' },
      el('div', { class: 'brand' },
        makeBrandLogo(),
        el('div', { class: 'name' }, brandName,
          el('small', {}, state.isAdmin ? 'Master Admin' : 'Client Portal'))
      ),
      inClientContext
        ? el('div', { class: 'client-pill' },
            el('div', { class: 'name' }, clientName || ''),
            el('div', { class: 'num' }, clientPhone || 'No number assigned')
          )
        : null,
      sidebarTabs,
      adminSection,
      el('button', { class: 'signout', onclick: logout }, 'Sign out'),
      el('div', { class: 'sidebar-footer' },
        'Powered by ',
        el('a', { href: 'https://goelev8.ai', target: '_blank', rel: 'noopener' }, 'GoElev8.AI')
      )
    ),
    navBackdrop,
    el('main', { class: 'main' }, mobileHeader, banner, content, poweredFooter),
    bottomNav
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
    const b = await api('/api/portal/billing');
    cards.appendChild(card('Sent This Month', b.sent_this_month, 'Outbound SMS'));
    const [{ data: contacts }, bookings] = [{ data: null }, null];
    const c = await api('/api/portal/crm?action=contacts');
    cards.appendChild(card('Contacts', c.contacts.length, 'Total in CRM'));
    const bk = await api('/api/portal/crm?action=bookings');
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
// BOOKINGS
// ============================================================
async function viewBookings() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Bookings'),
    el('button', { class: 'btn', onclick: () => openBookingModal() }, '+ New booking')
  ));
  const panel = el('div', { class: 'panel' });
  wrap.appendChild(panel);
  try {
    const r = await api('/api/portal/crm?action=bookings');
    if (!r.bookings.length) {
      panel.appendChild(el('p', { class: 'muted' }, 'No bookings yet.'));
      return wrap;
    }
    panel.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Service'), el('th', {}, 'Contact'),
        el('th', {}, 'Status'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.bookings.map(b =>
        el('tr', {},
          el('td', {}, new Date(b.starts_at).toLocaleString()),
          el('td', {}, b.service),
          el('td', {}, b.contacts?.name || '—'),
          el('td', {}, el('span', { class: 'badge' }, b.status)),
          el('td', {}, el('button', { class: 'btn sm danger', onclick: async () => {
            if (!confirm('Delete booking?')) return;
            await api('/api/portal/crm?action=bookings', { method: 'DELETE', body: { id: b.id } });
            render();
          }}, 'Delete'))
        )
      ))
    ));
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

async function openBookingModal() {
  const c = await api('/api/portal/crm?action=contacts');
  const contactSel = el('select', {},
    el('option', { value: '' }, '— none —'),
    ...c.contacts.map(ct => el('option', { value: ct.id }, `${ct.name} (${ct.phone})`))
  );
  const service = el('input', { placeholder: 'Consultation, etc.' });
  const startsAt = el('input', { type: 'datetime-local' });
  const status = el('select', {},
    ...['scheduled','confirmed','completed','cancelled'].map(s => el('option', { value: s }, s))
  );
  const notes = el('textarea', {});
  const close = () => bg.remove();
  const save = async () => {
    try {
      await api('/api/portal/crm?action=bookings', { method: 'POST', body: {
        contact_id: contactSel.value || null, service: service.value,
        starts_at: new Date(startsAt.value).toISOString(),
        status: status.value, notes: notes.value
      }});
      close(); render();
    } catch (e) { toast(e.message, true); }
  };
  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'New booking'),
    el('div', { class: 'field' }, el('label', {}, 'Contact'), contactSel),
    el('div', { class: 'field' }, el('label', {}, 'Service'), service),
    el('div', { class: 'field' }, el('label', {}, 'Starts at'), startsAt),
    el('div', { class: 'field' }, el('label', {}, 'Status'), status),
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
// MESSAGES (SMS inbox + composer)
// ============================================================
async function viewMessages() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Messages')));

  const layout = el('div', { class: 'chat-layout' });
  wrap.appendChild(layout);

  const list = el('div', { class: 'chat-list' });
  const pane = el('div', { class: 'chat-pane' });
  layout.appendChild(list);
  layout.appendChild(pane);

  const [contactsR, msgsR] = await Promise.all([
    api('/api/portal/crm?action=contacts'),
    api('/api/portal/messages')
  ]);
  const contacts = contactsR.contacts;
  const allMsgs = msgsR.messages;

  // Group last message per contact
  const lastByContact = {};
  for (const m of allMsgs) {
    if (!m.contact_id) continue;
    if (!lastByContact[m.contact_id]) lastByContact[m.contact_id] = m;
  }

  if (!contacts.length) {
    list.appendChild(el('div', { style: 'padding:14px; color:var(--muted)' }, 'No contacts yet.'));
  }

  let activeId = state.activeContactId || contacts[0]?.id || null;

  for (const c of contacts) {
    const last = lastByContact[c.id];
    const item = el('div', {
      class: 'item' + (c.id === activeId ? ' active' : ''),
      onclick: () => { state.activeContactId = c.id; render(); }
    },
      el('div', { class: 'name' }, c.name),
      el('div', { class: 'preview' }, last?.body || c.phone)
    );
    list.appendChild(item);
  }

  if (!activeId) {
    pane.appendChild(el('div', { style: 'padding:30px; color:var(--muted)' }, 'Select a contact to start messaging.'));
    return wrap;
  }

  const contact = contacts.find(c => c.id === activeId);
  pane.appendChild(el('div', { class: 'chat-header' },
    el('strong', {}, contact.name), ' ', el('span', { class: 'muted' }, contact.phone)
  ));

  const body = el('div', { class: 'chat-body' });
  const thread = allMsgs.filter(m => m.contact_id === activeId).slice().reverse();
  for (const m of thread) {
    body.appendChild(el('div', { class: 'bubble ' + (m.direction === 'inbound' ? 'in' : 'out') },
      el('div', {}, m.body),
      el('div', { class: 'ts' }, new Date(m.created_at).toLocaleString() + (m.status ? ` · ${m.status}` : ''))
    ));
  }
  pane.appendChild(body);
  setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);

  // Composer
  const ta = el('textarea', { placeholder: 'Type a message…' });
  const suggestionsRow = el('div', { class: 'suggestions' });
  const composer = el('div', { class: 'composer' },
    suggestionsRow,
    el('div', { class: 'composer-row' },
      ta,
      el('button', { class: 'btn ghost', onclick: async () => {
        suggestionsRow.innerHTML = '<span class="muted">Generating…</span>';
        try {
          const r = await api('/api/portal/ai-suggest', { method: 'POST', body: { contact_id: activeId } });
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
      await api('/api/portal/messages', { method: 'POST', body: { contact_id: activeId, body: text } });
      ta.value = '';
      render();
    } catch (e) {
      if (e.message === 'insufficient_credits') toast('Out of credits — top up to send.', true);
      else toast(e.message, true);
    }
  }
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
// SETTINGS
// ============================================================
async function viewSettings() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Settings')));

  // ----- Account info -----
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('h2', {}, 'Account'));
  panel.appendChild(el('p', {}, `Email: ${state.user?.email || ''}`));
  panel.appendChild(el('p', {}, `Client: ${state.client?.name || ''}`));
  panel.appendChild(el('p', { class: 'muted' }, state.client?.twilio_phone_number ? `Twilio number: ${state.client.twilio_phone_number}` : 'No Twilio number assigned'));
  wrap.appendChild(panel);

  // ----- Credits & Billing (embedded) -----
  try {
    const billingWrap = await viewBilling();
    // Strip the inner topbar so it merges visually with this Settings page.
    const inner = billingWrap.querySelector('.topbar');
    if (inner) inner.remove();
    const sectionHead = el('div', { class: 'topbar', style: 'margin-top:8px' },
      el('h2', {}, 'Credits & Billing')
    );
    wrap.appendChild(sectionHead);
    while (billingWrap.firstChild) wrap.appendChild(billingWrap.firstChild);
  } catch (e) {
    wrap.appendChild(el('div', { class: 'panel' },
      el('h2', {}, 'Credits & Billing'),
      el('p', { class: 'err' }, e.message)
    ));
  }

  // ----- Payments / Stripe Connect (embedded) -----
  try {
    const connectWrap = await viewConnect();
    const inner = connectWrap.querySelector('.topbar');
    if (inner) inner.remove();
    const sectionHead = el('div', { class: 'topbar', style: 'margin-top:8px' },
      el('h2', {}, 'Payments — Stripe Connect')
    );
    wrap.appendChild(sectionHead);
    while (connectWrap.firstChild) wrap.appendChild(connectWrap.firstChild);
  } catch (e) {
    wrap.appendChild(el('div', { class: 'panel' },
      el('h2', {}, 'Payments — Stripe Connect'),
      el('p', { class: 'err' }, e.message)
    ));
  }

  // ----- Notification preferences -----
  const notif = el('div', { class: 'panel' });
  notif.appendChild(el('h2', {}, 'Notification preferences'));
  const notifEnabled = el('input', { type: 'checkbox' });
  notifEnabled.checked = (typeof Notification !== 'undefined') && Notification.permission === 'granted';
  notif.appendChild(el('label', { class: 'toggle-row' },
    notifEnabled,
    el('span', {}, 'Push notifications for new leads & bookings')
  ));
  notif.appendChild(el('p', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
    'When enabled, GoElev8 will send a notification the moment a new lead or booking comes in. Works while the app is open or installed to your home screen.'));
  notifEnabled.addEventListener('change', async () => {
    if (notifEnabled.checked) {
      if (typeof Notification === 'undefined') { toast('Notifications not supported on this device', true); notifEnabled.checked = false; return; }
      try {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          notifEnabled.checked = false;
          toast(result === 'denied' ? 'Permission denied — re-enable in browser settings' : 'Permission not granted', true);
        } else {
          toast('Notifications enabled');
        }
      } catch { notifEnabled.checked = false; }
    } else {
      toast('To fully disable, revoke permission in browser settings');
    }
  });
  wrap.appendChild(notif);

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
      el('div', { class: 'card-label' }, label),
      el('div', { class: 'card-value' }, String(value)),
      sub ? el('div', { class: 'card-sub muted' }, sub) : null);
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
    // Build shared per-client action bindings once so the table row
    // and the mobile card can share the same onclick handlers without
    // duplicating logic.
    const buildClient = (c) => {
      const amountInput = el('input', { type: 'number', min: '1', value: '20', style: 'width:70px' });
      const noteInput   = el('input', { type: 'text', placeholder: 'note (optional)', style: 'width:140px' });
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
      const pauseToggle = async () => {
        try {
          await api('/api/admin?action=billing-pause', {
            method: 'POST', body: { client_id: c.id, paused: !c.billing_paused }
          });
          toast(c.billing_paused ? 'Billing resumed' : 'Billing paused');
          await refresh();
        } catch (e) { toast(e.message, true); }
      };
      return { c, amountInput, noteInput, adjust, pauseToggle };
    };

    // ---- Desktop / iPad: table ----
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
        // NOTE: table rows use their own action-button instances so the
        // input state (amount/note) is independent between the table and
        // the mobile card.
        const b = buildClient(c);
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
              setImpersonation(c.id, c); render();
            }}, 'View as'),
            b.amountInput, b.noteInput,
            el('button', { class: 'btn sm btn-success', onclick: () => b.adjust(+1) }, '+ Add'),
            el('button', { class: 'btn sm btn-warn',    onclick: () => b.adjust(-1) }, '− Remove'),
            el('button', {
              class: 'btn sm ' + (c.billing_paused ? 'btn-success' : 'btn-warn'),
              onclick: b.pauseToggle
            }, c.billing_paused ? 'Resume billing' : 'Pause billing')
          )
        );
      }))
    );
    const tableWrap = el('div', { class: 'admin-table-wrap' }, table);
    tableHost.appendChild(tableWrap);

    // ---- Mobile (<=767px): stacked cards, via CSS swap ----
    const cards = el('div', { class: 'admin-cards' },
      ...allClients.map((c) => {
        const b = buildClient(c);
        return el('div', { class: 'admin-card' },
          el('div', { class: 'admin-card-head' },
            el('strong', {}, c.name || '—'),
            c.billing_paused
              ? el('span', { class: 'pill warn' }, 'PAUSED')
              : el('span', { class: 'pill ok' }, 'active')
          ),
          el('div', { class: 'admin-card-row' },
            el('span', {}, 'Slug'),
            el('code', {}, c.slug || '—')
          ),
          el('div', { class: 'admin-card-row' },
            el('span', {}, 'Twilio'),
            el('code', {}, c.twilio_phone_number || '—')
          ),
          el('div', { class: 'admin-card-row' },
            el('span', {}, 'Credits'),
            el('span', {}, String(c.credit_balance ?? 0))
          ),
          el('div', { class: 'admin-card-row' },
            el('span', {}, 'Sent 30d'),
            el('span', {}, String(c.sent_30d || 0))
          ),
          el('div', { class: 'admin-card-credits' },
            b.amountInput,
            b.noteInput,
            el('button', { class: 'btn sm btn-success', onclick: () => b.adjust(+1) }, '+ Add'),
            el('button', { class: 'btn sm btn-warn',    onclick: () => b.adjust(-1) }, '− Remove')
          ),
          el('div', { class: 'admin-card-actions' },
            el('button', { class: 'btn sm', onclick: () => {
              setImpersonation(c.id, c); render();
            }}, 'View as'),
            el('button', {
              class: 'btn sm ' + (c.billing_paused ? 'btn-success' : 'btn-warn'),
              onclick: b.pauseToggle
            }, c.billing_paused ? 'Resume billing' : 'Pause billing')
          )
        );
      })
    );
    tableHost.appendChild(cards);
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
// DASHBOARD (mobile-first overview of leads / bookings / calls)
// ============================================================
function statusBadge(status) {
  const s = (status || '').toLowerCase();
  let cls = 'badge';
  if (['confirmed', 'completed', 'booked', 'active'].includes(s)) cls += ' green';
  else if (['new', 'scheduled', 'pending', 'contacted'].includes(s)) cls += ' yellow';
  else if (['cancelled', 'lost', 'voicemail', 'not interested'].includes(s)) cls += ' red';
  return el('span', { class: cls }, status || '—');
}

function skeleton(rows = 3) {
  const wrap = el('div', { class: 'skeleton-wrap' });
  for (let i = 0; i < rows; i++) wrap.appendChild(el('div', { class: 'skel-row' }));
  return wrap;
}

function emptyState(msg) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'empty-icon' }, '✨'),
    el('div', { class: 'empty-msg' }, msg)
  );
}

function startOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

async function viewDashboard() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Dashboard'),
    el('div', { class: 'muted' }, state.client?.name || '')
  ));

  // ---- Summary stats (top) ----
  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  cards.appendChild(skeleton(1));

  // ---- Recent leads ----
  const leadsPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Recent leads'),
      el('span', { class: 'muted small' }, 'Latest 5')
    ),
    skeleton(3)
  );
  wrap.appendChild(leadsPanel);

  // ---- Upcoming bookings ----
  const bookingsPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Upcoming bookings'),
      el('span', { class: 'muted small' }, 'Next 5')
    ),
    skeleton(3)
  );
  wrap.appendChild(bookingsPanel);

  // ---- Activity feed ----
  const feedPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Recent activity'),
    skeleton(5)
  );
  wrap.appendChild(feedPanel);

  try {
    const [billingR, leadsR, bookingsR, callsR] = await Promise.all([
      api('/api/portal/billing').catch(() => null),
      api('/api/portal/crm?action=leads').catch(() => ({ leads: [] })),
      api('/api/portal/crm?action=bookings').catch(() => ({ bookings: [] })),
      api('/api/portal/crm?action=calls').catch(() => ({ calls: [] }))
    ]);
    const monthStart = new Date(startOfMonthISO()).getTime();
    const inMonth = (ts) => new Date(ts).getTime() >= monthStart;
    const leadsMonth    = (leadsR.leads    || []).filter(l => inMonth(l.created_at)).length;
    const bookingsMonth = (bookingsR.bookings || []).filter(b => inMonth(b.created_at || b.starts_at)).length;
    const smsMonth      = billingR?.sent_this_month ?? 0;
    const callsMonth    = (callsR.calls    || []).filter(c => inMonth(c.created_at)).length;

    cards.innerHTML = '';
    cards.appendChild(card('Total leads', leadsMonth, 'This month', 'accent'));
    cards.appendChild(card('Bookings', bookingsMonth, 'This month'));
    cards.appendChild(card('SMS sent', smsMonth, 'This month'));
    cards.appendChild(card('Calls', callsMonth, 'This month'));

    // Cache a tiny snapshot for offline.html.
    window.ge8WriteSnapshot?.({
      leads_month: leadsMonth,
      bookings_month: bookingsMonth,
      calls_month: callsMonth,
      sms_month: smsMonth
    });

    // Recent leads — list (top 5 by created_at)
    leadsPanel.innerHTML = '';
    leadsPanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Recent leads'),
      el('span', { class: 'muted small' }, 'Latest 5')
    ));
    const recentLeads = (leadsR.leads || []).slice(0, 5);
    if (!recentLeads.length) {
      leadsPanel.appendChild(emptyState('No leads yet. Vapi calls and web form submissions will appear here.'));
    } else {
      const list = el('div', { class: 'lead-list' });
      for (const l of recentLeads) {
        list.appendChild(el('div', { class: 'lead-row' },
          el('div', { class: 'lead-main' },
            el('div', { class: 'lead-name' }, l.name || '—'),
            el('div', { class: 'lead-meta muted' },
              [l.phone, l.source].filter(Boolean).join(' · ')
            )
          ),
          el('div', { class: 'lead-side' },
            statusBadge(l.status),
            el('div', { class: 'lead-time muted' }, new Date(l.created_at).toLocaleDateString())
          )
        ));
      }
      leadsPanel.appendChild(list);
    }

    // Upcoming bookings — list (next 5 by starts_at, from now)
    bookingsPanel.innerHTML = '';
    bookingsPanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Upcoming bookings'),
      el('span', { class: 'muted small' }, 'Next 5')
    ));
    const now = Date.now();
    const upcoming = (bookingsR.bookings || [])
      .filter(b => b.starts_at && new Date(b.starts_at).getTime() >= now)
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
      .slice(0, 5);
    if (!upcoming.length) {
      bookingsPanel.appendChild(emptyState('No upcoming bookings. Confirmed appointments will appear here.'));
    } else {
      const list = el('div', { class: 'lead-list' });
      for (const b of upcoming) {
        list.appendChild(el('div', { class: 'lead-row' },
          el('div', { class: 'lead-main' },
            el('div', { class: 'lead-name' }, b.service || 'Appointment'),
            el('div', { class: 'lead-meta muted' }, b.contacts?.name || b.contacts?.phone || '—')
          ),
          el('div', { class: 'lead-side' },
            statusBadge(b.status),
            el('div', { class: 'lead-time muted' }, new Date(b.starts_at).toLocaleString())
          )
        ));
      }
      bookingsPanel.appendChild(list);
    }

    // Recent activity feed — last 5 across leads/bookings/calls
    const events = [
      ...(leadsR.leads || []).map(l => ({ ts: l.created_at, type: 'lead', label: `New lead: ${l.name}`, sub: l.source || '' })),
      ...(bookingsR.bookings || []).map(b => ({ ts: b.created_at || b.starts_at, type: 'booking', label: `Booking · ${b.service || 'appt'}`, sub: new Date(b.starts_at).toLocaleString() })),
      ...(callsR.calls || []).map(c => ({ ts: c.created_at, type: 'call', label: `Call · ${c.outcome || 'received'}`, sub: c.caller_phone || '' }))
    ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 5);

    feedPanel.innerHTML = '';
    feedPanel.appendChild(el('h2', {}, 'Recent activity'));
    if (!events.length) {
      feedPanel.appendChild(emptyState('No activity yet — your first lead, booking, or call will land here.'));
    } else {
      const list = el('div', { class: 'feed' });
      for (const e of events) {
        list.appendChild(el('div', { class: 'feed-row' },
          el('div', { class: 'feed-type ' + e.type }, e.type),
          el('div', { class: 'feed-body' },
            el('div', { class: 'feed-label' }, e.label),
            el('div', { class: 'feed-sub muted' }, e.sub)
          ),
          el('div', { class: 'feed-time muted' }, new Date(e.ts).toLocaleDateString())
        ));
      }
      feedPanel.appendChild(list);
    }
  } catch (e) {
    cards.innerHTML = '';
    cards.appendChild(el('div', { class: 'err' }, e.message));
  }

  return wrap;
}

// ============================================================
// LEADS
// ============================================================
async function viewLeads() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Leads'),
    el('div', { class: 'muted' }, 'Pipeline tracker')
  ));

  const filterBar = el('div', { class: 'filter-bar' });
  const STATUSES = ['All', 'New', 'Contacted', 'Booked', 'Lost'];
  let activeFilter = state.leadsFilter || 'All';
  const panel = el('div', { class: 'panel' });

  const renderList = async () => {
    panel.innerHTML = '';
    panel.appendChild(skeleton(4));
    try {
      const qs = activeFilter === 'All' ? '' : `&status=${encodeURIComponent(activeFilter)}`;
      const r = await api('/api/portal/crm?action=leads' + qs);
      panel.innerHTML = '';
      if (!r.leads.length) {
        panel.appendChild(emptyState('No leads yet. They appear here as soon as Vapi or your web forms send them in.'));
        return;
      }
      const list = el('div', { class: 'lead-list' });
      for (const l of r.leads) {
        const row = el('div', { class: 'lead-row' },
          el('div', { class: 'lead-main' },
            el('div', { class: 'lead-name' }, l.name),
            el('div', { class: 'lead-meta muted' },
              [l.phone, l.email, l.source].filter(Boolean).join(' · ')
            )
          ),
          el('div', { class: 'lead-side' },
            statusBadge(l.status),
            el('div', { class: 'lead-time muted' }, new Date(l.created_at).toLocaleDateString())
          )
        );
        row.addEventListener('click', () => {
          const existing = row.nextSibling;
          if (existing && existing.classList?.contains('lead-detail')) { existing.remove(); return; }
          const detail = el('div', { class: 'lead-detail' },
            el('div', {}, el('strong', {}, 'Phone: '), l.phone || '—'),
            el('div', {}, el('strong', {}, 'Email: '), l.email || '—'),
            el('div', {}, el('strong', {}, 'Source: '), l.source || '—'),
            el('div', {}, el('strong', {}, 'Created: '), new Date(l.created_at).toLocaleString()),
            l.notes ? el('div', { class: 'muted', style: 'margin-top:6px' }, l.notes) : null
          );
          row.after(detail);
        });
        list.appendChild(row);
      }
      panel.appendChild(list);
    } catch (e) {
      panel.innerHTML = '';
      panel.appendChild(el('div', { class: 'err' }, e.message));
    }
  };

  for (const s of STATUSES) {
    const b = el('button', {
      class: 'chip' + (s === activeFilter ? ' active' : ''),
      onclick: () => {
        activeFilter = s; state.leadsFilter = s;
        for (const c of filterBar.querySelectorAll('.chip')) c.classList.remove('active');
        b.classList.add('active');
        renderList();
      }
    }, s);
    filterBar.appendChild(b);
  }
  wrap.appendChild(filterBar);
  wrap.appendChild(panel);
  renderList();
  return wrap;
}

// ============================================================
// VAPI CALLS
// ============================================================
async function viewCalls() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Calls'),
    el('div', { class: 'muted' }, 'AI voice answer log')
  ));
  const panel = el('div', { class: 'panel' });
  panel.appendChild(skeleton(5));
  wrap.appendChild(panel);

  try {
    const r = await api('/api/portal/crm?action=calls');
    panel.innerHTML = '';
    if (!r.calls.length) {
      panel.appendChild(emptyState('No calls yet. Once Vapi handles a call it will show up here with the transcript.'));
      return wrap;
    }
    const list = el('div', { class: 'call-list' });
    for (const c of r.calls) {
      const mins = Math.floor((c.duration_seconds || 0) / 60);
      const secs = (c.duration_seconds || 0) % 60;
      const dur = `${mins}:${String(secs).padStart(2, '0')}`;
      const row = el('div', { class: 'call-row' },
        el('div', { class: 'call-main' },
          el('div', { class: 'call-phone' }, c.caller_phone || 'Unknown caller'),
          el('div', { class: 'call-meta muted' },
            new Date(c.created_at).toLocaleString() + ' · ' + dur
          )
        ),
        el('div', { class: 'call-side' }, statusBadge(c.outcome))
      );
      row.addEventListener('click', () => {
        const next = row.nextSibling;
        if (next && next.classList?.contains('call-transcript')) { next.remove(); return; }
        const t = el('div', { class: 'call-transcript' },
          c.transcript || el('span', { class: 'muted' }, 'No transcript captured.')
        );
        row.after(t);
      });
      list.appendChild(row);
    }
    panel.appendChild(list);
  } catch (e) {
    panel.innerHTML = '';
    panel.appendChild(el('div', { class: 'err' }, e.message));
  }
  return wrap;
}

// ============================================================
// ROUTER / RENDER
// ============================================================
async function render() {
  const root = $('#app');
  if (activityPoll && state.view !== 'activity') { clearInterval(activityPoll); activityPoll = null; }
  root.innerHTML = '';
  if (!state.token) { root.appendChild(renderLogin()); return; }
  if (!state.user) {
    try { await loadMe(); } catch { logout(); return; }
  }
  // Admins land on the admin view by default unless they pick a client.
  if (state.isAdmin && !state.impersonating && state.view !== 'admin') {
    state.view = 'admin';
  }
  // Reload client context when impersonation toggles.
  if (state.isAdmin && state.impersonating && !state.client) {
    try { await loadMe(); } catch (e) { toast('Impersonation failed: ' + e.message, true); }
  }
  // If admin is impersonating but we don't have cached metadata for the
  // impersonated client (e.g. the session was started before metadata was
  // captured), backfill it once from the admin client list so the header
  // shows the correct name + Twilio number even if /me returns null.
  if (state.isAdmin && state.impersonating && !ge8ImpersonateMeta()) {
    api('/api/admin?action=list-clients').then((r) => {
      const found = (r.clients || []).find((x) => x.id === state.impersonating);
      if (found) {
        try {
          localStorage.setItem('ge8_impersonate_meta', JSON.stringify({
            id: found.id,
            name: found.name || null,
            twilio_phone_number: found.twilio_phone_number || null,
            logo_url: found.logo_url || null,
            brand_color: found.brand_color || null
          }));
          render();
        } catch {}
      }
    }).catch(() => {});
  }
  // Legacy view IDs from older deeplinks/manifest shortcuts get folded
  // into the new 5-tab shape so old bookmarks still land somewhere sane.
  const LEGACY_REDIRECTS = {
    overview:  'dashboard',
    activity:  'dashboard',
    leads:     'dashboard',
    bookings:  'dashboard',
    billing:   'settings',
    connect:   'settings'
  };
  if (LEGACY_REDIRECTS[state.view]) state.view = LEGACY_REDIRECTS[state.view];

  let view;
  try {
    switch (state.view) {
      case 'admin':     view = await viewAdmin();    break;
      case 'dashboard': view = await viewDashboard(); break;
      case 'calls':     view = await viewCalls();    break;
      case 'messages':  view = await viewMessages(); break;
      case 'contacts':  view = await viewContacts(); break;
      case 'settings':  view = await viewSettings(); break;
      default:          view = await viewDashboard();
    }
  } catch (e) {
    view = el('div', { class: 'panel' }, el('p', { class: 'err' }, 'Error: ' + e.message));
  }
  root.appendChild(shell(view));
}

// Handle credits=success redirect AND deep-link ?view= for the PWA
// home-screen shortcuts in manifest.json.
const params = new URLSearchParams(window.location.search);
const initialView = params.get('view');
if (initialView) {
  state.view = initialView;
  history.replaceState({}, '', '/');
}
if (params.get('credits') === 'success') {
  toast('Payment received! Credits will appear shortly.');
  history.replaceState({}, '', '/');
}
if (params.get('connect') === 'done') {
  toast('Stripe Connect onboarding complete!');
  history.replaceState({}, '', '/');
}

render();

// ============================================================
// PWA: service worker, install prompt, realtime notifications
// ============================================================

// Register service worker (production only — avoids local-dev cache pain).
// We register, then immediately call .update() so users pick up new
// service-worker.js content on every page load instead of waiting for the
// browser's lazy ~24h refresh.
//
// IMPORTANT: only auto-reload on controllerchange when there was ALREADY
// a controller before this page load. Without this guard, the very first
// SW install (where controller goes from null → set) triggers an
// auto-reload during the user's first interaction with the page. On iOS
// Safari that race makes the login inputs lose focus and look "broken"
// — the user has to close + reopen the app several times before the
// reload settles. By gating on the previous controller we only reload
// when we're upgrading from an older SW.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', async () => {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register('/service-worker.js');
      reg.update().catch(() => {});
      if (hadController) {
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
      }
    } catch (err) {
      console.warn('SW register failed', err);
    }
  });
}

// "Add to Home Screen" install prompt.
//
// Rules:
//   - Show once per device (localStorage flag)
//   - Wait ~30 seconds after page load before showing (don't nag on first touch)
//   - Don't show if already running in standalone mode (already installed)
//   - On Chromium/Android: use the native beforeinstallprompt flow
//   - On iOS Safari: beforeinstallprompt doesn't exist, so show a manual
//     "Tap Share → Add to Home Screen" instruction panel instead
let deferredInstallPrompt = null;

function ge8IsStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari legacy
    window.navigator.standalone === true
  );
}
function ge8IsIOS() {
  const ua = navigator.userAgent || '';
  const iosDevice = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iosDevice && isSafari;
}
function ge8HideInstallBanner() {
  const b = document.querySelector('.install-banner');
  if (b) b.remove();
}
function ge8ShowInstallBanner(mode) {
  if (document.querySelector('.install-banner')) return;
  if (localStorage.getItem('ge8_install_dismissed')) return;
  if (ge8IsStandalone()) return;

  const dismiss = () => {
    localStorage.setItem('ge8_install_dismissed', '1');
    ge8HideInstallBanner();
  };

  const installBtn = mode === 'native'
    ? el('button', { class: 'btn sm', onclick: async () => {
        ge8HideInstallBanner();
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        try { await deferredInstallPrompt.userChoice; } catch {}
        deferredInstallPrompt = null;
        localStorage.setItem('ge8_install_dismissed', '1');
      }}, 'Install')
    : null;

  const label = mode === 'native'
    ? 'Install GoElev8 Portal for quick access'
    : 'Install: tap the Share button, then "Add to Home Screen"';

  const banner = el('div', { class: 'install-banner' },
    el('span', {}, label),
    installBtn,
    el('button', { class: 'btn sm ghost', onclick: dismiss }, 'Not now')
  );
  document.body.appendChild(banner);
}

// Shared install state. shell() reads this on every render to decide
// whether the "+ Install" pill should appear in the mobile header.
window.ge8InstallState = { canInstall: false, mode: null };

function ge8UpdateInstallState() {
  if (ge8IsStandalone()) {
    window.ge8InstallState = { canInstall: false, mode: null };
  } else if (deferredInstallPrompt) {
    window.ge8InstallState = { canInstall: true, mode: 'native' };
  } else if (ge8IsIOS()) {
    window.ge8InstallState = { canInstall: true, mode: 'ios' };
  } else {
    window.ge8InstallState = { canInstall: false, mode: null };
  }
}
ge8UpdateInstallState();

// Capture the native prompt event as soon as Chromium fires it. If the
// 30-second timer has already elapsed, show the post-delay banner too;
// always re-render so the header install pill appears immediately.
let ge8InstallTimerDone = false;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  ge8UpdateInstallState();
  if (typeof render === 'function') render();
  if (ge8InstallTimerDone) ge8ShowInstallBanner('native');
});

// Clear the flag once the user actually installs, so future devices (e.g.
// on a new phone) can still see the prompt.
window.addEventListener('appinstalled', () => {
  localStorage.setItem('ge8_install_dismissed', '1');
  deferredInstallPrompt = null;
  ge8UpdateInstallState();
  ge8HideInstallBanner();
  if (typeof render === 'function') render();
});

// iOS "Add to Home Screen" bottom sheet. Shown when the install pill is
// tapped on iOS Safari, or from the 30s install banner. Content is the
// step-by-step Share → Add to Home Screen flow.
function ge8ShowIosSheet() {
  if (document.querySelector('.ios-sheet-bg')) return;
  const close = () => bg.remove();
  const sheet = el('div', { class: 'ios-sheet', onclick: (e) => e.stopPropagation() },
    el('div', { class: 'handle' }),
    el('h2', {}, 'Install GoElev8 Portal'),
    el('p', {}, 'Get quick access from your home screen — works offline, launches like an app.'),
    el('ol', {},
      el('li', {},
        'Tap the Share button ',
        el('span', { class: 'share-glyph', 'aria-label': 'Share icon' }, '↑'),
        ' in the Safari toolbar.'
      ),
      el('li', {}, 'Scroll down and tap ', el('strong', {}, 'Add to Home Screen'), '.'),
      el('li', {}, 'Tap ', el('strong', {}, 'Add'), ' in the top-right corner.')
    ),
    el('button', { class: 'close', onclick: close }, 'Got it')
  );
  const bg = el('div', { class: 'ios-sheet-bg', onclick: close }, sheet);
  document.body.appendChild(bg);
}

// 30-second delay after load.
window.addEventListener('load', () => {
  setTimeout(() => {
    ge8InstallTimerDone = true;
    if (ge8IsStandalone()) return;
    if (localStorage.getItem('ge8_install_dismissed')) return;
    if (deferredInstallPrompt) {
      ge8ShowInstallBanner('native');
    } else if (ge8IsIOS()) {
      ge8ShowInstallBanner('ios');
    }
    // On browsers that don't support PWA install at all (e.g. desktop
    // Firefox) we simply never show the banner.
  }, 30_000);
});

// Write a tiny snapshot to localStorage on every successful dashboard
// render so offline.html has something to display. Kept intentionally
// small (< 1 KB) and only updated from viewDashboard's data fetch.
window.ge8WriteSnapshot = (s) => {
  try {
    localStorage.setItem('ge8_last_snapshot', JSON.stringify({
      leads_month: s.leads_month,
      bookings_month: s.bookings_month,
      calls_month: s.calls_month,
      ts: Date.now()
    }));
  } catch {}
};

// Live notifications via Supabase Realtime: subscribes to INSERTs on leads
// + bookings for the current client and shows a system notification + toast.
let realtimeChannel = null;
let supabaseBrowser = null;

async function ensureSupabaseBrowser() {
  if (supabaseBrowser) return supabaseBrowser;
  const r = await api('/api/portal/me').catch(() => null);
  const url = r?.supabase?.url, anon = r?.supabase?.anon_key;
  if (!url || !anon) return null;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  supabaseBrowser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${state.token}` } },
    realtime: { params: { eventsPerSecond: 5 } }
  });
  return supabaseBrowser;
}

async function notify(title, body) {
  toast(`${title} — ${body}`);
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  if (Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration?.();
  const opts = { body, icon: '/icon-192.png', badge: '/icon-192.png' };
  if (reg) reg.showNotification(title, opts);
  else new Notification(title, opts);
}

async function startRealtime() {
  if (realtimeChannel || !state.client?.id) return;
  const sb = await ensureSupabaseBrowser();
  if (!sb) return;
  const clientId = state.client.id;
  realtimeChannel = sb.channel('portal-' + clientId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'leads', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const l = payload.new || {};
        notify('New lead', `${l.name || 'Someone'} just came in${l.source ? ' via ' + l.source : ''}`);
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'bookings', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const b = payload.new || {};
        const when = b.starts_at ? new Date(b.starts_at).toLocaleString() : 'soon';
        notify('New booking', `Confirmed for ${when}`);
      })
    .subscribe();
}

function stopRealtime() {
  if (realtimeChannel && supabaseBrowser) {
    supabaseBrowser.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// Patch auth lifecycle to start/stop the realtime subscription. We rebind
// the existing top-level functions so all callers go through the patched
// versions without needing to refactor every call site.
const _origLoadMe = loadMe;
loadMe = async function patchedLoadMe() {  // eslint-disable-line no-func-assign
  await _origLoadMe();
  if (state.client?.id) startRealtime();
};
const _origLogout = logout;
logout = function patchedLogout() {  // eslint-disable-line no-func-assign
  stopRealtime();
  _origLogout();
};

// If the user is already signed in on first load, kick off realtime once
// the initial render finishes hydrating state.client.
setTimeout(() => { if (state.client?.id) startRealtime(); }, 1500);
