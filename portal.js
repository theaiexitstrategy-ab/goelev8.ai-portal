/* ═══════════════════════════════════════════
   GoElev8.AI Client Portal — portal.js v2
   Live data via /api/data (Airtable proxy)
════════════════════════════════════════════ */

let currentClient = null;
let activeCharts = {};
let cache = {}; // In-memory cache per session

// ── AUTH ──────────────────────────────────
function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.querySelector('.login-btn');

  const client = authenticate(email, password);
  if (client) {
    errorEl.style.display = 'none';
    btn.textContent = 'LOADING...';
    sessionStorage.setItem('goelev8_client', client.id);
    currentClient = client;
    launchPortal(client);
  } else {
    errorEl.style.display = 'block';
    document.getElementById('login-password').value = '';
  }
}

function handleLogout() {
  sessionStorage.removeItem('goelev8_client');
  currentClient = null;
  cache = {};
  destroyCharts();
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.querySelector('.login-btn').textContent = 'ACCESS PORTAL';
}

document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });

window.addEventListener('DOMContentLoaded', () => {
  const savedId = sessionStorage.getItem('goelev8_client');
  if (savedId && CLIENTS[savedId]) {
    currentClient = CLIENTS[savedId];
    launchPortal(currentClient);
  }
});

// ── LAUNCH ────────────────────────────────
function launchPortal(client) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  const avatar = document.getElementById('client-avatar');
  avatar.textContent = client.avatar;
  avatar.style.background = hexToRgba(client.color, 0.15);
  avatar.style.color = client.color;
  avatar.style.border = `1px solid ${hexToRgba(client.color, 0.3)}`;
  document.getElementById('client-name-badge').textContent = client.name;
  document.getElementById('client-tier-badge').textContent = client.aiTier;

  // Handle deep links from PWA shortcuts (e.g. ?view=funnel)
  if (typeof checkDeepLink === 'function') checkDeepLink();
  else showView('overview');
}

// ── AIRTABLE FETCH ────────────────────────
async function fetchTable(table) {
  const key = `${currentClient.id}:${table}`;
  if (cache[key]) return cache[key]; // return cached data within session

  const res = await fetch(`/api/data?clientId=${currentClient.id}&table=${table}`);
  if (!res.ok) throw new Error(`Failed to fetch ${table}: ${res.status}`);
  const data = await res.json();
  cache[key] = data.records || [];
  return cache[key];
}

function loadingHTML() {
  return `<div class="loading-state"><div class="spinner"></div><div class="loading-text">Fetching live data from Airtable...</div></div>`;
}

function errorHTML(table, retryFn) {
  return `
    <div class="error-state">
      <div class="error-icon">⚠️</div>
      <p>Could not load ${table} data. Check your Airtable connection.</p>
      <button class="retry-btn" onclick="${retryFn}()">Retry</button>
    </div>
  `;
}

// ── NAVIGATION ────────────────────────────
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`view-${viewId}`).classList.add('active');
  document.querySelector(`.nav-item[onclick="showView('${viewId}')"]`).classList.add('active');

  const titles = { overview: 'OVERVIEW', funnel: 'FUNNEL SUBMISSIONS', crm: 'CRM CONTACTS', ai: 'AI RECOMMENDATIONS' };
  document.getElementById('topbar-title').textContent = titles[viewId];
  document.getElementById('topbar-meta').textContent = `${currentClient.name} · ${today()}`;

  destroyCharts();

  switch(viewId) {
    case 'overview': renderOverview(); break;
    case 'funnel':   renderFunnel();   break;
    case 'crm':      renderCRM();      break;
    case 'ai':       renderAI();       break;
  }
}

// ── OVERVIEW ──────────────────────────────
async function renderOverview() {
  const el = document.getElementById('overview-content');
  el.innerHTML = loadingHTML();

  try {
    const [leads, crm, recs] = await Promise.all([
      fetchTable('Leads'),
      fetchTable('CRM'),
      fetchTable('Recommendations')
    ]);

    // Compute stats from live data
    const totalLeads = leads.length;
    const newLeads = leads.filter(r => (r.Status || '').toLowerCase() === 'new').length;
    const bookedLeads = leads.filter(r => (r.Status || '').toLowerCase() === 'booked').length;
    const aiLeads = leads.filter(r => (r.Source || '').includes('AI')).length;
    const webLeads = leads.filter(r => (r.Source || '').includes('Web')).length;

    const closedWon = crm.filter(r => (r.Stage || '').toLowerCase().includes('closed') || (r.Stage || '').toLowerCase().includes('won')).length;

    // Aggregate stats from Stats table if available, otherwise derive
    let statsRecords = [];
    try { statsRecords = await fetchTable('Stats'); } catch(e) {}
    const statRow = statsRecords[0] || {};

    const pageViews = statRow.PageViews || 0;
    const viewsChange = statRow.PageViewsChange || null;
    const appts = statRow.Appointments || bookedLeads;
    const responseRate = statRow.ResponseRate || '—';

    // Build weekly chart data from Stats or use lead date distribution
    const weeklyViews = statRow.WeeklyViews
      ? JSON.parse(statRow.WeeklyViews)
      : buildWeeklyFromLeads(leads);

    el.innerHTML = `
      <div class="stats-grid">
        ${statCard('Page Views (Total)', pageViews > 0 ? pageViews.toLocaleString() : '—', viewsChange, '👁', '#00d4ff')}
        ${statCard('Total Leads', totalLeads, null, '🎯', '#00e89a')}
        ${statCard('Appointments Set', appts, null, '📅', '#00d4ff')}
        ${statCard('AI Response Rate', responseRate !== '—' ? responseRate + '%' : '—', null, '🤖', '#00e89a')}
      </div>
      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-header">
            <div class="chart-title">Leads — Last 7 Days</div>
            <div class="chart-badge">${totalLeads} total leads</div>
          </div>
          <canvas id="chart-views"></canvas>
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <div class="chart-title">Lead Sources</div>
          </div>
          <canvas id="chart-sources"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Recent Submissions</div>
          <div style="font-size:12px;color:var(--cyan);cursor:pointer;" onclick="showView('funnel')">View All →</div>
        </div>
        ${leadsTable(leads.slice(0, 5), ['Name','Service','Date','Source','Status'])}
      </div>
    `;

    // Weekly leads chart
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const ctx1 = document.getElementById('chart-views').getContext('2d');
    activeCharts.views = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: days,
        datasets: [{
          data: weeklyViews,
          borderColor: currentClient.color,
          backgroundColor: hexToRgba(currentClient.color, 0.08),
          borderWidth: 2, fill: true, tension: 0.4,
          pointBackgroundColor: currentClient.color,
          pointRadius: 4, pointHoverRadius: 6
        }]
      },
      options: chartOptions()
    });

    // Sources donut
    const ctx2 = document.getElementById('chart-sources').getContext('2d');
    activeCharts.sources = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['AI Voice', 'Web Form', 'Other'],
        datasets: [{
          data: [aiLeads, webLeads, Math.max(0, totalLeads - aiLeads - webLeads)].filter((v,i,arr) => v > 0 || i < 2),
          backgroundColor: ['rgba(0,212,255,0.8)', 'rgba(0,232,154,0.8)', 'rgba(107,122,150,0.5)'],
          borderColor: ['#00d4ff', '#00e89a', '#3d4f6a'],
          borderWidth: 2, hoverOffset: 6
        }]
      },
      options: {
        ...chartOptions(),
        cutout: '65%',
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#6b7a96', font: { family: 'Outfit', size: 11 }, padding: 16 } },
          tooltip: tooltipStyle()
        }
      }
    });

  } catch(err) {
    console.error(err);
    el.innerHTML = errorHTML('overview', 'renderOverview');
  }
}

// ── FUNNEL ────────────────────────────────
let funnelFilter = 'all';
let funnelData = [];

async function renderFunnel(filter) {
  if (filter !== undefined) funnelFilter = filter;
  const contentEl = document.getElementById('funnel-content');

  if (funnelData.length === 0) {
    contentEl.innerHTML = loadingHTML();
    try {
      funnelData = await fetchTable('Leads');
    } catch(err) {
      contentEl.innerHTML = errorHTML('Leads', 'renderFunnel');
      return;
    }
  }

  const statuses = ['all', 'new', 'contacted', 'booked', 'closed'];
  const counts = {};
  statuses.forEach(s => {
    counts[s] = s === 'all' ? funnelData.length : funnelData.filter(r => (r.Status || '').toLowerCase() === s).length;
  });

  document.getElementById('funnel-count').textContent =
    `${counts.all} total submissions · ${counts.new} new`;

  document.getElementById('funnel-filters').innerHTML =
    statuses.map(s => `
      <button class="filter-btn ${funnelFilter === s ? 'active' : ''}" onclick="renderFunnel('${s}')">
        ${capitalize(s)}${counts[s] > 0 ? ` (${counts[s]})` : ''}
      </button>
    `).join('');

  const filtered = funnelFilter === 'all'
    ? funnelData
    : funnelData.filter(r => (r.Status || '').toLowerCase() === funnelFilter);

  contentEl.innerHTML = filtered.length === 0
    ? `<div class="table-wrap"><div class="empty"><div class="empty-icon">📭</div>No submissions matching this filter</div></div>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>Contact</th><th>Service Requested</th><th>Date</th><th>Source</th><th>Status</th></tr></thead>
        <tbody>
          ${filtered.map(r => `
            <tr>
              <td>
                <div style="font-weight:600">${r.Name || '—'}</div>
                <div style="font-size:11px;color:var(--muted)">${r.Email || ''} ${r.Phone ? '· ' + r.Phone : ''}</div>
              </td>
              <td>${r.Service || '—'}</td>
              <td style="color:var(--muted);white-space:nowrap">${formatDate(r.Date || r.SubmittedDate || r.CreatedDate)}</td>
              <td><span class="source-tag ${(r.Source||'').includes('AI') ? 'source-ai' : 'source-web'}">${r.Source || '—'}</span></td>
              <td>${statusPill(r.Status || 'new')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>`;
}

// ── CRM ───────────────────────────────────
let crmData = [];

async function renderCRM() {
  const contentEl = document.getElementById('crm-content');

  if (crmData.length === 0) {
    contentEl.innerHTML = loadingHTML();
    try {
      crmData = await fetchTable('CRM');
    } catch(err) {
      contentEl.innerHTML = errorHTML('CRM', 'renderCRM');
      return;
    }
  }

  filterCRM();
}

function filterCRM() {
  const contentEl = document.getElementById('crm-content');
  const search = (document.getElementById('crm-search')?.value || '').toLowerCase();

  const filtered = crmData.filter(r =>
    !search ||
    (r.Name || '').toLowerCase().includes(search) ||
    (r.Email || '').toLowerCase().includes(search) ||
    (r.Stage || '').toLowerCase().includes(search) ||
    (r.Notes || '').toLowerCase().includes(search)
  );

  const closedCount = crmData.filter(r => (r.Stage || '').toLowerCase().includes('closed') || (r.Stage || '').toLowerCase().includes('won')).length;
  document.getElementById('crm-count').textContent = `${crmData.length} contacts · ${closedCount} closed won`;

  contentEl.innerHTML = filtered.length === 0
    ? `<div class="table-wrap"><div class="empty"><div class="empty-icon">🔍</div>No contacts match your search</div></div>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Contact</th><th>Pipeline Value</th><th>Stage</th><th>Last Contact</th><th>Notes</th></tr></thead>
        <tbody>
          ${filtered.map(r => `
            <tr>
              <td><div style="font-weight:600">${r.Name || '—'}</div></td>
              <td>
                <div style="font-size:12px">${r.Email || ''}</div>
                <div style="font-size:11px;color:var(--muted)">${r.Phone || ''}</div>
              </td>
              <td style="font-weight:600;color:var(--cyan)">${r.Value || r.PipelineValue || '—'}</td>
              <td>${stagePill(r.Stage || '—')}</td>
              <td style="color:var(--muted);white-space:nowrap">${formatDate(r.LastContact || r.LastContactDate)}</td>
              <td style="font-size:12px;color:var(--muted);max-width:200px">${r.Notes || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>`;
}

// ── AI RECOMMENDATIONS ────────────────────
async function renderAI() {
  const contentEl = document.getElementById('ai-content');
  contentEl.innerHTML = loadingHTML();

  try {
    const recs = await fetchTable('Recommendations');

    if (recs.length === 0) {
      contentEl.innerHTML = `<div class="empty"><div class="empty-icon">🤖</div>No recommendations yet — check back soon as your data builds up.</div>`;
      return;
    }

    contentEl.innerHTML = `<div class="recs-grid">
      ${recs.map(r => {
        const priority = (r.Priority || 'medium').toLowerCase();
        const priorityLabel = priority === 'high' ? '🔴 HIGH PRIORITY' : priority === 'medium' ? '🟡 MEDIUM PRIORITY' : '⚪ LOW PRIORITY';
        return `
          <div class="rec-card priority-${priority}">
            <div class="rec-icon">${r.Icon || '💡'}</div>
            <div>
              <div class="rec-priority">${priorityLabel}</div>
              <div class="rec-title">${r.Title || ''}</div>
              <div class="rec-body">${r.Body || r.Description || ''}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>`;

  } catch(err) {
    console.error(err);
    contentEl.innerHTML = errorHTML('Recommendations', 'renderAI');
  }
}

// ── HELPERS ───────────────────────────────
function buildWeeklyFromLeads(leads) {
  // Count leads per day of week from recent data
  const counts = [0,0,0,0,0,0,0];
  const now = new Date();
  leads.forEach(r => {
    const dateStr = r.Date || r.SubmittedDate || r.CreatedDate;
    if (!dateStr) return;
    const d = new Date(dateStr);
    const diff = Math.floor((now - d) / 86400000);
    if (diff >= 0 && diff < 7) {
      const dayIndex = (d.getDay() + 6) % 7; // Mon=0
      counts[dayIndex]++;
    }
  });
  return counts;
}

function leadsTable(leads, cols) {
  if (!leads.length) return `<div class="empty"><div class="empty-icon">📭</div>No submissions yet</div>`;
  return `<table>
    <thead><tr><th>Name</th><th>Service</th><th>Date</th><th>Source</th><th>Status</th></tr></thead>
    <tbody>
      ${leads.map(r => `
        <tr>
          <td><strong>${r.Name || '—'}</strong></td>
          <td style="color:var(--muted)">${r.Service || '—'}</td>
          <td style="color:var(--muted)">${formatDate(r.Date || r.SubmittedDate)}</td>
          <td><span class="source-tag ${(r.Source||'').includes('AI') ? 'source-ai' : 'source-web'}">${r.Source || '—'}</span></td>
          <td>${statusPill(r.Status || 'new')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;
}

function statCard(label, value, change, icon, accentColor) {
  const changeHtml = change !== null && change !== undefined
    ? `<div class="stat-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}% vs last month</div>`
    : '';
  return `<div class="stat-card" style="--accent-color:${accentColor}">
    <div class="stat-icon">${icon}</div>
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${changeHtml}
  </div>`;
}

function statusPill(status) {
  const s = (status || '').toLowerCase().replace(/\s+/g, '-');
  const labels = { new:'New', contacted:'Contacted', booked:'Booked', closed:'Closed' };
  return `<span class="status-pill status-${s}">${labels[s] || status}</span>`;
}

function stagePill(stage) {
  const map = {
    'Closed Won':'won','Closed':'won','Booked':'booked','Deposit Paid':'deposit',
    'Negotiation':'negotiation','Discovery':'discovery','Proposal Sent':'proposal','Trial':'trial'
  };
  const cls = map[stage] || 'contacted';
  return `<span class="status-pill status-${cls}">${stage}</span>`;
}

function chartOptions() {
  return {
    responsive: true, maintainAspectRatio: true,
    plugins: { legend: { display: false }, tooltip: tooltipStyle() },
    scales: {
      x: { grid: { color: 'rgba(30,42,58,0.5)' }, ticks: { color: '#6b7a96', font: { family: 'Outfit', size: 11 } }, border: { color: '#1e2a3a' } },
      y: { grid: { color: 'rgba(30,42,58,0.5)' }, ticks: { color: '#6b7a96', font: { family: 'Outfit', size: 11 } }, border: { color: '#1e2a3a' } }
    }
  };
}

function tooltipStyle() {
  return {
    backgroundColor: '#131820', borderColor: '#1e2a3a', borderWidth: 1,
    titleColor: '#e8edf5', bodyColor: '#6b7a96',
    titleFont: { family: 'Outfit', size: 12 }, bodyFont: { family: 'Outfit', size: 12 }
  };
}

function destroyCharts() {
  Object.values(activeCharts).forEach(ch => { try { ch.destroy(); } catch(e){} });
  activeCharts = {};
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function today() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
