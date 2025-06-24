const pool = require("../db");
const { transaction } = require("../db");
const { createTokens, createAccessToken } = require("../utils/jwt");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const admin = require("../config/firebaseAdmin");

// Xác thực Firebase ID Token
const verifyFirebaseToken = async (idToken) => {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded;
};

// Hàm kiểm tra user_info tồn tại
async function checkUserInfo(userId) {
    try {
        const userInfo = await pool.query(
            "SELECT * FROM user_info WHERE id = $1",
            [userId]
        );
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
        console.log(
            `Lỗi khi xử lý user_info cho user_id ${userId}: ${error.message}`
        );
        throw error;
    }
}

// Google Login
exports.googleLogin = async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res
            .status(401)
            .json({ error: "Không có token hoặc định dạng sai" });
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
                const first_name =
                    nameParts.length > 1
                        ? nameParts.slice(0, -1).join(" ")
                        : displayName;
                const last_name =
                    nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

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
            return res
                .status(403)
                .json({ error: "Tài khoản của bạn đã bị khóa" });
        }

        // Tạo tokens
        const { accessToken, refreshToken } = createTokens(user);

        // Xử lý refresh token trong transaction riêng
        await transaction(async (client) => {
            // Xóa token cũ
            await client.query(
                "DELETE FROM refresh_tokens WHERE user_id = $1",
                [user.id]
            );

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
        if (error.message === "Tài khoản bị khóa") {
            return res
                .status(403)
                .json({ error: "Tài khoản của bạn đã bị khóa" });
        }
        return res.status(401).json({ error: "Xác thực Google thất bại" });
    }
};

// Login
exports.login = async (req, res) => {
    const { email, password } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Email không hợp lệ" });
    }
    if (password.length < 8) {
        return res
            .status(400)
            .json({ error: "Mật khẩu phải có ít nhất 8 ký tự" });
    }

    try {
        const result = await pool.query(
            "SELECT u.*, ui.is_active FROM users u LEFT JOIN user_info ui ON u.id = ui.id WHERE u.email = $1",
            [email.toLowerCase()]
        );
        const user = result.rows[0];

        if (!user) {
            return res
                .status(401)
                .json({ error: "Email không tồn tại hoặc không hợp lệ." });
        }

        // Kiểm tra trạng thái active
        if (!user.is_active) {
            return res
                .status(403)
                .json({ error: "Tài khoản của bạn đã bị khóa" });
        }

        // Kiểm tra password có tồn tại không
        if (!user.password) {
            return res.status(400).json({
                error: "Tài khoản này chưa đặt có mật khẩu. Vui lòng đăng nhập bằng Google hoặc phương thức khác.",
            });
        }

        const valid = await bcrypt.compare(password, user.password);
        console.log(`Password valid: ${valid}`);
        if (!valid) return res.status(401).json({ error: "Sai mật khẩu." });

        const { accessToken, refreshToken } = createTokens(user);

        // Xử lý refresh token trong transaction riêng
        await transaction(async (client) => {
            // Xóa token cũ
            await client.query(
                "DELETE FROM refresh_tokens WHERE user_id = $1",
                [user.id]
            );

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
            path: "/",
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
        res.status(500).json({ error: "Lỗi server." });
    }
};

// Signup
exports.signup = async (req, res) => {
    // Chuẩn hóa dữ liệu đầu vào
    const {
        email = "",
        password = "",
        firstName = "",
        lastName = "",
    } = req.body;
    console.log(
        `Signup data: email=${email}, firstName=${firstName}, lastName=${lastName}`
    );
    // Validate
    const errors = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) errors.push("Email không hợp lệ");
    if (password.length < 8) errors.push("Mật khẩu phải có ít nhất 8 ký tự");
    if (!firstName.trim()) errors.push("Họ không được để trống");
    if (!lastName.trim()) errors.push("Tên không được để trống");
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(", ") });
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
            path: "/",
        });

        res.status(201).json({
            message: "Đăng ký thành công",
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
        if (err.code === "23505") {
            return res.status(409).json({ error: "Email đã được đăng ký" });
        }
        res.status(500).json({
            error:
                process.env.NODE_ENV === "production"
                    ? "Lỗi hệ thống"
                    : err.message,
        });
    }
};

// Refresh Token
exports.refreshToken = async (req, res) => {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        // Kiểm tra database trước
        const tokenCheck = await pool.query(
            `SELECT * FROM refresh_tokens 
       WHERE token = $1 AND expires_at > NOW()`,
            [token]
        );

        if (tokenCheck.rowCount === 0) {
            return res.status(403).json({ error: "Invalid refresh token" });
        }

        const user_id = tokenCheck.rows[0].user_id;

        // Xác thực refresh token
        const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        if (decoded.id !== user_id) {
            return res
                .status(403)
                .json({ error: "Refresh token không hợp lệ" });
        }

        // Kiểm tra user
        const userResult = await pool.query(
            "SELECT id, email, first_name, last_name, avatar_url FROM users WHERE id = $1",
            [user_id]
        );

        if (userResult.rowCount === 0) {
            await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [
                token,
            ]);
            return res.status(404).json({ error: "Người dùng không tồn tại" });
        }

        const user = userResult.rows[0];

        // Kiểm tra trạng thái active
        const is_active = await checkUserInfo(user.id);
        if (!is_active) {
            await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [
                token,
            ]);
            return res
                .status(403)
                .json({ error: "Tài khoản của bạn đã bị khóa" });
        }

        // Tạo token mới và xóa token cũ
        const accessToken = createAccessToken(user);
        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [
            token,
        ]);

        res.json({ accessToken });
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [
                token,
            ]);
            return res.status(403).json({ error: "Refresh token đã hết hạn" });
        }
        res.status(500).json({ error: "Server error" });
    }
};

// Logout
exports.logout = async (req, res) => {
    const token = req.cookies.refreshToken;
    console.log(`Logout token: ${token}`);
    if (!token) return res.status(400).json({ error: "Không có token" });

    try {
        // Xóa refresh token khỏi database
        await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [
            token,
        ]);

        // Xóa cookie bằng cách đặt maxAge = 0 và sameSite, path trùng với khi set
        res.clearCookie("refreshToken", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "Strict",
            path: "/",
            maxAge: 0,
        });

        res.json({ message: "Đã đăng xuất" });
    } catch (err) {
        console.error("Lỗi logout:", err);
        res.status(500).json({ error: "Lỗi server." });
    }
};

// Get Profile
exports.getProfile = async (req, res) => {
    try {
        const {
            id,
            email,
            first_name,
            last_name,
            avatar_url,
            cover_url,
            bio,
            created_at,
        } = req.user;
        res.json({
            user: {
                id,
                email,
                first_name,
                last_name,
                avatar_url,
                cover_url,
                bio,
                created_at,
            },
        });
    } catch (err) {
        console.error("Lỗi getProfile:", err);
        res.status(500).json({ error: "Lỗi server" });
    }
};

// Forgot Password
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        // Kiểm tra xem email có tồn tại trong hệ thống không
        const result = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );
        const user = result.rows[0];

        // Nếu không tìm thấy hoặc chưa có mật khẩu, vẫn trả về thông báo chung (để tránh lộ thông tin)
        if (!user || !user.password) {
            return res.json({
                message:
                    "Nếu email hợp lệ và đã thiết lập mật khẩu, chúng tôi đã gửi hướng dẫn khôi phục.",
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
            console.error(
                "Lỗi gửi email:",
                emailErr && (emailErr.stack || emailErr.message || emailErr)
            );
            return res.status(400).json({
                error: "Không thể gửi email. Có thể địa chỉ email không tồn tại thật hoặc cấu hình gửi mail bị sai. Chi tiết lỗi đã được log ở server.",
            });
        }

        // Trả về thông báo chung
        return res.json({
            message:
                "Nếu email hợp lệ và đã thiết lập mật khẩu, chúng tôi đã gửi hướng dẫn khôi phục.",
        });
    } catch (err) {
        console.error("LỖI trong forgotPassword:", err);
        res.status(500).json({ error: "Lỗi server", detail: err.message });
    }
};

// Reset Password
exports.resetPassword = async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        // Kiểm tra token còn hiệu lực không
        const result = await pool.query(
            `
      SELECT * FROM password_resets
      WHERE token = $1 AND expires_at > NOW()
    `,
            [token]
        );

        const record = result.rows[0];
        if (!record)
            return res
                .status(400)
                .json({ error: "Token không hợp lệ hoặc đã hết hạn." });

        // Mã hóa mật khẩu mới
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Cập nhật mật khẩu người dùng
        await pool.query("UPDATE users SET password = $1 WHERE email = $2", [
            hashedPassword,
            record.email,
        ]);
        // Xóa token sau khi dùng
        await pool.query("DELETE FROM password_resets WHERE email = $1", [
            record.email,
        ]);

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
        from: `Solace Support <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "[Solace] Yêu cầu đặt lại mật khẩu tài khoản của bạn",
        html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; background: #f4f6fb; padding: 32px 0;">
        <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(99,102,241,0.08); padding: 32px 28px 28px 28px;">
          <div style="text-align: center; margin-bottom: 18px;">
            <img src='https://i.imgur.com/1Q9Z1Zm.png' alt='Solace Logo' width='48' height='48' style='border-radius:12px; box-shadow:0 2px 8px rgba(99,102,241,0.08); background:#f1f5f9;'/>
          </div>
          <h2 style="color: #1e293b; font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; text-align: center;">Yêu cầu đặt lại mật khẩu</h2>
          <p style="color: #334155; font-size: 1rem; margin-bottom: 18px; text-align: center;">Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với địa chỉ email này.</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${link}" style="display:inline-block; background: linear-gradient(90deg,#6366f1 0%,#2563eb 100%); color: #fff; padding: 12px 32px; border-radius: 8px; font-weight: 600; font-size: 1.1rem; text-decoration: none; box-shadow: 0 2px 8px rgba(99,102,241,0.08); transition: background 0.2s;">Đặt lại mật khẩu</a>
          </div>
          <p style="color: #64748b; font-size: 0.98rem; margin-bottom: 8px;">Liên kết trên sẽ hết hạn sau <b>15 phút</b> vì lý do bảo mật. Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.</p>
          <div style="margin-top: 18px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #94a3b8; font-size: 0.95rem; text-align: center;">
            Nếu có bất kỳ thắc mắc hoặc cần hỗ trợ, hãy liên hệ đội ngũ Solace qua email <a href="mailto:support@solace.com" style="color:#6366f1; text-decoration:underline;">support@solace.com</a>.<br/>
            <span style="font-size: 0.93rem;">Trân trọng,<br/>Đội ngũ Solace</span>
          </div>
        </div>
        <div style="text-align:center; color:#b6bbc7; font-size:0.92rem; margin-top:18px;">© ${new Date().getFullYear()} Solace. All rights reserved.</div>
      </div>
    `,
    });
}
