/* ═══════════════════════════════════════════
   GoElev8.AI Portal — pwa.js
   Service Worker registration + install prompt
════════════════════════════════════════════ */

let deferredInstallPrompt = null;

// ── SERVICE WORKER REGISTRATION ───────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[GoElev8 PWA] Service worker registered:', reg.scope);

      // Check for updates every 60 minutes
      setInterval(() => reg.update(), 60 * 60 * 1000);

    } catch(err) {
      console.warn('[GoElev8 PWA] Service worker registration failed:', err);
    }
  });
}

// ── INSTALL PROMPT ────────────────────────
// Capture the browser's beforeinstallprompt event
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;

  // Don't show if user already dismissed this session
  if (!sessionStorage.getItem('pwa-dismissed')) {
    // Show after a short delay — don't interrupt the login flow
    setTimeout(showInstallBanner, 4000);
  }
});

function showInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('show');
}

function installPWA() {
  if (!deferredInstallPrompt) return;

  document.getElementById('install-banner').classList.remove('show');
  deferredInstallPrompt.prompt();

  deferredInstallPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      console.log('[GoElev8 PWA] User accepted install');
    }
    deferredInstallPrompt = null;
  });
}

function dismissInstall() {
  document.getElementById('install-banner').classList.remove('show');
  sessionStorage.setItem('pwa-dismissed', '1');
}

// Hide banner if app gets installed
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').classList.remove('show');
  deferredInstallPrompt = null;
  console.log('[GoElev8 PWA] App installed successfully');
});

// ── OFFLINE / ONLINE DETECTION ────────────
function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (!navigator.onLine) {
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus(); // Check immediately on load

// ── DEEP LINK SHORTCUT SUPPORT ────────────
// Handle ?view=funnel etc. from manifest shortcuts
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view && ['funnel','crm','overview','ai'].includes(view)) {
    // Store requested view — portal.js will pick it up after login
    sessionStorage.setItem('goelev8_deeplink_view', view);
  }
});

// Called by portal.js after login to handle shortcut deep links
function checkDeepLink() {
  const view = sessionStorage.getItem('goelev8_deeplink_view');
  if (view) {
    sessionStorage.removeItem('goelev8_deeplink_view');
    setTimeout(() => showView(view), 100);
  }
}
