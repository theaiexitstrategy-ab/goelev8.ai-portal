// The Flex Facility portal shell — shared across all Flex tabs.
// Mirrors clients/islaystudios/shell.js structure but scoped to the
// /theflexfacility/ route prefix.

var CLIENT_ID = 'the_flex_facility';

// Only one tab for now — Bookings. Add more entries here as more tabs
// are built out; shell auto-renders whatever is in TAB_CATALOG.
var TAB_CATALOG = {
  bookings: { label: 'Bookings', icon: '📅' }
};

var DEFAULT_TABS = ['bookings'];

function getToken() {
  return localStorage.getItem('ge8_token');
}

function requireAuth() {
  if (!getToken()) {
    window.location.replace('/theflexfacility/login');
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
    window.location.replace('/theflexfacility/login');
    throw new Error('unauthorized');
  }
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function logout() {
  localStorage.removeItem('ge8_token');
  sessionStorage.removeItem('ge8_client');
  window.location.replace('/theflexfacility/login');
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

// Build the sidebar for the Flex portal. `activePage` must match a key in
// TAB_CATALOG. Gating: the Bookings tab is only visible if the authed client
// has a booking_calendars row, which the bookings page itself verifies —
// since this portal currently has only one tab, if the calendar is missing
// the page shows a helpful message rather than hiding the nav entry.
function initShell(activePage) {
  if (!requireAuth()) return;

  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  renderSidebar(sidebar, activePage, DEFAULT_TABS);
  renderBottomTabs(activePage, DEFAULT_TABS);

  var toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function() {
      sidebar.classList.toggle('open');
    });
  }
}

function renderSidebar(sidebar, activePage, tabs) {
  var brandHtml =
    '<div class="sb-brand">' +
      '<div class="sb-logo">The Flex Facility</div>' +
      '<div class="sb-sub">Client Portal</div>' +
    '</div>';

  var navHtml = tabs.map(function(key) {
    var tab = TAB_CATALOG[key];
    if (!tab) return '';
    var cls = key === activePage ? 'sb-link active' : 'sb-link';
    return '<a href="/theflexfacility/' + key + '" class="' + cls + '">' +
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
    a.href = '/theflexfacility/' + key;
    a.className = cls;
    a.innerHTML = '<span class="btab-icon">' + tab.icon + '</span>' + tab.label;
    bar.appendChild(a);
  });

  document.body.appendChild(bar);
}
