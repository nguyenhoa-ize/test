const express = require('express');
const router = express.Router();
const pool = require('../db');

router.post('/', async (req, res) => {
  try {
    await pool.query(`INSERT INTO visits (visit_date) VALUES (CURRENT_DATE)`);
    res.status(201).json({ message: 'Visit recorded' });
  } catch (err) {
    console.error('Error recording visit:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
