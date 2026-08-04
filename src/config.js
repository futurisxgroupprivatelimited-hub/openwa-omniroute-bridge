export const config = {
  port: Number(process.env.PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgres://openbridge:openbridge@localhost:5432/openbridge',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  webhookBase: (process.env.WEBHOOK_BASE || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, ''),
  omnirouteBase: (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128').replace(/\/$/, ''),
  omnirouteBearer: process.env.OMNIROUTE_BEARER || 'omniroute',
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@openbridge.local').toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'admin12345',
  sessionPollMs: Number(process.env.SESSION_POLL_MS || 30000),
  // WhatsApp ban-safety rails for the reconnect/periodic catch-up loop.
  // These only bound bursty/backdated replies — a burst of sends right after
  // reconnect or a reply to a days-old message is a classic automation signal.
  syncReplyDripMs: Number(process.env.SYNC_REPLY_DRIP_MS || 12000), // min gap between catch-up replies
  syncReplyMaxChats: Number(process.env.SYNC_REPLY_MAX_CHATS || 5), // max chats answered per sync pass
  syncReplyMaxAgeMs: Number(process.env.SYNC_REPLY_MAX_AGE_MS || 48 * 60 * 60 * 1000), // don't reply to msgs older than this
};
export const __SENTINEL__ = 'loaded-from-local-src';
