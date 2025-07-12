const express = require('express');
const pool = require('../db');
const { createCommentNotification } = require('../utils/notification');
const router = express.Router();

// Thêm comment mới
router.post('/', async (req, res) => {
  const { post_id, user_id, content } = req.body;
  if (!post_id || !user_id || !content) {
    return res.status(400).json({ error: 'Thiếu trường bắt buộc' });
  }
  const query = `
    INSERT INTO comments (post_id, user_id, content, created_at)
    VALUES ($1, $2, $3, NOW())
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [post_id, user_id, content]);
  const newComment = rows[0];

  // Lấy thông tin chủ bài viết
  const postResult = await pool.query('SELECT user_id FROM posts WHERE id = $1', [post_id]);
  const postAuthorId = postResult.rows[0]?.user_id;

  if (postAuthorId && postAuthorId !== user_id) {
    await createCommentNotification(
      post_id,   
      user_id,    
      postAuthorId,
      content
    );
  }
  res.status(201).json(rows[0]);
});

// Lấy danh sách comment của 1 post
router.get('/', async (req, res) => {
  const { post_id } = req.query;
  if (!post_id) return res.status(400).json({ error: 'Thiếu post_id' });
  const query = `
    SELECT c.*, u.first_name, u.last_name, u.avatar_url
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = $1
    ORDER BY c.created_at ASC
  `;
  const { rows } = await pool.query(query, [post_id]);
  res.json(rows);
});

// Lấy danh sách bình luận cho một bài đăng
router.get('/list', async (req, res) => {
  const { post_id } = req.query;
  try {
    const comments = await pool.query('SELECT * FROM comments WHERE post_id=$1 ORDER BY created_at DESC', [post_id]);
    res.json(comments.rows);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Thêm bình luận mới
router.post('/add', async (req, res) => {
  const { post_id, user_id, content } = req.body;
  try {
    const newComment = await pool.query(
      'INSERT INTO comments (post_id, user_id, content, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [post_id, user_id, content]
    );
    res.json(newComment.rows[0]);
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
