const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');

const {
  decideRecoveryAction,
} = require('../services/recoveryDecisionService');

const {
  executeRecoveryAction,
} = require('../services/recoveryExecutionService');

const {
  confirmRecovery,
} = require('../services/recoveryConfirmationService');

const {
  runAIRecoveryAnalysis,
} = require('../services/aiRecoveryAnalysisRunner');

/**
 * GET /api/recovery/cases
 */
async function getRecoveryCases(req, res) {
  try {
    const merchantId =
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    const {
      status,
    } = req.query;

    const allowedStatuses = [
      'OPEN',
      'ACTION_SCHEDULED',
      'ACTION_EXECUTED',
      'RECOVERED',
      'FAILED',
      'ESCALATED',
      'EXPIRED',
      'STOPPED',
    ];

    const query = {
      merchantId,
    };

    if (status) {
      if (
        !allowedStatuses.includes(
          status,
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Invalid recovery status: ${status}.`,
          allowedStatuses,
        });
      }

      query.status = status;
    }

    const cases =
      await RecoveryCase.find(
        query,
      )
        .sort({
          createdAt: -1,
        })
        .select(
          '_id type status amountAtRiskMinor eligibleAmountMinor recoveredAmountMinor currentAction recoveryWindowEndsAt retryAttemptCount reminderCount customerId sourceTransactionId subscriptionId',
        )
        .lean();

    return res.status(200).json({
      success: true,

      data: {
        count: cases.length,

        status:
          status || 'ALL',

        cases,
      },
    });
  } catch (error) {
    console.error(
      'Recovery cases fetch error:',
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        'Failed to fetch recovery cases.',
    });
  }
}

/**
 * GET /api/recovery/cases/:recoveryCaseId/timeline
 *
 * Returns:
 * - customer
 * - source transaction
 * - audit timeline
 */
async function getRecoveryCaseTimeline(
  req,
  res,
) {
  try {
    const {
      recoveryCaseId,
    } = req.params;

    const merchantId =
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    if (!recoveryCaseId) {
      return res.status(400).json({
        success: false,
        message:
          'recoveryCaseId is required.',
      });
    }

    const recoveryCase =
      await RecoveryCase.findOne({
        _id: recoveryCaseId,
        merchantId,
      })
        .select(
          '_id customerId sourceTransactionId subscriptionId',
        )
        .lean();

    if (!recoveryCase) {
      return res.status(404).json({
        success: false,
        message:
          'Recovery case not found.',
      });
    }

    const [
      customer,
      sourceTransaction,
      timeline,
    ] = await Promise.all([
      require('../models/Customer')
        .findOne({
          _id:
            recoveryCase.customerId,
          merchantId,
        })
        .select(
          '_id fullName name email phone externalCustomerId providerCustomerId customerId',
        )
        .lean(),

      Transaction.findOne({
        _id:
          recoveryCase.sourceTransactionId,

        merchantId,
      })
        .select(
          '_id transactionId type status amountMinor currency paymentMethod failureCategory failureCode failureReason failureStage occurredAt providerOrderId providerPaymentId providerEventId',
        )
        .lean(),

      AuditLog.find({
        merchantId,

        recoveryCaseId:
          recoveryCase._id,
      })
        .sort({
          occurredAt: 1,
        })
        .select(
          '_id actorType eventType action result message metadata occurredAt transactionId subscriptionId externalEventId',
        )
        .lean(),
    ]);

    return res.status(200).json({
      success: true,

      data: {
        recoveryCaseId:
          recoveryCase._id,

        customer:
          customer || null,

        sourceTransaction:
          sourceTransaction || null,

        count:
          timeline.length,

        timeline,
      },
    });
  } catch (error) {
    console.error(
      'Recovery case timeline error:',
      error,
    );

    if (
      error.name === 'CastError'
    ) {
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
        'Failed to fetch case context.',
    });
  }
}

/**
 * POST /api/recovery/ai-analysis
 *
 * Two supported modes:
 *
 * Selected case:
 * {
 *   recoveryCaseId: "..."
 * }
 *
 * Batch:
 * {
 *   limit: 20,
 *   batchSize: 5,
 *   activeOnly: true
 * }
 */
async function runAIRecoveryAnalysisController(
  req,
  res,
) {
  try {
    const merchantId =
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    const {
      recoveryCaseId,
      limit = 20,
      batchSize = 5,
      activeOnly = false,
    } = req.body || {};

    /*
     * --------------------------------------------------
     * SELECTED CASE MODE
     * --------------------------------------------------
     */

    if (recoveryCaseId) {
      const result =
        await runAIRecoveryAnalysis({
          merchantId,

          recoveryCaseId,

          limit: 1,

          batchSize: 1,

          activeOnly: true,
        });

      return res.status(200).json({
        success: true,

        data: result,
      });
    }

    /*
     * --------------------------------------------------
     * BATCH MODE
     * --------------------------------------------------
     */

    const parsedLimit =
      Number(limit);

    if (
      !Number.isInteger(
        parsedLimit,
      ) ||
      parsedLimit <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'limit must be a positive integer.',
      });
    }

    const parsedBatchSize =
      Number(batchSize);

    if (
      !Number.isInteger(
        parsedBatchSize,
      ) ||
      parsedBatchSize <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'batchSize must be a positive integer.',
      });
    }

    const result =
      await runAIRecoveryAnalysis({
        merchantId,

        limit:
          parsedLimit,

        batchSize:
          parsedBatchSize,

        activeOnly:
          activeOnly === true,
      });

    return res.status(200).json({
      success: true,

      data: result,
    });
  } catch (error) {
    console.error(
      'AI recovery analysis error:',
      error,
    );

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message:
          'Invalid recoveryCaseId.',
      });
    }

    if (
      error.status === 404
    ) {
      return res.status(404).json({
        success: false,
        message:
          error.message,
      });
    }

    /*
     * Preserve Gemini rate-limit status.
     */
    if (
      error.status === 429
    ) {
      return res.status(429).json({
        success: false,
        message:
          error.message ||
          'AI service is temporarily rate-limited.',
      });
    }

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        'Failed to run AI recovery analysis.',
    });
  }
}

/**
 * POST /api/recovery/execute
 */
async function decideAndExecuteRecovery(
  req,
  res,
) {
  try {
    const {
      recoveryCaseId,
    } = req.body;

    if (!recoveryCaseId) {
      return res.status(400).json({
        success: false,
        message:
          'recoveryCaseId is required.',
      });
    }

    const merchantId =
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    const recoveryCase =
      await RecoveryCase.findOne({
        _id: recoveryCaseId,
        merchantId,
      }).lean();

    if (!recoveryCase) {
      return res.status(404).json({
        success: false,
        message:
          'Recovery case not found.',
      });
    }

    const sourceTransaction =
      await Transaction.findOne({
        _id:
          recoveryCase.sourceTransactionId,

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

    const decision =
      decideRecoveryAction({
        failureCategory:
          sourceTransaction.failureCategory,

        caseType:
          recoveryCase.type,

        status:
          recoveryCase.status,

        retryAttemptCount:
          recoveryCase.retryAttemptCount ||
          0,

        reminderCount:
          recoveryCase.reminderCount ||
          0,

        eligibleAmountMinor:
          recoveryCase.eligibleAmountMinor ||
          0,

        recoveredAmountMinor:
          recoveryCase.recoveredAmountMinor ||
          0,

        recoveryWindowEndsAt:
          recoveryCase.recoveryWindowEndsAt,

        policySnapshot:
          recoveryCase.policySnapshot ||
          {},

        currentAction:
          recoveryCase.currentAction ||
          null,
      });

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
          execution.status,

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

    if (
      error.name === 'CastError'
    ) {
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
 * POST /api/recovery/confirm
 */
async function confirmRecoveryController(
  req,
  res,
) {
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

    const merchantId =
      req.user?.userId;

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

    if (
      error.name === 'CastError'
    ) {
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
  getRecoveryCases,
  getRecoveryCaseTimeline,
  runAIRecoveryAnalysisController,
  decideAndExecuteRecovery,
  confirmRecoveryController,
};