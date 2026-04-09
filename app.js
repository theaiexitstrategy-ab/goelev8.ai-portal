// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// GoElev8.ai Portal — vanilla JS SPA
// State + router + views.

// ============================================================
// Google Analytics GA4 helper. No-ops gracefully if gtag isn't
// loaded (e.g. ad-blocker), so it's safe to call from anywhere.
// ============================================================
function ge8Track(eventName, props = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', eventName, props);
    }
  } catch {}
}
function ge8SetUser(props = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('set', 'user_properties', props);
    }
  } catch {}
}
// Track standalone-launch on page load — fires once if the user
// opened the PWA from their home screen.
if (typeof window !== 'undefined') {
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) ge8Track('pwa_launched');
}

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
  //   - id + matching <label for> is what makes a tap on the label
  //     natively focus the input on iOS. Using a JS onclick handler on
  //     a plain <div> loses the first tap in PWA standalone mode.
  //   - inputmode + autocapitalize/autocorrect avoid the keyboard
  //     fighting with the form
  //   - autocomplete hints let the keychain pre-fill
  //   - touch-action: manipulation turns off iOS double-tap-to-zoom
  //     delay so taps register on the first touch
  //   - NO autofocus: setting autofocus on a freshly-mounted input
  //     during page transition is exactly the race that makes the
  //     keyboard never appear on the first tap on iOS PWA standalone.
  const emailInput = el('input', {
    id: 'ge8-login-email',
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
    id: 'ge8-login-password',
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
        ge8Track('login_success', {
          client_slug: state.client?.slug || null,
          client_name: state.client?.name || null
        });
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
    el('div', { class: 'field' },
      el('label', { for: 'ge8-login-email' }, 'Email'),
      emailInput
    ),
    el('div', { class: 'field' },
      el('label', { for: 'ge8-login-password' }, 'Password'),
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
  // Stamp every GA4 event with the active client_slug so cross-tenant
  // filtering "show only this client's activity" works in the dashboard.
  if (state.client?.slug) {
    ge8SetUser({
      client_slug: state.client.slug,
      client_name: state.client.name || null,
      is_admin: !!state.isAdmin
    });
  } else if (state.isAdmin) {
    ge8SetUser({ client_slug: null, client_name: null, is_admin: true });
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
    case 'dollar': return svg(['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']);
    case 'phone':  return svg(['M5 4h4l2 5-3 2a14 14 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 6a2 2 0 0 1 2-2z']);
    case 'chat':   return svg(['M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z']);
    case 'chart':  return svg(['M18 20V10', 'M12 20V4', 'M6 20v-6']);
    case 'person': return svg(['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']);
    case 'gear':   return svg([
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'
    ]);
    case 'nudge':  return svg(['M4 4h16v12H5.2L4 17.3V4z', 'M8 9h8', 'M8 12h5']);
    case 'menu':   return svg(['M4 6h16', 'M4 12h16', 'M4 18h16']);
  }
  return svg([]);
}

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home'   },
  { id: 'sales',     label: 'Sales',     icon: 'dollar' },
  { id: 'calls',     label: 'Calls',     icon: 'phone'  },
  { id: 'messages',  label: 'Messages',  icon: 'chat'   },
  { id: 'analytics', label: 'Analytics', icon: 'chart'  },
  { id: 'nudges',    label: 'Nudges',    icon: 'nudge'  },
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
  //
  // The client logo img is intentionally built with:
  //   - explicit width + height HTML attributes so the browser reserves
  //     the 32px box even before the cross-origin image finishes loading.
  //     Without this the <img> briefly collapses to 0×0 on mobile PWAs
  //     while flex layout is still resolving, and some iOS WebViews never
  //     re-layout once the image arrives, leaving an invisible logo.
  //   - loading="eager" + decoding="async" so iOS doesn't defer the
  //     cross-origin Supabase Storage fetch behind lazy-load heuristics.
  //   - an onerror fallback that swaps in the GoElev8 brand logo if the
  //     client logo URL 404s or fails cross-origin, so the header never
  //     looks broken even if a tenant's logo_url is misconfigured.
  const makeBrandLogo = () => {
    if (inClientContext && clientLogo) {
      const img = el('img', {
        src: clientLogo,
        alt: clientName || 'Client logo',
        width: 32,
        height: 32,
        loading: 'eager',
        decoding: 'async'
      });
      img.addEventListener('error', () => {
        img.src = '/logo.png';
        img.parentElement?.classList.remove('client-logo');
      });
      return el('div', { class: 'logo client-logo' }, img);
    }
    return el('div', { class: 'logo' }, el('img', {
      src: '/logo.png',
      alt: 'GoElev8.AI',
      width: 32,
      height: 32,
      loading: 'eager',
      decoding: 'async'
    }));
  };
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
    onclick: () => {
      state.view = tab.id;
      ge8Track('tab_viewed', { tab_name: tab.id });
      closeNav();
      render();
    }
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
  ge8Track('contact_viewed');
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
  ge8Track('message_viewed');
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Messages')));

  const layout = el('div', { class: 'chat-layout' });
  wrap.appendChild(layout);

  const list = el('div', { class: 'chat-list' });
  const pane = el('div', { class: 'chat-pane' });
  layout.appendChild(list);
  layout.appendChild(pane);

  const fetches = [
    api('/api/portal/crm?action=contacts'),
    api('/api/portal/messages')
  ];
  // For iSlay: also fetch artist inquiries for phone→name matching
  if (isIslayClient()) {
    fetches.push(api('/api/portal/artist?action=inquiries').catch(() => ({ inquiries: [] })));
  }
  const [contactsR, msgsR, artistR] = await Promise.all(fetches);
  const contacts = contactsR.contacts;
  const allMsgs = msgsR.messages;

  // Build phone→artist_name lookup for iSlay
  const phoneToArtist = {};
  if (isIslayClient() && artistR) {
    for (const a of (artistR.inquiries || [])) {
      if (a.artist_phone) phoneToArtist[a.artist_phone] = a.artist_name;
    }
  }

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
    // Show artist name if phone matches an artist inquiry
    const displayName = phoneToArtist[c.phone] || c.name;
    const item = el('div', {
      class: 'item' + (c.id === activeId ? ' active' : ''),
      onclick: () => { state.activeContactId = c.id; render(); }
    },
      el('div', { class: 'name' }, displayName),
      el('div', { class: 'preview' }, last?.body || c.phone)
    );
    list.appendChild(item);
  }

  if (!activeId) {
    pane.appendChild(el('div', { style: 'padding:30px; color:var(--muted)' }, 'Select a contact to start messaging.'));
    return wrap;
  }

  const contact = contacts.find(c => c.id === activeId);
  const chatDisplayName = phoneToArtist[contact.phone] || contact.name;
  pane.appendChild(el('div', { class: 'chat-header' },
    el('strong', {}, chatDisplayName), ' ', el('span', { class: 'muted' }, contact.phone)
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
// NUDGE SEQUENCE EDITOR
// ============================================================

// A2P 10DLC blocked phrases
const NUDGE_BLOCKED = [
  'FREE', 'WINNER', 'GUARANTEED', 'RISK FREE', 'CANCEL ANYTIME',
  'CLICK HERE', 'ACT NOW', 'LIMITED TIME', 'URGENT', 'CONGRATULATIONS',
  "YOU'VE BEEN SELECTED", 'NO OBLIGATION', 'CALL NOW'
];

const NUDGE_OPT_OUT_RE = [
  /reply\s+stop\s+to\s+opt\s+out/i,
  /txt\s+stop\s+to\s+end/i,
  /text\s+stop\s+to\s+(end|opt\s+out|unsubscribe)/i,
  /reply\s+stop\s+to\s+(end|unsubscribe)/i
];

const NUDGE_URL_RE = /https?:\/\/[^\s)}\]]+/gi;

const NUDGE_DELAY_OPTIONS = {
  1: [{ value: 0, label: 'Immediate' }],
  2: [{ value: 30, label: '30 min' }, { value: 60, label: '1 hr' }, { value: 120, label: '2 hr' }, { value: 240, label: '4 hr' }],
  3: [{ value: 720, label: '12 hr' }, { value: 1440, label: '24 hr' }, { value: 2880, label: '48 hr' }],
  4: [{ value: 1440, label: '24 hr' }, { value: 2880, label: '48 hr' }, { value: 4320, label: '72 hr' }],
  5: [{ value: 4320, label: '72 hr' }, { value: 7200, label: '5 days' }, { value: 10080, label: '7 days' }]
};

const NUDGE_MERGE_TAGS = ['[first_name]', '[business_name]', '[funnel_url]', '[phone]'];

const NUDGE_SAMPLE_DATA = {
  '[first_name]': 'Jane',
  '[business_name]': '', // filled from state.client
  '[funnel_url]': '',    // filled from state.client
  '[phone]': '(555) 123-4567'
};

function nudgeValidateBody(body, msgNum) {
  const errors = [];
  const upper = body.toUpperCase();
  for (const phrase of NUDGE_BLOCKED) {
    if (upper.includes(phrase)) errors.push(`Contains blocked A2P phrase "${phrase}"`);
  }
  const urls = body.match(NUDGE_URL_RE) || [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host.endsWith('goelev8.ai') && host !== 'goelev8.ai') {
        errors.push(`URL "${url}" is not on the goelev8.ai domain`);
      }
    } catch { errors.push(`Invalid URL "${url}"`); }
  }
  let finalBody = body;
  if (msgNum === 1) {
    const hasOptOut = NUDGE_OPT_OUT_RE.some((re) => re.test(body));
    if (!hasOptOut) finalBody = body + '\nReply STOP to opt out.';
  }
  if (finalBody.length > 160) errors.push(`${finalBody.length} characters exceeds the 160-character limit`);
  return { finalBody, errors };
}

function nudgeRenderPreview(body) {
  const biz = state.client?.business_name || state.client?.name || 'Your Business';
  const slug = state.client?.slug || 'demo';
  const sample = { ...NUDGE_SAMPLE_DATA, '[business_name]': biz, '[funnel_url]': `goelev8.ai/f/${slug}` };
  return body.replace(/\[(first_name|business_name|funnel_url|phone)\]/gi, (m) => sample[m.toLowerCase()] || m);
}

async function viewNudges() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'SMS Nudge Sequence'),
    el('div', { class: 'muted' }, 'Customize the 5-message drip that fires when a lead opts in through your funnel page')
  ));

  // Load nudges
  let nudges;
  try {
    const r = await api('/api/portal/nudges');
    nudges = r.nudges || [];
  } catch (e) {
    wrap.appendChild(el('div', { class: 'panel' }, el('p', { class: 'err' }, 'Failed to load nudges: ' + e.message)));
    return wrap;
  }

  // Pad to 5 if needed
  while (nudges.length < 5) {
    nudges.push({ message_number: nudges.length + 1, message_body: '', delay_minutes: 0, is_active: true, is_custom: false });
  }

  // State for each card
  const cardStates = nudges.map((n) => ({
    message_number: n.message_number,
    message_body: n.message_body || '',
    delay_minutes: n.delay_minutes,
    is_active: n.is_active,
    is_custom: n.is_custom
  }));

  const cardEls = [];

  for (let i = 0; i < 5; i++) {
    const cs = cardStates[i];
    const num = cs.message_number;
    const card = el('div', { class: 'nudge-card' + (cs.is_active ? '' : ' nudge-inactive') });

    // ── Header row ──
    const headerRow = el('div', { class: 'nudge-header' });
    const badge = el('span', { class: 'nudge-badge' }, `Message ${num}`);
    const toggle = el('input', { type: 'checkbox', class: 'nudge-toggle' });
    toggle.checked = cs.is_active;
    const toggleLabel = el('label', { class: 'nudge-toggle-row' },
      toggle,
      el('span', { class: 'nudge-toggle-text' }, 'Active')
    );
    headerRow.appendChild(badge);
    headerRow.appendChild(toggleLabel);
    card.appendChild(headerRow);

    // ── Delay selector ──
    const delayOpts = NUDGE_DELAY_OPTIONS[num] || [];
    const delaySelect = el('select', { class: 'nudge-delay' },
      ...delayOpts.map((o) => {
        const opt = el('option', { value: o.value }, o.label);
        if (o.value === cs.delay_minutes) opt.selected = true;
        return opt;
      })
    );
    const delayRow = el('div', { class: 'nudge-delay-row' },
      el('span', { class: 'nudge-delay-label' }, num === 1 ? 'Sends' : 'Delay'),
      delaySelect
    );
    if (num === 1) { delaySelect.disabled = true; }
    card.appendChild(delayRow);

    // ── Merge tag buttons ──
    const tagBar = el('div', { class: 'nudge-tag-bar' },
      el('span', { class: 'nudge-tag-hint' }, 'Insert:'),
      ...NUDGE_MERGE_TAGS.map((tag) =>
        el('button', {
          class: 'nudge-tag-btn',
          type: 'button',
          onclick: () => {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const val = textarea.value;
            textarea.value = val.slice(0, start) + tag + val.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + tag.length;
            textarea.focus();
            textarea.dispatchEvent(new Event('input'));
          }
        }, tag)
      )
    );
    card.appendChild(tagBar);

    // ── Textarea ──
    const textarea = el('textarea', {
      class: 'nudge-textarea',
      rows: 3,
      maxlength: 320,
      placeholder: `Write message ${num}...`
    });
    textarea.value = cs.message_body;
    card.appendChild(textarea);

    // ── Character counter ──
    const charCount = el('div', { class: 'nudge-char-count' });
    // ── Validation errors ──
    const errBox = el('div', { class: 'nudge-errors' });

    const updateCounter = () => {
      const body = textarea.value;
      cs.message_body = body;
      const { finalBody, errors } = nudgeValidateBody(body, num);
      const len = finalBody.length;
      charCount.textContent = `${len}/160 characters`;
      charCount.className = 'nudge-char-count' + (len > 160 ? ' nudge-over' : len > 140 ? ' nudge-warn' : '');

      errBox.innerHTML = '';
      if (errors.length) {
        for (const e of errors) {
          errBox.appendChild(el('div', { class: 'nudge-err-line' }, e));
        }
      }
      // Also update opt-out notice for msg 1
      if (num === 1 && finalBody !== body) {
        const notice = el('div', { class: 'nudge-opt-notice' }, 'Opt-out text will be auto-appended on save');
        // Only add if not already present
        if (!errBox.querySelector('.nudge-opt-notice')) {
          errBox.appendChild(notice);
        }
      }
      // Update preview
      previewText.textContent = nudgeRenderPreview(finalBody);
    };
    textarea.addEventListener('input', updateCounter);

    card.appendChild(charCount);
    card.appendChild(errBox);

    // ── Preview panel ──
    const previewText = el('div', { class: 'nudge-preview-bubble' });
    const previewPanel = el('div', { class: 'nudge-preview' },
      el('div', { class: 'nudge-preview-label' }, 'Preview'),
      previewText
    );
    card.appendChild(previewPanel);

    // ── Save button for this slot ──
    const saveOneBtn = el('button', { class: 'btn sm nudge-save-one', onclick: async () => {
      const { finalBody, errors } = nudgeValidateBody(textarea.value, num);
      if (errors.length) { toast(errors[0], true); return; }
      saveOneBtn.disabled = true;
      saveOneBtn.textContent = 'Saving...';
      try {
        await api(`/api/portal/nudges?slot=${num}`, {
          method: 'PUT',
          body: { message_body: textarea.value, delay_minutes: Number(delaySelect.value), is_active: toggle.checked }
        });
        cs.is_custom = true;
        toast(`Message ${num} saved`);
      } catch (e) {
        toast(e.message, true);
      } finally {
        saveOneBtn.disabled = false;
        saveOneBtn.textContent = 'Save';
      }
    }}, 'Save');
    card.appendChild(saveOneBtn);

    // Toggle handler
    toggle.addEventListener('change', () => {
      cs.is_active = toggle.checked;
      card.className = 'nudge-card' + (toggle.checked ? '' : ' nudge-inactive');
    });

    // Delay handler
    delaySelect.addEventListener('change', () => {
      cs.delay_minutes = Number(delaySelect.value);
    });

    // Init
    updateCounter();
    cardEls.push(card);
    wrap.appendChild(card);
  }

  // ── Bulk save button ──
  const bulkBar = el('div', { class: 'nudge-bulk-bar' });
  const bulkBtn = el('button', { class: 'btn', onclick: async () => {
    // Validate all
    const allErrors = [];
    for (const cs of cardStates) {
      const { errors } = nudgeValidateBody(cs.message_body, cs.message_number);
      allErrors.push(...errors.map((e) => `Msg ${cs.message_number}: ${e}`));
    }
    if (allErrors.length) { toast(allErrors[0], true); return; }

    bulkBtn.disabled = true;
    bulkBtn.textContent = 'Saving all...';
    try {
      const payload = cardStates.map((cs) => ({
        message_number: cs.message_number,
        message_body: cs.message_body,
        delay_minutes: cs.delay_minutes,
        is_active: cs.is_active
      }));
      await api('/api/portal/nudges', { method: 'PUT', body: { nudges: payload } });
      toast('All nudge messages saved');
    } catch (e) {
      toast(e.message, true);
    } finally {
      bulkBtn.disabled = false;
      bulkBtn.textContent = 'Save all messages';
    }
  }}, 'Save all messages');
  bulkBar.appendChild(bulkBtn);
  wrap.appendChild(bulkBar);

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
        el('th', {}, 'Tier'),
        el('th', {}, 'Status'),
        el('th', {}, 'Actions')
      )),
      el('tbody', {}, ...allClients.map((c) => {
        // NOTE: table rows use their own action-button instances so the
        // input state (amount/note) is independent between the table and
        // the mobile card.
        const b = buildClient(c);
        const tierLabel = (c.tier || 'starter').charAt(0).toUpperCase() + (c.tier || 'starter').slice(1);
        const tierCls = c.tier === 'custom' ? 'pill ok' : c.tier === 'growth' ? 'pill warn' : 'pill';
        return el('tr', {},
          el('td', {}, el('strong', {}, c.name || '—')),
          el('td', {}, el('code', {}, c.slug)),
          el('td', { class: 'muted mono' }, c.twilio_phone_number || '—'),
          el('td', {}, String(c.credit_balance ?? 0)),
          el('td', { class: 'muted' }, String(c.sent_30d || 0)),
          el('td', {}, el('span', { class: tierCls }, tierLabel)),
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
        const tierLabel = (c.tier || 'starter').charAt(0).toUpperCase() + (c.tier || 'starter').slice(1);
        const tierCls = c.tier === 'custom' ? 'pill ok' : c.tier === 'growth' ? 'pill warn' : 'pill';
        return el('div', { class: 'admin-card' },
          el('div', { class: 'admin-card-head' },
            el('strong', {}, c.name || '—'),
            el('span', { class: tierCls }, tierLabel),
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
// TIER FEATURE LOCKING (Part 12)
// ============================================================
const TIER_LEVELS = { starter: 1, growth: 2, custom: 3 };
const TIER_NAMES  = { starter: 'Starter', growth: 'Growth', custom: 'Custom' };

function clientTier() {
  return state.client?.tier || 'starter';
}

function hasTierAccess(requiredTier) {
  return (TIER_LEVELS[clientTier()] || 0) >= (TIER_LEVELS[requiredTier] || 0);
}

function tierLock(featureName, requiredTier, description) {
  const clientName = state.client?.name || 'your business';
  const tierLabel = TIER_NAMES[requiredTier] || requiredTier;
  const mailto = `mailto:aaron@goelev8.ai?subject=${encodeURIComponent('Upgrade Request — ' + clientName)}&body=${encodeURIComponent('I would like to upgrade to ' + tierLabel + ' tier for ' + clientName + '.')}`;
  return el('div', { class: 'tier-lock' },
    el('div', { class: 'tier-lock-icon' }, '\uD83D\uDD12'),
    el('div', { class: 'tier-lock-text' },
      el('div', { class: 'tier-lock-title' }, featureName),
      el('div', { class: 'tier-lock-desc muted' }, description || `Upgrade to ${tierLabel} to unlock ${featureName.toLowerCase()}.`)
    ),
    el('a', { class: 'btn tier-lock-btn', href: mailto }, 'Upgrade Now')
  );
}

// Returns the conversion label for the current client.
function conversionLabel() {
  return state.client?.conversion_label || 'Conversions';
}

// Is this the iSlay Studios client?
function isIslayClient() {
  return state.client?.slug === 'islay-studios';
}

// ============================================================
// ARTIST CONVERSION PIPELINE (Part 4 — iSlay Studios)
// ============================================================
const ARTIST_STAGES = ['New', 'Contacted', 'Booked', 'In Studio', 'Converted', 'Lost'];
const GENRE_COLORS = {
  'R&B': '#a855f7', 'Hip Hop': '#eab308', 'Gospel': '#3b82f6',
  'Pop': '#ec4899', 'Rock': '#ef4444', 'Jazz': '#14b8a6',
  'Country': '#f97316', 'Electronic': '#06b6d4'
};

function genreBadge(genre) {
  if (!genre) return null;
  const color = GENRE_COLORS[genre] || '#6b7280';
  return el('span', { class: 'genre-badge', style: `background:${color}20;color:${color};border:1px solid ${color}40` }, genre);
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

async function viewArtistPipeline() {
  const wrap = el('div', {});

  // Conversion rate card
  const ratePanel = el('div', { class: 'panel' });
  ratePanel.appendChild(skeleton(1));
  wrap.appendChild(ratePanel);

  // Pipeline
  const pipePanel = el('div', { class: 'panel pipeline-panel' });
  pipePanel.appendChild(skeleton(3));
  wrap.appendChild(pipePanel);

  try {
    const [pipeR, dashR] = await Promise.all([
      api('/api/portal/artist?action=pipeline'),
      api('/api/portal/artist?action=dashboard')
    ]);

    // ── Conversion rate card ──
    ratePanel.innerHTML = '';
    ratePanel.appendChild(el('h2', {}, 'Artist ' + conversionLabel()));
    const stats = dashR.stats;
    const rateCards = el('div', { class: 'cards' });
    rateCards.appendChild(card('Inquiries', stats.new_inquiries, 'This month', 'accent'));
    rateCards.appendChild(card('Converted', stats.conversions, 'This month'));
    const arrow = parseFloat(stats.conversion_rate) > 0 ? '\u2191' : '';
    rateCards.appendChild(card('Rate', stats.conversion_rate + '%', arrow + ' conversion'));
    rateCards.appendChild(card('Avg Session', '$' + stats.avg_session_value.toFixed(0), stats.avg_days_to_book ? stats.avg_days_to_book + 'd avg to book' : 'N/A'));
    ratePanel.appendChild(rateCards);

    // ── Pipeline stages ──
    pipePanel.innerHTML = '';
    pipePanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Artist Pipeline'),
      el('button', { class: 'btn sm', onclick: () => openArtistInquiryModal() }, '+ New Inquiry')
    ));

    const pipeline = el('div', { class: 'pipeline' });
    for (const stage of pipeR.stages) {
      const data = pipeR.pipeline[stage] || { count: 0, value: 0, items: [] };
      const stageClass = stage.toLowerCase().replace(/\s+/g, '-');
      const col = el('div', { class: 'pipeline-stage stage-' + stageClass },
        el('div', { class: 'pipeline-header' },
          el('div', { class: 'pipeline-title' }, stage),
          el('div', { class: 'pipeline-count' },
            el('span', { class: 'pipeline-num' }, String(data.count)),
            data.value > 0 ? el('span', { class: 'pipeline-value muted' }, ' $' + data.value.toLocaleString()) : null
          )
        )
      );

      const cardList = el('div', { class: 'pipeline-cards' });
      for (const item of data.items) {
        const days = daysSince(item.created_at);
        const artistCard = el('div', { class: 'artist-card', draggable: 'true' },
          el('div', { class: 'artist-card-top' },
            el('div', { class: 'artist-card-name' }, item.artist_name),
            genreBadge(item.genre)
          ),
          item.service_interest ? el('div', { class: 'artist-card-service muted' }, item.service_interest) : null,
          item.budget_range ? el('div', { class: 'artist-card-budget muted' }, item.budget_range) : null,
          el('div', { class: 'artist-card-footer' },
            days != null ? el('span', { class: 'muted small' }, days + 'd ago') : null,
            el('div', { class: 'artist-card-actions' },
              el('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); viewArtistDetail(item); } }, 'View'),
              stage !== 'Booked' && stage !== 'In Studio' && stage !== 'Converted' && stage !== 'Lost'
                ? el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openBookSessionModal(item); } }, 'Book')
                : null
            )
          )
        );

        // Drag-and-drop: set inquiry id
        artistCard.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        });

        cardList.appendChild(artistCard);
      }
      col.appendChild(cardList);

      // Drop zone
      col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const inquiryId = e.dataTransfer.getData('text/plain');
        if (!inquiryId) return;
        try {
          await api('/api/portal/artist?action=inquiries', {
            method: 'PATCH', body: { id: inquiryId, status: stage }
          });
          toast(`Moved to ${stage}`);
          render();
        } catch (err) { toast(err.message, true); }
      });

      pipeline.appendChild(col);
    }
    pipePanel.appendChild(pipeline);
  } catch (e) {
    ratePanel.innerHTML = '';
    ratePanel.appendChild(el('div', { class: 'err' }, e.message));
  }

  return wrap;
}

function viewArtistDetail(item) {
  const close = () => bg.remove();
  const modal = el('div', { class: 'modal' },
    el('h2', {}, item.artist_name),
    el('div', { class: 'artist-detail-grid' },
      el('div', {}, el('strong', {}, 'Phone: '), item.artist_phone || '—'),
      el('div', {}, el('strong', {}, 'Email: '), item.artist_email || '—'),
      el('div', {}, el('strong', {}, 'Genre: '), item.genre || '—'),
      el('div', {}, el('strong', {}, 'Service: '), item.service_interest || '—'),
      el('div', {}, el('strong', {}, 'Budget: '), item.budget_range || '—'),
      el('div', {}, el('strong', {}, 'Source: '), item.source || '—'),
      el('div', {}, el('strong', {}, 'Status: '), item.status || '—'),
      el('div', {}, el('strong', {}, 'Since: '), new Date(item.created_at).toLocaleDateString()),
      item.notes ? el('div', { style: 'grid-column:1/-1' }, el('strong', {}, 'Notes: '), item.notes) : null
    ),
    el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:16px' },
      item.artist_phone ? el('a', { class: 'btn ghost', href: 'tel:' + item.artist_phone }, 'Call') : null,
      el('button', { class: 'btn', onclick: () => { close(); openBookSessionModal(item); } }, 'Book Session'),
      el('button', { class: 'btn ghost', onclick: close }, 'Close')
    )
  );
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
}

function openArtistInquiryModal() {
  const name = el('input', { placeholder: 'Artist name' });
  const phone = el('input', { placeholder: '+15551234567' });
  const email = el('input', { placeholder: 'artist@example.com' });
  const genre = el('select', {},
    el('option', { value: '' }, '— Select genre —'),
    ...['R&B', 'Hip Hop', 'Gospel', 'Pop', 'Rock', 'Jazz', 'Country', 'Electronic', 'Other'].map(g =>
      el('option', { value: g }, g))
  );
  const serviceInterest = el('select', {},
    el('option', { value: '' }, '— Select service —'),
    ...['Recording', 'Mixing', 'Mastering', 'Full Production', 'Other'].map(s =>
      el('option', { value: s }, s))
  );
  const budget = el('select', {},
    el('option', { value: '' }, '— Budget range —'),
    ...['Under $500', '$500–$1,000', '$1,000–$2,500', '$2,500–$5,000', '$5,000+'].map(b =>
      el('option', { value: b }, b))
  );
  const notes = el('textarea', { rows: 3, placeholder: 'Notes...' });

  const close = () => bg.remove();
  const save = async () => {
    if (!name.value.trim()) { toast('Artist name required', true); return; }
    try {
      await api('/api/portal/artist?action=inquiries', { method: 'POST', body: {
        artist_name: name.value.trim(),
        artist_phone: phone.value.trim() || null,
        artist_email: email.value.trim() || null,
        genre: genre.value || null,
        service_interest: serviceInterest.value || null,
        budget_range: budget.value || null,
        notes: notes.value.trim() || null
      }});
      close(); toast('Inquiry added'); render();
    } catch (e) { toast(e.message, true); }
  };

  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'New Artist Inquiry'),
    el('div', { class: 'field' }, el('label', {}, 'Artist Name'), name),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', {}, 'Phone'), phone),
      el('div', { class: 'field' }, el('label', {}, 'Email'), email)
    ),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', {}, 'Genre'), genre),
      el('div', { class: 'field' }, el('label', {}, 'Service Interest'), serviceInterest)
    ),
    el('div', { class: 'field' }, el('label', {}, 'Budget Range'), budget),
    el('div', { class: 'field' }, el('label', {}, 'Notes'), notes),
    el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
      el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      el('button', { class: 'btn', onclick: save }, 'Save')
    )
  );
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
}

function openBookSessionModal(inquiry) {
  const dateInput = el('input', { type: 'datetime-local' });
  const serviceType = el('select', {},
    ...['Recording', 'Mixing', 'Mastering', 'Full Production', 'Other'].map(s =>
      el('option', { value: s, selected: s === (inquiry?.service_interest || '') }, s))
  );
  const duration = el('input', { type: 'number', min: '0.5', step: '0.5', value: '2' });
  const rate = el('input', { type: 'number', min: '0', step: '25', value: '150' });
  const totalDisplay = el('div', { class: 'booking-total' }, '$300.00');
  const notes = el('textarea', { rows: 2, placeholder: 'Session notes...' });

  const updateTotal = () => {
    const t = (parseFloat(duration.value) || 0) * (parseFloat(rate.value) || 0);
    totalDisplay.textContent = '$' + t.toFixed(2);
  };
  duration.addEventListener('input', updateTotal);
  rate.addEventListener('input', updateTotal);

  const close = () => bg.remove();
  const save = async () => {
    if (!dateInput.value) { toast('Select a date and time', true); return; }
    try {
      await api('/api/portal/artist?action=bookings', { method: 'POST', body: {
        artist_inquiry_id: inquiry?.id || null,
        artist_name: inquiry?.artist_name || 'Unknown',
        phone: inquiry?.artist_phone || null,
        email: inquiry?.artist_email || null,
        service_type: serviceType.value,
        session_date: new Date(dateInput.value).toISOString(),
        duration_hours: parseFloat(duration.value) || 1,
        rate_per_hour: parseFloat(rate.value) || 0,
        notes: notes.value.trim() || null
      }});
      close(); toast('Session booked! SMS sent to artist.'); render();
    } catch (e) { toast(e.message, true); }
  };

  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'Book Session — ' + (inquiry?.artist_name || 'Artist')),
    el('div', { class: 'field' }, el('label', {}, 'Date & Time'), dateInput),
    el('div', { class: 'field' }, el('label', {}, 'Service Type'), serviceType),
    el('div', { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', {}, 'Duration (hours)'), duration),
      el('div', { class: 'field' }, el('label', {}, 'Rate per hour ($)'), rate)
    ),
    el('div', { class: 'field' }, el('label', {}, 'Total'), totalDisplay),
    el('div', { class: 'field' }, el('label', {}, 'Notes'), notes),
    el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px' },
      el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      el('button', { class: 'btn', onclick: save }, 'Confirm Booking')
    )
  );
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
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
  // iSlay Studios gets a custom dashboard
  if (isIslayClient()) return viewIslayDashboard();

  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Dashboard'),
    el('div', { class: 'muted' }, state.client?.name || '')
  ));

  // ---- Summary stats (top) ----
  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  cards.appendChild(skeleton(1));

  // ---- Conversion pipeline (tier-gated) ----
  if (hasTierAccess('custom')) {
    // Generic pipeline placeholder for non-islay clients
  } else {
    wrap.appendChild(tierLock('Conversion Pipeline', 'custom',
      'Upgrade to Custom to unlock conversion tracking'));
  }

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
    ge8Track('lead_viewed', { count: recentLeads.length });
    if (!recentLeads.length) {
      leadsPanel.appendChild(emptyState('No leads yet. Vapi calls and web form submissions will appear here.'));
    } else {
      const list = el('div', { class: 'lead-list' });
      for (const l of recentLeads) {
        list.appendChild(el('div', {
          class: 'lead-row',
          onclick: () => ge8Track('lead_clicked', {
            lead_source: l.source || null,
            lead_status: l.status || null
          })
        },
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
// ISLAY STUDIOS DASHBOARD (Part 5)
// ============================================================
async function viewIslayDashboard() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Dashboard'),
    el('div', { class: 'muted' }, 'iSlay Studios')
  ));

  // ── Top Stats (4 cards) ──
  const statsCards = el('div', { class: 'cards' });
  wrap.appendChild(statsCards);
  statsCards.appendChild(skeleton(1));

  // ── Artist Conversion Pipeline ──
  const pipelineWrap = el('div', {});
  wrap.appendChild(pipelineWrap);
  pipelineWrap.appendChild(skeleton(3));

  // ── Upcoming Sessions Today ──
  const todayPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Sessions Today'),
      el('span', { class: 'muted small' }, new Date().toLocaleDateString())
    ),
    skeleton(2)
  );
  wrap.appendChild(todayPanel);

  // ── Recent Inquiries ──
  const recentPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Recent Inquiries'),
      el('span', { class: 'muted small' }, 'Latest 5')
    ),
    skeleton(3)
  );
  wrap.appendChild(recentPanel);

  try {
    const dashR = await api('/api/portal/artist?action=dashboard');
    const stats = dashR.stats;

    // ── Stats Cards ──
    statsCards.innerHTML = '';
    statsCards.appendChild(card('New Inquiries', stats.new_inquiries, 'This month', 'accent'));
    statsCards.appendChild(card('Sessions Booked', stats.sessions_booked, 'This month'));
    statsCards.appendChild(card(conversionLabel(), stats.conversions,
      stats.conversion_rate + '% rate'));
    statsCards.appendChild(card('Revenue', '$' + stats.revenue.toFixed(0), 'This month'));

    // ── Pipeline ──
    pipelineWrap.innerHTML = '';
    const pipelineView = await viewArtistPipeline();
    pipelineWrap.appendChild(pipelineView);

    // ── Today's Sessions ──
    todayPanel.innerHTML = '';
    todayPanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Sessions Today'),
      el('span', { class: 'muted small' }, new Date().toLocaleDateString())
    ));
    if (!dashR.today_sessions.length) {
      todayPanel.appendChild(emptyState('No sessions scheduled today.'));
    } else {
      const list = el('div', { class: 'lead-list' });
      for (const s of dashR.today_sessions) {
        const time = new Date(s.session_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        list.appendChild(el('div', { class: 'lead-row' },
          el('div', { class: 'lead-main' },
            el('div', { class: 'lead-name' }, s.artist_name),
            el('div', { class: 'lead-meta muted' },
              [s.service_type, s.duration_hours + 'h', time].filter(Boolean).join(' · ')
            )
          ),
          el('div', { class: 'lead-side' },
            statusBadge(s.status),
            el('div', { class: 'lead-time muted' }, '$' + (Number(s.total_amount) || 0).toFixed(0))
          )
        ));
      }
      todayPanel.appendChild(list);
    }

    // ── Recent Inquiries ──
    recentPanel.innerHTML = '';
    recentPanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Recent Inquiries'),
      el('span', { class: 'muted small' }, 'Latest 5')
    ));
    if (!dashR.recent_inquiries.length) {
      recentPanel.appendChild(emptyState('No inquiries yet. They will appear here as artists reach out.'));
    } else {
      const list = el('div', { class: 'lead-list' });
      for (const i of dashR.recent_inquiries) {
        list.appendChild(el('div', { class: 'lead-row' },
          el('div', { class: 'lead-main' },
            el('div', { class: 'lead-name' }, i.artist_name || '—'),
            el('div', { class: 'lead-meta muted' },
              [i.source, i.genre].filter(Boolean).join(' · ')
            )
          ),
          el('div', { class: 'lead-side' },
            statusBadge(i.status),
            el('div', { class: 'lead-time muted' }, new Date(i.created_at).toLocaleDateString())
          )
        ));
      }
      recentPanel.appendChild(list);
    }
  } catch (e) {
    statsCards.innerHTML = '';
    statsCards.appendChild(el('div', { class: 'err' }, e.message));
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
  ge8Track('call_viewed');
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Calls'),
    el('div', { class: 'muted' }, isIslayClient() ? 'Call log' : 'AI voice answer log')
  ));
  const panel = el('div', { class: 'panel' });
  panel.appendChild(skeleton(5));
  wrap.appendChild(panel);

  try {
    // Fetch calls and artist inquiries in parallel for phone→name matching
    const [callsR, artistR] = await Promise.all([
      api('/api/portal/crm?action=calls'),
      isIslayClient()
        ? api('/api/portal/artist?action=inquiries').catch(() => ({ inquiries: [] }))
        : Promise.resolve({ inquiries: [] })
    ]);

    // Build phone→artist_name lookup for iSlay
    const phoneToArtist = {};
    if (isIslayClient()) {
      for (const a of (artistR.inquiries || [])) {
        if (a.artist_phone) phoneToArtist[a.artist_phone] = a.artist_name;
      }
    }

    panel.innerHTML = '';
    if (!callsR.calls.length) {
      panel.appendChild(emptyState('No calls yet. Once Vapi handles a call it will show up here with the transcript.'));
      return wrap;
    }
    const list = el('div', { class: 'call-list' });
    for (const c of callsR.calls) {
      const mins = Math.floor((c.duration_seconds || 0) / 60);
      const secs = (c.duration_seconds || 0) % 60;
      const dur = `${mins}:${String(secs).padStart(2, '0')}`;
      // Show artist name instead of phone if we have a match
      const displayName = phoneToArtist[c.caller_phone] || c.caller_phone || 'Unknown caller';
      const showPhone = phoneToArtist[c.caller_phone] ? c.caller_phone : null;
      const row = el('div', { class: 'call-row' },
        el('div', { class: 'call-main' },
          el('div', { class: 'call-phone' }, displayName),
          el('div', { class: 'call-meta muted' },
            [showPhone, new Date(c.created_at).toLocaleString(), dur].filter(Boolean).join(' · ')
          )
        ),
        el('div', { class: 'call-side' }, statusBadge(c.outcome))
      );
      row.addEventListener('click', () => {
        const next = row.nextSibling;
        if (next && next.classList?.contains('call-transcript')) { next.remove(); return; }
        ge8Track('transcript_expanded', { outcome: c.outcome || null });
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
// SALES TRACKER
// ============================================================
function timeAgo(ts) {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

async function viewSales() {
  ge8Track('tab_viewed', { tab_name: 'sales' });
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Sales'),
    el('button', { class: 'btn', onclick: () => openAddProductModal() }, '+ Add Product')
  ));

  // Overview stat cards
  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  cards.appendChild(skeleton(1));

  // Products section
  const productsPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Products'),
      el('button', { class: 'btn sm', onclick: () => openAddProductModal() }, '+ Add Product')
    ),
    skeleton(2)
  );
  wrap.appendChild(productsPanel);

  // Sales table section
  const salesPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Recent Sales'),
    skeleton(5)
  );
  wrap.appendChild(salesPanel);

  try {
    const [statsR, productsR, salesR] = await Promise.all([
      api('/api/portal/sales?action=stats'),
      api('/api/portal/products'),
      api('/api/portal/sales?action=list')
    ]);

    // ---- Overview Cards ----
    cards.innerHTML = '';
    cards.appendChild(card('Total Revenue', '$' + statsR.total_revenue.toFixed(2), 'all time', 'accent'));
    cards.appendChild(card('Total Sales', statsR.total_count, 'all time'));
    const arrow = statsR.month_change >= 0 ? '\u2191' : '\u2193';
    cards.appendChild(card('This Month', '$' + statsR.this_month_revenue.toFixed(2),
      `vs last month ${arrow} ${Math.abs(statsR.month_change)}%`));
    cards.appendChild(card('Today', `$${statsR.today_revenue.toFixed(2)} (${statsR.today_count})`,
      `last updated ${new Date(statsR.last_updated).toLocaleTimeString()}`));

    // ---- Products Grid ----
    productsPanel.innerHTML = '';
    productsPanel.appendChild(el('div', { class: 'panel-head' },
      el('h2', {}, 'Products'),
      el('button', { class: 'btn sm', onclick: () => openAddProductModal() }, '+ Add Product')
    ));

    if (!productsR.products.length) {
      productsPanel.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, '$'),
        el('div', { class: 'empty-msg' }, 'No products yet'),
        el('div', { class: 'muted', style: 'margin-top:8px' }, 'Add your first product to start tracking sales'),
        el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => openAddProductModal() }, '+ Add Product')
      ));
    } else {
      const grid = el('div', { class: 'products-grid' });
      for (const p of productsR.products) {
        const productCard = el('div', { class: 'product-card' },
          p.image_url
            ? el('div', { class: 'product-img' }, el('img', { src: p.image_url, alt: p.name }))
            : el('div', { class: 'product-img placeholder' }, el('span', {}, '$')),
          el('div', { class: 'product-info' },
            el('div', { class: 'product-name-row' },
              el('div', { class: 'product-name' }, p.name),
              el('span', { class: 'badge ' + (p.is_active ? 'green' : 'red') }, p.is_active ? 'Active' : 'Inactive')
            ),
            el('div', { class: 'product-price' }, '$' + Number(p.price).toFixed(2)),
            el('div', { class: 'product-stats muted' },
              `${p.sales_count} sales  \u00b7  $${p.total_revenue.toFixed(2)}`
            ),
            p.show_in_funnel && p.funnel_pages?.length
              ? el('div', { class: 'product-funnel muted' }, 'Funnel: ' + p.funnel_pages.join(', '))
              : null,
            el('div', { class: 'product-actions' },
              el('button', { class: 'btn sm', onclick: () => openEditProductModal(p) }, 'Edit'),
              el('button', { class: 'btn sm', onclick: () => {
                state.salesProductFilter = p.id;
                render();
              }}, 'View Sales'),
              p.stripe_payment_link
                ? el('button', { class: 'btn sm', onclick: () => {
                    navigator.clipboard.writeText(p.stripe_payment_link);
                    toast('Payment link copied!');
                  }}, 'Share')
                : null
            )
          )
        );
        grid.appendChild(productCard);
      }
      productsPanel.appendChild(grid);
    }

    // ---- Sales Table ----
    salesPanel.innerHTML = '';
    salesPanel.appendChild(el('h2', {}, 'Recent Sales'));

    // Filter bar
    const filterBar = el('div', { class: 'sales-filters' });

    // Product filter
    const productFilter = el('select', { class: 'sales-select',
      onchange: () => loadSalesTable()
    },
      el('option', { value: 'all' }, 'All Products'),
      ...productsR.products.map(p => el('option', { value: p.id }, p.name))
    );

    // Period filter
    const periodFilter = el('select', { class: 'sales-select',
      onchange: () => loadSalesTable()
    },
      el('option', { value: 'all' }, 'All Time'),
      el('option', { value: 'today' }, 'Today'),
      el('option', { value: 'this_month', selected: true }, 'This Month'),
      el('option', { value: 'last_month' }, 'Last Month')
    );

    // Status filter
    const statusFilter = el('select', { class: 'sales-select',
      onchange: () => loadSalesTable()
    },
      el('option', { value: 'all' }, 'All Status'),
      el('option', { value: 'paid' }, 'Paid'),
      el('option', { value: 'failed' }, 'Failed'),
      el('option', { value: 'refunded' }, 'Refunded')
    );

    // Search
    const searchInput = el('input', {
      class: 'sales-search',
      type: 'text',
      placeholder: 'Search customers...',
      oninput: () => {
        clearTimeout(searchInput._debounce);
        searchInput._debounce = setTimeout(() => loadSalesTable(), 300);
      }
    });

    filterBar.appendChild(productFilter);
    filterBar.appendChild(periodFilter);
    filterBar.appendChild(statusFilter);
    filterBar.appendChild(searchInput);
    salesPanel.appendChild(filterBar);

    const salesHost = el('div', {});
    salesPanel.appendChild(salesHost);

    let currentPage = 1;

    async function loadSalesTable(page = 1) {
      currentPage = page;
      salesHost.innerHTML = '';
      salesHost.appendChild(skeleton(3));

      const params = new URLSearchParams({
        action: 'list',
        page: String(page),
        product: productFilter.value,
        period: periodFilter.value,
        status: statusFilter.value
      });
      if (searchInput.value.trim()) params.set('search', searchInput.value.trim());

      try {
        const r = await api('/api/portal/sales?' + params.toString());
        salesHost.innerHTML = '';

        if (!r.sales.length) {
          if (statsR.total_count === 0) {
            // True empty state
            salesHost.appendChild(el('div', { class: 'empty-state' },
              el('div', { class: 'empty-icon' }, '$'),
              el('div', { class: 'empty-msg' }, 'No sales yet'),
              el('div', { class: 'muted', style: 'margin-top:8px' }, 'Share your product link to get your first sale'),
              productsR.products[0]?.stripe_payment_link
                ? el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => {
                    navigator.clipboard.writeText(productsR.products[0].stripe_payment_link);
                    toast('Payment link copied!');
                  }}, 'Copy Payment Link')
                : null
            ));
          } else {
            salesHost.appendChild(el('div', { class: 'muted', style: 'padding:24px;text-align:center' },
              'No sales match the current filters.'));
          }
          return;
        }

        // Desktop table
        const table = el('table', { class: 'sales-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Customer'),
            el('th', {}, 'Product'),
            el('th', {}, 'Amount'),
            el('th', {}, 'Source'),
            el('th', {}, 'Date'),
            el('th', {}, 'Status')
          )),
          el('tbody', {}, ...r.sales.map(s => {
            const amtClass = s.payment_status === 'paid' ? 'sale-paid' : 'sale-failed';
            const row = el('tr', { class: 'sale-row' },
              el('td', {},
                el('div', { class: 'sale-customer' }, s.customer_name || 'Unknown'),
                el('div', { class: 'muted small' }, s.customer_email || '')
              ),
              el('td', {}, s.products?.name || '—'),
              el('td', { class: amtClass }, '$' + Number(s.amount).toFixed(2)),
              el('td', {}, el('span', { class: 'badge source-badge' }, s.source || 'direct')),
              el('td', { class: 'muted' }, timeAgo(s.created_at)),
              el('td', {}, statusBadge(s.payment_status === 'paid' ? 'Paid' : s.payment_status === 'failed' ? 'Failed' : 'Refunded'))
            );
            row.addEventListener('click', () => {
              const next = row.nextSibling;
              if (next?.classList?.contains('sale-detail-row')) { next.remove(); return; }
              const detail = el('tr', { class: 'sale-detail-row' },
                el('td', { colspan: 6 },
                  el('div', { class: 'sale-detail' },
                    el('div', {}, el('strong', {}, 'Name: '), s.customer_name || '—'),
                    el('div', {}, el('strong', {}, 'Email: '), s.customer_email || '—'),
                    el('div', {}, el('strong', {}, 'Phone: '), s.customer_phone || '—'),
                    el('div', {}, el('strong', {}, 'Stripe Session: '), el('code', {}, s.stripe_session_id || '—')),
                    el('div', {}, el('strong', {}, 'Source: '), s.source || '—'),
                    el('div', {}, el('strong', {}, 'Date: '), new Date(s.created_at).toLocaleString())
                  )
                )
              );
              row.after(detail);
            });
            return row;
          }))
        );
        salesHost.appendChild(table);

        // Mobile cards
        const mobileCards = el('div', { class: 'sales-cards-mobile' });
        for (const s of r.sales) {
          const amtClass = s.payment_status === 'paid' ? 'sale-paid' : 'sale-failed';
          mobileCards.appendChild(el('div', { class: 'sale-card-mobile' },
            el('div', { class: 'sale-card-top' },
              el('div', {},
                el('div', { class: 'sale-customer' }, s.customer_name || 'Unknown'),
                el('div', { class: 'muted small' }, s.customer_email || '')
              ),
              el('div', { class: amtClass + ' sale-amount' }, '$' + Number(s.amount).toFixed(2))
            ),
            el('div', { class: 'sale-card-bottom' },
              el('span', { class: 'badge source-badge' }, s.source || 'direct'),
              el('span', {}, s.products?.name || '—'),
              el('span', { class: 'muted' }, timeAgo(s.created_at)),
              statusBadge(s.payment_status === 'paid' ? 'Paid' : s.payment_status === 'failed' ? 'Failed' : 'Refunded')
            )
          ));
        }
        salesHost.appendChild(mobileCards);

        // Pagination
        if (r.pages > 1) {
          const pag = el('div', { class: 'pagination' });
          for (let i = 1; i <= r.pages; i++) {
            pag.appendChild(el('button', {
              class: 'btn sm' + (i === currentPage ? ' active' : ' ghost'),
              onclick: () => loadSalesTable(i)
            }, String(i)));
          }
          salesHost.appendChild(pag);
        }
      } catch (e) {
        salesHost.innerHTML = '';
        salesHost.appendChild(el('div', { class: 'err' }, e.message));
      }
    }

    loadSalesTable();

  } catch (e) {
    cards.innerHTML = '';
    cards.appendChild(el('div', { class: 'err' }, e.message));
  }
  return wrap;
}

// ============================================================
// ADD / EDIT PRODUCT MODAL
// ============================================================
function openAddProductModal() { openProductModal(null); }
function openEditProductModal(product) { openProductModal(product); }

function openProductModal(existing) {
  const isEdit = !!existing;
  let step = 1;

  // Form fields
  const nameInput = el('input', { value: existing?.name || '', placeholder: 'Product name' });
  const descInput = el('textarea', { rows: 3, placeholder: 'Product description' }, existing?.description || '');
  const priceInput = el('input', { type: 'number', step: '0.01', min: '0', value: existing?.price || '', placeholder: '0.00' });
  const imageUrlInput = el('input', { value: existing?.image_url || '', placeholder: 'Image URL (or upload below)' });
  const paymentLinkInput = el('input', { value: existing?.stripe_payment_link || '', placeholder: 'https://buy.stripe.com/...' });
  const priceIdInput = el('input', { value: existing?.stripe_price_id || '', placeholder: 'price_... (optional)' });

  const showInFunnel = el('input', { type: 'checkbox' });
  showInFunnel.checked = existing?.show_in_funnel || false;

  const FUNNEL_PAGES = [
    { value: 'thank-you', label: 'Thank You Page (/thank-you)' },
    { value: 'rs2', label: 'RS2 Page (/rs2)' },
    { value: 'fit', label: 'Fit Page (/fit)' },
    { value: '/', label: 'Main Website (/)' }
  ];
  const funnelChecks = FUNNEL_PAGES.map(fp => {
    const cb = el('input', { type: 'checkbox', value: fp.value });
    cb.checked = (existing?.funnel_pages || []).includes(fp.value);
    return { cb, label: fp.label, value: fp.value };
  });

  const funnelSection = el('div', { class: 'funnel-checks', style: showInFunnel.checked ? '' : 'display:none' });
  for (const fc of funnelChecks) {
    funnelSection.appendChild(el('label', { class: 'toggle-row' }, fc.cb, el('span', {}, fc.label)));
  }
  showInFunnel.addEventListener('change', () => {
    funnelSection.style.display = showInFunnel.checked ? '' : 'none';
  });

  const stepHost = el('div', {});
  const errBox = el('div', {});

  const renderStep = () => {
    stepHost.innerHTML = '';
    errBox.innerHTML = '';

    if (step === 1) {
      stepHost.appendChild(el('h3', {}, 'Product Details'));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Product name'), nameInput));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Description'), descInput));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Price ($)'), priceInput));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Image URL'), imageUrlInput));
    } else if (step === 2) {
      stepHost.appendChild(el('h3', {}, 'Stripe Connection'));
      stepHost.appendChild(el('p', { class: 'muted' }, 'Paste your existing Stripe payment link'));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Stripe Payment Link'), paymentLinkInput));
      stepHost.appendChild(el('div', { class: 'field' }, el('label', {}, 'Stripe Price ID (optional)'), priceIdInput));
      stepHost.appendChild(el('div', { class: 'muted', style: 'margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:var(--r-sm)' },
        el('strong', {}, 'Coming Soon: '), 'Create new product in Stripe directly (requires Stripe Connect)'
      ));
    } else if (step === 3) {
      stepHost.appendChild(el('h3', {}, 'Funnel Settings'));
      stepHost.appendChild(el('label', { class: 'toggle-row' }, showInFunnel, el('span', {}, 'Show in client funnel')));
      stepHost.appendChild(funnelSection);
    } else if (step === 4) {
      stepHost.appendChild(el('h3', {}, 'Review & Save'));
      stepHost.appendChild(el('div', { class: 'product-review' },
        el('div', {}, el('strong', {}, 'Name: '), nameInput.value || '—'),
        el('div', {}, el('strong', {}, 'Price: '), '$' + (parseFloat(priceInput.value) || 0).toFixed(2)),
        el('div', {}, el('strong', {}, 'Description: '), descInput.value || '—'),
        el('div', {}, el('strong', {}, 'Payment Link: '), paymentLinkInput.value || '—'),
        el('div', {}, el('strong', {}, 'Funnel: '),
          showInFunnel.checked
            ? funnelChecks.filter(fc => fc.cb.checked).map(fc => fc.label).join(', ') || 'None selected'
            : 'Off'
        )
      ));
    }
  };

  renderStep();

  const close = () => bg.remove();
  const save = async () => {
    if (!nameInput.value.trim()) { errBox.innerHTML = '<div class="err">Product name is required</div>'; return; }
    const body = {
      name: nameInput.value.trim(),
      description: descInput.value.trim() || null,
      price: parseFloat(priceInput.value) || 0,
      stripe_payment_link: paymentLinkInput.value.trim() || null,
      stripe_price_id: priceIdInput.value.trim() || null,
      image_url: imageUrlInput.value.trim() || null,
      show_in_funnel: showInFunnel.checked,
      funnel_pages: showInFunnel.checked ? funnelChecks.filter(fc => fc.cb.checked).map(fc => fc.value) : []
    };
    if (isEdit) body.id = existing.id;

    try {
      await api('/api/portal/products', {
        method: isEdit ? 'PATCH' : 'POST',
        body
      });
      // Trigger funnel sync if show_in_funnel
      if (body.show_in_funnel) {
        api('/api/products/sync', { method: 'POST' }).catch(() => {});
      }
      close();
      toast(isEdit ? 'Product updated' : 'Product saved');
      render();
    } catch (e) {
      errBox.innerHTML = `<div class="err">${e.message}</div>`;
    }
  };

  const modal = el('div', { class: 'modal product-modal' },
    el('h2', {}, isEdit ? 'Edit Product' : 'Add Product'),
    el('div', { class: 'step-indicator' },
      ...[1, 2, 3, 4].map(s => el('div', { class: 'step-dot' + (s === step ? ' active' : s < step ? ' done' : '') }, String(s)))
    ),
    errBox,
    stepHost,
    el('div', { class: 'row', style: 'justify-content:flex-end; gap:8px; margin-top:16px' },
      el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
      step > 1 ? el('button', { class: 'btn ghost', onclick: () => { step--; renderStep(); modal.querySelector('.step-indicator').innerHTML = ''; for (let s = 1; s <= 4; s++) modal.querySelector('.step-indicator').appendChild(el('div', { class: 'step-dot' + (s === step ? ' active' : s < step ? ' done' : '') }, String(s))); }}, 'Back') : null,
      step < 4
        ? el('button', { class: 'btn', onclick: () => { step++; renderStep(); modal.querySelector('.step-indicator').innerHTML = ''; for (let s = 1; s <= 4; s++) modal.querySelector('.step-indicator').appendChild(el('div', { class: 'step-dot' + (s === step ? ' active' : s < step ? ' done' : '') }, String(s))); }}, 'Next')
        : el('button', { class: 'btn', onclick: save }, 'Save Product')
    )
  );
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
}

// ============================================================
// ANALYTICS
// ============================================================
function miniBarChart(data, color, height = 120) {
  const entries = Object.entries(data);
  if (!entries.length) return el('div', { class: 'muted' }, 'No data');
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const chart = el('div', { class: 'mini-chart', style: `height:${height}px` });
  for (const [label, value] of entries) {
    const pct = (value / max * 100).toFixed(1);
    const bar = el('div', { class: 'chart-bar', style: `height:${pct}%; background:${color}`, title: `${label}: ${typeof value === 'number' ? value.toFixed(value % 1 ? 2 : 0) : value}` });
    const col = el('div', { class: 'chart-col' }, bar);
    chart.appendChild(col);
  }
  return chart;
}

function miniLineChart(data, color, height = 120) {
  const entries = Object.entries(data);
  if (!entries.length) return el('div', { class: 'muted' }, 'No data');
  const values = entries.map(([, v]) => v);
  const max = Math.max(...values, 1);
  const min = 0;
  const w = 100;
  const h = height;
  const points = values.map((v, i) => {
    const x = (i / Math.max(entries.length - 1, 1)) * w;
    const y = h - ((v - min) / (max - min)) * h;
    return `${x},${y}`;
  }).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'line-chart-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const polyline = document.createElementNS(ns, 'polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', color);
  polyline.setAttribute('stroke-width', '1.5');
  polyline.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(polyline);
  // Fill area
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `0,${h} ${points} ${w},${h}`);
  area.setAttribute('fill', color);
  area.setAttribute('opacity', '0.1');
  svg.appendChild(area);
  return el('div', { class: 'line-chart-wrap', style: `height:${height}px` }, svg);
}

async function viewAnalytics() {
  ge8Track('tab_viewed', { tab_name: 'analytics' });
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Analytics'),
    el('div', { class: 'muted' }, 'Performance overview')
  ));

  // Tier gate: funnel conversion rates locked for starter
  if (!hasTierAccess('growth')) {
    wrap.appendChild(tierLock('Funnel Conversion Rates', 'growth',
      'Upgrade to Growth to unlock funnel analytics and conversion tracking.'));
  }

  // Overview cards
  const cards = el('div', { class: 'cards' });
  wrap.appendChild(cards);
  cards.appendChild(skeleton(1));

  // Leads chart
  const leadsChartPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Leads — Last 30 Days'),
    skeleton(3)
  );
  wrap.appendChild(leadsChartPanel);

  // Leads by source
  const sourcePanel = el('div', { class: 'panel' },
    el('h2', {}, 'Leads by Source'),
    skeleton(2)
  );
  wrap.appendChild(sourcePanel);

  // Funnel performance
  const funnelPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Funnel Performance'),
    skeleton(2)
  );
  wrap.appendChild(funnelPanel);

  // Sales chart
  const salesChartPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Revenue — Last 30 Days'),
    skeleton(3)
  );
  wrap.appendChild(salesChartPanel);

  // Top sources
  const topSourcesPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Top Lead Sources'),
    skeleton(2)
  );
  wrap.appendChild(topSourcesPanel);

  // Recent activity
  const activityPanel = el('div', { class: 'panel' },
    el('h2', {}, 'Recent Activity'),
    skeleton(5)
  );
  wrap.appendChild(activityPanel);

  try {
    const [analyticsR, ga4R] = await Promise.all([
      api('/api/portal/analytics'),
      api('/api/analytics/ga4').catch(() => ({ unavailable: true }))
    ]);

    // ---- Overview Cards ----
    cards.innerHTML = '';
    const leadsArrow = analyticsR.overview.leads_change >= 0 ? '\u2191' : '\u2193';
    cards.appendChild(card('Total Leads', analyticsR.overview.total_leads,
      `this month ${leadsArrow} ${Math.abs(analyticsR.overview.leads_change)}%`, 'accent'));
    cards.appendChild(card('Bookings', analyticsR.overview.bookings_this_month, 'confirmed this month'));
    cards.appendChild(card('Revenue', '$' + analyticsR.overview.revenue_this_month.toFixed(2), 'this month'));
    cards.appendChild(card('Portal Logins',
      ga4R.unavailable ? 'N/A' : (ga4R.active_today || 0),
      ga4R.unavailable ? 'GA4 unavailable' : 'active today'));

    // ---- Leads Line Chart ----
    leadsChartPanel.innerHTML = '';
    leadsChartPanel.appendChild(el('h2', {}, 'Leads \u2014 Last 30 Days'));
    leadsChartPanel.appendChild(miniLineChart(analyticsR.leads_by_day, '#2DD4BF', 140));
    // Chart legend
    const leadsTotal = Object.values(analyticsR.leads_by_day).reduce((a, b) => a + b, 0);
    leadsChartPanel.appendChild(el('div', { class: 'chart-legend muted' },
      `${leadsTotal} total leads over 30 days`));

    // ---- Leads by Source Bar Chart ----
    sourcePanel.innerHTML = '';
    sourcePanel.appendChild(el('h2', {}, 'Leads by Source'));
    const sourceEntries = Object.entries(analyticsR.leads_by_source);
    if (sourceEntries.length) {
      sourcePanel.appendChild(miniBarChart(analyticsR.leads_by_source, '#2DD4BF', 100));
      const sourceLabels = el('div', { class: 'source-labels' });
      for (const [src, count] of sourceEntries.sort((a, b) => b[1] - a[1])) {
        sourceLabels.appendChild(el('div', { class: 'source-label-row' },
          el('span', { class: 'source-dot', style: 'background:#2DD4BF' }),
          el('span', {}, src),
          el('span', { class: 'muted' }, String(count))
        ));
      }
      sourcePanel.appendChild(sourceLabels);
    } else {
      sourcePanel.appendChild(emptyState('No lead source data yet.'));
    }

    // ---- Funnel Performance ----
    funnelPanel.innerHTML = '';
    funnelPanel.appendChild(el('h2', {}, 'Funnel Performance'));
    const funnelPages = [
      { path: '/fit', label: 'Fit Funnel' },
      { path: '/rs2', label: 'RS2 Page' },
      { path: '/', label: 'Main Site' }
    ];
    const funnelGrid = el('div', { class: 'funnel-grid' });
    for (const fp of funnelPages) {
      const visits = ga4R.unavailable ? 'N/A' : (ga4R.funnel_pages?.[fp.path] || 0);
      const submissions = analyticsR.funnel_leads?.[fp.path] || analyticsR.funnel_leads?.[fp.path.slice(1)] || 0;
      let rate = 'N/A';
      let rateClass = '';
      if (!ga4R.unavailable && typeof visits === 'number' && visits > 0) {
        const pct = (submissions / visits * 100);
        rate = pct.toFixed(1) + '%';
        rateClass = pct > 5 ? 'conversion-green' : pct >= 2 ? 'conversion-yellow' : 'conversion-red';
      }
      funnelGrid.appendChild(el('div', { class: 'funnel-card' },
        el('div', { class: 'funnel-card-path' }, fp.label),
        el('div', { class: 'funnel-card-row' },
          el('span', {}, 'Visits'), el('span', {}, String(visits))),
        el('div', { class: 'funnel-card-row' },
          el('span', {}, 'Submissions'), el('span', {}, String(submissions))),
        el('div', { class: 'funnel-card-row' },
          el('span', {}, 'Conversion'),
          el('span', { class: rateClass }, rate))
      ));
    }
    funnelPanel.appendChild(funnelGrid);

    // ---- Sales Bar Chart ----
    salesChartPanel.innerHTML = '';
    salesChartPanel.appendChild(el('h2', {}, 'Revenue \u2014 Last 30 Days'));
    salesChartPanel.appendChild(miniBarChart(analyticsR.sales_by_day, '#F5C518', 140));
    const revTotal = Object.values(analyticsR.sales_by_day).reduce((a, b) => a + b, 0);
    salesChartPanel.appendChild(el('div', { class: 'chart-legend muted' },
      `$${revTotal.toFixed(2)} total revenue over 30 days`));

    // ---- Top Sources Table ----
    topSourcesPanel.innerHTML = '';
    topSourcesPanel.appendChild(el('h2', {}, 'Top Lead Sources'));
    if (analyticsR.top_sources.length) {
      const tbl = el('div', { class: 'top-sources-list' });
      analyticsR.top_sources.forEach((s, i) => {
        tbl.appendChild(el('div', { class: 'top-source-row' },
          el('span', { class: 'top-source-rank' }, '#' + (i + 1)),
          el('span', { class: 'top-source-name' }, s.source),
          el('span', { class: 'muted' }, `${s.count} leads`)
        ));
      });
      topSourcesPanel.appendChild(tbl);
    } else {
      topSourcesPanel.appendChild(emptyState('No source data yet.'));
    }

    // ---- Recent Activity Feed ----
    activityPanel.innerHTML = '';
    activityPanel.appendChild(el('h2', {}, 'Recent Activity'));
    if (analyticsR.recent_activity.length) {
      const feed = el('div', { class: 'feed' });
      for (const ev of analyticsR.recent_activity) {
        const dotClass = ev.type === 'lead' ? 'lead' : ev.type === 'booking' ? 'booking' : ev.type === 'sale' ? 'sale' : 'call';
        feed.appendChild(el('div', { class: 'feed-row' },
          el('div', { class: 'feed-type ' + dotClass }, ev.type),
          el('div', { class: 'feed-body' },
            el('div', { class: 'feed-label' }, `${ev.name || 'Unknown'} ${ev.action}`),
            el('div', { class: 'feed-sub muted' }, `via ${ev.source || 'unknown'}`)
          ),
          el('div', { class: 'feed-time muted' }, timeAgo(ev.ts))
        ));
      }
      activityPanel.appendChild(feed);
    } else {
      activityPanel.appendChild(emptyState('No activity yet \u2014 analytics will populate as leads and activity come in.'));
    }
  } catch (e) {
    cards.innerHTML = '';
    cards.appendChild(el('div', { class: 'err' }, e.message));
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
    connect:   'settings',
    contacts:  'settings'
  };
  if (LEGACY_REDIRECTS[state.view]) state.view = LEGACY_REDIRECTS[state.view];

  let view;
  try {
    switch (state.view) {
      case 'admin':     view = await viewAdmin();     break;
      case 'dashboard': view = await viewDashboard(); break;
      case 'sales':     view = await viewSales();     break;
      case 'calls':     view = await viewCalls();     break;
      case 'messages':  view = await viewMessages();  break;
      case 'analytics': view = await viewAnalytics(); break;
      case 'nudges':    view = await viewNudges();    break;
      case 'contacts':  view = await viewContacts();  break;
      case 'settings':  view = await viewSettings();  break;
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
  ge8Track('credits_purchased', {
    pack_name: params.get('pack') || null,
    amount: params.get('amount') || null
  });
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
  ge8Track('pwa_install_prompted');
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

// Build the actual channel. Extracted so we can rebuild it on foreground
// without duplicating the handler wiring.
function ge8BuildRealtimeChannel(sb, clientId) {
  // Unique channel name per subscription (suffix with Date.now) so that a
  // previous, half-dead channel on the Supabase server can't collide with
  // the fresh one we're about to subscribe.
  return sb.channel(`portal-${clientId}-${Date.now()}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'leads', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const l = payload.new || {};
        console.log('[realtime] lead INSERT', l);
        notify('New lead', `${l.name || 'Someone'} just came in${l.source ? ' via ' + l.source : ''}`);
        // If the user is currently on a view that lists leads, re-run
        // the view so the new row appears without waiting for a manual
        // refresh. Cheap: viewDashboard/viewLeads just re-hit the same
        // REST endpoints the dashboard already polls on mount.
        if (state.view === 'dashboard' || state.view === 'leads') {
          try { render(); } catch {}
        }
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'bookings', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const b = payload.new || {};
        console.log('[realtime] booking INSERT', b);
        const when = b.starts_at ? new Date(b.starts_at).toLocaleString() : 'soon';
        notify('New booking', `Confirmed for ${when}`);
        if (state.view === 'dashboard') {
          try { render(); } catch {}
        }
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'artist_inquiries', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const a = payload.new || {};
        console.log('[realtime] artist_inquiry INSERT', a);
        notify('New Artist Inquiry', `${a.artist_name || 'Someone'} just reached out`);
        if (state.view === 'dashboard') {
          try { render(); } catch {}
        }
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'studio_bookings', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const b = payload.new || {};
        console.log('[realtime] studio_booking INSERT', b);
        const when = b.session_date ? new Date(b.session_date).toLocaleString() : 'soon';
        notify('Studio Session Booked', `${b.artist_name || 'Artist'} booked for ${when}`);
        if (state.view === 'dashboard') {
          try { render(); } catch {}
        }
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'sales', filter: `client_id=eq.${clientId}` },
      (payload) => {
        const s = payload.new || {};
        console.log('[realtime] sale INSERT', s);
        if (s.payment_status === 'paid') {
          notify('New Sale!', `$${Number(s.amount || 0).toFixed(2)} — ${s.customer_name || 'New customer'}`);
          state.newSaleIds = state.newSaleIds || new Set();
          state.newSaleIds.add(s.id);
        }
        if (state.view === 'sales' || state.view === 'dashboard' || state.view === 'analytics') {
          try { render(); } catch {}
        }
      })
    .subscribe((status) => {
      console.log('[realtime] channel status:', status);
    });
}

async function startRealtime() {
  if (!state.client?.id) return;
  const sb = await ensureSupabaseBrowser();
  if (!sb) return;
  const clientId = state.client.id;

  // Always tear down any existing channel before subscribing fresh. This
  // is what makes the PWA recover from a backgrounded/killed WebSocket —
  // iOS and Android kill the socket when the app is backgrounded and
  // don't restore it on foreground, so we can't just reuse the stale
  // channel object. Removing it first avoids leaking a dead channel on
  // the Supabase server.
  if (realtimeChannel) {
    try { sb.removeChannel(realtimeChannel); } catch {}
    realtimeChannel = null;
  }

  realtimeChannel = ge8BuildRealtimeChannel(sb, clientId);
}

function stopRealtime() {
  if (realtimeChannel && supabaseBrowser) {
    try { supabaseBrowser.removeChannel(realtimeChannel); } catch {}
    realtimeChannel = null;
  }
}

// CRITICAL for PWAs: iOS and Android kill WebSockets when the app is
// backgrounded and don't restore them on foreground. Without the handlers
// below, the dashboard would silently stop receiving live lead/booking
// events until the user killed and reopened the PWA. We resubscribe when:
//   - visibilitychange → visible (standard page-lifecycle)
//   - pageshow with e.persisted=true (iOS back-forward cache restore,
//     which doesn't fire visibilitychange)
//   - online (network dropped and came back)
// On each of these we also re-render the current view, which refetches
// the leads list via /api/portal/crm so any rows that arrived while
// we were backgrounded show up even if Realtime missed them.
let ge8LifecycleBound = false;
function ge8BindLifecycleHandlers() {
  if (ge8LifecycleBound) return;
  ge8LifecycleBound = true;

  const resync = (reason) => {
    if (!state.token || !state.client?.id) return;
    console.log('[realtime]', reason, '— resubscribing + refetching');
    startRealtime();
    // Re-run the current view so list data refreshes. Cheap — hits the
    // existing REST endpoints that the view already uses on mount.
    if (state.view === 'dashboard' || state.view === 'leads') {
      try { render(); } catch {}
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resync('visible');
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) resync('pageshow-bfcache');
  });
  window.addEventListener('online', () => resync('online'));
}

// Patch auth lifecycle to start/stop the realtime subscription. We rebind
// the existing top-level functions so all callers go through the patched
// versions without needing to refactor every call site.
const _origLoadMe = loadMe;
loadMe = async function patchedLoadMe() {  // eslint-disable-line no-func-assign
  await _origLoadMe();
  if (state.client?.id) {
    startRealtime();
    ge8BindLifecycleHandlers();
  }
};
const _origLogout = logout;
logout = function patchedLogout() {  // eslint-disable-line no-func-assign
  stopRealtime();
  _origLogout();
};

// If the user is already signed in on first load, kick off realtime once
// the initial render finishes hydrating state.client.
setTimeout(() => {
  if (state.client?.id) {
    startRealtime();
    ge8BindLifecycleHandlers();
  }
}, 1500);
