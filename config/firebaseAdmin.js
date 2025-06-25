// Đảm bảo dòng này luôn ở đầu ứng dụng của bạn để tải biến môi trường
require('dotenv').config();

const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  // Trong môi trường sản xuất, bạn có thể muốn thoát ứng dụng nếu thiếu cấu hình quan trọng
  process.exit(1);
}

try {
  // Chuyển đổi chuỗi JSON từ biến môi trường thành đối tượng JavaScript
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

  const firebaseConfig = {
    credential: admin.credential.cert(serviceAccount)
  };
    // Khởi tạo Firebase Admin SDK với cấu hình từ biến môi trường
  admin.initializeApp(firebaseConfig);

} catch (error) {
  // Thoát ứng dụng nếu có lỗi cấu hình nghiêm trọng
  process.exit(1);
}

// Export admin để bạn có thể sử dụng nó ở các tệp khác
module.exports = admin;