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
};
export const __SENTINEL__ = 'loaded-from-local-src';
