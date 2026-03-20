const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Send a new message
router.post('/', authenticateToken, async (req, res) => {
  try {
    const senderId = req.user.id;
    const { chatId, recipientId, text, productId } = req.body;

    if (!text || !recipientId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get or create chat
    let chatIdToUse = chatId;
    
    if (!chatId) {
      const { data: existingChat } = await supabase
        .from('chats')
        .select('id')
        .or(`and(user1_id.eq.${senderId},user2_id.eq.${recipientId}),and(user1_id.eq.${recipientId},user2_id.eq.${senderId})`)
        .maybeSingle();

      if (existingChat) {
        chatIdToUse = existingChat.id;
      } else {
        const { data: newChat, error: chatError } = await supabase
          .from('chats')
          .insert({
            user1_id: senderId,
            user2_id: recipientId,
            product_id: productId || null
          })
          .select()
          .single();

        if (chatError) throw chatError;
        chatIdToUse = newChat.id;
      }
    }

    // Save message
    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        chat_id: chatIdToUse,
        sender_id: senderId,
        recipient_id: recipientId,
        text: text,
        product_id: productId || null,
        created_at: new Date().toISOString()
      })
      .select(`
        *,
        sender:users!sender_id(name, profile_image_url),
        recipient:users!recipient_id(name, profile_image_url)
      `)
      .single();

    if (error) throw error;

    // Update chat's last message
    await supabase
      .from('chats')
      .update({
        last_message: text,
        last_message_time: message.created_at,
        last_message_sender: senderId,
        updated_at: new Date().toISOString()
      })
      .eq('id', chatIdToUse);

    // Get WebSocket server instance
    const wsServer = req.app.get('wsServer');
    
    // Prepare message payload
    const messagePayload = {
      type: 'new_message',
      message: {
        id: message.id,
        chatId: chatIdToUse,
        senderId,
        senderName: message.sender.name,
        senderImage: message.sender.profile_image_url,
        text,
        timestamp: message.created_at,
        isRead: false
      }
    };

    // Send to recipient via WebSocket
    wsServer.sendNotification(recipientId, messagePayload);

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: {
        message,
        chatId: chatIdToUse
      }
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to send message' 
    });
  }
});

// Get message by ID
router.get('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const { data: message, error } = await supabase
      .from('messages')
      .select(`
        *,
        sender:users!sender_id(name, profile_image_url),
        recipient:users!recipient_id(name, profile_image_url)
      `)
      .eq('id', messageId)
      .single();

    if (error) throw error;

    // Check if user is part of this message
    if (message.sender_id !== userId && message.recipient_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      message
    });

  } catch (error) {
    console.error('Get message error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch message' 
    });
  }
});

// Delete message
router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId)
      .eq('sender_id', userId);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully'
    });

  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete message' 
    });
  }
});

module.exports = router;