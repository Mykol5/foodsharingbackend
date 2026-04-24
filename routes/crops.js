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

// ============ HELPER FUNCTIONS FOR CROP GROWTH ============

// Calculate crop progress based on planting date
function calculateCropProgress(plantingDate, cropReference, manualProgress = null) {
  // If user manually set progress, use that
  if (manualProgress !== null && manualProgress >= 0 && manualProgress <= 100) {
    return manualProgress;
  }
  
  const now = new Date();
  const planted = new Date(plantingDate);
  const daysPlanted = Math.max(0, Math.floor((now - planted) / (1000 * 60 * 60 * 24)));
  
  const totalDays = cropReference.days_to_harvest;
  
  if (daysPlanted >= totalDays) {
    return 100;
  }
  
  const progress = (daysPlanted / totalDays) * 100;
  return Math.min(99, Math.floor(progress));
}

// Determine current growth stage based on days planted
function determineGrowthStage(daysPlanted, cropReference) {
  if (daysPlanted < cropReference.days_to_seedling) return 'seedling';
  if (daysPlanted < cropReference.days_to_vegetative) return 'seedling';
  if (daysPlanted < cropReference.days_to_flowering) return 'vegetative';
  if (daysPlanted < cropReference.days_to_fruiting) return 'flowering';
  if (daysPlanted < cropReference.days_to_harvest) return 'fruiting';
  return 'harvest';
}

// Get crop reference data
async function getCropReference(cropName) {
  const { data, error } = await supabase
    .from('crop_reference')
    .select('*')
    .eq('name', cropName.toLowerCase())
    .single();
  
  if (error || !data) {
    return null;
  }
  return data;
}

// ============ EXISTING UPLOAD ROUTES ============

// Configure multer storage for Cloudinary - CROPS folder
const cropStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'harvest-hub/crops',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});

const uploadCrop = multer({ storage: cropStorage });

// Upload crop image
router.post('/upload-image', authenticateToken, uploadCrop.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    const imageUrl = req.file.path;
    
    res.status(200).json({
      success: true,
      message: 'Crop image uploaded successfully',
      imageUrl
    });

  } catch (error) {
    console.error('Upload crop image error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload image'
    });
  }
});

// Handle base64 image upload for web
router.post('/upload-image-web', authenticateToken, async (req, res) => {
  try {
    const { image, fileName } = req.body;
    
    if (!image) {
      return res.status(400).json({
        success: false,
        error: 'No image data provided'
      });
    }

    console.log('📤 Received base64 image, length:', image.length);

    const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${image}`, {
      folder: 'harvest-hub/crops',
      public_id: `crop_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`,
    });

    console.log('✅ Cloudinary upload successful:', result.secure_url);

    res.status(200).json({
      success: true,
      message: 'Crop image uploaded successfully',
      imageUrl: result.secure_url
    });

  } catch (error) {
    console.error('❌ Upload crop image error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload image: ' + error.message
    });
  }
});

// ============ UPDATED GET CROPS ROUTE (with auto-growth calculation) ============

// Get all crops for current user - NOW with auto-growth calculation
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: crops, error } = await supabase
      .from('crops')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!crops || crops.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        crops: []
      });
    }

    // Get unique crop names for reference lookup
    const cropNames = [...new Set(crops.map(c => c.name.toLowerCase()))];
    
    // Fetch crop references
    const { data: references, error: refError } = await supabase
      .from('crop_reference')
      .select('*')
      .in('name', cropNames);
    
    if (refError) {
      console.error('Error fetching crop references:', refError);
    }
    
    // Create map for quick lookup
    const refMap = new Map();
    if (references) {
      references.forEach(ref => {
        refMap.set(ref.name, ref);
      });
    }
    
    // Calculate progress and stage for each crop
    const updatedCrops = crops.map(crop => {
      const cropRef = refMap.get(crop.name.toLowerCase());
      
      // If no reference data or no planting date, use existing values
      if (!cropRef || !crop.planting_date) {
        return {
          ...crop,
          progress: crop.manual_progress !== null ? crop.manual_progress : (crop.progress || 0),
          stage: crop.status,
          auto_update_enabled: crop.auto_update_enabled !== false,
          days_planted: 0,
          days_to_harvest: null
        };
      }
      
      const daysPlanted = Math.max(0, Math.floor((new Date() - new Date(crop.planting_date)) / (1000 * 60 * 60 * 24)));
      const progress = calculateCropProgress(crop.planting_date, cropRef, crop.manual_progress);
      const stage = determineGrowthStage(daysPlanted, cropRef);
      
      return {
        ...crop,
        progress: progress,
        stage: stage,
        days_planted: daysPlanted,
        days_to_harvest: cropRef.days_to_harvest,
        auto_update_enabled: crop.auto_update_enabled !== false,
        crop_reference: cropRef
      };
    });
    
    res.status(200).json({
      success: true,
      count: updatedCrops.length,
      crops: updatedCrops
    });
    
  } catch (error) {
    console.error('Get crops error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch crops' 
    });
  }
});

// ============ EXISTING ROUTES (unchanged) ============

// Get crops by garden
router.get('/garden/:gardenId', authenticateToken, async (req, res) => {
  try {
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

    // Get crop reference for growth calculation
    const cropRef = await getCropReference(crop.name);
    
    let enhancedCrop = { ...crop };
    
    if (cropRef && crop.planting_date) {
      const daysPlanted = Math.max(0, Math.floor((new Date() - new Date(crop.planting_date)) / (1000 * 60 * 60 * 24)));
      const progress = calculateCropProgress(crop.planting_date, cropRef, crop.manual_progress);
      const stage = determineGrowthStage(daysPlanted, cropRef);
      
      enhancedCrop = {
        ...crop,
        progress: progress,
        stage: stage,
        days_planted: daysPlanted,
        days_to_harvest: cropRef.days_to_harvest,
        auto_update_enabled: crop.auto_update_enabled !== false
      };
    }

    res.status(200).json({
      success: true,
      crop: enhancedCrop
    });
  } catch (error) {
    console.error('Get crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch crop' 
    });
  }
});

// ============ NEW ROUTE: Manually update crop progress ============

// PUT /api/crops/:id/progress - Manually update crop progress
router.put('/:id/progress', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { manual_progress, notes } = req.body;
    
    // Verify ownership
    const { data: crop, error: checkError } = await supabase
      .from('crops')
      .select('user_id')
      .eq('id', id)
      .single();
    
    if (checkError || !crop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found'
      });
    }
    
    if (crop.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    const updateData = {
      manual_progress: manual_progress !== undefined ? manual_progress : null,
      updated_at: new Date().toISOString()
    };
    
    if (notes !== undefined) updateData.notes = notes;
    
    // If manual_progress is set, also update the status to match
    if (manual_progress !== undefined) {
      // Get crop reference to determine stage from progress
      const { data: cropData } = await supabase
        .from('crops')
        .select('name')
        .eq('id', id)
        .single();
      
      if (cropData) {
        const cropRef = await getCropReference(cropData.name);
        if (cropRef) {
          // Determine stage based on progress percentage
          let newStatus = 'seedling';
          if (manual_progress >= 80) newStatus = 'harvest';
          else if (manual_progress >= 60) newStatus = 'fruiting';
          else if (manual_progress >= 40) newStatus = 'flowering';
          else if (manual_progress >= 20) newStatus = 'vegetative';
          else newStatus = 'seedling';
          
          updateData.status = newStatus;
        }
      }
    }
    
    const { data: updatedCrop, error } = await supabase
      .from('crops')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(200).json({
      success: true,
      message: manual_progress !== undefined ? 'Crop progress updated manually' : 'Crop updated',
      crop: updatedCrop
    });
    
  } catch (error) {
    console.error('Update crop progress error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update crop' 
    });
  }
});

// ============ NEW ROUTE: Toggle auto-update for a crop ============

// POST /api/crops/:id/auto-update - Toggle auto-update
router.post('/:id/auto-update', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { enabled } = req.body;
    
    // Verify ownership
    const { data: crop, error: checkError } = await supabase
      .from('crops')
      .select('user_id')
      .eq('id', id)
      .single();
    
    if (checkError || !crop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found'
      });
    }
    
    if (crop.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    // If enabling auto-update, clear manual progress
    const updateData = {
      auto_update_enabled: enabled,
      updated_at: new Date().toISOString()
    };
    
    if (enabled) {
      updateData.manual_progress = null;
    }
    
    const { data: updatedCrop, error } = await supabase
      .from('crops')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.status(200).json({
      success: true,
      message: enabled ? 'Auto-update enabled' : 'Auto-update disabled',
      crop: updatedCrop
    });
    
  } catch (error) {
    console.error('Toggle auto-update error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update auto-update setting' 
    });
  }
});

// ============ UPDATED CREATE CROP ROUTE (with auto-growth columns) ============

// Create new crop - UPDATED with auto-growth columns
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
      name: name.toLowerCase(),
      category: category || 'vegetable',
      variety: variety || null,
      planting_date: planting_date || new Date().toISOString(),
      expected_harvest: expected_harvest || null,
      status: status || 'seedling',
      progress: progress || 0,
      notes: notes || null,
      image_url: image_url || null,
      is_shared: is_shared || false,
      quantity: quantity || 1,
      quantity_unit: quantity_unit || null,
      auto_update_enabled: true,  // NEW: Enable auto-update by default
      manual_progress: null,       // NEW: No manual override initially
      maturity_updated_at: new Date().toISOString(), // NEW: Track last update
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: crop, error } = await supabase
      .from('crops')
      .insert([cropData])
      .select()
      .single();

    if (error) throw error;

    // Get crop reference for additional info
    const cropRef = await getCropReference(name);
    
    res.status(201).json({
      success: true,
      message: 'Crop created successfully',
      crop: {
        ...crop,
        days_to_harvest: cropRef?.days_to_harvest || null,
        crop_reference: cropRef
      }
    });
  } catch (error) {
    console.error('Create crop error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create crop' 
    });
  }
});

// ============ EXISTING UPDATE ROUTE (enhanced) ============

// Update crop - ENHANCED to handle auto-growth fields
router.put('/:id', authenticateToken, async (req, res) => {
  try {
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

// ============ EXISTING DELETE ROUTES ============

// Delete crop image
router.delete('/image/:cropId', authenticateToken, async (req, res) => {
  try {
    const { data: crop, error: fetchError } = await supabase
      .from('crops')
      .select('image_url')
      .eq('id', req.params.cropId)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !crop) {
      return res.status(404).json({
        success: false,
        error: 'Crop not found'
      });
    }

    if (crop?.image_url) {
      try {
        const publicId = crop.image_url.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`harvest-hub/crops/${publicId}`);
      } catch (cloudinaryError) {
        console.error('Cloudinary delete error:', cloudinaryError);
      }
    }

    const { error: updateError } = await supabase
      .from('crops')
      .update({ image_url: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.cropId);

    if (updateError) {
      throw updateError;
    }

    res.status(200).json({
      success: true,
      message: 'Crop image removed successfully'
    });

  } catch (error) {
    console.error('Delete crop image error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete image'
    });
  }
});

module.exports = router;










// // const express = require('express');
// // const router = express.Router();
// // const supabase = require('../supabase');
// // const { authenticateToken } = require('../middleware/auth');


// const express = require('express');
// const router = express.Router();
// const supabase = require('../supabase');
// const { authenticateToken } = require('../middleware/auth');
// const cloudinary = require('cloudinary').v2;
// const multer = require('multer');
// const { CloudinaryStorage } = require('multer-storage-cloudinary');

// // Configure Cloudinary
// cloudinary.config({
//   cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
//   api_key: process.env.CLOUDINARY_API_KEY,
//   api_secret: process.env.CLOUDINARY_API_SECRET
// });

// // Configure multer storage for Cloudinary - CROPS folder
// const cropStorage = new CloudinaryStorage({
//   cloudinary: cloudinary,
//   params: {
//     folder: 'harvest-hub/crops', // Different folder for crops
//     allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
//     transformation: [{ width: 800, height: 800, crop: 'limit' }] // Larger for crops
//   }
// });

// const uploadCrop = multer({ storage: cropStorage });

// // Upload crop image
// router.post('/upload-image', authenticateToken, uploadCrop.single('image'), async (req, res) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({
//         success: false,
//         error: 'No image file provided'
//       });
//     }

//     const imageUrl = req.file.path;
    
//     res.status(200).json({
//       success: true,
//       message: 'Crop image uploaded successfully',
//       imageUrl
//     });

//   } catch (error) {
//     console.error('Upload crop image error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to upload image'
//     });
//   }
// });


// // Handle base64 image upload for web
// // Add this new endpoint for web uploads (base64)
// router.post('/upload-image-web', authenticateToken, async (req, res) => {
//   try {
//     const { image, fileName } = req.body;
    
//     if (!image) {
//       return res.status(400).json({
//         success: false,
//         error: 'No image data provided'
//       });
//     }

//     console.log('📤 Received base64 image, length:', image.length);

//     // Upload to Cloudinary using base64
//     const result = await cloudinary.uploader.upload(`data:image/jpeg;base64,${image}`, {
//       folder: 'harvest-hub/crops',
//       public_id: `crop_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`,
//     });

//     console.log('✅ Cloudinary upload successful:', result.secure_url);

//     res.status(200).json({
//       success: true,
//       message: 'Crop image uploaded successfully',
//       imageUrl: result.secure_url
//     });

//   } catch (error) {
//     console.error('❌ Upload crop image error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to upload image: ' + error.message
//     });
//   }
// });

// // Get all crops for current user now and even later
// router.get('/', authenticateToken, async (req, res) => {
//   try {
//     const { data: crops, error } = await supabase
//       .from('crops')
//       .select('*')
//       .eq('user_id', req.user.id)
//       .order('created_at', { ascending: false });

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       count: crops.length,
//       crops
//     });
//   } catch (error) {
//     console.error('Get crops error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch crops' 
//     });
//   }
// });

// // Get crops by garden
// router.get('/garden/:gardenId', authenticateToken, async (req, res) => {
//   try {
//     // Verify garden belongs to user
//     const { data: garden, error: gardenError } = await supabase
//       .from('gardens')
//       .select('id')
//       .eq('id', req.params.gardenId)
//       .eq('user_id', req.user.id)
//       .single();

//     if (gardenError || !garden) {
//       return res.status(404).json({
//         success: false,
//         error: 'Garden not found or access denied'
//       });
//     }

//     const { data: crops, error } = await supabase
//       .from('crops')
//       .select('*')
//       .eq('garden_id', req.params.gardenId)
//       .order('created_at', { ascending: false });

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       count: crops.length,
//       crops
//     });
//   } catch (error) {
//     console.error('Get garden crops error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch garden crops' 
//     });
//   }
// });

// // Get single crop
// router.get('/:id', authenticateToken, async (req, res) => {
//   try {
//     const { data: crop, error } = await supabase
//       .from('crops')
//       .select(`
//         *,
//         gardens (
//           name,
//           location
//         )
//       `)
//       .eq('id', req.params.id)
//       .eq('user_id', req.user.id)
//       .single();

//     if (error) throw error;

//     if (!crop) {
//       return res.status(404).json({
//         success: false,
//         error: 'Crop not found'
//       });
//     }

//     res.status(200).json({
//       success: true,
//       crop
//     });
//   } catch (error) {
//     console.error('Get crop error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to fetch crop' 
//     });
//   }
// });


// // Add this new e
// // Create new crop
// // router.post('/', authenticateToken, async (req, res) => {
// //   try {
// //     const { 
// //       garden_id, 
// //       name, 
// //       category, 
// //       variety, 
// //       planting_date, 
// //       expected_harvest, 
// //       status, 
// //       progress, 
// //       notes, 
// //       image_url, 
// //       is_shared, 
// //       quantity, 
// //       quantity_unit 
// //     } = req.body;

// //     if (!name || !garden_id) {
// //       return res.status(400).json({
// //         success: false,
// //         error: 'Crop name and garden ID are required'
// //       });
// //     }

// //     // Verify garden belongs to user
// //     const { data: garden, error: gardenError } = await supabase
// //       .from('gardens')
// //       .select('id')
// //       .eq('id', garden_id)
// //       .eq('user_id', req.user.id)
// //       .single();

// //     if (gardenError || !garden) {
// //       return res.status(404).json({
// //         success: false,
// //         error: 'Garden not found or access denied'
// //       });
// //     }

// //     const cropData = {
// //       garden_id,
// //       user_id: req.user.id,
// //       name,
// //       category: category || 'vegetable',
// //       variety: variety || null,
// //       planting_date: planting_date || null,
// //       expected_harvest: expected_harvest || null,
// //       status: status || 'seedling',
// //       progress: progress || 0,
// //       notes: notes || null,
// //       image_url: image_url || null,
// //       is_shared: is_shared || false,
// //       quantity: quantity || 1,
// //       quantity_unit: quantity_unit || null,
// //       created_at: new Date().toISOString(),
// //       updated_at: new Date().toISOString()
// //     };

// //     const { data: crop, error } = await supabase
// //       .from('crops')
// //       .insert([cropData])
// //       .select()
// //       .single();

// //     if (error) throw error;

// //     res.status(201).json({
// //       success: true,
// //       message: 'Crop created successfully',
// //       crop
// //     });
// //   } catch (error) {
// //     console.error('Create crop error:', error);
// //     res.status(500).json({ 
// //       success: false,
// //       error: 'Failed to create crop' 
// //     });
// //   }
// // });

// // Update your existing POST route to handle image_url
// router.post('/', authenticateToken, async (req, res) => {
//   try {
//     const { 
//       garden_id, 
//       name, 
//       category, 
//       variety, 
//       planting_date, 
//       expected_harvest, 
//       status, 
//       progress, 
//       notes, 
//       image_url, // This will come from the upload first
//       is_shared, 
//       quantity, 
//       quantity_unit 
//     } = req.body;

//     if (!name || !garden_id) {
//       return res.status(400).json({
//         success: false,
//         error: 'Crop name and garden ID are required'
//       });
//     }

//     // Verify garden belongs to user
//     const { data: garden, error: gardenError } = await supabase
//       .from('gardens')
//       .select('id')
//       .eq('id', garden_id)
//       .eq('user_id', req.user.id)
//       .single();

//     if (gardenError || !garden) {
//       return res.status(404).json({
//         success: false,
//         error: 'Garden not found or access denied'
//       });
//     }

//     const cropData = {
//       garden_id,
//       user_id: req.user.id,
//       name,
//       category: category || 'vegetable',
//       variety: variety || null,
//       planting_date: planting_date || null,
//       expected_harvest: expected_harvest || null,
//       status: status || 'seedling',
//       progress: progress || 0,
//       notes: notes || null,
//       image_url: image_url || null, // Now accepts image_url
//       is_shared: is_shared || false,
//       quantity: quantity || 1,
//       quantity_unit: quantity_unit || null,
//       created_at: new Date().toISOString(),
//       updated_at: new Date().toISOString()
//     };

//     const { data: crop, error } = await supabase
//       .from('crops')
//       .insert([cropData])
//       .select()
//       .single();

//     if (error) throw error;

//     res.status(201).json({
//       success: true,
//       message: 'Crop created successfully',
//       crop
//     });
//   } catch (error) {
//     console.error('Create crop error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to create crop' 
//     });
//   }
// });


// // Update crop
// router.put('/:id', authenticateToken, async (req, res) => {
//   try {
//     // First check if crop exists and belongs to user
//     const { data: existingCrop, error: checkError } = await supabase
//       .from('crops')
//       .select('*')
//       .eq('id', req.params.id)
//       .eq('user_id', req.user.id)
//       .single();

//     if (checkError || !existingCrop) {
//       return res.status(404).json({
//         success: false,
//         error: 'Crop not found or access denied'
//       });
//     }

//     const updateData = {
//       name: req.body.name || existingCrop.name,
//       category: req.body.category || existingCrop.category,
//       variety: req.body.variety !== undefined ? req.body.variety : existingCrop.variety,
//       planting_date: req.body.planting_date !== undefined ? req.body.planting_date : existingCrop.planting_date,
//       expected_harvest: req.body.expected_harvest !== undefined ? req.body.expected_harvest : existingCrop.expected_harvest,
//       status: req.body.status || existingCrop.status,
//       progress: req.body.progress !== undefined ? req.body.progress : existingCrop.progress,
//       notes: req.body.notes !== undefined ? req.body.notes : existingCrop.notes,
//       image_url: req.body.image_url !== undefined ? req.body.image_url : existingCrop.image_url,
//       is_shared: req.body.is_shared !== undefined ? req.body.is_shared : existingCrop.is_shared,
//       quantity: req.body.quantity !== undefined ? req.body.quantity : existingCrop.quantity,
//       quantity_unit: req.body.quantity_unit !== undefined ? req.body.quantity_unit : existingCrop.quantity_unit,
//       updated_at: new Date().toISOString()
//     };

//     const { data: crop, error } = await supabase
//       .from('crops')
//       .update(updateData)
//       .eq('id', req.params.id)
//       .select()
//       .single();

//     if (error) throw error;

//     res.status(200).json({
//       success: true,
//       message: 'Crop updated successfully',
//       crop
//     });
//   } catch (error) {
//     console.error('Update crop error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to update crop' 
//     });
//   }
// });

// // Delete crop
// // router.delete('/:id', authenticateToken, async (req, res) => {
// //   try {
// //     // First check if crop exists and belongs to user
// //     const { data: existingCrop, error: checkError } = await supabase
// //       .from('crops')
// //       .select('id')
// //       .eq('id', req.params.id)
// //       .eq('user_id', req.user.id)
// //       .single();

// //     if (checkError || !existingCrop) {
// //       return res.status(404).json({
// //         success: false,
// //         error: 'Crop not found or access denied'
// //       });
// //     }

// //     const { error } = await supabase
// //       .from('crops')
// //       .delete()
// //       .eq('id', req.params.id);

// //     if (error) throw error;

// //     res.status(200).json({
// //       success: true,
// //       message: 'Crop deleted successfully'
// //     });
// //   } catch (error) {
// //     console.error('Delete crop error:', error);
// //     res.status(500).json({ 
// //       success: false,
// //       error: 'Failed to delete crop' 
// //     });
// //   }
// // });




// // Delete crop image
// router.delete('/image/:cropId', authenticateToken, async (req, res) => {
//   try {
//     // Get crop to find image URL
//     const { data: crop, error: fetchError } = await supabase
//       .from('crops')
//       .select('image_url')
//       .eq('id', req.params.cropId)
//       .eq('user_id', req.user.id)
//       .single();

//     if (fetchError || !crop) {
//       return res.status(404).json({
//         success: false,
//         error: 'Crop not found'
//       });
//     }

//     // Delete from Cloudinary if exists
//     if (crop?.image_url) {
//       try {
//         const publicId = crop.image_url.split('/').pop().split('.')[0];
//         await cloudinary.uploader.destroy(`harvest-hub/crops/${publicId}`);
//       } catch (cloudinaryError) {
//         console.error('Cloudinary delete error:', cloudinaryError);
//       }
//     }

//     // Update crop to remove image URL
//     const { error: updateError } = await supabase
//       .from('crops')
//       .update({ image_url: null, updated_at: new Date().toISOString() })
//       .eq('id', req.params.cropId);

//     if (updateError) {
//       throw updateError;
//     }

//     res.status(200).json({
//       success: true,
//       message: 'Crop image removed successfully'
//     });

//   } catch (error) {
//     console.error('Delete crop image error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to delete image'
//     });
//   }
// });

// module.exports = router;
