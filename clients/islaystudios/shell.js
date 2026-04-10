// iSlay Studios portal shell — shared across all pages.
// Handles auth, sidebar, API calls, and common utilities.

const CLIENT_ID = 'islay_studios';

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

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    localStorage.removeItem('ge8_token');
    window.location.replace('/islaystudios/login');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function logout() {
  localStorage.removeItem('ge8_token');
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

// Build the sidebar shell
function initShell(activePage) {
  if (!requireAuth()) return;

  var nav = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'leads', label: 'Leads', icon: '👥' },
    { id: 'blasts', label: 'SMS Blasts', icon: '📱' },
    { id: 'calls', label: 'Voice Calls', icon: '📞' },
    { id: 'artists', label: 'Artists', icon: '✂️' },
    { id: 'credits', label: 'Credits', icon: '💳' },
    { id: 'analytics', label: 'Analytics', icon: '📈' },
    { id: 'settings', label: 'Settings', icon: '⚙️' }
  ];

  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  sidebar.innerHTML =
    '<div class="sb-brand">' +
      '<div class="sb-logo">iSlay Studios</div>' +
      '<div class="sb-sub">Client Portal</div>' +
    '</div>' +
    '<nav class="sb-nav">' +
    nav.map(function(n) {
      var cls = n.id === activePage ? 'sb-link active' : 'sb-link';
      return '<a href="/islaystudios/' + n.id + '" class="' + cls + '">' +
        '<span class="sb-icon">' + n.icon + '</span>' + n.label + '</a>';
    }).join('') +
    '</nav>' +
    '<div class="sb-footer">' +
      '<button onclick="logout()" class="sb-signout">Sign out</button>' +
      '<div class="sb-powered">Powered by GoElev8.AI</div>' +
    '</div>';

  // Mobile menu toggle
  var toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function() {
      sidebar.classList.toggle('open');
    });
  }
}
