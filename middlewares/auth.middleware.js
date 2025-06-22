const jwt = require("jsonwebtoken");
const pool = require("../db");

// Middleware xác thực người dùng
exports.isAuthenticated = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
            .status(401)
            .json({ error: "Không có token hoặc định dạng sai" });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Truy vấn thông tin người dùng từ DB
        const userResult = await pool.query(
            `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.cover_url, u.bio, ui.created_at
       FROM users u
       LEFT JOIN user_info ui ON u.id = ui.id
       WHERE u.id = $1`,
            [decoded.id]
        );

        const userProfile = userResult.rows[0];

        // Nếu người dùng có token hợp lệ nhưng không tồn tại trong DB, đó là trạng thái không nhất quán
        if (!userProfile) {
            console.error(
                `Authenticated user with id ${decoded.id} not found in database.`
            );
            return res.status(401).json({ error: "Người dùng không tồn tại." });
        }

        // Gắn thông tin người dùng vào đối tượng request
        req.user = userProfile;
        next();
    } catch (err) {
        console.error("Lỗi xác thực:", err);

        if (err.name === "TokenExpiredError") {
            return res
                .status(401)
                .json({ error: "Token đã hết hạn", code: "TOKEN_EXPIRED" });
        }
        if (err.name === "JsonWebTokenError") {
            return res.status(401).json({ error: "Token không hợp lệ" });
        }

        // Đối với tất cả các lỗi khác (ví dụ: lỗi cơ sở dữ liệu), trả về lỗi 500
        return res
            .status(500)
            .json({ error: "Lỗi server trong quá trình xác thực" });
    }
};
