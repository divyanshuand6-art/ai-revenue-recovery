const express = require('express');

const {
  getRecoveryCases,
  getRecoveryCaseTimeline,
  runAIRecoveryAnalysisController,
  decideAndExecuteRecovery,
  executeRecoveryCasesInBulkController,
  confirmRecoveryController,
} = require('../controllers/recoveryController');

const {
  requireAuth,
} = require('../middleware/authMiddleware');

const router = express.Router();

router.use(requireAuth);

/*
 * --------------------------------------------------
 * RECOVERY CASES
 * --------------------------------------------------
 */

router.get(
  '/cases',
  getRecoveryCases,
);

router.get(
  '/cases/:recoveryCaseId/timeline',
  getRecoveryCaseTimeline,
);

/*
 * --------------------------------------------------
 * AI ANALYSIS
 * --------------------------------------------------
 */

router.post(
  '/ai-analysis',
  runAIRecoveryAnalysisController,
);

/*
 * --------------------------------------------------
 * SINGLE EXECUTION
 * --------------------------------------------------
 */

router.post(
  '/execute',
  decideAndExecuteRecovery,
);

/*
 * --------------------------------------------------
 * BULK EXECUTION
 * --------------------------------------------------
 */

router.post(
  '/execute-batch',
  executeRecoveryCasesInBulkController,
);

/*
 * --------------------------------------------------
 * PAYMENT CONFIRMATION
 * --------------------------------------------------
 */

router.post(
  '/confirm',
  confirmRecoveryController,
);

module.exports = router;