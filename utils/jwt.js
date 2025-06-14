const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

// Kiểm tra biến môi trường
if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET hoặc JWT_REFRESH_SECRET không được định nghĩa');
}

// Tạo access token
const createAccessToken = (user) => {
  if (!user || !user.id || !user.email) {
    throw new Error('Thông tin người dùng không hợp lệ');
  }

  try {
    const accessToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { 
        expiresIn: process.env.JWT_ACCESS_EXPIRATION || '15m',
      }
    );
    return accessToken;
  } catch (error) {
    throw new Error(`Lỗi khi tạo access token: ${error.message}`);
  }
};

// Tạo refresh token
const createRefreshToken = (user) => {
  if (!user || !user.id) {
    throw new Error('Thông tin người dùng không hợp lệ');
  }

  try {
    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.JWT_REFRESH_SECRET,
      { 
        expiresIn: process.env.JWT_REFRESH_EXPIRATION || '15d',
      }
    );
    return refreshToken;
  } catch (error) {
    throw new Error(`Lỗi khi tạo refresh token: ${error.message}`);
  }
};

// Tạo cả access và refresh token
const createTokens = (user) => {
  const accessToken = createAccessToken(user);
  const refreshToken = createRefreshToken(user);
  return { accessToken, refreshToken };
};

module.exports = { createTokens, createAccessToken, createRefreshToken };