const express = require('express');
const router = express.Router();

// Hardiness zones data
const hardinessZones = {
  'Zone 1': {
    name: 'Zone 1',
    tempRange: 'Below -50°F',
    color: '#2C3E5C',
    description: 'Extreme cold, very short growing season',
    suitableCrops: ['Potatoes', 'Kale', 'Carrots', 'Turnips'],
    states: ['Alaska', 'Northern Canada']
  },
  'Zone 2': {
    name: 'Zone 2',
    tempRange: '-50°F to -40°F',
    color: '#3E5A8A',
    description: 'Very cold, short growing season',
    suitableCrops: ['Potatoes', 'Cabbage', 'Peas', 'Radishes'],
    states: ['Alaska', 'Northern US']
  },
  // ... add all zones
};

// Get all zones
router.get('/', (req, res) => {
  res.json({
    success: true,
    zones: hardinessZones
  });
});

// Get zone by coordinates
router.post('/detect', (req, res) => {
  const { latitude, longitude } = req.body;
  
  // Simplified zone detection based on latitude
  let zone;
  if (latitude > 60) zone = 'Zone 1';
  else if (latitude > 55) zone = 'Zone 2';
  else if (latitude > 50) zone = 'Zone 3';
  else if (latitude > 45) zone = 'Zone 4';
  else if (latitude > 40) zone = 'Zone 5';
  else if (latitude > 35) zone = 'Zone 6';
  else if (latitude > 30) zone = 'Zone 7';
  else if (latitude > 25) zone = 'Zone 8';
  else if (latitude > 20) zone = 'Zone 9';
  else zone = 'Zone 10';
  
  res.json({
    success: true,
    zone: hardinessZones[zone],
    zoneName: zone
  });
});

module.exports = router;
