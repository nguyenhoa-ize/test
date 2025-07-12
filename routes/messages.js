const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get all messages
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM messages ORDER BY created_at DESC LIMIT 50'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new message
router.post('/', async (req, res) => {
    const { content, user_id, room_id } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO messages (content, user_id, room_id) VALUES ($1, $2, $3) RETURNING *',
            [content, user_id, room_id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get messages for a specific room
router.get('/room/:roomId', async (req, res) => {
    const { roomId } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50',
            [roomId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router; 