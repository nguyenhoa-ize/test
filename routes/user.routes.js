const express = require('express');
const router = express.Router();
const { pool, getClient} = require('../db');
const { sanitizeInput } = require('../utils/security');
const { isAuthenticated } = require("../middlewares/auth.middleware");


// GET /api/users/search
router.get('/search', isAuthenticated, async (req, res) => {
  const { q = '', limit = 10, offset = 0 } = req.query;
  const currentUserId = req.user.id; // From JWT payload

  // Validate and sanitize inputs
  const sanitizedQuery = sanitizeInput(q);
  const parsedLimit = Math.min(parseInt(limit, 10), 50); // Cap limit at 50
  const parsedOffset = Math.max(parseInt(offset, 10), 0); // Ensure offset is non-negative

  if (isNaN(parsedLimit) || isNaN(parsedOffset)) {
    return res.status(400).json({ error: 'Invalid limit or offset' });
  }

  try {
    const client = await getClient();

    // Query to count total matching users
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM users u
      WHERE 
        (u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR (u.last_name || ' ' || u.first_name) ILIKE $1)
        AND u.id != $2
        AND u.id NOT IN (
          SELECT cm.user_id 
          FROM conversation_members cm 
          JOIN conversations c ON c.id = cm.conversation_id 
          WHERE c.type = 'direct' 
          AND cm.user_id != $2
          AND c.id IN (
            SELECT conversation_id 
            FROM conversation_members 
            WHERE user_id = $2
          )
        )
    `;
    const countResult = await client.query(countQuery, [`%${sanitizedQuery}%`, currentUserId]);
    const total = parseInt(countResult.rows[0].total, 10);

    // Query to fetch users with pagination
    const usersQuery = `
      SELECT 
        u.id,
        u.last_name || ' ' || u.first_name AS name,
        u.avatar_url AS avatar,
        EXISTS (
          SELECT 1 
          FROM user_relationships ur 
          WHERE ur.user_id = u.id 
          AND ur.follower_id = $2
        ) AS is_followed,
        EXISTS (
          SELECT 1 
          FROM user_relationships ur 
          WHERE ur.user_id = $2 
          AND ur.follower_id = u.id
        ) AS is_following
      FROM users u
      WHERE 
        (u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR (u.last_name || ' ' || u.first_name) ILIKE $1)
        AND u.id != $2
        AND u.id NOT IN (
          SELECT cm.user_id 
          FROM conversation_members cm 
          JOIN conversations c ON c.id = cm.conversation_id 
          WHERE c.type = 'direct' 
          AND cm.user_id != $2
          AND c.id IN (
            SELECT conversation_id 
            FROM conversation_members 
            WHERE user_id = $2
          )
        )
      ORDER BY 
        CASE 
          WHEN EXISTS (
            SELECT 1 
            FROM user_relationships ur 
            WHERE ur.user_id = u.id 
            AND ur.follower_id = $2
          ) THEN 1
          WHEN EXISTS (
            SELECT 1 
            FROM user_relationships ur 
            WHERE ur.user_id = $2 
            AND ur.follower_id = u.id
          ) THEN 2
          ELSE 3
        END,
        u.first_name
      LIMIT $3 OFFSET $4
    `;
    const usersResult = await client.query(usersQuery, [
      `%${sanitizedQuery}%`,
      currentUserId,
      parsedLimit,
      parsedOffset,
    ]);

    client.release();

    res.json({
      users: usersResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        is_followed: row.is_followed,
        is_following: row.is_following,
      })),
      total,
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users?status=Hoạt động&search=Nguyễn
router.get('/', async (req, res) => {
  const { status, search } = req.query;

  try {
    let baseQuery = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.avatar_url,
             json_build_object(
               'is_active', ui.is_active,
               'created_at', ui.created_at
             ) AS user_info,
             COUNT(p.id) AS posts_count
      FROM users u
      JOIN user_info ui ON u.id = ui.id
      LEFT JOIN posts p ON p.user_id = u.id
    `;

    const conditions = [];
    const values = [];

    if (status === 'Hoạt động') {
      conditions.push(`ui.is_active = true`);
    } else if (status === 'Đã khóa') {
      conditions.push(`ui.is_active = false`);
    }

    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      conditions.push(`LOWER(u.first_name || ' ' || u.last_name) LIKE $${values.length}`);
    }

    if (conditions.length > 0) {
      baseQuery += ` WHERE ` + conditions.join(' AND ');
    }

    baseQuery += `
      GROUP BY u.id, ui.is_active, ui.created_at
      ORDER BY u.first_name, u.last_name
    `;

    const result = await pool.query(baseQuery, values);
    res.json(result.rows);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách người dùng:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/users/:id/status
router.put('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    await pool.query(
      `UPDATE user_info SET is_active = $1 WHERE id = $2`,
      [is_active, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi cập nhật trạng thái:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, email } = req.body;

  try {
    await pool.query(
      `UPDATE users SET first_name = $1, last_name = $2, email = $3 WHERE id = $4`,
      [first_name, last_name, email, id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Lỗi khi cập nhật thông tin người dùng:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;