const express = require('express');
const pool = require('../db');
const notificationUtils = require('../utils/notification');
const router = express.Router();
const { getIO } = require('../socket');

// Lấy danh sách báo cáo
router.get('/', async (req, res) => {
  try {
    const { search, status, offset = 0, limit = 10 } = req.query;
    let query = `
      SELECT 
        r.id,
        r.post_id,
        r.created_at,
        r.reason,
        r.description,
        r.status,
        r.reporter_id,
        r.reported_user_id,
        u1.first_name AS reporter_first_name,
        u1.last_name AS reporter_last_name,
        u2.first_name AS reported_first_name,
        u2.last_name AS reported_last_name
      FROM reports r
      LEFT JOIN users u1 ON r.reporter_id = u1.id
      LEFT JOIN users u2 ON r.reported_user_id = u2.id
    `;
    let where = [];
    let params = [];
    if (status && status !== 'all') {
      where.push('r.status = $' + (params.length + 1));
      params.push(status);
    }
    if (search) {
      where.push(`(
        LOWER(u1.first_name) LIKE $${params.length + 1} OR
        LOWER(u1.last_name) LIKE $${params.length + 2} OR
        LOWER(u2.first_name) LIKE $${params.length + 3} OR
        LOWER(u2.last_name) LIKE $${params.length + 4}
      )`);
      const searchValue = `%${search.toLowerCase()}%`;
      params.push(searchValue, searchValue, searchValue, searchValue);
    }
    if (where.length > 0) {
      query += ' WHERE ' + where.join(' AND ');
    }
    // Query lấy tổng số báo cáo (không phân trang)
    let countQuery = `
      SELECT COUNT(*) FROM reports r
      LEFT JOIN users u1 ON r.reporter_id = u1.id
      LEFT JOIN users u2 ON r.reported_user_id = u2.id
    `;
    if (where.length > 0) {
      countQuery += ' WHERE ' + where.join(' AND ');
    }
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    query += ' ORDER BY r.created_at DESC';
    // Xác định vị trí offset/limit trong params
    let mainParams;
    if (params.length > 0) {
      query += ` OFFSET $${params.length + 1} LIMIT $${params.length + 2}`;
      mainParams = [...params, parseInt(offset, 10), parseInt(limit, 10)];
    } else {
      query += ` OFFSET $1 LIMIT $2`;
      mainParams = [parseInt(offset, 10), parseInt(limit, 10)];
    }
    const { rows } = await pool.query(query, mainParams);

    const reports = rows.map((report, index) => ({
      stt: (parseInt(offset, 10) || 0) + index + 1,
      report_id: report.id,
      reporter_id: report.reporter_id,
      reported_user_id: report.reported_user_id,
      date_reported: new Date(report.created_at).toLocaleDateString('en-US'),
      reported_by: ((report.reporter_first_name || '') + ' ' + (report.reporter_last_name || '')).trim() || 'Không xác định',
      reported_account: ((report.reported_first_name || '') + ' ' + (report.reported_last_name || '')).trim() || 'Không xác định',
      content: report.reason + (report.description ? `: ${report.description}` : ''),
      status: report.status === 'pending' ? 'Chưa xử lý' : 'Đã xử lý',
    }));

    res.status(200).json({ success: true, items: reports, total });
  } catch (err) {
    console.error('Get reports error:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Tạo report mới cho bài viết
router.post('/', async (req, res) => {
  try {
    const { post_id, reporter_id, reason, description } = req.body;
    if (!post_id || !reporter_id || !reason) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    // Lấy chủ bài viết
    const postResult = await pool.query('SELECT user_id FROM posts WHERE id = $1', [post_id]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bài viết không tồn tại' });
    }
    const reported_user_id = postResult.rows[0].user_id;

    // Lấy email của reporter và reported_user
    const userQuery = 'SELECT id, email FROM users WHERE id = ANY($1)';
    const userResult = await pool.query(userQuery, [[reporter_id, reported_user_id]]);
    const users = userResult.rows;
    const reporterEmail = users.find((u) => u.id === reporter_id)?.email || 'Không xác định';
    const reportedUserEmail = users.find((u) => u.id === reported_user_id)?.email || 'Không xác định';

    // Thêm report vào DB
    const insertQuery = `
      INSERT INTO reports (post_id, reporter_id, reported_user_id, reason, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [post_id, reporter_id, reported_user_id, reason, description || null];
    const { rows } = await pool.query(insertQuery, values);

    const report = {
      ...rows[0],
      reporter_email: reporterEmail,
      reported_user_email: reportedUserEmail,
    };

    // Gửi thông báo cho admin về báo cáo mới
    await notificationUtils.createReportNotificationForAdmin(
      post_id,
      reporter_id,
      reported_user_id,
      reason
    );

    res.status(201).json({ success: true, report });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Đánh dấu báo cáo đã xử lý
router.put('/:id/process', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE reports SET status = $1 WHERE id = $2', ['processed', id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Xóa báo cáo
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reports WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Lấy chi tiết một báo cáo
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Lấy thông tin báo cáo
    const reportQuery = `
      SELECT 
        r.id,
        r.post_id,
        r.created_at,
        r.reason,
        r.description,
        r.status,
        r.reporter_id,
        r.reported_user_id,
        u1.first_name AS reporter_first_name,
        u1.last_name AS reporter_last_name,
        u2.first_name AS reported_first_name,
        u2.last_name AS reported_last_name
      FROM reports r
      LEFT JOIN users u1 ON r.reporter_id = u1.id
      LEFT JOIN users u2 ON r.reported_user_id = u2.id
      WHERE r.id = $1
    `;
    const reportRes = await pool.query(reportQuery, [id]);
    if (reportRes.rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy báo cáo' });
    }
    const report = reportRes.rows[0];

    // Lấy thông tin bài đăng bị báo cáo
    let post = null;
    let shared_post = null;
    const postRes = await pool.query(
      `SELECT p.*, u.first_name, u.last_name, u.avatar_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`, [report.post_id]
    );
    if (postRes.rows.length > 0) {
      post = postRes.rows[0];
      // Nếu là bài chia sẻ, lấy bài gốc
      if (post.shared_post_id) {
        const sharedRes = await pool.query(
          `SELECT p.*, u.first_name, u.last_name, u.avatar_url
           FROM posts p
           JOIN users u ON p.user_id = u.id
           WHERE p.id = $1`, [post.shared_post_id]
        );
        shared_post = sharedRes.rows[0] || null;
      }
    }

    res.json({
      success: true,
      report: {
        ...report,
        reported_by: ((report.reporter_first_name || '') + ' ' + (report.reporter_last_name || '')).trim() || 'Không xác định',
        reported_account: ((report.reported_first_name || '') + ' ' + (report.reported_last_name || '')).trim() || 'Không xác định',
        status: report.status === 'pending' ? 'Chưa xử lý' : 'Đã xử lý',
        date_reported: new Date(report.created_at).toLocaleDateString('en-US'),
        content: report.reason + (report.description ? `: ${report.description}` : ''),
      },
      post,
      shared_post, // <-- trả về bài gốc nếu có
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// Gửi thông báo từ trang báo cáo
router.post('/send-notification', async (req, res) => {
  try {
    const { user_id, title, content, type } = req.body;
    if (!user_id || !title || !content) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
    }
    const result  = await pool.query(
      'INSERT INTO notifications (user_id, title, content, type) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, title, content, type || null]
    );

    const notification = result.rows[0];
    
    // Gửi thông báo qua Socket.IO
    const io = getIO(); 
    io.to(`user:${user_id}`).emit('newNotification', {
      ...notification
    });
    
    res.json({ success: true, message: 'Đã gửi thông báo và lưu vào database!' });
  } catch (err) {
    console.error('Send notification error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server', detail: err.message });
  }
});

module.exports = router;