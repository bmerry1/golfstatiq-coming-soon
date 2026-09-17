/**
 * POST /api/request-access
 *
 * The ONLY route allowed to create a Mailchimp contact for GolfStatIQ.
 *
 * Controls applied, in order:
 *   1. Method + payload schema validation
 *   2. Honeypot field must be empty
 *   3. Minimum form-fill time (blocks instant scripted posts)
 *   4. Cloudflare Turnstile token validated server-side (Siteverify),
 *      including hostname and action checks
 *   5. In-memory rate limiting per IP and per email
 *   6. Mailchimp contact created as `pending` (double opt-in) and tagged
 *
 * Environment variables (Vercel -> Settings -> Environment Variables):
 *   TURNSTILE_SECRET_KEY        (required, server only)
 *   TURNSTILE_SITE_KEY          (required, public; NEXT_PUBLIC_ prefix also accepted)
 *   MAILCHIMP_API_KEY           (required for delivery, server only)
 *   MAILCHIMP_AUDIENCE_ID       (required for delivery)
 *   MAILCHIMP_SERVER_PREFIX     (optional, e.g. us14 - derived from the API key if unset)
 *   ALLOWED_HOSTNAMES           (optional CSV override; defaults below)
 */

const crypto = require('crypto');

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const TURNSTILE_ACTION = 'request-access';

const DEFAULT_ALLOWED_HOSTNAMES = [
  'golfstatiq.com',
  'www.golfstatiq.com',
  'localhost',
  '127.0.0.1',
];

const MIN_FILL_MS = 3500;
const MAX_FILL_MS = 1000 * 60 * 60 * 6; // stale form: make the visitor reload

const LAUNCH_MONITORS = [
  'TrackMan',
  'Foresight / GCQuad',
  'Garmin R10',
  'Rapsodo',
  'FlightScope / Mevo+',
  'Uneekor',
  'SkyTrak',
  'Bushnell Launch Pro',
  'Other',
  'Not using one yet',
];

const GENERIC_ERROR = 'We could not process that request. Please try again.';

/* ------------------------------------------------------------------ *
 * Rate limiting
 *
 * In-memory counters are per warm function instance, so they are a
 * speed bump rather than a guarantee. Pair with a Vercel WAF rate-limit
 * rule on POST /api/request-access (see BOT-PROTECTION.md).
 * ------------------------------------------------------------------ */

const hits = new Map(); // key -> array of timestamps

function recentHits(key, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent;
}

// Peek without consuming: a request that later fails verification must not
// burn a legitimate visitor's retry allowance.
function overLimit(key, limit, windowMs) {
  return recentHits(key, windowMs).length >= limit;
}

function recordHit(key, windowMs) {
  const recent = recentHits(key, windowMs);
  recent.push(Date.now());
  hits.set(key, recent);

  if (hits.size > 5000) {
    const now = Date.now();
    for (const [k, times] of hits) {
      if (!times.length || now - times[times.length - 1] > windowMs) hits.delete(k);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && email.length <= 254;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    return String(forwarded[0]).split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || '';
}

function allowedHostnames() {
  const raw = process.env.ALLOWED_HOSTNAMES;
  if (!raw) return DEFAULT_ALLOWED_HOSTNAMES;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) return JSON.parse(req.body);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ------------------------------------------------------------------ *
 * Mailchimp (server-side only, double opt-in)
 * ------------------------------------------------------------------ */

function mailchimpConfig() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!apiKey || !audienceId) return null;

  const prefix =
    process.env.MAILCHIMP_SERVER_PREFIX ||
    (apiKey.includes('-') ? apiKey.split('-').pop() : '');
  if (!prefix) return null;

  return { apiKey, audienceId, prefix };
}

function mailchimpHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
  };
}

async function upsertMailchimpContact(cfg, lead) {
  const hash = crypto
    .createHash('md5')
    .update(lead.email.toLowerCase())
    .digest('hex');

  const base = `https://${cfg.prefix}.api.mailchimp.com/3.0/lists/${cfg.audienceId}/members/${hash}`;

  const fullMergeFields = {
    FNAME: lead.firstName,
    LAUNCHMON: lead.launchMonitor,
    GOAL: lead.improvementGoal,
  };

  async function put(mergeFields) {
    return fetch(base, {
      method: 'PUT',
      headers: mailchimpHeaders(cfg.apiKey),
      body: JSON.stringify({
        email_address: lead.email,
        // Double opt-in: new contacts must confirm by email before they
        // become marketable or invitable.
        status_if_new: 'pending',
        merge_fields: mergeFields,
      }),
      cache: 'no-store',
    });
  }

  let response = await put(fullMergeFields);

  // If LAUNCHMON / GOAL merge fields have not been created in the audience yet,
  // Mailchimp rejects the request. Retry with FNAME only so the lead is never lost.
  if (response.status === 400) {
    const detail = await response.text();
    if (/merge field|merge_fields/i.test(detail)) {
      console.warn(
        'mailchimp_merge_fields_missing: create LAUNCHMON and GOAL merge tags in the audience to capture qualification answers'
      );
      response = await put({ FNAME: lead.firstName });
    } else {
      throw new Error(`mailchimp_put_failed ${response.status} ${detail.slice(0, 400)}`);
    }
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`mailchimp_put_failed ${response.status} ${detail.slice(0, 400)}`);
  }

  // Tag separately so the tag call cannot break contact creation.
  try {
    await fetch(`${base}/tags`, {
      method: 'POST',
      headers: mailchimpHeaders(cfg.apiKey),
      body: JSON.stringify({
        tags: [
          { name: 'Access Request - Submitted', status: 'active' },
          { name: 'Turnstile Verified', status: 'active' },
        ],
      }),
      cache: 'no-store',
    });
  } catch (error) {
    console.warn('mailchimp_tagging_failed', error.message);
  }
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ message: 'Method not allowed.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    res.status(400).json({ message: GENERIC_ERROR });
    return;
  }

  const firstName = cleanText(body.firstName, 60);
  const email = cleanText(body.email, 254).toLowerCase();
  const launchMonitor = cleanText(body.launchMonitor, 100);
  const improvementGoal = cleanText(body.improvementGoal, 500);
  const honeypot = cleanText(body.company, 200);
  const turnstileToken = cleanText(body.turnstileToken, 4096);
  const elapsedMs = Number(body.elapsedMs);

  // 1. Schema / content validation
  if (
    firstName.length < 2 ||
    !validEmail(email) ||
    !LAUNCH_MONITORS.includes(launchMonitor) ||
    improvementGoal.length < 12 ||
    !turnstileToken
  ) {
    res.status(400).json({
      message:
        'Please complete every field and the verification check, and tell us a little about what you want to improve.',
    });
    return;
  }

  // 2 + 3. Honeypot and timing
  if (
    honeypot ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < MIN_FILL_MS ||
    elapsedMs > MAX_FILL_MS
  ) {
    res.status(400).json({ message: GENERIC_ERROR });
    return;
  }

  const ip = clientIp(req);

  const IP_WINDOW = 15 * 60 * 1000;
  const EMAIL_WINDOW = 24 * 60 * 60 * 1000;

  // 5. Limits are checked here (before spending a Siteverify call) but only
  //    recorded after verification succeeds.
  if (ip && overLimit(`ip:${ip}`, 5, IP_WINDOW)) {
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
    return;
  }
  if (overLimit(`email:${email}`, 1, EMAIL_WINDOW)) {
    // Neutral wording: never reveal whether an address is already on file.
    res.status(200).json({
      message: 'Request received. Please check your inbox to confirm your email address.',
    });
    return;
  }

  // 4. Turnstile server-side validation (mandatory)
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('turnstile_secret_missing: set TURNSTILE_SECRET_KEY in Vercel');
    res.status(503).json({
      message: 'Access requests are briefly unavailable. Please try again shortly.',
    });
    return;
  }

  let verification;
  try {
    const params = new URLSearchParams({ secret, response: turnstileToken });
    if (ip) params.set('remoteip', ip);

    const verifyResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      cache: 'no-store',
    });
    verification = await verifyResponse.json();
  } catch (error) {
    console.error('turnstile_verify_error', error.message);
    res.status(400).json({ message: 'Verification failed. Please try again.' });
    return;
  }

  const hostnameOk =
    !verification.hostname ||
    allowedHostnames().includes(String(verification.hostname).toLowerCase());
  const actionOk = !verification.action || verification.action === TURNSTILE_ACTION;

  if (!verification.success || !hostnameOk || !actionOk) {
    console.warn('turnstile_rejected', {
      codes: verification['error-codes'],
      hostname: verification.hostname,
      action: verification.action,
    });
    res.status(400).json({
      message: 'Verification expired or failed. Please reload the page and try again.',
    });
    return;
  }

  if (ip) recordHit(`ip:${ip}`, IP_WINDOW);
  recordHit(`email:${email}`, EMAIL_WINDOW);

  // 6. Deliver to Mailchimp
  const lead = { firstName, email, launchMonitor, improvementGoal };
  const cfg = mailchimpConfig();

  if (!cfg) {
    // Loud, greppable log so a real lead is recoverable from Vercel logs
    // if the Mailchimp variables have not been set yet.
    console.error('LEAD_NOT_DELIVERED mailchimp_not_configured', {
      ...lead,
      submittedAt: new Date().toISOString(),
    });
  } else {
    try {
      await upsertMailchimpContact(cfg, lead);
    } catch (error) {
      console.error('LEAD_NOT_DELIVERED', error.message, {
        ...lead,
        submittedAt: new Date().toISOString(),
      });
      res.status(502).json({
        message:
          'We received your request but could not confirm it. Please try again in a few minutes.',
      });
      return;
    }
  }

  console.info('access_request_accepted', {
    email,
    launchMonitor,
    goalLength: improvementGoal.length,
    submittedAt: new Date().toISOString(),
  });

  res.status(200).json({
    message: 'Request received. Please check your inbox to confirm your email address.',
  });
};
