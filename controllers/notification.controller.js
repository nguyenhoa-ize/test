const { pool } = require('../db');
const { getIO } = require('../socket');

// Helper function để emit socket event cập nhật số lượng thông báo chưa đọc
const emitUnreadTotalUpdate = async (userId) => {
  try {
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    
    const io = getIO();
    // Sử dụng room system thay vì userSockets
    io.to(`user:${userId}`).emit('notificationUnreadTotalUpdated', { total: parseInt(count) });
  } catch (err) {
    console.error('Error emitting unread total update:', err);
  }
};

// Lấy danh sách thông báo với phân trang, lọc, search
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const tab = req.query.tab || 'all';

    let baseQuery = `
      SELECT n.*, 
             u.id as sender_id,
             u.first_name as sender_first_name, 
             u.last_name as sender_last_name,
             u.avatar_url as sender_avatar_url
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      WHERE n.user_id = $1
      AND n.type != 'report_new'
      AND n.type != 'post_approval'
    `;
    const params = [userId];
    if (tab === 'unread') {
      baseQuery += ' AND n.is_read = false';
    } else if (tab === 'system') {
      baseQuery += " AND n.type = 'system'";
    }

    baseQuery += ' ORDER BY n.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const { rows } = await pool.query(baseQuery, params);
    const countQuery = `
      SELECT COUNT(*) 
      FROM notifications n
      WHERE user_id = $1
      AND n.type != 'report_new'
      AND n.type != 'post_approval'
      ${tab === 'unread' ? 'AND n.is_read = false' : tab === 'system' ? "AND type = 'system'" : ''}
    `;
    const countParams = [userId];
    const { rows: [{ count }] } = await pool.query(countQuery, countParams);

    const notifications = rows.map(row => ({
      ...row,
      sender: row.sender_id ? {
        id: row.sender_id,
        first_name: row.sender_first_name,
        last_name: row.sender_last_name,
        avatar_url: row.sender_avatar_url
      } : undefined
    }));

    res.json({
      notifications,
      hasMore: offset + rows.length < parseInt(count)
    });
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// Đánh dấu 1 thông báo đã đọc
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [id, userId]);
    
    // Emit socket event để cập nhật số lượng thông báo chưa đọc
    await emitUnreadTotalUpdate(userId);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error mark notification as read:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// Đánh dấu tất cả đã đọc
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(`
      UPDATE notifications n SET is_read = true 
      WHERE user_id = $1
      AND n.type != 'report_new' AND n.type != 'post_approval'
    `, [userId]);
    
    // Emit socket event để cập nhật số lượng thông báo chưa đọc
    await emitUnreadTotalUpdate(userId);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error mark all notifications as read:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// Lấy tổng số thông báo chưa đọc
exports.getUnreadTotal = async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*) 
      FROM notifications n
      WHERE user_id = $1 AND is_read = false 
      AND n.type != 'report_new' AND n.type != 'post_approval' `,
      [userId]
    );
    res.json({ total: parseInt(count) });
  } catch (err) {
    console.error('Error getting unread total:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// Xóa 1 thông báo
exports.deleteNotification = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    
    // Kiểm tra xem thông báo có tồn tại và thuộc về user không
    const { rows } = await pool.query(
      'SELECT is_read FROM notifications WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Thông báo không tồn tại' });
    }
    
    const wasUnread = !rows[0].is_read;
    
    // Xóa thông báo
    await pool.query(
      `DELETE FROM notifications n
      WHERE id = $1 AND user_id = $2
      AND n.type != 'report_new'
      AND n.type != 'post_approval'`,
      [id, userId]
    );
    
    // Nếu thông báo bị xóa chưa đọc, emit socket event để cập nhật số lượng
    if (wasUnread) {
      await emitUnreadTotalUpdate(userId);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting notification:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// Xóa tất cả thông báo
exports.deleteAllNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(`
      DELETE FROM notifications n 
      WHERE user_id = $1  
      AND n.type != 'report_new' 
      AND n.type != 'post_approval'
    `, [userId]);
    
    // Emit socket event để cập nhật số lượng thông báo chưa đọc
    await emitUnreadTotalUpdate(userId);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting all notifications:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
}; 