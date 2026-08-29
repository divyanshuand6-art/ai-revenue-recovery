const express = require('express');

const {
  getDashboardAnalytics,
} = require('../controllers/analyticsController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/dashboard',
  getDashboardAnalytics,
);

module.exports = router;