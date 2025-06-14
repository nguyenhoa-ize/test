const pool = require("../db");
const { transaction } = require("../db");
const { createTokens, createAccessToken } = require("../utils/jwt");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const admin = require("../config/firebaseAdmin");

// Xác thực Firebase ID Token
const verifyFirebaseToken = async (idToken) => {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return decoded;
};
// Hàm kiểm tra user_info tồn tại
async function checkUserInfo(userId) {
  try {
    const userInfo = await pool.query("SELECT * FROM user_info WHERE id = $1", [userId]);
    if (userInfo.rowCount === 0) {
      await pool.query(
        "INSERT INTO user_info (id, is_active) VALUES ($1, $2)",
        [userId, true]
      );
      console.log(`Tạo user_info mới cho user_id: ${userId}`);
      return true;
    }
    return userInfo.rows[0].is_active; // Trả về trạng thái is_active
  } catch (error) {
    console.log(`Lỗi khi xử lý user_info cho user_id ${userId}: ${error.message}`);
    throw error;
  }
}

exports.googleLogin = async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Không có token hoặc định dạng sai" });
  }

  const idToken = authHeader.split(" ")[1];

  if (!idToken) {
    return res.status(400).json({ error: "Thiếu ID token" });
  }

  try {
    // Xác thực ID token với Firebase
    const decoded = await verifyFirebaseToken(idToken);
    console.log("Decoded ID token:", decoded);

    if (!decoded.email) {
      console.log("ID token không chứa email");
      return res.status(400).json({ error: "ID token không chứa email" });
    }

    // Sử dụng transaction
    const { user, is_active } = await transaction(async (client) => {
      let user;
      let is_active = false;

      // Kiểm tra user đã tồn tại chưa
      const existingUser = await client.query(
        "SELECT u.*, ui.is_active FROM users u LEFT JOIN user_info ui ON u.id = ui.id WHERE u.email = $1",
        [decoded.email]
      );

      if (existingUser.rowCount === 0) {
        // Tạo user mới
        const displayName = decoded.name?.trim() || "Unknown";
        const nameParts = displayName.split(" ");
        const first_name = nameParts.length > 1 ? nameParts.slice(0, -1).join(" ") : displayName;
        const last_name = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

        // Thêm người dùng mới
        const newUser = await client.query(
          `INSERT INTO users (email, avatar_url, first_name, last_name)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [decoded.email, decoded.picture, first_name, last_name]
        );
        user = newUser.rows[0];

        // Tạo bản ghi user_info mới
        await client.query(
          `INSERT INTO user_info (id, is_active)
           VALUES ($1, $2)`,
          [user.id, true]
        );
        is_active = true;
        console.log(`Người dùng mới đã được tạo: ${user.email}`);
      } else {
        user = existingUser.rows[0];
        is_active = existingUser.rows[0].is_active ?? true;

        // Nếu không có user_info, tạo mới
        if (existingUser.rows[0].is_active === null) {
          await client.query(
            `INSERT INTO user_info (id, is_active)
             VALUES ($1, $2)`,
            [user.id, true]
          );
          is_active = true;
        }
      }

      return { user, is_active };
    });

    // Kiểm tra trạng thái tài khoản
    if (!is_active) {
      return res.status(403).json({ error: "Tài khoản của bạn đã bị khóa" });
    }

    // Tạo tokens
    const { accessToken, refreshToken } = createTokens(user);

    // Xử lý refresh token trong transaction riêng
    await transaction(async (client) => {
      // Xóa token cũ
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
      
      // Thêm token mới
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + interval '15 days')`,
        [user.id, refreshToken]
      );
    });

    // Xóa password nếu có
    if (user.password) delete user.password;

    // Lưu refreshToken vào cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      maxAge: 15 * 24 * 60 * 60 * 1000, // 15 ngày
      path: "/",
    });

    res.json({
      message: "Xác thực Google thành công",
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar_url: user.avatar_url,
        role: user.role,
      },
      accessToken,
    });

  } catch (error) {
    console.error("Lỗi xác thực Google:", error);
    if (error.message === 'Tài khoản bị khóa') {
      return res.status(403).json({ error: "Tài khoản của bạn đã bị khóa" });
    }
    return res.status(401).json({ error: "Xác thực Google thất bại" });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Email không hợp lệ" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Mật khẩu phải có ít nhất 8 ký tự" });
  }

  try {
    const result = await pool.query(
        "SELECT u.*, ui.is_active FROM users u LEFT JOIN user_info ui ON u.id = ui.id WHERE u.email = $1",
        [email.toLowerCase()]
      );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Email không tồn tại hoặc không hợp lệ.' });
    }

    // Kiểm tra trạng thái active
    if (!user.is_active) {
      return res.status(403).json({ error: "Tài khoản của bạn đã bị khóa" });
    }

    // Kiểm tra password có tồn tại không
    if (!user.password) {
      return res.status(400).json({ error: 'Tài khoản này chưa đặt có mật khẩu. Vui lòng đăng nhập bằng Google hoặc phương thức khác.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    console.log(`Password valid: ${valid}`);
    if (!valid) return res.status(401).json({ error: 'Sai mật khẩu.' });

    const { accessToken, refreshToken } = createTokens(user);

    // Xử lý refresh token trong transaction riêng
    await transaction(async (client) => {
      // Xóa token cũ
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);
      
      // Thêm token mới
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, NOW() + interval '15 days')`,
        [user.id, refreshToken]
      );
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      maxAge: 15 * 24 * 60 * 60 * 1000, // 15 ngày
      path: "/", // Đặt path để cookie có thể truy cập từ mọi route
    });

    // Trả về access token và thông tin user
    res.json({
      message: "Đăng nhập thành công",
      user: {
        id: user.id,
        email: user.email.toLowerCase(),
        first_name: user.first_name,
        last_name: user.last_name,
        avatar_url: user.avatar_url,
        role: user.role,
      },
      accessToken,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
};

// Đăng ký user mới (local)
exports.signup = async (req, res) => {
  // Chuẩn hóa dữ liệu đầu vào
  const { email = '', password = '', firstName = '', lastName = '' } = req.body;
  console.log(`Signup data: email=${email}, firstName=${firstName}, lastName=${lastName}`);
  // Validate
  const errors = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) errors.push('Email không hợp lệ');
  if (password.length < 8) errors.push('Mật khẩu phải có ít nhất 8 ký tự');
  if (!firstName.trim()) errors.push('Họ không được để trống');
  if (!lastName.trim()) errors.push('Tên không được để trống');
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(', ') });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // Dùng transaction để đảm bảo đồng bộ dữ liệu
    const { user } = await transaction(async (client) => {
      // Tạo user mới
      const userResult = await client.query(
        `INSERT INTO users (email, first_name, last_name, password)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, first_name, last_name, avatar_url, role`,
        [email.toLowerCase(), firstName, lastName, hashedPassword]
      );
      const user = userResult.rows[0];

      // Tạo user_info tương ứng
      await client.query(
        `INSERT INTO user_info (id, is_active) VALUES ($1, $2)`,
        [user.id, true]
      );

      return { user };
    });

    const { accessToken, refreshToken } = createTokens(user);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      maxAge: 15 * 24 * 60 * 60 * 1000, // 15 ngày
      path: "/", // Đặt path để cookie có thể truy cập từ mọi route
    });

    res.status(201).json({
      message: 'Đăng ký thành công',
      user: {
        id: user.id,
        email: user.email.toLowerCase(),
        first_name: user.first_name,
        last_name: user.last_name,
        avatar_url: user.avatar_url,
        role: user.role,
      },
      accessToken,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email đã được đăng ký' });
    }
    res.status(500).json({
      error: process.env.NODE_ENV === 'production' ? 'Lỗi hệ thống' : err.message,
    });
  }
};

// Refresh token
exports.refreshToken = async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Kiểm tra database trước
    const tokenCheck = await pool.query(
      `SELECT * FROM refresh_tokens 
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (tokenCheck.rowCount === 0) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    const user_id = tokenCheck.rows[0].user_id;

    // Xác thực refresh token
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
        if (err) reject(err);
        resolve(decoded);
      });
    });

    if (decoded.id !== user_id) {
      return res.status(403).json({ error: 'Refresh token không hợp lệ' });
    }

    // Kiểm tra user
    const userResult = await pool.query(
      'SELECT id, email FROM users WHERE id = $1',
      [user_id]
    );

    if (userResult.rowCount === 0) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
      return res.status(404).json({ error: 'Người dùng không tồn tại' });
    }

    const user = userResult.rows[0];

    // Kiểm tra trạng thái active
    const is_active = await checkUserInfo(user.id);
    console.log("Active: ", is_active);
    if (!is_active) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
      return res.status(403).json({ error: 'Tài khoản của bạn đã bị khóa' });
    }

    console.log("User: ", user);
    // Tạo token mới và xóa token cũ
    const accessToken = createAccessToken(user);
    console.log("Access token: ", accessToken);

    res.json({ accessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
      return res.status(403).json({ error: 'Refresh token đã hết hạn' });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

// Logout
exports.logout = async (req, res) => {
  const token = req.cookies.refreshToken;
  console.log(`Logout token: ${token}`);
  if (!token) return res.status(400).json({ error: 'Không có token' });

  try {
    // Xóa refresh token khỏi database
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [token]);

    // Xóa cookie bằng cách đặt maxAge = 0 và sameSite, path trùng với khi set
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      maxAge: 0, // Đặt maxAge = 0 để xóa cookie
    });

    res.json({ message: "Đã đăng xuất" });
  } catch (err) {
    console.error("Lỗi logout:", err);
    res.status(500).json({ error: 'Lỗi server.' });
  }
};

// Trả về thông tin người dùng hiện tại sau xác thực
exports.getProfile = async (req, res) => {
  try {
    const { id, email, first_name, last_name, avatar_url } = req.user;
    res.json({ user: { id, email, first_name, last_name, avatar_url } });
  } catch (err) {
    console.error("Lỗi getProfile:", err);
    res.status(500).json({ error: "Lỗi server" });
  }
};

// Gửi email reset password
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    // Kiểm tra xem email có tồn tại trong hệ thống không
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    // Nếu không tìm thấy hoặc chưa có mật khẩu, vẫn trả về thông báo chung (để tránh lộ thông tin)
    if (!user || !user.password) {
      return res.json({
        message: "Nếu email hợp lệ và đã thiết lập mật khẩu, chúng tôi đã gửi hướng dẫn khôi phục.",
      });
    }

    // Tạo token khôi phục
    const token = crypto.randomBytes(32).toString("hex");
    const expires = (Date.now() + 15 * 60 * 1000) / 1000; // 15 phút

    console.log("Ghi password_resets:", { email, token, expires });

    // Lưu token vào bảng
    await pool.query(
      `INSERT INTO password_resets (email, token, expires_at)
       VALUES ($1, $2, to_timestamp($3))`,
      [email, token, expires]
    );

    const resetLink = `http://localhost:3000/reset-password?token=${token}`;

    try {
      await sendResetEmail(email, resetLink);
    } catch (emailErr) {
      console.error("Lỗi gửi email:", emailErr.message);
      return res.status(400).json({
        error: "Không thể gửi email. Có thể địa chỉ email không tồn tại thật.",
      });
    }

    // Trả về thông báo chung
    return res.json({
      message: "Nếu email hợp lệ và đã thiết lập mật khẩu, chúng tôi đã gửi hướng dẫn khôi phục.",
    });
  } catch (err) {
    console.error("LỖI trong forgotPassword:", err);
    res.status(500).json({ error: "Lỗi server", detail: err.message });
  }
};

// Đặt lại mật khẩu
exports.resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;

  try {
    // Kiểm tra token còn hiệu lực không
    const result = await pool.query(`
      SELECT * FROM password_resets
      WHERE token = $1 AND expires_at > NOW()
    `, [token]);

    const record = result.rows[0];
    if (!record) return res.status(400).json({ error: "Token không hợp lệ hoặc đã hết hạn." });

    // Mã hóa mật khẩu mới
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Cập nhật mật khẩu người dùng
    await pool.query("UPDATE users SET password = $1 WHERE email = $2", [hashedPassword, record.email]);
    // Xóa token sau khi dùng
    await pool.query("DELETE FROM password_resets WHERE email = $1", [record.email]);

    res.json({ message: "Đặt lại mật khẩu thành công." });
  } catch (err) {
    console.error("resetPassword error:", err);
    res.status(500).json({ error: "Lỗi server" });
  }
};


// Hàm gửi email chứa link reset
async function sendResetEmail(email, link) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"Solace Support" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Yêu cầu khôi phục mật khẩu",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Yêu cầu khôi phục mật khẩu</h2>
        <p>Xin chào,</p>
        <p>Chúng tôi đã nhận được yêu cầu khôi phục mật khẩu cho tài khoản liên kết với địa chỉ email này.</p>
        <p>Vui lòng nhấn vào nút bên dưới để đặt lại mật khẩu của bạn. Liên kết sẽ hết hạn sau 15 phút.</p>
        <p style="text-align: center; margin: 20px 0;">
          <a href="${link}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Đặt lại mật khẩu
          </a>
        </p>
        <p>Nếu bạn không yêu cầu hành động này, vui lòng bỏ qua email này.</p>
        <p>Trân trọng,<br/>Đội ngũ hỗ trợ Solace</p>
      </div>
    `,
  });
  
}
