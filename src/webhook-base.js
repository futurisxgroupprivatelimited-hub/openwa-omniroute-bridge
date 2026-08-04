import { config } from './config.js';

// Webhook URLs must be reachable FROM the tenant's OpenWA instance, so we never
// want to show a hardcoded localhost. When WEBHOOK_BASE is explicitly set in the
// environment we honour it; otherwise we derive the base from the actual request
// the admin used to reach this dashboard (Host header) — far more likely to be a
// valid hostname/IP. OpenWA's SSRF guard only delivers to public hosts unless the
// target is allowlisted in its SSRF_ALLOWED_HOSTS.
export function webhookBaseFor(req) {
  if (process.env.WEBHOOK_BASE) return config.webhookBase;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host = req.headers.host || req.headers['x-forwarded-host'] || `localhost:${config.port}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}
