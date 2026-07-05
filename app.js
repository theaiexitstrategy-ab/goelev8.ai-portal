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
  refreshToken: localStorage.getItem('ge8_refresh') || null,
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

async function api(path, opts = {}, _retried = false) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (state.isAdmin && state.impersonating) headers['x-admin-as-client'] = state.impersonating;
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
  });
  // On 401, try to refresh the token once before logging out
  if (res.status === 401 && !_retried && state.refreshToken) {
    const refreshed = await refreshSession();
    if (refreshed) return api(path, opts, true);
    logout(); throw new Error('unauthorized');
  }
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Throw the standard message string so existing call sites that
    // read .message keep working, but attach the full response body
    // as .data so callers (e.g. blast modal) can show segment counts
    // / required credits / per-tenant context without re-fetching.
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// Refresh the Supabase JWT using the stored refresh token. Returns true
// on success (state.token is updated), false if the refresh failed.
async function refreshSession() {
  try {
    const r = await fetch('/api/auth?action=refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });
    if (!r.ok) return false;
    const data = await r.json();
    state.token = data.access_token;
    state.refreshToken = data.refresh_token;
    localStorage.setItem('ge8_token', data.access_token);
    localStorage.setItem('ge8_refresh', data.refresh_token);
    return true;
  } catch { return false; }
}

function logout() {
  localStorage.removeItem('ge8_token');
  localStorage.removeItem('ge8_refresh');
  localStorage.removeItem('ge8_impersonate');
  state.token = null; state.refreshToken = null;
  state.user = null; state.client = null;
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

// Populates the sidebar impersonation tabs with all clients from DB.
// Only invoked when logged in as ab@goelev8.ai. Ensures the four required
// clients exist by delegating to an admin ensure endpoint.
async function loadImpersonateTabs() {
  if (state.user?.email !== 'ab@goelev8.ai') return;
  const container = document.getElementById('impersonate-tabs');
  if (!container) return;
  try {
    await api('/api/admin?action=ensure-default-clients', { method: 'POST' }).catch(() => {});
    const r = await api('/api/admin?action=list-clients');
    const clients = (r.clients || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    container.innerHTML = '';
    if (!clients.length) {
      container.appendChild(el('div', { class: 'muted', style: 'font-size:0.75rem' }, 'No clients'));
      return;
    }
    clients.forEach(c => {
      const active = state.impersonating === c.id;
      container.appendChild(el('button', {
        class: 'impersonate-tab' + (active ? ' active' : ''),
        onclick: () => { setImpersonation(c.id); render(); }
      }, c.name || c.slug));
    });
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(el('div', { class: 'err', style: 'font-size:0.75rem' }, 'Failed to load clients'));
  }
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
        localStorage.setItem('ge8_refresh', r.refresh_token);
        state.token = r.access_token;
        state.refreshToken = r.refresh_token;
        startTokenRefreshTimer();
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
    el('div', { class: 'forgot-row' },
      el('a', {
        href: '#',
        class: 'forgot-link',
        onclick: async (e) => {
          e.preventDefault();
          errBox.innerHTML = '';
          const addr = (emailInput.value || '').trim();
          if (!addr) {
            errBox.innerHTML = '<div class="err">Enter your email above first, then click Forgot.</div>';
            emailInput.focus();
            return;
          }
          try {
            await api('/api/auth?action=forgot-password', {
              method: 'POST',
              body: { email: addr }
            });
            errBox.innerHTML = '<div class="ok">Check your inbox — if that email is registered, a password reset link is on its way.</div>';
          } catch (err) {
            errBox.innerHTML = `<div class="err">${err.message || 'Could not send reset email'}</div>`;
          }
        }
      }, 'Forgot your password?')
    ),
    el('div', { class: 'footer' }, 'Powered by GoElev8 AI Infrastructure')
  );
  box.appendChild(form);
  return el('div', { class: 'login' }, box);
}

// ============================================================
// PASSWORD RESET VIEW
// ============================================================
// Rendered when the user lands on /?reset=1 from the recovery email.
// Supabase puts the recovery JWT in the URL hash as #access_token=…&
// type=recovery&… — we parse it, prompt for a new password, and POST to
// /api/auth?action=reset-password-with-token. Once successful we drop
// the hash + flag and let the regular login screen take over.
function renderResetPassword() {
  const box = el('div', { class: 'box' });
  const errBox = el('div');
  const np = el('input', { type: 'password', placeholder: 'At least 8 characters', required: true, minlength: 8 });
  const np2 = el('input', { type: 'password', placeholder: 'Confirm new password', required: true, minlength: 8 });

  // Parse the recovery hash. Supabase Auth uses hash params, not query params.
  const hash = (window.location.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const recoveryToken = params.get('access_token') || '';
  const isRecovery = params.get('type') === 'recovery' || !!recoveryToken;

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.innerHTML = '';
      if (np.value !== np2.value) {
        errBox.innerHTML = '<div class="err">Passwords don’t match.</div>';
        return;
      }
      if (np.value.length < 8) {
        errBox.innerHTML = '<div class="err">Password must be at least 8 characters.</div>';
        return;
      }
      if (!recoveryToken) {
        errBox.innerHTML = '<div class="err">Reset link expired or invalid. Click “Forgot your password?” from the login screen to get a fresh email.</div>';
        return;
      }
      try {
        await api('/api/auth?action=reset-password-with-token', {
          method: 'POST',
          body: { access_token: recoveryToken, new_password: np.value }
        });
        // Strip the hash + ?reset=1 so a refresh doesn't bring us back here.
        history.replaceState({}, '', '/');
        errBox.innerHTML = '<div class="ok">Password updated! Redirecting to sign-in…</div>';
        setTimeout(() => { window.location.href = '/'; }, 1200);
      } catch (err) {
        errBox.innerHTML = `<div class="err">${err.message || 'Reset failed'}</div>`;
      }
    }
  },
    el('div', { class: 'login-brand' },
      el('div', { class: 'logo' }, el('img', { src: '/logo.png', alt: '' })),
      el('div', {},
        el('h1', {}, 'Reset password'),
        el('p', { style: 'margin:2px 0 0' }, isRecovery
          ? 'Set a new password for your GoElev8.AI account.'
          : 'Open the link in the password-reset email we sent.')
      )
    ),
    errBox,
    el('div', { class: 'field' }, el('label', {}, 'New password'), np),
    el('div', { class: 'field' }, el('label', {}, 'Confirm password'), np2),
    el('button', { class: 'btn', type: 'submit', disabled: !recoveryToken ? '' : false }, 'Update password →'),
    el('div', { class: 'forgot-row' },
      el('a', { href: '/', class: 'forgot-link' }, '← Back to sign in')
    ),
    el('div', { class: 'footer' }, 'Powered by GoElev8 AI Infrastructure')
  );
  box.appendChild(form);
  return el('div', { class: 'login' }, box);
}

// ── Push notification registration ─────────────────────────
// Registers the service worker and subscribes to web push. Runs once
// after login; subsequent calls are no-ops (SW is already registered,
// subscription already saved). Silent-fail so push issues never block
// portal functionality.
let _pushInitDone = false;
async function initPushNotifications() {
  if (_pushInitDone) return;
  _pushInitDone = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (typeof Notification === 'undefined') return;
    if (!state.vapidPublicKey) return;

    const reg = await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;

    // Check if already subscribed
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Request permission (browser shows the prompt)
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;

      // Convert VAPID key from base64 URL string to Uint8Array
      const urlB64ToUint8Array = (b64) => {
        const pad = '='.repeat((4 - b64.length % 4) % 4);
        const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
        return Uint8Array.from(raw, c => c.charCodeAt(0));
      };

      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(state.vapidPublicKey)
      });
    }

    // Save subscription to Supabase via our API
    const subJson = sub.toJSON();
    await api('/api/portal/push-subscribe', {
      method: 'POST',
      body: {
        endpoint: subJson.endpoint,
        keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth }
      }
    });
  } catch (e) {
    console.warn('[push] registration failed (non-fatal):', e.message);
  }
}

// Proactive token refresh — runs every 45 minutes so the token never
// actually expires (Supabase JWTs last 1 hour). This prevents the brief
// logged-out state that can happen if the user is idle for >1 hour.
let _refreshInterval = null;
function startTokenRefreshTimer() {
  if (_refreshInterval) clearInterval(_refreshInterval);
  _refreshInterval = setInterval(async () => {
    if (!state.refreshToken) return;
    const ok = await refreshSession();
    if (!ok) { logout(); }
  }, 45 * 60 * 1000); // 45 minutes
}

async function loadMe() {
  const r = await api('/api/portal/me');
  state.user = r.user;
  state.client = r.client;
  state.isAdmin = !!r.isAdmin;
  // Public Supabase config used by the Messages tab realtime channel.
  // Anon key is safe in the browser; RLS still enforces tenant isolation.
  state.supabaseConfig = r.supabase || null;
  state.vapidPublicKey = r.vapid_public_key || null;

  // Register service worker + subscribe to push notifications (fire-and-forget).
  // Only runs once per browser session; the SW handles push events from there.
  initPushNotifications();

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
  messaging: 'Messaging',
  applications: 'Applications',
  trainer_applications: 'Trainer Applications',
  merch:     'Merch',
  analytics: 'Analytics',
  admin:     'Master Admin',
  admin_sales: 'Sales',
  taes:      'TAES',
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
  messaging: '💬',
  applications: '📋',
  trainer_applications: '🏋️',
  merch:     '🛍️',
  analytics: '📈',
  admin:     '🛡️',
  admin_sales: '💰',
  taes:      '🎓',
  booking_admin: '🗓️'
};

const DEFAULT_TABS = ['overview','leads','messaging','settings'];
const ADMIN_TABS = ['admin','admin_sales','taes','booking_admin','activity','analytics'];

// Final pass over the resolved tab list to:
//   - Drop the deprecated 'contacts' tab (Leads is the unified CRM view)
//   - Replace any standalone 'messages'/'blasts'/'nudges' with the
//     unified 'messaging' tab so legacy portal_tabs rows don't show
//     duplicate buttons
//   - Force 'overview' to be first and 'settings' last; everything
//     else keeps its declared order
function collapseToCleanNav(input) {
  const out = [];
  let messagingInserted = false;
  for (const id of input) {
    if (id === 'contacts') continue;
    if (id === 'messages' || id === 'blasts' || id === 'nudges') {
      if (!messagingInserted) { out.push('messaging'); messagingInserted = true; }
      continue;
    }
    if (id === 'messaging') {
      if (messagingInserted) continue;
      messagingInserted = true;
    }
    if (!out.includes(id)) out.push(id);
  }
  // Pin overview to the front, settings to the back.
  const pinFront = (arr, id) => {
    const i = arr.indexOf(id);
    if (i < 0) return arr;
    return [id, ...arr.slice(0, i), ...arr.slice(i + 1)];
  };
  const pinBack = (arr, id) => {
    const i = arr.indexOf(id);
    if (i < 0) return arr;
    return [...arr.slice(0, i), ...arr.slice(i + 1), id];
  };
  let ordered = pinBack(pinFront(out, 'overview'), 'settings');
  // If 'applications' is in the list, slot it right after 'leads' so
  // tenant-specific tabs sit alongside the CRM rather than wherever
  // they were declared in the portal_tabs array.
  const aIdx = ordered.indexOf('applications');
  const lIdx = ordered.indexOf('leads');
  if (aIdx >= 0 && lIdx >= 0 && aIdx !== lIdx + 1) {
    ordered = ordered.filter((x) => x !== 'applications');
    const li = ordered.indexOf('leads');
    ordered.splice(li + 1, 0, 'applications');
  }
  // 'trainer_applications' lands right after 'applications' (or after
  // 'leads' if applications isn't enabled for this tenant), keeping all
  // intake-style tabs grouped together.
  const tIdx = ordered.indexOf('trainer_applications');
  if (tIdx >= 0) {
    const anchor = ordered.indexOf('applications');
    const fallback = ordered.indexOf('leads');
    const target = anchor >= 0 ? anchor : fallback;
    if (target >= 0 && tIdx !== target + 1) {
      ordered = ordered.filter((x) => x !== 'trainer_applications');
      const a = ordered.indexOf(anchor >= 0 ? 'applications' : 'leads');
      ordered.splice(a + 1, 0, 'trainer_applications');
    }
  }
  return ordered;
}

function shell(content) {
  const navBtn = (id, label) =>
    el('button', { class: state.view === id ? 'active' : '', onclick: () => { state.view = id; render(); } }, label);

  // Impersonation switcher — only for ab@goelev8.ai
  const isGlobalAdminEmail = state.user?.email === 'ab@goelev8.ai';
  const impersonateSwitcher = isGlobalAdminEmail
    ? el('div', { class: 'impersonate-switcher' },
        el('div', { class: 'impersonate-label' }, 'Impersonate as'),
        el('div', { class: 'impersonate-tabs', id: 'impersonate-tabs' },
          el('div', { class: 'muted', style: 'font-size:0.75rem' }, 'Loading…')
        )
      )
    : null;
  if (impersonateSwitcher) loadImpersonateTabs();

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
    if (baseTabs.includes('analytics')) return baseTabs;
    const t = [...baseTabs];
    const settingsIdx = t.indexOf('settings');
    if (settingsIdx >= 0) t.splice(settingsIdx, 0, 'analytics');
    else t.push('analytics');
    return t;
  };
  // Insert Bookings when the current client has an active booking_calendars
  // row AND the tenant hasn't explicitly opted out by setting portal_tabs
  // without 'bookings'. iSlay Studios uses this opt-out to swap Bookings
  // for Applications while still keeping a booking_calendars row around
  // for booking-link infrastructure that doesn't need its own sidebar tab.
  const withBookings = (baseTabs, explicitTabs) => {
    if (!state.bookingCalendar) return baseTabs;
    if (baseTabs.includes('bookings')) return baseTabs;
    if (explicitTabs) return baseTabs;
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
    // Client has custom tabs — treat that list as authoritative.
    // portal_tabs is the single source of truth for tab visibility.
    // Master admin gets analytics auto-injected as a safety net for
    // legacy tenant rows that were provisioned before the analytics
    // tab existed — every other login honors portal_tabs as-is.
    tabs = isGlobalAdmin ? withAnalytics(state.client.portal_tabs) : state.client.portal_tabs;
    tabs = withBookings(tabs, /* explicitTabs */ true);
  } else {
    // Default client tabs
    tabs = isGlobalAdmin ? withAnalytics(DEFAULT_TABS) : DEFAULT_TABS;
    tabs = withBookings(tabs, /* explicitTabs */ false);
  }
  // Final pass: collapse legacy tab ids onto the new consolidated set
  // and enforce sidebar ordering. The standalone 'messages', 'blasts',
  // and 'nudges' tabs are folded into the unified 'messaging' tab so
  // we don't leak duplicate buttons after the migration. 'contacts'
  // is dropped (Leads is the single CRM view). Final order: Overview
  // first, Settings last, everything else preserves declared order.
  tabs = collapseToCleanNav(tabs);
  const navButtons = tabs.map(id => navBtn(id, TAB_LABELS[id] || id));

  const logoSrc = state.client?.logo_url || '/logo.png';
  // When a tenant is signed in (or admin is impersonating one), show
  // their business name in the sidebar. Admin without impersonation
  // and the unauthed shell both fall back to 'GoElev8.AI'.
  const brandName = state.client
    ? (state.client.business_name || state.client.name || 'Client Portal')
    : 'GoElev8.AI';

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
  // tag it with .client-logo so the CSS gives it a white background
  // — most tenant logos read better against white than against the
  // default brand gradient.
  const isClientLogo = !!state.client?.logo_url;
  const logoClass = isClientLogo ? 'logo client-logo' : 'logo';

  // Tag the brand wrapper with the active client's slug so CSS can
  // apply per-tenant overrides (e.g. iSlay Studios prefers a black
  // logo container, while most other tenants read better on white).
  const brandSlug = state.client?.slug || '';

  // Mobile header (hamburger + brand)
  const mobileHeader = el('div', { class: 'mobile-header' },
    el('button', { class: 'nav-toggle', onclick: toggleNav },
      el('span'), el('span'), el('span')
    ),
    el('div', { class: 'mobile-brand', 'data-client-slug': brandSlug },
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
      el('div', { class: 'brand', 'data-client-slug': brandSlug },
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
      impersonateSwitcher,
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

  // The /r2s analytics + ebook sales panels used to live here on the
  // Overview, but they're now consolidated into the Analytics tab
  // (loadR2sAnalyticsSection in viewAnalytics) so the Overview stays
  // a clean dashboard summary.

  // Quick top-up panel
  const tu = el('div', { class: 'panel' });
  tu.appendChild(el('h2', {}, 'Buy SMS credits'));
  tu.appendChild(el('p', { class: 'muted' }, 'Pick a pack — credits are added instantly after payment.'));
  const packsRow = el('div', { class: 'cards' });
  // Mirrors lib/credits.js + goelev8.ai/smscalc — keep in sync. Each
  // entry includes baseCredits + bonusCredits so the card can show
  // "1,500 + 200 bonus" instead of just the total.
  const PACKS = [
    { id: 'starter', label: 'Starter', price: '$25',  credits: 500,   baseCredits: 500,   bonusCredits: 0,    rate: '$0.050/SMS', badge: null },
    { id: 'growth',  label: 'Growth',  price: '$60',  credits: 1700,  baseCredits: 1500,  bonusCredits: 200,  rate: '$0.035/SMS', badge: '🔥 Most Popular' },
    { id: 'pro',     label: 'Pro',     price: '$175', credits: 6000,  baseCredits: 5000,  bonusCredits: 1000, rate: '$0.029/SMS', badge: 'Best Value' },
    { id: 'elite',   label: 'Elite',   price: '$300', credits: 12500, baseCredits: 10000, bonusCredits: 2500, rate: '$0.024/SMS', badge: null }
  ];
  for (const p of PACKS) {
    const btn = el('button', { class: 'btn',
      onclick: async () => {
        try {
          const r = await api('/api/portal/credits?action=checkout', { method: 'POST', body: { pack: p.id } });
          window.location.href = r.url;
        } catch (e) { toast(e.message, true); }
      }}, `Buy ${p.label} →`);
    const creditsLine = p.bonusCredits
      ? el('div', { class: 'pack-credits' },
          `${p.baseCredits.toLocaleString()} + `,
          el('span', { style: 'color:#86efac' }, `${p.bonusCredits.toLocaleString()} bonus`)
        )
      : el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`);
    const c = el('div', { class: 'pack-card' + (p.badge ? ' featured' : '') },
      p.badge ? el('div', { class: 'pack-badge', style: 'font-size:0.65rem;color:#fbd38d;letter-spacing:0.06em;margin-bottom:2px' }, p.badge) : null,
      el('div', { class: 'pack-label' }, p.label),
      el('div', { class: 'pack-price' }, p.price),
      creditsLine,
      p.bonusCredits ? el('div', { class: 'muted', style: 'font-size:0.7rem' }, `${p.credits.toLocaleString()} total`) : null,
      el('div', { class: 'pack-rate' }, p.rate),
      btn
    );
    packsRow.appendChild(c);
  }
  tu.appendChild(packsRow);
  wrap.appendChild(tu);
  return wrap;
}

// Shared tag suggestions used across Leads, Bookings, Contacts and the
// SMS Blast filter. Pick from these or type a custom one — they're a
// hint, not an enum. Keep the list short; long lists hurt scanability.
// Customer avatar helpers — initials fall back when no photo's been
// uploaded yet. Color is deterministic from the name so the same
// customer keeps the same circle color across sessions.
function customerInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function avatarColorFromName(name) {
  const s = String(name || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 60%, 22%)`; // dark, saturated bg; initials read in light text
}

// Returns a circle <div> element. size = 'sm' (28) | 'md' (40) | 'lg' (88)
function renderAvatar({ name, avatarUrl, size = 'md', onClick = null }) {
  const cls = 'cust-avatar cust-avatar-' + size + (onClick ? ' clickable' : '');
  const node = el('div', { class: cls, title: onClick ? 'Click to upload a photo' : '' });
  if (avatarUrl) {
    node.appendChild(el('img', { src: avatarUrl, alt: '', class: 'cust-avatar-img' }));
  } else {
    node.style.background = avatarColorFromName(name);
    node.appendChild(el('span', { class: 'cust-avatar-initials' }, customerInitials(name)));
  }
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

// Bucket noisy GA4 sessionSource values into a small number of clean
// channels so the Top Traffic Sources panel reads at a glance instead
// of being a wall of "facebook.com / m.facebook.com / l.facebook.com /
// lm.facebook.com" rows. Anything we don't recognize falls into Other.
const TRAFFIC_CHANNELS = [
  { label: 'Direct',     icon: '🔗', match: (s) => /^\(?direct\)?$/i.test(s) || s === '(none)' || s === '' },
  { label: 'Google',     icon: '🔍', match: (s) => /\bgoogle\b/i.test(s) },
  { label: 'Facebook',   icon: '📘', match: (s) => /facebook|^fb$|^fb\.|m\.facebook|l\.facebook|lm\.facebook/i.test(s) },
  { label: 'Instagram',  icon: '📷', match: (s) => /instagram|\bigshid\b/i.test(s) },
  { label: 'TikTok',     icon: '🎵', match: (s) => /tiktok/i.test(s) },
  { label: 'YouTube',    icon: '▶️', match: (s) => /youtube|\byoutu\.be\b/i.test(s) },
  { label: 'X / Twitter',icon: '𝕏',  match: (s) => /^t\.co$|twitter|^x\.com$/i.test(s) },
  { label: 'LinkedIn',   icon: '💼', match: (s) => /linkedin|lnkd/i.test(s) },
  { label: 'Bing',       icon: '🔎', match: (s) => /^bing$|\bbing\b/i.test(s) },
  { label: 'Email',      icon: '✉️', match: (s) => /\bemail\b|\bnewsletter\b|mailchimp|sendgrid|klaviyo/i.test(s) },
  { label: 'AI / LLMs',  icon: '🤖', match: (s) => /chatgpt|openai|perplexity|claude\.ai|copilot/i.test(s) }
];

function categorizeSource(rawSource) {
  const s = String(rawSource || '').trim();
  for (const ch of TRAFFIC_CHANNELS) if (ch.match(s)) return ch;
  return { label: 'Other', icon: '🌐', match: () => false };
}

// Roll an array of { source, sessions, users } into channel buckets,
// summing sessions/users per channel and sorting descending by sessions.
function bucketSources(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const buckets = new Map();
  for (const r of rows) {
    const ch = categorizeSource(r.source);
    const key = ch.label;
    if (!buckets.has(key)) buckets.set(key, { label: ch.label, icon: ch.icon, sessions: 0, users: 0 });
    const b = buckets.get(key);
    b.sessions += Number(r.sessions) || 0;
    b.users    += Number(r.users)    || 0;
  }
  return [...buckets.values()].sort((a, b) => b.sessions - a.sessions);
}

// Render a page list as a clean horizontal-bar list. Each row is the
// path (monospace) + bar fill + view count + percentage. `denom` is
// optional — when provided it's used for the % share (so a Funnel
// Pages list can show "% of total traffic" instead of "% of funnel
// pages"). Defaults to the sum of the supplied rows' views.
function renderPageList(pages, opts = {}) {
  const list = (Array.isArray(pages) ? pages : []).slice(0, opts.limit || 15);
  if (!list.length) {
    return el('p', { class: 'muted' }, opts.emptyText || 'No page data yet.');
  }
  const denom = opts.denom != null
    ? opts.denom
    : list.reduce((s, p) => s + (Number(p.views) || 0), 0);
  // Bar widths scale relative to the top page on screen so the chart
  // is visually meaningful even when one page dominates.
  const maxViews = Math.max(...list.map(p => Number(p.views) || 0), 1);

  const host = el('div', { class: 'page-bar-list' });
  for (const p of list) {
    const v = Number(p.views) || 0;
    const sessions = Number(p.sessions) || 0;
    const pct = denom > 0 ? (v / denom) * 100 : 0;
    const fillPct = (v / maxViews) * 100;
    host.appendChild(el('div', { class: 'page-bar' },
      el('div', { class: 'page-bar-head' },
        el('code', { class: 'page-bar-path', title: p.path }, p.path || '/'),
        el('span', { class: 'page-bar-count muted' },
          String(v) + ' view' + (v === 1 ? '' : 's') +
          (denom > 0 ? ' · ' + pct.toFixed(1) + '%' : '') +
          (sessions ? ' · ' + sessions + ' session' + (sessions === 1 ? '' : 's') : '')
        )
      ),
      el('div', { class: 'page-bar-track' },
        el('div', { class: 'page-bar-fill', style: 'width:' + Math.max(2, fillPct) + '%' })
      )
    ));
  }
  return host;
}

// Render the bucketed sources as a clean horizontal-bar list. Each row
// is icon + channel label + bar fill + session count + percentage.
function renderTrafficChannels(rows) {
  const buckets = bucketSources(rows);
  const total = buckets.reduce((s, b) => s + b.sessions, 0);
  if (!total) {
    return el('p', { class: 'muted' }, 'No traffic recorded yet.');
  }
  const list = el('div', { class: 'traffic-channel-list' });
  for (const b of buckets) {
    const pct = (b.sessions / total) * 100;
    list.appendChild(el('div', { class: 'traffic-channel' },
      el('div', { class: 'traffic-channel-head' },
        el('span', { class: 'traffic-channel-icon' }, b.icon),
        el('span', { class: 'traffic-channel-label' }, b.label),
        el('span', { class: 'traffic-channel-count muted' },
          String(b.sessions) + ' · ' + pct.toFixed(1) + '%')
      ),
      el('div', { class: 'traffic-channel-bar' },
        el('div', { class: 'traffic-channel-bar-fill', style: 'width:' + Math.max(2, pct) + '%' })
      )
    ));
  }
  return list;
}

const SUGGESTED_TAGS = [
  'Current Client',  // already paying
  'Free Trial',      // booked free session, hasn't paid
  'Paid',            // converted (added automatically by Mark as Paid)
  'New Lead',        // just came in
  'Hot Lead',        // engaged, likely to convert
  'Cold Lead',       // unresponsive
  'No Show',         // missed appointment
  'Returning',       // came back after a lapse
  'VIP',             // special handling
  'Do Not Contact'   // opted out / silent ban — exclude from blasts
];

// Coerce a tags value into a safe string[]. Postgres text[] usually
// arrives as a JS array via supabase-js, but rows can come back as
// null, a Postgres array literal string ("{a,b}"), a JSON-encoded
// array string ('["booking"]') if upstream double-stringified before
// insert, or a plain comma-list. Recurses on individual elements to
// strip nested JSON noise (e.g. ['["booking"]'] → ['booking']).
// Returning [] on anything weird means the chip UI never blows up.
function normalizeTags(v) {
  // Element-level cleanup: unwrap JSON-encoded arrays/strings stored as
  // a single tag entry, then trim quotes/brackets.
  const cleanOne = (raw) => {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return [];
    if (s.startsWith('[') && s.endsWith(']')) {
      try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed.flatMap(cleanOne); } catch {}
    }
    if (s.startsWith('"') && s.endsWith('"')) {
      try { return [JSON.parse(s)].filter(Boolean); } catch {}
    }
    return [s.replace(/^["{[\\]+|["}\]\\]+$/g, '').trim()].filter(Boolean);
  };
  if (Array.isArray(v)) return v.flatMap(cleanOne).filter(Boolean).map(t => String(t));
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    // JSON-encoded array stored as a single string field
    if (s.startsWith('[') && s.endsWith(']')) {
      try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed.flatMap(cleanOne).filter(Boolean); } catch {}
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      return s.slice(1, -1).split(',').map(t => t.replace(/^"|"$/g, '').trim()).filter(Boolean);
    }
    return s.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

// Renders an inline tag chip row + add-tag UI for a single record.
// `getTags`/`saveTags` keep the source of truth on the row. saveTags is
// async and returns when persisted; on success the chip row is rebuilt.
function tagChips({ getTags, saveTags, readonly = false }) {
  const host = el('div', { class: 'tag-chips' });
  const draw = () => {
    host.innerHTML = '';
    const tags = normalizeTags(getTags());
    for (const t of tags) {
      const chip = el('span', { class: 'tag-chip' }, t);
      if (!readonly) {
        chip.appendChild(el('button', {
          class: 'tag-chip-x',
          title: 'Remove tag',
          onclick: async (ev) => {
            ev.stopPropagation();
            const next = (getTags() || []).filter(x => x !== t);
            try { await saveTags(next); draw(); }
            catch (e) { toast('Tag update failed: ' + e.message, true); }
          }
        }, '×'));
      }
      host.appendChild(chip);
    }
    if (readonly) return;
    const addBtn = el('button', { class: 'tag-chip-add', title: 'Add tag', onclick: (ev) => {
      ev.stopPropagation();
      openTagPicker({
        current: normalizeTags(getTags()),
        onAdd: async (tag) => {
          const next = [...new Set([...normalizeTags(getTags()), tag])];
          try { await saveTags(next); draw(); }
          catch (e) { toast('Tag update failed: ' + e.message, true); }
        }
      });
    } }, '+');
    host.appendChild(addBtn);
  };
  draw();
  return host;
}

// Lightweight popover for picking a suggested tag or typing a custom one.
function openTagPicker({ current = [], onAdd }) {
  const existing = document.querySelector('.tag-picker-bg');
  if (existing) existing.remove();

  const input = el('input', { type: 'text', placeholder: 'Type a tag…', maxlength: '30' });
  const submit = async (val) => {
    const tag = String(val || input.value).trim();
    if (!tag) return;
    bg.remove();
    await onAdd(tag);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') bg.remove();
  });
  const suggestionList = el('div', { class: 'tag-suggestions' });
  for (const s of SUGGESTED_TAGS) {
    if (current.includes(s)) continue;
    suggestionList.appendChild(el('button', {
      class: 'tag-suggestion',
      onclick: () => submit(s)
    }, s));
  }

  const modal = el('div', { class: 'tag-picker' },
    el('div', { class: 'tag-picker-label' }, 'Add tag'),
    input,
    el('div', { class: 'tag-picker-hint muted' }, 'Pick one below or type your own:'),
    suggestionList,
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn sm', onclick: () => bg.remove() }, 'Cancel'),
      el('button', { class: 'btn sm primary', onclick: () => submit() }, 'Add')
    )
  );
  const bg = el('div', { class: 'tag-picker-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, modal);
  document.body.appendChild(bg);
  setTimeout(() => input.focus(), 50);
}

// Slide-over Customer Profile panel. Opens from any clickable lead
// name. Shows a header (name, contact, source/funnel, tags), a metrics
// strip (bookings / paid / calls / messages), and three sectioned
// timelines (bookings + programs, calls, messages). Closes on backdrop
// click or Esc.
async function openCustomerProfile(leadId) {
  const existing = document.querySelector('.profile-bg');
  if (existing) existing.remove();

  const sheet = el('div', { class: 'profile-sheet' },
    el('div', { class: 'profile-loading muted' }, 'Loading customer profile…'));
  const dismissOnBg = (e) => { if (e.target === bg) closeProfileOuter(e); };
  const bg = el('div', {
    class: 'profile-bg',
    onclick: dismissOnBg,
    ontouchend: dismissOnBg
  }, sheet);
  const onKey = (e) => { if (e.key === 'Escape') closeProfileOuter(e); };
  // Hoisted close so backdrop / Esc / button all share the same path.
  function closeProfileOuter(ev) {
    if (ev) { ev.preventDefault?.(); ev.stopPropagation?.(); }
    document.removeEventListener('keydown', onKey);
    bg.remove();
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);

  let r;
  try {
    r = await api('/api/portal/profile?lead_id=' + encodeURIComponent(leadId));
  } catch (e) {
    sheet.innerHTML = '';
    sheet.appendChild(el('div', { class: 'err', style: 'padding:24px' }, 'Failed to load: ' + e.message));
    return;
  }

  const lead = r.lead || {};
  const summary = r.summary || {};
  // Format booking timestamps in the calendar's tz so the operator
  // always sees the local Central time the customer actually booked,
  // not whatever tz their browser is in. Falls back to America/Chicago
  // for tenants without a booking_calendars row.
  const profileTz = state.bookingCalendar?.timezone || 'America/Chicago';
  const fmt = (ts) => ts
    ? new Date(ts).toLocaleString(undefined, { timeZone: profileTz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    : '—';
  const fmtAgo = (ts) => {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 30 * 86400) return Math.floor(diff / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  };

  // Header — close button is sized for iOS (44×44pt), and we listen on
  // both pointer and touch events so a single tap always dismisses.
  const closeBtn = el('button', {
    class: 'profile-close',
    type: 'button',
    'aria-label': 'Close',
    onclick: closeProfileOuter,
    ontouchend: closeProfileOuter
  }, '×');

  // Avatar — falls back to initials in a name-derived colored circle.
  // Click opens a hidden file picker; on file selected we read as
  // base64 + POST to the upload endpoint, then refresh the profile.
  let liveAvatar = lead.avatar_url || null;
  const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: 'display:none' });
  const avatarHost = el('div', { class: 'profile-avatar-host' });
  const renderAvatarHere = () => {
    avatarHost.innerHTML = '';
    avatarHost.appendChild(renderAvatar({
      name: lead.name, avatarUrl: liveAvatar, size: 'lg',
      onClick: () => fileIn.click()
    }));
    if (liveAvatar) {
      avatarHost.appendChild(el('button', {
        class: 'profile-avatar-remove', type: 'button', title: 'Remove photo',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm('Remove this customer photo?')) return;
          try {
            await api('/api/portal/profile?action=avatar', { method: 'DELETE', body: { lead_id: leadId } });
            liveAvatar = null; renderAvatarHere(); toast('Photo removed');
          } catch (e) { toast('Remove failed: ' + e.message, true); }
        }
      }, '×'));
    }
  };
  fileIn.addEventListener('change', () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Image too large (max 2 MB)', true); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api('/api/portal/profile?action=upload-avatar', {
          method: 'POST',
          body: { lead_id: leadId, image_data_url: reader.result }
        });
        liveAvatar = r.avatar_url; renderAvatarHere();
        toast('Photo uploaded' + (r.storage === 'inline_fallback' ? ' (inline — set up a lead-avatars Storage bucket for better perf)' : ''));
      } catch (e) { toast('Upload failed: ' + e.message, true); }
    };
    reader.readAsDataURL(file);
  });
  renderAvatarHere();

  const header = el('div', { class: 'profile-header' },
    el('div', { class: 'profile-header-top' },
      avatarHost,
      el('h2', { style: 'flex:1;min-width:0;margin:0' }, lead.name || 'Unnamed customer'),
      closeBtn
    ),
    fileIn,
    el('div', { class: 'profile-contact muted' },
      lead.phone || '—',
      lead.email ? ' · ' + lead.email : ''
    ),
    el('div', { class: 'profile-meta' },
      lead.source ? el('span', { class: 'badge' }, 'Source: ' + lead.source) : null,
      lead.funnel ? el('span', { class: 'badge info' }, 'Funnel: ' + lead.funnel) : null,
      lead.intent ? el('span', { class: 'badge' }, 'Intent: ' + lead.intent) : null,
      lead.paid_at ? el('span', { class: 'badge green' }, 'Paid · ' + fmtAgo(lead.paid_at)) : null
    )
  );

  // Tag editor inline so the operator can add/remove tags from the profile.
  let liveTags = normalizeTags(lead.tags);
  const tagsRow = el('div', { class: 'profile-tags-row' },
    el('span', { class: 'muted', style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-right:8px' }, 'Tags'),
    tagChips({
      getTags: () => liveTags,
      saveTags: async (next) => {
        await api('/api/portal/crm?action=leads', { method: 'PATCH', body: { id: leadId, tags: next } });
        liveTags = next;
      }
    })
  );

  // Action bar — same Mark Paid / Stop Nudges / Delete from the leads list
  const actionBar = el('div', { class: 'profile-actions' },
    lead.paid_at
      ? el('button', { class: 'btn sm ghost', onclick: async () => {
          try {
            await api('/api/portal/crm?action=leads', { method: 'PATCH', body: { id: leadId, mark_unpaid: true } });
            toast('Removed paid status'); bg.remove(); render();
          } catch (e) { toast(e.message, true); }
        } }, '✓ Paid (undo)')
      : el('button', { class: 'btn sm primary', onclick: async () => {
          try {
            const res = await api('/api/portal/crm?action=leads', {
              method: 'PATCH',
              body: { id: leadId, mark_paid: true, tags: [...new Set([...liveTags.filter(t => t !== 'Free Trial'), 'Paid', 'Current Client'])] }
            });
            const extra = res?.cancelled_nudges ? ` · cancelled ${res.cancelled_nudges} nudges` : '';
            toast('Marked paid' + extra); bg.remove(); render();
          } catch (e) { toast(e.message, true); }
        } }, 'Mark Paid'),
    !liveTags.includes('Do Not Contact') && el('button', { class: 'btn sm', onclick: async () => {
      try {
        const res = await api('/api/portal/crm?action=leads', {
          method: 'PATCH', body: { id: leadId, tags: [...new Set([...liveTags, 'Do Not Contact'])] }
        });
        const extra = res?.cancelled_nudges ? ` · ${res.cancelled_nudges} nudges cancelled` : '';
        toast('Stopped nudges' + extra); bg.remove(); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Stop Nudges'),
    el('button', { class: 'btn sm', onclick: () => {
      state.view = 'messages';
      state.activeContactId = r.contact?.id || null;
      bg.remove();
      render();
    } }, 'Open Messages'),
    el('button', { class: 'btn sm danger', onclick: async () => {
      if (!confirm('Delete this lead?\n\nThis removes the lead and any pending nudges. Bookings stay but lose their lead reference.')) return;
      try {
        await api('/api/portal/crm?action=leads', { method: 'DELETE', body: { id: leadId } });
        toast('Lead deleted'); bg.remove(); render();
      } catch (e) { toast('Delete failed: ' + e.message, true); }
    } }, 'Delete')
  );

  // Customer Info section — surfaces the contact details (especially
  // email) front and center with one-tap copy + mailto/tel links so the
  // operator can reach out directly without leaving the profile.
  const copyBtn = (val, label = 'Copy') => el('button', {
    class: 'btn sm ghost',
    type: 'button',
    title: 'Copy to clipboard',
    style: 'padding:2px 8px;font-size:0.7rem',
    onclick: async () => {
      try { await navigator.clipboard.writeText(val); toast(label + ' copied'); }
      catch { toast('Copy failed', true); }
    }
  }, '📋');
  const infoRow = (label, value, actions) => el('div', {
    style: 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border,rgba(255,255,255,0.06))'
  },
    el('div', { style: 'flex:0 0 90px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted,#888);font-weight:600' }, label),
    el('div', { style: 'flex:1;min-width:0;word-break:break-word;font-size:0.9rem' }, value || '—'),
    actions || null
  );

  const emailLink = lead.email
    ? el('a', { href: 'mailto:' + lead.email, style: 'color:#63b3ed;text-decoration:none' }, lead.email)
    : '—';
  const phoneLink = lead.phone
    ? el('a', { href: 'tel:' + lead.phone, style: 'color:#63b3ed;text-decoration:none' }, lead.phone)
    : '—';

  const infoSection = el('div', { class: 'profile-section' });
  infoSection.appendChild(el('h3', {}, 'Customer Info'));
  infoSection.appendChild(infoRow('Email', emailLink,
    lead.email ? el('div', { style: 'display:flex;gap:4px' }, copyBtn(lead.email, 'Email')) : null));
  infoSection.appendChild(infoRow('Phone', phoneLink,
    lead.phone ? el('div', { style: 'display:flex;gap:4px' }, copyBtn(lead.phone, 'Phone')) : null));
  if (lead.source)        infoSection.appendChild(infoRow('Source', lead.source));
  if (lead.funnel)        infoSection.appendChild(infoRow('Funnel', lead.funnel));
  if (lead.intent)        infoSection.appendChild(infoRow('Intent', lead.intent));
  if (lead.lead_status)   infoSection.appendChild(infoRow('Status', lead.lead_status));
  if (lead.artist_selected) infoSection.appendChild(infoRow('Artist', lead.artist_selected));
  if (lead.notes)         infoSection.appendChild(infoRow('Notes', lead.notes));
  if (lead.payload?.goal) infoSection.appendChild(infoRow('Goal', lead.payload.goal));
  if (lead.created_at)    infoSection.appendChild(infoRow('First contact', fmt(lead.created_at) + ' · ' + fmtAgo(lead.created_at)));
  if (lead.last_contacted_at) infoSection.appendChild(infoRow('Last contact', fmt(lead.last_contacted_at) + ' · ' + fmtAgo(lead.last_contacted_at)));

  // Metric strip
  const metrics = el('div', { class: 'leads-metrics-strip', style: 'margin:14px 0' },
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, String(summary.total_bookings || 0)),
      el('span', { class: 'metric-stat-label' }, 'Bookings')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat accent' },
      el('span', { class: 'metric-stat-value' }, String(summary.paid_bookings || 0)),
      el('span', { class: 'metric-stat-label' }, 'Paid')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, String(summary.total_calls || 0)),
      el('span', { class: 'metric-stat-label' }, 'Calls')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, String(summary.total_messages || 0)),
      el('span', { class: 'metric-stat-label' }, 'Messages')
    )
  );

  // Programs / bookings list
  const bookingsSection = el('div', { class: 'profile-section' });
  bookingsSection.appendChild(el('h3', {}, 'Programs & Bookings'));
  if (r.bookings?.length) {
    bookingsSection.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Service'), el('th', {}, 'Status'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.bookings.map(b => el('tr', {},
        el('td', {}, fmt(b.starts_at)),
        el('td', {}, b.service || b.service_type || '—'),
        el('td', {}, el('span', { class: 'badge' }, (b.status || 'pending'))),
        el('td', {}, b.paid_at ? el('span', { class: 'badge green' }, 'Paid') : el('span', { class: 'muted' }, 'Free'))
      )))
    ));
  } else {
    bookingsSection.appendChild(el('p', { class: 'muted' }, 'No bookings yet.'));
  }

  // Calls list
  const callsSection = el('div', { class: 'profile-section' });
  callsSection.appendChild(el('h3', {}, 'Voice Calls'));
  if (r.calls?.length) {
    callsSection.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Direction'), el('th', {}, 'Duration'), el('th', {}, 'Summary')
      )),
      el('tbody', {}, ...r.calls.map(c => el('tr', {},
        el('td', {}, fmt(c.started_at || c.created_at)),
        el('td', {}, c.direction || '—'),
        el('td', {}, c.duration_seconds ? Math.round(c.duration_seconds / 60) + 'm' : '—'),
        el('td', { class: 'muted', style: 'font-size:0.8rem' }, (c.summary || '').slice(0, 80))
      )))
    ));
  } else {
    callsSection.appendChild(el('p', { class: 'muted' }, 'No calls yet.'));
  }

  // Messages list
  const messagesSection = el('div', { class: 'profile-section' });
  messagesSection.appendChild(el('h3', {}, 'Recent Messages'));
  if (r.messages?.length) {
    const list = el('div', { class: 'profile-msg-list' });
    for (const m of r.messages.slice(0, 20)) {
      list.appendChild(el('div', { class: 'profile-msg ' + (m.direction === 'outbound' ? 'out' : 'in') },
        el('div', { class: 'profile-msg-meta muted' },
          (m.direction === 'outbound' ? '→ ' : '← '),
          fmtAgo(m.created_at)
        ),
        el('div', { class: 'profile-msg-body' }, m.body || '')
      ));
    }
    messagesSection.appendChild(list);
  } else {
    messagesSection.appendChild(el('p', { class: 'muted' }, 'No messages yet.'));
  }

  // Nudge timeline (so the operator can see exactly which drips fired
  // and which were cancelled by Mark Paid / Stop Nudges).
  const nudgesSection = el('div', { class: 'profile-section' });
  nudgesSection.appendChild(el('h3', {}, 'Nudge Drip'));
  if (r.nudges?.length) {
    nudgesSection.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'Scheduled'), el('th', {}, 'State')
      )),
      el('tbody', {}, ...r.nudges.map(n => {
        const state = n.sent_at ? 'sent' : n.failed_reason ? 'cancelled · ' + n.failed_reason : 'pending';
        const cls = n.sent_at ? 'green' : n.failed_reason ? 'red' : 'warn';
        return el('tr', {},
          el('td', {}, '#' + n.message_number),
          el('td', {}, fmt(n.scheduled_for)),
          el('td', {}, el('span', { class: 'badge ' + cls }, state))
        );
      }))
    ));
  } else {
    nudgesSection.appendChild(el('p', { class: 'muted' }, 'No nudge sequence enrolled.'));
  }

  sheet.innerHTML = '';
  // Sticky "Done" button at the very bottom of the sheet — second
  // unmissable exit for iOS users who can't easily reach the X in the
  // header after scrolling.
  const doneBar = el('div', { class: 'profile-done-bar' },
    el('button', {
      class: 'btn primary profile-done-btn',
      type: 'button',
      onclick: closeProfileOuter,
      ontouchend: closeProfileOuter
    }, 'Done')
  );

  sheet.append(header, tagsRow, actionBar, infoSection, metrics, bookingsSection, callsSection, messagesSection, nudgesSection, doneBar);
}

// Trash view — slide-over panel listing soft-deleted records from the
// last 30 days across leads / contacts / bookings. Per-row Restore +
// Permanently Delete buttons. Uses the same slide-over chrome as the
// customer profile so the close behavior + safe-area handling match.
async function openTrashView() {
  const existing = document.querySelector('.profile-bg');
  if (existing) existing.remove();

  const sheet = el('div', { class: 'profile-sheet' },
    el('div', { class: 'profile-loading muted' }, 'Loading recently deleted…'));
  const dismissOnBg = (e) => { if (e.target === bg) closeTrash(e); };
  const bg = el('div', { class: 'profile-bg', onclick: dismissOnBg, ontouchend: dismissOnBg }, sheet);
  const onKey = (e) => { if (e.key === 'Escape') closeTrash(e); };
  function closeTrash(ev) {
    if (ev) { ev.preventDefault?.(); ev.stopPropagation?.(); }
    document.removeEventListener('keydown', onKey);
    bg.remove();
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);

  const fmtAgo = (ts) => {
    if (!ts) return '—';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  async function refresh() {
    let r;
    try {
      r = await api('/api/admin?action=trash');
    } catch (e) {
      sheet.innerHTML = '';
      sheet.appendChild(el('div', { class: 'err', style: 'padding:24px' }, 'Failed to load: ' + e.message));
      return;
    }

    const totalCount = (r.leads?.length || 0) + (r.contacts?.length || 0) + (r.bookings?.length || 0);
    const closeBtn = el('button', {
      class: 'profile-close', type: 'button', 'aria-label': 'Close',
      onclick: closeTrash, ontouchend: closeTrash
    }, '×');

    const buildSection = (label, type, rows, columns) => {
      const sec = el('div', { class: 'profile-section' });
      sec.appendChild(el('h3', {}, label + ' (' + (rows?.length || 0) + ')'));
      if (!rows?.length) {
        sec.appendChild(el('p', { class: 'muted' }, 'No deleted ' + label.toLowerCase() + ' in the last 30 days.'));
        return sec;
      }
      const tbl = el('table', {},
        el('thead', {}, el('tr', {},
          ...columns.map(c => el('th', {}, c.label)),
          el('th', {}, 'Tenant'),
          el('th', {}, 'Deleted'),
          el('th', {}, '')
        )),
        el('tbody', {}, ...rows.map(row => {
          const tenantName = r.client_names?.[row.client_id] || row.client_id?.slice(0, 8) || '—';
          const restoreBtn = el('button', {
            class: 'btn sm primary', onclick: async () => {
              try {
                await api('/api/admin?action=restore-record', { method: 'POST', body: { type, id: row.id } });
                toast(label + ' restored');
                await refresh();
              } catch (e) { toast('Restore failed: ' + e.message, true); }
            }
          }, 'Restore');
          const purgeBtn = el('button', {
            class: 'btn sm danger', onclick: async () => {
              if (!confirm(`Permanently delete this ${label.toLowerCase().replace(/s$/, '')}?\n\nThis cannot be undone.`)) return;
              try {
                await api('/api/admin?action=restore-record', { method: 'POST', body: { type, id: row.id, permanent: true } });
                toast('Permanently deleted');
                await refresh();
              } catch (e) { toast('Failed: ' + e.message, true); }
            }
          }, 'Purge');
          return el('tr', {},
            ...columns.map(c => el('td', {}, c.cell(row))),
            el('td', { class: 'muted' }, tenantName),
            el('td', { class: 'muted' }, fmtAgo(row.deleted_at)),
            el('td', {}, el('div', { class: 'row', style: 'gap:4px;justify-content:flex-end' }, restoreBtn, purgeBtn))
          );
        }))
      );
      sec.appendChild(tbl);
      return sec;
    };

    sheet.innerHTML = '';
    sheet.append(
      el('div', { class: 'profile-header' },
        el('div', { class: 'profile-header-top' },
          el('h2', {}, '🗑 Trash'),
          closeBtn
        ),
        el('div', { class: 'profile-contact muted' },
          totalCount + ' record' + (totalCount === 1 ? '' : 's') + ' deleted in the last 30 days. Click Restore to recover; Purge to permanently remove.')
      ),
      buildSection('Leads', 'leads', r.leads, [
        { label: 'Name',  cell: x => x.name  || '—' },
        { label: 'Phone', cell: x => x.phone || '—' },
        { label: 'Email', cell: x => x.email || '—' }
      ]),
      buildSection('Contacts', 'contacts', r.contacts, [
        { label: 'Name',  cell: x => x.name  || '—' },
        { label: 'Phone', cell: x => x.phone || '—' },
        { label: 'Email', cell: x => x.email || '—' }
      ]),
      buildSection('Bookings', 'bookings', r.bookings, [
        { label: 'Name',    cell: x => x.lead_name || '—' },
        { label: 'Service', cell: x => x.service   || '—' },
        { label: 'When',    cell: x => x.starts_at ? new Date(x.starts_at).toLocaleString() : '—' }
      ]),
      el('div', { class: 'profile-done-bar' },
        el('button', { class: 'btn primary profile-done-btn', type: 'button',
          onclick: closeTrash, ontouchend: closeTrash }, 'Done'))
    );
  }
  await refresh();
}

function card(label, value, sub, cls = '') {
  return el('div', { class: 'card ' + cls },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, String(value)),
    sub ? el('div', { class: 'sub' }, sub) : null
  );
}

// Renders /r2s GA4 analytics scoped to theflexfacility.com. Server-side
// endpoint enforces that only ab@goelev8.ai or the Flex Facility client
// can read it — this loader just calls it and renders the result.
async function loadFlexR2sAnalytics(container) {
  const placeholder = el('p', { class: 'muted' }, 'Loading /r2s analytics…');
  container.appendChild(placeholder);
  try {
    const r = await api('/api/portal/flex-r2s');
    placeholder.remove();

    if (r.configured === false) {
      container.appendChild(el('p', { class: 'err' }, r.message || 'GA4 not configured for Flex Facility.'));
      return;
    }
    if (r.error) {
      container.appendChild(el('p', { class: 'err' }, 'GA4 error: ' + r.error));
      return;
    }

    const fmtSec = (s) => {
      if (!s || s < 1) return '0s';
      if (s < 60) return s.toFixed(0) + 's';
      const m = Math.floor(s / 60);
      const r = Math.round(s - m * 60);
      return `${m}m ${r}s`;
    };

    // Stat strip
    container.appendChild(el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:16px' },
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, String(r.page_views || 0)),
        el('span', { class: 'metric-stat-label' }, 'Page Views')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, String(r.users || 0)),
        el('span', { class: 'metric-stat-label' }, 'Unique Visitors')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, fmtSec(r.avg_time_on_page)),
        el('span', { class: 'metric-stat-label' }, 'Avg Time on Page')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat accent' },
        el('span', { class: 'metric-stat-value' }, String(r.sessions || 0)),
        el('span', { class: 'metric-stat-label' }, 'Sessions')
      ),
      ...(r.bounce_rate != null ? [
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value' }, (r.bounce_rate * 100).toFixed(1) + '%'),
          el('span', { class: 'metric-stat-label' }, 'Bounce Rate')
        )
      ] : [])
    ));

    // Top traffic sources to /r2s
    container.appendChild(el('h3', { style: 'margin:16px 0 8px;font-size:0.9rem' }, 'Top Traffic Sources to /r2s'));
    container.appendChild(renderTrafficChannels(r.top_sources || []));

    // Conversion events
    container.appendChild(el('h3', { style: 'margin:16px 0 8px;font-size:0.9rem' }, 'Conversion Events on /r2s'));
    const convEntries = Object.entries(r.conversions || {});
    if (convEntries.length) {
      const evCards = el('div', { class: 'cards' });
      for (const [name, count] of convEntries) {
        evCards.appendChild(card(name, count, 'Last 30 days'));
      }
      container.appendChild(evCards);
    } else {
      container.appendChild(el('p', { class: 'muted' },
        'No conversion events tracked yet. Fire lead_captured or booking_initiated GA4 events on /r2s to track conversions.'));
    }

    container.appendChild(el('p', { class: 'muted', style: 'font-size:0.7rem;margin-top:12px' },
      `Measurement ID: ${r.measurement_id} · GA4 Property: ${r.property_id}`));
  } catch (e) {
    placeholder.remove();
    container.appendChild(el('p', { class: 'err' }, 'Failed to load /r2s analytics: ' + e.message));
  }
}

// Renders the Road To The Stage ebook sales section. Only called from
// viewOverview when the current tenant is The Flex Facility. Server-side
// endpoint enforces the same tenant gate.
async function loadR2sEbookSection(container) {
  // Header card (always shown, even while loading)
  container.appendChild(el('div', { class: 'r2s-ebook-header' },
    el('h2', {}, 'Road To The Stage — Ebook Sales'),
    el('p', { class: 'muted', style: 'margin-top:4px;font-size:0.85rem' },
      'Track sales and performance for The Road To The Stage ebook.')
  ));

  const body = el('div', {});
  container.appendChild(body);
  const placeholder = el('p', { class: 'muted' }, 'Loading ebook sales…');
  body.appendChild(placeholder);

  let data;
  try {
    data = await api('/api/portal/r2s-sales');
  } catch (e) {
    placeholder.remove();
    body.appendChild(el('p', { class: 'err' }, 'Failed to load ebook sales: ' + e.message));
    return;
  }
  placeholder.remove();

  // Metrics strip (always shown, zero-safe)
  const units = data.total_units || 0;
  const revenueCents = data.total_revenue_cents || 0;
  body.appendChild(el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:12px' },
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, String(units)),
      el('span', { class: 'metric-stat-label' }, 'Total Units Sold')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat accent' },
      el('span', { class: 'metric-stat-value' }, `$${(revenueCents / 100).toFixed(2)}`),
      el('span', { class: 'metric-stat-label' }, 'Total Revenue')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, units > 0 ? `$${(revenueCents / units / 100).toFixed(2)}` : '—'),
      el('span', { class: 'metric-stat-label' }, 'Avg Sale Price')
    )
  ));

  // Sales over time chart (last 30 days) — simple bar chart
  const days = Object.entries(data.by_day || {});
  const chartPanel = el('div', { class: 'r2s-chart-panel' });
  chartPanel.appendChild(el('h3', { style: 'font-size:0.9rem;margin-bottom:8px' }, 'Sales Over Time (last 30 days)'));
  if (days.length && days.some(([_, v]) => v.units > 0)) {
    const max = Math.max(...days.map(([_, v]) => v.units), 1);
    const chart = el('div', { class: 'r2s-chart' });
    days.forEach(([date, v]) => {
      const bar = el('div', {
        class: 'r2s-chart-bar',
        title: `${date}: ${v.units} sale${v.units === 1 ? '' : 's'} · $${(v.revenue_cents / 100).toFixed(2)}`
      },
        el('div', { class: 'r2s-chart-fill', style: `height:${Math.max(2, (v.units / max) * 100)}%` }),
        el('div', { class: 'r2s-chart-label' }, new Date(date).getDate())
      );
      chart.appendChild(bar);
    });
    chartPanel.appendChild(chart);
  } else {
    chartPanel.appendChild(el('p', { class: 'muted' }, 'No sales recorded in the last 30 days.'));
  }
  body.appendChild(chartPanel);

  // Sales page link
  body.appendChild(el('div', { class: 'r2s-link-row' },
    el('span', { class: 'muted', style: 'font-size:0.8rem' }, 'Sales page:'),
    el('a', {
      href: 'https://www.theflexfacility.com/r2s',
      target: '_blank', rel: 'noopener noreferrer',
      class: 'r2s-link'
    }, 'theflexfacility.com/r2s →')
  ));

  // Manual entry fallback when no sales yet
  if (!data.sales?.length) {
    body.appendChild(el('p', { class: 'muted', style: 'margin-top:12px;font-size:0.85rem' },
      'Stripe is connected but no sales yet match "Road To The Stage" or "r2s". New Stripe sales will appear here automatically.'));
    body.appendChild(renderManualSaleForm(container));
  }

  // Recent sales list
  if (data.sales?.length) {
    body.appendChild(el('h3', { style: 'font-size:0.9rem;margin:16px 0 8px' }, 'Recent Sales'));
    body.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Customer'), el('th', {}, 'Product'),
        el('th', {}, 'Amount'), el('th', {}, 'Source')
      )),
      el('tbody', {}, ...data.sales.map(s => el('tr', {},
        el('td', {}, new Date(s.created_at).toLocaleDateString()),
        el('td', {}, s.customer_name || s.customer_email || '—'),
        el('td', {}, s.product_name || 'Road To The Stage'),
        el('td', { style: 'font-weight:600' }, `$${(s.amount_cents / 100).toFixed(2)}`),
        el('td', {}, el('span', { class: 'badge' + (s.source?.startsWith('r2s_manual') ? ' warn' : ' info') },
          s.source?.startsWith('r2s_manual') ? 'manual' : (s.source || 'stripe')))
      )))
    ));
  }
}

// Manual sale entry form used by the R2S ebook panel.
function renderManualSaleForm(parentContainer) {
  const nameIn  = el('input', { type: 'text', placeholder: 'Customer name' });
  const emailIn = el('input', { type: 'email', placeholder: 'customer@example.com' });
  const amtIn   = el('input', { type: 'number', min: '1', step: '0.01', placeholder: '27.00' });
  const noteIn  = el('input', { type: 'text', placeholder: 'Note (optional)' });
  const submit  = el('button', { class: 'btn primary', onclick: async () => {
    const amt = parseFloat(amtIn.value);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount', true); return; }
    submit.disabled = true; submit.textContent = 'Saving…';
    try {
      await api('/api/portal/r2s-sales', { method: 'POST', body: {
        customer_name: nameIn.value.trim() || null,
        customer_email: emailIn.value.trim() || null,
        amount_cents: Math.round(amt * 100),
        note: noteIn.value.trim() || null
      }});
      toast('Sale recorded');
      // Re-render the entire panel from fresh data
      parentContainer.innerHTML = '';
      loadR2sEbookSection(parentContainer);
    } catch (e) {
      toast('Save failed: ' + e.message, true);
    } finally { submit.disabled = false; submit.textContent = 'Log Sale'; }
  } }, 'Log Sale');

  return el('div', { class: 'r2s-manual-form' },
    el('h3', { style: 'font-size:0.9rem;margin-bottom:8px' }, 'Log a manual sale'),
    el('div', { class: 'r2s-manual-grid' },
      el('label', {},
        el('span', { class: 'muted', style: 'font-size:0.75rem' }, 'Customer name'),
        nameIn
      ),
      el('label', {},
        el('span', { class: 'muted', style: 'font-size:0.75rem' }, 'Email'),
        emailIn
      ),
      el('label', {},
        el('span', { class: 'muted', style: 'font-size:0.75rem' }, 'Amount ($)'),
        amtIn
      ),
      el('label', {},
        el('span', { class: 'muted', style: 'font-size:0.75rem' }, 'Note'),
        noteIn
      )
    ),
    el('div', { style: 'margin-top:10px' }, submit)
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

// Parse a free-text availability string into a set of HH:MM ranges.
//   "9a-3p"            → [{ start: '09:00', end: '15:00' }]
//   "9-12, 2-5"        → [{ 09:00, 12:00 }, { 14:00, 17:00 }]
//   "8:30am - 12pm"    → [{ 08:30, 12:00 }]
//   ""  / "closed"     → [] (treated as a day off — no error)
//   "garbage"          → { ok: false, error: "..." }
//
// AM/PM disambiguation when one or both sides omit a meridiem:
//   - If neither side has am/pm and end ≤ start in raw 24-hour form,
//     end is bumped to PM ("9-5"   → 9 AM – 5 PM).
//   - If neither has am/pm and 24-hour form is already valid, use it
//     directly ("13-15" → 1 PM – 3 PM).
//   - If only one side has am/pm, the other inherits — unless that
//     creates an invalid range, in which case it flips ("9-5p" → 9 AM,
//     "9a-5" → 5 PM).
function parseTimeRanges(input) {
  const trimmed = String(input || '').trim().toLowerCase();
  if (!trimmed) return { ok: true, ranges: [] };
  if (/^(closed|off|none|x|-|—|—)$/.test(trimmed)) {
    return { ok: true, ranges: [] };
  }

  // Split on "," or ";" for multiple blocks.
  const blocks = trimmed.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  const ranges = [];
  for (const block of blocks) {
    // Split start/end on hyphen-ish chars or " to " or " – ".
    const parts = block.split(/\s*(?:to|–|—|-)\s*/i).filter(Boolean);
    if (parts.length !== 2) {
      return { ok: false, error: `Couldn't read "${block}" — try "9a-5p"` };
    }
    const startRaw = parseTimeFragment(parts[0]);
    const endRaw   = parseTimeFragment(parts[1]);
    if (!startRaw || !endRaw) {
      return { ok: false, error: `Couldn't read "${block}" — try "9a-5p"` };
    }
    const resolved = disambiguate(startRaw, endRaw);
    if (!resolved) {
      return { ok: false, error: `End time must be after start in "${block}"` };
    }
    ranges.push(resolved);
  }
  return { ok: true, ranges };
}

// Parse one side of a range. Returns { h, m, mer } where mer is 'a' / 'p' / null.
function parseTimeFragment(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a|am|p|pm|noon|midnight)?$/i);
  if (!m) {
    if (/^noon$/i.test(s))     return { h: 12, m: 0,  mer: 'p' };
    if (/^midnight$/i.test(s)) return { h: 0,  m: 0,  mer: 'a' };
    return null;
  }
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (h < 0 || h > 23 || min > 59) return null;
  let mer = m[3] ? m[3][0].toLowerCase() : null;
  if (m[3] && /^noon$/i.test(m[3]))     { h = 12; mer = 'p'; }
  if (m[3] && /^midnight$/i.test(m[3])) { h = 0;  mer = 'a'; }
  return { h, m: min, mer };
}

// Resolve start/end fragments into concrete 24-hour HH:MM strings.
// Returns { start, end } or null if the range is unparseable / inverted.
function disambiguate(s, e) {
  const to24 = (frag) => {
    let h = frag.h;
    if (frag.mer === 'a') { if (h === 12) h = 0; }
    else if (frag.mer === 'p') { if (h !== 12) h += 12; }
    return h * 60 + frag.m;
  };

  const tryRange = (sFrag, eFrag) => {
    const sm = to24(sFrag), em = to24(eFrag);
    return em > sm ? { sm, em } : null;
  };

  let pick = null;
  if (s.mer && e.mer) {
    pick = tryRange(s, e);
  } else if (s.mer && !e.mer) {
    // Start is anchored. Try end with same meridiem, then with the other.
    pick = tryRange(s, { ...e, mer: s.mer })
        || tryRange(s, { ...e, mer: s.mer === 'a' ? 'p' : 'a' });
  } else if (!s.mer && e.mer) {
    pick = tryRange({ ...s, mer: e.mer }, e)
        || tryRange({ ...s, mer: e.mer === 'a' ? 'p' : 'a' }, e);
  } else {
    // Neither side has am/pm. Prefer 24-hour interpretation if it's valid;
    // otherwise treat as common-sense "9-5" → 9 AM to 5 PM.
    if (s.h <= 23 && e.h <= 23 && (e.h * 60 + e.m) > (s.h * 60 + s.m)) {
      pick = { sm: s.h * 60 + s.m, em: e.h * 60 + e.m };
    } else {
      pick = tryRange({ ...s, mer: 'a' }, { ...e, mer: 'p' })
          || tryRange({ ...s, mer: 'p' }, { ...e, mer: 'p' })
          || tryRange({ ...s, mer: 'a' }, { ...e, mer: 'a' });
    }
  }
  if (!pick) return null;
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return { start: fmt(pick.sm), end: fmt(pick.em) };
}

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
      mk('days_off',     'Days Off'),
      mk('services',     'Services')
    );
  }

  function renderAll() {
    renderSubTabBar();
    content.replaceChildren();
    if (subTab === 'appointments') { renderAppointments(); renderGoelev8Bookings(); }
    else if (subTab === 'availability') renderAvailability();
    else if (subTab === 'days_off') renderDaysOff();
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
      let rows, calendarTz;
      try {
        const r = await api('/api/portal/bookings/appointments?filter=' + encodeURIComponent(apptFilter));
        rows = r.appointments || [];
        calendarTz = r.timezone || cal.timezone || undefined;
      } catch (e) {
        listPanel.replaceChildren(el('p', { class: 'err' }, 'Failed to load appointments: ' + e.message));
        return;
      }
      if (!rows.length) {
        listPanel.replaceChildren(el('p', { class: 'muted' }, 'No appointments yet. Share your booking link to get started.'));
        return;
      }
      // Conversion summary (free → paid) for the operator. Counts only the
      // currently filtered set so it reflects what the user is looking at.
      const total = rows.length;
      const paid = rows.filter(r => r.paid_at).length;
      const rate = total ? Math.round((paid / total) * 100) : 0;
      const summary = el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:12px' },
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value' }, String(total)),
          el('span', { class: 'metric-stat-label' }, 'Bookings shown')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value' }, String(paid)),
          el('span', { class: 'metric-stat-label' }, 'Marked Paid')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat accent' },
          el('span', { class: 'metric-stat-value' }, rate + '%'),
          el('span', { class: 'metric-stat-label' }, 'Conversion (paid/total)')
        ),
        calendarTz ? el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-label muted' }, 'Times shown in ' + calendarTz)
        ) : null
      );

      listPanel.replaceChildren(
        summary,
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'When'),
            el('th', {}, 'Name'),
            el('th', {}, 'Service'),
            el('th', {}, 'Status'),
            el('th', {}, 'Tags'),
            el('th', {}, '')
          )),
          el('tbody', {}, ...rows.map(a => renderAppointmentRow(a, renderAppointments_reload, calendarTz)))
        )
      );
    }

    await renderAppointments_reload();
  }

  function renderAppointmentRow(a, reload, calendarTz) {
    const when = new Date(a.appointment_start);
    // Format in the calendar's timezone — not the operator's browser tz —
    // so 9 AM Central reads 9 AM regardless of where the admin is sitting.
    // Hard-fallback to America/Chicago when calendarTz isn't provided
    // (e.g. legacy booking_calendars row with NULL tz) so we never
    // silently fall through to the operator's browser tz.
    const tz = calendarTz || cal.timezone || 'America/Chicago';
    const fmtOpts = {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: tz, timeZoneName: 'short'
    };
    let whenStr;
    try { whenStr = when.toLocaleString(undefined, fmtOpts); }
    catch { whenStr = when.toLocaleString(); }
    const contactStr = [a.lead_name, a.lead_phone].filter(Boolean).join(' · ') || '—';
    // Booking name is clickable when we know which lead it came from.
    const contactCell = a.lead_id
      ? el('button', {
          class: 'link-btn',
          title: 'Open customer profile',
          onclick: () => openCustomerProfile(a.lead_id)
        }, contactStr)
      : document.createTextNode(contactStr);
    const badgeCls = STATUS_BADGE_CLASS[a.status] || 'badge';
    const statusText = (a.status || 'pending').replace('_', ' ');

    const actions = [];
    if (a.status !== 'confirmed' && a.status !== 'cancelled') {
      actions.push(el('button', {
        class: 'btn sm green',
        onclick: () => updateStatus(a.id, 'confirmed', reload)
      }, 'Confirm'));
    }
    // Mark as Paid: surfaces the free → paid conversion. Idempotent toggle.
    if (a.paid_at) {
      actions.push(el('button', {
        class: 'btn sm ghost',
        title: 'Paid on ' + new Date(a.paid_at).toLocaleDateString(),
        onclick: async () => {
          try {
            await api('/api/portal/bookings/appointments', { method: 'PATCH', body: { id: a.id, mark_unpaid: true } });
            toast('Removed paid status'); await reload();
          } catch (e) { toast(e.message, true); }
        }
      }, '✓ Paid (undo)'));
    } else if (a.status !== 'cancelled') {
      actions.push(el('button', {
        class: 'btn sm primary',
        onclick: async () => {
          try {
            const r = await api('/api/portal/bookings/appointments', { method: 'PATCH', body: { id: a.id, mark_paid: true } });
            const extra = r?.cancelled_nudges
              ? ` · cancelled ${r.cancelled_nudges} pending nudge${r.cancelled_nudges === 1 ? '' : 's'}`
              : '';
            toast('Marked as paid · counts toward conversion' + extra);
            await reload();
          } catch (e) { toast(e.message, true); }
        }
      }, 'Mark Paid'));
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
    // Hard delete — for cleaning up test appointments. Bypasses the
    // customer-facing cancellation SMS on purpose.
    actions.push(el('button', {
      class: 'btn sm danger',
      onclick: async () => {
        if (!confirm(`Delete this booking permanently?\n\n${a.lead_name || a.lead_phone || a.id}\n\nThis is a hard delete — no SMS will be sent. Use Cancel instead if you want to notify the customer.`)) return;
        try {
          await api('/api/portal/bookings/appointments', { method: 'DELETE', body: { id: a.id } });
          toast('Booking deleted');
          await reload();
        } catch (e) { toast('Delete failed: ' + e.message, true); }
      }
    }, 'Delete'));

    let currentTags = normalizeTags(a.tags);
    const tagsCell = tagChips({
      getTags: () => currentTags,
      saveTags: async (next) => {
        await api('/api/portal/bookings/appointments', { method: 'PATCH', body: { id: a.id, tags: next } });
        currentTags = next;
      }
    });

    return el('tr', {},
      el('td', {}, whenStr),
      el('td', {}, contactCell),
      el('td', {}, a.service_name || '—'),
      el('td', {}, el('span', { class: badgeCls }, statusText)),
      el('td', {}, tagsCell),
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

    let activeServiceId = services[0].id;
    let dayInputs = {}; // dow → { input, statusEl, ranges }
    let dirty = false;

    // Service picker only renders when there's more than one service.
    // Single-service tenants (like Will Power Fitness Factory) skip the
    // dropdown entirely so the availability editor is just "type your
    // hours, hit save".
    const showPicker = services.length > 1;
    const serviceSelect = showPicker ? el('select', {
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
    }, ...services.map(s => el('option', { value: s.id }, s.name))) : null;

    const headerRow = el('div', {
      class: 'row',
      style: 'gap: 12px; margin-bottom: 8px; flex-wrap: wrap; align-items: center'
    },
      showPicker
        ? el('div', { style: 'font-size: 13px; font-weight: 600; min-width: 80px' }, 'Service:')
        : null,
      serviceSelect,
      tz ? el('span', { class: 'muted', style: 'font-size: 12px; margin-left: auto' }, tz) : null
    );

    const helpText = el('div', {
      class: 'muted',
      style: 'font-size: 12px; line-height: 1.5; margin-bottom: 16px; padding: 10px 12px; background: rgba(45,156,219,0.06); border-left: 2px solid rgba(45,156,219,0.4); border-radius: 4px;'
    },
      el('div', { style: 'color: #93c5fd; font-weight: 600; margin-bottom: 4px' }, 'How to set hours'),
      el('div', { html: 'Type each day\'s hours like <strong>9a-3p</strong>, <strong>9-5</strong>, <strong>8:30am-12pm</strong>, or split blocks with a comma: <strong>9-12, 2-5</strong>. Leave blank or type <strong>closed</strong> for days off.' })
    );

    const dayContainer = el('div', {});
    const saveBtn = el('button', { class: 'btn', onclick: () => saveAvailability() }, 'Save changes');
    const footer = el('div', { class: 'row', style: 'justify-content: flex-end; margin-top: 16px' }, saveBtn);

    panel.replaceChildren(headerRow, helpText, dayContainer, footer);

    function renderForActiveService() {
      const svc = services.find(s => s.id === activeServiceId);
      if (!svc) return;
      const byDow = {};
      for (const t of (svc.templates || [])) {
        if (!byDow[t.day_of_week]) byDow[t.day_of_week] = [];
        byDow[t.day_of_week].push(t);
      }
      dayInputs = {};
      const dayBlocks = DAYS_OF_WEEK.map(d => {
        const slots = (byDow[d.dow] || []).slice().sort((a, b) =>
          (a.start_time || '').localeCompare(b.start_time || '')
        );
        const initial = slots.length
          ? slots.map(s => formatRange(s.start_time, s.end_time)).join(', ')
          : '';
        const input = el('input', {
          type: 'text',
          value: initial,
          placeholder: 'e.g. 9a-5p   (or leave blank for closed)',
          style: 'flex: 1; min-width: 0; padding: 9px 12px; font-size: 14px;',
          oninput: () => { dirty = true; updateStatus(d.dow); },
          onblur: () => updateStatus(d.dow)
        });
        const statusEl = el('div', {
          style: 'font-size: 12px; margin-top: 4px; min-height: 16px;'
        });
        dayInputs[d.dow] = { input, statusEl, ranges: [] };
        // Initial parse to seed the status preview.
        setTimeout(() => updateStatus(d.dow), 0);
        return el('div', {
          style: 'display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: start; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.04);'
        },
          el('div', { style: 'font-weight: 600; font-size: 14px; padding-top: 9px;' }, d.label),
          el('div', {}, input, statusEl)
        );
      });
      dayContainer.replaceChildren(...dayBlocks);
    }

    function updateStatus(dow) {
      const row = dayInputs[dow];
      if (!row) return;
      const parsed = parseTimeRanges(row.input.value);
      if (!parsed.ok) {
        row.ranges = null;
        row.statusEl.style.color = '#fca5a5';
        row.statusEl.textContent = '⚠️ ' + parsed.error;
        return;
      }
      row.ranges = parsed.ranges;
      if (!parsed.ranges.length) {
        row.statusEl.style.color = 'var(--text-mute, #888)';
        row.statusEl.textContent = 'Closed';
      } else {
        row.statusEl.style.color = '#86efac';
        row.statusEl.textContent = '✓ ' +
          parsed.ranges.map(r => formatRangeDisplay(r.start, r.end)).join(', ');
      }
    }

    async function saveAvailability() {
      const templates = [];
      const errors = [];
      for (const d of DAYS_OF_WEEK) {
        const row = dayInputs[d.dow];
        if (!row) continue;
        const parsed = parseTimeRanges(row.input.value);
        if (!parsed.ok) { errors.push(`${d.label}: ${parsed.error}`); continue; }
        for (const r of parsed.ranges) {
          templates.push({ day_of_week: d.dow, start_time: r.start, end_time: r.end });
        }
      }
      if (errors.length) {
        toast(errors[0], true);
        return;
      }
      saveBtn.disabled = true;
      try {
        const r = await api('/api/portal/bookings/availability', {
          method: 'PUT',
          body: { service_id: activeServiceId, templates }
        });
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

  // Compact range string for the input value: "9:00-17:00" → "9a-5p".
  function formatRange(startHHMMSS, endHHMMSS) {
    const a = String(startHHMMSS || '').slice(0, 5);
    const b = String(endHHMMSS   || '').slice(0, 5);
    return formatHM(a) + '-' + formatHM(b);
  }
  function formatHM(hhmm) {
    const [hStr, mStr] = hhmm.split(':');
    let h = +hStr; const m = +mStr;
    const mer = h >= 12 ? 'p' : 'a';
    h = h % 12; if (h === 0) h = 12;
    return m === 0 ? `${h}${mer}` : `${h}:${String(m).padStart(2, '0')}${mer}`;
  }
  // Friendlier "9:00 AM – 5:00 PM" preview shown under the input.
  function formatRangeDisplay(startHHMM, endHHMM) {
    return formatHMDisplay(startHHMM) + ' – ' + formatHMDisplay(endHHMM);
  }
  function formatHMDisplay(hhmm) {
    const [hStr, mStr] = hhmm.split(':');
    let h = +hStr; const m = +mStr;
    const mer = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${mer}`;
  }

  // ----- Days Off sub-view -----
  // One-off date blackouts. Will needs Monday off → add a row here
  // for that Monday and the widget skips it. Doesn't touch the
  // weekly recurring template, so the *next* Monday is back to
  // normal automatically.
  async function renderDaysOff() {
    content.appendChild(liveSyncNotice());
    const panel = el('div', { class: 'panel' });
    panel.appendChild(el('h2', { style: 'margin:0 0 4px' }, 'Days Off'));
    panel.appendChild(el('p', { class: 'muted', style: 'margin:0 0 16px;font-size:0.85rem' },
      'Block specific dates without changing your weekly schedule. Leave the time fields empty to block the entire day.'));

    // --- Add form ---
    const todayIso = new Date().toISOString().slice(0, 10);
    const dateIn = el('input', { type: 'date', min: todayIso, value: todayIso, style: 'padding:8px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem' });
    const startIn = el('input', { type: 'time', placeholder: 'Start (optional)', style: 'padding:8px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem;width:120px' });
    const endIn   = el('input', { type: 'time', placeholder: 'End (optional)',   style: 'padding:8px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem;width:120px' });
    const reasonIn = el('input', { type: 'text', placeholder: 'Reason (optional, e.g. "Doctor appt")', style: 'padding:8px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem;flex:1;min-width:200px' });
    const listWrap = el('div', {});

    const refresh = async () => {
      listWrap.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      try {
        const data = await api('/api/portal/bookings/blocks');
        const blocks = data.blocks || [];
        listWrap.replaceChildren();
        if (data.pending_migration) {
          listWrap.appendChild(el('div', {
            style: 'padding:14px;background:rgba(237,137,54,0.1);border:1px solid rgba(237,137,54,0.35);border-radius:8px;color:#fbd38d;font-size:0.85rem;line-height:1.5'
          },
            el('strong', { style: 'color:#f6ad55;display:block;margin-bottom:4px' }, 'One-time setup required'),
            'The Days Off feature needs a database migration to run. Go to ',
            el('strong', {}, 'Master Admin → Verify Migrations'),
            ', then come back here. (You only need to do this once.)'
          ));
          return;
        }
        if (!blocks.length) {
          listWrap.appendChild(el('p', { class: 'muted' }, 'No upcoming days off scheduled.'));
          return;
        }
        listWrap.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Date'),
            el('th', {}, 'Window'),
            el('th', {}, 'Reason'),
            el('th', {}, '')
          )),
          el('tbody', {}, ...blocks.map(b => {
            const dateLabel = new Date(b.blocked_date + 'T12:00:00').toLocaleDateString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
            });
            const window = (!b.start_time && !b.end_time) ? 'All day'
                         : `${(b.start_time || '').slice(0,5)} – ${(b.end_time || '').slice(0,5)}`;
            return el('tr', {},
              el('td', {}, dateLabel),
              el('td', {}, window),
              el('td', { class: 'muted' }, b.reason || '—'),
              el('td', {}, el('button', {
                class: 'btn sm danger',
                onclick: async () => {
                  if (!confirm(`Remove the ${dateLabel} block?\n\nThis date will become bookable again.`)) return;
                  try {
                    await api('/api/portal/bookings/blocks?id=' + encodeURIComponent(b.id), { method: 'DELETE' });
                    toast('Day off removed'); refresh();
                  } catch (e) { toast('Remove failed: ' + e.message, true); }
                }
              }, 'Remove'))
            );
          }))
        ));
      } catch (e) {
        listWrap.replaceChildren(el('p', { class: 'err' }, 'Failed to load: ' + e.message));
      }
    };

    const addBtn = el('button', { class: 'btn primary', onclick: async () => {
      const body = { blocked_date: dateIn.value };
      if (startIn.value) body.start_time = startIn.value;
      if (endIn.value)   body.end_time   = endIn.value;
      if (reasonIn.value.trim()) body.reason = reasonIn.value.trim();
      if (!body.blocked_date) { toast('Pick a date', true); return; }
      if ((body.start_time && !body.end_time) || (!body.start_time && body.end_time)) {
        toast('Provide both start and end, or leave both empty for full day', true);
        return;
      }
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      try {
        await api('/api/portal/bookings/blocks', { method: 'POST', body });
        toast('Day off added');
        startIn.value = ''; endIn.value = ''; reasonIn.value = '';
        refresh();
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('pending_migration')) {
          toast('Setup needed: Master Admin → Verify Migrations, then try again.', true, 8000);
        } else if (msg.includes('already_blocked')) {
          toast('That date and time window is already blocked.', true);
        } else {
          toast('Failed: ' + msg, true);
        }
      } finally {
        addBtn.disabled = false; addBtn.textContent = 'Add Day Off';
      }
    } }, 'Add Day Off');

    panel.appendChild(el('div', {
      style: 'display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:14px;background:rgba(99,179,237,0.05);border:1px solid rgba(99,179,237,0.18);border-radius:8px;margin-bottom:18px'
    },
      el('div', {}, el('div', { class: 'muted', style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px' }, 'Date'), dateIn),
      el('div', {}, el('div', { class: 'muted', style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px' }, 'From (optional)'), startIn),
      el('div', {}, el('div', { class: 'muted', style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px' }, 'To (optional)'), endIn),
      el('div', { style: 'flex:1;min-width:200px' }, el('div', { class: 'muted', style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px' }, 'Reason'), reasonIn),
      addBtn
    ));

    panel.appendChild(el('h3', { style: 'margin:0 0 10px;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted,#888)' }, 'Upcoming'));
    panel.appendChild(listWrap);
    content.appendChild(panel);
    refresh();
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
        el('th', {}, 'Email'), el('th', {}, 'Source'),
        el('th', {}, 'Status'), el('th', {}, 'Tags'), el('th', {}, '')
      )),
      el('tbody', {}, ...r.leads.map(l => {
        let currentTags = normalizeTags(l.tags);
        const tagsCell = tagChips({
          getTags: () => currentTags,
          saveTags: async (next) => {
            await api('/api/portal/crm?action=leads', {
              method: 'PATCH', body: { id: l.id, tags: next }
            });
            currentTags = next;
          }
        });

        const paidBtn = l.paid_at
          ? el('button', {
              class: 'btn sm ghost',
              title: 'Marked paid on ' + new Date(l.paid_at).toLocaleDateString(),
              onclick: async () => {
                try {
                  await api('/api/portal/crm?action=leads', { method: 'PATCH', body: { id: l.id, mark_unpaid: true } });
                  toast('Removed paid status'); render();
                } catch (e) { toast(e.message, true); }
              }
            }, '✓ Paid (undo)')
          : el('button', {
              class: 'btn sm primary',
              onclick: async () => {
                try {
                  const r = await api('/api/portal/crm?action=leads', { method: 'PATCH', body: { id: l.id, mark_paid: true, tags: [...new Set([...normalizeTags(l.tags).filter(t => t !== 'Free Trial'), 'Paid', 'Current Client'])] } });
                  const extra = r?.cancelled_nudges
                    ? ` · cancelled ${r.cancelled_nudges} pending nudge${r.cancelled_nudges === 1 ? '' : 's'}`
                    : '';
                  toast('Marked as paid · Paid + Current Client tags' + extra);
                  render();
                } catch (e) { toast(e.message, true); }
              }
            }, 'Mark Paid');

        // Single-click "Stop Nudges": tags Do Not Contact + cancels queued
        // drips on the same request. Useful when a customer signs up via
        // a different channel (in-person, partner referral) so Mark Paid
        // doesn't apply, but you still need to stop bothering them.
        const tagsHasDNC = normalizeTags(l.tags).includes('Do Not Contact');
        const stopBtn = tagsHasDNC
          ? null
          : el('button', {
              class: 'btn sm',
              title: 'Tag as Do Not Contact + cancel any pending nudges',
              onclick: async () => {
                try {
                  const r = await api('/api/portal/crm?action=leads', {
                    method: 'PATCH',
                    body: { id: l.id, tags: [...new Set([...normalizeTags(l.tags), 'Do Not Contact'])] }
                  });
                  const extra = r?.cancelled_nudges
                    ? ` · cancelled ${r.cancelled_nudges} pending nudge${r.cancelled_nudges === 1 ? '' : 's'}`
                    : '';
                  toast('Stopped nudges for this lead' + extra);
                  render();
                } catch (e) { toast(e.message, true); }
              }
            }, 'Stop Nudges');

        return el('tr', {},
          el('td', {}, new Date(l.created_at).toLocaleString()),
          el('td', {}, el('div', { class: 'lead-name-cell' },
            renderAvatar({ name: l.name, avatarUrl: l.avatar_url, size: 'sm' }),
            el('button', {
              class: 'link-btn',
              title: 'Open customer profile',
              onclick: () => openCustomerProfile(l.id)
            }, l.name || '—')
          )),
          el('td', {}, l.phone || '—'),
          el('td', {}, l.email || '—'),
          el('td', {}, el('span', { class: 'badge' }, l.source || 'manual')),
          el('td', {}, el('span', { class: 'badge' + (l.paid_at ? ' green' : '') }, l.paid_at ? 'paid' : (l.status || 'new'))),
          el('td', {}, tagsCell),
          el('td', {}, el('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;justify-content:flex-end' },
            paidBtn,
            stopBtn,
            el('button', { class: 'btn sm danger', onclick: async () => {
              if (!confirm('Delete lead?')) return;
              try {
                await api('/api/portal/crm?action=leads', { method: 'DELETE', body: { id: l.id } });
                toast('Lead deleted');
                render();
              } catch (e) { toast('Delete failed: ' + e.message, true); }
            }}, 'Delete')
          ))
        );
      }))
    ));
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

async function loadLeadMetrics(container) {
  try {
    // GA4 is per-tenant — for tenants without a configured property
    // (DLP / GoElev8.ai before setup) the call returns configured:false
    // or 500s. Soft-fail so the rest of the strip still renders.
    const [gaRes, lr] = await Promise.all([
      api('/api/portal/ga4').catch(() => ({ configured: false })),
      api('/api/portal/crm?action=leads')
    ]);
    const ga = gaRes && gaRes.configured !== false ? gaRes : {};
    const views = ga.page_views || ga.sessions || 0;
    const leadList = lr.leads || [];
    const leads = leadList.length;
    const paidLeads = leadList.filter(l => l.paid_at).length;
    const rate = views > 0 ? ((leads / views) * 100).toFixed(1) : '0.0';
    const paidRate = leads > 0 ? ((paidLeads / leads) * 100).toFixed(1) : '0.0';

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
      el('div', { class: 'metric-stat' },
        el('span', { class: 'metric-stat-value' }, `${rate}%`),
        el('span', { class: 'metric-stat-label' }, 'Lead Conversion')
      ),
      el('div', { class: 'metric-divider' }),
      el('div', { class: 'metric-stat accent' },
        el('span', { class: 'metric-stat-value' }, `${paidLeads} (${paidRate}%)`),
        el('span', { class: 'metric-stat-label' }, 'Free → Paid')
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

// Unified Messaging tab. Wraps the existing Messages / Blasts / Nudges
// views under a single sidebar entry with sub-tab chips at the top so
// the sidebar stays focused on the 6 primary destinations. Each
// sub-tab simply delegates to the underlying view function — no
// behavior changes — and remembers the last selection so coming back
// to the tab puts the operator back where they were.
async function viewMessaging() {
  const wrap = el('div', { class: 'messaging-tab' });
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Messaging')));

  // Persist the active sub-tab on the SPA's state object so router
  // re-renders (e.g. after sending a blast) keep the same sub-view.
  state._messagingSub = state._messagingSub || 'inbox';
  let active = state._messagingSub;

  // Prominent segmented-control sub-tab bar so 'Blasts' and 'Nudges'
  // read unambiguously as sub-sections (the previous tiny .chip
  // styling buried them — operators thought Blasts had been deleted).
  const subTabBar = el('div', { class: 'messaging-subtabs' });
  const content = el('div', {});

  const SUBTABS = [
    { id: 'inbox',  label: '💬 Inbox',     loader: viewMessages },
    { id: 'blasts', label: '📣 SMS Blasts', loader: viewBlasts },
    { id: 'nudges', label: '⚡ Nudges',     loader: viewNudges }
  ];

  function renderSubTabBar() {
    subTabBar.replaceChildren(...SUBTABS.map(t => el('button', {
      class: 'messaging-subtab-btn' + (active === t.id ? ' active' : ''),
      onclick: async () => {
        if (active === t.id) return;
        active = t.id;
        state._messagingSub = active;
        renderSubTabBar();
        await renderActive();
      }
    }, t.label)));
  }

  async function renderActive() {
    content.replaceChildren(el('p', { class: 'muted', style: 'padding:24px' }, 'Loading…'));
    const def = SUBTABS.find(t => t.id === active) || SUBTABS[0];
    try {
      const inner = await def.loader();
      // Each sub-view renders its own topbar with an H1 + (sometimes)
      // action buttons like '+ New Blast' / 'Import Contacts'. We
      // strip JUST the duplicate H1 so the Messaging tab's own H1
      // doesn't double up — but we KEEP the action buttons by
      // promoting the remaining topbar contents into a slim toolbar.
      // Previous version removed the whole .topbar, which made
      // '+ New Blast' and 'Import Contacts' vanish from the Blasts
      // sub-tab.
      const innerTopbar = inner.querySelector('.topbar');
      if (innerTopbar) {
        const h1 = innerTopbar.querySelector('h1');
        if (h1) h1.remove();
        // Anything left in the topbar (action buttons, status text)
        // stays where it is — just restyle so it doesn't look like
        // a stranded page header.
        innerTopbar.classList.remove('topbar');
        innerTopbar.classList.add('messaging-subview-toolbar');
        if (!innerTopbar.children.length && !innerTopbar.textContent.trim()) {
          innerTopbar.remove();
        }
      }
      content.replaceChildren(inner);
    } catch (e) {
      content.replaceChildren(el('p', { class: 'err', style: 'padding:24px' }, 'Failed to load: ' + e.message));
    }
  }

  renderSubTabBar();
  await renderActive();
  wrap.appendChild(subTabBar);
  wrap.appendChild(content);
  return wrap;
}

// ============================================================
// APPLICATIONS (artist applications submitted via the tenant's public
// site → routed through the Supabase /submit-application Edge Function
// into public.applications, then surfaced here for review + workflow).
// ============================================================
async function viewApplications() {
  const wrap = el('div', { class: 'applications-tab' });
  const topbar = el('div', { class: 'topbar' },
    el('h1', {}, 'Applications'),
    el('div', { class: 'muted', id: 'apps-subtitle' }, 'Loading…')
  );
  wrap.appendChild(topbar);

  let activeStatus = state._applicationsFilter || 'all';
  let data = { applications: [], counts: {} };

  const filterBar = el('div', { class: 'filter-bar', style: 'margin-bottom:14px' });
  const list = el('div', {});

  async function load() {
    list.replaceChildren(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Loading applications…')));
    try {
      const q = activeStatus === 'all' ? '' : `?status=${encodeURIComponent(activeStatus)}`;
      data = await api('/api/portal/applications' + q);
      const sub = topbar.querySelector('#apps-subtitle');
      const total = data.counts?.all || 0;
      const news  = data.counts?.new || 0;
      if (sub) {
        sub.textContent = total
          ? `${total} total · ${news} new${news ? ' to review' : ''}`
          : 'No applications yet';
      }
      renderFilters();
      renderList();
    } catch (e) {
      list.replaceChildren(el('div', { class: 'panel' },
        el('p', { class: 'err' }, 'Failed to load: ' + e.message)));
    }
  }

  function renderFilters() {
    const c = data.counts || {};
    const STATUSES = [
      { id: 'all',       label: 'All' },
      { id: 'new',       label: 'New' },
      { id: 'reviewed',  label: 'Reviewed' },
      { id: 'interview', label: 'Interview' },
      { id: 'hired',     label: 'Hired' },
      { id: 'declined',  label: 'Declined' }
    ];
    filterBar.replaceChildren(...STATUSES.map(s => {
      const n = c[s.id] || 0;
      const btn = el('button', {
        class: 'chip' + (activeStatus === s.id ? ' active' : ''),
        onclick: () => {
          if (activeStatus === s.id) return;
          activeStatus = s.id;
          state._applicationsFilter = activeStatus;
          load();
        }
      },
        s.label,
        n ? el('span', { class: 'chip-count' }, ' ' + n) : null
      );
      return btn;
    }));
  }

  function renderList() {
    const apps = data.applications || [];
    if (!apps.length) {
      const isEmpty = (data.counts?.all || 0) === 0;
      list.replaceChildren(el('div', {
        class: 'panel',
        style: 'text-align:center;padding:48px 24px'
      },
        el('div', { style: 'font-size:42px;margin-bottom:8px' }, '📋'),
        el('h3', { style: 'margin:0 0 6px' },
          isEmpty ? 'No applications yet' : 'No applications match this filter'),
        el('p', { class: 'muted', style: 'margin:0;max-width:380px;margin-left:auto;margin-right:auto' },
          isEmpty
            ? 'Share your Apply link to get started. Submissions from your public site land here in real time.'
            : 'Try the “All” filter to see other applications, or wait for new submissions to roll in.'
        )
      ));
      return;
    }
    list.replaceChildren(...apps.map(a => renderApplicationCard(a, load)));
  }

  wrap.appendChild(filterBar);
  wrap.appendChild(list);
  await load();
  return wrap;
}

function renderApplicationCard(a, onChange) {
  const specialties = Array.isArray(a.specialty) ? a.specialty.filter(Boolean) : [];
  const summaryBits = [
    a.city_state,
    a.years_experience ? `${a.years_experience} years` : null,
    a.schedule,
    a.employment_status
  ].filter(Boolean);
  return el('div', {
    class: 'application-card panel',
    role: 'button',
    tabindex: '0',
    onclick: () => openApplicationDrawer(a, onChange),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApplicationDrawer(a, onChange); }
    }
  },
    el('div', { class: 'row between', style: 'align-items:flex-start;flex-wrap:wrap;gap:10px' },
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'application-name' }, a.full_name || a.email || 'Anonymous applicant'),
        specialties.length
          ? el('div', { class: 'application-chips' },
              ...specialties.slice(0, 4).map(s => el('span', { class: 'application-spec-chip' }, s)),
              specialties.length > 4 ? el('span', { class: 'application-spec-chip more' }, `+${specialties.length - 4}`) : null
            )
          : null
      ),
      el('div', { style: 'text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px' },
        renderApplicationStatusBadge(a.status),
        el('div', { class: 'muted', style: 'font-size:11px' }, relativeFromNow(a.created_at))
      )
    ),
    summaryBits.length
      ? el('div', { class: 'application-summary muted' }, summaryBits.join(' · '))
      : null
  );
}

function renderApplicationStatusBadge(status) {
  const s = status || 'new';
  return el('span', { class: `application-status application-status-${s}` },
    s.charAt(0).toUpperCase() + s.slice(1)
  );
}

function relativeFromNow(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return new Date(iso).toLocaleDateString();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(ms / 86400000);
  if (d > 30) return new Date(iso).toLocaleDateString();
  if (d > 0)  return `${d} day${d === 1 ? '' : 's'} ago`;
  if (h > 0)  return `${h} hour${h === 1 ? '' : 's'} ago`;
  if (m > 0)  return `${m} min${m === 1 ? '' : 's'} ago`;
  return 'just now';
}

// Detail drawer for an application — readable layout for all submitted
// fields plus operator-editable status + internal notes. Patches via
// /api/portal/applications and re-runs the list loader on save.
function openApplicationDrawer(app, onSaved) {
  // Close any previously open drawer.
  const existing = document.querySelector('.application-drawer-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'application-drawer-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const drawer = el('div', { class: 'application-drawer' });

  const specialties = Array.isArray(app.specialty) ? app.specialty.filter(Boolean) : [];
  const statusSelect = el('select', { class: 'cta-select' },
    ...['new','reviewed','interview','hired','declined'].map(s =>
      el('option', { value: s, selected: app.status === s ? '' : false },
        s.charAt(0).toUpperCase() + s.slice(1)))
  );
  const notesInput = el('textarea', {
    rows: 4,
    placeholder: 'Internal notes (visible to your team only)…',
    style: 'width:100%;resize:vertical'
  });
  if (app.notes) notesInput.value = app.notes;

  const fieldRow = (label, value) =>
    value
      ? el('div', { class: 'application-field' },
          el('div', { class: 'application-field-label' }, label),
          el('div', { class: 'application-field-value' }, value)
        )
      : null;

  const linkRow = (label, url) =>
    url
      ? el('div', { class: 'application-field' },
          el('div', { class: 'application-field-label' }, label),
          el('div', { class: 'application-field-value' },
            el('a', { href: url.startsWith('http') ? url : 'https://' + url, target: '_blank', rel: 'noopener' }, url)
          )
        )
      : null;

  const errBox = el('div');
  const saveBtn = el('button', { class: 'btn primary', onclick: async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    errBox.innerHTML = '';
    try {
      const r = await api('/api/portal/applications', {
        method: 'PATCH',
        body: { id: app.id, status: statusSelect.value, notes: notesInput.value }
      });
      Object.assign(app, r.application || {});
      toast('Application updated');
      close();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      errBox.innerHTML = `<div class="err">${e.message}</div>`;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save changes';
    }
  } }, 'Save changes');

  drawer.appendChild(el('div', { class: 'application-drawer-header' },
    el('div', { style: 'flex:1;min-width:0' },
      el('h2', {}, app.full_name || app.email || 'Application'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' },
        `Submitted ${relativeFromNow(app.created_at)} · ${new Date(app.created_at).toLocaleString()}`)
    ),
    el('button', { class: 'btn ghost sm', onclick: close, title: 'Close' }, '×')
  ));

  // Status + quick actions
  drawer.appendChild(el('div', { class: 'application-status-row' },
    el('div', { class: 'application-field-label' }, 'Status'),
    statusSelect
  ));

  // Contact section
  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Contact'),
    el('div', { class: 'application-grid' },
      fieldRow('Full name', app.full_name),
      fieldRow('Email', app.email),
      fieldRow('Phone', app.phone),
      linkRow('Instagram', app.instagram),
      fieldRow('City / State', app.city_state)
    )
  ));

  // Specialties
  if (specialties.length) {
    drawer.appendChild(el('div', { class: 'application-section' },
      el('h3', {}, 'Specialties'),
      el('div', { class: 'application-chips' },
        ...specialties.map(s => el('span', { class: 'application-spec-chip' }, s))
      )
    ));
  }

  // Experience
  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Experience'),
    el('div', { class: 'application-grid' },
      fieldRow('Years', app.years_experience),
      fieldRow('Currently', app.employment_status),
      fieldRow('Has existing clientele', app.has_clientele === true ? 'Yes' : app.has_clientele === false ? 'No' : null),
      fieldRow('Clientele size', app.clientele_count)
    )
  ));

  // Logistics
  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Logistics'),
    el('div', { class: 'application-grid' },
      fieldRow('Desired start', app.desired_start),
      fieldRow('Booth preference', app.booth_preference),
      fieldRow('Schedule', app.schedule),
      fieldRow('Heard about us via', app.referral_source)
    )
  ));

  // Bio + portfolio
  if (app.bio || app.portfolio_url) {
    drawer.appendChild(el('div', { class: 'application-section' },
      el('h3', {}, 'About'),
      app.bio
        ? el('div', { class: 'application-field' },
            el('div', { class: 'application-field-label' }, 'Bio'),
            el('div', { class: 'application-bio' }, app.bio)
          )
        : null,
      linkRow('Portfolio', app.portfolio_url)
    ));
  }

  // Internal notes
  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Internal notes'),
    notesInput
  ));

  drawer.appendChild(errBox);
  drawer.appendChild(el('div', { class: 'application-drawer-actions' },
    el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
    saveBtn
  ));

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

// ============================================================
// TRAINER APPLICATIONS (coach intake submitted via theflexfacility.com/
// trainers → /api/trainer-apply → public.trainer_applications). Lives
// in its own tab, separate from the Applications (artist) and Leads
// tabs by design — see the trainer_applications migration for context.
// ============================================================
async function viewTrainerApplications() {
  const wrap = el('div', { class: 'applications-tab' });
  const topbar = el('div', { class: 'topbar' },
    el('h1', {}, 'Trainer Applications'),
    el('div', { class: 'muted', id: 'trainer-apps-subtitle' }, 'Loading…')
  );
  wrap.appendChild(topbar);

  let activeStatus = state._trainerApplicationsFilter || 'all';
  let data = { trainer_applications: [], counts: {} };

  const filterBar = el('div', { class: 'filter-bar', style: 'margin-bottom:14px' });
  const list = el('div', {});

  async function load() {
    list.replaceChildren(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Loading trainer applications…')));
    try {
      const q = activeStatus === 'all' ? '' : `?status=${encodeURIComponent(activeStatus)}`;
      data = await api('/api/portal/trainer-applications' + q);
      const sub = topbar.querySelector('#trainer-apps-subtitle');
      const total = data.counts?.all || 0;
      const news  = data.counts?.new || 0;
      if (sub) {
        sub.textContent = total
          ? `${total} total · ${news} new${news ? ' to review' : ''}`
          : 'No trainer applications yet';
      }
      renderFilters();
      renderList();
    } catch (e) {
      list.replaceChildren(el('div', { class: 'panel' },
        el('p', { class: 'err' }, 'Failed to load: ' + e.message)));
    }
  }

  function renderFilters() {
    const c = data.counts || {};
    const STATUSES = [
      { id: 'all',       label: 'All' },
      { id: 'new',       label: 'New' },
      { id: 'reviewed',  label: 'Reviewed' },
      { id: 'interview', label: 'Interview' },
      { id: 'hired',     label: 'Hired' },
      { id: 'declined',  label: 'Declined' }
    ];
    filterBar.replaceChildren(...STATUSES.map(s => {
      const n = c[s.id] || 0;
      const btn = el('button', {
        class: 'chip' + (activeStatus === s.id ? ' active' : ''),
        onclick: () => {
          if (activeStatus === s.id) return;
          activeStatus = s.id;
          state._trainerApplicationsFilter = activeStatus;
          load();
        }
      },
        s.label,
        n ? el('span', { class: 'chip-count' }, ' ' + n) : null
      );
      return btn;
    }));
  }

  function renderList() {
    const apps = data.trainer_applications || [];
    if (!apps.length) {
      const isEmpty = (data.counts?.all || 0) === 0;
      list.replaceChildren(el('div', {
        class: 'panel',
        style: 'text-align:center;padding:48px 24px'
      },
        el('div', { style: 'font-size:42px;margin-bottom:8px' }, '🏋️'),
        el('h3', { style: 'margin:0 0 6px' },
          isEmpty ? 'No trainer applications yet' : 'No applications match this filter'),
        el('p', { class: 'muted', style: 'margin:0;max-width:380px;margin-left:auto;margin-right:auto' },
          isEmpty
            ? 'Share theflexfacility.com/trainers to get coaches in the door. Submissions land here in real time.'
            : 'Try the “All” filter to see other applications.'
        )
      ));
      return;
    }
    list.replaceChildren(...apps.map(a => renderTrainerApplicationCard(a, load)));
  }

  wrap.appendChild(filterBar);
  wrap.appendChild(list);
  await load();
  return wrap;
}

function renderTrainerApplicationCard(a, onChange) {
  const summaryBits = [
    a.years_experience ? `${a.years_experience} years` : null,
    a.certifications
  ].filter(Boolean);
  return el('div', {
    class: 'application-card panel',
    role: 'button',
    tabindex: '0',
    onclick: () => openTrainerApplicationDrawer(a, onChange),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrainerApplicationDrawer(a, onChange); }
    }
  },
    el('div', { class: 'row between', style: 'align-items:flex-start;flex-wrap:wrap;gap:10px' },
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'application-name' }, a.full_name || a.email || 'Anonymous trainer'),
        a.specialty
          ? el('div', { class: 'application-chips' },
              el('span', { class: 'application-spec-chip' }, a.specialty)
            )
          : null
      ),
      el('div', { style: 'text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px' },
        renderApplicationStatusBadge(a.status),
        el('div', { class: 'muted', style: 'font-size:11px' }, relativeFromNow(a.created_at))
      )
    ),
    summaryBits.length
      ? el('div', { class: 'application-summary muted' }, summaryBits.join(' · '))
      : null
  );
}

function openTrainerApplicationDrawer(app, onSaved) {
  const existing = document.querySelector('.application-drawer-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'application-drawer-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const drawer = el('div', { class: 'application-drawer' });

  const statusSelect = el('select', { class: 'cta-select' },
    ...['new','reviewed','interview','hired','declined'].map(s =>
      el('option', { value: s, selected: app.status === s ? '' : false },
        s.charAt(0).toUpperCase() + s.slice(1)))
  );

  const fieldRow = (label, value) =>
    value
      ? el('div', { class: 'application-field' },
          el('div', { class: 'application-field-label' }, label),
          el('div', { class: 'application-field-value' }, value)
        )
      : null;

  const errBox = el('div');
  const saveBtn = el('button', { class: 'btn primary', onclick: async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    errBox.innerHTML = '';
    try {
      const r = await api('/api/portal/trainer-applications', {
        method: 'PATCH',
        body: { id: app.id, status: statusSelect.value }
      });
      Object.assign(app, r.trainer_application || {});
      toast('Trainer application updated');
      close();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      errBox.innerHTML = `<div class="err">${e.message}</div>`;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save changes';
    }
  } }, 'Save changes');

  drawer.appendChild(el('div', { class: 'application-drawer-header' },
    el('div', { style: 'flex:1;min-width:0' },
      el('h2', {}, app.full_name || app.email || 'Trainer application'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' },
        `Submitted ${relativeFromNow(app.created_at)} · ${new Date(app.created_at).toLocaleString()}`)
    ),
    el('button', { class: 'btn ghost sm', onclick: close, title: 'Close' }, '×')
  ));

  drawer.appendChild(el('div', { class: 'application-status-row' },
    el('div', { class: 'application-field-label' }, 'Status'),
    statusSelect
  ));

  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Contact'),
    el('div', { class: 'application-grid' },
      fieldRow('Full name', app.full_name),
      fieldRow('Email', app.email),
      fieldRow('Phone', app.phone)
    )
  ));

  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Experience'),
    el('div', { class: 'application-grid' },
      fieldRow('Specialty', app.specialty),
      fieldRow('Years', app.years_experience),
      fieldRow('Certifications', app.certifications)
    )
  ));

  if (app.why_flex) {
    drawer.appendChild(el('div', { class: 'application-section' },
      el('h3', {}, 'Why The Flex Facility?'),
      el('div', { class: 'application-bio' }, app.why_flex)
    ));
  }

  drawer.appendChild(errBox);
  drawer.appendChild(el('div', { class: 'application-drawer-actions' },
    el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
    saveBtn
  ));

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

// ============================================================
// MERCH — products, coupons, orders for the storefront on each
// tenant's marketing site (e.g. willpowerfitnessfactory.com/merch).
// Storefront fetches /api/external/products to render prices, calls
// /api/external/coupons/validate at checkout, then POSTs the finished
// order to /api/external/orders. The operator manages all three
// surfaces here.
// ============================================================
async function viewMerch() {
  const wrap = el('div', { class: 'merch-tab' });
  const topbar = el('div', { class: 'topbar' },
    el('h1', {}, 'Merch'),
    el('div', { class: 'muted', id: 'merch-subtitle' }, 'Loading…')
  );
  wrap.appendChild(topbar);

  state._merchSub = state._merchSub || 'products';
  let active = state._merchSub;

  const subTabBar = el('div', { class: 'filter-bar', style: 'margin-bottom:14px' });
  const content = el('div', {});

  const SUBTABS = [
    { id: 'products', label: 'Products' },
    { id: 'coupons',  label: 'Promos'   },
    { id: 'orders',   label: 'Orders'   },
    { id: 'pickup',   label: 'Pickup'   }
  ];

  function renderSubTabBar() {
    subTabBar.replaceChildren(...SUBTABS.map(t => el('button', {
      class: 'chip' + (active === t.id ? ' active' : ''),
      onclick: async () => {
        if (active === t.id) return;
        active = t.id;
        state._merchSub = active;
        renderSubTabBar();
        await renderActive();
      }
    }, t.label)));
  }

  async function renderActive() {
    content.replaceChildren(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Loading…')));
    try {
      if (active === 'products') await renderMerchProducts(content);
      else if (active === 'coupons') await renderMerchCoupons(content);
      else if (active === 'pickup')  await renderMerchPickup(content);
      else await renderMerchOrders(content);
    } catch (e) {
      content.replaceChildren(el('div', { class: 'panel' },
        el('p', { class: 'err' }, 'Failed to load: ' + e.message)));
    }
  }

  // Header summary — pulls a quick count + revenue for context.
  (async () => {
    try {
      const r = await api('/api/portal/merch?action=summary');
      const sub = topbar.querySelector('#merch-subtitle');
      if (sub) {
        if (r.setup_required) {
          sub.textContent = 'Run Pending Migrations to enable the merch storefront.';
        } else {
          const c = r.counts || {};
          const rev = '$' + ((r.revenue_cents || 0) / 100).toFixed(2);
          sub.textContent = `${c.products || 0} product${c.products === 1 ? '' : 's'} · ${c.active_coupons || 0} active promo${c.active_coupons === 1 ? '' : 's'} · ${c.orders || 0} order${c.orders === 1 ? '' : 's'} · ${rev} total`;
        }
      }
    } catch { /* non-fatal */ }
  })();

  renderSubTabBar();
  await renderActive();
  wrap.appendChild(subTabBar);
  wrap.appendChild(content);
  return wrap;
}

async function renderMerchProducts(container) {
  const r = await api('/api/portal/merch?action=list-products');
  const products = r.products || [];
  const setupRequired = !!r.setup_required;
  container.replaceChildren();

  // Storefront URL is rendered per-tenant so the subtitle matches
  // whichever client is logged in (Nate sees islaystudiosllc.com,
  // Will sees willpowerfitnessfactory.com, etc). Falls back to a
  // generic message when we don't have a hardcoded mapping yet.
  const STOREFRONT_URLS = {
    'islay-studios':      'islaystudiosllc.com/merch',
    'willpower-fitness':  'willpowerfitnessfactory.com/merch',
    'flex-facility':      'theflexfacility.com/merch'
  };
  const storefrontUrl = STOREFRONT_URLS[state.client?.slug];
  const subtitleText = storefrontUrl
    ? `Edits here update ${storefrontUrl} within a minute. No deploy needed.`
    : 'Edits here update your public storefront within a minute. No deploy needed.';

  const header = el('div', { class: 'row between', style: 'margin-bottom:12px' },
    el('div', { class: 'muted' }, subtitleText),
    el('button', { class: 'btn primary',
      disabled: setupRequired ? '' : false,
      onclick: () => openMerchProductModal(null, () => renderMerchProducts(container))
    }, '+ Add Product')
  );
  container.appendChild(header);

  if (setupRequired) {
    container.appendChild(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Merch tables not yet installed. Master Admin → Run Pending Migrations.')
    ));
    return;
  }

  if (!products.length) {
    container.appendChild(el('div', { class: 'panel', style: 'text-align:center;padding:48px 24px' },
      el('div', { style: 'font-size:42px;margin-bottom:8px' }, '🛍️'),
      el('h3', { style: 'margin:0 0 6px' }, 'No products yet'),
      el('p', { class: 'muted', style: 'margin:0 0 16px' },
        'Add the first product so prices show up on your storefront.'),
      el('button', { class: 'btn primary',
        onclick: () => openMerchProductModal(null, () => renderMerchProducts(container))
      }, '+ Add Product')
    ));
    return;
  }

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px' });
  for (const p of products) {
    grid.appendChild(renderMerchProductCard(p, () => renderMerchProducts(container)));
  }
  container.appendChild(grid);
}

function renderMerchProductCard(p, reload) {
  const price = '$' + ((p.base_price_cents || 0) / 100).toFixed(2);
  const compare = p.compare_at_price_cents
    ? ' (was $' + (p.compare_at_price_cents / 100).toFixed(2) + ')'
    : '';
  return el('div', {
    class: 'panel',
    style: 'padding:14px 16px;cursor:pointer;display:flex;flex-direction:column;gap:8px' +
      (p.is_active ? '' : ';opacity:0.55'),
    onclick: () => openMerchProductModal(p, reload)
  },
    el('div', { class: 'row between', style: 'align-items:flex-start;gap:10px' },
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { style: 'font-weight:600;font-size:15px;margin-bottom:2px' }, p.name),
        el('div', { class: 'muted mono', style: 'font-size:11px' }, p.product_key)
      ),
      el('span', {
        style: 'display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;' +
          (p.is_active
            ? 'background:rgba(34,197,94,0.18);color:#86efac'
            : 'background:rgba(148,163,184,0.18);color:#cbd5e1')
      }, p.is_active ? 'Live' : 'Hidden')
    ),
    el('div', { style: 'font-size:20px;font-weight:600' }, price,
      compare ? el('span', { class: 'muted', style: 'font-size:12px;font-weight:400;margin-left:6px;text-decoration:line-through' }, compare) : null
    ),
    p.description
      ? el('div', { class: 'muted', style: 'font-size:12px;line-height:1.45' },
          p.description.length > 90 ? p.description.slice(0, 87) + '…' : p.description)
      : null
  );
}

function openMerchProductModal(product, onSaved) {
  const isEdit = !!product;
  const existing = document.querySelector('.application-drawer-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'application-drawer-overlay' });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const drawer = el('div', { class: 'application-drawer' });

  const keyInput   = el('input', { type: 'text', value: product?.product_key || '', placeholder: 'e.g. tee, tank, hoodie' });
  const nameInput  = el('input', { type: 'text', value: product?.name || '',        placeholder: 'Product name (e.g. Shampoo, Logo Tee)' });
  const descInput  = el('textarea', { rows: 3, placeholder: 'Short description shown on the storefront card' });
  if (product?.description) descInput.value = product.description;
  const priceInput   = el('input', { type: 'number', min: '0', step: '0.01', value: product ? ((product.base_price_cents || 0) / 100).toFixed(2) : '' });
  const compareInput = el('input', { type: 'number', min: '0', step: '0.01', value: product?.compare_at_price_cents != null ? (product.compare_at_price_cents / 100).toFixed(2) : '' });
  const imageInput   = el('input', { type: 'url', value: product?.image_url || '', placeholder: 'https://…/tee.jpg' });
  const imagePreview = el('img', {
    src: product?.image_url || '',
    alt: '',
    style: 'max-width:140px;max-height:140px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);' +
      'object-fit:cover;display:' + (product?.image_url ? 'block' : 'none') + ';margin-bottom:8px;'
  });
  imageInput.addEventListener('input', () => {
    if (imageInput.value) {
      imagePreview.src = imageInput.value;
      imagePreview.style.display = 'block';
    } else {
      imagePreview.style.display = 'none';
    }
  });
  // Mobile photo picker: accept="image/*" prompts iOS/Android to show
  // both "Take Photo" and "Choose from Library". Once selected, we
  // base64-encode the file and POST to the upload endpoint, then drop
  // the resulting public URL into the URL field above.
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  const fileStatus = el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;min-height:14px' });
  const uploadBtn  = el('button', { type: 'button', class: 'btn sm ghost',
    onclick: () => fileInput.click()
  }, '📷 Upload from phone');
  // Track in-flight uploads so saveBtn (defined later) can block until
  // the URL lands. Without this, an impatient operator clicks Save
  // before the upload returns and the product is saved with image_url
  // null — exactly the bug Will hit on the first test product.
  let uploadingPromise = null;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      fileStatus.innerHTML = '<span style="color:#fca5a5">Please pick an image file.</span>';
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      fileStatus.innerHTML = '<span style="color:#fca5a5">Image too large (10 MB max).</span>';
      return;
    }
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.dataset.uploadGate = '1'; }
    fileStatus.textContent = '';
    uploadingPromise = (async () => {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = reject;
          r.readAsDataURL(f);
        });
        const out = await api('/api/portal/merch?action=upload-image', {
          method: 'POST',
          body: { data_url: dataUrl, filename: f.name }
        });
        imageInput.value = out.url || '';
        imagePreview.src = out.url || '';
        imagePreview.style.display = out.url ? 'block' : 'none';
        fileStatus.innerHTML = '<span style="color:#86efac">✓ Uploaded · click Save to attach</span>';
        return out.url;
      } catch (e) {
        fileStatus.innerHTML = `<span style="color:#fca5a5">${e.message}</span>`;
        return null;
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '📷 Upload from phone';
        fileInput.value = ''; // allow re-selecting the same file
        if (saveBtn && saveBtn.dataset.uploadGate === '1') {
          delete saveBtn.dataset.uploadGate;
          saveBtn.disabled = false;
        }
      }
    })();
    return uploadingPromise;
  });
  // ─── Color variants ───
  // Up to ~12 color rows, each { name, image_url }. When set, the
  // storefront renders a row of swatches under the product image and
  // swaps the displayed image when the customer taps one. The
  // selected color flows through to Stripe Checkout as variant.color
  // and lands in merch_order_items.color so the operator sees which
  // color a buyer picked on each line item.
  //
  // colorRows is the live array; mutated in place by each row's input
  // listeners + the Add/Remove buttons. saveBtn reads colorRows.
  const colorRows = Array.isArray(product?.colors) ? product.colors.map(c => ({
    name: c?.name || '',
    image_url: c?.image_url || ''
  })) : [];
  const colorsHost = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px' });
  const colorUploadingPromises = new Set();

  function renderColors() {
    colorsHost.innerHTML = '';
    if (!colorRows.length) {
      colorsHost.appendChild(el('div', { class: 'muted', style: 'font-size:11px;padding:6px 0' },
        'No color variants. Click + Add color to offer the same product in multiple colors with different images.'));
    }
    colorRows.forEach((c, i) => {
      const row = el('div', {
        style: 'display:flex;gap:8px;align-items:center;padding:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-radius:6px;flex-wrap:wrap'
      });

      const preview = el('img', {
        src: c.image_url || '',
        alt: '',
        style: 'width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid rgba(255,255,255,0.08);' +
               'display:' + (c.image_url ? 'block' : 'none') + ';flex:0 0 48px'
      });

      const nameIn = el('input', { type: 'text', value: c.name, placeholder: 'Color name (e.g. Black)' });
      nameIn.style.cssText = 'width:100%;padding:6px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:4px;color:var(--text,#e0e0e0);font-size:13px';
      nameIn.addEventListener('input', () => { c.name = nameIn.value; });

      const urlIn = el('input', { type: 'url', value: c.image_url, placeholder: 'Image URL or upload below' });
      urlIn.style.cssText = 'width:100%;padding:6px 10px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:4px;color:var(--text,#e0e0e0);font-size:12px;margin-top:4px;font-family:monospace';
      urlIn.addEventListener('input', () => {
        c.image_url = urlIn.value;
        preview.src = urlIn.value;
        preview.style.display = urlIn.value ? 'block' : 'none';
      });

      const fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
      const fileStat = el('span', { class: 'muted', style: 'font-size:10px;margin-left:6px' });
      const uploadBtn = el('button', {
        type: 'button',
        class: 'btn sm ghost',
        style: 'font-size:11px',
        onclick: () => fileIn.click()
      }, '📷 Upload');
      fileIn.addEventListener('change', async () => {
        const f = fileIn.files?.[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) {
          fileStat.innerHTML = '<span style="color:#fca5a5">Pick an image.</span>';
          return;
        }
        if (f.size > 10 * 1024 * 1024) {
          fileStat.innerHTML = '<span style="color:#fca5a5">Max 10 MB.</span>';
          return;
        }
        uploadBtn.disabled = true; uploadBtn.textContent = '…';
        const p = (async () => {
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result || ''));
              r.onerror = reject;
              r.readAsDataURL(f);
            });
            const out = await api('/api/portal/merch?action=upload-image', {
              method: 'POST',
              body: { data_url: dataUrl, filename: f.name }
            });
            c.image_url = out.url || '';
            urlIn.value = c.image_url;
            preview.src = c.image_url;
            preview.style.display = c.image_url ? 'block' : 'none';
            fileStat.innerHTML = '<span style="color:#86efac">✓</span>';
          } catch (e) {
            fileStat.innerHTML = `<span style="color:#fca5a5">${e.message}</span>`;
          } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = '📷 Upload';
            fileIn.value = '';
          }
        })();
        colorUploadingPromises.add(p);
        try { await p; } finally { colorUploadingPromises.delete(p); }
      });

      const removeBtn = el('button', {
        type: 'button',
        class: 'btn sm ghost',
        style: 'color:#fca5a5;font-size:11px',
        onclick: () => {
          colorRows.splice(i, 1);
          renderColors();
        }
      }, '× Remove');

      row.appendChild(preview);
      row.appendChild(el('div', { style: 'flex:1;min-width:180px' }, nameIn, urlIn));
      row.appendChild(el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap' },
        uploadBtn, fileIn, fileStat, removeBtn
      ));
      colorsHost.appendChild(row);
    });
  }
  renderColors();
  const addColorBtn = el('button', {
    type: 'button',
    class: 'btn sm',
    style: 'margin-top:8px;align-self:flex-start',
    onclick: () => {
      colorRows.push({ name: '', image_url: '' });
      renderColors();
    }
  }, '+ Add color');

  const paymentLinkInput = el('input', { type: 'url', value: product?.payment_link || '',
    placeholder: 'https://buy.stripe.com/…' });
  const activeInput  = el('input', { type: 'checkbox' });
  if (!product || product.is_active) activeInput.checked = true;
  const sortInput    = el('input', { type: 'number', value: product?.sort_order ?? 0 });

  const errBox = el('div');
  const saveBtn = el('button', { class: 'btn primary' }, isEdit ? 'Save changes' : 'Create product');
  saveBtn.onclick = async () => {
    errBox.innerHTML = '';
    if (!nameInput.value.trim()) { errBox.innerHTML = '<div class="err">Name is required.</div>'; return; }
    if (!isEdit && !keyInput.value.trim()) {
      errBox.innerHTML = '<div class="err">Product key is required (e.g. "tee", "hoodie").</div>';
      return;
    }
    // If an upload is still in flight (main image OR any color row),
    // wait for it to land before submitting — otherwise we'd save the
    // product with image_url null even though the operator picked a
    // file, or save colors[] with missing image_url for a row whose
    // upload was still spinning.
    if (uploadingPromise || colorUploadingPromises.size) {
      saveBtn.disabled = true; saveBtn.textContent = 'Waiting for upload…';
      try {
        await Promise.all([
          uploadingPromise || Promise.resolve(),
          ...colorUploadingPromises
        ]);
      } catch { /* errors surface in their respective status slots */ }
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const body = {
      id:                     isEdit ? product.id : undefined,
      product_key:            keyInput.value.trim(),
      name:                   nameInput.value.trim(),
      description:            descInput.value.trim() || null,
      base_price_cents:       Math.round(parseFloat(priceInput.value || '0') * 100),
      compare_at_price_cents: compareInput.value ? Math.round(parseFloat(compareInput.value) * 100) : null,
      image_url:              imageInput.value.trim() || null,
      payment_link:           paymentLinkInput.value.trim() || null,
      is_active:              activeInput.checked,
      sort_order:             parseInt(sortInput.value, 10) || 0,
      // Strip blank rows on save so the operator can leave half-filled
      // rows around mid-edit without those landing in the DB.
      colors: colorRows
        .map(c => ({ name: (c.name || '').trim(), image_url: (c.image_url || '').trim() }))
        .filter(c => c.name)
    };
    try {
      await api('/api/portal/merch?action=upsert-product', { method: 'POST', body });
      toast(isEdit ? 'Product saved' : 'Product created');
      overlay.remove();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      errBox.innerHTML = `<div class="err">${e.message}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save changes' : 'Create product';
    }
  };

  const deleteBtn = isEdit ? el('button', { class: 'btn ghost', style: 'color:#fca5a5' }, 'Delete') : null;
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete "${product.name}"? This can't be undone.`)) return;
      try {
        await api('/api/portal/merch?action=delete-product', { method: 'POST', body: { id: product.id } });
        toast('Product deleted');
        overlay.remove();
        if (typeof onSaved === 'function') onSaved();
      } catch (e) { errBox.innerHTML = `<div class="err">${e.message}</div>`; }
    };
  }

  drawer.appendChild(el('div', { class: 'application-drawer-header' },
    el('div', { style: 'flex:1' }, el('h2', {}, isEdit ? 'Edit product' : 'Add product')),
    el('button', { class: 'btn ghost sm', onclick: () => overlay.remove() }, '×')
  ));
  drawer.appendChild(el('div', { class: 'application-section' },
    el('div', { class: 'field' }, el('label', {}, 'Name'), nameInput),
    el('div', { class: 'field' }, el('label', {}, 'Product key' + (isEdit ? ' (locked)' : '')),
      (isEdit ? el('input', { type: 'text', value: product.product_key, disabled: '' }) : keyInput),
      el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' },
        'Stable identifier the storefront uses (e.g. "tee"). Lowercase, no spaces.')
    ),
    el('div', { class: 'field' }, el('label', {}, 'Description'), descInput),
    el('div', { class: 'row', style: 'gap:12px' },
      el('div', { class: 'field', style: 'flex:1' },
        el('label', {}, 'Sale Price (USD)'),
        priceInput,
        el('div', { class: 'muted', style: 'font-size:0.7rem;margin-top:2px' }, 'What the customer is actually charged. Goes to Stripe.')
      ),
      el('div', { class: 'field', style: 'flex:1' },
        el('label', {}, 'Original Price (optional)'),
        compareInput,
        el('div', { class: 'muted', style: 'font-size:0.7rem;margin-top:2px' }, 'Shown struck-through next to the sale price. Leave blank for no strikethrough.')
      )
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Product image'),
      imagePreview,
      el('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' },
        uploadBtn,
        fileInput,
        el('span', { class: 'muted', style: 'font-size:11px' }, 'or paste a URL:')
      ),
      imageInput,
      fileStatus
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Color variants (optional)'),
      el('div', { class: 'muted', style: 'font-size:11px;margin:2px 0 8px' },
        'One product, multiple colorways. Each row needs a color name and (optionally) its own image — the storefront shows swatches under the product and swaps the image when the customer taps one. Leave blank to keep this product single-color.'
      ),
      colorsHost,
      addColorBtn
    ),
    el('div', { class: 'field' },
      el('label', {}, 'Stripe Payment Link (optional)'),
      paymentLinkInput,
      el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' },
        'Leave blank for normal use — the storefront mints a Stripe Checkout Session at the current Price set above on every Buy click (edit the price here and it takes effect on the next purchase, no Stripe sync needed). Only paste a Payment Link URL if you want to override that flow for this product.')
    ),
    el('div', { class: 'row', style: 'gap:12px;align-items:center' },
      el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px' },
        activeInput, 'Visible on storefront'),
      el('div', { class: 'field', style: 'flex:1;margin:0' },
        el('label', { style: 'font-size:11px' }, 'Sort order'),
        sortInput
      )
    )
  ));
  drawer.appendChild(errBox);
  drawer.appendChild(el('div', { class: 'application-drawer-actions' },
    deleteBtn || el('button', { class: 'btn ghost', onclick: () => overlay.remove() }, 'Cancel'),
    saveBtn
  ));

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

async function renderMerchCoupons(container) {
  const r = await api('/api/portal/merch?action=list-coupons');
  const coupons = r.coupons || [];
  const setupRequired = !!r.setup_required;
  container.replaceChildren();

  const header = el('div', { class: 'row between', style: 'margin-bottom:12px' },
    el('div', { class: 'muted' }, 'Promo codes customers enter at checkout'),
    el('button', { class: 'btn primary',
      disabled: setupRequired ? '' : false,
      onclick: () => openMerchCouponModal(null, () => renderMerchCoupons(container))
    }, '+ Add Promo Code')
  );
  container.appendChild(header);

  if (setupRequired) {
    container.appendChild(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Merch tables not yet installed. Master Admin → Run Pending Migrations.')
    ));
    return;
  }
  if (!coupons.length) {
    container.appendChild(el('div', { class: 'panel', style: 'text-align:center;padding:48px 24px' },
      el('div', { style: 'font-size:42px;margin-bottom:8px' }, '🎟️'),
      el('h3', { style: 'margin:0 0 6px' }, 'No promo codes yet'),
      el('p', { class: 'muted', style: 'margin:0 0 16px' },
        'Create your first code to run a sale on your storefront.'),
      el('button', { class: 'btn primary',
        onclick: () => openMerchCouponModal(null, () => renderMerchCoupons(container))
      }, '+ Add Promo Code')
    ));
    return;
  }

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Code'), el('th', {}, 'Discount'), el('th', {}, 'Status'),
      el('th', {}, 'Used'), el('th', {}, 'Expires'), el('th', {}, '')
    )),
    el('tbody', {}, ...coupons.map(c => {
      const disc = c.discount_type === 'percent'
        ? `${c.discount_value}% off`
        : `$${(c.discount_value / 100).toFixed(2)} off`;
      const status = !c.is_active ? 'Disabled'
        : c.expires_at && new Date(c.expires_at).getTime() < Date.now() ? 'Expired'
        : c.max_uses && c.used_count >= c.max_uses ? 'Exhausted'
        : 'Active';
      const statusClass = status === 'Active' ? 'green' : '';
      return el('tr', {},
        el('td', { class: 'mono', style: 'font-weight:600' }, c.code),
        el('td', {}, disc),
        el('td', {}, el('span', { class: 'badge ' + statusClass }, status)),
        el('td', { class: 'muted' }, `${c.used_count || 0}${c.max_uses ? ' / ' + c.max_uses : ''}`),
        el('td', { class: 'muted' }, c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—'),
        el('td', {}, el('button', {
          class: 'btn sm ghost',
          onclick: () => openMerchCouponModal(c, () => renderMerchCoupons(container))
        }, 'Edit'))
      );
    }))
  );
  container.appendChild(el('div', { class: 'panel' }, table));
}

function openMerchCouponModal(coupon, onSaved) {
  const isEdit = !!coupon;
  const existing = document.querySelector('.application-drawer-overlay');
  if (existing) existing.remove();
  const overlay = el('div', { class: 'application-drawer-overlay' });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const drawer = el('div', { class: 'application-drawer' });

  const codeInput  = el('input', { type: 'text', value: coupon?.code || '', placeholder: 'SUMMER20',
    style: 'text-transform:uppercase' });
  const nameInput  = el('input', { type: 'text', value: coupon?.name || '', placeholder: 'Summer Sale 2026' });
  const typeSelect = el('select', { class: 'cta-select' },
    el('option', { value: 'percent', selected: (coupon?.discount_type !== 'fixed') ? '' : false }, 'Percent off'),
    el('option', { value: 'fixed',   selected: coupon?.discount_type === 'fixed' ? '' : false }, 'Fixed amount off')
  );
  const valueInput = el('input', { type: 'number', min: '0', step: '0.01',
    value: coupon ? (coupon.discount_type === 'fixed'
      ? (coupon.discount_value / 100).toFixed(2)
      : String(coupon.discount_value)) : '' });
  const minSubtotalInput = el('input', { type: 'number', min: '0', step: '0.01',
    value: coupon?.min_subtotal_cents != null ? (coupon.min_subtotal_cents / 100).toFixed(2) : '' });
  const expiresInput = el('input', { type: 'date',
    value: coupon?.expires_at ? new Date(coupon.expires_at).toISOString().slice(0, 10) : '' });
  const maxUsesInput = el('input', { type: 'number', min: '1', value: coupon?.max_uses ?? '' });
  const activeInput = el('input', { type: 'checkbox' });
  if (!coupon || coupon.is_active) activeInput.checked = true;

  const errBox = el('div');
  const saveBtn = el('button', { class: 'btn primary' }, isEdit ? 'Save changes' : 'Create promo');
  saveBtn.onclick = async () => {
    errBox.innerHTML = '';
    if (!isEdit && !codeInput.value.trim()) { errBox.innerHTML = '<div class="err">Code is required.</div>'; return; }
    if (!valueInput.value || +valueInput.value <= 0) {
      errBox.innerHTML = '<div class="err">Discount value must be greater than 0.</div>';
      return;
    }
    const discountType = typeSelect.value;
    const rawVal = parseFloat(valueInput.value);
    const discountValue = discountType === 'fixed' ? Math.round(rawVal * 100) : Math.round(rawVal);
    if (discountType === 'percent' && (discountValue < 1 || discountValue > 100)) {
      errBox.innerHTML = '<div class="err">Percent discounts must be between 1 and 100.</div>';
      return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    const body = {
      id: isEdit ? coupon.id : undefined,
      code: codeInput.value.trim().toUpperCase(),
      name: nameInput.value.trim() || null,
      discount_type: discountType,
      discount_value: discountValue,
      min_subtotal_cents: minSubtotalInput.value ? Math.round(parseFloat(minSubtotalInput.value) * 100) : null,
      expires_at: expiresInput.value ? new Date(expiresInput.value + 'T23:59:59').toISOString() : null,
      max_uses:   maxUsesInput.value ? parseInt(maxUsesInput.value, 10) : null,
      is_active:  activeInput.checked
    };
    try {
      await api('/api/portal/merch?action=upsert-coupon', { method: 'POST', body });
      toast(isEdit ? 'Promo code saved' : 'Promo code created');
      overlay.remove();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      errBox.innerHTML = `<div class="err">${e.message}</div>`;
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save changes' : 'Create promo';
    }
  };

  const deleteBtn = isEdit ? el('button', { class: 'btn ghost', style: 'color:#fca5a5' }, 'Delete') : null;
  if (deleteBtn) deleteBtn.onclick = async () => {
    if (!confirm(`Delete promo code "${coupon.code}"?`)) return;
    try {
      await api('/api/portal/merch?action=delete-coupon', { method: 'POST', body: { id: coupon.id } });
      toast('Promo code deleted');
      overlay.remove();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) { errBox.innerHTML = `<div class="err">${e.message}</div>`; }
  };

  drawer.appendChild(el('div', { class: 'application-drawer-header' },
    el('div', { style: 'flex:1' }, el('h2', {}, isEdit ? 'Edit promo code' : 'Add promo code')),
    el('button', { class: 'btn ghost sm', onclick: () => overlay.remove() }, '×')
  ));
  drawer.appendChild(el('div', { class: 'application-section' },
    el('div', { class: 'field' }, el('label', {}, 'Code (customer types this at checkout)'),
      isEdit ? el('input', { type: 'text', value: coupon.code, disabled: '', style: 'text-transform:uppercase' }) : codeInput),
    el('div', { class: 'field' }, el('label', {}, 'Internal name (optional)'), nameInput),
    el('div', { class: 'row', style: 'gap:12px' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Discount type'), typeSelect),
      el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Discount value'), valueInput)
    ),
    el('div', { class: 'muted', style: 'font-size:11px;margin:-6px 0 10px' },
      'Percent: 1–100. Fixed: dollar amount (e.g. 5.00 = $5 off).'),
    el('div', { class: 'row', style: 'gap:12px' },
      el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Minimum subtotal (optional)'), minSubtotalInput),
      el('div', { class: 'field', style: 'flex:1' }, el('label', {}, 'Max uses (optional)'), maxUsesInput)
    ),
    el('div', { class: 'field' }, el('label', {}, 'Expires (optional)'), expiresInput),
    el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin-top:8px' },
      activeInput, 'Active (accept this code at checkout)')
  ));
  drawer.appendChild(errBox);
  drawer.appendChild(el('div', { class: 'application-drawer-actions' },
    deleteBtn || el('button', { class: 'btn ghost', onclick: () => overlay.remove() }, 'Cancel'),
    saveBtn
  ));

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

// ─── Merch → Pickup sub-tab ───────────────────────────────────────
// Lets a tenant operator (Nate/Will/Kenny) set their pickup
// destination and instructions. Two outputs:
//   1. clients.pickup_location populates the Stripe Checkout shipping
//      option label: "Pick up at <location> (free)"
//   2. clients.pickup_instructions is appended to the order-received
//      SMS for any order whose customer picked the pickup rate, so
//      the buyer knows exactly when/where to collect.
// Plus a master enable toggle that hides the pickup option entirely
// for tenants without a physical location (pure-dropship sellers).
async function renderMerchPickup(container) {
  container.replaceChildren();
  const panel = el('div', { class: 'panel', style: 'max-width:640px' });

  panel.appendChild(el('h2', { style: 'margin:0 0 4px' }, 'Pickup'));
  panel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin:0 0 16px' },
    'Set where customers pick up their orders and any instructions they need. ' +
    'Appears as a free shipping option on the Stripe checkout page, and the instructions ' +
    'get appended to the order-received SMS we send when someone picks pickup.'));

  // Load current config + render form
  let cfg;
  try {
    cfg = await api('/api/portal/merch?action=pickup-config');
  } catch (e) {
    panel.appendChild(el('p', { class: 'err' }, 'Failed to load: ' + e.message));
    container.appendChild(panel);
    return;
  }
  if (cfg.setup_required) {
    panel.appendChild(el('div', {
      style: 'padding:12px;background:rgba(237,137,54,0.10);border:1px solid rgba(237,137,54,0.35);border-radius:6px;font-size:0.85rem;color:#fbd38d;margin-bottom:16px'
    }, 'One-time setup pending — ask Aaron to run Master Admin → Verify Migrations, then come back. You can fill in the form below now; it just won\'t save until the migration runs.'));
  }

  const enabledIn = el('input', { type: 'checkbox' });
  if (cfg.pickup_enabled) enabledIn.checked = true;
  const enabledLabel = el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:0.9rem;margin-bottom:14px' },
    enabledIn,
    el('span', {}, 'Offer in-person pickup at checkout'),
    el('span', { class: 'muted', style: 'font-size:0.7rem' }, '(unchecking hides pickup from the rate picker)')
  );

  const locIn = el('input', {
    type: 'text',
    value: cfg.pickup_location || '',
    placeholder: 'e.g. iSlay Studios, 1234 Main St, Springfield MO 65801'
  });
  locIn.style.cssText = 'width:100%;padding:10px 12px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.9rem;margin-top:4px';

  const insIn = el('textarea', {
    rows: '4',
    placeholder: 'e.g. Available M–F 9am–5pm. Text us when you arrive — we\'ll bring your order out.'
  });
  insIn.value = cfg.pickup_instructions || '';
  insIn.style.cssText = 'width:100%;padding:10px 12px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem;margin-top:4px;resize:vertical;min-height:80px';

  panel.appendChild(enabledLabel);

  panel.appendChild(el('label', { style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted,#888);font-weight:600' }, 'Pickup location'));
  panel.appendChild(el('div', { class: 'muted', style: 'font-size:0.7rem;margin:2px 0 4px' }, 'Shown on the Stripe checkout shipping picker AND in the customer\'s confirmation text.'));
  panel.appendChild(locIn);

  panel.appendChild(el('label', { style: 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted,#888);font-weight:600;display:block;margin-top:14px' }, 'Pickup instructions (optional)'));
  panel.appendChild(el('div', { class: 'muted', style: 'font-size:0.7rem;margin:2px 0 4px' }, 'Hours, door code, "text us when you arrive" — anything the customer needs to actually collect. Keep it short so the SMS stays one segment.'));
  panel.appendChild(insIn);

  // Live SMS preview so the operator sees exactly what the buyer
  // will get. Mirrors lib/transactional-sms.js sendOrderReceivedSms
  // pickup branch. Updates as they type.
  const previewBox = el('div', {
    style: 'margin-top:16px;padding:12px;background:rgba(99,179,237,0.06);border:1px dashed rgba(99,179,237,0.25);border-radius:6px;font-size:0.78rem;color:#cbd5e1;line-height:1.5;white-space:pre-wrap'
  });
  const previewLabel = el('div', { style: 'font-size:0.65rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted,#888);font-weight:600;margin-bottom:4px' },
    'Pickup SMS preview (with sample name "Sarah")');

  const renderPreview = () => {
    const tenant = state.client?.name || state.client?.business_name || 'the team';
    const loc = locIn.value.trim() ? ` at ${locIn.value.trim()}` : '';
    const ins = insIn.value.trim() ? ` ${insIn.value.trim()}` : ` We'll text you when it's ready.`;
    previewBox.textContent =
      `Hey Sarah, ${tenant} here — we got your order! Your order will be ready for pickup${loc}.${ins} Reply here with any questions. Reply STOP to opt out.`;
  };
  locIn.addEventListener('input', renderPreview);
  insIn.addEventListener('input', renderPreview);
  renderPreview();
  panel.appendChild(previewLabel);
  panel.appendChild(previewBox);

  const errBox = el('div', { style: 'margin-top:8px' });
  const saveBtn = el('button', { class: 'btn primary', style: 'margin-top:14px' }, 'Save pickup settings');
  saveBtn.onclick = async () => {
    errBox.innerHTML = '';
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await api('/api/portal/merch?action=set-pickup-config', {
        method: 'POST',
        body: {
          pickup_enabled:      enabledIn.checked,
          pickup_location:     locIn.value.trim() || null,
          pickup_instructions: insIn.value.trim() || null
        }
      });
      toast('Pickup settings saved');
    } catch (e) {
      const hint = e.message.includes('pending_migration')
        ? 'One-time setup needed — ask Aaron to run Master Admin → Verify Migrations, then try again.'
        : e.message;
      errBox.innerHTML = '<div class="err">' + hint + '</div>';
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save pickup settings';
    }
  };
  panel.appendChild(saveBtn);
  panel.appendChild(errBox);

  container.appendChild(panel);
}

async function renderMerchOrders(container) {
  // Auto-backfill: scan recent Stripe sessions for this tenant and
  // ingest any orders that didn't make it through the webhook (most
  // common cause is the Stripe webhook not subscribed to events on
  // connected accounts — until that's fixed, this is the safety net
  // so the operator never has to wonder where their orders are).
  // Only platform admins can run /api/admin so we fall back to a soft
  // skip for non-admins.
  // Auto-sync runs for every operator (not just admins) via the
  // tenant-scoped /api/portal/merch?action=sync-from-stripe endpoint.
  // The endpoint is locked to the caller's own tenant by auth — they
  // can't scan anyone else's account. The cron at /api/cron/sync-
  // stripe-orders does this same scan every 5 min in the background,
  // so even an operator who never opens the Merch tab still gets
  // their orders + push notification + order-received SMS within
  // minutes of the customer paying.
  let syncStatus = null;
  try {
    const sync = await api('/api/portal/merch?action=sync-from-stripe', { method: 'POST' });
    if ((sync.ingested || 0) > 0) {
      syncStatus = `Synced ${sync.ingested} new order${sync.ingested === 1 ? '' : 's'} from Stripe`;
    }
  } catch { /* non-fatal — empty state still rendered below */ }

  const r = await api('/api/portal/merch?action=list-orders');
  const orders = r.orders || [];
  container.replaceChildren();
  if (r.setup_required) {
    container.appendChild(el('div', { class: 'panel' },
      el('p', { class: 'muted' }, 'Merch tables not yet installed. Master Admin → Run Pending Migrations.')));
    return;
  }

  // Manual sync button — same logic as the auto-backfill above but
  // operator-triggered, so anyone (not just admins) can ask Stripe
  // for the latest. Shows a toast with how many orders were pulled.
  const syncBtn = el('button', { class: 'btn sm', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Syncing…';
    try {
      const sync = await api('/api/portal/merch?action=sync-from-stripe', { method: 'POST' });
      toast(`Stripe sync: ${sync.ingested || 0} new, ${sync.idempotent || 0} already present, ${sync.scanned || 0} scanned total`);
      renderMerchOrders(container);
    } catch (err) {
      toast('Sync failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = '🔄 Sync from Stripe';
    }
  } }, '🔄 Sync from Stripe');
  const syncBar = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px' },
    el('div', { class: 'muted', style: 'font-size:11px' },
      syncStatus
        ? `✓ ${syncStatus}`
        : 'Orders from your storefront sync automatically. Tap below if you suspect one is missing.'),
    syncBtn
  );
  container.appendChild(syncBar);

  if (!orders.length) {
    container.appendChild(el('div', { class: 'panel', style: 'text-align:center;padding:48px 24px' },
      el('div', { style: 'font-size:42px;margin-bottom:8px' }, '📦'),
      el('h3', { style: 'margin:0 0 6px' }, 'No orders yet'),
      el('p', { class: 'muted', style: 'margin:0' },
        'Completed checkouts from your storefront appear here in real time.')
    ));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'Customer'), el('th', {}, 'Total'),
      el('th', {}, 'Promo'), el('th', {}, 'Status'), el('th', {}, '')
    )),
    el('tbody', {}, ...orders.map(o => el('tr', {},
      el('td', { class: 'muted' }, new Date(o.created_at).toLocaleString()),
      el('td', {},
        el('div', { style: 'font-weight:500' }, o.customer_name || '—'),
        el('div', { class: 'muted', style: 'font-size:11px' }, o.customer_email || '')
      ),
      el('td', { style: 'font-weight:600' }, '$' + ((o.total_cents || 0) / 100).toFixed(2)),
      el('td', { class: 'mono' }, o.coupon_code || '—'),
      el('td', {}, el('span', { class: 'badge ' + (o.status === 'paid' ? 'green' : o.status === 'refunded' ? 'red' : '') }, o.status)),
      el('td', {}, el('button', {
        class: 'btn sm ghost',
        onclick: () => openMerchOrderDrawer(o.id, () => renderMerchOrders(container))
      }, 'View'))
    )))
  );
  container.appendChild(el('div', { class: 'panel' }, table));
}

async function openMerchOrderDrawer(orderId, onChange) {
  const r = await api('/api/portal/merch?action=order-detail&id=' + encodeURIComponent(orderId));
  const o = r.order;
  if (!o) return toast('Order not found', true);
  const items = r.items || [];

  const existing = document.querySelector('.application-drawer-overlay');
  if (existing) existing.remove();
  const overlay = el('div', { class: 'application-drawer-overlay' });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const drawer = el('div', { class: 'application-drawer' });

  const row = (label, value) =>
    value
      ? el('div', { class: 'application-field' },
          el('div', { class: 'application-field-label' }, label),
          el('div', { class: 'application-field-value' }, value)
        )
      : null;

  drawer.appendChild(el('div', { class: 'application-drawer-header' },
    el('div', { style: 'flex:1' },
      el('h2', {}, o.customer_name || 'Order'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' },
        new Date(o.created_at).toLocaleString())
    ),
    el('button', { class: 'btn ghost sm', onclick: () => overlay.remove() }, '×')
  ));

  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Customer'),
    el('div', { class: 'application-grid' },
      row('Name', o.customer_name),
      row('Email', o.customer_email),
      row('Phone', o.customer_phone)
    )
  ));

  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Shipping'),
    el('div', { class: 'application-grid' },
      row('Street', [o.shipping_address1, o.shipping_address2].filter(Boolean).join(', ')),
      row('City',   o.shipping_city),
      row('State',  o.shipping_state),
      row('ZIP',    o.shipping_zip),
      row('Country', o.shipping_country)
    )
  ));

  if (items.length) {
    drawer.appendChild(el('div', { class: 'application-section' },
      el('h3', {}, 'Items'),
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Product'), el('th', {}, 'Variant'),
          el('th', {}, 'Qty'),     el('th', {}, 'Price')
        )),
        el('tbody', {}, ...items.map(i => el('tr', {},
          el('td', {}, i.name || i.product_key),
          el('td', { class: 'muted' }, [i.color, i.size].filter(Boolean).join(' / ') || '—'),
          el('td', {}, String(i.quantity)),
          el('td', {}, '$' + ((i.price_cents || 0) / 100).toFixed(2))
        )))
      )
    ));
  }

  // Customer + tenant-side totals with the platform fee + Stripe
  // pass-through called out so the operator sees exactly where each
  // dollar went.
  const platformFee = (o.platform_fee_cents || 0) / 100;
  const stripeFee   = (o.stripe_fee_cents   || 0) / 100;
  const tenantTake  = ((o.subtotal_cents || 0) + (o.shipping_cents || 0) - (o.discount_cents || 0)) / 100;
  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'Totals'),
    el('div', { class: 'application-grid' },
      row('Subtotal', '$' + ((o.subtotal_cents || 0) / 100).toFixed(2)),
      row('Shipping', '$' + ((o.shipping_cents || 0) / 100).toFixed(2)),
      o.coupon_code ? row('Promo', `${o.coupon_code} (−$${((o.discount_cents || 0) / 100).toFixed(2)})`) : null,
      platformFee ? row('Platform fee (GoElev8)', '$' + platformFee.toFixed(2)) : null,
      stripeFee   ? row('Stripe processing',      '$' + stripeFee.toFixed(2))   : null,
      row('Customer paid', '$' + ((o.total_cents || 0) / 100).toFixed(2)),
      row('Tenant takehome', '$' + tenantTake.toFixed(2))
    )
  ));

  drawer.appendChild(el('div', { class: 'application-section' },
    el('h3', {}, 'References'),
    el('div', { class: 'application-grid' },
      row('Stripe payment', o.stripe_payment_id),
      row('Printify order', o.printify_order_id),
      row('Order number',   o.external_order_number),
      row('Status',         o.status)
    )
  ));

  const refundBtn = el('button', { class: 'btn ghost', style: 'color:#fca5a5' },
    o.status === 'refunded' ? 'Refunded' : 'Mark refunded');
  if (o.status === 'refunded') refundBtn.disabled = true;
  refundBtn.onclick = async () => {
    if (!confirm('Mark this order as refunded? (You still need to issue the refund in Stripe separately.)')) return;
    try {
      await api('/api/portal/merch?action=refund-order', { method: 'POST', body: { id: o.id } });
      toast('Order marked refunded');
      overlay.remove();
      if (typeof onChange === 'function') onChange();
    } catch (e) { toast(e.message, true); }
  };

  drawer.appendChild(el('div', { class: 'application-drawer-actions' },
    refundBtn,
    el('button', { class: 'btn primary', onclick: () => overlay.remove() }, 'Done')
  ));

  overlay.appendChild(drawer);
  document.body.appendChild(overlay);
}

// MMS attachment picker + uploader. Opens a native file picker, reads
// the image as a base64 data URL, POSTs it to /api/portal/messages
// ?action=upload-mms, and resolves with the resulting public URL. Used
// by every composer that supports image attachments (Inbox, Blasts,
// New Message modal). Rejects on cancel with `null` so callers can
// treat "user closed picker" as a no-op instead of an error.
//
// max_bytes: matches the server-side 10MB ceiling. We check client-side
// too so the operator gets a helpful message BEFORE the round-trip.
async function pickAndUploadMmsImage() {
  const MAX_BYTES = 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/gif,image/webp,image/heic';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) { resolve(null); return; }
      if (file.size > MAX_BYTES) {
        toast(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`, true);
        resolve(null); return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await api('/api/portal/messages?action=upload-mms', {
            method: 'POST',
            body: { data_url: reader.result, filename: file.name }
          });
          resolve({ url: r.url, name: file.name, size: file.size });
        } catch (e) {
          toast('Upload failed: ' + (e.message || 'unknown error'), true);
          reject(e);
        }
      };
      reader.onerror = () => { toast('Could not read image file.', true); resolve(null); };
      reader.readAsDataURL(file);
    };
    picker.click();
  });
}

// New Message composer — phone-style "start a new thread" modal.
// Takes any phone number + optional contact name + message body and
// POSTs to /api/portal/messages (which already accepts a raw `to`
// number, not just contact_id). On success, optionally saves the
// recipient as a new contact so the thread surfaces in the Inbox
// list on future renders.
function openNewMessageModal() {
  const existing = document.querySelector('.new-message-overlay');
  if (existing) existing.remove();

  const overlay = el('div', { class: 'new-message-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const card = el('div', { class: 'new-message-card' });

  const phoneInput = el('input', {
    type: 'tel', placeholder: '+1 555 123 4567', autocomplete: 'tel',
    style: 'width:100%'
  });
  const nameInput = el('input', {
    type: 'text', placeholder: '(optional) Save as new contact',
    autocomplete: 'name', style: 'width:100%'
  });
  const bodyInput = el('textarea', {
    placeholder: 'Type your message…', rows: 5,
    style: 'width:100%;resize:vertical;min-height:110px'
  });
  const segHint = el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' });
  bodyInput.addEventListener('input', () => {
    const len = bodyInput.value.length;
    const segments = len === 0 ? 0 : (len <= 160 ? 1 : Math.ceil(len / 153));
    segHint.textContent = len ? `${len} chars · ${segments} segment${segments === 1 ? '' : 's'}` : '';
  });

  // MMS attachment state — held on the modal itself so the send handler
  // can read the current URL. attachPreview shows a thumbnail + × chip.
  let attachedMediaUrl = null;
  const attachPreview = el('div', { style: 'margin-top:8px' });
  const drawAttachPreview = () => {
    attachPreview.innerHTML = '';
    if (!attachedMediaUrl) return;
    const chip = el('div', {
      style: 'display:inline-flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,255,255,0.08);border:1px solid rgba(0,255,255,0.28);border-radius:6px;font-size:0.78rem'
    },
      el('img', { src: attachedMediaUrl, style: 'width:32px;height:32px;object-fit:cover;border-radius:4px' }),
      el('span', { style: 'color:#00FFFF' }, '📎 Image attached · MMS (3 credits)'),
      el('button', {
        style: 'background:none;border:none;color:#fca5a5;font-size:1rem;cursor:pointer;padding:0 4px',
        title: 'Remove attachment',
        onclick: () => { attachedMediaUrl = null; drawAttachPreview(); }
      }, '×')
    );
    attachPreview.appendChild(chip);
  };
  const attachBtn = el('button', {
    class: 'btn ghost',
    style: 'font-size:0.78rem;padding:6px 10px',
    onclick: async () => {
      attachBtn.disabled = true; attachBtn.textContent = 'Uploading…';
      try {
        const r = await pickAndUploadMmsImage();
        if (r?.url) { attachedMediaUrl = r.url; drawAttachPreview(); }
      } catch {}
      attachBtn.disabled = false; attachBtn.textContent = '📎 Attach Image';
    }
  }, '📎 Attach Image');

  const errBox = el('div', { style: 'font-size:13px;min-height:18px;margin-top:8px' });
  const sendBtn = el('button', { class: 'btn primary' }, 'Send Message');

  sendBtn.onclick = async () => {
    errBox.innerHTML = '';
    const phone = phoneInput.value.trim();
    const text  = bodyInput.value.trim();
    if (!phone) { errBox.innerHTML = '<div class="err">Phone number is required.</div>'; phoneInput.focus(); return; }
    // MMS allows image-only messages (no body). SMS still requires text.
    if (!text && !attachedMediaUrl) {
      errBox.innerHTML = '<div class="err">Type a message or attach an image before sending.</div>'; bodyInput.focus(); return;
    }

    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      // Optionally create a contact first so the thread shows up
      // properly in the Inbox list. If creation fails (duplicate
      // phone, etc.) we still try to send — the message endpoint
      // accepts a raw `to` number directly.
      let contactId = null;
      if (nameInput.value.trim()) {
        try {
          const r = await api('/api/portal/crm?action=contacts', {
            method: 'POST',
            body: { name: nameInput.value.trim(), phone }
          });
          contactId = r?.contact?.id || null;
        } catch { /* non-fatal — fall through to direct send */ }
      }

      const sendBody = contactId
        ? { contact_id: contactId, body: text }
        : { to: phone, body: text };
      if (attachedMediaUrl) sendBody.media_url = attachedMediaUrl;
      const r = await api('/api/portal/messages', { method: 'POST', body: sendBody });
      toast(`Sent · balance ${r.balance ?? '—'} credits`);
      close();
      // Re-render the Messaging tab so the new thread + bumped credit
      // balance reflect immediately.
      render();
    } catch (e) {
      const msg = String(e.message || e);
      // Friendlier copy for the most common failure modes.
      if (/insufficient_credits/i.test(msg)) {
        errBox.innerHTML = '<div class="err">Not enough credits to send. Top up first.</div>';
      } else if (/no_twilio_number/i.test(msg)) {
        errBox.innerHTML = '<div class="err">No Twilio phone number on this tenant — set one in Settings before sending.</div>';
      } else if (/invalid_phone/i.test(msg)) {
        errBox.innerHTML = '<div class="err">That phone number couldn\'t be parsed. Use full digits including country code (e.g. +1 555 123 4567).</div>';
      } else {
        errBox.innerHTML = `<div class="err">${msg}</div>`;
      }
      sendBtn.disabled = false; sendBtn.textContent = 'Send Message';
    }
  };

  card.appendChild(el('div', { class: 'new-message-header' },
    el('h2', {}, '+ New Message'),
    el('button', { class: 'btn ghost sm', onclick: close, title: 'Close' }, '×')
  ));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'To (phone number)'), phoneInput));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Contact name'), nameInput));
  card.appendChild(el('div', { class: 'field' },
    el('label', {}, 'Message'),
    bodyInput,
    segHint,
    el('div', { style: 'margin-top:8px' }, attachBtn),
    attachPreview
  ));
  card.appendChild(errBox);
  card.appendChild(el('div', { class: 'new-message-actions' },
    el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
    sendBtn
  ));

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => phoneInput.focus(), 60);
}

async function viewMessages() {
  const wrap = el('div', { class: 'messages-tab' });
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Messages'),
    el('div', { style: 'display:flex;gap:8px' },
      el('button', {
        class: 'btn primary',
        onclick: () => openNewMessageModal()
      }, '+ New Message')
    )
  ));

  const layout = el('div', { class: 'chat-layout' });
  wrap.appendChild(layout);

  const list = el('div', { class: 'chat-list' });
  const pane = el('div', { class: 'chat-pane' });
  layout.appendChild(list);
  layout.appendChild(pane);

  // Start in thread-list view on mobile until the user picks a thread.
  // The .show-pane class flips to full-width chat view via CSS.
  if (state.activeThreadKey) layout.classList.add('show-pane');

  const [contactsR, msgsR, leadsR, bookingsR] = await Promise.all([
    api('/api/portal/crm?action=contacts'),
    api('/api/portal/messages'),
    api('/api/portal/leads?limit=500').catch(() => ({ leads: [] })),
    // Pull bookings so we can synthesize "Booking confirmed" events
    // into the thread for each customer. The booking widget at
    // book.theflexfacility.com sends its own confirmation SMS without
    // writing to public.messages, so without this synth the operator
    // sees no record of the SMS that went out.
    api('/api/portal/bookings/appointments?filter=all').catch(() => ({ appointments: [] }))
  ]);
  const contacts = contactsR.contacts || [];
  const allMsgs  = (msgsR.messages || []).slice();
  const leads    = leadsR.leads || [];
  const bookings = bookingsR.appointments || [];

  // Synthesize a booking event into the message stream so the thread
  // shows "📅 Booking confirmed" for any booking that has a phone match.
  // Tagged with synthetic=true so the renderer can style it differently
  // from real SMS rows.
  for (const b of bookings) {
    const phone = b.lead_phone || b.phone || null;
    if (!phone) continue;
    // Same calendar-tz formatting as the Bookings tab so the synthetic
    // booking event in the messages thread reads the same time the
    // operator sees on the Bookings list.
    const msgTz = state.bookingCalendar?.timezone || 'America/Chicago';
    const when = b.starts_at
      ? new Date(b.starts_at).toLocaleString(undefined, { timeZone: msgTz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : 'Pending time';
    const statusEmoji = b.status === 'confirmed' ? '✅'
      : b.status === 'cancelled' ? '❌'
      : b.status === 'no_show' ? '⚠️'
      : '📅';
    allMsgs.push({
      id: 'synth_booking_' + b.id,
      direction: 'event',
      to_number: phone,
      from_number: null,
      created_at: b.created_at || b.starts_at,
      body: `${statusEmoji} Booking ${b.status || 'made'}: ${b.service_name || 'session'} — ${when}`,
      status: b.status,
      synthetic: true,
      lead_id: b.lead_id || null
    });
  }

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
      // For synthetic event rows (e.g. booking events) the "other" phone
      // is just to_number — we don't have an inbound/outbound axis.
      const otherRaw = m.direction === 'inbound' ? m.from_number
                     : m.direction === 'event'   ? m.to_number
                     : m.to_number;
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
      // Synthesized booking events render as a centered system row so
      // the operator can tell them apart from real SMS bubbles.
      if (m.direction === 'event') {
        body.appendChild(el('div', { class: 'thread-event' },
          el('div', { class: 'thread-event-body' }, m.body),
          el('div', { class: 'thread-event-ts' }, ts)
        ));
        continue;
      }
      // Render an attached image (MMS) inline above the text body when
      // media_url is present. Click to open full-size in a new tab.
      // Falls back gracefully if the image fails to load (broken URL,
      // deleted Storage object) — the bubble still shows body text.
      const mediaBlock = m.media_url ? el('div', { class: 'bubble-media', style: 'margin-bottom:6px' },
        el('a', { href: m.media_url, target: '_blank', rel: 'noopener noreferrer' },
          el('img', {
            src: m.media_url,
            alt: 'MMS attachment',
            style: 'max-width:220px;max-height:260px;border-radius:8px;display:block;cursor:zoom-in;background:rgba(255,255,255,0.04)'
          })
        )
      ) : null;
      const bubble = el('div', { class: 'bubble ' + (m.direction === 'inbound' ? 'in' : 'out') },
        mediaBlock,
        m.body ? el('div', { class: 'bubble-body' }, m.body) : null,
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

    // MMS attachment state — one image per outbound message. Preview
    // row appears just above the composer row when populated; clicking
    // × clears the URL. Chip shows the MMS credit cost so the operator
    // sees the pricing bump before sending.
    let composerMediaUrl = null;
    const mediaPreviewRow = el('div', { class: 'composer-media-preview', style: 'padding:6px 12px' });
    const drawComposerPreview = () => {
      mediaPreviewRow.innerHTML = '';
      if (!composerMediaUrl) return;
      mediaPreviewRow.appendChild(el('div', {
        style: 'display:inline-flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(0,255,255,0.08);border:1px solid rgba(0,255,255,0.28);border-radius:6px;font-size:0.78rem'
      },
        el('img', { src: composerMediaUrl, style: 'width:32px;height:32px;object-fit:cover;border-radius:4px' }),
        el('span', { style: 'color:#00FFFF' }, '📎 Image attached · MMS (3 credits)'),
        el('button', {
          style: 'background:none;border:none;color:#fca5a5;font-size:1rem;cursor:pointer;padding:0 4px',
          title: 'Remove attachment',
          onclick: () => { composerMediaUrl = null; drawComposerPreview(); }
        }, '×')
      ));
    };
    const attachBtn = el('button', {
      class: 'btn ghost', title: 'Attach image (MMS)',
      onclick: async () => {
        attachBtn.disabled = true;
        try {
          const r = await pickAndUploadMmsImage();
          if (r?.url) { composerMediaUrl = r.url; drawComposerPreview(); }
        } catch {}
        attachBtn.disabled = false;
      }
    }, '📎');
    const composer = el('div', { class: 'composer' },
      suggestionsRow,
      mediaPreviewRow,
      el('div', { class: 'composer-row' },
        ta,
        attachBtn,
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
      // MMS allows an image-only send (no text). SMS still requires a
      // body.
      if (!text && !composerMediaUrl) return;
      try {
        const payload = active.contact?.id
          ? { contact_id: active.contact.id, body: text }
          : { to: active.phone, body: text };
        if (composerMediaUrl) payload.media_url = composerMediaUrl;
        await api('/api/portal/messages', { method: 'POST', body: payload });
        ta.value = '';
        composerMediaUrl = null;
        drawComposerPreview();
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
    const creditsLine = p.bonusCredits
      ? el('div', { class: 'pack-credits' },
          `${p.baseCredits.toLocaleString()} + `,
          el('span', { style: 'color:#86efac' }, `${p.bonusCredits.toLocaleString()} bonus`)
        )
      : el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`);
    packsRow.appendChild(el('div', { class: 'pack-card' + (p.badge ? ' featured' : '') },
      p.badge ? el('div', { class: 'pack-badge', style: 'font-size:0.65rem;color:#fbd38d;letter-spacing:0.06em;margin-bottom:2px' }, p.badge) : null,
      el('div', { class: 'pack-label' }, p.label),
      el('div', { class: 'pack-price' }, '$' + (p.priceCents / 100)),
      creditsLine,
      p.bonusCredits ? el('div', { class: 'muted', style: 'font-size:0.7rem' }, `${p.credits.toLocaleString()} total`) : null,
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
    ...Object.values(b.packs).map(p => el('option', { value: p.id, selected: p.id === b.auto_reload.pack }, `${p.label} ($${p.priceCents/100} / ${p.credits.toLocaleString()} credits${p.bonusCredits ? ' incl. ' + p.bonusCredits.toLocaleString() + ' bonus' : ''})`))
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
    panel.appendChild(el('p', {},
      'Link your existing Stripe account so customer payments land in your bank ' +
      'directly. GoElev8 takes a small platform fee on each transaction (handled ' +
      'automatically — you keep the rest). Clicking the button opens a Stripe ' +
      'login page where you sign in with your normal Stripe credentials.'
    ));
    const errInline = el('div', { style: 'margin-top:10px;font-size:13px;min-height:18px' });
    const startBtn = el('button', { class: 'btn', onclick: async () => {
      errInline.innerHTML = '';
      startBtn.disabled = true;
      const orig = startBtn.textContent;
      startBtn.textContent = 'Opening Stripe…';
      try {
        const r = await api('/api/portal/connect?action=start', { method: 'POST' });
        if (!r?.url) throw new Error('Stripe returned no authorize URL.');
        window.location.href = r.url;
      } catch (e) {
        errInline.innerHTML =
          `<div class="err">Stripe connect failed: ${e.message}</div>` +
          `<div class="muted" style="margin-top:4px;font-size:11px">If this keeps happening, check that STRIPE_CLIENT_ID + STRIPE_SECRET_KEY are set in Vercel and that Stripe Connect is enabled on the platform account.</div>`;
        startBtn.disabled = false;
        startBtn.textContent = orig;
      }
    }}, status.connected ? 'Continue connecting Stripe →' : 'Connect Stripe →');
    panel.appendChild(startBtn);
    panel.appendChild(errInline);
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

  // Color-coded status pill. Sending rows get a live progress bar so
  // the operator can see "35 / 200" instead of a frozen-looking row.
  const renderStatusCell = (b) => {
    const status = (b.status || 'pending').toLowerCase();
    const total = b.recipients ?? b.total_recipients ?? 0;
    const delivered = b.delivered ?? b.delivered_count ?? 0;
    const failed = b.failed ?? b.failed_count ?? 0;
    const done = delivered + failed;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    const colors = {
      sending:  { bg: 'rgba(99,179,237,0.15)',  fg: '#63b3ed' },
      sent:     { bg: 'rgba(72,187,120,0.15)',  fg: '#48bb78' },
      partial:  { bg: 'rgba(237,137,54,0.15)',  fg: '#ed8936' },
      failed:   { bg: 'rgba(245,101,101,0.15)', fg: '#f56565' },
      pending:  { bg: 'rgba(160,174,192,0.15)', fg: '#a0aec0' }
    };
    const c = colors[status] || colors.pending;
    const label = (b.status || 'pending');

    if (status === 'sending') {
      const bar = el('div', { style: 'width:100%;max-width:120px;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;margin-top:4px' });
      bar.appendChild(el('div', { style: `width:${pct}%;height:100%;background:#63b3ed;transition:width 0.3s` }));
      return el('td', {},
        el('span', { style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.72rem;font-weight:600;background:${c.bg};color:${c.fg}` }, label),
        el('div', { style: 'font-size:0.7rem;color:#a0aec0;margin-top:2px' }, `${done} / ${total} (${pct}%)`),
        bar
      );
    }
    return el('td', {},
      el('span', { style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.72rem;font-weight:600;background:${c.bg};color:${c.fg}` }, label)
    );
  };

  let refreshTimer = null;
  const renderBlasts = async () => {
    try {
      const data = await api('/api/portal/blasts');
      const blasts = data.blasts || [];
      tbody.innerHTML = '';
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
            el('td', {}, b.blast_name || b.name || '—'),
            el('td', {}, ((b.message_body || b.message) || '').slice(0, 60) + (((b.message_body || b.message) || '').length > 60 ? '…' : '')),
            el('td', {}, String(b.recipients ?? b.total_recipients ?? '—')),
            el('td', {}, String(b.delivered ?? b.delivered_count ?? '—')),
            el('td', {}, String(b.failed ?? b.failed_count ?? '—')),
            renderStatusCell(b)
          )))
        );
        tbody.appendChild(tbl);
      }
      // Auto-refresh while anything is mid-send so the operator can
      // watch the row tick up without leaving the page.
      const hasInFlight = blasts.some(b => (b.status || '').toLowerCase() === 'sending');
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (hasInFlight && document.body.contains(wrap)) {
        refreshTimer = setTimeout(renderBlasts, 3000);
      }
    } catch (e) {
      tbody.innerHTML = '';
      tbody.appendChild(el('p', { class: 'err' }, 'Failed to load blasts: ' + e.message));
    }
  };
  renderBlasts();
  return wrap;
}

async function loadBlastsContacts(container) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'muted' }, 'Loading contacts...'));
  let contacts;
  try {
    const r = await api('/api/portal/crm?action=contacts');
    contacts = r.contacts || [];
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'err' }, 'Failed to load contacts: ' + e.message));
    return;
  }
  container.innerHTML = '';
  if (!contacts.length) {
    container.appendChild(el('p', { class: 'muted' }, 'No contacts yet. Click "Import Contacts" to add from a file or spreadsheet.'));
    return;
  }

  // Filter state
  let searchQuery = '';
  let activeTab = 'all';        // 'all' | 'manual' | 'import' | 'tag:<name>'
  const selected = new Set();

  // Collect tag set for the filter chips (only tags actually in use).
  const tagCounts = new Map();
  for (const c of contacts) {
    for (const t of normalizeTags(c.tags)) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const popularTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);

  // Toolbar: search + bulk delete count
  const searchIn = el('input', {
    type: 'search',
    placeholder: 'Search name, phone, email…',
    style: 'flex:1;min-width:180px;padding:8px 12px;background:var(--bg-1,#0d1117);border:1px solid var(--border,#2a3a5c);border-radius:8px;color:var(--text,#e0e0e0);font-size:0.9rem'
  });
  searchIn.addEventListener('input', () => { searchQuery = searchIn.value.trim().toLowerCase(); render(); });

  const countLabel = el('span', { class: 'muted', style: 'font-size:0.8rem' });

  // Bulk tag — adds the picked tag to every selected contact in one
  // round-trip. Tag picker reuses the same popover the row chips use.
  const bulkTagBtn = el('button', { class: 'btn sm', style: 'display:none', onclick: () => {
    const ids = [...selected];
    if (!ids.length) return;
    openTagPicker({
      current: [],
      onAdd: async (tag) => {
        bulkTagBtn.disabled = true; bulkTagBtn.textContent = 'Tagging…';
        let ok = 0, failed = 0;
        // Fetch current contacts from the in-memory list, union the new
        // tag, PATCH each. PATCHes run in parallel (batched 8 at a time
        // so we don't blow up the function with 200 simultaneous calls).
        const batches = [];
        for (let i = 0; i < ids.length; i += 8) batches.push(ids.slice(i, i + 8));
        for (const batch of batches) {
          await Promise.all(batch.map(async (id) => {
            const c = contacts.find(x => x.id === id);
            const next = [...new Set([...normalizeTags(c?.tags), tag])];
            try {
              await api('/api/portal/crm?action=contacts', { method: 'PATCH', body: { id, tags: next } });
              if (c) c.tags = next;
              ok++;
            } catch { failed++; }
          }));
        }
        bulkTagBtn.disabled = false;
        toast(`Tagged ${ok} contact${ok === 1 ? '' : 's'} with "${tag}"` + (failed ? ` · ${failed} failed` : ''));
        // Re-render so the new tag chips show on every selected card,
        // and rebuild the tab row in case this tag wasn't visible before.
        for (const c of contacts) for (const t of normalizeTags(c.tags))
          tagCounts.set(t, (tagCounts.get(t) || 0) + 0); // ensure key
        loadBlastsContacts(container);
      }
    });
  } }, 'Tag Selected (0)');

  const bulkBtn = el('button', { class: 'btn sm danger', style: 'display:none', onclick: async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} contact${ids.length !== 1 ? 's' : ''}?`)) return;
    bulkBtn.disabled = true; bulkBtn.textContent = 'Deleting...';
    try {
      const r2 = await api('/api/portal/crm?action=contacts', { method: 'DELETE', body: { ids } });
      toast(`${r2.deleted || ids.length} contact${(r2.deleted || ids.length) !== 1 ? 's' : ''} deleted`);
      loadBlastsContacts(container);
    } catch (e) {
      toast('Delete failed: ' + e.message, true);
      bulkBtn.disabled = false; bulkBtn.textContent = `Delete Selected (${ids.length})`;
    }
  } }, 'Delete Selected (0)');

  const toolbar = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px' },
    searchIn, countLabel, bulkTagBtn, bulkBtn);
  container.appendChild(toolbar);

  // Tab/filter chip row — All · Manual · Imported · top tags as chips
  const tabRow = el('div', { class: 'contact-tabs' });
  container.appendChild(tabRow);

  const buildTabs = () => {
    tabRow.innerHTML = '';
    const mkTab = (id, label, count) => {
      const cls = 'contact-tab' + (activeTab === id ? ' active' : '');
      const btn = el('button', { class: cls, onclick: () => { activeTab = id; selected.clear(); render(); } },
        label,
        el('span', { class: 'contact-tab-count' }, '(' + count + ')')
      );
      return btn;
    };
    const allCount    = contacts.length;
    const manualCount = contacts.filter(c => (c.source || 'manual') !== 'import').length;
    const importCount = contacts.filter(c => c.source === 'import').length;
    tabRow.appendChild(mkTab('all', 'All', allCount));
    if (manualCount) tabRow.appendChild(mkTab('manual',  'Manual',   manualCount));
    if (importCount) tabRow.appendChild(mkTab('import',  'Imported', importCount));
    for (const t of popularTags) {
      tabRow.appendChild(mkTab('tag:' + t, t, tagCounts.get(t) || 0));
    }
  };

  // Card grid host
  const grid = el('div', { class: 'contact-card-grid' });
  container.appendChild(grid);

  // Predicate that applies the current tab + search
  const matches = (c) => {
    // Tab filter
    if (activeTab === 'manual' && c.source === 'import') return false;
    if (activeTab === 'import' && c.source !== 'import') return false;
    if (activeTab.startsWith('tag:')) {
      const tag = activeTab.slice(4);
      if (!normalizeTags(c.tags).includes(tag)) return false;
    }
    // Search filter
    if (searchQuery) {
      const hay = [c.name, c.phone, c.email].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  };

  function render() {
    buildTabs();
    const visible = contacts.filter(matches);
    const n = selected.size;
    countLabel.textContent = n
      ? `${n} selected · ${visible.length} of ${contacts.length} shown`
      : `${visible.length} of ${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;
    bulkBtn.style.display    = n ? '' : 'none';
    bulkTagBtn.style.display = n ? '' : 'none';
    bulkBtn.textContent      = `Delete Selected (${n})`;
    bulkTagBtn.textContent   = `Tag Selected (${n})`;

    grid.innerHTML = '';
    if (!visible.length) {
      grid.appendChild(el('p', { class: 'muted', style: 'padding:16px;text-align:center' },
        'No contacts match the current filter.'));
      return;
    }
    for (const c of visible) {
      grid.appendChild(renderContactCard(c));
    }
  }

  function renderContactCard(c) {
    const cb = el('input', { type: 'checkbox', class: 'contact-card-cb' });
    cb.checked = selected.has(c.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(c.id); else selected.delete(c.id);
      const n = selected.size;
      bulkBtn.style.display    = n ? '' : 'none';
      bulkTagBtn.style.display = n ? '' : 'none';
      bulkBtn.textContent      = `Delete Selected (${n})`;
      bulkTagBtn.textContent   = `Tag Selected (${n})`;
      countLabel.textContent = n
        ? `${n} selected · ${contacts.filter(matches).length} of ${contacts.length} shown`
        : `${contacts.filter(matches).length} of ${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;
      card.classList.toggle('selected', cb.checked);
    });

    let liveTags = normalizeTags(c.tags);
    const tagsHost = tagChips({
      getTags: () => liveTags,
      saveTags: async (next) => {
        await api('/api/portal/crm?action=contacts', {
          method: 'PATCH', body: { id: c.id, tags: next }
        });
        liveTags = next;
      }
    });

    const card = el('div', { class: 'contact-card' + (cb.checked ? ' selected' : '') },
      el('div', { class: 'contact-card-head' },
        cb,
        el('div', { class: 'contact-card-name' }, c.name || '—'),
        el('span', { class: 'badge' + (c.source === 'import' ? ' info' : '') }, c.source || 'manual')
      ),
      el('div', { class: 'contact-card-meta' },
        c.phone ? el('span', {}, '📱 ' + c.phone) : null,
        c.email ? el('span', {}, '✉️ ' + c.email) : null
      ),
      el('div', { class: 'contact-card-tags' }, tagsHost),
      el('div', { class: 'contact-card-actions' },
        el('button', { class: 'btn sm', onclick: () => {
          openContactEditModal(c, () => loadBlastsContacts(container));
        } }, 'Edit'),
        el('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm('Delete contact?')) return;
          try {
            await api('/api/portal/crm?action=contacts', { method: 'DELETE', body: { id: c.id } });
            toast('Contact deleted');
            loadBlastsContacts(container);
          } catch (e) { toast('Delete failed: ' + e.message, true); }
        } }, 'Delete')
      )
    );
    return card;
  }

  render();
}

function openContactEditModal(contact, onSaved) {
  const existing = document.querySelector('.contact-edit-modal-bg');
  if (existing) existing.remove();

  const nameIn  = el('input', { type: 'text',  placeholder: 'Full name' });
  nameIn.value  = contact.name || '';
  const phoneIn = el('input', { type: 'tel',   placeholder: '+1 555 555 1234' });
  phoneIn.value = contact.phone || '';
  const emailIn = el('input', { type: 'email', placeholder: 'name@example.com' });
  emailIn.value = contact.email || '';
  const tagsIn  = el('input', { type: 'text',  placeholder: 'comma-separated, e.g. vip, lead, returning' });
  tagsIn.value  = (contact.tags || []).join(', ');
  const notesIn = el('textarea', { rows: '3', placeholder: 'Notes (optional)' });
  notesIn.value = contact.notes || '';

  const errBox = el('div', { class: 'err', style: 'min-height:1.2em;font-size:0.85rem' });

  const field = (label, input) => el('div', { style: 'margin-bottom:10px' },
    el('label', { style: 'display:block;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted,#888);margin-bottom:4px' }, label),
    input
  );

  const saveBtn = el('button', { class: 'btn primary', onclick: async () => {
    const name = (nameIn.value || '').trim();
    const phone = (phoneIn.value || '').trim();
    if (!name || !phone) { errBox.textContent = 'Name and phone are required.'; return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const tags = tagsIn.value.split(',').map(t => t.trim()).filter(Boolean);
      const r = await api('/api/portal/crm?action=contacts', {
        method: 'PATCH',
        body: { id: contact.id, name, phone, email: emailIn.value.trim() || null, tags, notes: notesIn.value.trim() || null }
      });
      toast('Contact updated');
      bg.remove();
      if (onSaved) onSaved(r.contact);
    } catch (e) {
      errBox.textContent = 'Save failed: ' + e.message;
      saveBtn.disabled = false; saveBtn.textContent = 'Save';
    }
  } }, 'Save');

  const modal = el('div', { class: 'modal' },
    el('h2', {}, 'Edit Contact'),
    field('Name', nameIn),
    field('Phone', phoneIn),
    field('Email', emailIn),
    field('Tags', tagsIn),
    field('Notes', notesIn),
    errBox,
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn', onclick: () => bg.remove() }, 'Cancel'),
      saveBtn
    )
  );
  modal.style.maxWidth = '480px';

  const bg = el('div', { class: 'modal-bg contact-edit-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, modal);
  document.body.appendChild(bg);
  setTimeout(() => nameIn.focus(), 50);
}

function openContactImportModal(contactsBody) {
  const existing = document.querySelector('.import-modal-bg');
  if (existing) existing.remove();

  let step = 1;
  let parsedRows = [];
  let headers = [];
  let mappings = {};
  let hasHeaderRow = true;
  let delimiterOverride = ''; // '' = auto-detect; otherwise ',', '\t', ';', '|', ' '
  let lastInputText = '';
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
    phone: 'phone', mobile: 'phone', 'mobile number': 'phone', 'mobile phone': 'phone',
    cell: 'phone', 'cell phone': 'phone', cellphone: 'phone',
    telephone: 'phone', tel: 'phone', 'phone number': 'phone', phone_number: 'phone', phonenumber: 'phone', number: 'phone',
    first: 'first_name', 'first name': 'first_name', first_name: 'first_name', firstname: 'first_name', fname: 'first_name', 'f name': 'first_name', 'f. name': 'first_name', 'given name': 'first_name',
    last: 'last_name', 'last name': 'last_name', last_name: 'last_name', lastname: 'last_name', lname: 'last_name', 'l name': 'last_name', 'l. name': 'last_name', surname: 'last_name', 'family name': 'last_name',
    name: 'name', 'full name': 'name', fullname: 'name', full_name: 'name',
    'contact': 'name', 'contact name': 'name', contact_name: 'name',
    'client': 'name', 'client name': 'name', client_name: 'name',
    'customer': 'name', 'customer name': 'name', customer_name: 'name',
    'lead': 'name', 'lead name': 'name', lead_name: 'name',
    'display name': 'name', 'display_name': 'name',
    email: 'email', 'e-mail': 'email', email_address: 'email', 'email address': 'email', 'e mail': 'email',
    tag: 'tag', tags: 'tag', group: 'tag', category: 'tag', segment: 'tag',
    notes: 'notes', note: 'notes', comment: 'notes', comments: 'notes', description: 'notes'
  };

  function guessMapping(header) {
    return GUESS_MAP[header.toLowerCase().trim()] || 'skip';
  }

  // When all data ends up in one column (no recognizable delimiter, or
  // free-form rows like "John Smith 555-1234 john@x.com"), pull phone +
  // email out via regex and treat the leftover as the name.
  function autoSplitSingleColumn() {
    if (headers.length !== 1) return false;
    const col = headers[0];
    // Phone: allow optional wrapping parens around the whole match so we
    // consume "(555) 123-4567" without leaving the parens in the name.
    const PHONE_RE = /\(?\+?\d[\d\s().\-]{5,}\d\)?/;
    const EMAIL_RE = /[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+/;
    // Re-include the original header as a data row since it was eaten by Papa.
    const sourceRows = [col, ...parsedRows.map(r => r[col] || '')]
      .map(s => (s || '').toString())
      .filter(s => s.trim());
    const newRows = sourceRows.map(raw => {
      let s = raw;
      let email = '';
      const em = s.match(EMAIL_RE);
      if (em) { email = em[0]; s = s.replace(em[0], ' '); }
      let phone = '';
      const ph = s.match(PHONE_RE);
      if (ph) { phone = ph[0].replace(/[()]/g, '').trim(); s = s.replace(ph[0], ' '); }
      // Strip stray punctuation left behind by phone/email extraction.
      // Drops parens/brackets/commas/pipes/semicolons entirely, then nukes
      // standalone hyphens/dots/colons sitting between or around words.
      // Hyphens inside a word (Mary-Jane) are preserved because the
      // pattern requires whitespace or string boundaries on both sides.
      const name = s
        .replace(/[(){}\[\]<>,;|]/g, ' ')
        .replace(/(^|\s)[\-.:]+(?=\s|$)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      return { name, phone, email };
    }).filter(r => r.phone || r.email);
    if (!newRows.length) return false;
    headers = ['name', 'phone', 'email'];
    parsedRows = newRows;
    mappings = { name: 'name', phone: 'phone', email: 'email' };
    return true;
  }

  function parseInput(text) {
    lastInputText = text;
    const config = { skipEmptyLines: true, dynamicTyping: false };
    if (delimiterOverride) config.delimiter = delimiterOverride;
    if (hasHeaderRow) {
      config.header = true;
      const result = Papa.parse(text.trim(), config);
      headers = result.meta.fields || [];
      parsedRows = result.data || [];
    } else {
      const result = Papa.parse(text.trim(), config);
      const rows = result.data || [];
      const maxCols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
      headers = Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);
      parsedRows = rows.map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (row[i] || '').toString(); });
        return obj;
      });
    }
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
    if (lastInputText) pasteArea.value = lastInputText;
    const statusMsg = el('div', { style: 'margin-top:8px;font-size:0.8rem;color:var(--muted,#888)' });

    const headerCb = el('input', { type: 'checkbox', id: 'imp-header-cb' });
    headerCb.checked = hasHeaderRow;
    headerCb.addEventListener('change', () => { hasHeaderRow = headerCb.checked; });

    const delimSel = el('select', { id: 'imp-delim-sel', style: 'padding:4px 8px;background:var(--bg-1,#0d1117);border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.8rem' },
      el('option', { value: '' }, 'Auto-detect'),
      el('option', { value: ',' }, 'Comma (,)'),
      el('option', { value: '\t' }, 'Tab'),
      el('option', { value: ';' }, 'Semicolon (;)'),
      el('option', { value: '|' }, 'Pipe (|)'),
      el('option', { value: ' ' }, 'Space')
    );
    delimSel.value = delimiterOverride;
    delimSel.addEventListener('change', () => { delimiterOverride = delimSel.value; });

    const parseOptions = el('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:0.8rem;color:var(--muted,#888)' },
      el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer' },
        headerCb, 'First row is a header'
      ),
      el('label', { style: 'display:flex;align-items:center;gap:6px' },
        'Delimiter:', delimSel
      )
    );

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

    content.append(dropzone, pasteArea, pasteBtn, parseOptions, statusMsg);
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

    const oneColumnHint = headers.length === 1
      ? el('div', { style: 'background:rgba(240,173,78,0.08);border:1px solid rgba(240,173,78,0.4);border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:0.82rem' },
          el('div', { style: 'color:var(--warning,#f0ad4e);font-weight:600;margin-bottom:4px' }, 'Only 1 column detected'),
          el('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Your data has multiple fields packed into a single column. Auto-extract phone, email, and name from each row, or go Back and pick a different delimiter.'),
          el('button', { class: 'btn sm', onclick: () => {
            if (autoSplitSingleColumn()) renderCurrentStep();
            else mappingErr.textContent = 'Could not auto-extract — no phone or email patterns found in the rows.';
          } }, 'Auto-split phone + email + name')
        )
      : null;

    content.append(
      el('p', { style: 'font-size:0.85rem;margin-bottom:12px;color:var(--muted,#888)' }, 'Map each file column to a contact field. Phone is required.'),
      ...(oneColumnHint ? [oneColumnHint] : []),
      tbl, mappingErr
    );

    footer.append(
      el('button', { class: 'btn', onclick: () => { step = 1; renderCurrentStep(); } }, 'Back'),
      el('button', { class: 'btn primary', onclick: () => {
        const vals = Object.values(mappings);
        if (!vals.includes('phone')) {
          mappingErr.textContent = 'You must map at least one column to Phone.';
          mappingErr.style.color = 'var(--danger,#e74c3c)';
          return;
        }
        const hasName = vals.includes('name') || vals.includes('first_name') || vals.includes('last_name');
        if (!hasName && !mappingErr.dataset.nameWarned) {
          mappingErr.textContent = 'No name column mapped — contacts will import as "Unknown". Click Next again to continue anyway.';
          mappingErr.style.color = 'var(--warning,#f0ad4e)';
          mappingErr.dataset.nameWarned = '1';
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
        const dupCount = res.skipped_duplicates || 0;
        const created = res.created || 0;
        const failed = errCount > 0;
        resultMsg.style.color = failed ? 'var(--danger,#e74c3c)' : (created === 0 ? 'var(--warning,#f0ad4e)' : 'var(--success,#27ae60)');
        let msg = `Done! ${created} contacts imported.`;
        if (dupCount) msg += ` ${dupCount} duplicate phone(s) skipped.`;
        if (failed) msg += ` Errors: ${(res.errors || []).map(e => e.message).join('; ')}`;
        resultMsg.textContent = msg;
        toast(failed ? `Import error: ${(res.errors[0] || {}).message || 'unknown'}` : `${created} contacts imported!`, failed);
        if (contactsBody) loadBlastsContacts(contactsBody);
        if (!failed) setTimeout(() => bg.remove(), 1500);
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

function previewMergeTags(template, vars) {
  if (!template) return '';
  const norm = {};
  for (const k of Object.keys(vars || {})) norm[k.toLowerCase().trim().replace(/\s+/g, '_')] = vars[k];
  const sub = (m, k) => {
    const key = String(k).toLowerCase().trim().replace(/\s+/g, '_');
    const v = norm[key];
    return v !== undefined && v !== null && v !== '' ? String(v) : m;
  };
  return String(template)
    .replace(/\[\s*([a-zA-Z][a-zA-Z0-9_ ]{0,30}?)\s*\]/g, sub)
    .replace(/\{\{?\s*([a-zA-Z][a-zA-Z0-9_ ]{0,30}?)\s*\}\}?/g, sub);
}

function openBlastModal(wrap) {
  const existing = document.querySelector('.blast-modal-bg');
  if (existing) existing.remove();

  const nameIn = el('input', { type: 'text', placeholder: 'e.g. Spring Promo' });
  // Tag the textarea so the catch-all input style at the bottom of
  // openBlastModal skips it. That bulk style applies cssText (full
  // overwrite) which would otherwise wipe out the height/min-height
  // we need to keep the message box editable on long messages.
  const msgIn = el('textarea', {
    rows: '6',
    placeholder: 'Hey [first name], it’s {business_name}...',
    'data-blast-msg': '1',
    style: 'min-height:140px;height:140px;max-height:240px;resize:vertical;'
  });
  const promoIn = el('input', { type: 'text', placeholder: 'e.g. SPRING25 (optional)' });
  const segSel = el('select', {},
    el('option', { value: 'contacts' }, 'All Contacts (imported + funnel)'),
    el('option', { value: 'imported' }, 'Imported Contacts Only'),
    el('option', { value: 'all' }, 'Funnel Leads'),
    el('option', { value: 'first_timers' }, 'First Timers'),
    el('option', { value: 'returning' }, 'Returning'),
    el('option', { value: 'no_shows' }, 'No Shows')
  );
  const result = el('div', {});

  // MMS attachment state for this blast. Flat 3 credits per recipient
  // when set (matches the server-side MMS_CREDIT_COST). The segment
  // counter switches to flat-rate math when populated so operators see
  // "1,000 contacts × $0.12 = $120" instead of segmented SMS math.
  const MMS_CREDITS_PER_RECIPIENT = 3;
  let blastMediaUrl = null;
  const blastMediaPreview = el('div', { style: 'margin-top:8px;min-height:0' });
  const drawBlastMediaPreview = () => {
    blastMediaPreview.innerHTML = '';
    if (!blastMediaUrl) return;
    blastMediaPreview.appendChild(el('div', {
      style: 'display:inline-flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,255,255,0.08);border:1px solid rgba(0,255,255,0.28);border-radius:6px;font-size:0.78rem'
    },
      el('img', { src: blastMediaUrl, style: 'width:44px;height:44px;object-fit:cover;border-radius:6px' }),
      el('div', {},
        el('div', { style: 'color:#00FFFF;font-weight:600' }, '📎 MMS Image Attached'),
        el('div', { style: 'color:#a0aec0;font-size:0.72rem;margin-top:2px' },
          `Ships as MMS · flat ${MMS_CREDITS_PER_RECIPIENT} credits per recipient (image + up to 5000 chars)`)
      ),
      el('button', {
        style: 'margin-left:auto;background:none;border:none;color:#fca5a5;font-size:1.1rem;cursor:pointer;padding:0 6px',
        title: 'Remove image',
        onclick: () => { blastMediaUrl = null; drawBlastMediaPreview(); updatePreview(); }
      }, '×')
    ));
  };
  const attachImgBtn = el('button', {
    type: 'button', class: 'btn ghost', style: 'font-size:0.78rem;padding:6px 12px;margin-top:6px',
    onclick: async () => {
      attachImgBtn.disabled = true; attachImgBtn.textContent = 'Uploading…';
      try {
        const r = await pickAndUploadMmsImage();
        if (r?.url) { blastMediaUrl = r.url; drawBlastMediaPreview(); updatePreview(); }
      } catch {}
      attachImgBtn.disabled = false; attachImgBtn.textContent = '📎 Attach Image (MMS)';
    }
  }, '📎 Attach Image (MMS)');

  // Personalization helpers — shown right under the message textarea so
  // non-technical clients can click to insert a placeholder and see the
  // preview update with sample contact data.
  const sampleBusinessName = state.client?.business_name || state.client?.name || 'Your Business';
  const previewBox = el('div', { style: 'font-size:0.8rem;padding:10px 12px;background:rgba(255,255,255,0.04);border:1px dashed rgba(255,255,255,0.15);border-radius:6px;margin-top:6px;white-space:pre-wrap;line-height:1.4' });
  const previewLabel = el('div', { style: 'font-size:0.65rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted,#888);margin-bottom:4px;font-weight:600' }, 'Preview (with sample contact "Sarah Johnson")');
  const previewText = el('div', { style: 'color:var(--text,#e0e0e0)' });
  previewBox.append(previewLabel, previewText);

  // SMS segment counter — lives directly below the message textarea
  // so it's the first thing the operator sees as they type.
  // Char count vs current segment ceiling ("265 / 306 chars"),
  // segment count ("2 segments"), per-message cost ("$0.04 per
  // message"), total estimated ("500 contacts × $0.04 = $20.00").
  // Color tiers: 1 seg green / 2 yellow / 3 orange / 4+ red.
  // Recipient count is fetched live from /api/portal/blasts?action=
  // count-recipients on every segment / tag change. Informational
  // only — sending is never blocked.
  const SMS_RATE_CENTS_PER_SEG = Number.isFinite(+window.GE8_SMS_RATE_CENTS)
    ? +window.GE8_SMS_RATE_CENTS : 4;
  function ceilingForSegments(segs) {
    if (segs <= 1) return 160;
    return 160 + 146 + 153 * (segs - 2);
  }
  function segmentsFromLen(len) {
    if (len <= 0)   return 0;
    if (len <= 160) return 1;
    if (len <= 306) return 2;
    if (len <= 459) return 3;
    if (len <= 612) return 4;
    return 4 + Math.ceil((len - 612) / 153);
  }
  function colorForSegments(segs) {
    if (segs <= 1)  return '#86efac';
    if (segs === 2) return '#fde68a';
    if (segs === 3) return '#fdba74';
    return '#f87171';
  }

  const segCounter = el('div', {
    style:
      'display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;' +
      'padding:10px 12px;margin-top:6px;border-radius:6px;' +
      'background:#000;border:1px solid rgba(0,255,255,0.18);' +
      'font-size:0.78rem;line-height:1.35;font-family:Inter,system-ui,sans-serif'
  });
  const segChars = el('strong', { style: 'color:#86efac;letter-spacing:0.01em' }, '0 / 160 chars');
  const segCount = el('span',   { style: 'color:var(--muted,#888)' }, '1 segment');
  const segPer   = el('span',   { style: 'color:var(--muted,#888)' }, '$0.04 per message');
  const segTotal = el('span',   { style: 'color:#00FFFF;font-weight:600;margin-left:auto' }, '—');
  segCounter.append(segChars, segCount, segPer, segTotal);

  let recipientCount = null;
  function setRecipientCount(n) {
    recipientCount = (typeof n === 'number' && n >= 0) ? n : null;
    updateSegCounter();
  }

  function updateSegCounter() {
    let body = msgIn.value || '';
    if (promoIn && promoIn.value.trim()) body += '\n\nUse code: ' + promoIn.value.trim();
    if (body.trim() && !OPT_OUT_RE.test(body)) body += '\n\nReply STOP to opt out.';
    const len  = body.length;

    // MMS branch: flat 3 credits per recipient (matches server-side
    // MMS_CREDIT_COST). Body-length math is irrelevant — Twilio bills
    // MMS as a single message up to 5000 chars.
    if (blastMediaUrl) {
      segChars.textContent = len + ' chars · MMS';
      segChars.style.color = '#00FFFF';
      segCount.textContent = 'MMS (image + text)';
      const perMsgCents = MMS_CREDITS_PER_RECIPIENT * SMS_RATE_CENTS_PER_SEG;
      const perMsgUsd   = (perMsgCents / 100).toFixed(2);
      segPer.textContent = '$' + perMsgUsd + ' per message';
      if (recipientCount == null) {
        segTotal.textContent = 'Counting contacts…';
        segTotal.style.color = 'var(--muted,#888)';
      } else if (recipientCount === 0) {
        segTotal.textContent = '0 contacts';
        segTotal.style.color = 'var(--muted,#888)';
      } else {
        const totalCents = recipientCount * perMsgCents;
        const totalUsd   = (totalCents / 100).toFixed(2);
        segTotal.textContent = recipientCount.toLocaleString() + ' contacts × $' + perMsgUsd + ' = $' + totalUsd;
        segTotal.style.color = '#00FFFF';
      }
      return;
    }

    // SMS branch: per-segment math.
    const segs = Math.max(1, segmentsFromLen(len));
    const ceil = ceilingForSegments(segs);
    const color = colorForSegments(segs);
    segChars.textContent = len + ' / ' + ceil + ' chars';
    segChars.style.color = color;
    segCount.textContent = segs === 1 ? '1 segment' : (segs + ' segments');
    const perMsgCents = segs * SMS_RATE_CENTS_PER_SEG;
    const perMsgUsd   = (perMsgCents / 100).toFixed(2);
    segPer.textContent = '$' + perMsgUsd + ' per message';
    if (recipientCount == null) {
      segTotal.textContent = 'Counting contacts…';
      segTotal.style.color = 'var(--muted,#888)';
    } else if (recipientCount === 0) {
      segTotal.textContent = '0 contacts';
      segTotal.style.color = 'var(--muted,#888)';
    } else {
      const totalCents = recipientCount * perMsgCents;
      const totalUsd   = (totalCents / 100).toFixed(2);
      segTotal.textContent = recipientCount.toLocaleString() + ' contacts × $' + perMsgUsd + ' = $' + totalUsd;
      segTotal.style.color = '#00FFFF';
    }
  }

  // Carrier policy + TCPA require every blast to carry an opt-out
  // instruction. We mirror the server's regex here so the preview
  // shows the operator exactly what will be sent — they see the
  // "Reply STOP to opt out." line auto-appear when they haven't added
  // one of their own. If their message already includes STOP /
  // UNSUBSCRIBE / etc., we leave it alone.
  const OPT_OUT_RE = /\b(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|OPT[\s-]?OUT)\b/i;
  const updatePreview = () => {
    const sample = { first_name: 'Sarah', name: 'Sarah Johnson', last_name: 'Johnson', business_name: sampleBusinessName, phone: '+15555550123', email: 'sarah@example.com' };
    const body = msgIn.value.trim();
    if (!body) {
      previewText.textContent = '(start typing your message…)';
      previewText.style.fontStyle = 'italic';
      previewText.style.color = 'var(--muted,#888)';
      updateSegCounter();
      return;
    }
    let rendered = previewMergeTags(body, sample);
    if (promoIn.value.trim()) rendered += '\n\nUse code: ' + promoIn.value.trim();
    if (!OPT_OUT_RE.test(rendered)) rendered += '\n\nReply STOP to opt out.';
    previewText.textContent = rendered;
    previewText.style.fontStyle = '';
    previewText.style.color = '';
    updateSegCounter();
  };
  const insertAtCursor = (token) => {
    const start = msgIn.selectionStart != null ? msgIn.selectionStart : msgIn.value.length;
    const end   = msgIn.selectionEnd   != null ? msgIn.selectionEnd   : msgIn.value.length;
    msgIn.value = msgIn.value.slice(0, start) + token + msgIn.value.slice(end);
    const pos = start + token.length;
    msgIn.focus();
    msgIn.setSelectionRange(pos, pos);
    updatePreview();
  };

  const chip = (label, token) => el('button', { type: 'button', style: 'padding:4px 10px;background:rgba(99,179,237,0.12);border:1px solid rgba(99,179,237,0.4);color:#9fcdf5;border-radius:14px;font-size:0.75rem;cursor:pointer;font-family:inherit', onclick: () => insertAtCursor(token) }, label);
  const chipsRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px' },
    el('span', { style: 'font-size:0.75rem;color:var(--muted,#888);align-self:center;margin-right:4px' }, 'Insert:'),
    chip('First Name', '[first name]'),
    chip('Full Name', '[name]'),
    chip('Business Name', '[business name]')
  );

  msgIn.addEventListener('input', () => { updatePreview(); updateComplianceNote(); });
  promoIn.addEventListener('input', updatePreview);
  // Tag-based recipient filters. Layered on top of the segment dropdown:
  //   - Include tags = recipient must have at least one of these
  //   - Exclude tags = recipient is dropped if they have any of these
  // Common workflow: send to All Contacts but exclude "Do Not Contact" and
  // "Current Client" so paying clients don't get re-marketing pings.
  let includeTags = [];
  let excludeTags = [];
  const includeChipsHost = el('div', { class: 'tag-chips' });
  const excludeChipsHost = el('div', { class: 'tag-chips' });
  const drawIncludeChips = () => {
    includeChipsHost.innerHTML = '';
    for (const t of includeTags) {
      includeChipsHost.appendChild(el('span', { class: 'tag-chip' }, t,
        el('button', { class: 'tag-chip-x', onclick: () => {
          includeTags = includeTags.filter(x => x !== t); drawIncludeChips();
        } }, '×')
      ));
    }
    includeChipsHost.appendChild(el('button', { class: 'tag-chip-add', onclick: () => {
      openTagPicker({ current: includeTags, onAdd: (t) => { includeTags = [...new Set([...includeTags, t])]; drawIncludeChips(); } });
    } }, '+'));
  };
  const drawExcludeChips = () => {
    excludeChipsHost.innerHTML = '';
    for (const t of excludeTags) {
      excludeChipsHost.appendChild(el('span', { class: 'tag-chip', style: 'background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.35);color:#fca5a5' }, t,
        el('button', { class: 'tag-chip-x', onclick: () => {
          excludeTags = excludeTags.filter(x => x !== t); drawExcludeChips();
        } }, '×')
      ));
    }
    excludeChipsHost.appendChild(el('button', { class: 'tag-chip-add', onclick: () => {
      openTagPicker({ current: excludeTags, onAdd: (t) => { excludeTags = [...new Set([...excludeTags, t])]; drawExcludeChips(); } });
    } }, '+'));
  };
  drawIncludeChips();
  drawExcludeChips();

  // ── Recipient count fetch ─────────────────────────────────────────
  // Polled from /api/portal/blasts?action=count-recipients whenever
  // the segment dropdown or tag filters change. Debounced so a quick
  // sequence of clicks doesn't fire a request per click. The chip
  // drawer functions (drawIncludeChips / drawExcludeChips) are const
  // arrow functions — instead of monkey-patching them, the segment
  // counter's auto-refresh hook re-runs whenever the chips host
  // mutates (MutationObserver), which catches both adds and removes
  // without coupling to the existing onclick handlers.
  let countAbort = null;
  let countTimer = null;
  function refreshRecipientCount() {
    if (countTimer) clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
      try {
        if (countAbort) countAbort.abort();
        countAbort = new AbortController();
        const params = new URLSearchParams({
          action:  'count-recipients',
          segment: segSel.value || 'contacts'
        });
        if (includeTags.length) params.set('includeTags', includeTags.join(','));
        if (excludeTags.length) params.set('excludeTags', excludeTags.join(','));
        const headers = {};
        if (state.token) headers.authorization = 'Bearer ' + state.token;
        if (state.isAdmin && state.impersonating) headers['x-admin-as-client'] = state.impersonating;
        const r = await fetch('/api/portal/blasts?' + params.toString(), {
          headers, signal: countAbort.signal
        });
        if (!r.ok) { setRecipientCount(null); return; }
        const data = await r.json().catch(() => ({}));
        setRecipientCount(typeof data.count === 'number' ? data.count : null);
      } catch (e) {
        if (e.name !== 'AbortError') setRecipientCount(null);
      }
    }, 180);
  }
  // Fires whenever a tag chip is added or removed via the picker.
  // MutationObserver watches child changes on either chip host so we
  // don't need to monkey-patch the existing const drawers.
  const tagObserver = new MutationObserver(() => refreshRecipientCount());
  tagObserver.observe(includeChipsHost, { childList: true });
  tagObserver.observe(excludeChipsHost, { childList: true });
  // Segment dropdown change → recount (covers leads vs contacts swap).
  segSel.addEventListener('change', refreshRecipientCount);
  // Initial fetch on modal open.
  refreshRecipientCount();

  // Tracks the in-flight POST so a re-click can't fire a second one.
  // The button is also disabled, but this is belt-and-braces in case
  // a browser quirk re-enables it before the request settles.
  let inFlight = false;
  const sendBtn = el('button', { class: 'btn primary', onclick: async () => {
    if (inFlight) return;
    // MMS blasts may ship image-only (no body). Name always required;
    // message required unless an image is attached.
    if (!nameIn.value.trim()) { toast('Blast name is required', true); return; }
    if (!msgIn.value.trim() && !blastMediaUrl) { toast('Message body or an attached image is required', true); return; }
    inFlight = true;
    sendBtn.disabled = true; sendBtn.textContent = 'Sending...';

    // Live progress overlay — sits on top of the modal body so the
    // operator sees movement immediately and never feels the urge to
    // click Send a second time. Polls GET /api/portal/blasts every 2s
    // to find this run by name and surface delivered/failed counts.
    const progressTitle = el('div', { style: 'font-size:1.05rem;font-weight:600;color:#fff;text-align:center' }, 'Sending blast…');
    const progressSub   = el('div', { style: 'font-size:0.8rem;color:#a0aec0;text-align:center' }, 'Preparing recipients…');
    const progressBarBg = el('div', { style: 'width:100%;max-width:320px;height:10px;background:rgba(255,255,255,0.08);border-radius:5px;overflow:hidden' });
    const progressBarFill = el('div', { style: 'width:0%;height:100%;background:linear-gradient(90deg,#63b3ed,#4299e1);transition:width 0.3s' });
    progressBarBg.appendChild(progressBarFill);
    const progressNote = el('div', { style: 'font-size:0.7rem;color:#718096;text-align:center;max-width:320px;line-height:1.4' }, 'Don\'t close this window. Numbers texted in the last hour are skipped automatically.');
    const progressOverlay = el('div', {
      style: 'position:absolute;inset:0;background:rgba(13,17,23,0.96);' +
             'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
             'gap:14px;padding:32px;border-radius:12px;z-index:20;'
    }, progressTitle, progressBarBg, progressSub, progressNote);
    modal.style.position = 'relative';
    modal.appendChild(progressOverlay);

    const blastNameForPoll = nameIn.value.trim();
    let pollTimer = null;
    let stopped = false;
    const pollProgress = async () => {
      if (stopped) return;
      try {
        const d = await api('/api/portal/blasts');
        const row = (d.blasts || []).find(b => b.blast_name === blastNameForPoll);
        if (row) {
          const total = row.total_recipients || 0;
          const done = (row.delivered_count || 0) + (row.failed_count || 0);
          const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          progressBarFill.style.width = pct + '%';
          progressSub.textContent = total > 0
            ? `${done} of ${total} sent (${pct}%)`
            : 'Queuing messages…';
        }
      } catch {}
      if (!stopped) pollTimer = setTimeout(pollProgress, 2000);
    };
    pollTimer = setTimeout(pollProgress, 600);

    try {
      const body = {
        name: blastNameForPoll,
        message: msgIn.value.trim(),
        segment: segSel.value,
        includeTags,
        excludeTags
      };
      if (promoIn.value.trim()) body.promoCode = promoIn.value.trim();
      if (blastMediaUrl) body.media_url = blastMediaUrl;
      const data = await api('/api/portal/blasts', { method: 'POST', body });
      stopped = true; if (pollTimer) clearTimeout(pollTimer);

      // Snap the bar to 100% for the brief instant before we close.
      progressBarFill.style.width = '100%';

      if (data.duplicate) {
        toast(`This blast was already sent in the last 5 minutes — not re-sent. ${data.sent || 0} were delivered.`, true, 6000);
      } else if (data.throttled) {
        toast(`Nothing sent. ${data.skipped_recent || 0} recipient(s) were texted within the last hour and were skipped.`, true, 6000);
      } else {
        const parts = [`${data.sent || 0} delivered`];
        if (data.failed) parts.push(`${data.failed} failed`);
        if (data.skipped_recent) parts.push(`${data.skipped_recent} skipped (texted within last hour)`);
        const optNote = data.opt_out_appended ? ' · "Reply STOP" auto-added' : '';
        // Surface segment-aware billing when the message cost more
        // than 1 credit per recipient — operators want to know.
        const seg = data.segments_per_recipient || 1;
        const billNote = seg > 1
          ? ` · ${data.credits_charged} credits charged (${seg}/recipient)`
          : '';
        toast(`Blast complete — ${parts.join(', ')}${optNote}${billNote}`);
      }
      bg.remove();
      state.view = 'blasts'; render();
    } catch (e) {
      stopped = true; if (pollTimer) clearTimeout(pollTimer);
      progressOverlay.remove();
      // Tenant-level throttle errors are not bugs — they're guardrails
      // doing their job. Surface them in plain English so the operator
      // sees WHY the blast is blocked, not a raw error string.
      const raw = String(e.message || '');
      if (/insufficient_credits/.test(raw)) {
        // Server returned the segment-aware breakdown — surface it
        // so the operator understands why their balance fell short.
        const d = e.data || {};
        const seg = d.segments_per_recipient || 1;
        const need = d.required || 0;
        const avail = d.available || 0;
        const recips = d.recipients || 0;
        const explain = seg > 1
          ? `Your message is ${seg} segments long, so this blast costs ${seg} credits per recipient — ${recips} recipients × ${seg} = ${need} credits needed.`
          : `${recips} recipients × 1 credit each = ${need} credits needed.`;
        result.innerHTML =
          `<strong style="color:#fbd38d">Out of credits</strong><br>` +
          `<span style="color:#a0aec0;font-size:0.85rem">${explain} You have ${avail}. ` +
          (seg > 1 ? 'Shorten the message to fit in 1 segment (≤160 chars) to cut the cost.' : 'Top up to send.') +
          `</span>`;
        toast(`Need ${need} credits — you have ${avail}.`, true, 6000);
      } else if (/tenant_hour_throttle/.test(raw)) {
        result.innerHTML = '<strong style="color:#fbd38d">Blast blocked — daily limit</strong><br><span style="color:#a0aec0;font-size:0.85rem">You\'ve already sent a blast within the last hour. The limit is 1 blast per hour to protect your contacts from over-messaging.</span>';
        toast('Blocked: only 1 blast per hour allowed.', true, 6000);
      } else if (/tenant_day_throttle/.test(raw)) {
        result.innerHTML = '<strong style="color:#fbd38d">Blast blocked — daily limit</strong><br><span style="color:#a0aec0;font-size:0.85rem">You\'ve hit the daily cap of 2 blasts per 24 hours. The cap resets rolling on the oldest send.</span>';
        toast('Blocked: 2 blasts/day limit reached.', true, 6000);
      } else {
        result.textContent = 'Error: ' + raw;
        result.style.color = 'var(--error)';
      }
      inFlight = false;
      sendBtn.disabled = false; sendBtn.textContent = 'Send Blast';
    }
  } }, 'Send Blast');

  // Split into a scrollable body + a fixed-height footer. The footer
  // is OUTSIDE the scrolling area so its buttons are always visible
  // regardless of how long the message body / preview / tag chip
  // rows get. This is the reliable sticky-footer pattern — the
  // previous position:sticky bottom:-24px hid the buttons because
  // the negative offset put them past the scroll edge.
  // Sending-limit banner — populated by the limits payload returned
  // alongside GET /api/portal/blasts. Tells the operator up front
  // how many of their daily blasts they've used and when the next
  // one is available. Also disables the Send button when over limit
  // so they can't even attempt a blocked send.
  const limitsBanner = el('div', {
    style: 'padding:10px 12px;border-radius:6px;font-size:0.78rem;line-height:1.45;margin-bottom:12px;' +
           'background:rgba(99,179,237,0.08);border:1px solid rgba(99,179,237,0.22);color:#cbd5e1;'
  }, 'Checking your send limits…');

  // Compliance note + opt-out reminder rendered right below the
  // message field. Mirrors what the server enforces so the operator
  // can see why "Reply STOP to opt out." will (or won't) be added.
  const complianceNote = el('div', {
    style: 'font-size:0.7rem;color:#a0aec0;margin-top:4px;line-height:1.45'
  });
  const updateComplianceNote = () => {
    const body = msgIn.value.trim();
    if (!body) { complianceNote.textContent = ''; return; }
    if (OPT_OUT_RE.test(body)) {
      complianceNote.innerHTML = '<span style="color:#86efac">✓ Opt-out instruction detected in your copy.</span>';
    } else {
      complianceNote.innerHTML = '<span style="color:#fbd38d">⚠ No opt-out wording detected — we\'ll auto-append <strong>"Reply STOP to opt out."</strong> to stay carrier-compliant.</span>';
    }
  };

  const blastBody = el('div', {
    style: 'flex:1 1 auto;overflow-y:auto;padding:24px 24px 8px;'
  },
    el('h2', { style: 'margin:0 0 12px' }, 'New SMS Blast'),
    limitsBanner,
    el('label', {}, 'Blast Name'), nameIn,
    el('label', {}, 'Message Body'), msgIn,
    segCounter,
    complianceNote,
    chipsRow,
    previewBox,
    attachImgBtn,
    blastMediaPreview,
    el('label', {}, 'Promo Code'), promoIn,
    el('label', {}, 'Segment'), segSel,
    el('label', { style: 'margin-top:10px' }, 'Include only these tags (any-of)'),
    includeChipsHost,
    el('label', { style: 'margin-top:10px' }, 'Exclude these tags'),
    excludeChipsHost,
    el('div', { class: 'muted', style: 'font-size:0.7rem;margin-top:4px' },
      'Tip: exclude "Do Not Contact" and "Current Client" to keep blasts focused on prospects.'
    ),
    result
  );
  const blastFooter = el('div', {
    style: 'flex:0 0 auto;display:flex;gap:12px;justify-content:flex-end;' +
           'padding:14px 24px env(safe-area-inset-bottom,16px);' +
           'background:var(--card,#1a2236);' +
           'border-top:1px solid var(--border,rgba(255,255,255,0.08));' +
           'border-bottom-left-radius:12px;border-bottom-right-radius:12px;'
  },
    el('button', { class: 'btn', onclick: () => bg.remove() }, 'Cancel'),
    sendBtn
  );
  const modal = el('div', { class: 'modal' }, blastBody, blastFooter);
  // Initial preview render now that nodes are mounted.
  updatePreview();

  const bg = el('div', { class: 'blast-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } }, modal);
  // Overflow + flex-start anchor so a long preview never pushes the
  // Send Now button below the viewport. The overlay itself scrolls
  // (overflow-y:auto) AND the modal caps at 90vh with its own
  // scroll, so the action row stays clickable regardless of how
  // big the message body / preview grows.
  // Overlay scrolls if needed (very tall screens / zoom-in users).
  // Modal is flex-column with a max-height so the body scrolls
  // INSIDE the modal while the footer stays glued to its bottom.
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px env(safe-area-inset-bottom,16px);overflow-y:auto;z-index:1000';
  modal.style.cssText = 'background:var(--card,#1a2236);border:1px solid var(--border,#2a3a5c);border-radius:12px;width:100%;max-width:480px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';
  modal.querySelectorAll('input,textarea,select').forEach(i => {
    // The message-body textarea ships its own min-height / height /
    // resize via inline style. Setting cssText below would obliterate
    // those and let flex layout squeeze the box to nothing — leaving
    // the operator with a 1-line textarea they can't really edit.
    // Append the visual styling instead of replacing.
    if (i.dataset.blastMsg === '1') {
      i.style.width = '100%';
      i.style.padding = '8px 12px';
      i.style.margin = '4px 0 12px';
      i.style.background = '#0d1117';
      i.style.border = '1px solid var(--border, #2a3a5c)';
      i.style.borderRadius = '6px';
      i.style.color = 'var(--text, #e0e0e0)';
      i.style.fontSize = '0.85rem';
      return;
    }
    i.style.cssText = 'width:100%;padding:8px 12px;margin:4px 0 12px;background:#0d1117;border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem';
  });
  modal.querySelectorAll('label').forEach(l => l.style.cssText = 'font-size:0.8rem;color:var(--muted,#888)');
  document.body.appendChild(bg);

  // Load the sending-limit status and surface it in the banner +
  // disable the Send button if we're already at the cap. Falls back
  // to a neutral hint if the GET fails so the modal stays usable.
  (async () => {
    try {
      const d = await api('/api/portal/blasts');
      const lim = d.limits || null;
      if (!lim) {
        limitsBanner.textContent = 'Limit: 1 blast per hour · 2 per day · Each message ends with "Reply STOP to opt out."';
        return;
      }
      const hourLeft = Math.max(0, lim.max_per_hour - lim.count_hour);
      const dayLeft  = Math.max(0, lim.max_per_day  - lim.count_day);
      const overLimit = (lim.count_hour >= lim.max_per_hour) || (lim.count_day >= lim.max_per_day);
      const nextAvailMins = lim.next_available_at
        ? Math.max(1, Math.ceil((new Date(lim.next_available_at).getTime() - Date.now()) / 60000))
        : 0;
      if (overLimit) {
        const reason = (lim.count_day >= lim.max_per_day)
          ? `You've used ${lim.count_day} of ${lim.max_per_day} blasts in the last 24 hours.`
          : `You've already sent a blast in the last hour.`;
        const whenLabel = nextAvailMins >= 60
          ? `${Math.ceil(nextAvailMins / 60)} hour${Math.ceil(nextAvailMins / 60) === 1 ? '' : 's'}`
          : `${nextAvailMins} minute${nextAvailMins === 1 ? '' : 's'}`;
        limitsBanner.style.background = 'rgba(245,101,101,0.10)';
        limitsBanner.style.borderColor = 'rgba(245,101,101,0.35)';
        limitsBanner.style.color = '#fbd38d';
        limitsBanner.innerHTML = `<strong>Sending paused — limit reached.</strong><br>${reason} Next blast available in <strong>${whenLabel}</strong>. Each message ends with “Reply STOP to opt out.”`;
        sendBtn.disabled = true;
        sendBtn.title = 'Limit reached — wait until the cooldown ends.';
      } else {
        limitsBanner.innerHTML =
          `<strong>Sending limits</strong> — ` +
          `<strong>${hourLeft}</strong> of <strong>${lim.max_per_hour}</strong> blasts left this hour · ` +
          `<strong>${dayLeft}</strong> of <strong>${lim.max_per_day}</strong> left in the next 24h. ` +
          `Each message ends with “Reply STOP to opt out.”`;
      }
    } catch {
      limitsBanner.textContent = 'Limit: 1 blast per hour · 2 per day · Each message ends with "Reply STOP to opt out."';
    }
  })();
  // Run the compliance check once in case there's prefilled text.
  updateComplianceNote();
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
      el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px;min-width:0' },
        el('div', { style: 'width:28px;height:28px;border-radius:50%;background:var(--accent,#C9A84C);color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold;flex-shrink:0' }, String(i)),
        el('div', { style: 'flex:1;min-width:0;font-weight:600;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          'Message ' + i + (i === 1 ? ' — Welcome' : '')),
        el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--muted,#888);cursor:pointer;flex-shrink:0;white-space:nowrap' },
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

  // Fetch + render Stripe Connect status. Wrapped so the Disconnect
  // button below can call renderStripeStatus() to re-paint just this
  // row instead of reloading the whole Settings tab.
  async function renderStripeStatus() {
    try {
      const sc = await api('/api/portal/connect?action=status');
      stripeStatus.innerHTML = '';
      if (!sc.connected) {
        stripeStatus.appendChild(el('span', { class: 'badge red' }, 'Not connected'));
        const connectErr = el('div', { style: 'margin-left:8px;font-size:11px;color:#fca5a5;display:inline-block' });
        const connectBtn = el('button', { class: 'btn sm', style: 'margin-left:8px', onclick: async () => {
          connectErr.textContent = '';
          connectBtn.disabled = true;
          connectBtn.textContent = 'Opening…';
          try {
            const r = await api('/api/portal/connect?action=start', { method: 'POST' });
            if (!r?.url) throw new Error('Stripe returned no URL.');
            window.location.href = r.url;
          } catch (e) {
            connectErr.textContent = 'Setup failed: ' + e.message;
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect Stripe';
          }
        } }, 'Connect Stripe');
        stripeStatus.appendChild(connectBtn);
        stripeStatus.appendChild(connectErr);
      } else {
        const statusBadge = sc.charges_enabled
          ? el('span', { class: 'badge green' }, 'Active')
          : el('span', { class: 'badge warn' }, 'Onboarding incomplete');
        stripeStatus.appendChild(statusBadge);
        stripeStatus.appendChild(el('span', { class: 'muted', style: 'margin-left:8px;font-size:0.8rem' },
          `Account ${sc.account_id}` + (sc.charges_enabled ? ' · Charges enabled' : '')));

        // Disconnect button. Asks for confirmation because once
        // disconnected, every /api/external/checkout call returns
        // stripe_not_configured until the tenant re-OAuths — Buy
        // buttons on their storefront error out for customers.
        // Calls the existing /api/portal/connect?action=disconnect
        // which nulls clients.stripe_connected_account_id.
        const disconnectErr = el('div', { style: 'margin-left:8px;font-size:11px;color:#fca5a5;display:inline-block' });
        const disconnectBtn = el('button', {
          class: 'btn sm ghost',
          style: 'margin-left:8px;color:#fca5a5;border-color:rgba(245,101,101,0.35)',
          onclick: async () => {
            if (!confirm(
              'Disconnect your Stripe account?\n\n' +
              'Your storefront will stop accepting payments immediately. ' +
              'Any Buy buttons on your /merch page will show "not configured" ' +
              'until you reconnect.\n\n' +
              'This does NOT cancel pending Stripe payouts or refund anything — ' +
              'it only removes the link between this portal and your Stripe ' +
              'account. You can reconnect any time.'
            )) return;
            disconnectErr.textContent = '';
            disconnectBtn.disabled = true;
            disconnectBtn.textContent = 'Disconnecting…';
            try {
              await api('/api/portal/connect?action=disconnect', { method: 'POST' });
              toast('Stripe account disconnected.');
              await renderStripeStatus();
            } catch (e) {
              disconnectErr.textContent = 'Failed: ' + e.message;
              disconnectBtn.disabled = false;
              disconnectBtn.textContent = 'Disconnect';
            }
          }
        }, 'Disconnect');
        stripeStatus.appendChild(disconnectBtn);
        stripeStatus.appendChild(disconnectErr);
      }
    } catch { stripeStatus.textContent = 'Error checking Stripe'; }
  }
  await renderStripeStatus();
}

async function viewSettings() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Settings')));

  // ----- Push Notifications -----
  // The Notification API isn't available in every browser (iOS Safari
  // standalone PWA, in-app webviews, Brave with shields up, etc.).
  // Reference it through `typeof` and bail gracefully when missing so
  // the whole Settings tab doesn't crash.
  const pushSupported = typeof Notification !== 'undefined' && 'requestPermission' in Notification;
  const pushPerm = pushSupported ? Notification.permission : 'unsupported';
  const pushPanel = el('div', { class: 'panel' });
  pushPanel.appendChild(el('h2', {}, 'Push Notifications'));
  if (!pushSupported) {
    pushPanel.appendChild(el('p', { class: 'muted' },
      'This browser does not support push notifications. Open the portal in Chrome/Safari on desktop, or install it as a home-screen app on Android, to enable push.'));
  } else {
    const pushStatus = pushPerm === 'granted' ? 'Enabled' :
      pushPerm === 'denied' ? 'Blocked' : 'Not set up';
    pushPanel.appendChild(el('p', { class: 'muted', style: 'margin-bottom:8px' },
      'Status: ' + pushStatus + (pushPerm === 'denied'
        ? ' — unblock in your browser settings to receive alerts' : '')));
    if (pushPerm === 'granted') {
      const testBtn = el('button', { class: 'btn', onclick: async () => {
        testBtn.disabled = true; testBtn.textContent = 'Sending…';
        try {
          const r = await api('/api/portal/push-test', { method: 'POST' });
          if (r.ok) toast('Test notification sent — check your browser');
          else toast('Failed: ' + (r.error || 'unknown'), true);
        } catch (e) { toast('Failed: ' + e.message, true); }
        finally { testBtn.disabled = false; testBtn.textContent = 'Send Test Notification'; }
      } }, 'Send Test Notification');
      pushPanel.appendChild(testBtn);
    } else if (pushPerm === 'default') {
      const enableBtn = el('button', { class: 'btn primary', onclick: async () => {
        try {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') { initPushNotifications(); render(); }
          else toast('Notifications were blocked by your browser', true);
        } catch (e) { toast('Could not enable notifications: ' + e.message, true); }
      } }, 'Enable Push Notifications');
      pushPanel.appendChild(enableBtn);
    }
  }
  wrap.appendChild(pushPanel);

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
      const creditsLine = p.bonusCredits
        ? el('div', { class: 'pack-credits' },
            `${p.baseCredits.toLocaleString()} + `,
            el('span', { style: 'color:#86efac' }, `${p.bonusCredits.toLocaleString()} bonus`)
          )
        : el('div', { class: 'pack-credits' }, `${p.credits.toLocaleString()} credits`);
      packsRow.appendChild(el('div', { class: 'pack-card' + (p.badge ? ' featured' : '') },
        p.badge ? el('div', { class: 'pack-badge', style: 'font-size:0.65rem;color:#fbd38d;letter-spacing:0.06em;margin-bottom:2px' }, p.badge) : null,
        el('div', { class: 'pack-label' }, p.label),
        el('div', { class: 'pack-price' }, '$' + (p.priceCents / 100)),
        creditsLine,
        p.bonusCredits ? el('div', { class: 'muted', style: 'font-size:0.7rem' }, `${p.credits.toLocaleString()} total`) : null,
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
      ...Object.values(b.packs || {}).map(p => el('option', { value: p.id, selected: p.id === b.auto_reload?.pack }, `${p.label} ($${p.priceCents/100} / ${p.credits.toLocaleString()} credits${p.bonusCredits ? ' incl. ' + p.bonusCredits.toLocaleString() + ' bonus' : ''})`))
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

    // Twilio Reserve summary — admin-only inline so the operator can see
    // the reserve from inside any tenant's Settings without leaving.
    if (state.user?.email === 'ab@goelev8.ai') {
      const reserveStrip = el('div', { class: 'leads-metrics-strip', style: 'margin-top:20px' },
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value', id: 'tr-reserved' }, '—'),
          el('span', { class: 'metric-stat-label' }, 'Reserved for Twilio')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value', id: 'tr-used' }, '—'),
          el('span', { class: 'metric-stat-label' }, 'Used on SMS')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat accent' },
          el('span', { class: 'metric-stat-value', id: 'tr-balance' }, '—'),
          el('span', { class: 'metric-stat-label' }, 'Reserve Balance')
        )
      );
      billingPanel.appendChild(reserveStrip);
      api('/api/portal/twilio-reserve').then(r => {
        const f = (c) => '$' + ((c || 0) / 100).toFixed(2);
        const $ = (id) => reserveStrip.querySelector('#' + id);
        if ($('tr-reserved')) $('tr-reserved').textContent = f(r.reserved_total_cents);
        if ($('tr-used'))     $('tr-used').textContent = f(r.used_total_cents);
        if ($('tr-balance'))  $('tr-balance').textContent = f(r.balance_cents);
      }).catch(() => {});
    }

    // Recent activity ledger — covers Stripe purchases, free credit grants,
    // auto-reloads, refunds, and admin adjustments. Reconcile button below
    // re-checks Stripe for any paid sessions that didn't post via webhook.
    const ledgerHeader = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:24px;margin-bottom:8px' },
      el('h3', { style: 'font-size:14px;font-weight:600' }, 'Recent activity'),
      el('button', { class: 'btn sm', onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Refreshing…';
        try {
          const r = await api('/api/portal/credits?action=reconcile', { method: 'POST' });
          if (r.recovered > 0) toast(`Recovered ${r.recovered} purchase(s) · +${r.credits_added} credits`);
          else toast('All purchases are already up to date.');
          render();
        } catch (e) { toast('Refresh failed: ' + e.message, true); }
        finally { btn.disabled = false; btn.textContent = orig; }
      } }, 'Refresh purchases')
    );
    billingPanel.appendChild(ledgerHeader);
    if (b.ledger?.length) {
      // Show only the most recent 5 transactions by default; "Show more"
      // expands to the full ledger (capped at 50 by the billing endpoint).
      const PAGE = 5;
      const buildRow = (r) => el('tr', {},
        el('td', {}, new Date(r.created_at).toLocaleString()),
        el('td', {}, el('span', {
          class: 'badge ' + (r.delta > 0 ? 'green' : r.delta < 0 ? 'red' : '')
        }, r.reason)),
        el('td', { style: 'font-weight:600' }, (r.delta > 0 ? '+' : '') + r.delta),
        el('td', {}, r.amount_cents ? '$' + (r.amount_cents/100).toFixed(2) : '—'),
        el('td', { class: 'muted', style: 'font-size:0.75rem;font-family:monospace' },
          r.ref_id ? r.ref_id.slice(0, 24) + (r.ref_id.length > 24 ? '…' : '') : '—')
      );
      const tbody = el('tbody', {}, ...b.ledger.slice(0, PAGE).map(buildRow));
      billingPanel.appendChild(el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'Type'), el('th', {}, 'Δ Credits'), el('th', {}, 'Amount'), el('th', {}, 'Reference')
        )),
        tbody
      ));

      if (b.ledger.length > PAGE) {
        let expanded = false;
        const toggleBtn = el('button', {
          class: 'btn sm',
          style: 'margin-top:10px',
          onclick: () => {
            expanded = !expanded;
            tbody.innerHTML = '';
            const rows = expanded ? b.ledger : b.ledger.slice(0, PAGE);
            for (const r of rows) tbody.appendChild(buildRow(r));
            toggleBtn.textContent = expanded
              ? 'Show less'
              : `Show all ${b.ledger.length} transactions`;
          }
        }, `Show all ${b.ledger.length} transactions`);
        billingPanel.appendChild(toggleBtn);
      }
    } else {
      billingPanel.appendChild(el('p', { class: 'muted' },
        'No activity yet. Stripe purchases and free credit grants will appear here. If a recent purchase is missing, click "Refresh purchases".'));
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
    el('code', {}, '{{source_path}}'), ' ',
    el('code', {}, '{{booking_url}}')
  ));
  wsms.appendChild(el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;font-style:italic' },
    'Tip: Use {{booking_url}} so your scheduling link always points to the current booking page (set by Booking URL in Master Admin or your custom domain).'
  ));

  const previewLabel = el('div', { class: 'field-label', style: 'margin-top:14px' }, 'Preview');
  const preview = el('div', { class: 'sms-preview' });
  wsms.appendChild(previewLabel);
  wsms.appendChild(preview);

  // Pull the live booking_url from /api/portal/me-extras so the preview shows
  // exactly what the actual welcome SMS will render. Falls back gracefully.
  let livebookingUrl = '';
  api('/api/portal/me?action=booking-url').then(r => {
    livebookingUrl = r?.booking_url || '';
    renderPreview();
  }).catch(() => {});

  const renderPreview = () => {
    const sample = {
      first_name: 'Jane',
      name: 'Jane Doe',
      client_name: state.client?.name || 'Your Business',
      source: 'theflexfacility.com',
      source_path: '/fit',
      booking_url: livebookingUrl || 'https://book.goelev8.ai/your-slug'
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
  if (state._activityChannels) {
    for (const ch of state._activityChannels) { try { ch.unsubscribe(); } catch {} }
    state._activityChannels = null;
  }

  // Hard gate: Activity is admin-only. Non-admins get sent to Overview.
  if (!state.isAdmin || state.user?.email !== 'ab@goelev8.ai') {
    const deny = el('div', {});
    deny.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Activity')));
    deny.appendChild(el('div', { class: 'panel' },
      el('p', { class: 'err' }, 'This page is restricted to platform admins.')));
    return deny;
  }

  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Activity'),
    el('div', { class: 'muted' }, 'Cross-tenant live feed of lead submissions & bookings')
  ));

  // ----- Filter state (kept in closure so realtime handler can read it) -----
  const filters = {
    clientId: 'all',          // 'all' | <uuid>
    eventType: 'all',         // 'all' | 'lead' | 'booking'
    from: '',                 // YYYY-MM-DD
    to: ''                    // YYYY-MM-DD
  };
  let allEvents = [];         // master list (unfiltered)
  let clientsById = {};       // { id: { name, slug } }

  // ----- Filter bar -----
  const filterBar = el('div', { class: 'activity-filters panel' });
  const clientSel = el('select', {},
    el('option', { value: 'all' }, 'All clients')
  );
  const typeSel = el('select', {},
    el('option', { value: 'all' }, 'All events'),
    el('option', { value: 'lead' }, 'Leads only'),
    el('option', { value: 'booking' }, 'Bookings only')
  );
  const fromIn = el('input', { type: 'date' });
  const toIn   = el('input', { type: 'date' });
  const resetBtn = el('button', { class: 'btn sm' }, 'Reset');

  const liveDot = el('span', { class: 'live-dot' });
  const liveLabel = el('span', { class: 'live-label muted' }, 'Connecting…');
  filterBar.appendChild(el('div', { class: 'activity-filter-row' },
    el('label', {}, el('span', { class: 'muted' }, 'Client'), clientSel),
    el('label', {}, el('span', { class: 'muted' }, 'Type'), typeSel),
    el('label', {}, el('span', { class: 'muted' }, 'From'), fromIn),
    el('label', {}, el('span', { class: 'muted' }, 'To'), toIn),
    resetBtn,
    el('div', { class: 'activity-live' }, liveDot, liveLabel)
  ));
  wrap.appendChild(filterBar);

  // ----- Feed panel -----
  const list = el('div', { class: 'panel activity-feed' }, el('div', { class: 'muted' }, 'Loading…'));
  wrap.appendChild(list);

  // ----- Helpers -----
  const fmt = (ts) => {
    const d = new Date(ts); const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleString();
  };

  const applyFilters = () => {
    const from = filters.from ? new Date(filters.from + 'T00:00:00') : null;
    const to   = filters.to   ? new Date(filters.to   + 'T23:59:59') : null;
    return allEvents.filter(ev => {
      if (filters.clientId !== 'all' && ev.client_id !== filters.clientId) return false;
      if (filters.eventType !== 'all' && ev.type !== filters.eventType) return false;
      const t = new Date(ev.ts);
      if (from && t < from) return false;
      if (to && t > to) return false;
      return true;
    });
  };

  const renderRows = () => {
    const events = applyFilters().slice(0, 200);
    list.innerHTML = '';
    if (!events.length) {
      list.appendChild(el('div', { class: 'muted', style: 'padding:24px;text-align:center' },
        'No activity matching current filters.'));
      return;
    }
    const table = el('div', { class: 'event-list' });
    for (const ev of events) {
      const c = clientsById[ev.client_id];
      const clientLabel = c ? c.name : 'Unknown tenant';
      const funnelLabel = ev.funnel ? ` — ${ev.funnel}` : '';
      const typeBadge = el('div', {
        class: 'event-type ' + (ev.type === 'lead' ? 'ev-lead' : 'ev-booking')
      }, ev.type === 'lead' ? 'Lead Submitted' : 'Booking Made');

      const actionBtn = el('button', { class: 'btn sm', onclick: (e) => {
        e.stopPropagation();
        setImpersonation(ev.client_id);
        state.view = ev.type === 'lead' ? 'leads' : 'bookings';
        render();
      } }, 'View record →');

      const row = el('div', { class: 'event-row' + (ev._new ? ' event-new' : '') },
        typeBadge,
        el('div', { class: 'event-body' },
          el('div', { class: 'event-title' },
            el('strong', {}, `${clientLabel}${funnelLabel}`)),
          el('div', { class: 'event-meta muted' },
            (ev.who || '—'),
            ev.contact ? ` · ${ev.contact}` : ''
          )
        ),
        el('div', { class: 'event-time muted' }, fmt(ev.ts)),
        actionBtn
      );
      table.appendChild(row);
      if (ev._new) setTimeout(() => { row.classList.remove('event-new'); ev._new = false; }, 3000);
    }
    list.appendChild(table);
  };

  // ----- Normalize raw lead / booking rows to a common Event shape -----
  const toEvent = (row, type) => {
    if (type === 'lead') {
      return {
        type: 'lead',
        id: 'l:' + row.id,
        client_id: row.client_id,
        ts: row.created_at,
        funnel: row.funnel || row.source || null,
        who: row.name || null,
        contact: row.phone || row.email || null,
        raw: row
      };
    }
    return {
      type: 'booking',
      id: 'b:' + row.id,
      client_id: row.client_id,
      ts: row.created_at || row.starts_at,
      funnel: row.service || null,
      who: row.contact_name || row.lead_name || null,
      contact: row.contact_phone || row.contact_email || null,
      raw: row
    };
  };

  const upsertEvent = (ev, markNew) => {
    const i = allEvents.findIndex(x => x.id === ev.id);
    if (markNew) ev._new = true;
    if (i >= 0) allEvents[i] = ev; else allEvents.unshift(ev);
    allEvents.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    if (allEvents.length > 1000) allEvents.length = 1000;
    renderRows();
  };

  // ----- Initial fetch: pull leads + bookings + clients via a new admin endpoint -----
  try {
    const r = await api('/api/admin?action=activity-feed&limit=500');
    clientsById = {};
    for (const c of (r.clients || [])) { clientsById[c.id] = { name: c.name, slug: c.slug }; }
    // Populate client filter dropdown
    const sortedClients = Object.entries(clientsById)
      .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    for (const [id, c] of sortedClients) {
      clientSel.appendChild(el('option', { value: id }, c.name || c.slug));
    }
    // Merge leads + bookings into the master list
    allEvents = [
      ...(r.leads || []).map(x => toEvent(x, 'lead')),
      ...(r.bookings || []).map(x => toEvent(x, 'booking'))
    ].sort((a, b) => new Date(b.ts) - new Date(a.ts));
    renderRows();
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'err' }, 'Failed to load feed: ' + e.message));
    return wrap;
  }

  // ----- Filter handlers -----
  clientSel.addEventListener('change', () => { filters.clientId = clientSel.value; renderRows(); });
  typeSel.addEventListener('change',   () => { filters.eventType = typeSel.value; renderRows(); });
  fromIn.addEventListener('change',    () => { filters.from = fromIn.value; renderRows(); });
  toIn.addEventListener('change',      () => { filters.to = toIn.value; renderRows(); });
  resetBtn.addEventListener('click', () => {
    filters.clientId = 'all'; filters.eventType = 'all'; filters.from = ''; filters.to = '';
    clientSel.value = 'all'; typeSel.value = 'all'; fromIn.value = ''; toIn.value = '';
    renderRows();
  });

  // ----- Supabase Realtime subscriptions (leads + bookings) -----
  (async () => {
    const cfg = state.supabaseConfig;
    if (!cfg?.url || !cfg?.anon_key) {
      liveLabel.textContent = 'Realtime unavailable (auto-refresh 5s)';
      activityPoll = setInterval(async () => {
        try {
          const r = await api('/api/admin?action=activity-feed&limit=200');
          allEvents = [
            ...(r.leads || []).map(x => toEvent(x, 'lead')),
            ...(r.bookings || []).map(x => toEvent(x, 'booking'))
          ].sort((a, b) => new Date(b.ts) - new Date(a.ts));
          renderRows();
        } catch {}
      }, 5000);
      return;
    }

    let createClient;
    try {
      ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2'));
    } catch (e) {
      liveLabel.textContent = 'Realtime load failed';
      return;
    }
    const sb = createClient(cfg.url, cfg.anon_key, {
      realtime: { params: { eventsPerSecond: 10 } }
    });
    try { sb.realtime.setAuth(state.token); } catch {}

    const leadsCh = sb.channel('admin:activity:leads')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' }, (p) => {
        upsertEvent(toEvent(p.new, 'lead'), true);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          liveDot.classList.add('on');
          liveLabel.textContent = 'Live';
        }
      });
    const bookingsCh = sb.channel('admin:activity:bookings')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings' }, (p) => {
        upsertEvent(toEvent(p.new, 'booking'), true);
      })
      .subscribe();

    state._activityChannels = [leadsCh, bookingsCh];
  })();

  return wrap;
}

// ============================================================
// MASTER ADMIN VIEW
// ============================================================
// Renders a single client management card for the Master Admin grid.
// Shows business name, active status, credit balance, last activity,
// and three quick actions: Impersonate · Add Credits · View Analytics.
function renderClientCard(c) {
  const fmtAgo = (ts) => {
    if (!ts) return 'No activity yet';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60)    return diff + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 30 * 86400) return Math.floor(diff / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  };
  const isActive = !c.billing_paused;
  const displayName = c.business_name || c.name || c.slug;

  const statusBadge = isActive
    ? el('span', { class: 'badge green' }, 'Active')
    : el('span', { class: 'badge red' }, 'Paused');

  const impersonateBtn = el('button', {
    class: 'btn sm primary',
    onclick: () => { setImpersonation(c.id); state.view = 'overview'; render(); }
  }, 'Impersonate');

  const addCreditsBtn = el('button', {
    class: 'btn sm',
    onclick: async () => {
      const raw = prompt(`Adjust SMS credits for ${displayName}\n\nEnter a number. Positive = add, negative = remove.`, '20');
      if (raw == null) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n === 0) { toast('Enter a non-zero integer', true); return; }
      try {
        const r = await api('/api/admin?action=set-credits', {
          method: 'POST',
          body: { client_id: c.id, delta: n, note: `admin card ${n > 0 ? '+' : ''}${n}` }
        });
        toast(`${displayName}: ${r.client.credit_balance} credits`);
        state.view = 'admin'; render();
      } catch (e) { toast('Credit adjust failed: ' + e.message, true); }
    }
  }, 'Add Credits');

  const analyticsBtn = el('button', {
    class: 'btn sm',
    onclick: () => { setImpersonation(c.id); state.view = 'analytics'; render(); }
  }, 'View Analytics');

  return el('div', { class: 'client-card' },
    el('div', { class: 'client-card-header' },
      el('div', { class: 'client-card-name' }, displayName),
      statusBadge
    ),
    el('div', { class: 'client-card-slug muted' },
      el('code', {}, c.slug)
    ),
    el('div', { class: 'client-card-stats' },
      el('div', { class: 'client-card-stat' },
        el('div', { class: 'client-card-stat-value' }, String(c.credit_balance ?? 0)),
        el('div', { class: 'client-card-stat-label muted' }, 'SMS Credits')
      ),
      el('div', { class: 'client-card-stat' },
        el('div', { class: 'client-card-stat-value' }, fmtAgo(c.last_activity_at)),
        el('div', { class: 'client-card-stat-label muted' }, 'Last Activity')
      )
    ),
    el('div', { class: 'client-card-actions' },
      impersonateBtn, addCreditsBtn, analyticsBtn
    )
  );
}

// Master Admin client card — replaces the old wide table row. Logo at
// the top (or initials in a name-derived circle as a fallback), then
// stats grid (credits / sent 30d / last activity), then primary
// actions (Impersonate, View Analytics, Add/Remove Credits) + a ⚙
// Settings button that opens a modal with the per-tenant config
// (GA4 ID, Stripe key, Booking URL, Pause billing).
function renderAdminClientCard(c, refresh) {
  const fmtAgo = (ts) => {
    if (!ts) return 'No activity yet';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60)    return diff + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 30 * 86400) return Math.floor(diff / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  };
  const isActive = !c.billing_paused;
  const displayName = c.business_name || c.name || c.slug;

  // Logo header — render the uploaded logo OR a tinted-circle initial
  // fallback so the card looks finished even before a logo's set.
  const logoEl = c.logo_url
    ? el('img', { class: 'admin-card-logo-img', src: c.logo_url, alt: '' })
    : (() => {
        const node = el('div', { class: 'admin-card-logo-fallback' },
          el('span', {}, customerInitials(displayName)));
        node.style.background = avatarColorFromName(displayName);
        return node;
      })();

  const statusBadge = isActive
    ? el('span', { class: 'badge green' }, 'Active')
    : el('span', { class: 'badge red' }, 'Paused');

  const adjustCredits = async (sign) => {
    const raw = prompt(`Adjust SMS credits for ${displayName}\n\nEnter a positive number to ${sign > 0 ? 'add' : 'remove'} credits:`, '20');
    if (raw == null) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) { toast('Enter a positive integer', true); return; }
    try {
      const r = await api('/api/admin?action=set-credits', {
        method: 'POST',
        body: { client_id: c.id, delta: sign * n, note: `admin card ${sign > 0 ? '+' : '-'}${n}` }
      });
      toast(`${displayName}: ${r.client.credit_balance} credits`);
      await refresh();
    } catch (e) { toast('Credit adjust failed: ' + e.message, true); }
  };

  return el('div', { class: 'admin-client-card' },
    el('div', { class: 'admin-card-header' },
      el('div', { class: 'admin-card-logo' }, logoEl),
      el('div', { class: 'admin-card-title' },
        el('div', { class: 'admin-card-name' }, displayName),
        el('div', { class: 'admin-card-status' }, statusBadge,
          c.twilio_phone_number ? el('span', { class: 'muted', style: 'font-size:0.7rem;margin-left:6px' }, c.twilio_phone_number) : null
        )
      )
    ),
    el('div', { class: 'admin-card-stats' },
      el('div', { class: 'admin-card-stat' },
        el('div', { class: 'admin-card-stat-value' }, String(c.credit_balance ?? 0)),
        el('div', { class: 'admin-card-stat-label muted' }, 'SMS Credits')
      ),
      el('div', { class: 'admin-card-stat' },
        el('div', { class: 'admin-card-stat-value' }, String(c.sent_30d || 0)),
        el('div', { class: 'admin-card-stat-label muted' }, 'Sent 30d')
      ),
      el('div', { class: 'admin-card-stat' },
        el('div', { class: 'admin-card-stat-value', style: 'font-size:0.85rem' }, fmtAgo(c.last_activity_at)),
        el('div', { class: 'admin-card-stat-label muted' }, 'Last Activity')
      )
    ),
    el('div', { class: 'admin-card-actions' },
      el('button', { class: 'btn sm primary',
        onclick: () => { setImpersonation(c.id); state.view = 'overview'; render(); }
      }, 'Impersonate'),
      el('button', { class: 'btn sm',
        onclick: () => { setImpersonation(c.id); state.view = 'analytics'; render(); }
      }, 'Analytics'),
      el('button', { class: 'btn sm', onclick: () => adjustCredits(+1) }, '+ Credits'),
      el('button', { class: 'btn sm ghost', onclick: () => adjustCredits(-1) }, '− Credits'),
      el('button', { class: 'btn sm', onclick: () => openClientSettingsModal(c, refresh) }, '⚙ Settings')
    )
  );
}

// Per-tenant config modal — keeps the GA4 / Stripe / Booking / pause
// controls off the cluttered card surface.
function openClientSettingsModal(c, refresh) {
  const existing = document.querySelector('.client-settings-bg');
  if (existing) existing.remove();

  const ga4In = el('input', { type: 'text', placeholder: 'GA4 property ID (numeric)', value: c.ga4_property_id || '' });
  const buIn  = el('input', { type: 'text', placeholder: 'book.theflexfacility.com', value: c.booking_custom_domain || '' });
  const skIn  = el('input', { type: 'password', placeholder: 'sk_live_… (paste to set, leave blank to keep current)' });

  const close = () => bg.remove();
  const result = el('div', { style: 'min-height:1.2em;font-size:0.8rem' });

  const saveAll = async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      // GA4 + Booking always save (even when blank — clears them).
      await api('/api/admin?action=set-ga4', { method: 'POST', body: { client_id: c.id, ga4_property_id: ga4In.value.trim() } });
      await api('/api/admin?action=set-booking-url', { method: 'POST', body: { client_id: c.id, booking_url: buIn.value.trim() } });
      // Stripe key only saves when the field is non-empty (keeps existing on blank).
      if (skIn.value.trim()) {
        await api('/api/admin?action=set-stripe-key', { method: 'POST', body: { client_id: c.id, stripe_secret_key: skIn.value.trim() } });
      }
      toast('Settings saved for ' + (c.business_name || c.name));
      close();
      await refresh();
    } catch (e) {
      result.textContent = 'Error: ' + e.message;
      result.style.color = 'var(--danger,#e74c3c)';
    } finally { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  };

  const togglePause = async () => {
    try {
      await api('/api/admin?action=billing-pause', {
        method: 'POST', body: { client_id: c.id, paused: !c.billing_paused }
      });
      toast(c.billing_paused ? 'Billing resumed' : 'Billing paused');
      close();
      await refresh();
    } catch (e) { toast(e.message, true); }
  };

  const saveBtn = el('button', { class: 'btn primary', onclick: saveAll }, 'Save');

  const field = (label, hint, input) => el('div', { class: 'csm-field' },
    el('label', {}, label),
    hint ? el('div', { class: 'muted', style: 'font-size:0.7rem;margin-bottom:4px' }, hint) : null,
    input
  );

  const modal = el('div', { class: 'client-settings-modal' },
    el('div', { class: 'csm-header' },
      el('h3', {}, '⚙ ' + (c.business_name || c.name) + ' — Settings'),
      el('button', { class: 'profile-close', type: 'button', 'aria-label': 'Close',
        onclick: close, ontouchend: close }, '×')
    ),
    field('GA4 Property ID',
      'Numeric GA4 property (e.g. 123456789). Leave blank to clear.',
      ga4In),
    field('Booking URL',
      'Custom domain for this tenant\'s booking widget (no protocol). Drives the Vapi assistant + welcome SMS.',
      buIn),
    field('Stripe Secret Key',
      'sk_live_... — only used to sync sales from this tenant\'s Stripe account. Leave blank to keep the existing key.',
      skIn),
    el('div', { class: 'csm-row' },
      el('button', {
        class: 'btn ' + (c.billing_paused ? 'btn-success' : 'btn-warn'),
        onclick: togglePause
      }, c.billing_paused ? 'Resume Billing' : 'Pause Billing'),
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn', onclick: close }, 'Cancel'),
      saveBtn
    ),
    result
  );

  const bg = el('div', { class: 'client-settings-bg', onclick: (e) => { if (e.target === bg) close(); } }, modal);
  document.body.appendChild(bg);
}

async function viewAdmin() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Master Admin'),
    el('div', { class: 'muted' }, 'Cross-tenant operations · only visible to platform admins')));

  // Seed defaults once; also deletes any stale DLP row so it doesn't keep
  // showing up as a duplicate/acronym for Daniels Legacy Planning.
  await api('/api/admin?action=ensure-default-clients', { method: 'POST' }).catch(() => {});

  // ----- Push Notifications -----
  const pushPanel = el('div', { class: 'panel' });
  pushPanel.appendChild(el('h2', {}, 'Push Notifications'));
  const pushPerm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const pushLabel = pushPerm === 'granted' ? 'Enabled' :
    pushPerm === 'denied' ? 'Blocked — unblock in browser settings' :
    pushPerm === 'unsupported' ? 'Not supported in this browser' : 'Not set up';
  pushPanel.appendChild(el('p', { class: 'muted', style: 'margin-bottom:8px' },
    'Receive alerts for all client activity (leads, SMS, calls, sales). Status: ' + pushLabel));
  if (pushPerm === 'granted') {
    const testBtn = el('button', { class: 'btn', onclick: async () => {
      testBtn.disabled = true; testBtn.textContent = 'Sending…';
      try {
        const r = await api('/api/portal/push-test', { method: 'POST' });
        if (r.ok) toast('Test notification sent — check your browser/OS notifications');
        else toast('Failed: ' + (r.error || JSON.stringify(r)), true);
      } catch (e) { toast('Failed: ' + e.message, true); }
      finally { testBtn.disabled = false; testBtn.textContent = 'Send Test Notification'; }
    } }, 'Send Test Notification');
    pushPanel.appendChild(testBtn);
  } else if (pushPerm === 'default') {
    const enableBtn = el('button', { class: 'btn primary', onclick: async () => {
      _pushInitDone = false;
      const perm = await Notification.requestPermission();
      if (perm === 'granted') { await initPushNotifications(); render(); }
      else toast('Notifications were blocked by your browser', true);
    } }, 'Enable Push Notifications');
    pushPanel.appendChild(enableBtn);
  }
  wrap.appendChild(pushPanel);

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

  // ----- Schema migrations (run pending migrations from the portal) -----
  const migPanel = el('div', { class: 'panel' });
  migPanel.appendChild(el('h2', {}, '🗄️ Database Migrations'));
  migPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
    'Apply pending schema changes (Stripe key, RLS, Twilio reserve, tags + paid_at) to Supabase. Idempotent — safe to re-run.'));
  // Persistent status card — replaces the disappearing toast so the
  // operator sees a clear ✓ / ⚠ summary that sticks around until
  // they click again. Toast still fires for screen-reader / mobile
  // visibility.
  const migStatus = el('div', { style: 'display:none;margin-top:12px;padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5' });
  const migOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:240px;margin-top:8px' });
  const migBtn = el('button', { class: 'btn primary', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Applying…';
    migStatus.style.display = 'block';
    migStatus.style.background = 'rgba(255,255,255,0.04)';
    migStatus.style.border = '1px solid rgba(255,255,255,0.08)';
    migStatus.style.color = 'var(--text-mute,#9ca3af)';
    migStatus.textContent = 'Applying migrations… (this can take 15–30 seconds for the full run)';
    try {
      const r = await api('/api/admin?action=apply-pending-migrations', { method: 'POST' });
      const failed = (r.results || []).filter(x => !x.ok);
      toast(`Applied ${r.success}/${r.total} statements${r.failed ? ` · ${r.failed} failed` : ''}`,
            failed.length > 0);
      if (failed.length) {
        migStatus.style.background = 'rgba(239,68,68,0.10)';
        migStatus.style.border = '1px solid rgba(239,68,68,0.35)';
        migStatus.style.color = '#fca5a5';
        migStatus.innerHTML =
          `<strong>⚠ ${r.failed} of ${r.total} statements failed.</strong><br/>` +
          `${r.success} succeeded · project ${r.project_ref || '—'}. ` +
          `Expand the JSON below for the failures.`;
      } else {
        migStatus.style.background = 'rgba(34,197,94,0.10)';
        migStatus.style.border = '1px solid rgba(34,197,94,0.35)';
        migStatus.style.color = '#86efac';
        migStatus.innerHTML =
          `<strong>✓ All ${r.total} migration statements applied successfully.</strong><br/>` +
          `<span class="muted" style="color:#86efac;opacity:0.85;font-size:12px">project ${r.project_ref || '—'} · click <strong>Verify Migrations</strong> next to confirm the schema landed.</span>`;
      }
      migOut.style.display = 'block';
      migOut.textContent = JSON.stringify({ project_ref: r.project_ref, total: r.total, success: r.success, failed: r.failed, errors: failed }, null, 2);
    } catch (err) {
      migStatus.style.background = 'rgba(239,68,68,0.10)';
      migStatus.style.border = '1px solid rgba(239,68,68,0.35)';
      migStatus.style.color = '#fca5a5';
      migStatus.innerHTML = `<strong>⚠ Failed:</strong> ${err.message}`;
      toast('Failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Run Pending Migrations';
    }
  } }, 'Run Pending Migrations');
  migPanel.appendChild(migBtn);
  migPanel.appendChild(migStatus);
  migPanel.appendChild(migOut);

  // Dedupe leads — merges any leads sharing a phone/email into the
  // oldest row, repoints bookings + calls + messages + nudges, and
  // deletes the dupes. Idempotent.
  const dedupeOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:240px;margin-top:8px' });
  const dedupeBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    if (!confirm('Find and merge duplicate leads across every tenant?\n\nThis groups leads by phone (then email), keeps the oldest, repoints all FK references, and deletes the dupes. Idempotent.')) return;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Merging…';
    try {
      const r = await api('/api/admin?action=dedupe-leads', { method: 'POST' });
      toast(`Merged ${r.merged_groups} groups · removed ${r.duplicates_removed} duplicate leads`);
      dedupeOut.style.display = 'block';
      dedupeOut.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      toast('Dedupe failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Merge Duplicate Leads';
    }
  } }, 'Merge Duplicate Leads');
  migPanel.appendChild(dedupeBtn);
  migPanel.appendChild(dedupeOut);

  // Dedupe contacts — groups contacts per-client by normalized phone
  // (digits + leading '+'), merges into the oldest row, repoints FK
  // references in messages/bookings/leads/vapi_calls/nudge_queue, and
  // deletes the dupes. Idempotent. Fixes the 'CSV re-upload created
  // duplicate contacts' problem iSlay hit.
  const dedupeContactsOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:240px;margin-top:8px' });
  const dedupeContactsBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    if (!confirm('Find and merge duplicate contacts across every tenant?\n\nGroups by normalized phone — collapses (555) 123-4567, +15551234567, 5551234567 onto one row. Keeps the oldest, repoints messages/bookings/leads/calls/nudges, deletes the dupes. Idempotent.')) return;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Merging contacts…';
    try {
      const r = await api('/api/admin?action=dedupe-contacts', { method: 'POST' });
      toast(`Merged ${r.merged_groups} contact groups · removed ${r.duplicates_removed} duplicates`);
      dedupeContactsOut.style.display = 'block';
      dedupeContactsOut.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      toast('Contact dedupe failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Merge Duplicate Contacts';
    }
  } }, 'Merge Duplicate Contacts');
  migPanel.appendChild(dedupeContactsBtn);
  migPanel.appendChild(dedupeContactsOut);

  // ─── Backfill external merch orders ───────────────────────────────
  // Scans recent Stripe Checkout Sessions on every connected account
  // and writes any that completed before the webhook fix shipped
  // (or before the Connect webhook was subscribed) into merch_orders.
  // Idempotent on stripe_payment_id — safe to re-run.
  const backfillOrdersOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:300px;margin-top:8px' });
  const backfillOrdersBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    if (!confirm('Scan recent Stripe sessions on every connected account and ingest any portal-external-checkout orders into the Merch → Orders tab?\n\nIdempotent — duplicate calls are no-ops.')) return;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Scanning Stripe…';
    try {
      const r = await api('/api/admin?action=backfill-external-merch-orders', {
        method: 'POST',
        body: { hours_back: 168, max_sessions: 100 }
      });
      const t = r.totals || {};
      toast(`Scanned ${t.scanned || 0} sessions · ingested ${t.ingested || 0} new · ${t.idempotent || 0} already present`);
      backfillOrdersOut.style.display = 'block';
      backfillOrdersOut.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      toast('Backfill failed: ' + err.message, true);
      backfillOrdersOut.style.display = 'block';
      backfillOrdersOut.textContent = 'Error: ' + err.message;
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Backfill Merch Orders';
    }
  } }, 'Backfill Merch Orders');
  migPanel.appendChild(backfillOrdersBtn);
  migPanel.appendChild(backfillOrdersOut);

  // ─── Stripe Connect status across every tenant ────────────────────
  // Quick read on which tenants have OAuthed Stripe in their Settings
  // panel and which haven't. Verifies charges_enabled live against
  // Stripe so a "connected but restricted" account is visible at a
  // glance — that's the same trap iSlay almost hit when the
  // stripe_secret_key gate was wrong.
  const connectOut = el('div', { style: 'display:none;margin-top:8px' });
  const connectBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Checking Stripe…';
    connectOut.style.display = 'block';
    connectOut.innerHTML = '<div class="muted" style="font-size:0.75rem;padding:8px">Loading tenant connection statuses…</div>';
    try {
      const r = await api('/api/admin?action=connect-status-all');
      const t = r.totals || {};
      toast(`${t.charges_live || 0} of ${t.tenants || 0} tenants charge-enabled · ${t.storefront_ready || 0} fully storefront-ready`);

      const cell = (text, color) => `<td style="padding:6px 10px;font-size:11px;color:${color || 'var(--text,#e0e0e0)'}">${text}</td>`;
      const yes = `<span style="color:#86efac">●</span>`;
      const no  = `<span style="color:#fca5a5">○</span>`;
      const warn = `<span style="color:#fbd38d">◐</span>`;
      const rows = (r.tenants || []).map(t => {
        let stripeIcon, stripeLabel;
        if (!t.connected_account) { stripeIcon = no; stripeLabel = 'Not connected'; }
        else if (t.stripe_error)   { stripeIcon = warn; stripeLabel = 'Connected · ' + t.stripe_error.slice(0, 40); }
        else if (t.charges_enabled === true) { stripeIcon = yes; stripeLabel = 'Charges live'; }
        else                       { stripeIcon = warn; stripeLabel = 'Onboarding incomplete'; }
        return `<tr style="border-top:1px solid rgba(255,255,255,0.05)">
          ${cell(`<strong>${t.name || t.slug}</strong><br><span class="muted" style="font-size:10px">${t.slug}</span>`)}
          ${cell(`${stripeIcon} ${stripeLabel}` + (t.connected_account ? `<br><span class="muted mono" style="font-size:9px">${t.connected_account}</span>` : ''))}
          ${cell(`${t.merch_products_active}/${t.merch_products}`, t.merch_products_active > 0 ? '#86efac' : 'var(--muted,#888)')}
          ${cell(t.twilio_configured ? yes + ' SMS' : no + ' No Twilio')}
          ${cell((t.platform_fee_pct ?? '—') + '%')}
        </tr>`;
      }).join('');
      connectOut.innerHTML = `
        <div style="background:rgba(0,0,0,0.3);border-radius:6px;padding:10px;font-size:12px">
          <div style="margin-bottom:8px;color:var(--muted,#888);font-size:11px">
            ● = charges live · ◐ = needs attention · ○ = not set
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="font-size:10px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:0.06em">
                ${cell('Tenant')}
                ${cell('Stripe Connect')}
                ${cell('Active/Total Products')}
                ${cell('SMS')}
                ${cell('Fee %')}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } catch (err) {
      connectOut.innerHTML = '<div class="err" style="padding:8px">Failed: ' + err.message + '</div>';
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Connect Status';
    }
  } }, 'Connect Status');
  migPanel.appendChild(connectBtn);
  migPanel.appendChild(connectOut);

  // ─── Stripe Webhook Health ────────────────────────────────────────
  // Lists every webhook endpoint configured on the platform Stripe
  // account and verifies the one pointing at portal.goelev8.ai is
  // (a) subscribed to checkout.session.completed AND (b) toggled to
  // listen on connected accounts. Without (b), iSlay / Will / Kenny's
  // payments never reach the ingest path and orders silently vanish.
  const webhookOut = el('div', { style: 'display:none;margin-top:8px' });
  const webhookBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Checking Stripe…';
    webhookOut.style.display = 'block';
    webhookOut.innerHTML = '<div class="muted" style="font-size:0.75rem;padding:8px">Loading webhook config…</div>';
    try {
      const r = await api('/api/admin?action=stripe-webhook-health');
      const verdictColor = r.ready ? '#86efac' : '#fbd38d';
      const verdictBg    = r.ready ? 'rgba(34,197,94,0.10)' : 'rgba(237,137,54,0.10)';
      const verdictBorder = r.ready ? 'rgba(34,197,94,0.35)' : 'rgba(237,137,54,0.35)';
      const verdictIcon  = r.ready ? '✓' : '⚠';
      const summary = r.ready ? 'Webhook is correctly configured' : 'Webhook needs attention';
      const endpointRows = (r.all_endpoints || []).map(ep => {
        const isPortal = ep.is_portal_url;
        const connectIcon = ep.receives_connect_events ? '<span style="color:#86efac">●</span>' : '<span style="color:#fca5a5">○</span>';
        const eventCount = ep.enabled_events.length;
        const hasCompleted = ep.enabled_events.includes('*') || ep.enabled_events.includes('checkout.session.completed');
        return `<tr style="border-top:1px solid rgba(255,255,255,0.05)${isPortal ? ';background:rgba(99,179,237,0.04)' : ''}">
          <td style="padding:6px 10px;font-size:11px"><span class="mono" style="font-size:10px">${ep.url}</span>${isPortal ? ' <span style="color:#63b3ed;font-size:9px">(portal)</span>' : ''}</td>
          <td style="padding:6px 10px;font-size:11px;text-align:center">${connectIcon}</td>
          <td style="padding:6px 10px;font-size:11px">${hasCompleted ? '<span style="color:#86efac">checkout ✓</span>' : '<span style="color:#fca5a5">checkout ✗</span>'} <span class="muted">· ${eventCount} events</span></td>
          <td style="padding:6px 10px;font-size:10px;color:${ep.status === 'enabled' ? '#86efac' : 'var(--muted,#888)'}">${ep.status}</td>
        </tr>`;
      }).join('');
      webhookOut.innerHTML = `
        <div style="padding:14px;background:${verdictBg};border:1px solid ${verdictBorder};border-radius:8px;font-size:0.85rem;line-height:1.5;color:${verdictColor};margin-bottom:10px">
          <div style="font-weight:600;margin-bottom:4px">${verdictIcon} ${summary}</div>
          <div style="color:#cbd5e1;font-size:0.78rem;line-height:1.5">${r.diagnosis}</div>
        </div>
        <div style="background:rgba(0,0,0,0.3);border-radius:6px;padding:10px;font-size:12px">
          <div style="margin-bottom:6px;color:var(--muted,#888);font-size:11px">
            Connect column: ● = receives connected account events · ○ = platform-only
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="font-size:10px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:0.06em">
              <th style="padding:6px 10px;text-align:left">URL</th>
              <th style="padding:6px 10px;text-align:center">Connect</th>
              <th style="padding:6px 10px;text-align:left">Events</th>
              <th style="padding:6px 10px;text-align:left">Status</th>
            </tr></thead>
            <tbody>${endpointRows || '<tr><td colspan="4" style="padding:10px;text-align:center;color:var(--muted,#888)">No webhooks configured</td></tr>'}</tbody>
          </table>
        </div>
      `;
    } catch (err) {
      webhookOut.innerHTML = '<div class="err" style="padding:8px">Failed: ' + err.message + '</div>';
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Stripe Webhook Health';
    }
  } }, 'Stripe Webhook Health');
  migPanel.appendChild(webhookBtn);
  migPanel.appendChild(webhookOut);

  // ─── Inspect Recent Stripe Sessions ────────────────────────────────
  // For a specific tenant, list recent Checkout Sessions on their
  // connected account with a verdict on whether each one made it into
  // merch_orders. Use this when "Backfill" reports zero scanned but
  // you know a customer paid — tells you exactly what Stripe thinks
  // happened.
  const inspectOut = el('div', { style: 'display:none;margin-top:8px' });
  const inspectBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const slug = prompt('Which tenant? (slug, e.g. islay-studios / flex-facility / willpower-fitness)');
    if (!slug) return;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Inspecting…';
    inspectOut.style.display = 'block';
    inspectOut.innerHTML = '<div class="muted" style="font-size:0.75rem;padding:8px">Loading…</div>';
    try {
      const r = await api('/api/admin?action=inspect-recent-stripe-sessions', {
        method: 'POST',
        body: { slug: slug.trim(), hours_back: 168 }
      });
      const sessions = r.sessions || [];
      const rowsHtml = sessions.map(s => {
        const verdictColor = s.verdict.startsWith('OK') ? '#86efac'
          : s.verdict.startsWith('NEEDS_BACKFILL') ? '#fbd38d' : 'var(--muted,#888)';
        const lineItemsHtml = (s.line_items || []).map(li =>
          `<div style="font-size:10px;color:#cbd5e1"><strong>${li.description || '?'}</strong> ×${li.quantity} @ $${((li.unit_amount || 0) / 100).toFixed(2)}</div>`
        ).join('') || '<span class="muted" style="font-size:10px">—</span>';
        const shippingHtml = s.amount_shipping
          ? `$${(s.amount_shipping / 100).toFixed(2)}`
          : '<span class="muted">no shipping</span>';
        return `<tr style="border-top:1px solid rgba(255,255,255,0.05);vertical-align:top">
          <td style="padding:6px 10px;font-size:10px"><span class="mono">${s.session_id.slice(-12)}</span><br><span class="muted" style="font-size:9px">${s.created.slice(0,16).replace('T',' ')}</span></td>
          <td style="padding:6px 10px;font-size:11px">${lineItemsHtml}</td>
          <td style="padding:6px 10px;font-size:11px">
            <div><span class="muted" style="font-size:9px">subtotal</span> $${((s.amount_subtotal || 0) / 100).toFixed(2)}</div>
            <div><span class="muted" style="font-size:9px">shipping</span> ${shippingHtml}</div>
            <div style="font-weight:600"><span class="muted" style="font-size:9px;font-weight:normal">total</span> $${((s.amount_total || 0) / 100).toFixed(2)}</div>
          </td>
          <td style="padding:6px 10px;font-size:11px">${s.metadata_source || '<span class="muted">—</span>'}<br><span class="muted" style="font-size:9px">${s.payment_status}</span></td>
          <td style="padding:6px 10px;font-size:10px;color:${verdictColor}">${s.verdict}</td>
        </tr>`;
      }).join('');
      inspectOut.innerHTML = `
        <div style="margin-bottom:8px;color:#cbd5e1;font-size:0.8rem">
          Tenant: <strong>${r.tenant?.name || slug}</strong> · scanned ${r.scanned} session(s) · <strong style="color:#fbd38d">${r.needs_backfill}</strong> need backfill
        </div>
        <div style="background:rgba(0,0,0,0.3);border-radius:6px;padding:10px;font-size:12px">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="font-size:10px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:0.06em">
              <th style="padding:6px 10px;text-align:left">Session</th>
              <th style="padding:6px 10px;text-align:left">Line items</th>
              <th style="padding:6px 10px;text-align:left">Amounts</th>
              <th style="padding:6px 10px;text-align:left">Source</th>
              <th style="padding:6px 10px;text-align:left">Verdict</th>
            </tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="4" style="padding:10px;text-align:center;color:var(--muted,#888)">No recent sessions</td></tr>'}</tbody>
          </table>
        </div>
      `;
    } catch (err) {
      inspectOut.innerHTML = '<div class="err" style="padding:8px">Failed: ' + err.message + '</div>';
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Inspect Stripe Sessions';
    }
  } }, 'Inspect Stripe Sessions');
  migPanel.appendChild(inspectBtn);
  migPanel.appendChild(inspectOut);

  // ─── Per-tenant Pickup Configuration ──────────────────────────────
  // Sets clients.pickup_enabled + pickup_location for a single tenant
  // so the Stripe Checkout shipping picker shows the custom label
  // ("Pick up at iSlay Studios — free") instead of the generic one.
  const pickupOut = el('div', { style: 'display:none;margin-top:8px' });
  const pickupBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const slug = prompt('Which tenant? (slug, e.g. islay-studios)');
    if (!slug) return;
    const loc = prompt('Pickup location? (shown on Stripe Checkout, e.g. "iSlay Studios, Springfield MO"). Leave blank for generic "Pick up in person".');
    if (loc === null) return;
    const enabled = confirm('Enable pickup option for this tenant? Click OK for ON, Cancel for OFF.\n\n(Default is ON. Click Cancel to hide pickup from the checkout picker.)');
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Saving…';
    pickupOut.style.display = 'block';
    pickupOut.innerHTML = '<div class="muted" style="font-size:0.75rem;padding:8px">Updating…</div>';
    try {
      const r = await api('/api/admin?action=set-pickup', {
        method: 'POST',
        body: { slug: slug.trim(), pickup_enabled: enabled, pickup_location: loc.trim() }
      });
      toast(`Pickup config updated for ${r.client?.name || slug}`);
      pickupOut.innerHTML = '<pre style="background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto">' + JSON.stringify(r.client, null, 2) + '</pre>';
    } catch (err) {
      pickupOut.innerHTML = '<div class="err" style="padding:8px">Failed: ' + err.message + '</div>';
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Pickup Config';
    }
  } }, 'Pickup Config');
  migPanel.appendChild(pickupBtn);
  migPanel.appendChild(pickupOut);

  // ─── Backfill Booking Times (timezone fix) ────────────────────────
  // Re-derives bookings.starts_at from bookings.booking_date for any
  // row where they disagree. Fixes the legacy WPFF widget bug where
  // 'new Date(date+time).toISOString()' on a UTC Vercel server stored
  // 3pm CDT as 15:00 UTC — the portal then displayed it as 10am.
  // The fix landed in the widget on 2026-06-16, but bookings placed
  // before that still need this backfill to round-trip correctly.
  // Idempotent: rows already correct are skipped.
  const tzBackfillOut = el('div', { style: 'display:none;margin-top:8px' });
  const tzBackfillBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const slug = prompt('Which tenant slug? (e.g. willpower-fitness — leave blank for ALL tenants)') || '';
    const dryRun = confirm('Click OK for DRY RUN (preview without writing).\n\nClick Cancel to actually write the corrections.');
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Scanning…';
    tzBackfillOut.style.display = 'block';
    tzBackfillOut.innerHTML = '<div class="muted" style="font-size:0.75rem;padding:8px">Comparing each booking_date string against the stored UTC and computing corrections…</div>';
    try {
      const body = { dry_run: dryRun, limit: 5000 };
      if (slug.trim()) body.slug = slug.trim();
      const r = await api('/api/admin?action=backfill-booking-times', { method: 'POST', body });
      toast(`${dryRun ? 'Dry run' : 'Fixed'} ${r.fixed} of ${r.inspected} bookings · ${r.skipped} already correct · ${r.unparseable} unparseable`);
      const sampleRows = (r.sample_corrections || []).map(s =>
        `<tr style="border-top:1px solid rgba(255,255,255,0.05)">
          <td style="padding:4px 8px;font-size:10px">${s.lead_name || s.id.slice(-8)}</td>
          <td style="padding:4px 8px;font-size:10px">${s.booking_date}</td>
          <td style="padding:4px 8px;font-size:10px;color:#fca5a5">${s.old_starts_at}</td>
          <td style="padding:4px 8px;font-size:10px;color:#86efac">${s.new_starts_at}</td>
        </tr>`).join('');
      tzBackfillOut.innerHTML = `
        <div style="padding:10px;background:${dryRun ? 'rgba(99,179,237,0.10)' : 'rgba(34,197,94,0.10)'};border:1px solid ${dryRun ? 'rgba(99,179,237,0.35)' : 'rgba(34,197,94,0.35)'};border-radius:6px;font-size:0.78rem;margin-bottom:10px;color:#cbd5e1">
          ${dryRun ? 'DRY RUN — nothing was written.' : '✓ Corrections applied.'} <strong>${r.fixed}</strong> of ${r.inspected} bookings ${dryRun ? 'would be' : 'were'} fixed · ${r.skipped} already correct.
        </div>
        ${sampleRows ? `
          <div style="background:rgba(0,0,0,0.3);border-radius:6px;padding:8px;font-size:11px">
            <div style="margin-bottom:6px;color:var(--muted,#888);font-size:10px">Sample (first 10):</div>
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="font-size:9px;color:var(--muted,#888);text-transform:uppercase">
                <th style="padding:4px 8px;text-align:left">Lead</th>
                <th style="padding:4px 8px;text-align:left">Wall time</th>
                <th style="padding:4px 8px;text-align:left">Old UTC</th>
                <th style="padding:4px 8px;text-align:left">New UTC</th>
              </tr></thead>
              <tbody>${sampleRows}</tbody>
            </table>
          </div>` : ''}
      `;
    } catch (err) {
      tzBackfillOut.innerHTML = '<div class="err" style="padding:8px">Failed: ' + err.message + '</div>';
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Backfill Booking Times';
    }
  } }, 'Backfill Booking Times');
  migPanel.appendChild(tzBackfillBtn);
  migPanel.appendChild(tzBackfillOut);

  // ─── Inspect a Single Booking (timezone debug) ────────────────────
  // Use when 'Backfill Booking Times' didn't help and the operator
  // still sees a wrong time on one specific booking. Tells us
  // exactly what's in the DB, what the regex sees, and what the fix
  // would compute.
  const inspectBookingOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:360px;margin-top:8px' });
  const inspectBookingBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const choice = prompt('Inspect by booking_id OR most-recent booking for a tenant slug?\n\nEnter a booking UUID, OR enter "slug:willpower-fitness" (or any slug) to inspect the most recent booking for that tenant.\n\nLeave blank to cancel.');
    if (!choice) return;
    const body = {};
    if (choice.toLowerCase().startsWith('slug:')) body.slug = choice.slice(5).trim();
    else body.booking_id = choice.trim();
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Inspecting…';
    try {
      const r = await api('/api/admin?action=inspect-booking', { method: 'POST', body });
      inspectBookingOut.style.display = 'block';
      inspectBookingOut.textContent = JSON.stringify(r, null, 2);
      toast(r.verdict || 'See output below', !r.verdict?.startsWith('OK'));
    } catch (err) {
      inspectBookingOut.style.display = 'block';
      inspectBookingOut.textContent = 'Failed: ' + err.message;
      toast('Failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Inspect Booking';
    }
  } }, 'Inspect Booking');
  migPanel.appendChild(inspectBookingBtn);
  migPanel.appendChild(inspectBookingOut);

  // ─── Provision Tenant ─────────────────────────────────────────────
  // Manual trigger for lib/provisioning.js. Wires brand fields onto
  // the clients row, moves uploaded assets into client-assets/<slug>/,
  // registers the requested domain, verifies Stripe Connect, seeds
  // keywords (client + iSlay Studios + Claude-generated), writes a
  // provisioning_log row, and emails ab@goelev8.ai a summary.
  // Idempotent — safe to re-run on an already-provisioned client.
  const provisionOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:360px;margin-top:8px' });
  const provisionBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const choice = prompt('Provision tenant by slug or by client UUID:\n\nEnter "slug:locs-and-wellness" or paste a clients.id UUID.\nLeave blank to cancel.');
    if (!choice) return;
    const body = {};
    if (choice.toLowerCase().startsWith('slug:')) body.slug = choice.slice(5).trim();
    else body.client_id = choice.trim();
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Provisioning…';
    try {
      const r = await api('/api/admin?action=provision-tenant', { method: 'POST', body });
      provisionOut.style.display = 'block';
      provisionOut.textContent = JSON.stringify(r, null, 2);
      const okCount = (r.completed || []).length;
      const errCount = (r.errors || []).length;
      toast(`Provisioned ${r.business_name || r.slug || ''} — ${okCount} steps, ${errCount} error${errCount === 1 ? '' : 's'}`, errCount > 0);
    } catch (err) {
      provisionOut.style.display = 'block';
      provisionOut.textContent = 'Failed: ' + err.message;
      toast('Failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Provision Tenant';
    }
  } }, 'Provision Tenant');
  migPanel.appendChild(provisionBtn);
  migPanel.appendChild(provisionOut);

  // ─── Backfill Leads → Contacts ────────────────────────────────────
  // Inserts a contacts row for every lead that doesn't already have
  // one, so legacy leads (submitted before lead-intake started
  // auto-creating contacts) show up in the SMS Blasts → Contacts list.
  // Idempotent — leads with a matching contact are skipped.
  const leadsToContactsOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:240px;margin-top:8px' });
  const leadsToContactsBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    const slug = prompt('Tenant slug to backfill (leave blank for ALL tenants):') || '';
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Backfilling…';
    try {
      const body = {};
      if (slug.trim()) body.slug = slug.trim();
      const r = await api('/api/admin?action=backfill-leads-to-contacts', { method: 'POST', body });
      toast(`Inserted ${r.inserted} contacts (${r.already_present} already there, ${r.skipped} skipped)`);
      leadsToContactsOut.style.display = 'block';
      leadsToContactsOut.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      toast('Backfill failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Backfill Leads → Contacts';
    }
  } }, 'Backfill Leads → Contacts');
  migPanel.appendChild(leadsToContactsBtn);
  migPanel.appendChild(leadsToContactsOut);

  // Ensure every tenant has the standard tab set. After shipping a new
  // feature (Leads, Bookings, Analytics, etc.) click this to push the
  // tab into every tenant's sidebar without per-tenant SQL.
  const tabsOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:240px;margin-top:8px' });
  const tabsBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Updating…';
    try {
      const r = await api('/api/admin?action=ensure-portal-tabs', { method: 'POST' });
      toast(`Updated ${r.tenants_updated} tenants — every portal now exposes overview/leads/messaging/bookings/analytics/settings`);
      tabsOut.style.display = 'block';
      tabsOut.textContent = JSON.stringify(r, null, 2);
    } catch (err) {
      toast('Failed: ' + err.message, true);
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Sync Tabs to All Tenants';
    }
  } }, 'Sync Tabs to All Tenants');
  migPanel.appendChild(tabsBtn);
  migPanel.appendChild(tabsOut);

  // Open the cross-tenant Trash view (soft-deleted records, last 30 days).
  const trashBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: () => openTrashView() }, '🗑 View Trash (30d)');
  migPanel.appendChild(trashBtn);

  // Verify migrations — probes the live DB for every artifact the
  // migration runner is supposed to have installed and renders a
  // pass/fail checklist. Operators click this AFTER Run Pending
  // Migrations to confirm the schema actually landed instead of
  // guessing. Replaces the now-redundant "Onboard Will Power"
  // button since Will is fully onboarded; re-onboarding adds no
  // value.
  const verifyStatus = el('div', { style: 'display:none;margin-top:12px;padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5' });
  const verifyChecks = el('div', { style: 'display:none;margin-top:8px;background:rgba(0,0,0,0.25);padding:12px 14px;border-radius:6px;font-size:12px;max-height:340px;overflow:auto' });
  const verifyBtn = el('button', { class: 'btn', style: 'margin-left:8px', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Verifying…';
    verifyStatus.style.display = 'block';
    verifyStatus.style.background = 'rgba(255,255,255,0.04)';
    verifyStatus.style.border = '1px solid rgba(255,255,255,0.08)';
    verifyStatus.style.color = 'var(--text-mute,#9ca3af)';
    verifyStatus.textContent = 'Checking…';
    verifyChecks.style.display = 'none';
    try {
      const r = await api('/api/admin?action=verify-migrations');
      const passed = r.summary?.passed || 0;
      const failed = r.summary?.failed || 0;
      const total  = r.summary?.total  || 0;
      if (r.healthy) {
        verifyStatus.style.background = 'rgba(34,197,94,0.10)';
        verifyStatus.style.border = '1px solid rgba(34,197,94,0.35)';
        verifyStatus.style.color = '#86efac';
        verifyStatus.innerHTML =
          `<strong>✓ All ${total} checks passed.</strong><br/>` +
          `<span style="opacity:0.85;font-size:12px">Schema + tenant config are healthy.</span>`;
      } else {
        verifyStatus.style.background = 'rgba(239,68,68,0.10)';
        verifyStatus.style.border = '1px solid rgba(239,68,68,0.35)';
        verifyStatus.style.color = '#fca5a5';
        verifyStatus.innerHTML =
          `<strong>⚠ ${failed} of ${total} checks failed.</strong><br/>` +
          `<span style="opacity:0.85;font-size:12px">${passed} passed. Failures detailed below.</span>`;
      }
      verifyChecks.innerHTML = (r.checks || []).map(c =>
        `<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
           <span style="font-size:14px;color:${c.ok ? '#86efac' : '#fca5a5'};flex-shrink:0">${c.ok ? '✓' : '✗'}</span>
           <div style="flex:1;min-width:0">
             <div style="font-weight:500">${c.name}</div>
             <div class="muted" style="font-size:11px;word-break:break-word">${c.detail || ''}</div>
           </div>
         </div>`
      ).join('');
      verifyChecks.style.display = 'block';
    } catch (err) {
      verifyStatus.style.background = 'rgba(239,68,68,0.10)';
      verifyStatus.style.border = '1px solid rgba(239,68,68,0.35)';
      verifyStatus.style.color = '#fca5a5';
      verifyStatus.innerHTML = `<strong>⚠ Verify failed:</strong> ${err.message}`;
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = '✅ Verify Migrations';
    }
  } }, '✅ Verify Migrations');
  migPanel.appendChild(verifyBtn);
  migPanel.appendChild(verifyStatus);
  migPanel.appendChild(verifyChecks);

  wrap.appendChild(migPanel);

  // ----- Onboarding payment link (one-click Stripe setup) -----
  const onbPanel = el('div', { class: 'panel' });
  onbPanel.appendChild(el('h2', {}, '💳 Onboarding Payment Link'));
  onbPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
    'Creates the Stripe products, FOUNDING coupon, and Payment Link for the GoElev8.ai onboarding flow ($400 setup → $200 with Founding discount + $99/month subscription). Idempotent — re-clicking returns the existing link.'));
  const onbOut = el('div', {});
  const onbBtn = el('button', { class: 'btn primary', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Setting up Stripe…';
    try {
      const r = await api('/api/admin?action=create-onboarding-link', { method: 'POST' });
      onbOut.innerHTML = '';
      onbOut.appendChild(el('div', { class: 'reserve-setup-banner', style: 'margin-top:12px;background:rgba(0,207,255,0.06);border-color:rgba(0,207,255,0.4)' },
        el('strong', { style: 'color:var(--brand-1,#00CFFF)' }, '✅ Payment link ready' + (r.reused ? ' (reusing existing)' : '')),
        el('div', { style: 'margin:8px 0;font-size:0.85rem' },
          el('strong', {}, 'Mode: '), r.mode === 'test' ? '🧪 TEST mode' : '🟢 LIVE mode'
        ),
        el('div', { style: 'margin:6px 0;font-size:0.85rem;word-break:break-all' },
          el('a', { href: r.payment_link_url, target: '_blank', rel: 'noopener',
                    style: 'color:var(--brand-1,#00CFFF);font-weight:600' },
            r.payment_link_url)
        ),
        el('div', { style: 'display:flex;gap:6px;margin-top:8px' },
          el('button', { class: 'btn sm', onclick: () => {
            navigator.clipboard.writeText(r.payment_link_url).then(() => toast('Copied to clipboard'));
          } }, 'Copy URL'),
          el('a', { class: 'btn sm primary', target: '_blank', rel: 'noopener',
                    href: r.mode === 'test'
                      ? 'https://dashboard.stripe.com/test/payment-links'
                      : 'https://dashboard.stripe.com/payment-links' },
            'Open Stripe Dashboard')
        ),
        el('div', { style: 'margin-top:10px;font-size:0.75rem;color:var(--text-mute,#888)' },
          'Onboarding price: ' + (r.onboarding?.price || '—') + ' · ' +
          'Growth price: ' + (r.growth?.price || '—') + ' · ' +
          'Coupon: ' + (r.coupon || '—'))
      ));
      toast(r.reused ? 'Reusing existing payment link' : 'Created payment link');
    } catch (err) {
      onbOut.innerHTML = '';
      onbOut.appendChild(el('div', { class: 'err', style: 'margin-top:12px' },
        '❌ Failed: ' + err.message + '. Confirm STRIPE_SECRET_KEY is set in Vercel and the function has been redeployed since adding it.'));
    } finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = 'Create / Refresh Payment Link';
    }
  } }, 'Create / Refresh Payment Link');
  onbPanel.appendChild(onbBtn);
  onbPanel.appendChild(onbOut);
  wrap.appendChild(onbPanel);

  // ----- Twilio Reserve (platform-wide accounting) -----
  const reservePanel = el('div', { class: 'panel twilio-reserve-panel' });
  reservePanel.appendChild(el('h2', {}, '📡 Twilio Reserve'));
  reservePanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
    'How much of incoming Stripe revenue is auto-reserved to cover Twilio SMS costs. The Reserved bucket grows on each credit-pack purchase and shrinks on each SMS send. Anything above the reserve is true platform margin.'));

  // Per-segment cost editor — drives both the live trigger and the
  // backfill helper. Default is 1¢; if Twilio is actually charging you
  // more (e.g. 2¢ for US carriers, more for international), set it
  // here so the reserve numbers actually reflect reality.
  const costInput = el('input', {
    type: 'number', min: '0', max: '100', step: '1',
    placeholder: '1',
    style: 'width:80px;padding:6px 8px;background:var(--bg-1,#0d1117);border:1px solid var(--border,#2a3a5c);border-radius:6px;color:var(--text,#e0e0e0);font-size:0.85rem'
  });
  const costStatus = el('span', { class: 'muted', style: 'font-size:0.75rem' }, 'Loading current cost…');
  api('/api/admin?action=twilio-cost').then(r => {
    costInput.value = String(r.effective_cents ?? 1);
    costStatus.textContent = r.db_setting_cents != null
      ? `Current: ${r.db_setting_cents}¢/segment (set in DB)`
      : `Current: ${r.effective_cents}¢/segment (env var fallback — set a value below to persist in DB)`;
  }).catch(() => { costStatus.textContent = 'Cost setting unavailable'; });

  const saveCostBtn = el('button', { class: 'btn sm', onclick: async () => {
    const cents = parseInt(costInput.value, 10);
    if (!Number.isFinite(cents) || cents < 0) { toast('Enter a non-negative integer', true); return; }
    saveCostBtn.disabled = true; saveCostBtn.textContent = 'Saving + rebuilding…';
    try {
      await api('/api/admin?action=twilio-cost', { method: 'POST', body: { cents } });
      // Cost change → rebuild from history so existing reserve totals
      // get re-priced at the new rate immediately.
      const r = await api('/api/admin?action=backfill-twilio-reserve', { method: 'POST' });
      toast(`Set Twilio cost to ${cents}¢/segment. Rebuilt ${r.processed} clients.`);
      render();
    } catch (e) { toast('Failed: ' + e.message, true); }
    finally { saveCostBtn.disabled = false; saveCostBtn.textContent = 'Save + Rebuild'; }
  } }, 'Save + Rebuild');

  reservePanel.appendChild(el('div', { class: 'twilio-cost-row' },
    el('label', { style: 'font-size:0.8rem;font-weight:600' }, 'Twilio cost per segment (¢):'),
    costInput,
    saveCostBtn,
    costStatus
  ));

  const reserveBody = el('div', {}, el('div', { class: 'muted' }, 'Loading…'));
  reservePanel.appendChild(reserveBody);

  const backfillBtn = el('button', { class: 'btn sm', style: 'margin-top:12px', onclick: async (e) => {
    if (!confirm('Rebuild Twilio reserve from existing credit_ledger history?\n\nThis is idempotent and safe.')) return;
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Rebuilding…';
    try {
      const r = await api('/api/admin?action=backfill-twilio-reserve', { method: 'POST' });
      toast(`Rebuilt ${r.processed} clients. Reserved $${(r.reserved_cents_total/100).toFixed(2)}, used $${(r.used_cents_total/100).toFixed(2)}.`);
      render();
    } catch (err) { toast('Backfill failed: ' + err.message, true); }
  } }, 'Rebuild from history');
  reservePanel.appendChild(backfillBtn);

  // Diagnose & repair — checks every piece of the reserve plumbing
  // (column / table / function / trigger / RPC / cost setting / row
  // counts), reports what's broken, and on confirmation re-creates
  // the missing pieces idempotently + backfills.
  const diagOut = el('pre', { style: 'display:none;background:rgba(0,0,0,0.35);padding:12px;border-radius:6px;font-size:0.7rem;overflow:auto;max-height:320px;margin-top:10px' });
  const diagBtn = el('button', { class: 'btn sm', style: 'margin-top:12px;margin-left:8px', onclick: async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Diagnosing…';
    try {
      const d = await api('/api/admin?action=twilio-reserve-diagnose');
      diagOut.style.display = 'block';
      diagOut.textContent = JSON.stringify(d, null, 2);
      const broken = [
        !d.checks.column_clients_twilio_reserve_cents && 'column missing',
        !d.checks.table_twilio_reserves && 'reserve table missing',
        !d.checks.fn_debit_twilio_reserve_on_sms && 'trigger function missing',
        !d.checks.trigger_credit_ledger_debit_reserve && 'trigger missing',
        !d.checks.fn_adjust_twilio_reserve && 'adjust RPC missing'
      ].filter(Boolean);
      if (broken.length) {
        if (confirm('Twilio reserve is broken: ' + broken.join(', ') + '.\n\nRepair now? This re-creates the missing DB pieces (idempotent) and backfills the reserve from credit_ledger history.')) {
          e.currentTarget.textContent = 'Repairing…';
          const r = await api('/api/admin?action=twilio-reserve-diagnose', { method: 'POST' });
          diagOut.textContent = JSON.stringify(r, null, 2);
          toast('Repair complete: ' + (r.diagnosis || 'see details below'));
          render();
        }
      } else {
        toast(d.diagnosis);
      }
    } catch (err) { toast('Diagnose failed: ' + err.message, true); }
    finally {
      e.currentTarget.disabled = false;
      e.currentTarget.textContent = '🩺 Diagnose & Repair';
    }
  } }, '🩺 Diagnose & Repair');
  reservePanel.appendChild(diagBtn);
  reservePanel.appendChild(diagOut);

  wrap.appendChild(reservePanel);

  // Load reserve data
  (async () => {
    try {
      const r = await api('/api/portal/twilio-reserve');
      reserveBody.innerHTML = '';

      // Setup-not-ready states get a clear banner + one-click fix.
      // Without this branch the panel renders silent zeros and the
      // operator can't tell whether the reserve genuinely is empty
      // or the migration just hasn't run.
      if (r.setup_status === 'column_missing' || r.setup_status === 'table_missing') {
        const banner = el('div', { class: 'reserve-setup-banner' },
          el('strong', {}, '⚠️ Setup not complete'),
          el('div', { style: 'margin:6px 0 12px;font-size:0.85rem' },
            r.setup_message || 'Migration 0022 has not been fully applied yet.'
          ),
          el('button', { class: 'btn primary', onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            ev.currentTarget.textContent = 'Repairing…';
            try {
              const fix = await api('/api/admin?action=twilio-reserve-diagnose', { method: 'POST' });
              const failedSteps = (fix.repairs || []).filter(s => !s.ok);
              if (failedSteps.length) {
                toast(`Repair failed at: ${failedSteps[0].step}. Check SUPABASE_ACCESS_TOKEN env var in Vercel.`, true);
              } else {
                toast('Reserve repaired — refreshing…');
              }
              render();
            } catch (e) { toast('Repair failed: ' + e.message, true); }
          } }, 'Repair Now')
        );
        reserveBody.appendChild(banner);
        return;
      }

      const fmt = (c) => '$' + ((c || 0) / 100).toFixed(2);
      reserveBody.appendChild(el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:12px' },
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value' }, fmt(r.reserved_total_cents)),
          el('span', { class: 'metric-stat-label' }, 'Reserved (lifetime)')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat' },
          el('span', { class: 'metric-stat-value' }, fmt(r.used_total_cents)),
          el('span', { class: 'metric-stat-label' }, 'Used on SMS')
        ),
        el('div', { class: 'metric-divider' }),
        el('div', { class: 'metric-stat accent' },
          el('span', { class: 'metric-stat-value' }, fmt(r.balance_cents)),
          el('span', { class: 'metric-stat-label' }, 'Currently Reserved')
        )
      ));
      if (r.by_client?.length) {
        reserveBody.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Client'), el('th', {}, 'Reserved Balance')
          )),
          el('tbody', {}, ...r.by_client.map(c => el('tr', {},
            el('td', {}, c.name),
            el('td', { style: 'font-weight:600' }, fmt(c.balance_cents))
          )))
        ));
      }
    } catch (e) {
      reserveBody.innerHTML = '';
      reserveBody.appendChild(el('p', { class: 'err' }, 'Failed to load: ' + e.message +
        ' — run migration 0022_twilio_reserve.sql in Supabase, then click Rebuild from history.'));
    }
  })();

  // ----- Client Accounts (clean card grid with logos) -----
  // Per-tenant config (GA4 ID, Stripe key, Booking URL, billing pause)
  // moved into a Settings modal opened from each card so the grid
  // surface only shows the at-a-glance info.
  const tablePanel = el('div', { class: 'panel client-mgmt-panel' });
  tablePanel.appendChild(el('h2', {}, 'Client Accounts'));
  tablePanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:14px' },
    'Click any card\'s ⚙ Settings button for per-tenant config (GA4, Stripe, Booking URL, pause billing).'));
  const cardGridHost = el('div', {}, el('div', { class: 'muted' }, 'Loading…'));
  tablePanel.appendChild(cardGridHost);
  wrap.appendChild(tablePanel);

  let allClients = [];
  const onClientsLoaded = [];
  const refresh = async () => {
    const r = await api('/api/admin?action=list-clients');
    allClients = (r.clients || []).filter(c =>
      c.slug !== 'dlp' && (c.name || '').toLowerCase() !== 'dlp'
    );
    for (const fn of onClientsLoaded) { try { fn(allClients); } catch {} }
    cardGridHost.innerHTML = '';
    if (!allClients.length) {
      cardGridHost.appendChild(el('div', { class: 'muted' }, 'No clients yet.'));
      return;
    }
    const grid = el('div', { class: 'admin-clients-grid' },
      ...allClients.map(c => renderAdminClientCard(c, refresh))
    );
    cardGridHost.appendChild(grid);
  };
  refresh().catch((e) => { cardGridHost.innerHTML = ''; cardGridHost.appendChild(el('div', { class: 'err' }, e.message)); });

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
// MASTER ADMIN — GoElev8 platform revenue dashboard ("Sales" tab).
// Aggregates every source of income across all tenants. Hidden from
// ============================================================
// TAES — The AI Exit Strategy admin (roster, participant detail, attention,
// partner stats). Data comes from api/admin.js taes-* actions, which proxy the
// TAES app's read-only /api/portal API. Admin-only (router gates by isAdmin).
// ============================================================
function taesFmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function taesKV(obj, skip = []) {
  const rows = Object.entries(obj || {})
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => el('tr', {},
      el('td', { class: 'muted', style: 'white-space:nowrap;padding-right:12px;vertical-align:top' }, k),
      el('td', {}, typeof v === 'object' ? JSON.stringify(v) : String(v))));
  return rows.length ? el('table', {}, el('tbody', {}, ...rows)) : el('p', { class: 'muted' }, 'None.');
}

// TAES email composer — small modal for sending a transactional email
// to a participant. Uses the portal's shared mailer (Resend + BCC to
// the operator per policy). Prefills the participant's email; subject
// + body are typed by the operator. Best-effort — the operator sees
// success/failure in a toast.
function openTaesEmailComposer(p) {
  const overlay = el('div', { class: 'new-message-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const card = el('div', { class: 'new-message-card' });

  const toInput = el('input', { type: 'email', value: p.email || '', style: 'width:100%' });
  const subjectInput = el('input', {
    type: 'text', placeholder: 'e.g. Following up on Module 3',
    style: 'width:100%'
  });
  const bodyInput = el('textarea', {
    placeholder: 'Type your message…', rows: 8,
    style: 'width:100%;resize:vertical;min-height:180px'
  });
  const errBox = el('div', { style: 'font-size:13px;min-height:18px;margin-top:8px' });
  const sendBtn = el('button', { class: 'btn primary' }, 'Send Email');

  sendBtn.onclick = async () => {
    errBox.innerHTML = '';
    if (!toInput.value.trim())     { errBox.innerHTML = '<div class="err">Recipient required.</div>'; return; }
    if (!subjectInput.value.trim()){ errBox.innerHTML = '<div class="err">Subject required.</div>'; return; }
    if (!bodyInput.value.trim())   { errBox.innerHTML = '<div class="err">Message body required.</div>'; return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      await api('/api/admin?action=taes-send-email', {
        method: 'POST',
        body: {
          to:      toInput.value.trim(),
          subject: subjectInput.value.trim(),
          body:    bodyInput.value.trim()
        }
      });
      toast('Email sent to ' + toInput.value.trim());
      close();
    } catch (e) {
      errBox.innerHTML = '<div class="err">' + (e.message || 'Send failed') + '</div>';
      sendBtn.disabled = false; sendBtn.textContent = 'Send Email';
    }
  };

  card.appendChild(el('div', { class: 'new-message-header' },
    el('h2', {}, '📧 Email ' + (p.name || 'participant')),
    el('button', { class: 'btn ghost sm', onclick: close, title: 'Close' }, '×')));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'To'), toInput));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Subject'), subjectInput));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Message'), bodyInput));
  card.appendChild(errBox);
  card.appendChild(el('div', { class: 'new-message-actions' },
    el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
    sendBtn));
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => subjectInput.focus(), 60);
}

// TAES SMS composer — sends from the ai-exit-strategy tenant's Twilio
// number. Free send (no credit debit). Prefills the participant's
// phone; the operator types the body. 160-char SMS ceiling is enforced
// server-side but a live counter here helps the operator see the limit.
function openTaesSmsComposer(p) {
  const overlay = el('div', { class: 'new-message-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const card = el('div', { class: 'new-message-card' });

  const phoneInput = el('input', { type: 'tel', value: p.phone || '', style: 'width:100%' });
  const bodyInput = el('textarea', {
    placeholder: 'Type your message…', rows: 5,
    style: 'width:100%;resize:vertical;min-height:110px'
  });
  const segHint = el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' });
  bodyInput.addEventListener('input', () => {
    const len = bodyInput.value.length;
    segHint.textContent = len ? `${len}/160 chars${len > 160 ? ' — will be truncated' : ''}` : '';
    segHint.style.color = len > 160 ? '#fca5a5' : '';
  });
  const errBox = el('div', { style: 'font-size:13px;min-height:18px;margin-top:8px' });
  const sendBtn = el('button', { class: 'btn primary' }, 'Send SMS');

  sendBtn.onclick = async () => {
    errBox.innerHTML = '';
    if (!phoneInput.value.trim()) { errBox.innerHTML = '<div class="err">Phone required.</div>'; return; }
    if (!bodyInput.value.trim())  { errBox.innerHTML = '<div class="err">Message required.</div>'; return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      await api('/api/admin?action=taes-send-sms', {
        method: 'POST',
        body: { to: phoneInput.value.trim(), body: bodyInput.value.trim() }
      });
      toast('SMS sent to ' + phoneInput.value.trim());
      close();
    } catch (e) {
      const msg = String(e.message || '');
      if (/no_twilio_number_on_taes_tenant/.test(msg)) {
        errBox.innerHTML = '<div class="err">The AI Exit Strategy tenant doesn\'t have a Twilio phone number set. Add one in Master Admin → clients before sending SMS from this tab.</div>';
      } else {
        errBox.innerHTML = '<div class="err">' + msg + '</div>';
      }
      sendBtn.disabled = false; sendBtn.textContent = 'Send SMS';
    }
  };

  card.appendChild(el('div', { class: 'new-message-header' },
    el('h2', {}, '💬 SMS ' + (p.name || 'participant')),
    el('button', { class: 'btn ghost sm', onclick: close, title: 'Close' }, '×')));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'To'), phoneInput));
  card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Message'), bodyInput, segHint));
  card.appendChild(errBox);
  card.appendChild(el('div', { class: 'new-message-actions' },
    el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
    sendBtn));
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  setTimeout(() => bodyInput.focus(), 60);
}

// Two-step delete confirm. First click asks "sure?"; second click within
// 3 seconds fires the DELETE. Matches the destructive-action pattern
// used elsewhere in the app (no browser confirm(); dialog which some
// mobile browsers strip out on installed PWAs).
async function taesDeleteParticipant(p, onDeleted) {
  if (!confirm(`Delete ${p.name || 'this participant'} from The AI Exit Strategy?\n\nThis removes them + every module, quiz, session, and profile they submitted. This cannot be undone.`)) {
    return;
  }
  try {
    await api('/api/admin?action=taes-delete-participant', {
      method: 'POST', body: { id: p.id || p.participantId }
    });
    toast('Deleted ' + (p.name || 'participant'));
    if (typeof onDeleted === 'function') onDeleted();
  } catch (e) {
    toast('Delete failed: ' + (e.message || 'unknown'), true, 6000);
  }
}

// Open a participant's profile in a modal pop-up. Loads the full
// participant record + progress + assessment, then renders the
// "fun" profile card with a gradient hero, big avatar, and inline
// upload. onDeleted (optional) is called after a successful delete
// so the caller can refresh the roster.
async function openTaesProfileModal(participantId, opts) {
  const onDeleted = (opts && opts.onDeleted) || null;

  const modal = el('div', { class: 'modal taes-profile-modal', style:
    'width:min(680px,94vw);max-height:92vh;overflow-y:auto;padding:0;' +
    'border-radius:16px;background:#0d1117;box-shadow:0 20px 60px rgba(0,0,0,0.6)' });
  const bg = el('div', {
    class: 'modal-bg',
    style: 'background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)',
    onclick: (e) => { if (e.target === bg) bg.remove(); }
  }, modal);
  document.body.appendChild(bg);

  // Loading placeholder so the modal feels responsive while the
  // fetch is in flight.
  modal.appendChild(el('div', { style: 'padding:60px;text-align:center' },
    el('div', { class: 'muted' }, 'Loading profile…')));

  try {
    const d = await api('/api/admin?action=taes-participant&id=' + encodeURIComponent(participantId) + '&full=1');
    modal.replaceChildren(...taesProfileNodes(d, {
      onDeleted: () => { bg.remove(); if (onDeleted) onDeleted(); },
      onClose: () => bg.remove()
    }));
  } catch (e) {
    modal.replaceChildren(el('div', { style: 'padding:24px' },
      el('h2', {}, 'Could not load profile'),
      el('p', { class: 'err' }, e.message || 'unknown'),
      el('button', { class: 'btn', onclick: () => bg.remove() }, 'Close')));
  }
}

// Two initials for the placeholder avatar (when no photo_url is set).
// Falls back to "?" if we can't extract anything.
function taesInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  return ((parts[0][0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// Deterministic pastel color from the name so the placeholder avatar
// varies per participant but stays stable for the same person.
function taesAvatarColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return `hsl(${h % 360}, 70%, 60%)`;
}

// Kick off a file picker + upload for a participant's profile photo.
// Reads the file as a data URL, POSTs to /api/admin?action=taes-upload
// -photo, and calls onUploaded(url) with the new public URL on success.
async function taesPickAndUploadPhoto(participantId, onUploaded) {
  const MAX_BYTES = 10 * 1024 * 1024;
  return new Promise((resolve) => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/gif,image/webp,image/heic';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) { resolve(null); return; }
      if (file.size > MAX_BYTES) {
        toast(`Photo too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`, true);
        resolve(null); return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await api('/api/admin?action=taes-upload-photo', {
            method: 'POST',
            body: { id: participantId, data_url: reader.result, filename: file.name }
          });
          const url = r?.url || r?.photo_url || null;
          if (url && typeof onUploaded === 'function') onUploaded(url);
          toast('Photo updated');
          resolve(url);
        } catch (e) {
          toast('Upload failed: ' + (e.message || 'unknown'), true);
          resolve(null);
        }
      };
      reader.onerror = () => { toast('Could not read image.', true); resolve(null); };
      reader.readAsDataURL(file);
    };
    picker.click();
  });
}

// Build the modal contents for a participant profile. Returns an
// array of nodes so the caller (openTaesProfileModal) can drop them
// straight into the modal wrapper. Splits the profile into a hero
// (gradient background + avatar + name + action buttons) and a body
// section (progress, contact, website, modules, assessment).
function taesProfileNodes(d, opts) {
  const p = d.participant || {};
  const onDeleted = (opts && opts.onDeleted) || null;
  const onClose = (opts && opts.onClose) || (() => {});
  const nodes = [];

  // ─── Close button (top-right, always visible) ─────────────────────
  const closeBtn = el('button', {
    style: 'position:absolute;top:14px;right:14px;background:rgba(0,0,0,0.35);' +
           'color:#fff;border:none;width:34px;height:34px;border-radius:50%;' +
           'font-size:1.2rem;cursor:pointer;line-height:1;z-index:2',
    title: 'Close', onclick: onClose
  }, '×');

  // ─── Avatar — big circle with photo_url or fallback initials ──────
  // Click anywhere on the avatar to open the photo picker + upload.
  // The camera-icon overlay makes the affordance obvious.
  const avatarRing = el('div', { style:
    'width:110px;height:110px;border-radius:50%;background:#fff;padding:4px;' +
    'position:relative;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.3);' +
    'flex:0 0 auto'
  });
  const avatarInner = el('div', { style:
    'width:100%;height:100%;border-radius:50%;overflow:hidden;position:relative;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:' + taesAvatarColor(p.name) + ';color:#fff;font-size:2.2rem;font-weight:700'
  });
  const imgOrInitials = () => {
    if (p.photo_url) {
      return el('img', {
        src: p.photo_url + (p.photo_url.includes('?') ? '&' : '?') + 't=' + Date.now(),
        alt: p.name || 'profile',
        style: 'width:100%;height:100%;object-fit:cover'
      });
    }
    return el('span', {}, taesInitials(p.name));
  };
  avatarInner.appendChild(imgOrInitials());
  const camBadge = el('div', { style:
    'position:absolute;bottom:0;right:0;background:#00FFFF;color:#0d1117;' +
    'width:32px;height:32px;border-radius:50%;display:flex;align-items:center;' +
    'justify-content:center;font-size:0.9rem;border:3px solid #fff;' +
    'box-shadow:0 2px 6px rgba(0,0,0,0.3)'
  }, '📷');
  avatarRing.append(avatarInner, camBadge);
  avatarRing.onclick = () => {
    taesPickAndUploadPhoto(p.id || p.participantId, (newUrl) => {
      p.photo_url = newUrl;
      avatarInner.replaceChildren(imgOrInitials());
    });
  };

  // ─── Action buttons — big, colorful, sit inside the hero ──────────
  const heroBtn = (label, bg, color, disabled, handler, title) => {
    const b = el('button', {
      style: 'padding:9px 16px;border-radius:999px;font-size:0.82rem;font-weight:600;' +
             'border:none;cursor:pointer;background:' + bg + ';color:' + color +
             (disabled ? ';opacity:0.4;cursor:not-allowed' : ''),
      title: title || '', onclick: disabled ? undefined : handler
    }, label);
    if (disabled) b.disabled = true;
    return b;
  };
  const actionRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:14px' },
    heroBtn('📧 Email', 'rgba(255,255,255,0.15)', '#fff', !p.email,
      () => openTaesEmailComposer(p), p.email ? 'Email ' + p.email : 'No email on file'),
    heroBtn('💬 SMS', 'rgba(255,255,255,0.15)', '#fff', !p.phone,
      () => openTaesSmsComposer(p), p.phone ? 'SMS ' + p.phone : 'No phone on file'),
    heroBtn('🗑 Delete', 'rgba(239,68,68,0.25)', '#fecaca', false,
      () => taesDeleteParticipant(p, onDeleted), 'Delete participant + all their data')
  );

  // ─── Hero — gradient banner with avatar + name + org + actions ────
  const hero = el('div', { style:
    'position:relative;padding:32px 24px 24px;text-align:center;' +
    'background:linear-gradient(135deg, #7c3aed 0%, #ec4899 50%, #06b6d4 100%);' +
    'border-radius:16px 16px 0 0;color:#fff'
  },
    closeBtn,
    el('div', { style: 'display:flex;justify-content:center;margin-bottom:14px' }, avatarRing),
    el('h1', { style: 'margin:0;font-size:1.5rem;font-weight:700' }, p.name || 'Participant'),
    p.orgName ? el('div', { style: 'margin-top:4px;font-size:0.9rem;opacity:0.85' }, p.orgName) : null,
    actionRow
  );
  nodes.push(hero);

  // ─── Body wrapper — padded panels stacked vertically ──────────────
  const body = el('div', { style: 'padding:20px 22px 24px' });
  nodes.push(body);

  // Progress tracker — big visual bar summarising the participant's
  // journey. completedModules / totalModules from the roster row was
  // not passed in with `d`, so we compute both from d.modules directly.
  // Any module with status='complete' counts. Falls back to the raw
  // count when a module list is unavailable so the panel still shows
  // something useful.
  // Note: the detailed modules table below reuses `d.modules` under
  // its own `mods` binding — don't shadow it here.
  const progressMods = d.modules || [];
  const total = progressMods.length;
  const done = progressMods.filter((m) => (m.status || '').toLowerCase() === 'complete').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const quizAvg = (() => {
    const scores = progressMods.map((m) => m.quiz_score).filter((s) => s != null);
    if (!scores.length) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  })();

  const barColor = pct >= 80 ? '#86efac' : pct >= 40 ? '#fbd38d' : '#fca5a5';
  body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
    el('h3', { style: 'margin-top:0' }, 'Progress'),
    total > 0
      ? el('div', {},
          el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px' },
            el('span', { style: 'font-weight:600;font-size:1.05rem' }, done + ' of ' + total + ' modules complete'),
            el('span', { style: 'color:' + barColor + ';font-weight:600' }, pct + '%')),
          el('div', {
            style: 'width:100%;height:14px;background:rgba(255,255,255,0.06);border-radius:7px;overflow:hidden;border:1px solid rgba(255,255,255,0.08)'
          }, el('div', {
            style: 'width:' + pct + '%;height:100%;background:' + barColor + ';transition:width 200ms ease'
          })),
          el('div', { class: 'muted', style: 'font-size:0.78rem;margin-top:8px;display:flex;gap:18px;flex-wrap:wrap' },
            quizAvg != null ? el('span', {}, 'Quiz average: ' + quizAvg + '%') : null,
            el('span', {}, 'Enrolled: ' + taesFmtDate(p.created_at))))
      : el('p', { class: 'muted' }, 'No module activity yet.')));


  body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
    el('h3', {}, 'Contact & account'),
    taesKV({
      email: p.email, phone: p.phone,
      'SMS consent': p.sms_consent ? ('yes · ' + taesFmtDate(p.sms_consent_at)) : 'no',
      'PWA installed': p.pwa_installed ? 'yes' : 'no',
      'push opt-in': p.push_opt_in ? 'yes' : 'no',
      'onboarding skipped': p.onboarding_skipped ? 'yes' : 'no',
      enrolled: taesFmtDate(p.created_at),
    })));

  if (d.website) {
    const w = d.website;
    body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
      el('h3', {}, 'Website'),
      taesKV({ purpose: w.site_purpose, published: taesFmtDate(w.published_at) }),
      w.deploy_url ? el('p', {}, el('a', { href: w.deploy_url, target: '_blank', rel: 'noopener' }, w.deploy_url)) : null,
      w.github_repo_url ? el('p', {}, el('a', { href: w.github_repo_url, target: '_blank', rel: 'noopener' }, '💻 ' + w.github_repo_url)) : null));
  }

  body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
    el('h3', {}, 'Assessment profile'),
    (d.assessment && d.assessment.profile)
      ? taesKV(d.assessment.profile, ['id', 'participant_id', 'created_at', 'updated_at'])
      : el('p', { class: 'muted' }, 'No profile yet.')));

  const mods = d.modules || [];
  body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
    el('h3', {}, 'Modules (' + mods.length + ')'),
    mods.length ? el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Module'), el('th', {}, 'Status'), el('th', { style: 'text-align:right' }, 'Quiz'))),
      el('tbody', {}, ...mods.map((m) => el('tr', {},
        el('td', { class: 'mono' }, m.module_id),
        el('td', {}, m.status || '—'),
        el('td', { class: 'mono', style: 'text-align:right' }, m.quiz_score != null ? m.quiz_score + '%' : '—')))))
      : el('p', { class: 'muted' }, 'No module activity.')));

  const sessions = (d.assessment && d.assessment.sessions) || [];
  if (sessions.length) {
    const s = sessions[0];
    const transcript = Array.isArray(s.transcript) ? s.transcript : null;
    body.appendChild(el('div', { class: 'panel', style: 'margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px' },
      el('h3', {}, 'Assessment chat'),
      el('div', { class: 'muted' }, (s.status || '') + ' · ' + taesFmtDate(s.created_at)),
      transcript ? el('div', { style: 'max-height:260px;overflow:auto;margin-top:8px' },
        ...transcript.map((t) => el('p', { style: 'margin:6px 0' },
          el('strong', {}, (t.role === 'assistant' ? 'Guide: ' : 'Student: ')), String(t.content || '')))) : null));
  }

  return nodes;
}

async function viewTaes() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, '🎓 TAES'),
    el('div', { class: 'muted' }, 'The AI Exit Strategy — roster & progress')));

  const sub = state._taesSub || 'roster';
  const tabs = [['roster', 'Roster'], ['attention', 'Attention'], ['partners', 'Partners']];
  wrap.appendChild(el('div', { class: 'row', style: 'gap:8px;margin-bottom:12px' },
    ...tabs.map(([id, label]) => el('button', {
      class: 'btn' + (sub === id ? ' primary' : ''),
      onclick: () => { state._taesSub = id; render(); },
    }, label))));

  const content = el('div', {});
  content.appendChild(el('div', { class: 'panel' }, el('div', { class: 'muted' }, 'Loading…')));
  wrap.appendChild(content);

  try {
    if (sub === 'roster') {
      const r = await api('/api/admin?action=taes-roster');
      const parts = r.participants || [];
      const stuck = parts.filter((p) => p.stuck).length;
      const avg = parts.length ? Math.round(parts.reduce((a, p) => a + (p.completionPct || 0), 0) / parts.length) : 0;

      content.replaceChildren(
        el('div', { class: 'cards' },
          el('div', { class: 'card' }, el('div', { class: 'label' }, 'Participants'), el('div', { class: 'value' }, String(parts.length))),
          el('div', { class: 'card' }, el('div', { class: 'label' }, 'Avg completion'), el('div', { class: 'value' }, avg + '%')),
          el('div', { class: 'card' }, el('div', { class: 'label' }, 'Need attention'), el('div', { class: 'value' }, String(stuck)))),
        el('div', { class: 'panel' },
          el('h2', {}, 'Roster'),
          el('div', { class: 'muted', style: 'font-size:0.78rem;margin-bottom:8px' }, 'Click a participant to open their profile.'),
          parts.length ? el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Org'), el('th', {}, 'Track'),
              el('th', { style: 'text-align:right' }, 'Progress'), el('th', { style: 'text-align:right' }, 'Quiz'), el('th', {}, 'Last active'))),
            el('tbody', {}, ...parts.map((p) => el('tr', {
              style: 'cursor:pointer',
              // Click opens the profile in a pop-up modal. onDeleted
              // re-renders the whole TAES view so the deleted
              // participant vanishes from the roster on close.
              onclick: () => openTaesProfileModal(p.participantId, { onDeleted: () => render() }),
            },
              el('td', {}, (p.stuck ? '🔴 ' : '') + (p.name || '—')),
              el('td', { class: 'muted' }, p.email || ''),
              el('td', {}, p.orgName || '—'),
              el('td', {}, p.track || '—'),
              el('td', { class: 'mono', style: 'text-align:right' }, (p.completedModules || 0) + '/' + (p.totalModules || 0) + ' (' + (p.completionPct || 0) + '%)'),
              el('td', { class: 'mono', style: 'text-align:right' }, p.quizAvg != null ? p.quizAvg + '%' : '—'),
              el('td', { class: 'muted' }, taesFmtDate(p.lastActive)))))
          ) : el('p', { class: 'muted' }, 'No participants yet.'))
      );
    } else if (sub === 'attention') {
      const r = await api('/api/admin?action=taes-attention');
      const rows = r.flagged || [];
      content.replaceChildren(el('div', { class: 'panel' },
        el('h2', {}, 'Needs attention (' + rows.length + ')'),
        rows.length ? el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Org'), el('th', {}, 'Reason'), el('th', {}, 'Details'), el('th', {}, 'Updated'))),
          el('tbody', {}, ...rows.map((f) => el('tr', {},
            el('td', {}, f.name || '—'),
            el('td', { class: 'muted' }, f.email || ''),
            el('td', {}, f.orgName || '—'),
            el('td', {}, f.reasonCode || '—'),
            el('td', { class: 'muted' }, typeof f.details === 'object' ? JSON.stringify(f.details) : (f.details || '')),
            el('td', { class: 'muted' }, taesFmtDate(f.updatedAt)))))
        ) : el('p', { class: 'muted' }, 'Nobody needs attention right now. 🎉')));
    } else {
      const r = await api('/api/admin?action=taes-partners');
      const partners = r.partners || [];
      content.replaceChildren(el('div', { class: 'panel' },
        el('h2', {}, 'Partner orgs (' + partners.length + ')'),
        partners.length ? el('div', { class: 'cards' }, ...partners.map((pt) => el('div', { class: 'card' },
          el('div', { class: 'label' }, pt.orgName || pt.partnerOrgId || 'Org'),
          el('div', { class: 'value' }, String(pt.totalParticipants != null ? pt.totalParticipants : '—')),
          el('div', { class: 'sub muted' },
            'completion ' + (pt.completionRate != null ? pt.completionRate + '%' : '—') +
            ' · active ' + (pt.activeParticipants != null ? pt.activeParticipants : '—') +
            (pt.flaggedCount != null ? ' · flagged ' + pt.flaggedCount : ''))))
        ) : el('p', { class: 'muted' }, 'No partner orgs.')));
    }
  } catch (e) {
    content.replaceChildren(el('div', { class: 'panel' },
      el('h3', {}, 'Could not load TAES data'),
      el('p', { class: 'err' }, e.message),
      el('p', { class: 'muted' }, 'Check that PORTAL_API_KEY is set on this project (Vercel) and the TAES app is reachable.')));
  }
  return wrap;
}

// every non-admin context — the router gates by state.isAdmin.
// ============================================================
async function viewAdminSales() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, '💰 Sales — GoElev8 Revenue'),
    el('div', { class: 'muted' }, 'Platform-wide income across all tenants'))
  );

  const fmt = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const tenantsCache = {};

  // Headline KPIs — last 30d, lifetime, MRR.
  const headerStrip = el('div', { class: 'cards' });
  const stat = (icon, label, value, sub) => el('div', { class: 'card' },
    el('div', { class: 'label' }, icon + ' ' + label),
    el('div', { class: 'value' }, value),
    sub ? el('div', { class: 'sub muted' }, sub) : null
  );
  headerStrip.appendChild(el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Loading…')));
  wrap.appendChild(headerStrip);

  const sourcesPanel = el('div', {});
  wrap.appendChild(sourcesPanel);

  let data;
  try {
    data = await api('/api/admin?action=sales-dashboard');
  } catch (e) {
    headerStrip.innerHTML = '';
    const errPanel = el('div', { class: 'panel' },
      el('h3', { style: 'margin:0 0 8px' }, '⚠️ Sales dashboard failed to load'),
      el('p', { class: 'err', style: 'margin:0 0 12px' }, e.message || String(e)),
      el('p', { class: 'muted', style: 'font-size:12px;margin:0 0 6px' },
        'Common causes:'),
      el('ul', { class: 'muted', style: 'font-size:12px;margin:0;padding-left:18px;line-height:1.6' },
        el('li', {}, 'Vercel hasn\'t finished deploying the latest commit yet — wait 60s and refresh.'),
        el('li', {}, 'Merch tables not yet migrated — Master Admin → Run Pending Migrations.'),
        el('li', {}, 'Open DevTools → Network → /api/admin?action=sales-dashboard for the full response.')
      )
    );
    wrap.appendChild(errPanel);
    return wrap;
  }
  tenantsCache.byId = data.tenants || {};

  headerStrip.innerHTML = '';
  headerStrip.appendChild(stat('📅', 'Last 30 days', fmt(data.totals?.last_30d_cents), 'all sources combined'));
  headerStrip.appendChild(stat('Σ',  'Lifetime',     fmt(data.totals?.lifetime_cents), 'all-time platform income'));
  headerStrip.appendChild(stat('🔁', 'MRR',          fmt(data.totals?.mrr_cents),       'recurring monthly'));

  const tenantName = (id) => (tenantsCache.byId[id]?.name) || (tenantsCache.byId[id]?.slug) || id;

  // Source-by-source panels.
  const sourceMeta = [
    { id: 'merch',          icon: '🛍️', title: 'Merch platform fees',
      desc: 'GoElev8 cut on every paid order across all tenant storefronts.' },
    { id: 'sms',            icon: '📣', title: 'SMS margin',
      desc: 'Tenant credit purchases minus Twilio per-segment cost.' },
    { id: 'subscriptions',  icon: '🔁', title: 'Monthly subscriptions',
      desc: 'Recurring SaaS plans (FOUNDING / Growth / etc.).' },
    { id: 'bookings',       icon: '📆', title: 'Booking fees',
      desc: '$10 per paid booking on Will Power + Flex Facility.' },
    { id: 'hires',          icon: '🤝', title: 'Hire fees',
      desc: '$100 per hire on iSlay Studios + Flex trainer applications.' }
  ];

  for (const meta of sourceMeta) {
    const src = data.sources?.[meta.id] || {};
    const panel = el('div', { class: 'panel' });
    panel.appendChild(el('div', { class: 'row between', style: 'margin-bottom:6px;flex-wrap:wrap;gap:8px' },
      el('h2', { style: 'margin:0' }, meta.icon + ' ' + meta.title),
      meta.id === 'subscriptions'
        ? el('div', { class: 'mono', style: 'color:var(--brand-1,#00CFFF);font-weight:600' }, fmt(src.mrr_cents) + '/mo')
        : el('div', { style: 'text-align:right' },
            el('div', { class: 'mono', style: 'font-weight:600' }, fmt(src.last_30d_cents) + ' / 30d'),
            el('div', { class: 'muted mono', style: 'font-size:11px' }, fmt(src.lifetime_cents) + ' lifetime')
          )
    ));
    panel.appendChild(el('p', { class: 'muted', style: 'font-size:12px;margin:0 0 12px' }, meta.desc));

    if (src.setup_required) {
      panel.appendChild(el('p', { class: 'muted' }, 'Underlying tables not yet installed. Master Admin → Run Pending Migrations.'));
    } else if (src.error) {
      panel.appendChild(el('p', { class: 'err' }, src.error));
    } else if (meta.id === 'subscriptions') {
      const subs = src.active || [];
      if (!subs.length) {
        panel.appendChild(el('p', { class: 'muted' }, 'No active subscriptions.'));
      } else {
        panel.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Tenant'), el('th', {}, 'Plan'), el('th', { style: 'text-align:right' }, 'MRR')
          )),
          el('tbody', {}, ...subs.map(s => el('tr', {},
            el('td', {}, s.slug),
            el('td', {}, s.plan),
            el('td', { class: 'mono', style: 'text-align:right' }, fmt(s.mrr_cents))
          )))
        ));
      }
      if (src.note) panel.appendChild(el('p', { class: 'muted', style: 'font-size:11px;margin-top:8px' }, src.note));
    } else {
      const breakdown = data.breakdowns?.[meta.id] || {};
      const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      if (!entries.length) {
        panel.appendChild(el('p', { class: 'muted' }, 'No revenue from this source yet.'));
      } else {
        panel.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Tenant'),
            el('th', { style: 'text-align:right' }, 'Lifetime')
          )),
          el('tbody', {}, ...entries.map(([cid, amt]) => el('tr', {},
            el('td', {}, tenantName(cid)),
            el('td', { class: 'mono', style: 'text-align:right' }, fmt(amt))
          )))
        ));
      }
      if (meta.id === 'sms' && Number.isFinite(src.twilio_cost_per_segment_cents)) {
        panel.appendChild(el('p', { class: 'muted', style: 'font-size:11px;margin-top:8px' },
          `Computed against ${src.twilio_cost_per_segment_cents}¢/segment Twilio cost. Update with the twilio-cost admin action if your rate changes.`));
      }
    }

    sourcesPanel.appendChild(panel);
  }

  // Footer: phase 2 reminders.
  sourcesPanel.appendChild(el('div', { class: 'panel', style: 'background:rgba(0,207,255,0.04);border-color:rgba(0,207,255,0.18)' },
    el('h3', { style: 'margin:0 0 8px' }, 'Phase 2 — coming next'),
    el('ul', { style: 'margin:0;padding-left:18px;line-height:1.7;font-size:13px;color:var(--text-mute,#9ca3af)' },
      el('li', {}, 'Live Stripe Subscriptions feed (replaces hardcoded MRR table).'),
      el('li', {}, 'Stripe Connect status check for each tenant (verifies application_fee splits).'),
      el('li', {}, 'Auto-invoice Kenny / Nate / Will after each booking + hire.')
    )
  ));

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
  srcPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.8rem;margin-bottom:12px' },
    'Where your visitors come from, grouped by channel. Hover a bar for raw GA4 sources.'));
  srcPanel.appendChild(renderTrafficChannels(ga.top_sources || []));
  restOfPage.appendChild(srcPanel);

  // Top pages (show first 15 in main table)
  const pagePanel = el('div', { class: 'panel' });
  pagePanel.appendChild(el('h2', {}, '📄 Top Pages'));
  pagePanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.8rem;margin-bottom:12px' },
    'Most-viewed pages on your site, last 30 days. Bar width is relative to the top page on screen.'));
  pagePanel.appendChild(renderPageList(ga.top_pages || [], {
    limit: 15,
    emptyText: 'No page data yet.'
  }));
  restOfPage.appendChild(pagePanel);

  // Funnel page performance — same bar-list treatment, but the % share
  // is calculated against TOTAL site traffic (not just funnel pages) so
  // "what fraction of visits hit /r2s" is meaningful.
  const funnelPanel = el('div', { class: 'panel' });
  funnelPanel.appendChild(el('h2', {}, '🔗 Funnel Page Performance'));
  funnelPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.8rem;margin-bottom:12px' },
    'Funnel pages only (e.g. /r2s, /fit, /book). Percentage is share of total site traffic.'));
  const funnelPages = (ga.top_pages || []).filter(p =>
    p.path && (p.path.startsWith('/r') || p.path.startsWith('/fit') || p.path === '/' || p.path.startsWith('/book'))
  );
  const totalPageViews = (ga.top_pages || []).reduce((s, p) => s + (Number(p.views) || 0), 0);
  funnelPanel.appendChild(renderPageList(funnelPages, {
    denom: totalPageViews,
    emptyText: 'No funnel page data yet. Funnel pages like /r2s, /fit, /book will appear here once they receive traffic.'
  }));
  restOfPage.appendChild(funnelPanel);

  // Storefront (/merch) performance — first-party tracker data from
  // embed/track.js, joined to merch_orders for a view→order
  // conversion rate. Fired in parallel; failure renders an empty
  // panel rather than blocking the rest of Analytics.
  const merchPanel = el('div', { class: 'panel' });
  merchPanel.appendChild(el('h2', {}, '🛍️ Storefront (/merch) Performance'));
  merchPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
    'First-party view tracking on your /merch page + paid orders from the portal · last 30 days'));
  const merchSlot = el('div', {}, el('p', { class: 'muted' }, 'Loading…'));
  merchPanel.appendChild(merchSlot);
  restOfPage.appendChild(merchPanel);
  (async () => {
    try {
      const fv = await api('/api/portal/funnel-views');
      const sf = fv.storefront;
      merchSlot.replaceChildren();
      if (!sf) {
        merchSlot.appendChild(el('p', { class: 'muted' },
          'No /merch traffic recorded yet. Make sure the GoElev8 tracker script is embedded in your /merch page (see Master Admin → tracking snippet) — views appear within a minute of the next page load.'));
        return;
      }
      // Summary cards
      const fmtPct = (v) => v == null ? '—' : v + '%';
      const summaryCards = el('div', { class: 'cards', style: 'margin-bottom:14px' },
        card('👀', '/merch Views',  sf.views_30d,  'Unique-per-hour visits'),
        card('🛒', 'Paid Orders',   sf.orders_30d, 'Same 30-day window'),
        card('🎯', 'View → Order',  fmtPct(sf.conversion_pct), sf.views_30d > 0 ? 'Conversion rate' : 'Need views to compute')
      );
      merchSlot.appendChild(summaryCards);

      // Daily chart from sf.by_day
      const days = Object.entries(sf.by_day || {});
      if (days.length && days.some(([_, v]) => v > 0)) {
        const max = Math.max(...days.map(([_, v]) => v), 1);
        const chart = el('div', { class: 'view-chart' });
        days.forEach(([date, views]) => {
          const bar = el('div', {
            class: 'view-bar',
            title: date + ': ' + views + ' view' + (views === 1 ? '' : 's')
          },
            el('div', { class: 'view-bar-fill', style: 'height:' + Math.max(2, (views / max) * 100) + '%' }),
            el('div', { class: 'view-bar-label' }, new Date(date).getDate())
          );
          chart.appendChild(bar);
        });
        merchSlot.appendChild(chart);
      } else {
        merchSlot.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-top:8px' },
          'No /merch views in the last 30 days. Check that ' +
          '<script src="https://portal.goelev8.ai/embed/track.js" async></script> ' +
          'is in the <head> of your /merch page.'));
      }

      // Top portal-tracked pages — helps the operator see whether
      // other pages (/, /about, etc) are also being tracked, useful
      // for sanity-checking the embed.
      if (Array.isArray(fv.by_path) && fv.by_path.length) {
        const pathPanel = el('div', { style: 'margin-top:14px' });
        pathPanel.appendChild(el('div', { class: 'muted', style: 'font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px' },
          'All tracked pages (first-party tracker)'));
        const max = fv.by_path[0]?.count || 1;
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px' });
        for (const p of fv.by_path.slice(0, 8)) {
          const bar = el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:0.8rem' },
            el('div', { class: 'mono', style: 'flex:0 0 220px;color:' + (p.path === '/merch' ? '#63b3ed' : 'var(--text,#e0e0e0)') }, p.path),
            el('div', { style: 'flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden' },
              el('div', { style: 'width:' + Math.round((p.count / max) * 100) + '%;height:100%;background:#63b3ed' })
            ),
            el('div', { style: 'flex:0 0 50px;text-align:right;color:var(--muted,#888);font-size:0.75rem' }, String(p.count))
          );
          list.appendChild(bar);
        }
        pathPanel.appendChild(list);
        merchSlot.appendChild(pathPanel);
      }
    } catch (e) {
      merchSlot.replaceChildren();
      merchSlot.appendChild(el('p', { class: 'err', style: 'font-size:0.85rem' },
        'Storefront stats unavailable: ' + e.message));
    }
  })();

  // Road To The Stage Ebook Sales — for tenants that resell the R2S
  // ebook (Flex Facility, Will Power Fitness Factory). Admin sees it
  // via impersonation; never in any other tenant's view.
  if (['flex-facility', 'willpower-fitness'].includes(state.client?.slug)) {
    const r2sPanel = el('div', { class: 'panel' });
    r2sPanel.appendChild(el('h2', {}, '📕 The Road To The Stage Ebook Sales'));
    r2sPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
      'Ebook sales + /r2s page analytics · view-to-purchase conversion rate · last 30 days'));
    restOfPage.appendChild(r2sPanel);
    loadR2sAnalyticsSection(r2sPanel);
  }

  // Booking Page Analytics — scoped to the tenant's booking subdomain
  // (e.g. book.theflexfacility.com, book.willpowerfitnessfactory.com)
  // via a hostName filter on the same GA4 property. Only renders when
  // the tenant has a booking_calendars row with a custom_domain set.
  const bookingHost = state.bookingCalendar?.custom_domain
    ? state.bookingCalendar.custom_domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
    : null;
  if (bookingHost) {
    const bkPanel = el('div', { class: 'panel' });
    bkPanel.appendChild(el('h2', {}, '📅 Booking Page Analytics'));
    bkPanel.appendChild(el('p', { class: 'muted', style: 'font-size:0.85rem;margin-bottom:12px' },
      `GA4 data scoped to ${bookingHost} · last 30 days. Same property, host-filtered.`));
    restOfPage.appendChild(bkPanel);
    loadBookingPageAnalytics(bkPanel, bookingHost);
  }

  // Sales tracking section
  const salesPanel = el('div', { class: 'panel' });
  salesPanel.appendChild(el('h2', {}, '💰 Sales'));
  restOfPage.appendChild(salesPanel);
  loadSalesSection(salesPanel);

  // Tenant Activity panel — replaces the legacy GA4 "Portal Events"
  // panel. The custom events (lead_viewed, booking_viewed, etc.) are
  // fired into the platform's GA4 property (G-07Y6KTRES2), not into
  // each tenant's own GA4. Querying a tenant's GA4 for those events
  // always returns 0 — misleading. Sourcing the same intent from
  // Supabase tables gives accurate, tenant-scoped counts.
  const activityPanel = el('div', { class: 'panel' });
  activityPanel.appendChild(el('h2', {}, '⚡ Tenant Activity (last 30 days)'));
  const activityCards = el('div', { class: 'cards', style: 'margin-top:8px' });
  activityCards.appendChild(el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Loading…')));
  activityPanel.appendChild(activityCards);
  restOfPage.appendChild(activityPanel);

  api('/api/portal/analytics').then(an => {
    activityCards.innerHTML = '';
    // Use the rolling 30-day counts so the panel label matches the data.
    // Falls back to the legacy "this month" fields if the API hasn't
    // been redeployed yet.
    activityCards.appendChild(card('🔥', 'Leads Captured', an.overview?.leads_30d    ?? an.overview?.total_leads        ?? 0, 'last 30 days'));
    activityCards.appendChild(card('📅', 'Bookings Made',  an.overview?.bookings_30d ?? an.overview?.bookings_this_month ?? 0, 'last 30 days'));
    activityCards.appendChild(card('💬', 'Outbound SMS',   an.overview?.sms_30d      ?? an.overview?.sms_sent            ?? 0, 'last 30 days'));
    activityCards.appendChild(card('📞', 'Voice Calls',    an.overview?.calls_30d    ?? an.overview?.calls_this_month    ?? 0, 'last 30 days'));
  }).catch(() => {
    activityCards.innerHTML = '';
    activityCards.appendChild(el('div', { class: 'card' },
      el('div', { class: 'muted' }, 'Could not load tenant activity.')));
  });

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

// Road To The Stage ebook sales + /r2s GA4 analytics section
// rendered inside the Analytics view for Flex Facility only.
// Booking Page Analytics — scoped GA4 view of the tenant's booking
// subdomain. Renders headline metrics + a per-day chart + a
// host-filtered Top Pages list so the operator can see exactly how
// the booking flow is performing without the noise of the main site.
async function loadBookingPageAnalytics(container, host) {
  const placeholder = el('p', { class: 'muted' }, 'Loading booking page analytics…');
  container.appendChild(placeholder);
  try {
    const r = await api('/api/portal/ga4?host=' + encodeURIComponent(host));
    placeholder.remove();
    if (r.configured === false) {
      container.appendChild(el('p', { class: 'muted' }, r.error || 'GA4 not configured.'));
      return;
    }
    if (r.error) {
      container.appendChild(el('p', { class: 'err' }, 'GA4 error: ' + r.error));
      return;
    }

    // Summary cards
    const cards = el('div', { class: 'cards' });
    const card = (icon, label, value, sub) => el('div', { class: 'card' },
      el('div', { class: 'label' }, icon + ' ' + label),
      el('div', { class: 'value' }, String(value)),
      sub ? el('div', { class: 'sub muted' }, sub) : null
    );
    cards.appendChild(card('👁️', 'Sessions', r.sessions || 0, 'last 30 days'));
    cards.appendChild(card('📄', 'Page Views', r.page_views || 0, 'last 30 days'));
    cards.appendChild(card('👤', 'Visitors', r.users || 0, 'unique users'));
    container.appendChild(cards);

    // Top pages on this host only
    const pagePanel = el('div', { style: 'margin-top:16px' });
    pagePanel.appendChild(el('h3', { style: 'font-size:0.95rem;margin:0 0 8px' }, 'Top Pages on ' + host));
    pagePanel.appendChild(renderPageList(r.top_pages || [], {
      limit: 10,
      emptyText: 'No page views recorded for ' + host + ' in the last 30 days. Confirm the data stream for this subdomain is set up in GA4 → Admin → Data Streams.'
    }));
    container.appendChild(pagePanel);

    // Top sources to this host only
    if ((r.top_sources || []).length) {
      const srcPanel = el('div', { style: 'margin-top:16px' });
      srcPanel.appendChild(el('h3', { style: 'font-size:0.95rem;margin:0 0 8px' }, 'Top Sources Driving Traffic to ' + host));
      srcPanel.appendChild(renderTrafficChannels(r.top_sources));
      container.appendChild(srcPanel);
    }
  } catch (e) {
    placeholder.remove();
    container.appendChild(el('p', { class: 'err' }, 'Failed to load booking page analytics: ' + e.message));
  }
}

async function loadR2sAnalyticsSection(container) {
  const placeholder = el('p', { class: 'muted' }, 'Loading ebook sales + /r2s analytics…');
  container.appendChild(placeholder);

  let salesData, ga4Data;
  try {
    [salesData, ga4Data] = await Promise.all([
      api('/api/portal/r2s-sales'),
      api('/api/portal/flex-r2s').catch(() => null)
    ]);
  } catch (e) {
    placeholder.remove();
    container.appendChild(el('p', { class: 'err' }, 'Failed to load R2S data: ' + e.message));
    return;
  }
  placeholder.remove();

  const units = salesData.total_units || 0;
  const revenueCents = salesData.total_revenue_cents || 0;
  const pageViews = ga4Data?.page_views || 0;
  const conversionRate = pageViews > 0 ? ((units / pageViews) * 100).toFixed(2) + '%' : '—';

  const fmtSec = (s) => {
    if (!s || s < 1) return '0s';
    if (s < 60) return s.toFixed(0) + 's';
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
  };

  // Metrics strip
  container.appendChild(el('div', { class: 'leads-metrics-strip', style: 'margin-bottom:16px;flex-wrap:wrap' },
    el('div', { class: 'metric-stat accent' },
      el('span', { class: 'metric-stat-value' }, String(units)),
      el('span', { class: 'metric-stat-label' }, 'Units Sold')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat accent' },
      el('span', { class: 'metric-stat-value' }, `$${(revenueCents / 100).toFixed(2)}`),
      el('span', { class: 'metric-stat-label' }, 'Total Revenue')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, String(pageViews)),
      el('span', { class: 'metric-stat-label' }, '/r2s Page Views')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, ga4Data ? String(ga4Data.users || 0) : '—'),
      el('span', { class: 'metric-stat-label' }, 'Unique Visitors')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, ga4Data ? fmtSec(ga4Data.avg_time_on_page) : '—'),
      el('span', { class: 'metric-stat-label' }, 'Avg Time on Page')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat' },
      el('span', { class: 'metric-stat-value' }, ga4Data?.bounce_rate != null ? (ga4Data.bounce_rate * 100).toFixed(1) + '%' : '—'),
      el('span', { class: 'metric-stat-label' }, 'Bounce Rate')
    ),
    el('div', { class: 'metric-divider' }),
    el('div', { class: 'metric-stat accent' },
      el('span', { class: 'metric-stat-value', style: 'font-size:1.4rem' }, conversionRate),
      el('span', { class: 'metric-stat-label' }, 'Conversion Rate')
    )
  ));

  // Live ticker — last 30 minutes, bypasses GA4's 24-48h delay on the
  // historical numbers so a fresh visit shows up immediately.
  if (ga4Data?.realtime) {
    const rt = ga4Data.realtime;
    container.appendChild(el('div', { class: 'r2s-realtime' },
      el('span', { class: 'r2s-realtime-dot' }),
      el('span', {}, 'Live: '),
      el('strong', {}, String(rt.active_users || 0)),
      el('span', { class: 'muted' }, ' active now · '),
      el('strong', {}, String(rt.page_views_last_30_min || 0)),
      el('span', { class: 'muted' }, ' /r2s view' + (rt.page_views_last_30_min === 1 ? '' : 's') + ' in the last 30 min')
    ));
    container.appendChild(el('p', { class: 'muted', style: 'font-size:0.7rem;margin-top:4px' },
      'Note: the 30-day metrics above update once per day (GA4 standard reporting has a 24–48h delay). The Live ticker is near real-time.'));
  }

  // Sales over time chart
  const salesDays = Object.entries(salesData.by_day || {});
  const ga4Days = ga4Data?.by_day || {};
  if (salesDays.length) {
    container.appendChild(el('h3', { style: 'font-size:0.9rem;margin-bottom:8px' }, 'Sales + Page Views (last 30 days)'));
    const maxUnits = Math.max(...salesDays.map(([_, v]) => v.units), 1);
    const maxViews = Math.max(...salesDays.map(([d]) => ga4Days[d]?.views || 0), 1);
    const chart = el('div', { class: 'r2s-chart' });
    salesDays.forEach(([date, v]) => {
      const views = ga4Days[date]?.views || 0;
      const bar = el('div', {
        class: 'r2s-chart-bar',
        title: `${date}: ${v.units} sale${v.units === 1 ? '' : 's'} · $${(v.revenue_cents / 100).toFixed(2)} · ${views} views`
      },
        el('div', { class: 'r2s-chart-fill', style: `height:${Math.max(2, (v.units / maxUnits) * 100)}%;opacity:1` }),
        el('div', { class: 'r2s-chart-fill', style: `height:${Math.max(1, (views / maxViews) * 60)}%;opacity:0.3;position:absolute;bottom:0;left:0;right:0` }),
        el('div', { class: 'r2s-chart-label' }, new Date(date).getDate())
      );
      chart.appendChild(bar);
    });
    container.appendChild(chart);
    container.appendChild(el('p', { class: 'muted', style: 'font-size:0.7rem;margin-top:6px' },
      'Solid bars = sales · Faded bars = page views'));
  }

  // Traffic sources
  if (ga4Data?.top_sources?.length) {
    container.appendChild(el('h3', { style: 'margin:16px 0 8px;font-size:0.9rem' }, 'Traffic Sources to /r2s'));
    container.appendChild(renderTrafficChannels(ga4Data.top_sources || []));
  }

  // Recent sales
  if (salesData.sales?.length) {
    container.appendChild(el('h3', { style: 'font-size:0.9rem;margin:16px 0 8px' }, 'Recent Ebook Sales'));
    container.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Customer'), el('th', {}, 'Amount'), el('th', {}, 'Source')
      )),
      el('tbody', {}, ...salesData.sales.map(s => el('tr', {},
        el('td', {}, new Date(s.created_at).toLocaleDateString()),
        el('td', {}, s.customer_name || s.customer_email || '—'),
        el('td', { style: 'font-weight:600' }, `$${(s.amount_cents / 100).toFixed(2)}`),
        el('td', {}, el('span', { class: 'badge' + (s.source?.startsWith('r2s_manual') ? ' warn' : ' info') },
          s.source?.startsWith('r2s_manual') ? 'manual' : (s.source || 'stripe')))
      )))
    ));
  }

  // Sales page link
  container.appendChild(el('div', { class: 'r2s-link-row', style: 'margin-top:12px' },
    el('span', { class: 'muted', style: 'font-size:0.8rem' }, 'Sales page:'),
    el('a', {
      href: 'https://www.theflexfacility.com/r2s',
      target: '_blank', rel: 'noopener noreferrer',
      class: 'r2s-link'
    }, 'theflexfacility.com/r2s →')
  ));
}

// ============================================================
// ROUTER / RENDER
// ============================================================
async function render() {
  const root = $('#app');
  // Apply per-client brand color to the document root so the SPA picks up
  // each tenant's accent (e.g. iSlay Studios gold) without a separate app.
  const brand = state.client?.brand_color;
  if (brand && /^#?[0-9a-f]{3,8}$/i.test(brand.replace('#', ''))) {
    const hex = brand.startsWith('#') ? brand : '#' + brand;
    document.documentElement.style.setProperty('--brand-1', hex);
    document.documentElement.style.setProperty('--brand-glow', hex + '33');
  } else {
    document.documentElement.style.removeProperty('--brand-1');
    document.documentElement.style.removeProperty('--brand-glow');
  }
  if (activityPoll && state.view !== 'activity') { clearInterval(activityPoll); activityPoll = null; }
  if (state._activityChannels && state.view !== 'activity') {
    for (const ch of state._activityChannels) { try { ch.unsubscribe(); } catch {} }
    state._activityChannels = null;
  }
  // Tear down the Messages realtime channel any time we leave the
  // Messages tab (or before re-rendering it). The viewMessages() body
  // re-creates the channel on each render so we don't leak handlers.
  if (state._messagesChannel) {
    try { state._messagesChannel.unsubscribe(); } catch {}
    state._messagesChannel = null;
  }
  root.innerHTML = '';
  // Recovery-email landing: ?reset=1 from the email's redirectTo, or a
  // bare #access_token=…&type=recovery hash from Supabase's redirect.
  // Show the reset-password form before anything else, even when an
  // expired session JWT is still in localStorage.
  {
    const qs = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    if (qs.get('reset') === '1' || hashParams.get('type') === 'recovery') {
      root.appendChild(renderResetPassword());
      return;
    }
  }
  if (!state.token) { root.appendChild(renderLogin()); return; }
  if (!state.user) {
    // Start the refresh timer on page load if we have a refresh token
    if (state.refreshToken) startTokenRefreshTimer();
    try { await loadMe(); } catch { logout(); return; }
  }
  // Client-specific portal redirect: previously sent iSlay users to the
  // separate /islaystudios static-HTML mini-app. Disabled — iSlay now
  // renders inside the main SPA so they get every feature the admin sees
  // when impersonating (Recent Activity, Refresh purchases, Contact
  // Import, etc.) without us having to port each one twice.
  const CLIENT_PORTALS = {};
  if (!state.isAdmin && state.client?.slug && CLIENT_PORTALS[state.client.slug]) {
    window.location.replace(CLIENT_PORTALS[state.client.slug]);
    return;
  }
  // Admins land on the admin view by default — but allow switching to
  // other admin-accessible tabs (activity, analytics, sales). Without
  // 'admin_sales' here, clicking the Sales tab would silently bounce
  // back to Master Admin because the guard below resets state.view.
  const ADMIN_VIEWS = ['admin', 'admin_sales', 'activity', 'analytics', 'booking_admin', 'taes'];
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
      case 'activity':  view = (state.isAdmin && state.user?.email === 'ab@goelev8.ai') ? await viewActivity() : await viewOverview(); break;
      case 'contacts':  view = await viewContacts(); break;
      case 'leads':     view = await viewLeads(); break;
      case 'calls':     view = await viewCalls(); break;
      case 'bookings':  view = await viewBookings(); break;
      case 'messages':  view = await viewMessages(); break;
      case 'messaging': view = await viewMessaging(); break;
      case 'applications': view = await viewApplications(); break;
      case 'merch':     view = await viewMerch(); break;
      case 'trainer_applications': view = await viewTrainerApplications(); break;
      case 'billing':   view = await viewBilling(); break;
      case 'connect':   view = await viewConnect(); break;
      case 'blasts':    view = await viewBlasts(); break;
      case 'nudges':    view = await viewNudges(); break;
      case 'settings':  view = await viewSettings(); break;
      case 'booking_admin': view = state.isAdmin ? await viewBookingAdmin() : await viewOverview(); break;
      case 'admin_sales':   view = state.isAdmin ? await viewAdminSales()   : await viewOverview(); break;
      case 'taes':      view = (state.isAdmin || state.client?.slug === 'ai-exit-strategy') ? await viewTaes() : await viewOverview(); break;
      case 'analytics': view = await viewAnalytics(); break;
      default:          view = await viewOverview();
    }
  } catch (e) {
    view = el('div', { class: 'panel' }, el('p', { class: 'err' }, 'Error: ' + e.message));
  }
  root.appendChild(shell(view));
}

// Handle credits=success redirect — trigger reconcile so the credits land
// even if the Stripe webhook didn't fire (network blip, signing-secret
// mismatch, redeploy mid-checkout, etc).
const params = new URLSearchParams(window.location.search);
if (params.get('credits') === 'success') {
  toast('Payment received! Granting credits…');
  history.replaceState({}, '', '/');
  // Wait briefly for the JWT to be loaded by render(), then reconcile
  (async () => {
    for (let i = 0; i < 20 && !state.token; i++) await new Promise(r => setTimeout(r, 100));
    try {
      const r = await api('/api/portal/credits?action=reconcile', { method: 'POST' });
      if (r.recovered > 0) {
        toast(`Added ${r.credits_added} credits from your purchase.`);
        if (state.view === 'settings' || state.view === 'billing' || state.view === 'overview') render();
      }
    } catch (e) { /* silent — webhook may have already done it */ }
  })();
}
// OAuth callback landed — Stripe redirected the tenant back after
// they linked their personal account. Show a clear toast (the
// new ?account= param carries the just-linked acct_... id) and
// strip the params before rendering so a refresh doesn't repeat.
if (params.get('connect') === 'done') {
  const acct = params.get('account');
  toast(acct
    ? `✓ Stripe connected · ${acct}`
    : 'Stripe Connect onboarding complete!');
  history.replaceState({}, '', '/');
}
if (params.get('connect') === 'error') {
  const reason = params.get('reason') || 'unknown';
  // Friendlier copy for the cases the user might trigger themselves.
  const REASON_COPY = {
    access_denied:  'You declined to authorize the connection.',
    state_expired:  'The connection link expired — click Connect Stripe again to retry.',
    invalid_state:  'Security token mismatch — refresh the page and try again.',
    missing_params: 'Stripe redirected without a code — try Connect Stripe again.'
  };
  toast(REASON_COPY[reason] || ('Stripe connect failed: ' + reason), true);
  history.replaceState({}, '', '/');
}

render();
