const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/dashboard/summary
router.get('/summary', async (req, res) => {
  try {
    const [
      reportTodayResult,
      reportYesterdayResult,
      postThisWeekResult,
      postLastWeekResult,
      userTodayResult,
      userYesterdayResult
    ] = await Promise.all([
      // Báo cáo hôm nay
      pool.query(`SELECT COUNT(*) FROM reports WHERE created_at::date = CURRENT_DATE`),

      // Báo cáo hôm qua
      pool.query(`SELECT COUNT(*) FROM reports WHERE created_at::date = CURRENT_DATE - INTERVAL '1 day'`),

      // Bài đăng tuần này (7 ngày gần nhất)
      pool.query(`SELECT COUNT(*) FROM posts WHERE created_at >= NOW() - INTERVAL '7 days'`),

      // Bài đăng tuần trước (8–14 ngày trước)
      pool.query(`
        SELECT COUNT(*) FROM posts 
        WHERE created_at >= NOW() - INTERVAL '14 days' 
          AND created_at < NOW() - INTERVAL '7 days'
      `),

      // Người dùng mới hôm nay
      pool.query(`SELECT COUNT(*) FROM users WHERE created_at::date = CURRENT_DATE`),

      // Người dùng mới hôm qua
      pool.query(`SELECT COUNT(*) FROM users WHERE created_at::date = CURRENT_DATE - INTERVAL '1 day'`)
    ]);

    res.json({
      reports_today: parseInt(reportTodayResult.rows[0].count),
      reports_yesterday: parseInt(reportYesterdayResult.rows[0].count),
      posts_this_week: parseInt(postThisWeekResult.rows[0].count),
      posts_last_week: parseInt(postLastWeekResult.rows[0].count),
      new_users_today: parseInt(userTodayResult.rows[0].count),
      new_users_yesterday: parseInt(userYesterdayResult.rows[0].count)
    });
  } catch (err) {
    console.error('Error fetching dashboard summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET / api / dashboard / monthly-users 
router.get('/monthly-users', async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear(); // Mặc định là năm hiện tại
    const result = await pool.query(`
      SELECT 
        TO_CHAR(created_at, 'Mon') AS month,
        EXTRACT(MONTH FROM created_at) AS month_number,
        COUNT(*) AS total
      FROM users
      WHERE EXTRACT(YEAR FROM created_at) = $1
      GROUP BY month, month_number
      ORDER BY month_number
    `, [year]);

    const data = result.rows.map((row) => ({
      month: row.month,
      total: parseInt(row.total),
    }));
    res.json(data);
  } catch (err) {
    console.error('Lỗi truy vấn monthly-users:', err);
    res.status(500).json({ error: 'Lỗi truy vấn' });
  }
});

// GET /api/dashboard/post-sentiment
router.get('/post-sentiment', async (req, res) => {
  try {
    const range = req.query.range || 'month';
    let condition = '';

    if (range === 'week') {
      condition = `WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`;
    } else if (range === 'month') {
      condition = `WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
    }

    const result = await pool.query(`
      SELECT type_post, COUNT(*) AS count 
      FROM posts 
      ${condition}
      GROUP BY type_post
    `);

    const formatted = result.rows.map(row => ({
      type: row.type_post === 'positive' ? 'Tích cực' : 'Tiêu cực',
      count: parseInt(row.count)
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Error fetching post sentiment:', err);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/dashboard/daily-visits
router.get('/daily-visits', async (req, res) => {
  try {
    const range = req.query.range || '7'; // mặc định 7 ngày
    let condition = '';

    if (range === 'all') {
      condition = ''; // không giới hạn
    } else {
      const days = parseInt(range);
      condition = `WHERE visit_date >= CURRENT_DATE - INTERVAL '${days} days'`;
    }

    const result = await pool.query(`
      SELECT TO_CHAR(visit_date, 'YYYY-MM-DD') AS day, COUNT(*) AS total
      FROM visits
      ${condition}
      GROUP BY day
      ORDER BY day
    `);

    res.json(result.rows.map(r => ({
      date: r.day,
      total: parseInt(r.total)
    })));
  } catch (err) {
    console.error('Error fetching daily visits:', err);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
