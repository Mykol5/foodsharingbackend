const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure multer storage for Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'harvest-hub/profiles',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    transformation: [{ width: 500, height: 500, crop: 'limit' }]
  }
});

const upload = multer({ storage });

// Get user profile
router.get('/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Get user info
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, name, phone, created_at, profile_image_url, bio, location, garden_name, garden_size')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user stats
    const { data: crops, error: cropsError } = await supabase
      .from('crops')
      .select('id, name, status, progress, is_shared')
      .eq('user_id', userId);

    if (cropsError) {
      console.error('Error fetching crops:', cropsError);
    }

    // Calculate stats
    const totalCrops = crops?.length || 0;
    const activeCrops = crops?.filter(crop => crop.status !== 'harvest').length || 0;
    const sharedCrops = crops?.filter(crop => crop.is_shared).length || 0;
    const avgProgress = crops?.length 
      ? Math.round(crops.reduce((sum, crop) => sum + (crop.progress || 0), 0) / crops.length)
      : 0;

    // Get sharing history (recent shared crops)
    const { data: sharedHistory, error: historyError } = await supabase
      .from('crops')
      .select('id, name, image_url, created_at')
      .eq('user_id', userId)
      .eq('is_shared', true)
      .order('created_at', { ascending: false })
      .limit(5);

    if (historyError) {
      console.error('Error fetching sharing history:', historyError);
    }

    res.status(200).json({
      success: true,
      profile: {
        ...user,
        stats: {
          totalCrops,
          activeCrops,
          sharedCrops,
          avgProgress
        },
        sharingHistory: sharedHistory || []
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
});

// Get current user's profile (shortcut)
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Get user info with stats
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, name, phone, created_at, profile_image_url, bio, location, garden_name, garden_size')
      .eq('id', req.user.id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user's gardens
    const { data: gardens, error: gardensError } = await supabase
      .from('gardens')
      .select('id, name, type, size, location')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (gardensError) {
      console.error('Error fetching gardens:', gardensError);
    }

    // Get user's active crops
    const { data: crops, error: cropsError } = await supabase
      .from('crops')
      .select('id, name, category, status, progress, image_url')
      .eq('user_id', req.user.id)
      .neq('status', 'harvest')
      .order('created_at', { ascending: false })
      .limit(5);

    if (cropsError) {
      console.error('Error fetching crops:', cropsError);
    }

    // Get sharing history
    const { data: sharedHistory, error: historyError } = await supabase
      .from('crops')
      .select('id, name, image_url, created_at')
      .eq('user_id', req.user.id)
      .eq('is_shared', true)
      .order('created_at', { ascending: false })
      .limit(5);

    if (historyError) {
      console.error('Error fetching sharing history:', historyError);
    }

    // Calculate impact metrics (simplified for now)
    const sharedKg = Math.floor(Math.random() * 20) + 5; // Mock data
    const helpedCount = Math.floor(Math.random() * 10) + 1; // Mock data
    const savedCO2 = Math.floor(Math.random() * 15) + 5; // Mock data

    res.status(200).json({
      success: true,
      profile: {
        ...user,
        impact: {
          sharedKg,
          helpedCount,
          savedCO2
        },
        gardens: gardens || [],
        activeCrops: crops || [],
        sharingHistory: sharedHistory || []
      }
    });

  } catch (error) {
    console.error('Get current profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
});

// Update user profile
router.put('/', authenticateToken, async (req, res) => {
  try {
    const { name, bio, location, garden_name, garden_size } = req.body;

    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (name) updateData.name = name;
    if (bio !== undefined) updateData.bio = bio;
    if (location !== undefined) updateData.location = location;
    if (garden_name !== undefined) updateData.garden_name = garden_name;
    if (garden_size !== undefined) updateData.garden_size = garden_size;

    const { data: user, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.id)
      .select('id, email, name, phone, created_at, profile_image_url, bio, location, garden_name, garden_size')
      .single();

    if (error) {
      console.error('Update profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update profile'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Upload profile image
router.post('/upload-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    const imageUrl = req.file.path;

    // Update user profile with new image URL
    const { data: user, error } = await supabase
      .from('users')
      .update({
        profile_image_url: imageUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.user.id)
      .select('id, email, name, profile_image_url')
      .single();

    if (error) {
      console.error('Update profile image error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update profile image'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile image uploaded successfully',
      imageUrl,
      user
    });

  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload image'
    });
  }
});

// Delete profile image
router.delete('/image', authenticateToken, async (req, res) => {
  try {
    // Get current image URL
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('profile_image_url')
      .eq('id', req.user.id)
      .single();

    if (fetchError) {
      console.error('Fetch user error:', fetchError);
    }

    // Delete from Cloudinary if exists
    if (user?.profile_image_url) {
      try {
        const publicId = user.profile_image_url.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`harvest-hub/profiles/${publicId}`);
      } catch (cloudinaryError) {
        console.error('Cloudinary delete error:', cloudinaryError);
      }
    }

    // Remove image URL from database
    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({
        profile_image_url: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.user.id)
      .select('id, email, name, profile_image_url')
      .single();

    if (error) {
      console.error('Remove profile image error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to remove profile image'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile image removed successfully',
      user: updatedUser
    });

  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove image'
    });
  }
});

// Get user's sharing impact stats
router.get('/stats/impact', authenticateToken, async (req, res) => {
  try {
    // Mock impact stats for now - you can implement real calculations
    const sharedKg = Math.floor(Math.random() * 20) + 5;
    const helpedCount = Math.floor(Math.random() * 10) + 1;
    const savedCO2 = Math.floor(Math.random() * 15) + 5;

    res.status(200).json({
      success: true,
      impact: {
        sharedKg,
        helpedCount,
        savedCO2,
        sharedChange: Math.floor(Math.random() * 5) + 1,
        helpedChange: Math.floor(Math.random() * 3) + 1,
        savedChange: Math.floor(Math.random() * 4) + 1
      }
    });

  } catch (error) {
    console.error('Get impact stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch impact stats'
    });
  }
});

// Delete user account
router.delete('/', authenticateToken, async (req, res) => {
  try {
    // First delete profile image from Cloudinary if exists
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('profile_image_url')
      .eq('id', req.user.id)
      .single();

    if (fetchError) {
      console.error('Fetch user error:', fetchError);
    }

    if (user?.profile_image_url) {
      try {
        const publicId = user.profile_image_url.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`harvest-hub/profiles/${publicId}`);
      } catch (cloudinaryError) {
        console.error('Cloudinary delete error:', cloudinaryError);
      }
    }

    // Delete user from database (cascades to gardens and crops)
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.user.id);

    if (error) {
      console.error('Delete user error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete account'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete account'
    });
  }
});

module.exports = router;