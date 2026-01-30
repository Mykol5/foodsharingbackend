const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Get all gardens for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: gardens, error } = await supabase
      .from('gardens')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.status(200).json({
      success: true,
      count: gardens.length,
      gardens
    });
  } catch (error) {
    console.error('Get gardens error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch gardens' 
    });
  }
});

// Get single garden
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: garden, error } = await supabase
      .from('gardens')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;

    if (!garden) {
      return res.status(404).json({
        success: false,
        error: 'Garden not found'
      });
    }

    res.status(200).json({
      success: true,
      garden
    });
  } catch (error) {
    console.error('Get garden error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch garden' 
    });
  }
});

// Create new garden
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, location, type, size, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Garden name is required'
      });
    }

    const gardenData = {
      user_id: req.user.id,
      name,
      location: location || null,
      type: type || 'outdoor',
      size: size || 'medium',
      description: description || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: garden, error } = await supabase
      .from('gardens')
      .insert([gardenData])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Garden created successfully',
      garden
    });
  } catch (error) {
    console.error('Create garden error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create garden' 
    });
  }
});

// Update garden
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { name, location, type, size, description } = req.body;

    // First check if garden exists and belongs to user
    const { data: existingGarden, error: checkError } = await supabase
      .from('gardens')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (checkError || !existingGarden) {
      return res.status(404).json({
        success: false,
        error: 'Garden not found or access denied'
      });
    }

    const updateData = {
      name: name || existingGarden.name,
      location: location !== undefined ? location : existingGarden.location,
      type: type || existingGarden.type,
      size: size || existingGarden.size,
      description: description !== undefined ? description : existingGarden.description,
      updated_at: new Date().toISOString()
    };

    const { data: garden, error } = await supabase
      .from('gardens')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Garden updated successfully',
      garden
    });
  } catch (error) {
    console.error('Update garden error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update garden' 
    });
  }
});

// Delete garden
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // First check if garden exists and belongs to user
    const { data: existingGarden, error: checkError } = await supabase
      .from('gardens')
      .select('id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (checkError || !existingGarden) {
      return res.status(404).json({
        success: false,
        error: 'Garden not found or access denied'
      });
    }

    const { error } = await supabase
      .from('gardens')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Garden deleted successfully'
    });
  } catch (error) {
    console.error('Delete garden error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete garden' 
    });
  }
});

module.exports = router;