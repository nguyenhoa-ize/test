const { query, pool, transaction } = require('../db');
const { getIO, isUserInRoom } = require('../socket');


const getUnreadTotal = async (userId) => {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(unread_count), 0) as total
    FROM conversation_members
    WHERE user_id = $1 AND unread_count > 0
  `, [userId]);
  return parseInt(rows[0].total, 10);
};

const processConversationRow = (row) => {
  const lastMessageAt = row.last_message_at?.toISOString() || null;
  const updatedAt = row.updated_at?.toISOString() || lastMessageAt;

  let lastMessage = '';
  if (row.last_message_image_urls && row.last_message_image_urls.length > 0) {
    lastMessage = '[Đã gửi một ảnh]';
  } else if (row.last_message_content) {
    lastMessage = row.last_message_content;
  }

  const conversation = {
    id: row.id,
    name: row.name,
    type: row.type,
    avatar_group: row.avatar_group || null,
    last_message: lastMessage,
    last_message_at: lastMessageAt,
    updated_at: updatedAt,
    unread_count: row.unread_count || 0,
  };

  if (row.type === 'direct' && row.other_user_id) {
    conversation.other_user = {
      id: row.other_user_id,
      name: [row.other_user_last_name, row.other_user_first_name]
        .filter(Boolean).join(' ').trim(),
      avatar: row.other_user_avatar_url || '',
    };
  }

  return conversation;
};

exports.getConversationDetails = async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  console.log("Conversation ID: ", conversationId)

  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.type,
        c.avatar_group,
        m.content AS last_message_content,
        m.image_url AS last_message_image_url,
        m.created_at AS last_message_at,
        cm.unread_count,
        u.id AS other_user_id,
        u.first_name AS other_user_first_name,
        u.last_name AS other_user_last_name,
        u.avatar_url AS other_user_avatar_url
      FROM conversations c
      JOIN conversation_members cm 
        ON c.id = cm.conversation_id 
        AND cm.user_id = $1
      LEFT JOIN messages m 
        ON c.last_message_id = m.id
      LEFT JOIN LATERAL (
        SELECT 
          u.id, 
          u.first_name, 
          u.last_name, 
          u.avatar_url
        FROM conversation_members cm2
        JOIN users u ON cm2.user_id = u.id
        WHERE 
          cm2.conversation_id = c.id 
          AND cm2.user_id != $1
          AND c.type = 'direct'
        LIMIT 1
      ) u ON true
      WHERE c.id = $2;
    `, [userId, conversationId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy cuộc hội thoại' }) || null;
    }

    const conversation = processConversationRow(rows[0]);
    return res.status(200).json(conversation);
  } catch (error) {
    console.error('Lỗi khi lấy chi tiết cuộc hội thoại:', error);
    return res.status(500).json({ message: 'Lỗi máy chủ' });
  }
};

exports.getAllConversations = async (req, res) => {
  const userId = req.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = req.query.search ? `%${req.query.search.toLowerCase()}%` : null;
  const offset = (page - 1) * limit;

  try {
    const countQuery = `
      SELECT COUNT(*) 
      FROM conversations c
      JOIN conversation_members cm 
        ON c.id = cm.conversation_id 
        AND cm.user_id = $1
      LEFT JOIN messages m 
        ON c.last_message_id = m.id
      LEFT JOIN LATERAL (
        SELECT u.first_name, u.last_name
        FROM conversation_members cm2
        JOIN users u ON cm2.user_id = u.id
        WHERE cm2.conversation_id = c.id 
          AND cm2.user_id != $1
          AND c.type = 'direct'
        LIMIT 1
      ) u ON true
      WHERE $2::text IS NULL OR (
        c.type = 'group' AND LOWER(c.name) LIKE $2::text
        OR c.type = 'direct' AND (
          LOWER(u.first_name || ' ' || u.last_name) LIKE $2::text
          OR LOWER(m.content) LIKE $2::text
        )
      )
    `;
    const { rows: [{ count }] } = await pool.query(countQuery, [userId, search]);

    // Fetch conversations
    const conversationsQuery = `
      SELECT
        c.id,
        c.name,
        c.type,
        c.avatar_group,
        c.last_message_at,
        m.content AS last_message_content,
        m.image_url AS last_message_image_urls,
        cm.unread_count,
        u.id AS other_user_id,
        u.first_name AS other_user_first_name,
        u.last_name AS other_user_last_name,
        u.avatar_url AS other_user_avatar_url
      FROM conversations c
      JOIN conversation_members cm 
        ON c.id = cm.conversation_id 
        AND cm.user_id = $1
      LEFT JOIN messages m 
        ON c.last_message_id = m.id
      LEFT JOIN LATERAL (
        SELECT 
          u.id, 
          u.first_name, 
          u.last_name, 
          u.avatar_url
        FROM conversation_members cm2
        JOIN users u ON cm2.user_id = u.id
        WHERE 
          cm2.conversation_id = c.id 
          AND cm2.user_id != $1
          AND c.type = 'direct'
        LIMIT 1
      ) u ON true
      WHERE $2::text IS NULL OR (
        c.type = 'group' AND LOWER(c.name) LIKE $2::text
        OR c.type = 'direct' AND (
          LOWER(u.first_name || ' ' || u.last_name) LIKE $2::text
          OR LOWER(m.content) LIKE $2::text
        )
      )
      ORDER BY GREATEST(c.last_message_at, c.updated_at) DESC NULLS LAST
      LIMIT $3 OFFSET $4
    `;
    const { rows } = await pool.query(conversationsQuery, [userId, search, limit, offset]);

    const processedRows = rows.map(row => {
      if (typeof row.last_message_image_urls === 'string') {
        try {
          row.last_message_image_urls = JSON.parse(row.last_message_image_urls);
        } catch (e) {
          row.last_message_image_urls = [row.last_message_image_urls];
        }
      }
      return row;
    });

    const conversations = processedRows.map(processConversationRow);
    return res.status(200).json({
      conversations,
      total: parseInt(count),
    });
  } catch (error) {
    console.error('Lỗi khi lấy danh sách hội thoại:', error);
    return res.status(500).json({ message: 'Lỗi máy chủ' });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const offset = (page - 1) * limit;

    // Verify user is part of the conversation
    const conversation = await query(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (conversation.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to view this conversation' });
    }

    const messages = await query(`
      SELECT 
        m.*,
        u.first_name || ' ' || u.last_name as sender_name,
        u.avatar_url as sender_avatar,
        rm.content as reply_to_content,
        ru.first_name || ' ' || ru.last_name as reply_to_sender_name,
        rm.type as reply_to_type
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
      LEFT JOIN users ru ON rm.sender_id = ru.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [conversationId, limit, offset]);

    // Parse image_url from JSON string to array
    const processedMessages = messages.rows.map(msg => {
      if (typeof msg.image_url === 'string') {
        try {
          // Attempt to parse it as JSON. If it's just a plain string URL, wrap it in an array.
          const parsed = JSON.parse(msg.image_url);
          msg.image_urls = Array.isArray(parsed) ? parsed : [msg.image_url];
        } catch (e) {
          // If parsing fails, it's likely a single URL string.
          msg.image_urls = [msg.image_url];
        }
      } else {
        msg.image_urls = [];
      }
      delete msg.image_url; // Clean up old field
      return msg;
    });

    res.json(processedMessages);
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.createConversation = async (req, res) => {
  try {
    const { members, type = 'direct', name = '', avatar_group = null } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(members)) {
      return res.status(400).json({ error: 'Danh sách thành viên không hợp lệ' });
    }

    if (type === 'direct') {
      if (members.length !== 1) {
        return res.status(400).json({ error: 'Yêu cầu chính xác một thành viên khác' });
      }

      const otherUserId = members[0];
      if (otherUserId === userId) {
        return res.status(400).json({ error: 'Không thể tạo hội thoại với chính mình' });
      }

      // Kiểm tra hội thoại đã tồn tại chưa
      const checkQuery = `
        SELECT c.id
        FROM conversations c
        JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
        JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
        WHERE c.type = 'direct'
        LIMIT 1
      `;
      const checkResult = await pool.query(checkQuery, [userId, otherUserId]);

      if (checkResult.rowCount > 0) {
        const convoId = checkResult.rows[0].id;

        // Lấy thông tin chi tiết hội thoại
        const detailQuery = `
          SELECT
            c.id, c.type, c.last_message_at, c.updated_at,
            m.content AS last_message,
            cm.unread_count,
            u.id AS other_user_id, u.email, u.first_name, u.last_name, u.avatar_url
          FROM conversations c
          JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
          JOIN conversation_members cm_other ON cm_other.conversation_id = c.id AND cm_other.user_id = $2
          JOIN users u ON u.id = cm_other.user_id
          LEFT JOIN messages m ON m.id = c.last_message_id
          WHERE c.id = $3
        `;
        const detailRes = await pool.query(detailQuery, [userId, otherUserId, convoId]);
        const row = detailRes.rows[0];

        return res.status(200).json({
          conversation: {
            id: row.id,
            name: `${row.first_name} ${row.last_name}`,
            type: row.type,
            last_message_at: row.last_message_at,
            updated_at: row.updated_at,
            last_message: row.last_message || '',
            avatar_group: null,
            other_user: {
              id: row.other_user_id,
              email: row.email,
              name: `${row.first_name} ${row.last_name}`,
              avatar: row.avatar_url,
            },
            unread_count: parseInt(row.unread_count, 10) || 0,
          },
          message: 'Hội thoại đã tồn tại',
          isNew: false,
        });
      }
    }

    // Kiểm tra dữ liệu khi tạo nhóm
    if (type === 'group') {
      if (members.length === 0) {
        return res.status(400).json({ error: 'Cần ít nhất một thành viên khác' });
      }
      if (!name.trim()) {
        return res.status(400).json({ error: 'Tên nhóm là bắt buộc' });
      }
    } else if (type !== 'direct') {
      return res.status(400).json({ error: 'Loại hội thoại không hợp lệ' });
    }

    // Tiến hành tạo hội thoại mới
    const result = await transaction(async (client) => {
      const convoRes = await client.query(
        `INSERT INTO conversations (name, type, avatar_group)
         VALUES ($1, $2, $3)
         RETURNING id, created_at, updated_at`,
        [type === 'direct' ? '' : name, type, type === 'group' ? avatar_group : null]
      );

      const convo = convoRes.rows[0];
      const allMembers = [...new Set([...members, userId])]; // loại trùng

      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, unread_count)
         SELECT $1, unnest($2::uuid[]), 0`,
        [convo.id, allMembers]
      );

      return {
        id: convo.id,
        updatedAt: convo.updated_at,
      };
    });

    // Lấy thông tin người dùng nếu là direct
    if (type === 'direct') {
      const otherUserId = members[0];
      const userRes = await pool.query(
        `SELECT id, email, first_name, last_name, avatar_url FROM users WHERE id = $1`,
        [otherUserId]
      );
      const user = userRes.rows[0];

      return res.status(201).json({
        conversation: {
          id: result.id,
          name: `${user.first_name} ${user.last_name}`,
          type,
          last_message_at: null,
          updated_at: result.updatedAt,
          last_message: '',
          avatar_group: null,
          other_user: {
            id: user.id,
            email: user.email,
            name: `${user.first_name} ${user.last_name}`,
            avatar: user.avatar_url,
          },
          unread_count: 0,
        },
        message: 'Tạo hội thoại thành công',
        isNew: true,
      });
    } else {
      return res.status(201).json({
        conversation: {
          id: result.id,
          name,
          type,
          avatar_group,
          last_message_at: null,
          updated_at: result.updatedAt,
          last_message: '',
          other_user: null,
          members: [...new Set([...members, userId])],
          unread_count: 0,
        },
        message: 'Tạo nhóm thành công',
        isNew: true,
      });
    }
  } catch (error) {
    console.error('Lỗi tạo hội thoại:', error);
    return res.status(500).json({ error: 'Lỗi server', details: error.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, type = 'text', imageUrl, imageUrls, replyToMessageId } = req.body;
    const userId = req.user.id;

    let finalImageUrls = [];
    if (imageUrls && Array.isArray(imageUrls)) {
      finalImageUrls = imageUrls;
    } else if (imageUrl) {
      finalImageUrls = [imageUrl];
    }
    
    // Store as JSON string if not empty, otherwise null
    const imageUrlsJson = finalImageUrls.length > 0 ? JSON.stringify(finalImageUrls) : null;
    const messageType = finalImageUrls.length > 0 ? 'image' : type;

    const message = await transaction(async (client) => {
      // Xác minh quyền
      const { rowCount } = await client.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );
      if (rowCount === 0) {
        throw { status: 403, message: 'Not authorized to send messages in this conversation' };
      }

      // Chèn tin nhắn
      const msgInsertRes = await client.query(`
        INSERT INTO messages (conversation_id, sender_id, content, type, image_url, reply_to_message_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, created_at
      `, [conversationId, userId, content, messageType, imageUrlsJson, replyToMessageId]);
      const { id: messageId, created_at } = msgInsertRes.rows[0];

      // Cập nhật thời gian tin nhắn cuối cùng
      await client.query(`
        UPDATE conversations SET last_message_at = $1, updated_at = $1, last_message_id = $2 WHERE id = $3
      `, [created_at, messageId, conversationId]);

      // Lấy thông tin đầy đủ của tin nhắn
      const result = await client.query(`
        SELECT 
          m.*, 
          u.first_name || ' ' || u.last_name AS sender_name,
          u.avatar_url AS sender_avatar,
          rm.content AS reply_to_content,
          ru.first_name || ' ' || ru.last_name AS reply_to_sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.sender_id = ru.id
        WHERE m.id = $1
      `, [messageId]);

      const dbMessage = result.rows[0];
      
      // Parse image_url before sending back
      if (typeof dbMessage.image_url === 'string') {
        try {
          dbMessage.image_urls = JSON.parse(dbMessage.image_url);
        } catch {
          dbMessage.image_urls = [dbMessage.image_url];
        }
      } else {
        dbMessage.image_urls = [];
      }
      delete dbMessage.image_url;
      
      return dbMessage;
    });

    res.status(201).json(message);

    // Emit real-time
    const io = getIO();
    io.to(conversationId).emit('newMessage', message);

    // Lấy conversation members
    const membersRes = await pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
      [conversationId, userId]
    );
    const targetUsers = membersRes.rows.map((row) => row.user_id);

    // Cập nhật tin nhắn chưa được và gửi thông báo đến user không ở trong phòng
    await Promise.all(
      targetUsers.map(async (targetUserId) => {
        const isUserInRoomResult = await isUserInRoom(targetUserId, conversationId);

        if (!isUserInRoomResult) {
          // Tăng tin nhắn chưa đọc
          await pool.query(
            `UPDATE conversation_members 
             SET unread_count = unread_count + 1 
             WHERE user_id = $1 AND conversation_id = $2`,
            [targetUserId, conversationId]
          );

          const totalUnread = await getUnreadTotal(targetUserId);

          // Emit newMessage và unreadTotalUpdated đến user
          io.to(`user:${targetUserId}`).emit('newMessage', message);
          io.to(`user:${targetUserId}`).emit('unreadTotalUpdated', { total: totalUnread });
        }
      })
    );

  } catch (error) {
    if (error.status === 403) {
      return res.status(403).json({ error: error.message });
    }
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getUnreadTotal = async (req, res) => {
  try {
    const userId = req.user.id;
    const total = await getUnreadTotal(userId);
    res.json({ total });
  } catch (error) {
    console.error('Error fetching unread total:', error);
    res.status(500).json({ error: 'Failed to fetch unread total' });
  }
};