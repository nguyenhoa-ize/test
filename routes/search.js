const express = require('express');
const pool = require('../db');
const router = express.Router();

// API gợi ý tìm kiếm
router.get('/search-suggestions', async (req, res) => {
  const query = (req.query.query || '').toLowerCase();
  if (!query) return res.json([]);

  try {
    // Lấy user có avatar
    const users = await pool.query(
      "SELECT id, (first_name || ' ' || last_name) AS name, avatar_url AS avatar, 'user' AS type FROM users WHERE first_name IS NOT NULL AND last_name IS NOT NULL AND avatar_url IS NOT NULL AND avatar_url <> '' AND unaccent(LOWER(first_name || ' ' || last_name)) LIKE unaccent($1) LIMIT 5",
      [`%${query}%`]
    );
    // Lấy post liên quan
    const posts = await pool.query(
      `SELECT 
        p.id, 
        p.content, 
        p.created_at, 
        p.images, 
        p.feeling, 
        p.location, 
        p.type_post, 
        p.user_id,
        u.first_name, 
        u.last_name, 
        u.avatar_url, 
        'post' AS type
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.content IS NOT NULL AND LOWER(p.content) LIKE $1
      LIMIT 5`,
      [`%${query}%`]
    );
    // Gộp lại
    const suggestions = [...users.rows, ...posts.rows];
    res.json(suggestions);
  } catch (err) {
    console.error('Search API error:', err); // Log chi tiết lỗi ra terminal
    res.status(500).json({ error: 'Lỗi lấy gợi ý tìm kiếm', detail: err.message, stack: err.stack });
  }
});

module.exports = router; 