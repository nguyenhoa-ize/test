const express = require('express');
const pool = require('../db');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth.middleware');

// API: GET /api/admin/notifications
router.get('/notifications', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const tab = req.query.tab || 'all';

    // Lấy tổng số thông báo
    let countQuery = `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND (type = 'report_new' OR type = 'post_approval')`;
    let notiQuery = `
      SELECT
        n.*,
        u.first_name AS sender_first_name,
        u.last_name AS sender_last_name,
        u.avatar_url AS sender_avatar_url
      FROM
          notifications n
      LEFT JOIN
          users u ON n.sender_id = u.id
      WHERE
          n.user_id = $1
          AND (n.type = 'report_new' OR n.type = 'post_approval')
    `;
    if (tab === 'unread') {
      countQuery += ' AND is_read = false';
      notiQuery += ' AND n.is_read = false';
    }
    notiQuery += ` ORDER BY n.created_at DESC LIMIT $2 OFFSET $3`;
    const countRes = await pool.query(countQuery, [userId]);
    const total = parseInt(countRes.rows[0].count);
    const { rows: notifications } = await pool.query(notiQuery, [userId, limit, offset]);

    const notiList = notifications.map(n => ({
      id: n.id,
      title: n.title,
      content: n.content,
      type: n.type,
      created_at: n.created_at,
      is_read: n.is_read,
      sender: n.sender_id ? {
        id: n.sender_id,
        first_name: n.sender_first_name,
        last_name: n.sender_last_name,
        avatar_url: n.sender_avatar_url
      } : undefined,
      related_type: n.related_type,
      related_id: n.related_id
    }));

    res.json({
      notifications: notiList,
      hasMore: offset + notifications.length < total,
      total
    });
  } catch (err) {
    console.error('Lỗi lấy thông báo admin:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// API: GET /api/admin/notifications/unread-total
router.get('/notifications/unread-total', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const countRes = await pool.query(`
      SELECT COUNT(*)
      FROM notifications
      WHERE user_id = $1
        AND is_read = false
        AND (type = 'report_new' OR type = 'post_approval');
    `,[userId]);
    const total = parseInt(countRes.rows[0].count);
    res.json({ total });
  } catch (err) {
    console.error('Lỗi lấy tổng số thông báo chưa đọc:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Đánh dấu 1 thông báo admin đã đọc
router.post('/notifications/:id/read', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 AND (type = 'report_new' OR type = 'post_approval')`,
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Lỗi đánh dấu đã đọc:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Đánh dấu tất cả thông báo admin đã đọc
router.post('/notifications/read-all', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 AND (type = 'report_new' OR type = 'post_approval')`,
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Lỗi đánh dấu tất cả đã đọc:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Xóa 1 thông báo admin
router.delete('/notifications/:id', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2 AND (type = 'report_new' OR type = 'post_approval')`,
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Lỗi xóa thông báo:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Xóa tất cả thông báo admin
router.delete('/notifications/all', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND (type = 'report_new' OR type = 'post_approval')`,
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Lỗi xóa tất cả thông báo:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

module.exports = router;
