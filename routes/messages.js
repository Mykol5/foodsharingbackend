import 'package:flutter/material.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:provider/provider.dart';
import 'chat_screen.dart';
import 'providers/auth_provider.dart';
import 'services/api_service.dart';
import 'dart:convert';

class MessagesScreen extends StatefulWidget {
  final String? recipientId;
  final String? recipientName;
  final String? recipientImage;
  final String? productId;
  final String? productName;
  final String? productStatus;
  final int? productQuantity;
  
  const MessagesScreen({
    Key? key,
    this.recipientId,
    this.recipientName,
    this.recipientImage,
    this.productId,
    this.productName,
    this.productStatus,
    this.productQuantity,
  }) : super(key: key);

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  int _selectedTabIndex = 0;
  String _selectedStatusFilter = 'All';
  bool _isLoading = true;
  bool _isRefreshing = false;
  
  List<Map<String, dynamic>> _chats = [];
  List<Map<String, dynamic>> _filteredChats = [];
  
  final ApiService _apiService = ApiService();
  WebSocketChannel? _channel;
  bool _isConnected = false;

  static const String webSocketUrl = 'wss://foodsharingbackend.onrender.com';

  @override
  void initState() {
    super.initState();
    _loadChats();
    _connectWebSocket();
    _checkForDirectMessage();
  }

  void _connectWebSocket() {
    try {
      final authProvider = Provider.of<AuthProvider>(context, listen: false);
      final token = authProvider.token;
      
      if (token == null) {
        print('No token available for WebSocket connection');
        return;
      }
      
      _channel = WebSocketChannel.connect(
        Uri.parse('$webSocketUrl/ws?token=$token'),
      );

      _channel!.stream.listen(
        (message) {
          _handleIncomingNotification(message);
        },
        onError: (error) {
          print('WebSocket error: $error');
          setState(() {
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
      });
    } catch (e) {
      print('Failed to connect WebSocket: $e');
      setState(() {
        _isConnected = false;
      });
    }
  }

  void _handleIncomingNotification(String message) {
    try {
      final data = jsonDecode(message);
      print('📨 Received notification: ${data['type']}');
      
      if (data['type'] == 'new_message') {
        _refreshChats();
        
        // Show notification
        final messageData = data['message'];
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('New message from ${messageData['senderName'] ?? 'someone'}'),
            action: SnackBarAction(
              label: 'View',
              onPressed: () {
                _navigateToChat(
                  chatId: messageData['chatId'],
                  userName: messageData['senderName'] ?? 'User',
                  userImage: messageData['senderImage'] ?? '',
                  itemName: widget.productName ?? 'Produce',
                  productId: widget.productId,
                  productStatus: widget.productStatus,
                  quantity: widget.productQuantity ?? 0,
                  recipientId: messageData['senderId'],
                );
              },
            ),
            backgroundColor: const Color(0xFF29A366),
            duration: const Duration(seconds: 5),
          ),
        );
      } else if (data['type'] == 'message_sent') {
        _refreshChats();
      } else if (data['type'] == 'status_update') {
        _refreshChats();
      }
    } catch (e) {
      print('Error handling notification: $e');
    }
  }

  Future<void> _loadChats() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final result = await _apiService.getUserChats();
      print('📥 Chats response: $result');
      
      if (result['success'] == true) {
        final chats = result['chats'] ?? [];
        
        setState(() {
          _chats = chats.map((chat) {
            final otherUser = chat['otherUser'] ?? {};
            final product = chat['product'] ?? {};
            
            return {
              'id': chat['id'],
              'userName': otherUser['name'] ?? 'User',
              'userImage': otherUser['profile_image_url'] ?? '',
              'userId': otherUser['id'],
              'lastMessage': chat['lastMessage'] ?? 'No messages yet',
              'lastMessageTime': chat['lastMessageTime'],
              'unreadCount': chat['unreadCount'] ?? 0,
              'productName': product['name'] ?? 'Produce',
              'productImage': product['image_url'] ?? '',
              'status': chat['status'] ?? 'active',
              'productId': product['id'],
            };
          }).toList();
          
          _applyFilters();
        });
      } else {
        print('Failed to load chats: ${result['error']}');
      }
    } catch (e) {
      print('Error loading chats: $e');
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _refreshChats() async {
    if (_isRefreshing) return;

    setState(() {
      _isRefreshing = true;
    });

    try {
      final result = await _apiService.getUserChats();
      if (result['success'] == true) {
        final chats = result['chats'] ?? [];
        
        setState(() {
          _chats = chats.map((chat) {
            final otherUser = chat['otherUser'] ?? {};
            final product = chat['product'] ?? {};
            
            return {
              'id': chat['id'],
              'userName': otherUser['name'] ?? 'User',
              'userImage': otherUser['profile_image_url'] ?? '',
              'userId': otherUser['id'],
              'lastMessage': chat['lastMessage'] ?? 'No messages yet',
              'lastMessageTime': chat['lastMessageTime'],
              'unreadCount': chat['unreadCount'] ?? 0,
              'productName': product['name'] ?? 'Produce',
              'productImage': product['image_url'] ?? '',
              'status': chat['status'] ?? 'active',
              'productId': product['id'],
            };
          }).toList();
          
          _applyFilters();
        });
      }
    } catch (e) {
      print('Error refreshing chats: $e');
    } finally {
      setState(() {
        _isRefreshing = false;
      });
    }
  }

  void _applyFilters() {
    List<Map<String, dynamic>> filtered = List.from(_chats);
    
    // Apply status filter
    if (_selectedStatusFilter != 'All') {
      filtered = filtered.where((chat) => 
        chat['status'] == _selectedStatusFilter
      ).toList();
    }
    
    // Apply tab filter (Buying/Selling - based on product ownership)
    if (_selectedTabIndex == 1) { // Buying (I am the recipient)
      // In a real app, you'd filter based on whether current user is buyer
      filtered = filtered.toList();
    } else if (_selectedTabIndex == 2) { // Selling (I am the seller)
      filtered = filtered.toList();
    }
    
    setState(() {
      _filteredChats = filtered;
    });
  }

  Future<void> _checkForDirectMessage() async {
    if (widget.recipientId != null && widget.recipientName != null) {
      await Future.delayed(const Duration(milliseconds: 100));
      
      if (mounted) {
        await _navigateToChat(
          recipientId: widget.recipientId!,
          userName: widget.recipientName!,
          userImage: widget.recipientImage ?? '',
          itemName: widget.productName ?? 'Produce',
          productId: widget.productId,
          productStatus: widget.productStatus,
          quantity: widget.productQuantity ?? 0,
        );
      }
    }
  }

  Future<void> _navigateToChat({
    String? chatId,
    required String userName,
    String userImage = '',
    required String itemName,
    String? recipientId,
    String? productId,
    String? productStatus,
    int quantity = 0,
  }) async {
    String targetChatId = chatId ?? '';
    
    if (targetChatId.isEmpty && recipientId != null) {
      try {
        final result = await _apiService.createOrGetChat(
          recipientId: recipientId,
          productId: productId,
        );
        
        if (result['success'] == true) {
          targetChatId = result['chat']['id'];
        } else {
          throw Exception(result['error'] ?? 'Failed to create chat');
        }
      } catch (e) {
        print('Error creating chat: $e');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Failed to start chat: $e'),
              backgroundColor: Colors.red,
            ),
          );
        }
        return;
      }
    }
    
    if (targetChatId.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Cannot start chat: Missing chat information'),
            backgroundColor: Colors.orange,
          ),
        );
      }
      return;
    }
    
    if (mounted) {
      await Navigator.push(
        context,
        MaterialPageRoute(
          builder: (context) => ChatScreen(
            itemName: itemName,
            userName: userName,
            userImage: userImage,
            productId: productId,
            productStatus: productStatus,
            quantity: quantity,
            recipientId: recipientId ?? '',
            chatId: targetChatId,
          ),
        ),
      );
      
      _refreshChats();
    }
  }

  int _getUnreadCount() {
    int count = 0;
    for (var chat in _chats) {
      count += chat['unreadCount'] as int;
    }
    return count;
  }

  String _formatTime(String? timestamp) {
    if (timestamp == null) return '';
    try {
      final time = DateTime.parse(timestamp);
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
    } catch (e) {
      return '';
    }
  }

  void _showSearchDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Search Messages'),
        content: TextField(
          decoration: const InputDecoration(
            hintText: 'Search by name or product...',
            border: OutlineInputBorder(),
          ),
          onChanged: (value) {
            // Implement search functionality
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF29A366),
            ),
            child: const Text('Search'),
          ),
        ],
      ),
    );
  }

  void _showNewMessageDialog(BuildContext context) {
    // Navigate to users list or product list to start a new conversation
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Browse products to start a new conversation'),
        backgroundColor: Color(0xFF29A366),
      ),
    );
  }

  @override
  void dispose() {
    _channel?.sink.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDarkMode = Theme.of(context).brightness == Brightness.dark;
    final unreadCount = _getUnreadCount();
    
    return Scaffold(
      backgroundColor: isDarkMode ? const Color(0xFF18251B) : const Color(0xFFFAFAF9),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showNewMessageDialog(context),
        backgroundColor: const Color(0xFF29A366),
        child: const Icon(Icons.edit, color: Colors.white),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.endFloat,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _refreshChats,
          color: const Color(0xFF29A366),
          child: Column(
            children: [
              // Top App Bar
              Container(
                padding: const EdgeInsets.only(
                  top: 16,
                  left: 24,
                  right: 24,
                  bottom: 16,
                ),
                decoration: BoxDecoration(
                  color: isDarkMode 
                      ? const Color(0xFF18251B).withOpacity(0.8)
                      : const Color(0xFFFAFAF9).withOpacity(0.8),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        IconButton(
                          onPressed: () => Navigator.pop(context),
                          icon: Icon(
                            Icons.arrow_back_ios_new,
                            color: const Color(0xFF29A366),
                            size: 20,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Messages',
                              style: TextStyle(
                                fontSize: 32,
                                fontWeight: FontWeight.bold,
                                color: isDarkMode ? Colors.white : const Color(0xFF101914),
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _isLoading 
                                  ? 'Loading...'
                                  : '$unreadCount unread · ${_filteredChats.length} chats',
                              style: const TextStyle(
                                fontSize: 14,
                                color: Color(0xFF578E73),
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                    
                    // Connection indicator
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: _isConnected ? Colors.green : Colors.red,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ],
                ),
              ),

              // Tabs for Buying/Selling
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: isDarkMode ? const Color(0xFF253529) : const Color(0xFFF0F4F2),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      _buildTabButton('All', 0, isDarkMode),
                      _buildTabButton('Buying', 1, isDarkMode),
                      _buildTabButton('Selling', 2, isDarkMode),
                    ],
                  ),
                ),
              ),

              // Status Filter Chips
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      _buildStatusFilterChip('All', isDarkMode),
                      const SizedBox(width: 8),
                      _buildStatusFilterChip('In Progress', isDarkMode),
                      const SizedBox(width: 8),
                      _buildStatusFilterChip('Claimed', isDarkMode),
                      const SizedBox(width: 8),
                      _buildStatusFilterChip('Completed', isDarkMode),
                    ],
                  ),
                ),
              ),

              // Chat List
              Expanded(
                child: _isLoading
                    ? const Center(child: CircularProgressIndicator(color: Color(0xFF29A366)))
                    : _filteredChats.isEmpty
                        ? _buildEmptyState(isDarkMode)
                        : ListView.builder(
                            padding: const EdgeInsets.all(16),
                            itemCount: _filteredChats.length,
                            itemBuilder: (context, index) {
                              final chat = _filteredChats[index];
                              return _buildChatCard(chat, isDarkMode);
                            },
                          ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusFilterChip(String label, bool isDarkMode) {
    final isSelected = _selectedStatusFilter == label;
    
    return FilterChip(
      label: Text(label),
      selected: isSelected,
      onSelected: (selected) {
        setState(() {
          _selectedStatusFilter = label;
          _applyFilters();
        });
      },
      backgroundColor: isDarkMode ? const Color(0xFF253529) : const Color(0xFFF0F4F2),
      selectedColor: const Color(0xFF29A366),
      labelStyle: TextStyle(
        color: isSelected ? Colors.white : const Color(0xFF578E73),
        fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
      ),
    );
  }

  Widget _buildTabButton(String label, int index, bool isDarkMode) {
    final isSelected = _selectedTabIndex == index;
    
    return Expanded(
      child: GestureDetector(
        onTap: () {
          setState(() {
            _selectedTabIndex = index;
            _applyFilters();
          });
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            color: isSelected
                ? (isDarkMode ? const Color(0xFF101914) : Colors.white)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 14,
                fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                color: isSelected
                    ? const Color(0xFF29A366)
                    : const Color(0xFF578E73),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildChatCard(Map<String, dynamic> chat, bool isDarkMode) {
    final hasUnread = chat['unreadCount'] > 0;
    final timeAgo = _formatTime(chat['lastMessageTime']);
    
    return GestureDetector(
      onTap: () => _navigateToChat(
        chatId: chat['id'],
        userName: chat['userName'],
        userImage: chat['userImage'],
        itemName: chat['productName'],
        productId: chat['productId'],
        recipientId: chat['userId'],
        productStatus: chat['status'],
      ),
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: isDarkMode ? Colors.white.withOpacity(0.05) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: hasUnread 
                ? const Color(0xFF29A366).withOpacity(0.3)
                : Colors.black.withOpacity(0.05),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.03),
              blurRadius: 4,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            // User Avatar
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: hasUnread ? const Color(0xFF29A366) : Colors.transparent,
                  width: 2,
                ),
              ),
              child: CircleAvatar(
                radius: 26,
                backgroundImage: chat['userImage'].isNotEmpty
                    ? NetworkImage(chat['userImage'])
                    : null,
                backgroundColor: const Color(0xFF29A366).withOpacity(0.1),
                child: chat['userImage'].isEmpty
                    ? Text(
                        chat['userName'][0].toUpperCase(),
                        style: const TextStyle(
                          color: Color(0xFF29A366),
                          fontWeight: FontWeight.bold,
                          fontSize: 18,
                        ),
                      )
                    : null,
              ),
            ),
            const SizedBox(width: 12),
            
            // Chat Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          chat['userName'],
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: hasUnread ? FontWeight.bold : FontWeight.w600,
                            color: isDarkMode ? Colors.white : const Color(0xFF101914),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Text(
                        timeAgo,
                        style: TextStyle(
                          fontSize: 11,
                          color: hasUnread ? const Color(0xFF29A366) : const Color(0xFF578E73),
                          fontWeight: hasUnread ? FontWeight.bold : FontWeight.normal,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    chat['productName'],
                    style: TextStyle(
                      fontSize: 12,
                      color: const Color(0xFF29A366),
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          chat['lastMessage'],
                          style: TextStyle(
                            fontSize: 13,
                            color: hasUnread 
                                ? (isDarkMode ? Colors.white : const Color(0xFF101914))
                                : const Color(0xFF578E73),
                            fontWeight: hasUnread ? FontWeight.w500 : FontWeight.normal,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (hasUnread)
                        Container(
                          margin: const EdgeInsets.only(left: 8),
                          padding: const EdgeInsets.all(4),
                          decoration: const BoxDecoration(
                            color: Color(0xFF29A366),
                            shape: BoxShape.circle,
                          ),
                          constraints: const BoxConstraints(
                            minWidth: 20,
                            minHeight: 20,
                          ),
                          child: Center(
                            child: Text(
                              '${chat['unreadCount']}',
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEmptyState(bool isDarkMode) {
    return Center(
      child: SingleChildScrollView(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 80,
              color: const Color(0xFF29A366).withOpacity(0.3),
            ),
            const SizedBox(height: 16),
            Text(
              'No messages yet',
              style: TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.bold,
                color: isDarkMode ? Colors.white : const Color(0xFF101914),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _selectedStatusFilter == 'All'
                  ? 'Start a conversation by claiming some produce!'
                  : 'No ${_selectedStatusFilter.toLowerCase()} messages',
              style: TextStyle(
                fontSize: 14,
                color: isDarkMode ? Colors.white70 : const Color(0xFF5C8A7A),
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: () {
                Navigator.pop(context);
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF29A366),
                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: const Text(
                'Find Produce to Share',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}




// const express = require('express');
// const router = express.Router();
// const supabase = require('../supabase');
// const { authenticateToken } = require('../middleware/auth');

// // Send a new message
// router.post('/', authenticateToken, async (req, res) => {
//   try {
//     const senderId = req.user.id;
//     const { chatId, recipientId, text, productId } = req.body;

//     if (!text || !recipientId) {
//       return res.status(400).json({
//         success: false,
//         error: 'Missing required fields'
//       });
//     }

//     // Get or create chat
//     let chatIdToUse = chatId;
    
//     if (!chatId) {
//       const { data: existingChat } = await supabase
//         .from('chats')
//         .select('id')
//         .or(`and(user1_id.eq.${senderId},user2_id.eq.${recipientId}),and(user1_id.eq.${recipientId},user2_id.eq.${senderId})`)
//         .maybeSingle();

//       if (existingChat) {
//         chatIdToUse = existingChat.id;
//       } else {
//         const { data: newChat, error: chatError } = await supabase
//           .from('chats')
//           .insert({
//             user1_id: senderId,
//             user2_id: recipientId,
//             product_id: productId || null
//           })
//           .select()
//           .single();

//         if (chatError) throw chatError;
//         chatIdToUse = newChat.id;
//       }
//     }

//     // Save message
//     const { data: message, error } = await supabase
//       .from('messages')
//       .insert({
//         chat_id: chatIdToUse,
//         sender_id: senderId,
//         recipient_id: recipientId,
//         text: text,
//         product_id: productId || null,
//         created_at: new Date().toISOString()
//       })
//       .select(`
//         *,
//         sender:users!sender_id(name, profile_image_url),
//         recipient:users!recipient_id(name, profile_image_url)
//       `)
//       .single();

//     if (error) throw error;

//     // Update chat's last message
//     await supabase
//       .from('chats')
//       .update({
//         last_message: text,
//         last_message_time: message.created_at,
//         last_message_sender: senderId,
//         updated_at: new Date().toISOString()
//       })
//       .eq('id', chatIdToUse);

//     // Get WebSocket server instance
//     const wsServer = req.app.get('wsServer');
    
//     // Prepare message payload
//     const messagePayload = {
//       type: 'new_message',
//       message: {
//         id: message.id,
//         chatId: chatIdToUse,
//         senderId,
//         senderName: message.sender.name,
//         senderImage: message.sender.profile_image_url,
//         text,
//         timestamp: message.created_at,
//         isRead: false
//       }
//     };

//     // Send to recipient via WebSocket
//     wsServer.sendNotification(recipientId, messagePayload);

//     res.status(201).json({
//       success: true,
//       message: 'Message sent successfully',
//       data: {
//         message,
//         chatId: chatIdToUse
//       }
//     });

//   } catch (error) {
//     console.error('Send message error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to send message' 
//     });
//   }
// });

// // Get message by ID
// router.get('/:messageId', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { messageId } = req.params;

//     const { data: message, error } = await supabase
//       .from('messages')
//       .select(`
//         *,
//         sender:users!sender_id(name, profile_image_url),
//         recipient:users!recipient_id(name, profile_image_url)
//       `)
//       .eq('id', messageId)
//       .single();

//     if (error) throw error;

//     // Check if user is part of this message
//     if (message.sender_id !== userId && message.recipient_id !== userId) {
//       return res.status(403).json({
//         success: false,
//         error: 'Access denied'
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message
//     });

//   } catch (error) {
//     console.error('Get message error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch message' 
//     });
//   }
// });

// // Delete message
// router.delete('/:messageId', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const { messageId } = req.params;

//     const { error } = await supabase
//       .from('messages')
//       .delete()
//       .eq('id', messageId)
//       .eq('sender_id', userId);

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       message: 'Message deleted successfully'
//     });

//   } catch (error) {
//     console.error('Delete message error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to delete message' 
//     });
//   }
// });

// module.exports = router;
