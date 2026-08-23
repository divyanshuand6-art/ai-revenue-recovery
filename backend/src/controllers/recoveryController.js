const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');

const {
  decideRecoveryAction,
} = require('../services/recoveryDecisionService');

const {
  executeRecoveryAction,
} = require('../services/recoveryExecutionService');

const {
  confirmRecovery,
} = require('../services/recoveryConfirmationService');

/**
 * Decide the correct recovery action and execute
 * the bounded workflow action.
 *
 * POST /api/recovery/execute
 */
async function decideAndExecuteRecovery(req, res) {
  try {
    const { recoveryCaseId } = req.body;

    if (!recoveryCaseId) {
      return res.status(400).json({
        success: false,
        message: 'recoveryCaseId is required.',
      });
    }

    /*
     * --------------------------------------------------
     * 1. Resolve authenticated merchant
     * --------------------------------------------------
     */

    const merchantId = req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    /*
     * --------------------------------------------------
     * 2. Find recovery case belonging to merchant
     * --------------------------------------------------
     */

    const recoveryCase =
      await RecoveryCase.findOne({
        _id: recoveryCaseId,
        merchantId,
      }).lean();

    if (!recoveryCase) {
      return res.status(404).json({
        success: false,
        message: 'Recovery case not found.',
      });
    }

    /*
     * --------------------------------------------------
     * 3. Find the source transaction
     * --------------------------------------------------
     *
     * failureCategory belongs to Transaction,
     * NOT RecoveryCase.
     */

    const sourceTransaction =
      await Transaction.findOne({
        _id: recoveryCase.sourceTransactionId,
        merchantId,
      })
        .select(
          '_id failureCategory paymentMethod type amountMinor occurredAt',
        )
        .lean();

    if (!sourceTransaction) {
      return res.status(404).json({
        success: false,
        message:
          'Source transaction for this recovery case was not found.',
      });
    }

    /*
     * --------------------------------------------------
     * 4. Ask the decision engine what should happen
     * --------------------------------------------------
     */

    const decision =
      decideRecoveryAction({
        failureCategory:
          sourceTransaction.failureCategory,

        caseType:
          recoveryCase.type,

        status:
          recoveryCase.status,

        retryAttemptCount:
          recoveryCase.retryAttemptCount || 0,

        reminderCount:
          recoveryCase.reminderCount || 0,

        eligibleAmountMinor:
          recoveryCase.eligibleAmountMinor || 0,

        recoveredAmountMinor:
          recoveryCase.recoveredAmountMinor || 0,

        recoveryWindowEndsAt:
          recoveryCase.recoveryWindowEndsAt,

        policySnapshot:
          recoveryCase.policySnapshot || {},

        currentAction:
          recoveryCase.currentAction || null,
      });

    /*
     * --------------------------------------------------
     * 5. Execute the bounded decision
     * --------------------------------------------------
     */

    const execution =
      await executeRecoveryAction({
        recoveryCaseId:
          recoveryCase._id,

        action:
          decision.action,

        reason:
          decision.reason,

        actor:
          'RECOVERY_ENGINE',
      });

    /*
     * --------------------------------------------------
     * IMPORTANT:
     *
     * Executing an action does NOT mean money has
     * actually been recovered.
     *
     * Payment confirmation happens separately through:
     *
     * POST /api/recovery/confirm
     * --------------------------------------------------
     */

    return res.status(200).json({
      success: true,

      data: {
        recoveryCaseId:
          recoveryCase._id,

        sourceTransactionId:
          sourceTransaction._id,

        failureCategory:
          sourceTransaction.failureCategory ||
          null,

        paymentMethod:
          sourceTransaction.paymentMethod ||
          null,

        caseType:
          recoveryCase.type,

        currentStatus:
          recoveryCase.status,

        decision,

        execution,

        recoveryConfirmed:
          false,

        message:
          'Recovery decision processed. Money is counted as recovered only after payment confirmation.',
      },
    });
  } catch (error) {
    console.error(
      'Recovery decision/execution error:',
      error,
    );

    /*
     * Invalid MongoDB ObjectId should be a client error.
     */

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message:
          'Invalid recoveryCaseId.',
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        'Failed to process recovery case.',
    });
  }
}

/**
 * Confirm that a successful payment actually
 * recovered money.
 *
 * POST /api/recovery/confirm
 */
async function confirmRecoveryController(req, res) {
  try {
    const {
      recoveryCaseId,
      recoveredAmountMinor,
      paymentTransactionId,
    } = req.body;

    if (!recoveryCaseId) {
      return res.status(400).json({
        success: false,
        message:
          'recoveryCaseId is required.',
      });
    }

    /*
     * Resolve authenticated merchant.
     */

    const merchantId = req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    if (
      !Number.isInteger(
        recoveredAmountMinor,
      ) ||
      recoveredAmountMinor <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'recoveredAmountMinor must be a positive integer.',
      });
    }

    /*
     * The confirmation service also verifies
     * merchant ownership.
     */

    const result =
      await confirmRecovery({
        recoveryCaseId,

        merchantId,

        recoveredAmountMinor,

        paymentTransactionId:
          paymentTransactionId ||
          null,

        actor:
          'SYSTEM',
      });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(
      'Recovery confirmation error:',
      error,
    );

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message:
          'Invalid recoveryCaseId or paymentTransactionId.',
      });
    }

    return res.status(400).json({
      success: false,
      message:
        error.message ||
        'Failed to confirm recovery.',
    });
  }
}

module.exports = {
  decideAndExecuteRecovery,
  confirmRecoveryController,
};