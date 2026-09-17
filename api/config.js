/**
 * GET /api/config
 *
 * Serves the *public* Turnstile site key to the browser.
 *
 * This site is static HTML with no build step, so it cannot inline an
 * environment variable at build time. Serving the public site key from a
 * function keeps the key out of the repository entirely.
 *
 * Only the site key is exposed here. TURNSTILE_SECRET_KEY must never be
 * returned by this endpoint.
 */

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ message: 'Method not allowed.' });
    return;
  }

  const siteKey =
    process.env.TURNSTILE_SITE_KEY ||
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
    '';

  // Cache briefly at the edge; the value changes only when the widget is rotated.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json({ turnstileSiteKey: siteKey });
};
