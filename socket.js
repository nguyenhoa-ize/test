const { Server } = require('socket.io');
const { pool } = require('./db');
let io;
const userSockets = {}; // { userId: [socketId, ...] }

function init(server) {
  io = new Server(server, {
    cors: {
      origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000'
      ],
      credentials: true
    }
  });

  // Socket.IO logic cho realtime chat
  const onlineUsers = new Set();

  io.on('connection', (socket) => {
    let userId = null;

    // Khi client xác thực xong, gửi userId lên
    socket.on('register', (id) => {
      userId = id;
      if (!userSockets[userId]) userSockets[userId] = [];
      userSockets[userId].push(socket.id);
      socket.userId = userId;

      // Gửi broadcast về user online
      onlineUsers.add(userId);
      io.emit('onlineUsers', Array.from(onlineUsers));
    });

    socket.on('joinConversation', async ({ userId, conversationId }) => {
      try {
        socket.join(conversationId);

        // Cập nhật lại tin nhắn đã đọc
        const result = await pool.query(
          'UPDATE conversation_members SET unread_count = 0 WHERE user_id = $1 AND conversation_id = $2 RETURNING unread_count',
          [userId, conversationId]
        );

        // Lấy tổng số unread mới
        const { rows } = await pool.query(`
          SELECT COALESCE(SUM(unread_count), 0) as total
          FROM conversation_members
          WHERE user_id = $1 AND unread_count > 0
        `, [userId]);

        const totalUnread = parseInt(rows[0].total, 10);

        // Emit tổng số unread mới
        if (userSockets[userId]) {
          userSockets[userId].forEach((socketId) => {
            io.to(socketId).emit('unreadTotalUpdated', { total: totalUnread });
          });
        }
      } catch (error) {
        console.error('Error updating unread_count:', error);
      }
    });

    socket.on('leave', (conversationId) => {
      socket.leave(conversationId);
    });

    socket.on('typing', ({ conversationId, userId }) => {
      socket.to(conversationId).emit('typing', { userId });
    });

    socket.on('stopTyping', ({ conversationId, userId }) => {
      socket.to(conversationId).emit('stopTyping', { userId });
    });

    socket.on('disconnect', () => {
      if (userId) {
        if (userSockets[userId]) {
          userSockets[userId] = userSockets[userId].filter((id) => id !== socket.id);
          if (userSockets[userId].length === 0) {
            delete userSockets[userId];
            onlineUsers.delete(userId);
            io.emit('onlineUsers', Array.from(onlineUsers));
          }
        }
      }
    });
  });
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { init, getIO, userSockets };