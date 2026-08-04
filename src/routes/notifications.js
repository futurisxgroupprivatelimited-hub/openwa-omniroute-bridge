import { Router } from 'express';
import { requireUser } from '../auth.js';
import { listNotifications, unreadCount, markRead } from '../services/notifications.js';

const router = Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const page = Math.max(1, Number(req.query.page) || 1);
  const unreadOnly = req.query.unreadOnly === 'true';
  res.json(await listNotifications(req.user.id, { limit, page, unreadOnly }));
});

router.get('/unread-count', async (req, res) => {
  res.json({ count: await unreadCount(req.user.id) });
});

router.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  res.json(await markRead(req.user.id, ids));
});

export default router;
