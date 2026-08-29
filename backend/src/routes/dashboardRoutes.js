const express = require('express');

const {
  getDashboardOverviewController,
} = require('../controllers/dashboardController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router =
  express.Router();

router.get(
  '/overview',
  requireAuth,
  getDashboardOverviewController,
);

module.exports = router;