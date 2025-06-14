const express = require('express');
const pool = require('../db');
const router = express.Router();

// Like post
router.post('/like', async (req, res) => {
  const { post_id, user_id } = req.body;
  if (!post_id || !user_id) return res.status(400).json({ error: 'Thiếu post_id hoặc user_id' });

  // Kiểm tra đã like chưa
  const check = await pool.query('SELECT * FROM post_likes WHERE post_id=$1 AND user_id=$2', [post_id, user_id]);
  if (check.rows.length > 0) return res.status(400).json({ error: 'Đã like rồi' });

  await pool.query('INSERT INTO post_likes (post_id, user_id, created_at) VALUES ($1, $2, NOW())', [post_id, user_id]);
  await pool.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [post_id]);
  res.json({ success: true });
});

// Unlike post
router.post('/unlike', async (req, res) => {
  const { post_id, user_id } = req.body;
  if (!post_id || !user_id) return res.status(400).json({ error: 'Thiếu post_id hoặc user_id' });

  await pool.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2', [post_id, user_id]);
  await pool.query('UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1', [post_id]);
  res.json({ success: true });
});

// Kiểm tra user đã like post chưa
router.get('/is-liked', async (req, res) => {
  const { post_id, user_id } = req.query;
  const check = await pool.query('SELECT * FROM post_likes WHERE post_id=$1 AND user_id=$2', [post_id, user_id]);
  const likeCountResult = await pool.query('SELECT like_count FROM posts WHERE id=$1', [post_id]);
  const likeCount = likeCountResult.rows[0]?.like_count || 0;
  res.json({ liked: check.rows.length > 0, likeCount });
});

// Lấy danh sách người đã like post
router.get('/list', async (req, res) => {
  const { post_id } = req.query;
  if (!post_id) return res.status(400).json({ error: 'Thiếu post_id' });
  const result = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.avatar_url
     FROM post_likes pl
     JOIN users u ON pl.user_id = u.id
     WHERE pl.post_id = $1
     ORDER BY pl.created_at ASC`,
    [post_id]
  );
  res.json(result.rows);
});

module.exports = router;
