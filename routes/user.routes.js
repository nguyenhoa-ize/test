const express = require("express");
const router = express.Router();
const { pool, getClient } = require("../db");
const { sanitizeInput } = require("../utils/security");
const { isAuthenticated } = require("../middlewares/auth.middleware");
const { createFollowNotification } = require("../utils/notification");
const { getIO } = require("../socket");

// GET /api/users/search
router.get("/search", isAuthenticated, async (req, res) => {
    const { q = "", limit = 10, offset = 0 } = req.query;
    const currentUserId = req.user.id; // From JWT payload

    // Validate and sanitize inputs
    const sanitizedQuery = sanitizeInput(q);
    const parsedLimit = Math.min(parseInt(limit, 10), 50); // Cap limit at 50
    const parsedOffset = Math.max(parseInt(offset, 10), 0); // Ensure offset is non-negative

    if (isNaN(parsedLimit) || isNaN(parsedOffset)) {
        return res.status(400).json({ error: "Invalid limit or offset" });
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
        const countResult = await client.query(countQuery, [
            `%${sanitizedQuery}%`,
            currentUserId,
        ]);
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
        console.error("Error fetching users:", error);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// GET /api/users?status=Hoạt động&search=Nguyễn&role=admin
router.get("/", async (req, res) => {
    const { status, search, offset = 0, limit = 10, role } = req.query;
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

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

        if (status === "Hoạt động") {
            conditions.push(`ui.is_active = true`);
        } else if (status === "Đã khóa") {
            conditions.push(`ui.is_active = false`);
        }

        if (search) {
            values.push(`%${search.toLowerCase()}%`);
            conditions.push(
                `LOWER(u.first_name || ' ' || u.last_name) LIKE $${values.length}`
            );
        }

        if (role && ["admin", "user"].includes(role)) {
            values.push(role);
            conditions.push(`u.role = $${values.length}`);
        }

        if (conditions.length > 0) {
            baseQuery += ` WHERE ` + conditions.join(" AND ");
        }

        baseQuery += `
      GROUP BY u.id, ui.is_active, ui.created_at
      ORDER BY u.first_name, u.last_name
      OFFSET $${values.length + 1} LIMIT $${values.length + 2}
    `;

        values.push(parsedOffset, parsedLimit);

        // Query for paginated users
        const result = await pool.query(baseQuery, values);

        // Query for total count (không phân trang)
        let countQuery = `SELECT COUNT(*) FROM users u JOIN user_info ui ON u.id = ui.id`;
        if (conditions.length > 0) {
            countQuery += ` WHERE ` + conditions.join(" AND ");
        }
        const countResult = await pool.query(countQuery, values.slice(0, -2));
        const total = parseInt(countResult.rows[0].count, 10);

        res.json({ users: result.rows, total });
    } catch (error) {
        console.error("Lỗi khi lấy danh sách người dùng:", error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/users/:id/status
router.put("/:id/status", async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;

    try {
        await pool.query(`UPDATE user_info SET is_active = $1 WHERE id = $2`, [
            is_active,
            id,
        ]);
        // Lấy lại user mới nhất
        const userRes = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.avatar_url,
                json_build_object('is_active', ui.is_active, 'created_at', ui.created_at) AS user_info,
                (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count
            FROM users u
            JOIN user_info ui ON u.id = ui.id
            WHERE u.id = $1`, [id]
        );
        const updatedUser = userRes.rows[0];
        const io = getIO();
        io.emit('userUpdated', updatedUser);
        res.json({ success: true });
    } catch (error) {
        console.error("Lỗi khi cập nhật trạng thái:", error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/users/:id
router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { first_name, last_name, email, avatar_url, cover_url, bio } =
        req.body;

    try {
        await pool.query(
            `UPDATE users SET first_name = $1, last_name = $2, email = $3, avatar_url = $4, cover_url = $5, bio = $6 WHERE id = $7`,
            [first_name, last_name, email, avatar_url, cover_url, bio, id]
        );
        // Truy vấn lại user mới nhất
        const userRes = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.avatar_url,
                json_build_object('is_active', ui.is_active, 'created_at', ui.created_at) AS user_info,
                (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count
            FROM users u
            JOIN user_info ui ON u.id = ui.id
            WHERE u.id = $1`, [id]
        );
        const updatedUser = userRes.rows[0];
        const io = getIO();
        io.emit('userUpdated', updatedUser);
        res.json({ success: true, user: updatedUser });
    } catch (error) {
        console.error("Lỗi khi cập nhật thông tin người dùng:", error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/users/:id/role
router.put("/:id/role", async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!["admin", "user"].includes(role)) {
        return res.status(400).json({ error: "Role không hợp lệ" });
    }
    try {
        await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
            role,
            id,
        ]);
        // Lấy lại user mới nhất
        const userRes = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.avatar_url,
                json_build_object('is_active', ui.is_active, 'created_at', ui.created_at) AS user_info,
                (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS posts_count
            FROM users u
            JOIN user_info ui ON u.id = ui.id
            WHERE u.id = $1`, [id]
        );
        const updatedUser = userRes.rows[0];
        const io = getIO();
        io.emit('userUpdated', updatedUser);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Lỗi khi cập nhật role:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lấy thông tin follow của user
router.get("/:id/follow-stats", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `
      SELECT 
        (SELECT COUNT(*) FROM user_relationships WHERE user_id = $1) as followers_count,
        (SELECT COUNT(*) FROM user_relationships WHERE follower_id = $1) as following_count,
        EXISTS(
          SELECT 1 FROM user_relationships 
          WHERE user_id = $1 AND follower_id = $2
        ) as is_following
      FROM users WHERE id = $1
    `,
            [id, req.user?.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error("Error getting follow stats:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lấy danh sách người theo dõi
router.get("/:id/followers", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `
      SELECT u.id, u.first_name, u.last_name, u.avatar_url, u.email,
             r.created_at as followed_at,
             EXISTS(
               SELECT 1 FROM user_relationships 
               WHERE user_id = u.id AND follower_id = $2
             ) as is_following
      FROM user_relationships r
      JOIN users u ON r.follower_id = u.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
    `,
            [id, req.user?.id]
        );

        res.json(result.rows);
    } catch (error) {
        console.error("Error getting followers:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lấy danh sách đang theo dõi
router.get("/:id/following", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `
      SELECT u.id, u.first_name, u.last_name, u.avatar_url, u.email,
             r.created_at as followed_at,
             EXISTS(
               SELECT 1 FROM user_relationships 
               WHERE user_id = u.id AND follower_id = $2
             ) as is_following
      FROM user_relationships r
      JOIN users u ON r.user_id = u.id
      WHERE r.follower_id = $1
      ORDER BY r.created_at DESC
    `,
            [id, req.user?.id]
        );

        res.json(result.rows);
    } catch (error) {
        console.error("Error getting following:", error);
        res.status(500).json({ error: error.message });
    }
});

// Follow user
router.post("/:id/follow", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const followerId = req.user?.id;

    if (!followerId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (id === followerId) {
        return res.status(400).json({ error: "Cannot follow yourself" });
    }

    try {
        // Begin transaction
        await pool.query("BEGIN");

        // Check if already following with FOR UPDATE to prevent race conditions
        const existingFollow = await pool.query(
            "SELECT * FROM user_relationships WHERE user_id = $1 AND follower_id = $2 FOR UPDATE",
            [id, followerId]
        );

        if (existingFollow.rows.length > 0) {
            await pool.query("ROLLBACK");
            return res
                .status(400)
                .json({ error: "Already following this user" });
        }

        // Add new follow relationship
        await pool.query(
            "INSERT INTO user_relationships (user_id, follower_id) VALUES ($1, $2)",
            [id, followerId]
        );

        // Get updated stats
        const stats = await pool.query(
            `
      SELECT 
        (SELECT COUNT(*) FROM user_relationships WHERE user_id = $1) as followers_count,
        (SELECT COUNT(*) FROM user_relationships WHERE follower_id = $1) as following_count,
        true as is_following
      FROM users WHERE id = $1
    `,
            [id]
        );

        await pool.query("COMMIT");

        await createFollowNotification(followerId, id);

        res.json({
            success: true,
            ...stats.rows[0],
        });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error following user:", error);
        res.status(500).json({ error: error.message });
    }
});

// Unfollow user
router.delete("/:id/follow", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const followerId = req.user?.id;

    if (!followerId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // Begin transaction
        await pool.query("BEGIN");

        // Check if relationship exists
        const followRelationship = await pool.query(
            "SELECT * FROM user_relationships WHERE user_id = $1 AND follower_id = $2 FOR UPDATE",
            [id, followerId]
        );

        if (followRelationship.rows.length === 0) {
            await pool.query("ROLLBACK");
            return res
                .status(404)
                .json({ error: "Follow relationship not found" });
        }

        // Delete the relationship
        await pool.query(
            "DELETE FROM user_relationships WHERE user_id = $1 AND follower_id = $2",
            [id, followerId]
        );

        // Get updated stats
        const stats = await pool.query(
            `
      SELECT 
        (SELECT COUNT(*) FROM user_relationships WHERE user_id = $1) as followers_count,
        (SELECT COUNT(*) FROM user_relationships WHERE follower_id = $1) as following_count,
        false as is_following
      FROM users WHERE id = $1
    `,
            [id]
        );

        await pool.query("COMMIT");

        res.json({
            success: true,
            ...stats.rows[0],
        });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error unfollowing user:", error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/users/:id
router.get("/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `
      SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url, u.cover_url, u.bio, ui.created_at
      FROM users u
      JOIN user_info ui ON u.id = ui.id
      WHERE u.id = $1
    `,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lấy tổng số bài viết của user
router.get("/:id/post-stats", isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            "SELECT COUNT(*) AS total_posts FROM posts WHERE user_id = $1",
            [id]
        );
        res.json({ total_posts: parseInt(result.rows[0].total_posts, 10) });
    } catch (error) {
        console.error("Error getting post stats:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// API lấy danh sách bạn bè (mình follow và được follow lại)
router.get("/:id/friends", isAuthenticated, async (req, res) => {
    try {
        const userId = req.params.id;
        const result = await pool.query(
            `
      SELECT u.id, u.first_name, u.last_name, u.avatar_url
      FROM users u
      WHERE u.id IN (
        SELECT ur1.user_id
        FROM user_relationships ur1
        JOIN user_relationships ur2
          ON ur1.user_id = ur2.follower_id
        WHERE ur1.follower_id = $1 AND ur2.user_id = $1
      )
      `,
            [userId]
        );
        res.json({ friends: result.rows });
    } catch (err) {
        console.error("Lỗi khi lấy friends:", err);
        res.status(500).json({ error: "Server error" });
    }
});

module.exports = router;
