const { pool } = require('../db');
const { getIO } = require('../socket');

exports.createNotification = async (
  userId,
  title,
  content,
  type,
  senderId,
  relatedType,
  relatedId
) => {
  try {
    const result = await pool.query(
      `
      INSERT INTO notifications (user_id, title, content, type, sender_id, related_type, related_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [userId, title, content, type, senderId || null, relatedType || null, relatedId || null]
    );

    const notification = result.rows[0];

    const sender = senderId
      ? await pool.query(
          'SELECT id, first_name, last_name, avatar_url FROM users WHERE id = $1',
          [senderId]
        ).then(res => res.rows[0])
      : undefined;

    // Gửi thông báo qua Socket.IO
    const io = getIO(); 
    io.to(`user:${userId}`).emit('newNotification', {
      ...notification,
      sender
    });

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

exports.createLikeNotification = async (postId, userId, postOwnerId) => {
  if (userId === postOwnerId) return;

  await exports.createNotification(
    postOwnerId,
    'Bài viết được yêu thích',
    'đã thích bài viết của bạn',
    'like',
    userId,
    'post',
    postId
  );
};

exports.createCommentNotification = async (postId, userId, postOwnerId, commentContent) => {
  if (userId === postOwnerId) return;

  await exports.createNotification(
    postOwnerId,
    'Bình luận mới',
    `đã bình luận về bài viết của bạn: "${commentContent.substring(0, 50)}..."`,
    'comment',
    userId,
    'post',
    postId
  );
};

exports.createFollowNotification = async (followerId, userId) => {
  await exports.createNotification(
    userId,
    'Người theo dõi mới',
    'đã bắt đầu theo dõi bạn',
    'follow',
    followerId,
    null,
    null
  );
};

exports.createPostApprovedNotification = async (postId, postAuthorId) => {
  const title = 'Bài viết của bạn đã được duyệt!';
  const content = 'Bài viết của bạn đã được quản trị viên duyệt và hiển thị công khai.';

  await exports.createNotification(
    postAuthorId,
    title,
    content,
    'system',
    null,
    'post',
    postId
  );
};

exports.createPostNotification = async (postId, postAuthorId, postContent) => {
  // Lấy danh sách tất cả admin
  const adminsRes = await pool.query(
    "SELECT id FROM users WHERE role = 'admin'"
  );
  const adminIds = adminsRes.rows.map(row => row.id);

  const adminTitle = 'Bài viết mới cần duyệt';
  const adminContent = `Bài viết của user ${postAuthorId} "${postContent.substring(0, 100)}..." cần được duyệt.`;

  // Gửi thông báo đến từng admin
  const notifyAdmins = adminIds.map(adminId =>
    exports.createNotification(
      adminId,
      adminTitle,
      adminContent,
      'post_approval',
      postAuthorId,
      'post',
      postId
    )
  );
  await Promise.allSettled(notifyAdmins);

  await exports.createNotification(
    postAuthorId,
    'Bài viết của bạn đang chờ duyệt',
    'Bài viết của bạn đã được gửi và đang chờ quản trị viên xem xét.',
    'system',
    null,
    'post',
    postId
  );
};

exports.createPostForFollowersNotification = async (postId, postAuthorId) => {
  try {
    const authorRes = await pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [postAuthorId]);
    const author = authorRes.rows[0];
    if (!author) {
      console.warn(`Không tìm thấy bài viết ${postAuthorId}. Không thể gửi thông báo đến followers.`);
      return;
    }

    const notificationTitle = 'Có bài viết mới từ người bạn theo dõi';
    const notificationContent = `${author.last_name} ${author.first_name} đã đăng một bài viết mới.`;

    const followersRes = await pool.query(
      'SELECT follower_id FROM user_relationships WHERE user_id = $1',
      [postAuthorId]
    );
    const followerIds = followersRes.rows.map(row => row.follower_id);

    const notificationPromises = followerIds.map(followerId => {
      if (followerId === postAuthorId) {
        return Promise.resolve();
      }
      return exports.createNotification(
        followerId,
        notificationTitle,
        notificationContent,
        'new_post',
        postAuthorId,
        'post',
        postId
      );
    });

    await Promise.allSettled(notificationPromises);

  } catch (error) {
    throw error;
  }
};

exports.createReportNotificationForAdmin = async (postId, reporterId, reportedUserId, reason) => {
  try {
    const usersRes = await pool.query(
      'SELECT id, first_name, last_name FROM users WHERE id IN ($1, $2)',
      [reporterId, reportedUserId]
    );
    const reporter = usersRes.rows.find(u => u.id === reporterId);
    const reportedUser = usersRes.rows.find(u => u.id === reportedUserId);

    const reporterName = reporter ? `${reporter.first_name} ${reporter.last_name}`.trim() : 'Không xác định';
    const reportedUserName = reportedUser ? `${reportedUser.first_name} ${reportedUser.last_name}`.trim() : 'Không xác định';

    const adminTitle = 'Báo cáo mới cần xem xét';
    const adminContent = `Bài viết ID ${postId} của ${reportedUserName} đã bị ${reporterName} báo cáo vì: "${reason}".`;

    const adminsRes = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    const adminIds = adminsRes.rows.map(row => row.id);

    const notifyAdminsPromises = adminIds.map(adminId =>
      exports.createNotification(
        adminId,
        adminTitle,
        adminContent,
        'report_new',
        reporterId,
        'post',
        postId
      )
    );
    await Promise.allSettled(notifyAdminsPromises);
  } catch (error) {
    throw error;
  }
};

exports.createReportNotificationForUser = async (reporterId, reportId, status, postId) => {
  try {
    const title = 'Báo cáo của bạn đã được xử lý';
    const content = `Báo cáo của bạn về bài viết ID ${postId} đã được xử lý với trạng thái: "${status === 'processed' ? 'Đã xử lý' : status}". Cảm ơn bạn đã đóng góp!`;

    await exports.createNotification(
      reporterId,
      title,
      content,
      'system',
      null,
      'report',
      reportId
    );

  } catch (error) {
    throw error;
  }
};