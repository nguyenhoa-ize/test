const express = require('express');
const pool = require('../db');
const router = express.Router();

// Lấy danh sách từ cấm
router.get('/', async (req, res) => {
  try {
    const { search, offset = 0, limit = 10 } = req.query;
    let query = 'SELECT id, word, added_at FROM forbidden_words';
    let params = [];
    if (search) {
      query += ' WHERE LOWER(word) LIKE $1';
      params.push(`%${search.toLowerCase()}%`);
    }
    // Query lấy tổng số từ cấm (không phân trang)
    let countQuery = 'SELECT COUNT(*) FROM forbidden_words';
    let countParams = [];
    if (search) {
      countQuery += ' WHERE LOWER(word) LIKE $1';
      countParams.push(`%${search.toLowerCase()}%`);
    }
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    query += ' ORDER BY added_at DESC';
    // Sửa lỗi OFFSET/LIMIT
    if (search) {
      query += ' OFFSET $2 LIMIT $3';
      params.push(parseInt(offset, 10), parseInt(limit, 10));
    } else {
      query += ' OFFSET $1 LIMIT $2';
      params.push(parseInt(offset, 10), parseInt(limit, 10));
    }
    const { rows } = await pool.query(query, params);
    const forbiddenWords = (rows || []).map((fw, index) => ({
      stt: offset * 1 + index + 1,
      id: fw.id,
      word: fw.word,
      added_at: fw.added_at ? new Date(fw.added_at).toLocaleDateString('en-CA') : '',
    }));
    res.json({ success: true, items: forbiddenWords, total });
  } catch (err) {
    console.error('Get forbidden words error:', err);
     res.status(500).json({ success: false, message: 'Lỗi server', detail: err.message });
  }
});

// Thêm từ cấm mới
router.post('/', async (req, res) => {
  try {
    const { word } = req.body;
    if (!word || !word.trim()) {
      return res.status(400).json({ success: false, message: 'Từ cấm không được để trống.' });
    }
    // Kiểm tra trùng lặp
    const check = await pool.query('SELECT id FROM forbidden_words WHERE LOWER(word) = $1', [word.trim().toLowerCase()]);
    if (check.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Từ cấm đã tồn tại.' });
    }
    // Chỉ thêm các trường có trong bảng: word, added_at
    await pool.query(
      'INSERT INTO forbidden_words (word, added_at) VALUES ($1, NOW())',
      [word.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Add forbidden word error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server', detail: err.message });
  }
});

// Xóa từ cấm theo id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM forbidden_words WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete forbidden word error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server', detail: err.message });
  }
});

module.exports = router;
