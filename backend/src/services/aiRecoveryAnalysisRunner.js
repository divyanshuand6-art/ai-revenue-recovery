const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');

const {
  processRecoveryCasesInBatches,
} = require('./aiLargeBatchProcessor');

const ACTIVE_STATUSES = [
  'OPEN',
  'ACTION_SCHEDULED',
  'ACTION_EXECUTED',
];

async function loadRecoveryCasesForAI({
  merchantId,
  limit = 100,
  activeOnly = false,
}) {
  if (!merchantId) {
    throw new Error(
      'merchantId is required.',
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit <= 0
  ) {
    throw new Error(
      'limit must be a positive integer.',
    );
  }

  const query = {
    merchantId,
  };

  if (activeOnly) {
    query.status = {
      $in: ACTIVE_STATUSES,
    };
  }

  const recoveryCases =
    await RecoveryCase.find(query)
      .sort({
        createdAt: 1,
      })
      .limit(limit)
      .lean();

  if (recoveryCases.length === 0) {
    return [];
  }

  const transactionIds =
    recoveryCases
      .map(
        (recoveryCase) =>
          recoveryCase.sourceTransactionId,
      )
      .filter(Boolean);

  const transactions =
    await Transaction.find({
      merchantId,
      _id: {
        $in: transactionIds,
      },
    })
      .select(
        '_id failureCategory paymentMethod type amountMinor occurredAt',
      )
      .lean();

  const transactionMap =
    new Map(
      transactions.map(
        (transaction) => [
          String(transaction._id),
          transaction,
        ],
      ),
    );

  return recoveryCases.map(
    (recoveryCase) => {
      const transaction =
        transactionMap.get(
          String(
            recoveryCase.sourceTransactionId,
          ),
        );

      return {
        recoveryCaseId:
          String(recoveryCase._id),

        caseType:
          recoveryCase.type,

        status:
          recoveryCase.status,

        amountAtRiskMinor:
          recoveryCase.amountAtRiskMinor,

        eligibleAmountMinor:
          recoveryCase.eligibleAmountMinor,

        recoveredAmountMinor:
          recoveryCase.recoveredAmountMinor,

        retryAttemptCount:
          recoveryCase.retryAttemptCount || 0,

        reminderCount:
          recoveryCase.reminderCount || 0,

        recoveryWindowEndsAt:
          recoveryCase.recoveryWindowEndsAt,

        currentAction:
          recoveryCase.currentAction ||
          null,

        policySnapshot:
          recoveryCase.policySnapshot ||
          {},

        failureCategory:
          transaction?.failureCategory ||
          'UNKNOWN',

        paymentMethod:
          transaction?.paymentMethod ||
          null,

        transactionType:
          transaction?.type ||
          null,

        transactionAmountMinor:
          transaction?.amountMinor ||
          null,

        transactionOccurredAt:
          transaction?.occurredAt ||
          null,
      };
    },
  );
}

async function runAIRecoveryAnalysis({
  merchantId,
  limit = 100,
  batchSize,
  activeOnly = false,
}) {
  const recoveryCases =
    await loadRecoveryCasesForAI({
      merchantId,
      limit,
      activeOnly,
    });

  if (recoveryCases.length === 0) {
    return {
      totalCases: 0,
      batchSize:
        batchSize || null,
      totalBatches: 0,
      recommendations: [],
    };
  }

  return processRecoveryCasesInBatches(
    recoveryCases,
    {
      batchSize,
    },
  );
}

module.exports = {
  loadRecoveryCasesForAI,
  runAIRecoveryAnalysis,
};