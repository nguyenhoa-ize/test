const express = require('express');
const pool = require('../db');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth.middleware');

// Lưu lịch sử tìm kiếm
router.post('/', isAuthenticated, async (req, res) => {
  const user_id = req.user.id; // Lấy user_id từ req.user sau khi xác thực
  const { keyword } = req.body;

  if (!keyword) {
    return res.status(400).json({ error: 'Thiếu từ khóa tìm kiếm' });
  }

  try {
    // Thêm kiểm tra người dùng trước khi insert
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1', 
      [user_id]
    );
    if (userCheck.rowCount === 0) {
      return res.status(400).json({ error: 'Người dùng không tồn tại trong hệ thống' });
    }

    await pool.query(
      'INSERT INTO search_history (user_id, keyword) VALUES ($1, $2)',
      [user_id, keyword]
    );
    res.json({ success: true, message: 'Lịch sử tìm kiếm đã được lưu.' });
  } catch (err) {
    console.error('Lỗi khi lưu lịch sử tìm kiếm:', err); // Log chi tiết lỗi
    res.status(500).json({ error: 'Lỗi server khi lưu lịch sử tìm kiếm', detail: err.message, stack: err.stack });
  }
});

// Lấy lịch sử tìm kiếm (chỉ trả về mỗi keyword 1 lần, mới nhất trước)
router.get('/', isAuthenticated, async (req, res) => {
  const user_id = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (keyword) id, keyword, created_at
       FROM search_history
       WHERE user_id = $1
       ORDER BY keyword, created_at DESC`,
      [user_id]
    );
    // Sắp xếp lại theo created_at mới nhất trước, chỉ lấy tối đa 10
    const unique = rows
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10)
      .map(row => ({ id: row.id, keyword: row.keyword }));
    res.json({ history: unique });
  } catch (err) {
    console.error('Lỗi khi lấy lịch sử tìm kiếm:', err);
    res.status(500).json({ error: 'Lỗi server khi lấy lịch sử tìm kiếm', detail: err.message, stack: err.stack });
  }
});

// Xóa tất cả bản ghi keyword đó của user
router.delete('/by-keyword/:keyword', isAuthenticated, async (req, res) => {
  const { keyword } = req.params;
  const userId = req.user.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: User ID not found.' });
  }
  try {
    const query = 'DELETE FROM search_history WHERE user_id = $1 AND keyword = $2';
    await pool.query(query, [userId, keyword]);
    res.status(200).json({ message: 'All search history entries with this keyword deleted successfully.' });
  } catch (error) {
    console.error('Error deleting search history entry:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router; 