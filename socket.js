const { Server } = require('socket.io');
const { pool } = require('./db');

let io;

function init(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000', 'http://127.0.0.1:3000'],
      credentials: true,
    },
  });

  const onlineUsers = new Set();

  io.on('connection', (socket) => {
    let userId = null;

    socket.on('register', (id) => {
      if (!id) {
        socket.emit('error', { message: 'Invalid user ID' });
        return;
      }
      userId = id;
      socket.userId = id;
      socket.join(`user:${userId}`);
      onlineUsers.add(userId);
      io.emit('onlineUsers', Array.from(onlineUsers));
    });

    socket.on('joinConversation', async ({ userId, conversationId }) => {
      if (!userId || !conversationId) {
        socket.emit('error', { message: 'Missing userId or conversationId' });
        return;
      }

      if (!socket.userId) {
        socket.userId = userId;
      }

      try {
        socket.join(conversationId);

        const result = await pool.query(
          'UPDATE conversation_members SET unread_count = 0 WHERE user_id = $1 AND conversation_id = $2 RETURNING unread_count',
          [userId, conversationId]
        );

        if (result.rowCount === 0) {
          socket.emit('error', { message: 'Conversation member not found' });
          return;
        }

        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(unread_count), 0) as total
           FROM conversation_members
           WHERE user_id = $1 AND unread_count > 0`,
          [userId]
        );

        const totalUnread = parseInt(rows[0].total, 10);
        io.to(`user:${userId}`).emit('unreadTotalUpdated', { total: totalUnread });
      } catch (error) {
        console.error('Error updating unread_count:', error);
        socket.emit('error', { message: 'Failed to update unread count' });
      }
    });

    socket.on('leave', (conversationId) => {
      if (conversationId) {
        socket.leave(conversationId);
      }
    });

    socket.on('typing', ({ conversationId, userId }) => {
      if (conversationId && userId) {
        socket.to(conversationId).emit('typing', { userId });
      }
    });

    socket.on('stopTyping', ({ conversationId, userId }) => {
      if (conversationId && userId) {
        socket.to(conversationId).emit('stopTyping', { userId });
      }
    });

    socket.on('disconnect', async () => {
      if (userId) {
        socket.leave(`user:${userId}`);
        try {
          const socketsInRoom = await io.in(`user:${userId}`).allSockets();
          if (socketsInRoom.size === 0) {
            onlineUsers.delete(userId);
            io.emit('onlineUsers', Array.from(onlineUsers));
          }
        } catch (error) {
          console.error('Lỗi khi kiểm tra thành viên không kết nối:', error);
        }
      }
    });
  });
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

async function isUserInRoom(userId, roomId) {
  if (!io) return false;
  
  try {
    const socketsInRoom = await io.in(roomId).allSockets();
    
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket && socket.userId === userId) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking if user is in room:', error);
    return false;
  }
}

module.exports = { init, getIO, isUserInRoom };