const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Get all available shared items (for marketplace)
router.get('/', async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from('shared_items')
      .select(`
        *,
        users (
          name,
          profile_image_url,
          location
        )
      `)
      .eq('status', 'available')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: items.length,
      items
    });
  } catch (error) {
    console.error('Get shared items error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch shared items' 
    });
  }
});

// Get user's shared items
router.get('/my-items', authenticateToken, async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from('shared_items')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: items.length,
      items
    });
  } catch (error) {
    console.error('Get user shared items error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch your shared items' 
    });
  }
});

// Get single shared item
router.get('/:id', async (req, res) => {
  try {
    const { data: item, error } = await supabase
      .from('shared_items')
      .select(`
        *,
        users (
          name,
          profile_image_url,
          location
        )
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    res.status(200).json({
      success: true,
      item
    });
  } catch (error) {
    console.error('Get shared item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch item' 
    });
  }
});

// Create new shared item
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      crop_id,
      name, 
      category, 
      quantity, 
      quantity_unit, 
      description, 
      image_url, 
      pickup_instructions,
      latitude,
      longitude,
      location_text,
      expires_at
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Item name is required'
      });
    }

    const itemData = {
      user_id: req.user.id,
      crop_id: crop_id || null,
      name,
      category: category || 'vegetable',
      quantity: quantity || 1,
      quantity_unit: quantity_unit || 'lbs',
      description: description || null,
      image_url: image_url || null,
      pickup_instructions: pickup_instructions || null,
      latitude: latitude || null,
      longitude: longitude || null,
      location_text: location_text || null,
      status: 'available',
      expires_at: expires_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: item, error } = await supabase
      .from('shared_items')
      .insert([itemData])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Item shared successfully',
      item
    });
  } catch (error) {
    console.error('Create shared item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to share item' 
    });
  }
});

// Update shared item status
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;

    // First check if item exists and belongs to user or is available
    const { data: existingItem, error: checkError } = await supabase
      .from('shared_items')
      .select('user_id, status')
      .eq('id', req.params.id)
      .single();

    if (checkError || !existingItem) {
      return res.status(404).json({
        success: false,
        error: 'Item not found'
      });
    }

    // Only owner can update to 'claimed' or 'reserved'
    if (existingItem.user_id !== req.user.id && status === 'claimed') {
      return res.status(403).json({
        success: false,
        error: 'You can only claim items, not mark them as claimed'
      });
    }

    const { data: item, error } = await supabase
      .from('shared_items')
      .update({ 
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Item status updated successfully',
      item
    });
  } catch (error) {
    console.error('Update shared item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update item status' 
    });
  }
});

// Delete shared item
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // First check if item exists and belongs to user
    const { data: existingItem, error: checkError } = await supabase
      .from('shared_items')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (checkError || !existingItem) {
      return res.status(404).json({
        success: false,
        error: 'Item not found or access denied'
      });
    }

    const { error } = await supabase
      .from('shared_items')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Item deleted successfully'
    });
  } catch (error) {
    console.error('Delete shared item error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete item' 
    });
  }
});

module.exports = router;
