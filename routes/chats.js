const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Get all chats for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: chats, error } = await supabase
      .from('chats')
      .select(`
        *,
        user1:users!user1_id(id, name, profile_image_url),
        user2:users!user2_id(id, name, profile_image_url),
        product:shared_items(id, name, image_url, quantity, quantity_unit, status)
      `)
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    // Get unread counts and last message for each chat
    const chatsWithDetails = await Promise.all(chats.map(async (chat) => {
      // Get unread count
      const { count: unreadCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('chat_id', chat.id)
        .eq('recipient_id', userId)
        .eq('is_read', false);

      // Get last message
      const { data: lastMessage } = await supabase
        .from('messages')
        .select('text, created_at, sender_id, is_read')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const otherUser = chat.user1_id === userId ? chat.user2 : chat.user1;
      
      return {
        id: chat.id,
        otherUser: {
          id: otherUser?.id,
          name: otherUser?.name || 'User',
          profile_image_url: otherUser?.profile_image_url || '',
        },
        product: chat.product,
        lastMessage: lastMessage?.[0]?.text || 'No messages yet',
        lastMessageTime: lastMessage?.[0]?.created_at || chat.created_at,
        lastMessageSender: lastMessage?.[0]?.sender_id,
        unreadCount: unreadCount || 0,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at
      };
    }));

    res.status(200).json({
      success: true,
      chats: chatsWithDetails
    });

  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch chats' 
    });
  }
});

// Get or create chat with user about product
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { recipientId, productId } = req.body;

    if (!recipientId) {
      return res.status(400).json({
        success: false,
        error: 'Recipient ID is required'
      });
    }

    // Check if chat already exists
    let { data: existingChat } = await supabase
      .from('chats')
      .select('*')
      .or(`and(user1_id.eq.${userId},user2_id.eq.${recipientId}),and(user1_id.eq.${recipientId},user2_id.eq.${userId})`)
      .maybeSingle();

    if (!existingChat) {
      // Create new chat
      const { data: newChat, error } = await supabase
        .from('chats')
        .insert({
          user1_id: userId,
          user2_id: recipientId,
          product_id: productId || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      existingChat = newChat;
    }

    res.status(200).json({
      success: true,
      chat: existingChat
    });

  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create chat' 
    });
  }
});

// Get messages for a specific chat
router.get('/:chatId/messages', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const { limit = 50, before } = req.query;

    // Verify user is part of this chat
    const { data: chat } = await supabase
      .from('chats')
      .select('user1_id, user2_id')
      .eq('id', chatId)
      .single();

    if (!chat || (chat.user1_id !== userId && chat.user2_id !== userId)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let query = supabase
      .from('messages')
      .select(`
        *,
        sender:users!sender_id(id, name, profile_image_url),
        recipient:users!recipient_id(id, name, profile_image_url)
      `)
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data: messages, error } = await query;

    if (error) throw error;

    // Mark messages as read if user is recipient
    const unreadMessages = messages.filter(m => 
      m.recipient_id === userId && !m.is_read
    );
    
    if (unreadMessages.length > 0) {
      await supabase
        .from('messages')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .in('id', unreadMessages.map(m => m.id));
    }

    res.status(200).json({
      success: true,
      messages: messages.reverse()
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch messages' 
    });
  }
});

// Mark messages as read
router.post('/:chatId/read', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const { messageIds } = req.body;

    const { error } = await supabase
      .from('messages')
      .update({ 
        is_read: true,
        read_at: new Date().toISOString()
      })
      .in('id', messageIds)
      .eq('recipient_id', userId)
      .eq('chat_id', chatId);

    if (error) throw error;

    // Get WebSocket server instance
    const wsServer = req.app.get('wsServer');
    
    // Notify sender via WebSocket
    const { data: messages } = await supabase
      .from('messages')
      .select('sender_id')
      .in('id', messageIds)
      .limit(1);

    if (messages && messages.length > 0 && wsServer) {
      wsServer.broadcastToChat(chatId, {
        type: 'messages_read',
        chatId,
        messageIds,
        readerId: userId
      }, userId);
    }

    res.status(200).json({
      success: true,
      message: 'Messages marked as read'
    });

  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to mark messages as read' 
    });
  }
});

// Delete chat
router.delete('/:chatId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;

    const { error } = await supabase
      .from('chats')
      .delete()
      .eq('id', chatId)
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Chat deleted successfully'
    });

  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete chat' 
    });
  }
});

module.exports = router;






// const express = require('express');
// const router = express.Router();
// const supabase = require('../supabase');
// const { authenticateToken } = require('../middleware/auth');

// // Get all chats for current user
// router.get('/', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;

//     const { data: chats, error } = await supabase
//       .from('chats')
//       .select(`
//         *,
//         user1:users!user1_id(id, name, profile_image_url),
//         user2:users!user2_id(id, name, profile_image_url),
//         product:shared_items(id, name, image_url, quantity, quantity_unit, status),
//         last_message:messages(text, created_at, sender_id, is_read)
//       `)
//       .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
//       .order('last_message_time', { ascending: false });

//     if (error) throw error;

//     // Get unread counts for each chat
//     const chatsWithUnread = await Promise.all(chats.map(async (chat) => {
//       const { count } = await supabase
//         .from('messages')
//         .select('*', { count: 'exact', head: true })
//         .eq('chat_id', chat.id)
//         .eq('recipient_id', userId)
//         .eq('is_read', false);

//       const otherUser = chat.user1_id === userId ? chat.user2 : chat.user1;
      
//       return {
//         ...chat,
//         otherUser,
//         unreadCount: count || 0
//       };
//     }));

//     res.status(200).json({
//       success: true,
//       chats: chatsWithUnread
//     });

//   } catch (error) {
//     console.error('Get chats error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch chats' 
//     });
//   }
// });

// // Get or create chat with user about product
// router.post('/', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { recipientId, productId } = req.body;

//     if (!recipientId) {
//       return res.status(400).json({
//         success: false,
//         error: 'Recipient ID is required'
//       });
//     }

//     // Check if chat already exists
//     let { data: existingChat } = await supabase
//       .from('chats')
//       .select('*')
//       .or(`and(user1_id.eq.${userId},user2_id.eq.${recipientId}),and(user1_id.eq.${recipientId},user2_id.eq.${userId})`)
//       .maybeSingle();

//     if (!existingChat) {
//       // Create new chat
//       const { data: newChat, error } = await supabase
//         .from('chats')
//         .insert({
//           user1_id: userId,
//           user2_id: recipientId,
//           product_id: productId || null
//         })
//         .select()
//         .single();

//       if (error) throw error;
//       existingChat = newChat;
//     }

//     res.status(200).json({
//       success: true,
//       chat: existingChat
//     });

//   } catch (error) {
//     console.error('Create chat error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to create chat' 
//     });
//   }
// });

// // Get messages for a specific chat
// router.get('/:chatId/messages', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { chatId } = req.params;
//     const { limit = 50, before } = req.query;

//     // Verify user is part of this chat
//     const { data: chat } = await supabase
//       .from('chats')
//       .select('user1_id, user2_id')
//       .eq('id', chatId)
//       .single();

//     if (!chat || (chat.user1_id !== userId && chat.user2_id !== userId)) {
//       return res.status(403).json({
//         success: false,
//         error: 'Access denied'
//       });
//     }

//     let query = supabase
//       .from('messages')
//       .select(`
//         *,
//         sender:users!sender_id(name, profile_image_url),
//         recipient:users!recipient_id(name, profile_image_url)
//       `)
//       .eq('chat_id', chatId)
//       .order('created_at', { ascending: false })
//       .limit(limit);

//     if (before) {
//       query = query.lt('created_at', before);
//     }

//     const { data: messages, error } = await query;

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       messages: messages.reverse()
//     });

//   } catch (error) {
//     console.error('Get messages error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch messages' 
//     });
//   }
// });

// // Mark messages as read
// router.post('/:chatId/read', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { chatId } = req.params;
//     const { messageIds } = req.body;

//     const { error } = await supabase
//       .from('messages')
//       .update({ 
//         is_read: true,
//         read_at: new Date().toISOString()
//       })
//       .in('id', messageIds)
//       .eq('recipient_id', userId)
//       .eq('chat_id', chatId);

//     if (error) throw error;

//     // Get WebSocket server instance
//     const wsServer = req.app.get('wsServer');
    
//     // Notify sender via WebSocket
//     const { data: messages } = await supabase
//       .from('messages')
//       .select('sender_id')
//       .in('id', messageIds)
//       .limit(1);

//     if (messages && messages.length > 0) {
//       wsServer.broadcastToChat(chatId, {
//         type: 'messages_read',
//         chatId,
//         messageIds,
//         readerId: userId
//       }, userId);
//     }

//     res.status(200).json({
//       success: true,
//       message: 'Messages marked as read'
//     });

//   } catch (error) {
//     console.error('Mark read error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to mark messages as read' 
//     });
//   }
// });

// // Delete chat
// router.delete('/:chatId', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { chatId } = req.params;

//     const { error } = await supabase
//       .from('chats')
//       .delete()
//       .eq('id', chatId)
//       .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       message: 'Chat deleted successfully'
//     });

//   } catch (error) {
//     console.error('Delete chat error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to delete chat' 
//     });
//   }
// });

// module.exports = router;
