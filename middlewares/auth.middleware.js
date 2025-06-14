const jwt = require("jsonwebtoken");
const pool = require("../db");

// Middleware xác thực người dùng
exports.isAuthenticated = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Không có token hoặc định dạng sai" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      "SELECT id, email, first_name, last_name, avatar_url FROM users WHERE id = $1",
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Token không hợp lệ hoặc user không tồn tại" });
    }

    req.user = result.rows[0]; // Gắn thông tin user vào req
    next();
  } catch (err) {
    console.error("Lỗi xác thực:", err);
    res.status(401).json({ error: "Token không hợp lệ" });
  }
};
