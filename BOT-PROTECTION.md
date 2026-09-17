# Signup bot protection

Context: between August 28 and September 17, 2026 the audience gained 231 contacts
through the browser-to-Mailchimp embedded form, almost all with fabricated names and
proxy/Tor-associated opt-in IPs. The exposed form action was the attack surface.

## What changed

The browser no longer talks to Mailchimp. All four signup forms now post JSON to a
Vercel Function that must accept the request before any contact is created.

```
Visitor
  -> form on golfstatiq.com (Turnstile widget rendered client-side)
  -> POST /api/request-access
       1. schema validation (name, email, launch monitor from a fixed list, goal 12-250 chars)
       2. honeypot field must be empty
       3. form fill time must be >= 3.5s and < 6h
       4. Turnstile token verified with Cloudflare Siteverify (hostname + action checked)
       5. rate limits per IP and per email
       6. Mailchimp contact created with status_if_new = "pending" (double opt-in)
          and tagged "Access Request - Submitted" / "Turnstile Verified"
  -> thank-you.html ("check your email to confirm")
```

Files:

| File | Role |
|---|---|
| `api/request-access.js` | The only route that may create a Mailchimp contact |
| `api/config.js` | Serves the public Turnstile site key (static site has no build step) |
| `js/request-access.js` | Adds the qualification fields, honeypot, and Turnstile widget to every `form[data-gsiq-signup]`, then submits JSON |

Forms upgraded: `index.html` (hero + final CTA), `from-the-bay/index.html`,
`from-the-bay/club-path-vs-face-angle.html`. No Mailchimp URL remains in any page.

## Required environment variables (Vercel -> Settings -> Environment Variables)

| Name | Sensitive | Notes |
|---|---|---|
| `TURNSTILE_SITE_KEY` | No | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is also accepted |
| `TURNSTILE_SECRET_KEY` | Yes | Server only. Without it the endpoint returns 503 and accepts nothing |
| `MAILCHIMP_API_KEY` | Yes | Server only |
| `MAILCHIMP_AUDIENCE_ID` | No | Mailchimp: Audience -> Settings -> Audience name and defaults -> Audience ID |
| `MAILCHIMP_SERVER_PREFIX` | No | Optional, e.g. `us14`. Derived from the API key suffix if omitted |
| `ALLOWED_HOSTNAMES` | No | Optional CSV. Defaults to golfstatiq.com, www.golfstatiq.com, localhost, 127.0.0.1. Add a Vercel preview hostname here if you want to test on a preview URL |

Redeploy after adding or changing any of these.

Until the Mailchimp variables are set, an accepted request is written to the Vercel
function log as `LEAD_NOT_DELIVERED mailchimp_not_configured` with the full payload, so
a real lead can still be recovered. Set them before announcing the form.

## Mailchimp setup

1. Audience -> Signup forms -> enable **double opt-in** (the endpoint sends
   `status_if_new: "pending"`, which relies on it).
2. Turn off or delete the old embedded/hosted form so the previous submit route cannot
   be replayed. Also enable Mailchimp's reCAPTCHA on any form that stays live.
3. Create two audience merge fields so the qualification answers are captured:
   - `LAUNCHMON` (text) - launch monitor or data source
   - `GOAL` (text) - what the golfer wants to diagnose. The form and endpoint bound this
     to 250 characters to stay inside Mailchimp's text merge field limit

   If these do not exist the endpoint logs `mailchimp_merge_fields_missing` and retries
   with `FNAME` only, so submissions still succeed.
4. Quarantine the 231 records from the incident window. Do not campaign to them.

## Vercel Firewall (recommended second layer)

The attack used ~189 distinct IPs, so in-function limits are a speed bump only.
In the project Firewall settings:

- Enable the **Bot Protection** managed ruleset.
- Add a rate-limit rule scoped to `path = /api/request-access` and `method = POST`:
  challenge above 3 requests per 10 minutes per IP, block above 10 per hour.
- Add an alert for more than 20-30 requests in 15 minutes.
- Do not block by country. Location was not a reliable signal in this incident.

## Local testing

```bash
export TURNSTILE_SITE_KEY=1x00000000000000000000AA          # Cloudflare test key, always passes
export TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
export ALLOWED_HOSTNAMES=localhost,127.0.0.1,example.com    # test keys report hostname example.com
vercel dev
```

Verified behavior of `/api/request-access`:

| Case | Result |
|---|---|
| `GET` | 405 |
| Missing or empty Turnstile token | 400, generic copy |
| Honeypot `company` populated | 400, generic copy |
| Submitted in under 3.5s | 400, generic copy |
| Launch monitor not in the allowed list | 400 |
| Goal shorter than 12 characters | 400 |
| Turnstile hostname not authorized | 400, `turnstile_rejected` logged |
| Valid submission | 200, Mailchimp contact pending, redirect to thank-you.html |
| Same email within 24h | 200 with neutral copy, no second Mailchimp write |
| 6th request from one IP within 15 min | 429 |

## Known limits

- Rate-limit counters live in function memory, so they reset on cold starts and are not
  shared across instances. The Vercel Firewall rule above is the durable control. If you
  want durable counters later, back them with Upstash Redis or Vercel KV.
- Leads are not stored anywhere outside Mailchimp yet. A small Postgres/Supabase
  `access_requests` table remains the better system of record for admission decisions.
- `contribute/index.html` still uploads directly to
  `https://golfstatiq-api.onrender.com/api/v1/contribute/upload` with no bot protection.
  That endpoint is a separate exposure and is out of scope for this change.
