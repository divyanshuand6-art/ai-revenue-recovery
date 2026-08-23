const express = require('express');

const {
  getRecoveryAnalyticsController,
} = require('../controllers/analyticsController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router = express.Router();

router.get(
  '/recovery',
  requireAuth,
  getRecoveryAnalyticsController,
);

module.exports = router;