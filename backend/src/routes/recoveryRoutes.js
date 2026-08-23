const express = require('express');

const {
  decideAndExecuteRecovery,
  confirmRecoveryController,
} = require('../controllers/recoveryController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router = express.Router();

/*
 * Decide which recovery action should be taken
 * and execute that bounded action.
 *
 * POST /api/recovery/execute
 */
router.post(
  '/execute',
  requireAuth,
  decideAndExecuteRecovery,
);

/*
 * Confirm that a payment actually recovered money.
 *
 * POST /api/recovery/confirm
 */
router.post(
  '/confirm',
  requireAuth,
  confirmRecoveryController,
);

module.exports = router;