const mongoose = require('mongoose');

const Transaction = require('../models/Transaction');
const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

const RECOVERY_WINDOW_HOURS = 48;
const MAX_PAYMENT_RETRIES = 2;
const MAX_REMINDERS = 2;

/*
 * --------------------------------------------------
 * RISK RULES
 * --------------------------------------------------
 *
 * Stage 1 is deterministic.
 *
 * A transaction becomes recovery-worthy when it
 * represents revenue that was not successfully captured.
 *
 * We intentionally do NOT call Gemini here.
 *
 * Gemini belongs to Stage 2:
 * RecoveryCase -> AI analysis -> recommendation.
 * --------------------------------------------------
 */

function classifyTransactionRisk(
  transaction,
) {
  if (!transaction) {
    return {
      risky: false,
      score: 0,
      riskLevel: 'LOW',
      reason: 'Transaction does not exist.',
    };
  }

  /*
   * Successful / non-loss terminal states.
   */
  if (
    transaction.status === 'CAPTURED' ||
    transaction.status === 'AUTHORIZED' ||
    transaction.status === 'REFUNDED' ||
    transaction.status === 'CANCELLED'
  ) {
    return {
      risky: false,
      score: 0,
      riskLevel: 'LOW',
      reason:
        'Transaction does not represent currently recoverable lost revenue.',
    };
  }

  /*
   * Existing recovery case means Stage 1 has already
   * processed this source transaction.
   */
  if (transaction.recoveryCaseId) {
    return {
      risky: false,
      score: 0,
      riskLevel: 'LOW',
      reason:
        'Transaction is already linked to a recovery case.',
    };
  }

  /*
   * Abandoned checkout is directly recoverable as a
   * checkout abandonment case.
   */
  if (
    transaction.type === 'CHECKOUT' &&
    transaction.status === 'ABANDONED'
  ) {
    return {
      risky: true,
      score: 90,
      riskLevel: 'HIGH',
      reason:
        'Checkout was abandoned before successful payment capture.',
    };
  }

  /*
   * Failed subscription payment.
   */
  if (
    transaction.type ===
      'SUBSCRIPTION_PAYMENT' &&
    transaction.status === 'FAILED'
  ) {
    return {
      risky: true,
      score: 95,
      riskLevel: 'HIGH',
      reason:
        'Subscription payment failed and represents recoverable recurring revenue.',
    };
  }

  /*
   * Normal failed payment.
   */
  if (
    transaction.type === 'PAYMENT' &&
    transaction.status === 'FAILED'
  ) {
    let score = 80;

    switch (
      transaction.failureCategory
    ) {
      case 'NETWORK_ERROR':
        score = 78;
        break;

      case 'PROCESSING_ERROR':
        score = 82;
        break;

      case 'AUTHENTICATION_FAILED':
        score = 80;
        break;

      case 'INSUFFICIENT_FUNDS':
        score = 88;
        break;

      case 'BANK_DECLINED':
        score = 92;
        break;

      case 'MANDATE_ERROR':
        score = 94;
        break;

      case 'UNKNOWN':
      default:
        score = 75;
        break;
    }

    return {
      risky: true,
      score,
      riskLevel:
        score >= 90
          ? 'HIGH'
          : score >= 80
            ? 'MEDIUM'
            : 'LOW',
      reason:
        transaction.failureReason ||
        `Payment failed with category ${
          transaction.failureCategory ||
          'UNKNOWN'
        }.`,
    };
  }

  /*
   * Anything else is not currently considered
   * recovery-worthy by Stage 1.
   */
  return {
    risky: false,
    score: 0,
    riskLevel: 'LOW',
    reason:
      'Transaction status/type does not match a recoverable revenue-loss event.',
  };
}

/*
 * --------------------------------------------------
 * MAP TRANSACTION -> RECOVERY CASE TYPE
 * --------------------------------------------------
 */

function getRecoveryCaseType(
  transaction,
) {
  if (
    transaction.type === 'CHECKOUT' &&
    transaction.status === 'ABANDONED'
  ) {
    return 'CHECKOUT_ABANDONMENT';
  }

  if (
    transaction.type ===
      'SUBSCRIPTION_PAYMENT' &&
    transaction.status === 'FAILED'
  ) {
    return 'SUBSCRIPTION_PAYMENT_FAILURE';
  }

  if (
    transaction.type === 'PAYMENT' &&
    transaction.status === 'FAILED'
  ) {
    return 'PAYMENT_FAILURE';
  }

  return null;
}

/*
 * --------------------------------------------------
 * CREATE AUDIT LOGS
 * --------------------------------------------------
 */

async function createRiskAuditLogs({
  transaction,
  recoveryCase,
  risk,
}) {
  const baseTime =
    new Date();

  const detectionEventType =
    getDetectionEventType(
      recoveryCase.type,
    );

  const auditDocuments = [
    {
      merchantId:
        transaction.merchantId,

      recoveryCaseId:
        recoveryCase._id,

      transactionId:
        transaction._id,

      subscriptionId:
        transaction.subscriptionId ||
        undefined,

      actorType:
        'SYSTEM',

      eventType:
        detectionEventType,

      result:
        'INFO',

      message:
        'Revenue risk detected from transaction analysis.',

      metadata: {
        riskScore:
          String(risk.score),

        riskLevel:
          risk.riskLevel,

        amountMinor:
          String(
            transaction.amountMinor,
          ),

        transactionStatus:
          transaction.status,

        transactionType:
          transaction.type,

        failureCategory:
          transaction.failureCategory ||
          'UNKNOWN',
      },

      externalEventId:
        transaction.providerEventId ||
        undefined,

      occurredAt:
        baseTime,
    },

    {
      merchantId:
        transaction.merchantId,

      recoveryCaseId:
        recoveryCase._id,

      transactionId:
        transaction._id,

      subscriptionId:
        transaction.subscriptionId ||
        undefined,

      actorType:
        'SYSTEM',

      eventType:
        'RECOVERY_CASE_CREATED',

      result:
        'INFO',

      message:
        'Recovery case created from a detected revenue-risk transaction.',

      metadata: {
        amountAtRiskMinor:
          String(
            recoveryCase.amountAtRiskMinor,
          ),

        eligibleAmountMinor:
          String(
            recoveryCase.eligibleAmountMinor,
          ),

        riskScore:
          String(risk.score),

        riskLevel:
          risk.riskLevel,
      },

      occurredAt:
        new Date(
          baseTime.getTime() + 1000,
        ),
    },
  ];

  await AuditLog.insertMany(
    auditDocuments,
    {
      ordered: true,
    },
  );
}

/*
 * --------------------------------------------------
 * DETECTION AUDIT TYPE
 * --------------------------------------------------
 */

function getDetectionEventType(
  caseType,
) {
  switch (caseType) {
    case 'PAYMENT_FAILURE':
      return 'PAYMENT_FAILURE_DETECTED';

    case 'CHECKOUT_ABANDONMENT':
      return 'CHECKOUT_ABANDONED_DETECTED';

    case 'SUBSCRIPTION_PAYMENT_FAILURE':
      return 'SUBSCRIPTION_PAYMENT_FAILED';

    default:
      return 'PAYMENT_FAILURE_DETECTED';
  }
}

/*
 * --------------------------------------------------
 * CREATE ONE RECOVERY CASE
 * --------------------------------------------------
 */

async function createRecoveryCaseFromRisk(
  transaction,
  risk,
) {
  const caseType =
    getRecoveryCaseType(
      transaction,
    );

  if (!caseType) {
    return {
      created: false,
      recoveryCase: null,
      reason:
        'No valid recovery case type could be derived.',
    };
  }

  if (
    !transaction.customerId
  ) {
    return {
      created: false,
      recoveryCase: null,
      reason:
        'Transaction has no customerId.',
    };
  }

  const amountMinor =
    Number(
      transaction.amountMinor,
    );

  if (
    !Number.isSafeInteger(
      amountMinor,
    ) ||
    amountMinor <= 0
  ) {
    return {
      created: false,
      recoveryCase: null,
      reason:
        'Transaction amount is invalid.',
    };
  }

  /*
   * Idempotency check.
   *
   * The transaction should normally already be linked
   * through recoveryCaseId, but we also verify the
   * RecoveryCase collection directly.
   */
  const existingCase =
    await RecoveryCase.findOne({
      merchantId:
        transaction.merchantId,

      sourceTransactionId:
        transaction._id,
    });

  if (existingCase) {
    if (
      !transaction.recoveryCaseId ||
      String(
        transaction.recoveryCaseId,
      ) !==
        String(
          existingCase._id,
        )
    ) {
      await Transaction.updateOne(
        {
          _id:
            transaction._id,

          merchantId:
            transaction.merchantId,
        },
        {
          $set: {
            recoveryCaseId:
              existingCase._id,
          },
        },
      );
    }

    return {
      created: false,
      recoveryCase:
        existingCase,
      reason:
        'Recovery case already exists for this transaction.',
    };
  }

  /*
   * Stage 1 creates a FRESH case.
   *
   * There is:
   * - no AI decision
   * - no execution
   * - no recovery transaction
   * - no recovered amount
   *
   * Stage 2 will perform AI analysis later.
   */
  const now =
    new Date();

  const recoveryWindowEndsAt =
    new Date(
      now.getTime() +
        RECOVERY_WINDOW_HOURS *
          60 *
          60 *
          1000,
    );

  const recoveryCase =
    await RecoveryCase.create({
      merchantId:
        transaction.merchantId,

      customerId:
        transaction.customerId,

      sourceTransactionId:
        transaction._id,

      subscriptionId:
        transaction.subscriptionId ||
        undefined,

      type:
        caseType,

      status:
        'RECOVERY_PENDING',

      amountAtRiskMinor:
        amountMinor,

      eligibleAmountMinor:
        amountMinor,

      recoveredAmountMinor:
        0,

      currency:
        transaction.currency ||
        'INR',

      retryAttemptCount:
        0,

      reminderCount:
        0,

      /*
       * Stage 1 MUST NOT select the final AI action.
       */
      currentAction:
        undefined,

      nextActionAt:
        undefined,

      recoveryWindowEndsAt,

      policySnapshot: {
        maxPaymentRetries:
          MAX_PAYMENT_RETRIES,

        maxReminders:
          MAX_REMINDERS,

        recoveryWindowHours:
          RECOVERY_WINDOW_HOURS,
      },

      /*
       * AI populates this only in Stage 2.
       */
      agentDecision:
        undefined,

      recoveredAt:
        undefined,

      recoveryTransactionId:
        undefined,

      stopReason:
        undefined,

      escalationReason:
        undefined,
    });

  /*
   * Link source transaction to the newly created case.
   */
  const updateResult =
    await Transaction.updateOne(
      {
        _id:
          transaction._id,

        merchantId:
          transaction.merchantId,

        /*
         * Prevent overwriting a case if another worker
         * processed the same transaction concurrently.
         */
        $or: [
          {
            recoveryCaseId:
              {
                $exists:
                  false,
              },
          },
          {
            recoveryCaseId:
              null,
          },
        ],
      },
      {
        $set: {
          recoveryCaseId:
            recoveryCase._id,
        },
      },
    );

  /*
   * A concurrent worker may have already linked the
   * transaction. In that case remove the duplicate
   * case we just created and return the authoritative case.
   */
  if (
    updateResult.modifiedCount !==
    1
  ) {
    await RecoveryCase.deleteOne({
      _id:
        recoveryCase._id,
    });

    const authoritativeCase =
      await RecoveryCase.findOne({
        merchantId:
          transaction.merchantId,

        sourceTransactionId:
          transaction._id,
      });

    return {
      created: false,

      recoveryCase:
        authoritativeCase,

      reason:
        'Another risk-analysis worker created the recovery case first.',
    };
  }

  await createRiskAuditLogs({
    transaction,
    recoveryCase,
    risk,
  });

  return {
    created: true,
    recoveryCase,
    reason:
      'Recovery case created successfully.',
  };
}

/*
 * --------------------------------------------------
 * ANALYZE ALL TRANSACTIONS
 * --------------------------------------------------
 */

async function analyzeTransactionsForRevenueRisk({
  merchantId,
  from,
  to,
  limit = 500,
} = {}) {
  if (!merchantId) {
    throw new Error(
      'merchantId is required.',
    );
  }

  if (
    !mongoose.Types.ObjectId.isValid(
      merchantId,
    )
  ) {
    throw new Error(
      'Invalid merchantId.',
    );
  }

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 500,
        1,
      ),
      5000,
    );

  const query = {
    merchantId:
      new mongoose.Types.ObjectId(
        merchantId,
      ),
  };

  /*
   * Optional date filtering.
   */
  if (from || to) {
    query.occurredAt = {};

    if (from) {
      const fromDate =
        new Date(from);

      if (
        Number.isNaN(
          fromDate.getTime(),
        )
      ) {
        throw new Error(
          'Invalid "from" date.',
        );
      }

      query.occurredAt.$gte =
        fromDate;
    }

    if (to) {
      const toDate =
        new Date(to);

      if (
        Number.isNaN(
          toDate.getTime(),
        )
      ) {
        throw new Error(
          'Invalid "to" date.',
        );
      }

      query.occurredAt.$lte =
        toDate;
    }
  }

  /*
   * Pull ALL source transactions for this merchant,
   * not transactions belonging to recovery cases.
   */
  const transactions =
    await Transaction.find(
      query,
    )
      .sort({
        occurredAt: -1,
      })
      .limit(safeLimit)
      .lean();

  let analyzedCount =
    0;

  let riskyCount =
    0;

  let createdCaseCount =
    0;

  let alreadyProcessedCount =
    0;

  let skippedCount =
    0;

  let totalRevenueAtRiskMinor =
    0;

  const riskResults = [];

  for (
    const transaction of
      transactions
  ) {
    analyzedCount += 1;

    const risk =
      classifyTransactionRisk(
        transaction,
      );

    if (
      transaction.recoveryCaseId
    ) {
      alreadyProcessedCount +=
        1;

      riskResults.push({
        transactionId:
          String(
            transaction._id,
          ),

        risky: false,

        riskScore: 0,

        riskLevel:
          'LOW',

        action:
          'ALREADY_PROCESSED',
      });

      continue;
    }

    if (!risk.risky) {
      skippedCount += 1;

      riskResults.push({
        transactionId:
          String(
            transaction._id,
          ),

        risky: false,

        riskScore:
          risk.score,

        riskLevel:
          risk.riskLevel,

        action:
          'IGNORED',

        reason:
          risk.reason,
      });

      continue;
    }

    riskyCount +=
      1;

    const result =
      await createRecoveryCaseFromRisk(
        transaction,
        risk,
      );

    if (result.created) {
      createdCaseCount += 1;

      totalRevenueAtRiskMinor +=
        Number(
          transaction.amountMinor,
        );
    } else {
      alreadyProcessedCount +=
        1;
    }

    riskResults.push({
      transactionId:
        String(
          transaction._id,
        ),

      risky: true,

      riskScore:
        risk.score,

      riskLevel:
        risk.riskLevel,

      action:
        result.created
          ? 'RECOVERY_CASE_CREATED'
          : 'ALREADY_PROCESSED',

      recoveryCaseId:
        result.recoveryCase
          ? String(
              result.recoveryCase._id,
            )
          : null,

      reason:
        result.reason,
    });
  }

  return {
    merchantId:
      String(merchantId),

    transactionsAnalyzed:
      analyzedCount,

    riskyTransactions:
      riskyCount,

    recoveryCasesCreated:
      createdCaseCount,

    alreadyProcessed:
      alreadyProcessedCount,

    skippedTransactions:
      skippedCount,

    revenueAtRiskMinor:
      totalRevenueAtRiskMinor,

    revenueAtRisk:
      Number(
        (
          totalRevenueAtRiskMinor /
          100
        ).toFixed(2),
      ),

    results:
      riskResults,
  };
}

module.exports = {
  classifyTransactionRisk,
  analyzeTransactionsForRevenueRisk,
  createRecoveryCaseFromRisk,
};