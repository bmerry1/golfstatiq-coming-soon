/**
 * GolfStatIQ pre-alpha access form.
 *
 * Progressively upgrades every `<form data-gsiq-signup>` on the site:
 *   - adds launch-monitor and improvement-goal qualification fields
 *   - adds a hidden honeypot field
 *   - renders a Cloudflare Turnstile widget (site key fetched from /api/config)
 *   - submits JSON to /api/request-access, never to Mailchimp directly
 *
 * All markup and styling is injected here so the four signup forms stay in
 * sync and no Tailwind rebuild is required.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/request-access';
  var CONFIG_ENDPOINT = '/api/config';
  var THANK_YOU = '/thank-you.html';
  var TURNSTILE_SRC =
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=gsiqTurnstileReady';

  var LAUNCH_MONITORS = [
    'TrackMan',
    'Foresight / GCQuad',
    'Garmin R10',
    'Rapsodo',
    'FlightScope / Mevo+',
    'Uneekor',
    'SkyTrak',
    'Bushnell Launch Pro',
    'Other',
    'Not using one yet'
  ];

  var STYLES =
    '.gsiq-field{width:100%;background:rgba(31,41,55,.8);color:#fff;border:1px solid #4b5563;' +
    'border-radius:.375rem;padding:.75rem 1rem;font:inherit;font-size:1rem;line-height:1.4;' +
    '-webkit-appearance:none;appearance:none;box-sizing:border-box}' +
    '.gsiq-field:focus{outline:none;border-color:#D4AF37;box-shadow:0 0 0 2px rgba(212,175,55,.6)}' +
    '.gsiq-field::placeholder{color:rgba(243,244,246,.45)}' +
    'select.gsiq-field{background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%23D4AF37\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E");' +
    'background-repeat:no-repeat;background-position:right .75rem center;background-size:1.1rem;padding-right:2.5rem}' +
    'select.gsiq-field option{background:#1A1A1A;color:#fff}' +
    'textarea.gsiq-field{min-height:5.5rem;resize:vertical}' +
    '.gsiq-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
    '.gsiq-turnstile{display:flex;justify-content:center;min-height:0}' +
    '.gsiq-msg{font-size:.8125rem;line-height:1.5;margin:.5rem 0 0;text-align:left}' +
    '.gsiq-msg-error{color:#fca5a5}' +
    '.gsiq-msg-ok{color:#86efac}' +
    '.gsiq-busy{opacity:.6;cursor:not-allowed}';

  var pending = [];
  var siteKey = null;
  var turnstileReady = false;

  function injectStyles() {
    if (document.getElementById('gsiq-signup-styles')) return;
    var style = document.createElement('style');
    style.id = 'gsiq-signup-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    if (text) node.textContent = text;
    return node;
  }

  function enhance(form, index) {
    var button = form.querySelector('button[type="submit"], button');
    var container = button ? button.parentNode : form;

    var select = el('select', {
      name: 'launchMonitor',
      class: 'gsiq-field',
      required: 'required',
      'aria-label': 'Launch monitor or data source'
    });
    var placeholder = el('option', { value: '', disabled: 'disabled', selected: 'selected' },
      'Launch monitor or data source');
    select.appendChild(placeholder);
    LAUNCH_MONITORS.forEach(function (name) {
      select.appendChild(el('option', { value: name }, name));
    });

    var goal = el('textarea', {
      name: 'improvementGoal',
      class: 'gsiq-field',
      required: 'required',
      maxlength: '500',
      'aria-label': 'What would you most like to diagnose or improve',
      placeholder:
        'What would you most like to diagnose? For example: driver dispersion, strike consistency, spin control, approach distance control.'
    });

    var honeypotWrap = el('div', { class: 'gsiq-hp', 'aria-hidden': 'true' });
    honeypotWrap.appendChild(
      el('input', { type: 'text', name: 'company', tabindex: '-1', autocomplete: 'off' })
    );

    var widget = el('div', { class: 'gsiq-turnstile' });
    var message = el('p', { class: 'gsiq-msg', 'aria-live': 'polite' });

    if (button) {
      container.insertBefore(select, button);
      container.insertBefore(goal, button);
      container.insertBefore(honeypotWrap, button);
      container.insertBefore(widget, button);
    } else {
      form.appendChild(select);
      form.appendChild(goal);
      form.appendChild(honeypotWrap);
      form.appendChild(widget);
    }
    form.appendChild(message);

    var state = {
      form: form,
      button: button,
      message: message,
      widget: widget,
      widgetId: null,
      token: null,
      loadedAt: Date.now(),
      submitting: false,
      buttonLabel: button ? button.textContent.trim() : 'Request Pre-Alpha Access',
      index: index
    };

    form.setAttribute('novalidate', 'novalidate');
    form.addEventListener('submit', function (event) {
      handleSubmit(event, state);
    });

    pending.push(state);
    renderWidget(state);
  }

  function say(state, text, kind) {
    state.message.textContent = text || '';
    state.message.className =
      'gsiq-msg' + (kind ? ' gsiq-msg-' + kind : '');
  }

  function renderWidget(state) {
    if (!turnstileReady || !siteKey || state.widgetId !== null) return;
    state.widgetId = window.turnstile.render(state.widget, {
      sitekey: siteKey,
      action: 'request-access',
      theme: 'dark',
      callback: function (token) {
        state.token = token;
      },
      'expired-callback': function () {
        state.token = null;
      },
      'error-callback': function () {
        state.token = null;
      }
    });
  }

  function renderAll() {
    pending.forEach(renderWidget);
  }

  window.gsiqTurnstileReady = function () {
    turnstileReady = true;
    renderAll();
  };

  function busy(state, isBusy) {
    state.submitting = isBusy;
    if (!state.button) return;
    state.button.disabled = isBusy;
    state.button.classList.toggle('gsiq-busy', isBusy);
    state.button.textContent = isBusy ? 'Submitting...' : state.buttonLabel;
  }

  function handleSubmit(event, state) {
    event.preventDefault();
    if (state.submitting) return;

    var form = state.form;
    var firstName = (form.elements.FNAME && form.elements.FNAME.value || '').trim();
    var email = (form.elements.EMAIL && form.elements.EMAIL.value || '').trim();
    var launchMonitor = (form.elements.launchMonitor.value || '').trim();
    var improvementGoal = (form.elements.improvementGoal.value || '').trim();
    var honeypot = (form.elements.company && form.elements.company.value || '').trim();

    if (!firstName || firstName.length < 2) {
      say(state, 'Please enter your first name.', 'error');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) {
      say(state, 'Please enter a valid email address.', 'error');
      return;
    }
    if (!launchMonitor) {
      say(state, 'Please choose the launch monitor or data source you use most.', 'error');
      return;
    }
    if (improvementGoal.length < 12) {
      say(state, 'Please tell us in a few words what you want to diagnose or improve.', 'error');
      return;
    }
    if (!siteKey) {
      say(state, 'Verification is unavailable right now. Please try again shortly.', 'error');
      return;
    }
    if (!state.token) {
      say(state, 'Please complete the verification check just above the button.', 'error');
      return;
    }

    busy(state, true);
    say(state, '');

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: firstName,
        email: email,
        launchMonitor: launchMonitor,
        improvementGoal: improvementGoal,
        company: honeypot,
        elapsedMs: Date.now() - state.loadedAt,
        turnstileToken: state.token
      })
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { ok: response.ok, data: data };
          });
      })
      .then(function (result) {
        // Turnstile tokens are single-use: always reset after a submit.
        state.token = null;
        if (state.widgetId !== null) window.turnstile.reset(state.widgetId);

        if (!result.ok) {
          busy(state, false);
          say(
            state,
            result.data.message || 'We could not submit your request. Please try again.',
            'error'
          );
          return;
        }

        say(state, result.data.message || 'Request received.', 'ok');
        window.location.href = THANK_YOU;
      })
      .catch(function () {
        state.token = null;
        if (state.widgetId !== null) window.turnstile.reset(state.widgetId);
        busy(state, false);
        say(state, 'Network error. Please try again.', 'error');
      });
  }

  function loadTurnstileScript() {
    if (document.getElementById('gsiq-turnstile-script')) return;
    var script = el('script', {
      id: 'gsiq-turnstile-script',
      src: TURNSTILE_SRC,
      async: 'async',
      defer: 'defer'
    });
    document.head.appendChild(script);
  }

  function start() {
    var forms = document.querySelectorAll('form[data-gsiq-signup]');
    if (!forms.length) return;

    injectStyles();
    Array.prototype.forEach.call(forms, enhance);

    fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (config) {
        siteKey = config && config.turnstileSiteKey;
        if (!siteKey) throw new Error('missing site key');
        loadTurnstileScript();
        renderAll();
      })
      .catch(function () {
        pending.forEach(function (state) {
          say(
            state,
            'Access requests are briefly unavailable. Please try again shortly.',
            'error'
          );
        });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
