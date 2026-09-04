const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');

const {
  simulateSuccessfulRecoveryPayment,
} = require('../services/recoveryPaymentService');

const {
  executeRecoveryAction,
} = require('../services/recoveryExecutionService');

const {
  confirmRecovery,
} = require('../services/recoveryConfirmationService');

const {
  runAIRecoveryAnalysis,
} = require('../services/aiRecoveryAnalysisRunner');

const {
  validateAIRecommendation,
} = require('../services/aiRecommendationValidationService');


const {
  executeRecoveryCasesInBulk,
} = require('../services/bulkRecoveryExecutionService');
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
        _id:
          recoveryCaseId,
        merchantId,
      })
        .select(
          [
            '_id',
            'customerId',
            'sourceTransactionId',
            'subscriptionId',
            'status',
            'currentAction',
            'actionTaken',
            'amountAtRiskMinor',
            'eligibleAmountMinor',
            'recoveredAmountMinor',
            'recoveryTransactionId',
            'currency',
            'recoveredAt',
          ].join(' '),
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

        case: {
          _id:
            recoveryCase._id,

          status:
            recoveryCase.status,

          currentAction:
            recoveryCase.currentAction ||
            null,

          actionTaken:
            recoveryCase.actionTaken ||
            null,

          amountAtRiskMinor:
            recoveryCase.amountAtRiskMinor,

          eligibleAmountMinor:
            recoveryCase.eligibleAmountMinor,

          recoveredAmountMinor:
            recoveryCase.recoveredAmountMinor,

          recoveryTransactionId:
            recoveryCase.recoveryTransactionId ||
            null,

          currency:
            recoveryCase.currency ||
            'INR',

          recoveredAt:
            recoveryCase.recoveredAt ||
            null,
        },

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
 *   activeOnly: true,
 *   from: "2026-08-01",
 *   to: "2026-08-31",
 *   status: "ALL"
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

      from,

      to,

      status = 'ALL',
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

          limit:
            1,

          batchSize:
            1,

          activeOnly:
            true,
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

    /*
     * --------------------------------------------------
     * DATE VALIDATION
     * --------------------------------------------------
     */

    if (
      from !== undefined &&
      from !== null &&
      from !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(
        String(from),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'from must use YYYY-MM-DD format.',
      });
    }

    if (
      to !== undefined &&
      to !== null &&
      to !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(
        String(to),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'to must use YYYY-MM-DD format.',
      });
    }

    if (
      from &&
      to &&
      from > to
    ) {
      return res.status(400).json({
        success: false,
        message:
          'from cannot be later than to.',
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

        from:
          from || undefined,

        to:
          to || undefined,

        status:
          status || 'ALL',
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

    if (
      error.name ===
      'CastError'
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid recoveryCaseId.',
      });
    }

    if (
      error.status === 400
    ) {
      return res.status(400).json({
        success: false,
        message:
          error.message ||
          'Invalid AI analysis request.',
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

/*
 * --------------------------------------------------
 * POST /api/recovery/execute
 * --------------------------------------------------
 *
 * IMPORTANT:
 *
 * Execution must consume the AI decision that was
 * already analyzed + persisted on the recovery case.
 *
 * Flow:
 *
 * saved agentDecision.finalAction
 *          ↓
 * current-state policy revalidation
 *          ↓
 * execute only the validated final action
 *
 * This function MUST NOT independently choose a new
 * action using decideRecoveryAction().
 */
async function decideAndExecuteRecovery(
  req,
  res,
) {
  try {
    const {
      recoveryCaseId,
    } = req.body || {};

    /*
     * --------------------------------------------------
     * 1. BASIC REQUEST VALIDATION
     * --------------------------------------------------
     */

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

    /*
     * --------------------------------------------------
     * 2. LOAD OWNED RECOVERY CASE
     * --------------------------------------------------
     */

    const recoveryCase =
      await RecoveryCase.findOne({
        _id:
          recoveryCaseId,
        merchantId,
      });

    if (!recoveryCase) {
      return res.status(404).json({
        success: false,
        message:
          'Recovery case not found.',
      });
    }

    /*
     * --------------------------------------------------
     * 3. ACTION_EXECUTED = WAITING FOR PAYMENT
     * --------------------------------------------------
     *
     * Do NOT run policy again and accidentally turn
     * this condition into a STOP action.
     */

    if (
      recoveryCase.status ===
      'ACTION_EXECUTED'
    ) {
      return res.status(409).json({
        success: false,

        message:
          'Recovery action has already been executed and is awaiting payment confirmation.',

        data: {
          recoveryCaseId:
            recoveryCase._id,

          currentStatus:
            recoveryCase.status,

          currentAction:
            recoveryCase.currentAction ||
            null,

          recoveryConfirmed:
            false,

          awaitingPaymentConfirmation:
            true,
        },
      });
    }

    /*
     * --------------------------------------------------
     * 4. TERMINAL CASE PROTECTION
     * --------------------------------------------------
     */

    const terminalStatuses =
      new Set([
        'RECOVERED',
        'FAILED',
        'ESCALATED',
        'EXPIRED',
        'STOPPED',
      ]);

    if (
      terminalStatuses.has(
        recoveryCase.status,
      )
    ) {
      return res.status(409).json({
        success: false,

        message:
          `Recovery case is already in terminal status: ${recoveryCase.status}.`,

        data: {
          recoveryCaseId:
            recoveryCase._id,

          currentStatus:
            recoveryCase.status,

          recoveryConfirmed:
            recoveryCase.status ===
            'RECOVERED',
        },
      });
    }

    /*
     * --------------------------------------------------
     * 5. AI DECISION MUST EXIST
     * --------------------------------------------------
     *
     * AI analysis must happen before execution.
     */

    if (
      !recoveryCase.agentDecision
    ) {
      return res.status(400).json({
        success: false,

        message:
          'No AI decision is available for this recovery case. Run AI analysis before execution.',
      });
    }

    /*
     * --------------------------------------------------
     * 6. FINAL AI ACTION MUST EXIST
     * --------------------------------------------------
     *
     * A blocked analysis intentionally has no
     * executable finalAction.
     */

    const storedFinalAction =
      recoveryCase
        .agentDecision
        .finalAction ||
      recoveryCase
        .agentDecision
        .action ||
      null;

    if (!storedFinalAction) {
      return res.status(409).json({
        success: false,

        message:
          recoveryCase
            .agentDecision
            .rationale ||
          'No executable AI/policy final action is available for this recovery case.',

        data: {
          recoveryCaseId:
            recoveryCase._id,

          aiDecision:
            recoveryCase.agentDecision,

          executionAllowed:
            false,
        },
      });
    }

    /*
     * --------------------------------------------------
     * 7. LOAD SOURCE TRANSACTION
     * --------------------------------------------------
     */

    const sourceTransaction =
      await Transaction.findOne({
        _id:
          recoveryCase.sourceTransactionId,

        merchantId,
      })
        .select(
          [
            '_id',
            'type',
            'status',
            'amountMinor',
            'currency',
            'paymentMethod',
            'failureCategory',
            'failureCode',
            'failureReason',
            'failureStage',
            'occurredAt',
          ].join(' '),
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
     * 8. LOAD CUSTOMER CONTEXT
     * --------------------------------------------------
     *
     * Current policy may depend on communication
     * consent.
     */

    const customer =
      await require('../models/Customer')
        .findOne({
          _id:
            recoveryCase.customerId,

          merchantId,
        })
        .select(
          [
            '_id',
            'communicationConsent',
            'paymentHistory',
          ].join(' '),
        )
        .lean();

    /*
     * --------------------------------------------------
     * 9. REVALIDATE THE STORED AI DECISION
     * --------------------------------------------------
     *
     * This is critical.
     *
     * We trust neither the old case state nor the old
     * policy result blindly.
     *
     * We re-check the SAME stored AI recommendation
     * against the CURRENT case state and policy.
     */

    const aiRecommendation = {
      recoveryCaseId:
        String(
          recoveryCase._id,
        ),

      recommendedAction:
        storedFinalAction,

      confidence:
        Number(
          recoveryCase
            .agentDecision
            .confidence ??
          0,
        ),

      riskLevel:
        recoveryCase
          .agentDecision
          .riskLevel ||
        'MEDIUM',

      reason:
        recoveryCase
          .agentDecision
          .rationale ||
        'Persisted AI recovery decision.',
    };

    const policyValidation =
      validateAIRecommendation({
        aiRecommendation,

        recoveryCase,

        transaction:
          sourceTransaction,

        customer,

        now:
          new Date(),
      });

    /*
     * --------------------------------------------------
     * 10. HARD POLICY BLOCK
     * --------------------------------------------------
     *
     * IMPORTANT:
     *
     * Never execute STOP just because validation
     * returned a policy block.
     *
     * A blocked case should remain in its current state.
     */

    if (
      policyValidation.executionAllowed !==
      true
    ) {
      return res.status(409).json({
        success: false,

        message:
          policyValidation.message ||
          'Policy does not allow execution for this case.',

        data: {
          recoveryCaseId:
            recoveryCase._id,

          currentStatus:
            recoveryCase.status,

          storedAIAction:
            storedFinalAction,

          policyValidation,

          executionAllowed:
            false,

          recoveryConfirmed:
            false,
        },
      });
    }

    /*
     * --------------------------------------------------
     * 11. DETERMINE THE ONLY ACTION WE MAY EXECUTE
     * --------------------------------------------------
     *
     * If the persisted action is still allowed,
     * execute that SAME action.
     *
     * We are NOT calling decideRecoveryAction().
     */

    const finalAction =
      policyValidation.finalAction;

    if (!finalAction) {
      return res.status(409).json({
        success: false,

        message:
          'Policy validation did not produce an executable final action.',

        data: {
          recoveryCaseId:
            recoveryCase._id,

          policyValidation,

          executionAllowed:
            false,
        },
      });
    }

    /*
     * --------------------------------------------------
     * 12. EXECUTE THE VALIDATED AI ACTION
     * --------------------------------------------------
     */

    const execution =
      await executeRecoveryAction({
        recoveryCaseId:
          recoveryCase._id,

        action:
          finalAction,

        reason:
          policyValidation
            .aiRecommendation
            ?.reason ||
          recoveryCase
            .agentDecision
            .rationale ||
          'Validated AI recovery action.',
      });

    /*
     * --------------------------------------------------
     * 13. LOAD UPDATED CASE
     * --------------------------------------------------
     */

    const updatedCase =
      await RecoveryCase.findOne({
        _id:
          recoveryCase._id,

        merchantId,
      }).lean();

    /*
     * --------------------------------------------------
     * 14. RETURN COMPLETE PIPELINE RESULT
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

        aiDecision:
          recoveryCase.agentDecision,

        policyValidation,

        finalAction,

        execution,

        currentStatus:
          updatedCase?.status ||
          execution.status,

        currentAction:
          updatedCase?.currentAction ||
          execution.action ||
          finalAction,

        recoveryConfirmed:
          updatedCase?.status ===
          'RECOVERED',

        awaitingPaymentConfirmation:
          updatedCase?.status ===
          'ACTION_EXECUTED',

        message:
          execution.status ===
          'ACTION_EXECUTED'
            ? 'Validated AI recovery action executed. Money is counted as recovered only after payment confirmation.'
            : 'Recovery action processed successfully.',
      },
    });
  } catch (error) {
    console.error(
      'Recovery AI execution error:',
      error,
    );

    if (
      error.name ===
      'CastError'
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
        'Failed to execute the validated recovery action.',
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

async function simulateRecoveryPaymentController(
  req,
  res,
) {
  try {
    const {
      recoveryCaseId,
    } = req.body || {};

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

    const result =
      await simulateSuccessfulRecoveryPayment({
        recoveryCaseId,
        merchantId,
      });

    return res.status(200).json({
      success: true,

      data: result,
    });
  } catch (error) {
    console.error(
      'Simulated recovery payment error:',
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

    return res.status(400).json({
      success: false,
      message:
        error.message ||
        'Failed to simulate recovery payment.',
    });
  }
}

async function executeRecoveryCasesInBulkController(
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
      recoveryCaseIds,
    } = req.body || {};

    if (
      !Array.isArray(recoveryCaseIds) ||
      recoveryCaseIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'At least one recovery case is required.',
      });
    }

    const result =
      await executeRecoveryCasesInBulk({
        merchantId,
        recoveryCaseIds,
      });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(
      'executeRecoveryCasesInBulkController error:',
      error,
    );

    return res.status(400).json({
      success: false,
      message:
        error.message ||
        'Failed to execute recovery cases in bulk.',
    });
  }
}
module.exports = {
  getRecoveryCases,
  getRecoveryCaseTimeline,
  runAIRecoveryAnalysisController,
  decideAndExecuteRecovery,
  executeRecoveryCasesInBulkController,
  confirmRecoveryController,
  simulateRecoveryPaymentController,
};