const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Get all crops for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: crops, error } = await supabase
      .from('crops')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: crops.length,
      crops
    });
  } catch (error) {
    console.error('Get crops error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch crops' 
    });
  }
});

// Get crops by garden
router.get('/garden/:gardenId', authenticateToken, async (req, res) => {
  try {
    // Verify garden belongs to user
    const { data: garden, error: gardenError } = await supabase
      .from('gardens')
      .select('id')
      .eq('id', req.params.gardenId)
      .eq('user_id', req.user.id)
      .single();

    if (gardenError || !garden) {
      return res.status(404).json({
        success: false,
        error: 'Garden not found or access denied'
      });
    }

    const { data: crops, error } = await supabase
      .from('crops')
      .select('*')
      .eq('garden_id', req.params.gardenId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: crops.length,
      crops
    });
  } catch (error) {
    console.error('Get garden crops error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch garden crops' 
    });
  }
});

// Get single crop
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: crop, error } = await supabase
      .from('crops')
      .select(`
        *,
        gardens (
          name,
          location
        )
      `)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;

    if (!crop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found'
      });
    }

    res.status(200).json({
      success: true,
      crop
    });
  } catch (error) {
    console.error('Get crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch crop' 
    });
  }
});

// Create new crop
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      garden_id, 
      name, 
      category, 
      variety, 
      planting_date, 
      expected_harvest, 
      status, 
      progress, 
      notes, 
      image_url, 
      is_shared, 
      quantity, 
      quantity_unit 
    } = req.body;

    if (!name || !garden_id) {
      return res.status(400).json({
        success: false,
        error: 'Crop name and garden ID are required'
      });
    }

    // Verify garden belongs to user
    const { data: garden, error: gardenError } = await supabase
      .from('gardens')
      .select('id')
      .eq('id', garden_id)
      .eq('user_id', req.user.id)
      .single();

    if (gardenError || !garden) {
      return res.status(404).json({
        success: false,
        error: 'Garden not found or access denied'
      });
    }

    const cropData = {
      garden_id,
      user_id: req.user.id,
      name,
      category: category || 'vegetable',
      variety: variety || null,
      planting_date: planting_date || null,
      expected_harvest: expected_harvest || null,
      status: status || 'seedling',
      progress: progress || 0,
      notes: notes || null,
      image_url: image_url || null,
      is_shared: is_shared || false,
      quantity: quantity || 1,
      quantity_unit: quantity_unit || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: crop, error } = await supabase
      .from('crops')
      .insert([cropData])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Crop created successfully',
      crop
    });
  } catch (error) {
    console.error('Create crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create crop' 
    });
  }
});

// Update crop
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    // First check if crop exists and belongs to user
    const { data: existingCrop, error: checkError } = await supabase
      .from('crops')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (checkError || !existingCrop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found or access denied'
      });
    }

    const updateData = {
      name: req.body.name || existingCrop.name,
      category: req.body.category || existingCrop.category,
      variety: req.body.variety !== undefined ? req.body.variety : existingCrop.variety,
      planting_date: req.body.planting_date !== undefined ? req.body.planting_date : existingCrop.planting_date,
      expected_harvest: req.body.expected_harvest !== undefined ? req.body.expected_harvest : existingCrop.expected_harvest,
      status: req.body.status || existingCrop.status,
      progress: req.body.progress !== undefined ? req.body.progress : existingCrop.progress,
      notes: req.body.notes !== undefined ? req.body.notes : existingCrop.notes,
      image_url: req.body.image_url !== undefined ? req.body.image_url : existingCrop.image_url,
      is_shared: req.body.is_shared !== undefined ? req.body.is_shared : existingCrop.is_shared,
      quantity: req.body.quantity !== undefined ? req.body.quantity : existingCrop.quantity,
      quantity_unit: req.body.quantity_unit !== undefined ? req.body.quantity_unit : existingCrop.quantity_unit,
      updated_at: new Date().toISOString()
    };

    const { data: crop, error } = await supabase
      .from('crops')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Crop updated successfully',
      crop
    });
  } catch (error) {
    console.error('Update crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update crop' 
    });
  }
});

// Delete crop
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // First check if crop exists and belongs to user
    const { data: existingCrop, error: checkError } = await supabase
      .from('crops')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (checkError || !existingCrop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found or access denied'
      });
    }

    const { error } = await supabase
      .from('crops')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Crop deleted successfully'
    });
  } catch (error) {
    console.error('Delete crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete crop' 
    });
  }
});

module.exports = router;