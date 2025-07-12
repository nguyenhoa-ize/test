const express = require('express');
const router = express.Router();
const chatBotController = require('../controllers/chatBotController');
const rateLimit = require('express-rate-limit');

// Rate limit: 5 request/phút/user
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Quá nhiều request, vui lòng thử lại sau'
});

router.post('/chat', chatLimiter, chatBotController.chat);

module.exports = router; 