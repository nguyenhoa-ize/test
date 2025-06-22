const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth.middleware');
const notificationController = require('../controllers/notification.controller');

router.get('/', isAuthenticated, notificationController.getNotifications);
// Lấy tổng số thông báo chưa đọc
router.get('/unread-total', isAuthenticated, notificationController.getUnreadTotal);
// Đánh dấu 1 thông báo đã đọc
router.post('/:id/read', isAuthenticated, notificationController.markAsRead);
// Đánh dấu tất cả đã đọc
router.post('/read-all', isAuthenticated, notificationController.markAllAsRead);
// Xóa tất cả thông báo
router.delete('/all', isAuthenticated, notificationController.deleteAllNotifications);
// Xóa 1 thông báo
router.delete('/:id', isAuthenticated, notificationController.deleteNotification);


module.exports = router; 