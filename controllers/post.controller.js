const pool = require('../db');

async function getUserPosts(req, res) {
  const { id: targetUserId } = req.params;
  const { limit = 5, offset = 0, viewer_id, filter } = req.query;

  try {
    let query = `
      WITH post_data AS (
        SELECT 
          p.*,
          u.first_name,
          u.last_name,
          u.avatar_url,
          CASE
            WHEN p.user_id = $1 THEN true
            WHEN p.access_modifier = 'public' THEN true
            WHEN p.access_modifier = 'private' THEN false
            WHEN p.access_modifier = 'followers' THEN EXISTS (
              SELECT 1 FROM user_relationships ur
              WHERE ur.user_id = p.user_id 
              AND ur.follower_id = $1
            )
            ELSE true
          END as has_access,
          EXISTS (
            SELECT 1 FROM post_likes pl
            WHERE pl.post_id = p.id AND pl.user_id = $1
          ) as is_liked
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id = $2
        AND p.is_approved = true
    `;

    const values = [viewer_id || targetUserId, targetUserId];

    // Add media filter if requested
    if (filter === 'media') {
      query += ` AND p.images IS NOT NULL AND p.images != '[]'`;
    }

    query += `
      )
      SELECT *
      FROM post_data
      WHERE has_access = true
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
    `;

    values.push(limit, offset);

    const result = await pool.query(query, values);

    // Format the posts data
    const posts = result.rows.map(post => ({
      ...post,
      images: post.images ? JSON.parse(post.images) : [],
      feeling: post.feeling ? JSON.parse(post.feeling) : null,
    }));

    res.json(posts);
  } catch (err) {
    console.error('Error fetching user posts:', err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra khi tải bài viết' });
  }
}

async function getUserPostStats(req, res) {
  const { id: targetUserId } = req.params;
  const { viewer_id } = req.query;

  try {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE 
          CASE
            WHEN p.user_id = $1 THEN true
            WHEN p.access_modifier = 'public' THEN true
            WHEN p.access_modifier = 'private' THEN false
            WHEN p.access_modifier = 'followers' THEN EXISTS (
              SELECT 1 FROM user_relationships ur
              WHERE ur.user_id = p.user_id 
              AND ur.follower_id = $1
            )
            ELSE true
          END = true
          AND p.is_approved = true
        ) as total_posts,
        COUNT(*) FILTER (WHERE 
          images IS NOT NULL 
          AND images != '[]'
          AND CASE
            WHEN p.user_id = $1 THEN true
            WHEN p.access_modifier = 'public' THEN true
            WHEN p.access_modifier = 'private' THEN false
            WHEN p.access_modifier = 'followers' THEN EXISTS (
              SELECT 1 FROM user_relationships ur
              WHERE ur.user_id = p.user_id 
              AND ur.follower_id = $1
            )
            ELSE true
          END = true
          AND p.is_approved = true
        ) as total_media
      FROM posts p
      WHERE p.user_id = $2
    `;

    const result = await pool.query(query, [viewer_id || targetUserId, targetUserId]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user post stats:', err);
    res.status(500).json({ error: 'Đã có lỗi xảy ra khi tải thống kê bài viết' });
  }
}

module.exports = {
  getUserPosts,
  getUserPostStats
};
