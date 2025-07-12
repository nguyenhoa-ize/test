// Đảm bảo dòng này luôn ở đầu ứng dụng của bạn để tải biến môi trường
require('dotenv').config();

const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('Lỗi: Biến môi trường FIREBASE_SERVICE_ACCOUNT_KEY chưa được đặt.');
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
  console.log('Firebase Admin SDK đã được khởi tạo thành công từ biến môi trường.');

} catch (error) {
  console.error('Lỗi khi phân tích JSON hoặc khởi tạo Firebase Admin SDK:', error);
  // Thoát ứng dụng nếu có lỗi cấu hình nghiêm trọng
  process.exit(1);
}

// Export admin để bạn có thể sử dụng nó ở các tệp khác
module.exports = admin;