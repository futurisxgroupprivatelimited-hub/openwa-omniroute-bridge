import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query } from './db.js';
import webhookRouter from './webhook.js';
import authRoutes from './routes/auth.js';
import characterRoutes from './routes/characters.js';
import sessionRoutes from './routes/sessions.js';
import settingsRoutes from './routes/settings.js';
import webhookRoutes from './routes/webhooks.js';
import dashboardRoutes from './routes/dashboard.js';
import { discoverSessions, logLine, registerWebhooksForSession } from './services/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use('/api', express.json({ limit: '2mb' }));
app.use('/api', express.urlencoded({ extended: true }));

app.use(webhookRouter); // POST /webhook/:token[/:slug] — reads raw body, keep before /api json middleware
app.use('/api/auth', authRoutes);
app.use('/api/characters', characterRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error('[api] error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  logLine(`[bridge] SaaS listening on http://localhost:${config.port}`);
  logLine(`[bridge] webhook base: ${config.webhookBase}`);
  logLine(`[bridge] OmniRoute: ${config.omnirouteBase}`);
  logLine(`[bridge] session poll: every ${config.sessionPollMs}ms`);
});

// Background: refresh every tenant's sessions + auto-register webhooks
async function pollAllSessions() {
  try {
    const r = await query('SELECT * FROM users WHERE openwa_base_url IS NOT NULL AND openwa_api_key IS NOT NULL');
    for (const user of r.rows) {
      try {
        const sessions = await discoverSessions(user);
        if (user.webhooks_auto_register !== false) {
          for (const s of sessions) {
            if (!s.webhook_registered) {
              try {
                const urls = await registerWebhooksForSession(user, s);
                await logLine(`[poll] ${user.email} auto-registered ${urls.length} webhook(s) on ${s.name}`);
              } catch (e) {
                await logLine(`[poll] ${user.email} ${s.name} register failed: ${e.message}`);
              }
            }
          }
        }
      } catch (e) {
        await logLine(`[poll] ${user.email} session refresh failed: ${e.message}`);
      }
    }
  } catch (e) {
    await logLine(`[poll] error: ${e.message}`);
  }
}
setTimeout(pollAllSessions, 3000);
setInterval(pollAllSessions, config.sessionPollMs);
