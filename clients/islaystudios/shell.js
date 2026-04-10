// iSlay Studios portal shell — shared across all pages.
// Handles auth, sidebar, API calls, and common utilities.

// Force SW update + nuke stale caches on load
(function() {
  if ('serviceWorker' in navigator) {
    // Clear all caches that aren't the current version
    if ('caches' in window) {
      caches.keys().then(function(names) {
        names.forEach(function(name) {
          if (name !== 'goelev8-portal-v9') caches.delete(name);
        });
      });
    }
    // Force the SW to check for updates
    navigator.serviceWorker.getRegistration().then(function(reg) {
      if (reg) reg.update();
    });
  }
  // Clear stale client config cache
  try { sessionStorage.removeItem('ge8_client'); } catch(e) {}
})();

var CLIENT_ID = 'islay_studios';

// Full tab catalog — maps tab key to config
var TAB_CATALOG = {
  leads:     { label: 'Leads',     icon: '👥' },
  messages:  { label: 'Messages',  icon: '💬' },
  blasts:    { label: 'Blasts',    icon: '📣' },
  nudges:    { label: 'Nudges',    icon: '⚡' },
  settings:  { label: 'Settings',  icon: '⚙️' },
  dashboard: { label: 'Dashboard', icon: '📊' },
  calls:     { label: 'Voice Calls', icon: '📞' },
  artists:   { label: 'Artists',   icon: '✂️' },
  credits:   { label: 'Credits',   icon: '💳' },
  analytics: { label: 'Analytics', icon: '📈' }
};

// Default tabs when portal_tabs is not set on the client record
var DEFAULT_TABS = ['dashboard','leads','blasts','calls','artists','credits','analytics','settings'];

function getToken() {
  return localStorage.getItem('ge8_token');
}

function requireAuth() {
  if (!getToken()) {
    window.location.replace('/islaystudios/login');
    return false;
  }
  return true;
}

async function api(path, opts) {
  opts = opts || {};
  var headers = { 'Content-Type': 'application/json' };
  var k; for (k in (opts.headers || {})) headers[k] = opts.headers[k];
  var token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    localStorage.removeItem('ge8_token');
    window.location.replace('/islaystudios/login');
    throw new Error('unauthorized');
  }
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function logout() {
  localStorage.removeItem('ge8_token');
  sessionStorage.removeItem('ge8_client');
  window.location.replace('/islaystudios/login');
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toast(msg, isError) {
  var t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3500);
}

// Fetch and cache client config (portal_tabs, logo_url, brand_color)
async function getClientConfig() {
  var cached = sessionStorage.getItem('ge8_client');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) { /* fall through */ }
  }
  try {
    var data = await api('/api/portal/me');
    if (data.client) {
      sessionStorage.setItem('ge8_client', JSON.stringify(data.client));
      return data.client;
    }
  } catch(e) { /* fall through */ }
  return null;
}

// Build the sidebar shell — fetches client config for dynamic tabs
function initShell(activePage) {
  if (!requireAuth()) return;

  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Render immediately with known tabs, then update if client config differs
  renderSidebar(sidebar, activePage, DEFAULT_TABS, null);
  renderBottomTabs(activePage, DEFAULT_TABS);

  // Fetch client config and re-render with portal_tabs if set
  getClientConfig().then(function(client) {
    if (client) {
      var tabs = client.portal_tabs || DEFAULT_TABS;
      renderSidebar(sidebar, activePage, tabs, client);
      renderBottomTabs(activePage, tabs);
    }
  });

  // Mobile menu toggle
  var toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function() {
      sidebar.classList.toggle('open');
    });
  }

  // PWA install banner
  showInstallBanner();
}

function renderSidebar(sidebar, activePage, tabs, client) {
  var logoUrl = (client && client.logo_url) ? client.logo_url : null;

  var brandHtml;
  if (logoUrl) {
    brandHtml =
      '<div class="sb-brand">' +
        '<img src="' + logoUrl + '" alt="iSlay Studios" class="sb-logo-img" />' +
        '<div class="sb-sub">Client Portal</div>' +
      '</div>';
  } else {
    brandHtml =
      '<div class="sb-brand">' +
        '<div class="sb-logo">iSlay Studios</div>' +
        '<div class="sb-sub">Client Portal</div>' +
      '</div>';
  }

  var navHtml = tabs.map(function(key) {
    var tab = TAB_CATALOG[key];
    if (!tab) return '';
    var cls = key === activePage ? 'sb-link active' : 'sb-link';
    return '<a href="/islaystudios/' + key + '" class="' + cls + '">' +
      '<span class="sb-icon">' + tab.icon + '</span>' + tab.label + '</a>';
  }).join('');

  sidebar.innerHTML =
    brandHtml +
    '<nav class="sb-nav">' + navHtml + '</nav>' +
    '<div class="sb-footer">' +
      '<button onclick="logout()" class="sb-signout">Sign out</button>' +
      '<div class="sb-powered">Powered by GoElev8.AI</div>' +
    '</div>';
}

// Mobile bottom tab bar
function renderBottomTabs(activePage, tabs) {
  var existing = document.getElementById('bottom-tabs');
  if (existing) existing.remove();

  var bar = document.createElement('nav');
  bar.id = 'bottom-tabs';
  bar.className = 'bottom-tabs';

  tabs.forEach(function(key) {
    var tab = TAB_CATALOG[key];
    if (!tab) return;
    var cls = key === activePage ? 'btab active' : 'btab';
    var a = document.createElement('a');
    a.href = '/islaystudios/' + key;
    a.className = cls;
    a.innerHTML = '<span class="btab-icon">' + tab.icon + '</span>' + tab.label;
    bar.appendChild(a);
  });

  document.body.appendChild(bar);
}

// PWA install banner
var deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredPrompt = e;
});

function showInstallBanner() {
  // Don't show if already installed as PWA
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (window.navigator.standalone === true) return;
  // Don't show if user dismissed it
  if (sessionStorage.getItem('pwa_dismissed')) return;

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var banner = document.createElement('div');
  banner.className = 'pwa-banner';
  banner.id = 'pwa-banner';

  if (isIOS) {
    banner.innerHTML =
      '<div class="pwa-banner-text">' +
        '<strong>Add to Home Screen</strong><br>' +
        'Tap <span style="font-size:1.1rem">⎙</span> then "Add to Home Screen" for the best experience.' +
      '</div>' +
      '<button class="btn-dismiss" onclick="dismissInstall()">✕</button>';
  } else if (deferredPrompt) {
    banner.innerHTML =
      '<div class="pwa-banner-text">' +
        '<strong>Install App</strong><br>' +
        'Add to your home screen for quick access.' +
      '</div>' +
      '<button class="btn-install" onclick="installPWA()">Install</button>' +
      '<button class="btn-dismiss" onclick="dismissInstall()">✕</button>';
  } else {
    // No install prompt available and not iOS — don't show
    return;
  }

  document.body.appendChild(banner);
}

function installPWA() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
  }
  dismissInstall();
}

function dismissInstall() {
  var banner = document.getElementById('pwa-banner');
  if (banner) banner.remove();
  sessionStorage.setItem('pwa_dismissed', '1');
}
