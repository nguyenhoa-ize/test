const express = require('express');
const router = express.Router();
const { isAuthenticated } = require("../middlewares/auth.middleware");
const messagesController = require('../controllers/messages.controller');

router.get('/unread-total', isAuthenticated, messagesController.getUnreadTotal);
router.get('/conversation/:conversationId', isAuthenticated, messagesController.getConversationDetails);
router.get('/', isAuthenticated, messagesController.getAllConversations);
router.get('/:conversationId', isAuthenticated, messagesController.getMessages);
router.post('/', isAuthenticated, messagesController.createConversation);
router.post('/:conversationId', isAuthenticated, messagesController.sendMessage);

module.exports = router;
