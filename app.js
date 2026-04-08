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
  view: 'overview'
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
}

// ============================================================
// SHELL
// ============================================================
function shell(content) {
  const navBtn = (id, label) =>
    el('button', { class: state.view === id ? 'active' : '', onclick: () => { state.view = id; render(); } }, label);

  const adminSection = state.isAdmin
    ? el('div', { class: 'admin-section' },
        el('div', { class: 'admin-label' }, 'ADMIN'),
        navBtn('admin', 'Master Admin'),
        state.impersonating
          ? el('button', { class: 'btn-stop-impersonate', onclick: () => { setImpersonation(null); render(); } },
              '× Stop impersonating')
          : null
      )
    : null;

  const banner = state.isAdmin && state.impersonating
    ? el('div', { class: 'impersonation-banner' },
        el('span', {}, 'Viewing as '),
        el('strong', {}, state.client?.name || '…'),
        el('button', { class: 'link', onclick: () => { setImpersonation(null); render(); } }, 'Exit'))
    : null;

  return el('div', { class: 'app' + (state.isAdmin ? ' is-admin' : '') },
    el('aside', { class: 'sidebar' },
      el('div', { class: 'brand' },
        el('div', { class: 'logo' }, el('img', { src: '/logo.png', alt: '' })),
        el('div', { class: 'name' }, 'GoElev8.AI',
          el('small', {}, state.isAdmin ? 'Master Admin' : 'Client Portal'))
      ),
      state.client
        ? el('div', { class: 'client-pill' },
            el('div', { class: 'name' }, state.client?.name || ''),
            el('div', { class: 'num' }, state.client?.twilio_phone_number || 'No number assigned')
          )
        : null,
      state.client
        ? el('div', { class: 'nav' },
            navBtn('overview', 'Overview'),
            navBtn('activity', 'Activity'),
            navBtn('messages', 'Messages'),
            navBtn('contacts', 'Contacts'),
            navBtn('leads', 'Leads'),
            navBtn('calls', 'Voice Calls'),
            navBtn('bookings', 'Bookings'),
            navBtn('billing', 'Credits & Billing'),
            navBtn('connect', 'Payments (Connect)'),
            navBtn('settings', 'Settings')
          )
        : null,
      adminSection,
      el('button', { class: 'signout', onclick: logout }, 'Sign out')
    ),
    el('main', { class: 'main' }, banner, content)
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
// LEADS
// ============================================================
async function viewLeads() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' },
    el('h1', {}, 'Leads'),
    el('div', { class: 'muted' }, 'Captured by Vapi voice agents and web forms')
  ));
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
            await api('/api/portal/crm?action=leads', { method: 'DELETE', body: { id: l.id } });
            render();
          }}, 'Delete'))
        )
      ))
    ));
  } catch (e) { panel.innerHTML = `<p class="err">${e.message}</p>`; }
  return wrap;
}

// ============================================================
// VOICE CALLS (Vapi)
// ============================================================
async function viewCalls() {
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
function viewSettings() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'topbar' }, el('h1', {}, 'Settings')));

  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('h2', {}, 'Account'));
  panel.appendChild(el('p', {}, `Email: ${state.user?.email || ''}`));
  panel.appendChild(el('p', {}, `Client: ${state.client?.name || ''}`));
  wrap.appendChild(panel);

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
            }}, c.billing_paused ? 'Resume billing' : 'Pause billing')
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
      case 'settings':  view = viewSettings(); break;
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
