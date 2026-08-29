const express = require('express');

const {
  getRecoveryCases,
  getRecoveryCaseTimeline,
  runAIRecoveryAnalysisController,
  decideAndExecuteRecovery,
  confirmRecoveryController,
} = require('../controllers/recoveryController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router = express.Router();

router.use(requireAuth);

router.get(
  '/cases',
  getRecoveryCases,
);

router.get(
  '/cases/:recoveryCaseId/timeline',
  getRecoveryCaseTimeline,
);

router.post(
  '/ai-analysis',
  runAIRecoveryAnalysisController,
);

router.post(
  '/execute',
  decideAndExecuteRecovery,
);

router.post(
  '/confirm',
  confirmRecoveryController,
);

module.exports = router;