const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Create a new product request
router.post('/products/:productId/request', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const requesterId = req.user.id;
    const { quantity, message } = req.body;

    if (!quantity || quantity < 1 || quantity > 3) {
      return res.status(400).json({
        success: false,
        error: 'Quantity must be between 1 and 3'
      });
    }

    // Get product details and owner
    const { data: product, error: productError } = await supabase
      .from('shared_items')
      .select('id, name, quantity, quantity_unit, user_id, status, image_url')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    if (product.user_id === requesterId) {
      return res.status(400).json({
        success: false,
        error: 'You cannot request your own product'
      });
    }

    if (product.quantity < quantity) {
      return res.status(400).json({
        success: false,
        error: 'Not enough quantity available'
      });
    }

    // Check if user already has a pending request for this product
    const { data: existingRequest, error: existingError } = await supabase
      .from('product_requests')
      .select('id, status')
      .eq('product_id', productId)
      .eq('requester_id', requesterId)
      .in('status', ['pending', 'accepted'])
      .maybeSingle();

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        error: `You already have a ${existingRequest.status} request for this product`
      });
    }

    // Create the request
    const { data: request, error: requestError } = await supabase
      .from('product_requests')
      .insert({
        product_id: productId,
        requester_id: requesterId,
        owner_id: product.user_id,
        quantity: quantity,
        status: 'pending',
        message: message || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (requestError) throw requestError;

    // Get or create chat for this request
    let chatId;
    const { data: existingChat } = await supabase
      .from('chats')
      .select('id')
      .or(`and(user1_id.eq.${requesterId},user2_id.eq.${product.user_id}),and(user1_id.eq.${product.user_id},user2_id.eq.${requesterId})`)
      .maybeSingle();

    if (existingChat) {
      chatId = existingChat.id;
    } else {
      const { data: newChat, error: chatError } = await supabase
        .from('chats')
        .insert({
          user1_id: requesterId,
          user2_id: product.user_id,
          product_id: productId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (chatError) throw chatError;
      chatId = newChat.id;
    }

    // Send a system message in the chat about the request
    const requestMessage = `📦 **NEW REQUEST**\n\n${requesterId === product.user_id ? 'You' : 'Someone'} requested ${quantity} ${product.quantity_unit || 'unit(s)'} of "${product.name}".\n\n${message ? `Message: "${message}"` : ''}\n\nPlease accept or decline this request.`;
    
    await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        sender_id: requesterId,
        recipient_id: product.user_id,
        text: requestMessage,
        product_id: productId,
        request_id: request.id,
        is_system_message: true,
        created_at: new Date().toISOString(),
        is_read: false
      });

    // Get WebSocket server instance
    const wsServer = req.app.get('wsServer');
    
    if (wsServer) {
      // Notify owner
      wsServer.sendNotification(product.user_id, {
        type: 'new_request',
        request: {
          id: request.id,
          productId: productId,
          productName: product.name,
          quantity: quantity,
          requesterId: requesterId,
          message: message || '',
          status: 'pending'
        }
      });
    }

    res.status(201).json({
      success: true,
      message: 'Request sent successfully',
      request: {
        id: request.id,
        quantity: request.quantity,
        status: request.status,
        message: request.message,
        product_id: request.product_id,
        requester_id: request.requester_id,
        owner_id: request.owner_id,
        created_at: request.created_at
      },
      chat: { id: chatId }
    });

  } catch (error) {
    console.error('Create request error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create request' 
    });
  }
});

// Get user's existing request for a product (UPDATED - works for BOTH requester AND owner)
router.get('/products/:productId/my-request', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user.id;

    console.log('🔍 Checking request for product:', productId);
    console.log('👤 User ID:', userId);

    // First check if user is the requester
    let { data: request, error } = await supabase
      .from('product_requests')
      .select('*')
      .eq('product_id', productId)
      .eq('requester_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log('📝 Requester check result:', request);

    // If not found as requester, check if user is the owner
    if (!request) {
      console.log('🔍 Not found as requester, checking as owner...');
      const { data: ownerRequest, error: ownerError } = await supabase
        .from('product_requests')
        .select('*')
        .eq('product_id', productId)
        .eq('owner_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (ownerError) {
        console.error('Owner check error:', ownerError);
      }
      
      request = ownerRequest;
      console.log('📝 Owner check result:', request);
    }

    if (error && !request) throw error;

    res.status(200).json({
      success: true,
      request: request || null
    });

  } catch (error) {
    console.error('Get user request error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch request' 
    });
  }
});

// Accept a request (owner only)
router.post('/requests/:requestId/accept', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.id;

    // Get request details
    const { data: request, error: requestError } = await supabase
      .from('product_requests')
      .select('*, product:shared_items(*)')
      .eq('id', requestId)
      .single();

    if (requestError || !request) {
      return res.status(404).json({
        success: false,
        error: 'Request not found'
      });
    }

    // Verify ownership
    if (request.owner_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the product owner can accept requests'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Request is already ${request.status}`
      });
    }

    // Check if enough quantity is still available
    if (request.product.quantity < request.quantity) {
      return res.status(400).json({
        success: false,
        error: 'Not enough quantity available anymore'
      });
    }

    // Update request status
    const { data: updatedRequest, error: updateError } = await supabase
      .from('product_requests')
      .update({
        status: 'accepted',
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Decrease product quantity
    const newQuantity = request.product.quantity - request.quantity;
    const { error: updateProductError } = await supabase
      .from('shared_items')
      .update({
        quantity: newQuantity,
        updated_at: new Date().toISOString(),
        status: newQuantity === 0 ? 'claimed' : 'available'
      })
      .eq('id', request.product_id);

    if (updateProductError) throw updateProductError;

    // Get chat between users
    const { data: chat } = await supabase
      .from('chats')
      .select('id')
      .or(`and(user1_id.eq.${request.requester_id},user2_id.eq.${request.owner_id}),and(user1_id.eq.${request.owner_id},user2_id.eq.${request.requester_id})`)
      .single();

    // Send acceptance message in chat
    const acceptMessage = `✅ **REQUEST ACCEPTED!**\n\nYour request for ${request.quantity} ${request.product.quantity_unit || 'unit(s)'} of "${request.product.name}" has been accepted.\n\nPlease arrange pickup with the gardener.`;
    
    if (chat) {
      await supabase
        .from('messages')
        .insert({
          chat_id: chat.id,
          sender_id: userId,
          recipient_id: request.requester_id,
          text: acceptMessage,
          product_id: request.product_id,
          request_id: requestId,
          is_system_message: true,
          created_at: new Date().toISOString(),
          is_read: false
        });
    }

    // Get WebSocket server
    const wsServer = req.app.get('wsServer');
    
    if (wsServer) {
      wsServer.sendNotification(request.requester_id, {
        type: 'request_accepted',
        request: {
          id: requestId,
          productId: request.product_id,
          productName: request.product.name,
          quantity: request.quantity,
          status: 'accepted'
        }
      });
    }

    res.status(200).json({
      success: true,
      message: 'Request accepted',
      request: updatedRequest,
      remainingQuantity: newQuantity
    });

  } catch (error) {
    console.error('Accept request error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to accept request' 
    });
  }
});

// Decline a request (owner only)
router.post('/requests/:requestId/decline', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.id;

    // Get request details
    const { data: request, error: requestError } = await supabase
      .from('product_requests')
      .select('*, product:shared_items(*)')
      .eq('id', requestId)
      .single();

    if (requestError || !request) {
      return res.status(404).json({
        success: false,
        error: 'Request not found'
      });
    }

    // Verify ownership
    if (request.owner_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the product owner can decline requests'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Request is already ${request.status}`
      });
    }

    // Update request status
    const { data: updatedRequest, error: updateError } = await supabase
      .from('product_requests')
      .update({
        status: 'declined',
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Get chat between users
    const { data: chat } = await supabase
      .from('chats')
      .select('id')
      .or(`and(user1_id.eq.${request.requester_id},user2_id.eq.${request.owner_id}),and(user1_id.eq.${request.owner_id},user2_id.eq.${request.requester_id})`)
      .single();

    // Send decline message in chat
    const declineMessage = `❌ **REQUEST DECLINED**\n\nYour request for ${request.quantity} ${request.product.quantity_unit || 'unit(s)'} of "${request.product.name}" has been declined.\n\nPlease contact the gardener for more information.`;
    
    if (chat) {
      await supabase
        .from('messages')
        .insert({
          chat_id: chat.id,
          sender_id: userId,
          recipient_id: request.requester_id,
          text: declineMessage,
          product_id: request.product_id,
          request_id: requestId,
          is_system_message: true,
          created_at: new Date().toISOString(),
          is_read: false
        });
    }

    // Get WebSocket server
    const wsServer = req.app.get('wsServer');
    
    if (wsServer) {
      wsServer.sendNotification(request.requester_id, {
        type: 'request_declined',
        request: {
          id: requestId,
          productId: request.product_id,
          productName: request.product.name,
          quantity: request.quantity,
          status: 'declined'
        }
      });
    }

    res.status(200).json({
      success: true,
      message: 'Request declined',
      request: updatedRequest
    });

  } catch (error) {
    console.error('Decline request error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to decline request' 
    });
  }
});

// Get all requests for a product (for owner)
router.get('/products/:productId/requests', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user.id;

    // Verify ownership
    const { data: product, error: productError } = await supabase
      .from('shared_items')
      .select('user_id')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    if (product.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the product owner can view requests'
      });
    }

    const { data: requests, error } = await supabase
      .from('product_requests')
      .select(`
        *,
        requester:users!requester_id(id, name, profile_image_url)
      `)
      .eq('product_id', productId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      requests: requests
    });

  } catch (error) {
    console.error('Get product requests error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch requests' 
    });
  }
});

// Get all requests made by current user
router.get('/my-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: requests, error } = await supabase
      .from('product_requests')
      .select(`
        *,
        product:shared_items(id, name, image_url, quantity_unit, user_id),
        owner:users!owner_id(id, name, profile_image_url)
      `)
      .eq('requester_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      requests: requests
    });

  } catch (error) {
    console.error('Get my requests error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch requests' 
    });
  }
});

// Get requests where user is the owner (incoming requests)
router.get('/incoming-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: requests, error } = await supabase
      .from('product_requests')
      .select(`
        *,
        product:shared_items(id, name, image_url, quantity_unit, user_id),
        requester:users!requester_id(id, name, profile_image_url)
      `)
      .eq('owner_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      requests: requests
    });

  } catch (error) {
    console.error('Get incoming requests error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch incoming requests' 
    });
  }
});

module.exports = router;









// const express = require('express');
// const router = express.Router();
// const supabase = require('../supabase');
// const { authenticateToken } = require('../middleware/auth');

// // Create a new product request
// router.post('/products/:productId/request', authenticateToken, async (req, res) => {
//   try {
//     const { productId } = req.params;
//     const requesterId = req.user.id;
//     const { quantity, message } = req.body;

//     if (!quantity || quantity < 1 || quantity > 3) {
//       return res.status(400).json({
//         success: false,
//         error: 'Quantity must be between 1 and 3'
//       });
//     }

//     // Get product details and owner
//     const { data: product, error: productError } = await supabase
//       .from('shared_items')
//       .select('id, name, quantity, quantity_unit, user_id, status, image_url')
//       .eq('id', productId)
//       .single();

//     if (productError || !product) {
//       return res.status(404).json({
//         success: false,
//         error: 'Product not found'
//       });
//     }

//     if (product.user_id === requesterId) {
//       return res.status(400).json({
//         success: false,
//         error: 'You cannot request your own product'
//       });
//     }

//     if (product.quantity < quantity) {
//       return res.status(400).json({
//         success: false,
//         error: 'Not enough quantity available'
//       });
//     }

//     // Check if user already has a pending request for this product
//     const { data: existingRequest, error: existingError } = await supabase
//       .from('product_requests')
//       .select('id, status')
//       .eq('product_id', productId)
//       .eq('requester_id', requesterId)
//       .in('status', ['pending', 'accepted'])
//       .maybeSingle();

//     if (existingRequest) {
//       return res.status(400).json({
//         success: false,
//         error: `You already have a ${existingRequest.status} request for this product`
//       });
//     }

//     // Create the request
//     const { data: request, error: requestError } = await supabase
//       .from('product_requests')
//       .insert({
//         product_id: productId,
//         requester_id: requesterId,
//         owner_id: product.user_id,
//         quantity: quantity,
//         status: 'pending',
//         message: message || null,
//         created_at: new Date().toISOString(),
//         updated_at: new Date().toISOString()
//       })
//       .select()
//       .single();

//     if (requestError) throw requestError;

//     // Get or create chat for this request
//     let chatId;
//     const { data: existingChat } = await supabase
//       .from('chats')
//       .select('id')
//       .or(`and(user1_id.eq.${requesterId},user2_id.eq.${product.user_id}),and(user1_id.eq.${product.user_id},user2_id.eq.${requesterId})`)
//       .maybeSingle();

//     if (existingChat) {
//       chatId = existingChat.id;
//     } else {
//       const { data: newChat, error: chatError } = await supabase
//         .from('chats')
//         .insert({
//           user1_id: requesterId,
//           user2_id: product.user_id,
//           product_id: productId,
//           created_at: new Date().toISOString(),
//           updated_at: new Date().toISOString()
//         })
//         .select()
//         .single();

//       if (chatError) throw chatError;
//       chatId = newChat.id;
//     }

//     // Send a system message in the chat about the request
//     const requestMessage = `🎉 **REQUEST PENDING**\n\n${requesterId === product.user_id ? 'You' : 'Someone'} requested ${quantity} ${product.quantity_unit || 'unit(s)'} of "${product.name}".\n\n${message ? `Message: "${message}"` : ''}\n\nPlease accept or decline this request.`;
    
//     const { data: systemMessage } = await supabase
//       .from('messages')
//       .insert({
//         chat_id: chatId,
//         sender_id: requesterId,
//         recipient_id: product.user_id,
//         text: requestMessage,
//         product_id: productId,
//         request_id: request.id,
//         is_system_message: true,
//         created_at: new Date().toISOString(),
//         is_read: false
//       })
//       .select();

//     // Get WebSocket server instance
//     const wsServer = req.app.get('wsServer');
    
//     if (wsServer) {
//       // Notify owner
//       wsServer.sendNotification(product.user_id, {
//         type: 'new_request',
//         request: {
//           id: request.id,
//           productId: productId,
//           productName: product.name,
//           quantity: quantity,
//           requesterId: requesterId,
//           message: message || '',
//           status: 'pending'
//         }
//       });
//     }

//     res.status(201).json({
//       success: true,
//       message: 'Request sent successfully',
//       request: request,
//       chat: { id: chatId }
//     });

//   } catch (error) {
//     console.error('Create request error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to create request' 
//     });
//   }
// });

// // Get user's existing request for a product
// router.get('/products/:productId/my-request', authenticateToken, async (req, res) => {
//   try {
//     const { productId } = req.params;
//     const userId = req.user.id;

//     const { data: request, error } = await supabase
//       .from('product_requests')
//       .select('*')
//       .eq('product_id', productId)
//       .eq('requester_id', userId)
//       .order('created_at', { ascending: false })
//       .limit(1)
//       .maybeSingle();

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       request: request || null
//     });

//   } catch (error) {
//     console.error('Get user request error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch request' 
//     });
//   }
// });

// // Accept a request (owner only)
// router.post('/requests/:requestId/accept', authenticateToken, async (req, res) => {
//   try {
//     const { requestId } = req.params;
//     const userId = req.user.id;

//     // Get request details
//     const { data: request, error: requestError } = await supabase
//       .from('product_requests')
//       .select('*, product:shared_items(*)')
//       .eq('id', requestId)
//       .single();

//     if (requestError || !request) {
//       return res.status(404).json({
//         success: false,
//         error: 'Request not found'
//       });
//     }

//     // Verify ownership
//     if (request.owner_id !== userId) {
//       return res.status(403).json({
//         success: false,
//         error: 'Only the product owner can accept requests'
//       });
//     }

//     if (request.status !== 'pending') {
//       return res.status(400).json({
//         success: false,
//         error: `Request is already ${request.status}`
//       });
//     }

//     // Check if enough quantity is still available
//     if (request.product.quantity < request.quantity) {
//       return res.status(400).json({
//         success: false,
//         error: 'Not enough quantity available anymore'
//       });
//     }

//     // Update request status
//     const { data: updatedRequest, error: updateError } = await supabase
//       .from('product_requests')
//       .update({
//         status: 'accepted',
//         updated_at: new Date().toISOString()
//       })
//       .eq('id', requestId)
//       .select()
//       .single();

//     if (updateError) throw updateError;

//     // Decrease product quantity
//     const newQuantity = request.product.quantity - request.quantity;
//     const { error: updateProductError } = await supabase
//       .from('shared_items')
//       .update({
//         quantity: newQuantity,
//         updated_at: new Date().toISOString(),
//         status: newQuantity === 0 ? 'claimed' : 'available'
//       })
//       .eq('id', request.product_id);

//     if (updateProductError) throw updateProductError;

//     // Get chat between users
//     const { data: chat } = await supabase
//       .from('chats')
//       .select('id')
//       .or(`and(user1_id.eq.${request.requester_id},user2_id.eq.${request.owner_id}),and(user1_id.eq.${request.owner_id},user2_id.eq.${request.requester_id})`)
//       .single();

//     // Send acceptance message in chat
//     const acceptMessage = `✅ **REQUEST ACCEPTED!**\n\nYour request for ${request.quantity} ${request.product.quantity_unit || 'unit(s)'} of "${request.product.name}" has been accepted.\n\nPlease arrange pickup with the gardener.`;
    
//     if (chat) {
//       await supabase
//         .from('messages')
//         .insert({
//           chat_id: chat.id,
//           sender_id: userId,
//           recipient_id: request.requester_id,
//           text: acceptMessage,
//           product_id: request.product_id,
//           request_id: requestId,
//           is_system_message: true,
//           created_at: new Date().toISOString(),
//           is_read: false
//         });
//     }

//     // Get WebSocket server
//     const wsServer = req.app.get('wsServer');
    
//     if (wsServer) {
//       wsServer.sendNotification(request.requester_id, {
//         type: 'request_accepted',
//         request: {
//           id: requestId,
//           productId: request.product_id,
//           productName: request.product.name,
//           quantity: request.quantity,
//           status: 'accepted'
//         }
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message: 'Request accepted',
//       request: updatedRequest,
//       remainingQuantity: newQuantity
//     });

//   } catch (error) {
//     console.error('Accept request error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to accept request' 
//     });
//   }
// });

// // Decline a request (owner only)
// router.post('/requests/:requestId/decline', authenticateToken, async (req, res) => {
//   try {
//     const { requestId } = req.params;
//     const userId = req.user.id;

//     // Get request details
//     const { data: request, error: requestError } = await supabase
//       .from('product_requests')
//       .select('*, product:shared_items(*)')
//       .eq('id', requestId)
//       .single();

//     if (requestError || !request) {
//       return res.status(404).json({
//         success: false,
//         error: 'Request not found'
//       });
//     }

//     // Verify ownership
//     if (request.owner_id !== userId) {
//       return res.status(403).json({
//         success: false,
//         error: 'Only the product owner can decline requests'
//       });
//     }

//     if (request.status !== 'pending') {
//       return res.status(400).json({
//         success: false,
//         error: `Request is already ${request.status}`
//       });
//     }

//     // Update request status
//     const { data: updatedRequest, error: updateError } = await supabase
//       .from('product_requests')
//       .update({
//         status: 'declined',
//         updated_at: new Date().toISOString()
//       })
//       .eq('id', requestId)
//       .select()
//       .single();

//     if (updateError) throw updateError;

//     // Get chat between users
//     const { data: chat } = await supabase
//       .from('chats')
//       .select('id')
//       .or(`and(user1_id.eq.${request.requester_id},user2_id.eq.${request.owner_id}),and(user1_id.eq.${request.owner_id},user2_id.eq.${request.requester_id})`)
//       .single();

//     // Send decline message in chat
//     const declineMessage = `❌ **REQUEST DECLINED**\n\nYour request for ${request.quantity} ${request.product.quantity_unit || 'unit(s)'} of "${request.product.name}" has been declined.\n\nPlease contact the gardener for more information.`;
    
//     if (chat) {
//       await supabase
//         .from('messages')
//         .insert({
//           chat_id: chat.id,
//           sender_id: userId,
//           recipient_id: request.requester_id,
//           text: declineMessage,
//           product_id: request.product_id,
//           request_id: requestId,
//           is_system_message: true,
//           created_at: new Date().toISOString(),
//           is_read: false
//         });
//     }

//     // Get WebSocket server
//     const wsServer = req.app.get('wsServer');
    
//     if (wsServer) {
//       wsServer.sendNotification(request.requester_id, {
//         type: 'request_declined',
//         request: {
//           id: requestId,
//           productId: request.product_id,
//           productName: request.product.name,
//           quantity: request.quantity,
//           status: 'declined'
//         }
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message: 'Request declined',
//       request: updatedRequest
//     });

//   } catch (error) {
//     console.error('Decline request error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to decline request' 
//     });
//   }
// });

// // Get all requests for a product (for owner)
// router.get('/products/:productId/requests', authenticateToken, async (req, res) => {
//   try {
//     const { productId } = req.params;
//     const userId = req.user.id;

//     // Verify ownership
//     const { data: product, error: productError } = await supabase
//       .from('shared_items')
//       .select('user_id')
//       .eq('id', productId)
//       .single();

//     if (productError || !product) {
//       return res.status(404).json({
//         success: false,
//         error: 'Product not found'
//       });
//     }

//     if (product.user_id !== userId) {
//       return res.status(403).json({
//         success: false,
//         error: 'Only the product owner can view requests'
//       });
//     }

//     const { data: requests, error } = await supabase
//       .from('product_requests')
//       .select(`
//         *,
//         requester:users!requester_id(id, name, profile_image_url)
//       `)
//       .eq('product_id', productId)
//       .order('created_at', { ascending: false });

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       requests: requests
//     });

//   } catch (error) {
//     console.error('Get product requests error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch requests' 
//     });
//   }
// });

// // Get all requests made by current user
// router.get('/my-requests', authenticateToken, async (req, res) => {
//   try {
//     const userId = req.user.id;

//     const { data: requests, error } = await supabase
//       .from('product_requests')
//       .select(`
//         *,
//         product:shared_items(id, name, image_url, quantity_unit, user_id),
//         owner:users!owner_id(id, name, profile_image_url)
//       `)
//       .eq('requester_id', userId)
//       .order('created_at', { ascending: false });

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       requests: requests
//     });

//   } catch (error) {
//     console.error('Get my requests error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch requests' 
//     });
//   }
// });

// module.exports = router;
