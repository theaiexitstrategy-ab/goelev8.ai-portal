/* © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
 *
 * Tiny form-capture beacon for client websites. Drop into <head> with:
 *
 *   <script>
 *     window.GoElev8 = { slug: "flex-facility", secret: "<webhook-secret>" };
 *   </script>
 *   <script src="https://portal.goelev8.ai/embed/track.js" async></script>
 *
 * Listens for any form submission on the page, extracts the most common
 * name/phone/email field names, and POSTs them to
 * https://portal.goelev8.ai/api/webhooks/lead. Never blocks the original
 * form submission. No dependencies, < 5 KB minified.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__ge8TrackLoaded) return;
  window.__ge8TrackLoaded = true;

  var cfg = window.GoElev8 || {};
  if (!cfg.slug || !cfg.secret) {
    if (window.console && console.warn) {
      console.warn('[GoElev8] Missing window.GoElev8.slug or .secret — lead capture disabled.');
    }
    return;
  }

  var ENDPOINT = 'https://portal.goelev8.ai/api/webhooks/lead';

  // Field name guesses, ordered by specificity.
  var NAME_KEYS  = ['name', 'full_name', 'fullname', 'full-name', 'first_name', 'firstname', 'fname', 'first-name', 'your-name'];
  var EMAIL_KEYS = ['email', 'e-mail', 'email_address', 'emailaddress', 'your-email'];
  var PHONE_KEYS = ['phone', 'tel', 'telephone', 'mobile', 'cell', 'phone_number', 'phonenumber', 'your-phone'];

  function pick(form, keys) {
    // Try element name match first.
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var el = form.elements[k] || form.querySelector('[name="' + k + '"]');
      if (el && el.value) return String(el.value).trim();
    }
    // Then a fuzzy contains-match across all elements.
    var elements = form.elements;
    for (var j = 0; j < elements.length; j++) {
      var e = elements[j];
      var n = (e.name || e.id || '').toLowerCase();
      if (!n || !e.value) continue;
      for (var k2 = 0; k2 < keys.length; k2++) {
        if (n.indexOf(keys[k2]) !== -1) return String(e.value).trim();
      }
    }
    // Last resort for emails: any input[type=email] / [type=tel].
    if (keys === EMAIL_KEYS) {
      var em = form.querySelector('input[type="email"]');
      if (em && em.value) return em.value.trim();
    }
    if (keys === PHONE_KEYS) {
      var ph = form.querySelector('input[type="tel"]');
      if (ph && ph.value) return ph.value.trim();
    }
    return null;
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    // Prefer sendBeacon when supported so the request survives the
    // form's own navigation, otherwise fall back to a keepalive fetch.
    try {
      if (navigator.sendBeacon) {
        // sendBeacon doesn't accept custom headers, so wrap as a Blob with
        // a content-type. The serverless function reads the secret from
        // the body field as a fallback when the header is missing.
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (_) {}
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'X-GoElev8-Secret': cfg.secret
        },
        body: body
      }).catch(function () {});
    } catch (_) {}
  }

  function inferFunnel(path) {
    if (!path) return null;
    var p = path.toLowerCase();
    if (p.indexOf('/fit') === 0 || p.indexOf('/fit/') !== -1) return 'fit';
    if (p.indexOf('/rs2') === 0 || p.indexOf('/rs2/') !== -1) return 'rs2';
    if (p.indexOf('/book') === 0 || p.indexOf('/book/') !== -1) return 'booking';
    if (p === '/' || p === '') return 'main';
    return null;
  }

  function handleSubmit(ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    try {
      var name  = pick(form, NAME_KEYS);
      var email = pick(form, EMAIL_KEYS);
      var phone = pick(form, PHONE_KEYS);
      if (!name && !email && !phone) return;

      var loc = window.location || {};
      var source = (loc.host || '') + (loc.pathname || '');
      var funnel = inferFunnel(loc.pathname);

      send({
        slug:   cfg.slug,
        secret: cfg.secret, // beacon fallback (header version preferred)
        name:   name,
        phone:  phone,
        email:  email,
        source: source,
        funnel: funnel,
        metadata: {
          path:       loc.pathname || null,
          url:        loc.href || null,
          title:      document.title || null,
          referrer:   document.referrer || null,
          form_id:    form.id || null,
          form_name:  form.getAttribute('name') || null,
          form_action: form.action || null,
          user_agent: navigator.userAgent || null
        }
      });
    } catch (e) {
      if (window.console && console.warn) console.warn('[GoElev8] capture failed', e);
    }
    // Never block the original submission.
  }

  // Capture phase so we run before the form's own onsubmit handler can
  // navigate / unmount the page.
  document.addEventListener('submit', handleSubmit, true);
})();
