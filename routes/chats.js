import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:provider/provider.dart';
import 'providers/auth_provider.dart';
import 'services/api_service.dart';

class ChatScreen extends StatefulWidget {
  final String itemName;
  final String userName;
  final String userImage;
  final String? productId;
  final String? productStatus;
  final int quantity;
  final String recipientId;
  final String chatId;
  
  const ChatScreen({
    Key? key,
    required this.itemName,
    required this.userName,
    required this.userImage,
    this.productId,
    this.productStatus,
    this.quantity = 0,
    required this.recipientId,
    required this.chatId,
  }) : super(key: key);

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  WebSocketChannel? _channel;
  final ApiService _apiService = ApiService();
  
  List<Map<String, dynamic>> _messages = [];
  bool _isLoading = true;
  bool _isConnected = false;
  String? _connectionError;
  
  static const String webSocketUrl = 'wss://foodsharingbackend.onrender.com';

  @override
  void initState() {
    super.initState();
    _connectWebSocket();
    _loadMessages();
  }

  void _connectWebSocket() {
    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;
      
      if (token == null) {
        setState(() {
          _connectionError = 'Not authenticated';
          _isConnected = false;
        });
        return;
      }
      
      _channel = WebSocketChannel.connect(
        Uri.parse('$webSocketUrl/ws?token=$token'),
      );

      _channel!.stream.listen(
        (message) {
          print('📨 WebSocket message received: $message');
          final data = jsonDecode(message);
          _handleIncomingMessage(data);
        },
        onError: (error) {
          print('WebSocket error: $error');
          setState(() {
            _connectionError = 'Connection error: $error';
            _isConnected = false;
          });
        },
        onDone: () {
          setState(() {
            _isConnected = false;
          });
          Future.delayed(const Duration(seconds: 3), () {
            if (mounted) _connectWebSocket();
          });
        },
      );

      setState(() {
        _isConnected = true;
        _connectionError = null;
      });
      
      // Subscribe to the chat
      _channel!.sink.add(jsonEncode({
        'type': 'subscribe',
        'chatId': widget.chatId,
      }));
      
    } catch (e) {
      print('Failed to connect WebSocket: $e');
      setState(() {
        _connectionError = 'Failed to connect: $e';
        _isConnected = false;
      });
    }
  }

  Future<void> _loadMessages() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final result = await _apiService.getChatMessages(widget.chatId);
      print('📥 Messages response: $result');
      
      if (result['success'] == true) {
        final messages = result['messages'] ?? [];
        final authProvider = Provider.of<AuthProvider>(context, listen: false);
        final currentUserId = authProvider.userId;
        
        setState(() {
          _messages = messages.map((msg) {
            final timestamp = DateTime.tryParse(msg['created_at'] ?? msg['timestamp'] ?? DateTime.now().toIso8601String());
            
            return {
              'id': msg['id'],
              'text': msg['text'],
              'isMe': msg['sender_id'] == currentUserId,
              'time': _formatTime(timestamp ?? DateTime.now()),
              'userName': msg['sender']?['name'] ?? 
                          (msg['sender_id'] == currentUserId ? 'You' : widget.userName),
              'userImage': msg['sender']?['profile_image_url'] ?? 
                          (msg['sender_id'] == currentUserId ? '' : widget.userImage),
              'isRead': msg['is_read'] ?? false,
              'isSending': false,
              'isFailed': false,
            };
          }).toList();
        });
        
        _scrollToBottom();
      }
    } catch (e) {
      print('Error loading messages: $e');
      if (_messages.isEmpty) {
        setState(() {
          _messages.add({
            'id': 'welcome',
            'text': 'Start a conversation with ${widget.userName} about ${widget.itemName}!',
            'isMe': false,
            'time': _formatTime(DateTime.now()),
            'userName': 'System',
            'userImage': '',
            'isRead': true,
            'isSending': false,
            'isFailed': false,
          });
        });
      }
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _handleIncomingMessage(Map<String, dynamic> data) {
    print('📨 Handling incoming message: ${data['type']}');
    
    if (data['type'] == 'new_message') {
      final messageData = data['message'];
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final currentUserId = authProvider.userId;
      
      // Check if message already exists (prevent duplicates)
      final bool exists = _messages.any((m) => m['id'] == messageData['id']);
      
      if (!exists && messageData['senderId'] != currentUserId) {
        setState(() {
          _messages.add({
            'id': messageData['id'],
            'text': messageData['text'],
            'isMe': false,
            'time': _formatTime(DateTime.parse(messageData['timestamp'])),
            'userName': messageData['senderName'] ?? widget.userName,
            'userImage': messageData['senderImage'] ?? widget.userImage,
            'isRead': false,
            'isSending': false,
            'isFailed': false,
          });
        });
        
        _scrollToBottom();
        
        // Mark as read
        _markAsRead(messageData['id']);
      }
    } 
    else if (data['type'] == 'message_sent') {
      // This is the confirmation for a message we sent
      final messageData = data['message'];
      print('✅ Message sent confirmation: ${messageData['id']}');
      
      setState(() {
        final index = _messages.indexWhere((m) => m['id'] == messageData['id'] || m['tempId'] == messageData['id']);
        if (index != -1) {
          _messages[index]['isSending'] = false;
          _messages[index]['id'] = messageData['id'];
          _messages[index]['time'] = _formatTime(DateTime.parse(messageData['timestamp']));
          _messages[index]['isFailed'] = false;
        }
      });
    }
    else if (data['type'] == 'messages_read') {
      final messageIds = data['messageIds'] as List;
      setState(() {
        for (var message in _messages) {
          if (messageIds.contains(message['id'])) {
            message['isRead'] = true;
          }
        }
      });
    }
    else if (data['type'] == 'message_failed') {
      final chatId = data['chatId'];
      print('❌ Message failed to send');
      
      setState(() {
        // Find the last unsent message
        for (var message in _messages.reversed) {
          if (message['isSending'] == true) {
            message['isSending'] = false;
            message['isFailed'] = true;
            break;
          }
        }
      });
    }
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      Future.delayed(const Duration(milliseconds: 100), () {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            _scrollController.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        }
      });
    }
  }

  void _markAsRead(String messageId) {
    if (_channel != null && _isConnected) {
      _channel!.sink.add(jsonEncode({
        'type': 'mark_read',
        'chatId': widget.chatId,
        'messageIds': [messageId],
      }));
    }
  }

  Future<void> _sendMessage() async {
    if (_messageController.text.trim().isEmpty) return;

    final authProvider = Provider.of<AuthProvider>(context, listen: false);
    final currentUser = authProvider.currentUser;
    final currentUserId = authProvider.userId;
    
    final messageText = _messageController.text.trim();
    _messageController.clear();

    // Create temporary ID
    final tempId = 'temp_${DateTime.now().millisecondsSinceEpoch}';
    
    // Add message optimistically
    final tempMessage = {
      'id': tempId,
      'tempId': tempId,
      'text': messageText,
      'isMe': true,
      'time': 'Sending...',
      'userName': currentUser?['name'] ?? 'You',
      'userImage': currentUser?['profile_image_url'] ?? '',
      'isRead': false,
      'isSending': true,
      'isFailed': false,
    };

    setState(() {
      _messages.add(tempMessage);
    });
    _scrollToBottom();

    try {
      // Send via WebSocket
      if (_channel != null && _isConnected) {
        _channel!.sink.add(jsonEncode({
          'type': 'message',
          'chatId': widget.chatId,
          'recipientId': widget.recipientId,
          'text': messageText,
          'productId': widget.productId,
        }));
        
        // The message will be confirmed via 'message_sent' event
        print('📤 Message sent via WebSocket: $tempId');
      } else {
        // Fallback to API if WebSocket is not connected
        print('⚠️ WebSocket not connected, using API fallback');
        final result = await _apiService.sendMessage(
          chatId: widget.chatId,
          recipientId: widget.recipientId,
          text: messageText,
          productId: widget.productId,
        );
        
        if (result['success'] == true) {
          setState(() {
            final index = _messages.indexWhere((m) => m['id'] == tempId);
            if (index != -1) {
              _messages[index]['id'] = result['data']['message']['id'];
              _messages[index]['isSending'] = false;
              _messages[index]['time'] = _formatTime(DateTime.now());
            }
          });
        } else {
          throw Exception(result['error']);
        }
      }
    } catch (e) {
      print('Error sending message: $e');
      setState(() {
        final index = _messages.indexWhere((m) => m['id'] == tempId);
        if (index != -1) {
          _messages[index]['isSending'] = false;
          _messages[index]['isFailed'] = true;
          _messages[index]['time'] = 'Failed';
        }
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to send message: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  String _formatTime(DateTime time) {
    final now = DateTime.now();
    final difference = now.difference(time);

    if (difference.inMinutes < 1) {
      return 'Just now';
    } else if (difference.inHours < 1) {
      return '${difference.inMinutes}m ago';
    } else if (difference.inDays < 1) {
      return '${time.hour}:${time.minute.toString().padLeft(2, '0')}';
    } else if (difference.inDays == 1) {
      return 'Yesterday';
    } else if (difference.inDays < 7) {
      return '${time.day}/${time.month}';
    } else {
      return '${time.day}/${time.month}/${time.year}';
    }
  }

  Color _getStatusColor() {
    switch(widget.productStatus) {
      case 'In Progress':
        return const Color(0xFFFFC300);
      case 'Claimed':
        return const Color(0xFF29A366);
      case 'Completed':
        return const Color(0xFF668799);
      default:
        return const Color(0xFF29A366);
    }
  }

  @override
  void dispose() {
    _messageController.dispose();
    _scrollController.dispose();
    if (_channel != null) {
      if (_isConnected) {
        _channel!.sink.add(jsonEncode({
          'type': 'unsubscribe',
          'chatId': widget.chatId,
        }));
      }
      _channel!.sink.close();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final statusColor = _getStatusColor();
    
    return Scaffold(
      backgroundColor: isDarkMode ? const Color(0xFF201712) : const Color(0xFFF6F5F3),
      body: SafeArea(
        child: Column(
          children: [
            // Top Navigation Bar
            Container(
              padding: EdgeInsets.only(
                top: MediaQuery.of(context).padding.top + 8,
                left: 8,
                right: 16,
                bottom: 12,
              ),
              decoration: BoxDecoration(
                color: isDarkMode 
                    ? const Color(0xFF201712).withOpacity(0.95)
                    : const Color(0xFFF6F5F3).withOpacity(0.95),
                border: Border(
                  bottom: BorderSide(
                    color: Colors.black.withOpacity(0.05),
                  ),
                ),
              ),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: Icon(
                      Icons.arrow_back_ios,
                      color: isDarkMode ? Colors.white : const Color(0xFF3D2B1F),
                      size: 20,
                    ),
                  ),
                  const SizedBox(width: 8),
                  CircleAvatar(
                    radius: 20,
                    backgroundImage: widget.userImage.isNotEmpty
                        ? NetworkImage(widget.userImage)
                        : null,
                    backgroundColor: statusColor.withOpacity(0.1),
                    child: widget.userImage.isEmpty
                        ? Text(
                            widget.userName[0].toUpperCase(),
                            style: TextStyle(
                              color: statusColor,
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                            ),
                          )
                        : null,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.userName,
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: isDarkMode ? Colors.white : const Color(0xFF3D2B1F),
                          ),
                        ),
                        Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: _isConnected ? Colors.green : Colors.red,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              _isConnected ? 'Online' : 'Offline',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w500,
                                color: _isConnected ? Colors.green : Colors.red,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: statusColor,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      widget.quantity > 0 
                          ? '${widget.quantity} left'
                          : 'Claimed',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            // Connection Error Banner
            if (_connectionError != null)
              Container(
                margin: const EdgeInsets.all(16),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.red.withOpacity(0.3)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_outline, color: Colors.red, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _connectionError!,
                        style: const TextStyle(color: Colors.red, fontSize: 12),
                      ),
                    ),
                    TextButton(
                      onPressed: _connectWebSocket,
                      child: const Text(
                        'Reconnect',
                        style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ],
                ),
              ),

            // Chat Messages
            Expanded(
              child: _isLoading
                  ? const Center(child: CircularProgressIndicator(color: Color(0xFF29A366)))
                  : _messages.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.chat_bubble_outline,
                                size: 64,
                                color: statusColor.withOpacity(0.3),
                              ),
                              const SizedBox(height: 16),
                              Text(
                                'No messages yet',
                                style: TextStyle(
                                  fontSize: 16,
                                  color: isDarkMode ? Colors.white70 : const Color(0xFF5C8A7A),
                                ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                'Start a conversation with ${widget.userName}',
                                style: TextStyle(
                                  fontSize: 14,
                                  color: isDarkMode ? Colors.white38 : const Color(0xFF808080),
                                ),
                              ),
                            ],
                          ),
                        )
                      : ListView.builder(
                          controller: _scrollController,
                          padding: const EdgeInsets.all(16),
                          itemCount: _messages.length,
                          itemBuilder: (context, index) {
                            final message = _messages[index];
                            return _buildMessageBubble(message, isDarkMode, statusColor);
                          },
                        ),
            ),

            // Message Input
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: isDarkMode ? const Color(0xFF201712) : const Color(0xFFF6F5F3),
                border: Border(
                  top: BorderSide(
                    color: isDarkMode 
                        ? Colors.white.withOpacity(0.1) 
                        : Colors.black.withOpacity(0.1),
                  ),
                ),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      decoration: BoxDecoration(
                        color: isDarkMode ? const Color(0xFF333333) : Colors.white,
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(
                          color: statusColor.withOpacity(0.3),
                        ),
                      ),
                      child: TextField(
                        controller: _messageController,
                        decoration: InputDecoration(
                          hintText: 'Type a message...',
                          hintStyle: TextStyle(
                            color: (isDarkMode ? Colors.white : const Color(0xFF3D2B1F)).withOpacity(0.3),
                            fontSize: 14,
                          ),
                          border: InputBorder.none,
                        ),
                        style: TextStyle(
                          color: isDarkMode ? Colors.white : const Color(0xFF3D2B1F),
                          fontSize: 14,
                        ),
                        onSubmitted: (_) => _sendMessage(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: _messageController.text.isEmpty 
                          ? statusColor.withOpacity(0.5)
                          : statusColor,
                      shape: BoxShape.circle,
                    ),
                    child: IconButton(
                      onPressed: _messageController.text.isEmpty ? null : _sendMessage,
                      icon: Icon(
                        Icons.send,
                        color: Colors.white,
                        size: 20,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageBubble(Map<String, dynamic> message, bool isDarkMode, Color statusColor) {
    final isMe = message['isMe'] == true;
    final isSending = message['isSending'] == true;
    final isFailed = message['isFailed'] == true;
    
    return Container(
      margin: EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        children: [
          if (!isMe)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: CircleAvatar(
                radius: 18,
                backgroundImage: message['userImage'] != null && message['userImage'].isNotEmpty
                    ? NetworkImage(message['userImage'])
                    : null,
                backgroundColor: statusColor.withOpacity(0.1),
                child: message['userImage'] == null || message['userImage'].isEmpty
                    ? Text(
                        message['userName'][0].toUpperCase(),
                        style: TextStyle(
                          color: statusColor,
                          fontWeight: FontWeight.bold,
                          fontSize: 14,
                        ),
                      )
                    : null,
              ),
            ),
          
          Flexible(
            child: Column(
              crossAxisAlignment: isMe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              children: [
                if (!isMe)
                  Padding(
                    padding: const EdgeInsets.only(left: 8, bottom: 4),
                    child: Text(
                      message['userName'] ?? 'User',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: statusColor,
                      ),
                    ),
                  ),
                
                Container(
                  constraints: BoxConstraints(
                    maxWidth: MediaQuery.of(context).size.width * 0.7,
                  ),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: isMe
                        ? (isDarkMode ? const Color(0xFF333333) : const Color(0xFFC4D3BB))
                        : statusColor,
                    borderRadius: BorderRadius.only(
                      topLeft: const Radius.circular(12),
                      topRight: const Radius.circular(12),
                      bottomLeft: isMe ? const Radius.circular(12) : const Radius.circular(0),
                      bottomRight: isMe ? const Radius.circular(0) : const Radius.circular(12),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        message['text'],
                        style: TextStyle(
                          fontSize: 14,
                          color: isMe
                              ? (isDarkMode ? Colors.white : const Color(0xFF3D2B1F))
                              : Colors.white,
                          height: 1.4,
                        ),
                      ),
                      if (isSending || isFailed)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (isSending)
                                const SizedBox(
                                  width: 12,
                                  height: 12,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white70,
                                  ),
                                ),
                              if (isFailed)
                                const Icon(
                                  Icons.error_outline,
                                  color: Colors.red,
                                  size: 12,
                                ),
                              const SizedBox(width: 4),
                              Text(
                                isSending ? 'Sending...' : 'Failed',
                                style: TextStyle(
                                  fontSize: 10,
                                  color: isMe
                                      ? (isDarkMode ? Colors.white70 : Colors.black54)
                                      : Colors.white70,
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                
                if (isMe && message['isRead'] == true && !isSending && !isFailed)
                  Padding(
                    padding: const EdgeInsets.only(right: 8, top: 4),
                    child: Text(
                      'Read',
                      style: TextStyle(
                        fontSize: 10,
                        color: (isDarkMode ? Colors.white : const Color(0xFF3D2B1F)).withOpacity(0.4),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          
          if (isMe)
            Padding(
              padding: const EdgeInsets.only(left: 8),
              child: CircleAvatar(
                radius: 18,
                backgroundImage: message['userImage'] != null && message['userImage'].isNotEmpty
                    ? NetworkImage(message['userImage'])
                    : null,
                backgroundColor: statusColor.withOpacity(0.1),
                child: message['userImage'] == null || message['userImage'].isEmpty
                    ? const Icon(Icons.person, size: 16, color: Color(0xFF29A366))
                    : null,
              ),
            ),
        ],
      ),
    );
  }
}






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
