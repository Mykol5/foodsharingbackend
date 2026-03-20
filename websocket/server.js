const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Store active connections
const clients = new Map(); // userId -> { ws, userId, chatSubscriptions, questionSubscriptions }
const userStatus = new Map(); // userId -> 'online' | 'offline'
const questionSubscribers = new Map(); // questionId -> Set of userIds

class WebSocketServer {
  constructor(server, options = {}) {
    this.wss = new WebSocket.Server({ 
      server,
      path: options.path || '/ws'
    });
    this.setupWebSocket();
  }

  setupWebSocket() {
    this.wss.on('connection', async (ws, req) => {
      try {
        // Get the URL path
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.pathname;
        
        // Extract token from query string
        const token = url.searchParams.get('token');
        
        if (!token) {
          ws.close(1008, 'No token provided');
          return;
        }

        // Verify JWT token
        let decoded;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
          ws.close(1008, 'Invalid token');
          return;
        }
        
        const userId = decoded.id;

        // Store client connection
        clients.set(userId, {
          ws,
          userId,
          chatSubscriptions: new Set(),
          questionSubscriptions: new Set(),
          lastPing: Date.now()
        });

        // Update user status
        userStatus.set(userId, 'online');
        
        // Broadcast online status to relevant users
        await this.broadcastStatusUpdate(userId, 'online');

        console.log(`User ${userId} connected. Total connections: ${clients.size}`);

        // Send initial connection success
        ws.send(JSON.stringify({
          type: 'connection',
          status: 'connected',
          userId: userId
        }));

        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const data = JSON.parse(message);
            await this.handleMessage(userId, ws, data);
          } catch (error) {
            console.error('Error parsing message:', error);
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid message format'
            }));
          }
        });

        // Handle ping/pong for connection health
        ws.on('pong', () => {
          const client = clients.get(userId);
          if (client) {
            client.lastPing = Date.now();
          }
        });

        // Handle disconnection
        ws.on('close', async () => {
          // Clean up question subscriptions
          if (questionSubscribers.size > 0) {
            for (const [questionId, subscribers] of questionSubscribers.entries()) {
              if (subscribers.has(userId)) {
                subscribers.delete(userId);
                if (subscribers.size === 0) {
                  questionSubscribers.delete(questionId);
                }
              }
            }
          }
          
          clients.delete(userId);
          userStatus.set(userId, 'offline');
          await this.broadcastStatusUpdate(userId, 'offline');
          console.log(`User ${userId} disconnected. Total connections: ${clients.size}`);
        });

        // Set up ping interval to check connection health
        const pingInterval = setInterval(() => {
          const client = clients.get(userId);
          if (client) {
            const now = Date.now();
            if (now - client.lastPing > 30000) { // 30 seconds
              console.log(`User ${userId} ping timeout, terminating connection`);
              ws.terminate();
              clearInterval(pingInterval);
            } else {
              ws.ping();
            }
          } else {
            clearInterval(pingInterval);
          }
        }, 15000);

      } catch (error) {
        console.error('WebSocket connection error:', error);
        ws.close(1011, 'Authentication failed');
      }
    });
  }

  async handleMessage(userId, ws, data) {
    const client = clients.get(userId);
    if (!client) return;

    switch (data.type) {
      case 'subscribe':
        await this.handleSubscribe(userId, data);
        break;
      case 'unsubscribe':
        await this.handleUnsubscribe(userId, data);
        break;
      case 'subscribe_question':
        await this.handleQuestionSubscribe(userId, data);
        break;
      case 'unsubscribe_question':
        await this.handleQuestionUnsubscribe(userId, data);
        break;
      case 'message':
        await this.handleChatMessage(userId, data);
        break;
      case 'mark_read':
        await this.handleMarkRead(userId, data);
        break;
      case 'typing':
        await this.handleTyping(userId, data);
        break;
      case 'get_status':
        await this.handleGetStatus(userId, ws, data);
        break;
      default:
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Unknown message type'
        }));
    }
  }

  async handleSubscribe(userId, data) {
    const client = clients.get(userId);
    if (!client) return;

    const { chatId } = data;
    client.chatSubscriptions.add(chatId);

    // Send confirmation
    client.ws.send(JSON.stringify({
      type: 'subscribed',
      chatId
    }));

    // Send online status of other participants
    await this.sendChatParticipantsStatus(chatId, userId);
  }

  async handleUnsubscribe(userId, data) {
    const client = clients.get(userId);
    if (!client) return;

    const { chatId } = data;
    client.chatSubscriptions.delete(chatId);

    client.ws.send(JSON.stringify({
      type: 'unsubscribed',
      chatId
    }));
  }

  async handleQuestionSubscribe(userId, data) {
    const client = clients.get(userId);
    if (!client) return;

    const { questionId } = data;
    client.questionSubscriptions.add(questionId);
    
    if (!questionSubscribers.has(questionId)) {
      questionSubscribers.set(questionId, new Set());
    }
    questionSubscribers.get(questionId).add(userId);

    client.ws.send(JSON.stringify({
      type: 'subscribed_question',
      questionId
    }));
  }

  async handleQuestionUnsubscribe(userId, data) {
    const client = clients.get(userId);
    if (!client) return;

    const { questionId } = data;
    client.questionSubscriptions.delete(questionId);
    
    if (questionSubscribers.has(questionId)) {
      questionSubscribers.get(questionId).delete(userId);
      if (questionSubscribers.get(questionId).size === 0) {
        questionSubscribers.delete(questionId);
      }
    }

    client.ws.send(JSON.stringify({
      type: 'unsubscribed_question',
      questionId
    }));
  }

  async handleChatMessage(userId, data) {
    const { chatId, recipientId, text, productId } = data;

    try {
      // Save message to database
      const { data: message, error } = await supabase
        .from('messages')
        .insert({
          chat_id: chatId,
          sender_id: userId,
          recipient_id: recipientId,
          text: text,
          product_id: productId,
          created_at: new Date().toISOString(),
          is_read: false
        })
        .select(`
          *,
          sender:users!sender_id(name, profile_image_url),
          recipient:users!recipient_id(name, profile_image_url)
        `)
        .single();

      if (error) throw error;

      // Get sender info
      const { data: senderData } = await supabase
        .from('users')
        .select('name, profile_image_url')
        .eq('id', userId)
        .single();

      // Prepare message payload
      const messagePayload = {
        type: 'new_message',
        message: {
          id: message.id,
          chatId,
          senderId: userId,
          senderName: senderData?.name || 'User',
          senderImage: senderData?.profile_image_url,
          text,
          timestamp: message.created_at,
          isRead: false
        }
      };

      // Send to recipient if online
      const recipientClient = clients.get(recipientId);
      if (recipientClient && recipientClient.chatSubscriptions.has(chatId)) {
        recipientClient.ws.send(JSON.stringify(messagePayload));
      }

      // Send confirmation to sender
      const senderClient = clients.get(userId);
      if (senderClient) {
        senderClient.ws.send(JSON.stringify({
          ...messagePayload,
          type: 'message_sent',
          message: {
            ...messagePayload.message,
            isMe: true
          }
        }));
      }

      // Update chat last message
      await supabase
        .from('chats')
        .update({
          last_message: text,
          last_message_time: message.created_at,
          last_message_sender: userId
        })
        .eq('id', chatId);

    } catch (error) {
      console.error('Error saving message:', error);
      
      const senderClient = clients.get(userId);
      if (senderClient) {
        senderClient.ws.send(JSON.stringify({
          type: 'message_failed',
          chatId,
          error: 'Failed to send message'
        }));
      }
    }
  }

  async handleMarkRead(userId, data) {
    const { chatId, messageIds } = data;

    try {
      // Update messages as read in database
      const { error } = await supabase
        .from('messages')
        .update({ is_read: true })
        .in('id', messageIds)
        .eq('recipient_id', userId);

      if (error) throw error;

      // Notify sender that messages were read
      const { data: messages } = await supabase
        .from('messages')
        .select('sender_id')
        .in('id', messageIds)
        .limit(1);

      if (messages && messages.length > 0) {
        const senderId = messages[0].sender_id;
        const senderClient = clients.get(senderId);
        
        if (senderClient && senderClient.chatSubscriptions.has(chatId)) {
          senderClient.ws.send(JSON.stringify({
            type: 'messages_read',
            chatId,
            messageIds
          }));
        }
      }

    } catch (error) {
      console.error('Error marking messages as read:', error);
    }
  }

  async handleTyping(userId, data) {
    const { chatId, isTyping, recipientId } = data;

    const recipientClient = clients.get(recipientId);
    if (recipientClient && recipientClient.chatSubscriptions.has(chatId)) {
      recipientClient.ws.send(JSON.stringify({
        type: 'typing',
        chatId,
        userId,
        isTyping
      }));
    }
  }

  async handleGetStatus(userId, ws, data) {
    const { userIds } = data;
    const statuses = {};

    for (const id of userIds) {
      statuses[id] = userStatus.get(id) || 'offline';
    }

    ws.send(JSON.stringify({
      type: 'status_update',
      statuses
    }));
  }

  async broadcastStatusUpdate(userId, status) {
    // Find all chats this user is part of
    const { data: chats } = await supabase
      .from('chats')
      .select('id, user1_id, user2_id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (!chats) return;

    // For each chat, notify the other participant
    for (const chat of chats) {
      const otherUserId = chat.user1_id === userId ? chat.user2_id : chat.user1_id;
      const otherClient = clients.get(otherUserId);

      if (otherClient && otherClient.chatSubscriptions.has(chat.id)) {
        otherClient.ws.send(JSON.stringify({
          type: 'user_status',
          userId,
          status,
          chatId: chat.id
        }));
      }
    }
  }

  async sendChatParticipantsStatus(chatId, requestingUserId) {
    // Get chat participants
    const { data: chat } = await supabase
      .from('chats')
      .select('user1_id, user2_id')
      .eq('id', chatId)
      .single();

    if (!chat) return;

    const participants = [chat.user1_id, chat.user2_id];
    const statuses = {};

    for (const participantId of participants) {
      if (participantId !== requestingUserId) {
        statuses[participantId] = userStatus.get(participantId) || 'offline';
      }
    }

    const client = clients.get(requestingUserId);
    if (client) {
      client.ws.send(JSON.stringify({
        type: 'participants_status',
        chatId,
        statuses
      }));
    }
  }

  // Public method to send notification about new question
  sendNewQuestionNotification(question) {
    // Broadcast to all connected users
    for (const [userId, client] of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'new_question',
          question
        }));
      }
    }
  }

  // Public method to send notification about new answer
  sendNewAnswerNotification(questionId, answer) {
    // Send to users subscribed to this question
    if (questionSubscribers.has(questionId)) {
      const subscribers = questionSubscribers.get(questionId);
      for (const userId of subscribers) {
        const client = clients.get(userId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'new_answer',
            questionId,
            answer
          }));
        }
      }
    }
  }

  // Public method to send notification to specific user
  sendNotification(userId, notification) {
    const client = clients.get(userId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'notification',
        ...notification
      }));
    }
  }

  // Public method to broadcast to all users in a chat
  broadcastToChat(chatId, message, excludeUserId = null) {
    clients.forEach((client, userId) => {
      if (excludeUserId && userId === excludeUserId) return;
      if (client.chatSubscriptions.has(chatId)) {
        client.ws.send(JSON.stringify(message));
      }
    });
  }

  // Public method to get online status of a user
  getUserStatus(userId) {
    return userStatus.get(userId) || 'offline';
  }
}

module.exports = WebSocketServer;





// const WebSocket = require('ws');
// const jwt = require('jsonwebtoken');
// const { createClient } = require('@supabase/supabase-js');

// // Initialize Supabase client
// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_KEY
// );

// // Store active connections
// const clients = new Map(); // userId -> { ws, userId, subscriptions }
// const userStatus = new Map(); // userId -> 'online' | 'offline'
// const questionSubscribers = new Map(); // questionId -> Set of userIds

// class WebSocketServer {
//   constructor(server, options = {}) {
//     this.wss = new WebSocket.Server({ 
//       server,
//       path: options.path || '/ws'
//     });
//     this.setupWebSocket();
//   }

//   setupWebSocket() {
//     this.wss.on('connection', async (ws, req) => {
//       try {
//         // Extract token from query string
//         const url = new URL(req.url, `http://${req.headers.host}`);
//         const token = url.searchParams.get('token');
        
//         if (!token) {
//           ws.close(1008, 'No token provided');
//           return;
//         }

//         // Verify JWT token
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         const userId = decoded.id;

//         // Store client connection
//         clients.set(userId, {
//           ws,
//           userId,
//           chatSubscriptions: new Set(),
//           questionSubscriptions: new Set(),
//           lastPing: Date.now()
//         });

//         // Update user status
//         userStatus.set(userId, 'online');
        
//         // Broadcast online status to relevant users
//         await this.broadcastStatusUpdate(userId, 'online');

//         console.log(`User ${userId} connected. Total connections: ${clients.size}`);

//         // Send initial connection success
//         ws.send(JSON.stringify({
//           type: 'connection',
//           status: 'connected',
//           userId: userId
//         }));

//         // Handle incoming messages
//         ws.on('message', async (message) => {
//           try {
//             const data = JSON.parse(message);
//             await this.handleMessage(userId, ws, data);
//           } catch (error) {
//             console.error('Error parsing message:', error);
//             ws.send(JSON.stringify({
//               type: 'error',
//               error: 'Invalid message format'
//             }));
//           }
//         });

//         // Handle ping/pong for connection health
//         ws.on('pong', () => {
//           const client = clients.get(userId);
//           if (client) {
//             client.lastPing = Date.now();
//           }
//         });

//         // Handle disconnection
//         ws.on('close', async () => {
//           // Clean up question subscriptions
//           if (questionSubscribers.size > 0) {
//             for (const [questionId, subscribers] of questionSubscribers.entries()) {
//               if (subscribers.has(userId)) {
//                 subscribers.delete(userId);
//                 if (subscribers.size === 0) {
//                   questionSubscribers.delete(questionId);
//                 }
//               }
//             }
//           }
          
//           clients.delete(userId);
//           userStatus.set(userId, 'offline');
//           await this.broadcastStatusUpdate(userId, 'offline');
//           console.log(`User ${userId} disconnected. Total connections: ${clients.size}`);
//         });

//         // Set up ping interval to check connection health
//         const pingInterval = setInterval(() => {
//           const client = clients.get(userId);
//           if (client) {
//             const now = Date.now();
//             if (now - client.lastPing > 30000) { // 30 seconds
//               console.log(`User ${userId} ping timeout, terminating connection`);
//               ws.terminate();
//               clearInterval(pingInterval);
//             } else {
//               ws.ping();
//             }
//           } else {
//             clearInterval(pingInterval);
//           }
//         }, 15000);

//       } catch (error) {
//         console.error('WebSocket connection error:', error);
//         ws.close(1011, 'Authentication failed');
//       }
//     });
//   }

//   async handleMessage(userId, ws, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     switch (data.type) {
//       case 'subscribe':
//         await this.handleSubscribe(userId, data);
//         break;
//       case 'unsubscribe':
//         await this.handleUnsubscribe(userId, data);
//         break;
//       case 'subscribe_question':
//         await this.handleQuestionSubscribe(userId, data);
//         break;
//       case 'unsubscribe_question':
//         await this.handleQuestionUnsubscribe(userId, data);
//         break;
//       case 'message':
//         await this.handleChatMessage(userId, data);
//         break;
//       case 'mark_read':
//         await this.handleMarkRead(userId, data);
//         break;
//       case 'typing':
//         await this.handleTyping(userId, data);
//         break;
//       case 'get_status':
//         await this.handleGetStatus(userId, ws, data);
//         break;
//       default:
//         ws.send(JSON.stringify({
//           type: 'error',
//           error: 'Unknown message type'
//         }));
//     }
//   }

//   async handleSubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { chatId } = data;
//     client.chatSubscriptions.add(chatId);

//     // Send confirmation
//     client.ws.send(JSON.stringify({
//       type: 'subscribed',
//       chatId
//     }));

//     // Send online status of other participants
//     await this.sendChatParticipantsStatus(chatId, userId);
//   }

//   async handleUnsubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { chatId } = data;
//     client.chatSubscriptions.delete(chatId);

//     client.ws.send(JSON.stringify({
//       type: 'unsubscribed',
//       chatId
//     }));
//   }

//   async handleQuestionSubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { questionId } = data;
//     client.questionSubscriptions.add(questionId);
    
//     if (!questionSubscribers.has(questionId)) {
//       questionSubscribers.set(questionId, new Set());
//     }
//     questionSubscribers.get(questionId).add(userId);

//     client.ws.send(JSON.stringify({
//       type: 'subscribed_question',
//       questionId
//     }));
//   }

//   async handleQuestionUnsubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { questionId } = data;
//     client.questionSubscriptions.delete(questionId);
    
//     if (questionSubscribers.has(questionId)) {
//       questionSubscribers.get(questionId).delete(userId);
//       if (questionSubscribers.get(questionId).size === 0) {
//         questionSubscribers.delete(questionId);
//       }
//     }

//     client.ws.send(JSON.stringify({
//       type: 'unsubscribed_question',
//       questionId
//     }));
//   }

//   async handleChatMessage(userId, data) {
//     const { chatId, recipientId, text, productId } = data;

//     try {
//       // Save message to database
//       const { data: message, error } = await supabase
//         .from('messages')
//         .insert({
//           chat_id: chatId,
//           sender_id: userId,
//           recipient_id: recipientId,
//           text: text,
//           product_id: productId,
//           created_at: new Date().toISOString(),
//           is_read: false
//         })
//         .select(`
//           *,
//           sender:users!sender_id(name, profile_image_url),
//           recipient:users!recipient_id(name, profile_image_url)
//         `)
//         .single();

//       if (error) throw error;

//       // Get sender info
//       const { data: senderData } = await supabase
//         .from('users')
//         .select('name, profile_image_url')
//         .eq('id', userId)
//         .single();

//       // Prepare message payload
//       const messagePayload = {
//         type: 'new_message',
//         message: {
//           id: message.id,
//           chatId,
//           senderId: userId,
//           senderName: senderData?.name || 'User',
//           senderImage: senderData?.profile_image_url,
//           text,
//           timestamp: message.created_at,
//           isRead: false
//         }
//       };

//       // Send to recipient if online
//       const recipientClient = clients.get(recipientId);
//       if (recipientClient && recipientClient.chatSubscriptions.has(chatId)) {
//         recipientClient.ws.send(JSON.stringify(messagePayload));
//       }

//       // Send confirmation to sender
//       const senderClient = clients.get(userId);
//       if (senderClient) {
//         senderClient.ws.send(JSON.stringify({
//           ...messagePayload,
//           type: 'message_sent',
//           message: {
//             ...messagePayload.message,
//             isMe: true
//           }
//         }));
//       }

//       // Update chat last message
//       await supabase
//         .from('chats')
//         .update({
//           last_message: text,
//           last_message_time: message.created_at,
//           last_message_sender: userId
//         })
//         .eq('id', chatId);

//     } catch (error) {
//       console.error('Error saving message:', error);
      
//       const senderClient = clients.get(userId);
//       if (senderClient) {
//         senderClient.ws.send(JSON.stringify({
//           type: 'message_failed',
//           chatId,
//           error: 'Failed to send message'
//         }));
//       }
//     }
//   }

//   async handleMarkRead(userId, data) {
//     const { chatId, messageIds } = data;

//     try {
//       // Update messages as read in database
//       const { error } = await supabase
//         .from('messages')
//         .update({ is_read: true })
//         .in('id', messageIds)
//         .eq('recipient_id', userId);

//       if (error) throw error;

//       // Notify sender that messages were read
//       const { data: messages } = await supabase
//         .from('messages')
//         .select('sender_id')
//         .in('id', messageIds)
//         .limit(1);

//       if (messages && messages.length > 0) {
//         const senderId = messages[0].sender_id;
//         const senderClient = clients.get(senderId);
        
//         if (senderClient && senderClient.chatSubscriptions.has(chatId)) {
//           senderClient.ws.send(JSON.stringify({
//             type: 'messages_read',
//             chatId,
//             messageIds
//           }));
//         }
//       }

//     } catch (error) {
//       console.error('Error marking messages as read:', error);
//     }
//   }

//   async handleTyping(userId, data) {
//     const { chatId, isTyping, recipientId } = data;

//     const recipientClient = clients.get(recipientId);
//     if (recipientClient && recipientClient.chatSubscriptions.has(chatId)) {
//       recipientClient.ws.send(JSON.stringify({
//         type: 'typing',
//         chatId,
//         userId,
//         isTyping
//       }));
//     }
//   }

//   async handleGetStatus(userId, ws, data) {
//     const { userIds } = data;
//     const statuses = {};

//     for (const id of userIds) {
//       statuses[id] = userStatus.get(id) || 'offline';
//     }

//     ws.send(JSON.stringify({
//       type: 'status_update',
//       statuses
//     }));
//   }

//   async broadcastStatusUpdate(userId, status) {
//     // Find all chats this user is part of
//     const { data: chats } = await supabase
//       .from('chats')
//       .select('id, user1_id, user2_id')
//       .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

//     if (!chats) return;

//     // For each chat, notify the other participant
//     for (const chat of chats) {
//       const otherUserId = chat.user1_id === userId ? chat.user2_id : chat.user1_id;
//       const otherClient = clients.get(otherUserId);

//       if (otherClient && otherClient.chatSubscriptions.has(chat.id)) {
//         otherClient.ws.send(JSON.stringify({
//           type: 'user_status',
//           userId,
//           status,
//           chatId: chat.id
//         }));
//       }
//     }
//   }

//   async sendChatParticipantsStatus(chatId, requestingUserId) {
//     // Get chat participants
//     const { data: chat } = await supabase
//       .from('chats')
//       .select('user1_id, user2_id')
//       .eq('id', chatId)
//       .single();

//     if (!chat) return;

//     const participants = [chat.user1_id, chat.user2_id];
//     const statuses = {};

//     for (const participantId of participants) {
//       if (participantId !== requestingUserId) {
//         statuses[participantId] = userStatus.get(participantId) || 'offline';
//       }
//     }

//     const client = clients.get(requestingUserId);
//     if (client) {
//       client.ws.send(JSON.stringify({
//         type: 'participants_status',
//         chatId,
//         statuses
//       }));
//     }
//   }

//   // Public method to send notification about new question
//   sendNewQuestionNotification(question) {
//     // Broadcast to all connected users (or specific subscribers)
//     for (const [userId, client] of clients) {
//       if (client.ws.readyState === WebSocket.OPEN) {
//         client.ws.send(JSON.stringify({
//           type: 'new_question',
//           question
//         }));
//       }
//     }
//   }

//   // Public method to send notification about new answer
//   sendNewAnswerNotification(questionId, answer) {
//     // Send to users subscribed to this question
//     if (questionSubscribers.has(questionId)) {
//       const subscribers = questionSubscribers.get(questionId);
//       for (const userId of subscribers) {
//         const client = clients.get(userId);
//         if (client && client.ws.readyState === WebSocket.OPEN) {
//           client.ws.send(JSON.stringify({
//             type: 'new_answer',
//             questionId,
//             answer
//           }));
//         }
//       }
//     }
//   }

//   // Public method to send notification to specific user
//   sendNotification(userId, notification) {
//     const client = clients.get(userId);
//     if (client && client.ws.readyState === WebSocket.OPEN) {
//       client.ws.send(JSON.stringify({
//         type: 'notification',
//         ...notification
//       }));
//     }
//   }

//   // Public method to broadcast to all users in a chat
//   broadcastToChat(chatId, message, excludeUserId = null) {
//     clients.forEach((client, userId) => {
//       if (excludeUserId && userId === excludeUserId) return;
//       if (client.chatSubscriptions.has(chatId)) {
//         client.ws.send(JSON.stringify(message));
//       }
//     });
//   }

//   // Public method to get online status of a user
//   getUserStatus(userId) {
//     return userStatus.get(userId) || 'offline';
//   }
// }

// module.exports = WebSocketServer;




// const WebSocket = require('ws');
// const jwt = require('jsonwebtoken');
// const { createClient } = require('@supabase/supabase-js');

// // Initialize Supabase client
// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_KEY
// );

// // Store active connections
// const clients = new Map(); // userId -> { ws, userId, subscriptions }
// const userStatus = new Map(); // userId -> 'online' | 'offline'

// class WebSocketServer {
//   constructor(server) {
//     this.wss = new WebSocket.Server({ server });
//     this.setupWebSocket();
//   }

//   setupWebSocket() {
//     this.wss.on('connection', async (ws, req) => {
//       try {
//         // Extract token from query string
//         const urlParams = new URLSearchParams(req.url.split('?')[1]);
//         const token = urlParams.get('token');
        
//         if (!token) {
//           ws.close(1008, 'No token provided');
//           return;
//         }

//         // Verify JWT token
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         const userId = decoded.id;

//         // Store client connection
//         clients.set(userId, {
//           ws,
//           userId,
//           subscriptions: new Set(),
//           lastPing: Date.now()
//         });

//         // Update user status
//         userStatus.set(userId, 'online');
        
//         // Broadcast online status to relevant users
//         await this.broadcastStatusUpdate(userId, 'online');

//         console.log(`User ${userId} connected. Total connections: ${clients.size}`);

//         // Send initial connection success
//         ws.send(JSON.stringify({
//           type: 'connection',
//           status: 'connected',
//           userId: userId
//         }));

//         // Handle incoming messages
//         ws.on('message', async (message) => {
//           try {
//             const data = JSON.parse(message);
//             await this.handleMessage(userId, ws, data);
//           } catch (error) {
//             console.error('Error parsing message:', error);
//             ws.send(JSON.stringify({
//               type: 'error',
//               error: 'Invalid message format'
//             }));
//           }
//         });

//         // Handle ping/pong for connection health
//         ws.on('pong', () => {
//           const client = clients.get(userId);
//           if (client) {
//             client.lastPing = Date.now();
//           }
//         });

//         // Handle disconnection
//         ws.on('close', async () => {
//           clients.delete(userId);
//           userStatus.set(userId, 'offline');
//           await this.broadcastStatusUpdate(userId, 'offline');
//           console.log(`User ${userId} disconnected. Total connections: ${clients.size}`);
//         });

//         // Set up ping interval to check connection health
//         const pingInterval = setInterval(() => {
//           const client = clients.get(userId);
//           if (client) {
//             const now = Date.now();
//             if (now - client.lastPing > 30000) { // 30 seconds
//               console.log(`User ${userId} ping timeout, terminating connection`);
//               ws.terminate();
//               clearInterval(pingInterval);
//             } else {
//               ws.ping();
//             }
//           } else {
//             clearInterval(pingInterval);
//           }
//         }, 15000);

//       } catch (error) {
//         console.error('WebSocket connection error:', error);
//         ws.close(1011, 'Authentication failed');
//       }
//     });
//   }

//   async handleMessage(userId, ws, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     switch (data.type) {
//       case 'subscribe':
//         await this.handleSubscribe(userId, data);
//         break;
//       case 'unsubscribe':
//         await this.handleUnsubscribe(userId, data);
//         break;
//       case 'message':
//         await this.handleChatMessage(userId, data);
//         break;
//       case 'mark_read':
//         await this.handleMarkRead(userId, data);
//         break;
//       case 'typing':
//         await this.handleTyping(userId, data);
//         break;
//       case 'get_status':
//         await this.handleGetStatus(userId, ws, data);
//         break;
//       default:
//         ws.send(JSON.stringify({
//           type: 'error',
//           error: 'Unknown message type'
//         }));
//     }
//   }

//   async handleSubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { chatId } = data;
//     client.subscriptions.add(chatId);

//     // Send confirmation
//     client.ws.send(JSON.stringify({
//       type: 'subscribed',
//       chatId
//     }));

//     // Send online status of other participants
//     await this.sendChatParticipantsStatus(chatId, userId);
//   }

//   async handleUnsubscribe(userId, data) {
//     const client = clients.get(userId);
//     if (!client) return;

//     const { chatId } = data;
//     client.subscriptions.delete(chatId);

//     client.ws.send(JSON.stringify({
//       type: 'unsubscribed',
//       chatId
//     }));
//   }

//   async handleChatMessage(userId, data) {
//     const { chatId, recipientId, text, productId } = data;

//     try {
//       // Save message to database
//       const { data: message, error } = await supabase
//         .from('messages')
//         .insert({
//           chat_id: chatId,
//           sender_id: userId,
//           recipient_id: recipientId,
//           text: text,
//           product_id: productId,
//           created_at: new Date().toISOString(),
//           is_read: false
//         })
//         .select(`
//           *,
//           sender:users!sender_id(name, profile_image_url),
//           recipient:users!recipient_id(name, profile_image_url)
//         `)
//         .single();

//       if (error) throw error;

//       // Get sender info
//       const { data: senderData } = await supabase
//         .from('users')
//         .select('name, profile_image_url')
//         .eq('id', userId)
//         .single();

//       // Prepare message payload
//       const messagePayload = {
//         type: 'new_message',
//         message: {
//           id: message.id,
//           chatId,
//           senderId: userId,
//           senderName: senderData?.name || 'User',
//           senderImage: senderData?.profile_image_url,
//           text,
//           timestamp: message.created_at,
//           isRead: false
//         }
//       };

//       // Send to recipient if online
//       const recipientClient = clients.get(recipientId);
//       if (recipientClient && recipientClient.subscriptions.has(chatId)) {
//         recipientClient.ws.send(JSON.stringify(messagePayload));
//       }

//       // Send confirmation to sender
//       const senderClient = clients.get(userId);
//       if (senderClient) {
//         senderClient.ws.send(JSON.stringify({
//           ...messagePayload,
//           type: 'message_sent',
//           message: {
//             ...messagePayload.message,
//             isMe: true
//           }
//         }));
//       }

//       // Update chat last message
//       await supabase
//         .from('chats')
//         .update({
//           last_message: text,
//           last_message_time: message.created_at,
//           last_message_sender: userId
//         })
//         .eq('id', chatId);

//     } catch (error) {
//       console.error('Error saving message:', error);
      
//       const senderClient = clients.get(userId);
//       if (senderClient) {
//         senderClient.ws.send(JSON.stringify({
//           type: 'message_failed',
//           chatId,
//           error: 'Failed to send message'
//         }));
//       }
//     }
//   }

//   async handleMarkRead(userId, data) {
//     const { chatId, messageIds } = data;

//     try {
//       // Update messages as read in database
//       const { error } = await supabase
//         .from('messages')
//         .update({ is_read: true })
//         .in('id', messageIds)
//         .eq('recipient_id', userId);

//       if (error) throw error;

//       // Notify sender that messages were read
//       const { data: messages } = await supabase
//         .from('messages')
//         .select('sender_id')
//         .in('id', messageIds)
//         .limit(1);

//       if (messages && messages.length > 0) {
//         const senderId = messages[0].sender_id;
//         const senderClient = clients.get(senderId);
        
//         if (senderClient && senderClient.subscriptions.has(chatId)) {
//           senderClient.ws.send(JSON.stringify({
//             type: 'messages_read',
//             chatId,
//             messageIds
//           }));
//         }
//       }

//     } catch (error) {
//       console.error('Error marking messages as read:', error);
//     }
//   }

//   async handleTyping(userId, data) {
//     const { chatId, isTyping, recipientId } = data;

//     const recipientClient = clients.get(recipientId);
//     if (recipientClient && recipientClient.subscriptions.has(chatId)) {
//       recipientClient.ws.send(JSON.stringify({
//         type: 'typing',
//         chatId,
//         userId,
//         isTyping
//       }));
//     }
//   }

//   async handleGetStatus(userId, ws, data) {
//     const { userIds } = data;
//     const statuses = {};

//     for (const id of userIds) {
//       statuses[id] = userStatus.get(id) || 'offline';
//     }

//     ws.send(JSON.stringify({
//       type: 'status_update',
//       statuses
//     }));
//   }

//   async broadcastStatusUpdate(userId, status) {
//     // Find all chats this user is part of
//     const { data: chats } = await supabase
//       .from('chats')
//       .select('id, user1_id, user2_id')
//       .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

//     if (!chats) return;

//     // For each chat, notify the other participant
//     for (const chat of chats) {
//       const otherUserId = chat.user1_id === userId ? chat.user2_id : chat.user1_id;
//       const otherClient = clients.get(otherUserId);

//       if (otherClient && otherClient.subscriptions.has(chat.id)) {
//         otherClient.ws.send(JSON.stringify({
//           type: 'user_status',
//           userId,
//           status,
//           chatId: chat.id
//         }));
//       }
//     }
//   }

//   async sendChatParticipantsStatus(chatId, requestingUserId) {
//     // Get chat participants
//     const { data: chat } = await supabase
//       .from('chats')
//       .select('user1_id, user2_id')
//       .eq('id', chatId)
//       .single();

//     if (!chat) return;

//     const participants = [chat.user1_id, chat.user2_id];
//     const statuses = {};

//     for (const participantId of participants) {
//       if (participantId !== requestingUserId) {
//         statuses[participantId] = userStatus.get(participantId) || 'offline';
//       }
//     }

//     const client = clients.get(requestingUserId);
//     if (client) {
//       client.ws.send(JSON.stringify({
//         type: 'participants_status',
//         chatId,
//         statuses
//       }));
//     }
//   }

//   // Public method to get online status of a user
//   getUserStatus(userId) {
//     return userStatus.get(userId) || 'offline';
//   }

//   // Public method to send notification to specific user
//   sendNotification(userId, notification) {
//     const client = clients.get(userId);
//     if (client) {
//       client.ws.send(JSON.stringify({
//         type: 'notification',
//         ...notification
//       }));
//     }
//   }

//   // Public method to broadcast to all users in a chat
//   broadcastToChat(chatId, message, excludeUserId = null) {
//     clients.forEach((client, userId) => {
//       if (excludeUserId && userId === excludeUserId) return;
//       if (client.subscriptions.has(chatId)) {
//         client.ws.send(JSON.stringify(message));
//       }
//     });
//   }
// }

// module.exports = WebSocketServer;
