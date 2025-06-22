const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const pool = require("../db");
const router = express.Router();
const { createPostNotification } = require("../utils/notification");
const { getIO } = require("../socket");

// Helper function to safely parse and transform post data
const transformPost = (post) => {
    if (!post) return null;

    let images = [];
    if (post.images && typeof post.images === "string") {
        try {
            const parsed = JSON.parse(post.images);
            if (Array.isArray(parsed)) {
                images = parsed;
            }
        } catch (e) {
            // Ignore error, images will remain an empty array
        }
    }

    let feeling = null;
    if (post.feeling && typeof post.feeling === "string") {
        try {
            // Only assign if parsing is successful
            feeling = JSON.parse(post.feeling);
        } catch (e) {
            // Ignore error, feeling remains null
        }
    }

    return {
        ...post,
        images,
        feeling,
        shares: post.shares || 0, // Ensure shares is always a number
    };
};

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
if (process.env.NODE_ENV !== "production") {
    console.log("Cloudinary config:", cloudinary.config());
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/upload-media", upload.array("media", 9), async (req, res) => {
    try {
        console.log("Uploading media:", req.files?.length, "files");
        const files = req.files || [];
        let mediaUrls = [];
        for (const file of files) {
            const url = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { resource_type: "auto", folder: "solace-posts" },
                    (error, result) => {
                        if (error) return reject(error);
                        resolve(result.secure_url);
                    }
                );
                stream.end(file.buffer);
            });
            mediaUrls.push(url);
        }
        res.status(200).json({ images: mediaUrls });
    } catch (err) {
        console.error("Upload media error:", err);
        res.status(500).json({
            error: "Tải ảnh thất bại",
            detail: err.message,
        });
    }
});

router.post("/", async (req, res) => {
    try {
        if (!req.body || typeof req.body !== "object") {
            return res
                .status(400)
                .json({ error: "Missing or invalid request body" });
        }
        console.log("Creating post:", req.body);
        const {
            content,
            privacy,
            user_id,
            images = [],
            feeling,
            location,
            type_post,
            shared_post_id,
        } = req.body;
        if (!content || !privacy || !user_id) {
            return res.status(400).json({
                error: "Thiếu trường bắt buộc: content, privacy, user_id",
            });
        }

        // --- KIỂM TRA TỪ CẤM ---
        const forbiddenRes = await pool.query(
            "SELECT word FROM forbidden_words"
        );
        const forbiddenWords = forbiddenRes.rows.map((row) =>
            row.word.toLowerCase()
        );
        const found = forbiddenWords.find((word) =>
            content.toLowerCase().includes(word)
        );
        if (found) {
            return res
                .status(400)
                .json({ error: `Nội dung chứa từ cấm: "${found}"` });
        }
        // --- HẾT KIỂM TRA TỪ CẤM ---

        // Đảm bảo images luôn là mảng string trước khi stringify
        let imagesArray = [];
        if (Array.isArray(images)) {
            imagesArray = images;
        } else if (typeof images === "string") {
            imagesArray = [images];
        } else if (images && typeof images === "object") {
            imagesArray = Object.values(images);
        }
        const imagesStr = JSON.stringify(imagesArray);
        const feelingStr =
            feeling && typeof feeling === "object"
                ? JSON.stringify(feeling)
                : feeling || null;

        const allowedTypes = ["positive", "negative"];
        const safeTypePost = allowedTypes.includes(type_post)
            ? type_post
            : "positive";

        let insertQuery, values;
        if (shared_post_id) {
            insertQuery = `
        INSERT INTO posts (user_id, content, images, access_modifier, type_post, created_at, feeling, location, shared_post_id, is_approved)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *;
      `;
            values = [
                user_id,
                content,
                imagesStr,
                privacy,
                safeTypePost,
                new Date().toISOString(),
                feelingStr,
                location || null,
                shared_post_id,
                false, // luôn là chờ duyệt
            ];
        } else {
            insertQuery = `
        INSERT INTO posts (user_id, content, images, access_modifier, type_post, created_at, feeling, location, is_approved)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `;
            values = [
                user_id,
                content,
                imagesStr,
                privacy,
                safeTypePost,
                new Date().toISOString(),
                feelingStr,
                location || null,
                false, // luôn là chờ duyệt
            ];
        }
        const { rows } = await pool.query(insertQuery, values);
        const post = rows[0];

        await createPostNotification(post.id, user_id, content);

        // Truy vấn lại để lấy thông tin user kèm theo post
        const selectQuery = `
      SELECT p.*, u.first_name, u.last_name, u.avatar_url
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
    `;
        const { rows: postRows } = await pool.query(selectQuery, [post.id]);
        const fullPost = transformPost(postRows[0]);

        // Emit sự kiện có bài viết mới cho admin
        try {
            const io = getIO();
            io.to("admin_room").emit("newPost", { post: fullPost });
        } catch (e) {
            console.error("Socket emit newPost error:", e);
        }

        res.status(201).json(fullPost);
    } catch (err) {
        console.error("Post creation error:", err);
        res.status(500).json({
            error: "Đăng bài thất bại",
            detail: err.message,
        });
    }
});

// Lấy danh sách tất cả bài viết (GET /api/posts) - ĐÃ TỐI ƯU HÓA VÀ SỬA LỖI
router.get("/", async (req, res) => {
    const { limit = 5, offset = 0, type, viewer_id } = req.query;

    const values = [];
    let paramIndex = 1;

    // Subquery for is_liked, an toàn hơn khi viewer_id không tồn tại
    let isLikedSubquery = "false as is_liked";
    if (viewer_id) {
        isLikedSubquery = `EXISTS(SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = $${paramIndex})`;
        values.push(viewer_id);
        paramIndex++;
    }

    // Mệnh đề WHERE động
    const whereConditions = ["p.is_approved = true"];
    if (type) {
        whereConditions.push(`p.type_post = $${paramIndex}`);
        values.push(type);
        paramIndex++;
    }

    // Gán index cho LIMIT và OFFSET
    const limitIndex = paramIndex++;
    values.push(limit);
    const offsetIndex = paramIndex++;
    values.push(offset);

    try {
        const query = `
            SELECT 
                p.*, 
                u.first_name, 
                u.last_name, 
                u.avatar_url,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count,
                ${isLikedSubquery}
            FROM posts p
            JOIN users u ON p.user_id = u.id
            WHERE ${whereConditions.join(" AND ")}
            GROUP BY p.id, u.id
            ORDER BY p.created_at DESC
            LIMIT $${limitIndex} OFFSET $${offsetIndex}
        `;

        const { rows } = await pool.query(query, values);

        // Parsing dữ liệu JSON một cách an toàn
        const posts = rows.map(transformPost);

        res.json(posts);
    } catch (err) {
        console.error("Get posts error:", err);
        res.status(500).json({
            error: "Không lấy được danh sách bài viết",
            detail: err.message,
        });
    }
});

router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
      SELECT p.*, u.first_name, u.last_name, u.avatar_url,
             (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
    `;
        const { rows } = await pool.query(query, [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Post not found" });
        }
        const post = transformPost(rows[0]);
        res.json(post);
    } catch (err) {
        console.error("Error fetching post:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

const { isAuthenticated } = require("../middlewares/auth.middleware");

router.get("/user/:userId", isAuthenticated, async (req, res) => {
    try {
        const { userId } = req.params;
        const offset = parseInt(req.query.offset, 10) || 0;
        const limit = parseInt(req.query.limit, 10) || 10;
        const { filter, viewer_id } = req.query;
        const authenticatedUserId = viewer_id || req.user?.id;

        // Nếu là chủ tài khoản thì xem được tất cả bài, còn lại chỉ xem bài đã duyệt
        let whereClause = "p.user_id = $1";
        let values = [userId];
        if (authenticatedUserId !== userId) {
            whereClause += " AND p.is_approved = true";
        }
        if (filter === "media") {
            whereClause += " AND p.images IS NOT NULL AND p.images != '[]'";
        }

        const query = `
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.avatar_url,
        COUNT(DISTINCT c.id) as comment_count,
        COUNT(DISTINCT pl.id) as like_count,
        EXISTS(
          SELECT 1 FROM post_likes 
          WHERE post_id = p.id AND user_id = $2
        ) as is_liked
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      LEFT JOIN post_likes pl ON pl.post_id = p.id
      WHERE ${whereClause}
      GROUP BY p.id, u.first_name, u.last_name, u.avatar_url
      ORDER BY p.created_at DESC
      OFFSET $3 LIMIT $4
    `;
        // $1: userId, $2: authenticatedUserId, $3: offset, $4: limit
        values = [userId, authenticatedUserId || "", offset, limit];

        const { rows } = await pool.query(query, values);
        const posts = rows.map(transformPost);
        res.json(posts);
    } catch (error) {
        console.error("Error fetching user posts:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/user/:userId/count", isAuthenticated, async (req, res) => {
    try {
        const { userId } = req.params;

        // Query để lấy tổng số bài viết và ảnh/video
        const query = `
      SELECT 
        COUNT(DISTINCT p.id) as total_posts,
        COUNT(DISTINCT CASE WHEN p.images IS NOT NULL AND p.images != '[]' THEN p.id END) as posts_with_media,
        SUM(
          CASE 
            WHEN p.images IS NOT NULL AND p.images != '[]' 
            AND jsonb_typeof(CAST(p.images AS JSONB)) = 'array'
            THEN JSONB_ARRAY_LENGTH(CAST(p.images AS JSONB))
            ELSE 0 
          END
        ) as total_media
      FROM posts p
      WHERE p.user_id = $1
        AND (p.is_approved = true OR p.user_id = $2)  -- Show unapproved posts to their owners
    `;

        const { rows } = await pool.query(query, [userId, req.user?.id || ""]);
        const stats = rows[0];

        res.json({
            totalPosts: parseInt(stats.total_posts) || 0,
            totalMedia: parseInt(stats.total_media) || 0,
        });
    } catch (error) {
        console.error("Error fetching user post counts:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/increment-shares", async (req, res) => {
    const { postId } = req.body;
    if (!postId) {
        return res.status(400).json({ error: "Thiếu postId" });
    }
    try {
        await pool.query(
            "UPDATE posts SET shares = COALESCE(shares, 0) + 1 WHERE id = $1",
            [postId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Error incrementing shares:", err);
        res.status(500).json({ error: "Không tăng được số lượt chia sẻ" });
    }
});

module.exports = router;

// Ví dụ trong CreatePostModal hoặc nơi gọi API đăng bài
const handleCreatePost = async (data) => {
    try {
        const res = await fetch("/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        const result = await res.json();
        if (!res.ok) {
            // Hiển thị thông báo lỗi khi có từ cấm
            alert(result.error || "Đăng bài thất bại!"); // hoặc toast.error(result.error)
            return;
        }
        // Thành công: reset form, đóng modal, v.v.
        alert("Đăng bài thành công!");
    } catch (err) {
        alert("Đăng bài thất bại!");
    }
};
