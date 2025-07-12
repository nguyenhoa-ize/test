const express = require('express');
const router = express.Router(); 
const pool = require('../db');
const { getUserPosts, getUserPostStats } = require('../controllers/post.controller');
const { getIO } = require('../socket');
const {
  createPostApprovedNotification,
  createPostForFollowersNotification
} = require('../utils/notification');

// GET /api/posts/user/:id - Get user posts with access control
router.get('/user/:id', getUserPosts);

// GET /api/posts/user/:id/stats - Get user post statistics
router.get('/user/:id/post-stats', getUserPostStats);

// GET /api/posts?type=positive&status=approved&search=keyword
router.get('/', async (req, res) => {
  const { type, status, search, offset = 0, limit = 10 } = req.query;

  try {
    let query = `
      SELECT p.*, u.first_name, u.last_name, u.avatar_url
      FROM posts p
      JOIN users u ON p.user_id = u.id
    `;
    const conditions = [];
    const values = [];

    if (type) {
      values.push(type);
      conditions.push(`p.type_post = $${values.length}`);
    }

    if (status === 'approved') {
      conditions.push(`p.is_approved = true`);
    } else if (status === 'pending') {
      conditions.push(`p.is_approved = false`);
    }

    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      conditions.push(`LOWER(p.content) LIKE $${values.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY p.created_at DESC';
    query += ` OFFSET $${values.length + 1} LIMIT $${values.length + 2}`;
    values.push(parseInt(offset, 10), parseInt(limit, 10));

    // Query lấy tổng số bài viết (không phân trang)
    let countQuery = `SELECT COUNT(*) FROM posts p JOIN users u ON p.user_id = u.id`;
    if (conditions.length > 0) {
      countQuery += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await pool.query(countQuery, values.slice(0, -2));
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await pool.query(query, values);
    res.json({ items: result.rows, total });
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/posts/:id/approve
router.put('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE posts SET is_approved = true WHERE id = $1', [id]);

    // Lấy thông tin đầy đủ của bài viết vừa duyệt để gửi qua socket
    const postRes = await pool.query(
      `SELECT p.*, u.first_name, u.last_name, u.avatar_url,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) as likes
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`, [id]
    );

    if (postRes.rows.length === 0) {
      // Dù không tìm thấy, vẫn trả về success vì post đã được approve
      return res.json({ success: true });
    }
    const approvedPost = postRes.rows[0];

    // Parse images and feeling
    if (approvedPost.images && typeof approvedPost.images === 'string') {
        try { approvedPost.images = JSON.parse(approvedPost.images); } catch(e) { approvedPost.images = [] }
    }
    if (approvedPost.feeling && typeof approvedPost.feeling === 'string') {
        try { approvedPost.feeling = JSON.parse(approvedPost.feeling); } catch(e) { approvedPost.feeling = null }
    }


    await createPostApprovedNotification(id, approvedPost.user_id);
    await createPostForFollowersNotification(id, approvedPost.user_id);

    // Emit event với dữ liệu bài viết đầy đủ
    try {
      const io = getIO();
      // Đổi tên payload thành post để nhất quán
      io.emit('postApproved', { post: approvedPost });
    } catch (e) { console.error('Socket emit postApproved error:', e); }
    
    // Trả về luôn post đã được duyệt để client có thể dùng nếu cần
    res.json({ success: true, post: approvedPost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/posts/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    
    // Emit sự kiện xóa bài viết
    try {
        const io = getIO();
        io.emit('postDeleted', { postId: id });
    } catch (e) { console.error('Socket emit postDeleted error:', e); }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy chi tiết một bài đăng (và bài gốc nếu là bài chia sẻ)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Lấy thông tin bài đăng
    const postRes = await pool.query(
      `SELECT p.*, u.first_name, u.last_name, u.avatar_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`, [id]
    );
    if (postRes.rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy bài đăng' });
    }
    const post = postRes.rows[0];

    // Nếu là bài share, lấy thêm bài gốc
    let shared_post = null;
    if (post.shared_post_id) {
      const sharedRes = await pool.query(
        `SELECT p.*, u.first_name, u.last_name, u.avatar_url
         FROM posts p
         JOIN users u ON p.user_id = u.id
         WHERE p.id = $1`, [post.shared_post_id]
      );
      shared_post = sharedRes.rows[0] || null;
    }

    res.json({
      success: true,
      post,
      shared_post,
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

module.exports = router;
