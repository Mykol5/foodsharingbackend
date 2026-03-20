// This can be used in your routes to handle typing indicators
const typingUsers = new Map(); // chatId -> Set of userIds

const typingMiddleware = {
  // User started typing
  startTyping: (chatId, userId) => {
    if (!typingUsers.has(chatId)) {
      typingUsers.set(chatId, new Set());
    }
    typingUsers.get(chatId).add(userId);
  },

  // User stopped typing
  stopTyping: (chatId, userId) => {
    if (typingUsers.has(chatId)) {
      typingUsers.get(chatId).delete(userId);
      if (typingUsers.get(chatId).size === 0) {
        typingUsers.delete(chatId);
      }
    }
  },

  // Get users typing in a chat
  getTypingUsers: (chatId) => {
    return typingUsers.get(chatId) || new Set();
  },

  // Clear all typing data (useful for disconnections)
  clearUser: (userId) => {
    for (const [chatId, users] of typingUsers.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          typingUsers.delete(chatId);
        }
      }
    }
  }
};

module.exports = typingMiddleware;