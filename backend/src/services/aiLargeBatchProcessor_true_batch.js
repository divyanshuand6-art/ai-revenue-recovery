const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');

const {
  analyzeRecoveryBatch,
} = require('./aiBatchAnalysisService');

const {
  validateAIRecommendation,
} = require('./aiRecommendationValidationService');

const {
  getRecoveryPolicyConstraints,
} = require('./recoveryDecisionService');

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;

function getBatchSize() {
  const configuredSize = Number(
    process.env.AI_BATCH_SIZE,
  );

  if (
    !Number.isInteger(configuredSize) ||
    configuredSize <= 0
  ) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(
    configuredSize,
    MAX_BATCH_SIZE,
  );
}

function normalizeBatchSize(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return getBatchSize();
  }

  return Math.min(parsed, MAX_BATCH_SIZE);
}

function splitIntoBatches(
  items,
  batchSize = getBatchSize(),
) {
  if (!Array.isArray(items)) {
    throw new Error('items must be an array.');
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    throw new Error(
      'batchSize must be a positive integer.',
    );
  }

  const batches = [];

  for (
    let index = 0;
    index < items.length;
    index += batchSize
  ) {
    batches.push(
      items.slice(
        index,
        index + batchSize,
      ),
    );
  }

  return batches;
}

function createRecoveryCaseMap(
  recoveryCases,
) {
  return new Map(
    recoveryCases.map((recoveryCase) => [
      String(recoveryCase._id),
      recoveryCase,
    ]),
  );
}

function toPlainCommunicationConsent(
  communicationConsent,
) {
  return {
    email: Boolean(
      communicationConsent?.email,
    ),
    sms: Boolean(
      communicationConsent?.sms,
    ),
    whatsapp: Boolean(
      communicationConsent?.whatsapp,
    ),
  };
}

/*
 * IMPORTANT:
 * Do not reconstruct transaction information from
 * RecoveryCase fields because RecoveryCase does not
 * contain the complete transaction failure context.
 *
 * enrichRecoveryCasesForAI() stores the exact source
 * Transaction context inside transactionContext.
 */
function createTransactionForValidation(
  recoveryCase,
) {
  const transaction =
    recoveryCase?.transactionContext ||
    {};

  return {
    failureCategory:
      transaction.failureCategory ||
      'UNKNOWN',

    paymentMethod:
      transaction.paymentMethod ||
      null,

    type:
      transaction.type ||
      null,

    amountMinor:
      transaction.amountMinor ??
      null,

    occurredAt:
      transaction.occurredAt ||
      null,
  };
}

async function enrichRecoveryCasesForAI(
  recoveryCases,
) {
  if (!Array.isArray(recoveryCases)) {
    throw new Error(
      'recoveryCases must be an array.',
    );
  }

  if (recoveryCases.length === 0) {
    return [];
  }

  const transactionIds = recoveryCases
    .map(
      (recoveryCase) =>
        recoveryCase.sourceTransactionId,
    )
    .filter(Boolean);

  const customerIds = recoveryCases
    .map(
      (recoveryCase) =>
        recoveryCase.customerId,
    )
    .filter(Boolean);

  const merchantId =
    recoveryCases[0].merchantId;

  const [
    transactions,
    customers,
  ] = await Promise.all([
    Transaction.find({
      merchantId,
      _id: {
        $in: transactionIds,
      },
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
      .lean(),

    Customer.find({
      merchantId,
      _id: {
        $in: customerIds,
      },
    })
      .select(
        [
          '_id',
          'communicationConsent',
          'paymentHistory',
        ].join(' '),
      )
      .lean(),
  ]);

  const transactionMap = new Map(
    transactions.map((transaction) => [
      String(transaction._id),
      transaction,
    ]),
  );

  const customerMap = new Map(
    customers.map((customer) => [
      String(customer._id),
      customer,
    ]),
  );

  const now = new Date();

  return recoveryCases.map((recoveryCase) => {
    const transaction = transactionMap.get(
      String(
        recoveryCase.sourceTransactionId,
      ),
    );

    const customer = customerMap.get(
      String(recoveryCase.customerId),
    );

    const communicationConsent =
      toPlainCommunicationConsent(
        customer?.communicationConsent,
      );

    const policyConstraints =
      getRecoveryPolicyConstraints({
        failureCategory:
          transaction?.failureCategory ||
          'UNKNOWN',

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

        communicationConsent,

        now,
      });

    const recoveryWindowEndsAt =
      recoveryCase.recoveryWindowEndsAt ||
      null;

    const recoveryWindowEndsAtDate =
      recoveryWindowEndsAt
        ? new Date(recoveryWindowEndsAt)
        : null;

    const recoveryWindowHoursRemaining =
      recoveryWindowEndsAtDate &&
      !Number.isNaN(
        recoveryWindowEndsAtDate.getTime(),
      )
        ? Number(
            Math.max(
              0,
              (recoveryWindowEndsAtDate.getTime() -
                now.getTime()) /
                3600000,
            ).toFixed(2),
          )
        : null;

    return {
      /*
       * Internal persistence context.
       */
      _id: recoveryCase._id,

      merchantId:
        recoveryCase.merchantId,

      sourceTransactionId:
        recoveryCase.sourceTransactionId,

      recoveryCaseId:
        String(recoveryCase._id),

      caseType:
        recoveryCase.type,

      status:
        recoveryCase.status,

      amountAtRiskMinor:
        recoveryCase.amountAtRiskMinor || 0,

      eligibleAmountMinor:
        recoveryCase.eligibleAmountMinor || 0,

      recoveredAmountMinor:
        recoveryCase.recoveredAmountMinor || 0,

      retryAttemptCount:
        recoveryCase.retryAttemptCount || 0,

      reminderCount:
        recoveryCase.reminderCount || 0,

      currentAction:
        recoveryCase.currentAction || null,

      recoveryWindowEndsAt,

      recoveryWindowHoursRemaining,

      policySnapshot:
        recoveryCase.policySnapshot || {},

      transaction: transaction
        ? {
            type:
              transaction.type,

            status:
              transaction.status,

            amountMinor:
              transaction.amountMinor,

            currency:
              transaction.currency,

            paymentMethod:
              transaction.paymentMethod,

            failureCategory:
              transaction.failureCategory,

            failureCode:
              transaction.failureCode,

            failureReason:
              transaction.failureReason,

            failureStage:
              transaction.failureStage,

            occurredAt:
              transaction.occurredAt,
          }
        : null,

      /*
       * IMPORTANT FIX:
       *
       * Keep the exact source Transaction context for
       * second-stage policy validation.
       *
       * Previously the validator tried to reconstruct
       * failureCategory/paymentMethod from RecoveryCase,
       * which caused cases such as INSUFFICIENT_FUNDS to
       * become UNKNOWN during validation.
       */
      transactionContext: transaction
        ? {
            type:
              transaction.type,

            status:
              transaction.status,

            amountMinor:
              transaction.amountMinor,

            currency:
              transaction.currency,

            paymentMethod:
              transaction.paymentMethod,

            failureCategory:
              transaction.failureCategory,

            failureCode:
              transaction.failureCode,

            failureReason:
              transaction.failureReason,

            failureStage:
              transaction.failureStage,

            occurredAt:
              transaction.occurredAt,
          }
        : null,

      /*
       * No customer PII is included.
       */
      customer: customer
        ? {
            communicationConsent,

            paymentHistory:
              customer.paymentHistory || {},
          }
        : null,

      /*
       * Exact per-case policy boundary.
       */
      policy: {
        blocked:
          Boolean(
            policyConstraints.blocked,
          ),

        allowedActions:
          policyConstraints.allowedActions ||
          [],

        fallbackAction:
          policyConstraints.fallbackAction ||
          null,

        reasonCode:
          policyConstraints.reasonCode ||
          null,

        message:
          policyConstraints.message ||
          null,
      },

      /*
       * Used again when validating the Gemini result.
       */
      validationContext: {
        communicationConsent,
      },
    };
  });
}

function buildFallbackRecommendation(
  recoveryCase,
) {
  const action =
    recoveryCase?.policy?.fallbackAction ||
    'STOP';

  return {
    recoveryCaseId:
      String(recoveryCase.recoveryCaseId),

    recommendedAction:
      action,

    confidence:
      0.25,

    riskLevel:
      action === 'STOP' ||
      action === 'ESCALATE'
        ? 'HIGH'
        : 'MEDIUM',

    reason:
      'AI batch analysis was unavailable; deterministic policy fallback selected.',
  };
}

function buildBlockedResult(
  recoveryCase,
) {
  return {
    recoveryCaseId:
      String(recoveryCase.recoveryCaseId),

    aiRecommendation:
      null,

    policyValidation: {
      accepted:
        false,

      reasonCode:
        recoveryCase.policy.reasonCode,

      message:
        recoveryCase.policy.message ||
        'Recovery case is blocked by policy.',

      policyDecision:
        null,

      finalAction:
        null,

      executionAllowed:
        false,
    },

    finalAction:
      null,

    blocked:
      true,

    skippedAI:
      true,

    recoveryCase,
  };
}

function validateAIRecommendationsAgainstPolicy(
  recommendations,
  enrichedCases,
) {
  if (!Array.isArray(recommendations)) {
    throw new Error(
      'recommendations must be an array.',
    );
  }

  if (!Array.isArray(enrichedCases)) {
    throw new Error(
      'enrichedCases must be an array.',
    );
  }

  const recoveryCaseMap =
    createRecoveryCaseMap(
      enrichedCases.map((item) => ({
        ...item,
        _id: item.recoveryCaseId,
      })),
    );

  return recommendations.map(
    (recommendation) => {
      const recoveryCase =
        recoveryCaseMap.get(
          String(
            recommendation.recoveryCaseId,
          ),
        );

      if (!recoveryCase) {
        throw new Error(
          `Recovery case ${recommendation.recoveryCaseId} was not found during policy validation.`,
        );
      }

      const validation =
        validateAIRecommendation({
          aiRecommendation:
            recommendation,

          recoveryCase: {
            _id:
              recoveryCase.recoveryCaseId,

            type:
              recoveryCase.caseType,

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
          },

          /*
           * IMPORTANT:
           * This now contains the ACTUAL Transaction
           * context from enrichRecoveryCasesForAI().
           */
          transaction:
            createTransactionForValidation(
              recoveryCase,
            ),

          /*
           * Preserve the exact consent context.
           */
          customer: {
            communicationConsent:
              recoveryCase
                .validationContext
                ?.communicationConsent ||
              {},
          },
        });

      return {
        recoveryCaseId:
          recommendation.recoveryCaseId,

        aiRecommendation: {
          action:
            recommendation.recommendedAction,

          confidence:
            recommendation.confidence,

          riskLevel:
            recommendation.riskLevel,

          reason:
            recommendation.reason,
        },

        policyValidation:
          validation,

        finalAction:
          validation.finalAction,

        blocked:
          false,

        skippedAI:
          false,

        recoveryCase,
      };
    },
  );
}

async function persistBatchRecommendations(
  validatedRecommendations,
) {
  for (
    const result of validatedRecommendations
  ) {
    const recoveryCase =
      result.recoveryCase;

    if (!recoveryCase) {
      continue;
    }

    if (result.skippedAI) {
      await AuditLog.create({
        merchantId:
          recoveryCase.merchantId,

        recoveryCaseId:
          recoveryCase._id,

        transactionId:
          recoveryCase.sourceTransactionId,

        actorType:
          'POLICY_ENGINE',

        eventType:
          'POLICY_REJECTED',

        result:
          'SKIPPED',

        message:
          result.policyValidation.message ||
          'AI analysis skipped because deterministic policy blocked the recovery case.',

        metadata: {
          reasonCode:
            result.policyValidation
              .reasonCode ||
            'POLICY_BLOCKED',

          batchAnalysis:
            'true',

          skippedAI:
            'true',
        },
      });

      continue;
    }

    const aiRecommendation =
      result.aiRecommendation;

    const policyValidation =
      result.policyValidation;

    const isRuleBasedFallback =
      aiRecommendation.reason ===
      'AI batch analysis was unavailable; deterministic policy fallback selected.';

    const agentDecision = {
      recommendedAction:
        aiRecommendation.action,

      policyAccepted:
        policyValidation.accepted,

      confidence:
        aiRecommendation.confidence,

      riskLevel:
        aiRecommendation.riskLevel,

      provider:
        isRuleBasedFallback
          ? 'RULE_BASED_FALLBACK'
          : 'GEMINI',

      policyReasonCode:
        policyValidation.reasonCode,

      reasonCode:
        policyValidation.reasonCode,

      rationale:
        aiRecommendation.reason,

      stopCondition:
        policyValidation.executionAllowed
          ? 'POLICY_REVALIDATION_REQUIRED_BEFORE_EXECUTION'
          : policyValidation.reasonCode,

      analyzedAt:
        new Date(),
    };

    if (policyValidation.finalAction) {
      agentDecision.action =
        policyValidation.finalAction;

      agentDecision.finalAction =
        policyValidation.finalAction;
    }

    await RecoveryCase.updateOne(
      {
        _id:
          recoveryCase._id,

        merchantId:
          recoveryCase.merchantId,
      },
      {
        $set: {
          agentDecision,
        },
      },
    );

    const auditBase = {
      merchantId:
        recoveryCase.merchantId,

      recoveryCaseId:
        recoveryCase._id,

      transactionId:
        recoveryCase.sourceTransactionId,
    };

    await AuditLog.create({
      ...auditBase,

      actorType:
        'AI_AGENT',

      eventType:
        'AI_ANALYSIS_COMPLETED',

      action:
        aiRecommendation.action,

      result:
        policyValidation.accepted
          ? 'SUCCEEDED'
          : 'REJECTED',

      message:
        aiRecommendation.reason,

      metadata: {
        provider:
          agentDecision.provider,

        confidence:
          aiRecommendation.confidence,

        riskLevel:
          aiRecommendation.riskLevel,

        recommendedAction:
          aiRecommendation.action,

        policyAction:
          policyValidation
            .policyDecision
            ?.action ||
          '',

        finalAction:
          policyValidation.finalAction ||
          '',

        policyAccepted:
          String(
            policyValidation.accepted,
          ),

        batchAnalysis:
          'true',
      },
    });

    await AuditLog.create({
      ...auditBase,

      actorType:
        'POLICY_ENGINE',

      eventType:
        policyValidation.executionAllowed
          ? 'POLICY_VALIDATED'
          : 'POLICY_REJECTED',

      action:
        policyValidation.finalAction ||
        policyValidation
          .policyDecision
          ?.action ||
        aiRecommendation.action,

      result:
        policyValidation.executionAllowed
          ? 'SUCCEEDED'
          : 'REJECTED',

      message:
        policyValidation.message ||
        'Batch AI recommendation validated by deterministic policy.',

      metadata: {
        recommendedAction:
          aiRecommendation.action,

        finalAction:
          policyValidation.finalAction ||
          '',

        accepted:
          String(
            policyValidation.accepted,
          ),

        reasonCode:
          policyValidation.reasonCode ||
          '',

        batchAnalysis:
          'true',
      },
    });
  }
}

async function processRecoveryCasesInBatches(
  recoveryCases,
  options = {},
) {
  if (!Array.isArray(recoveryCases)) {
    throw new Error(
      'recoveryCases must be an array.',
    );
  }

  if (recoveryCases.length === 0) {
    return {
      totalCases:
        0,

      eligibleCases:
        0,

      skippedCases:
        0,

      batchSize:
        normalizeBatchSize(
          options.batchSize,
        ),

      totalBatches:
        0,

      geminiRequests:
        0,

      failedBatches:
        0,

      fallbackRecommendations:
        0,

      recommendations:
        [],

      skipped:
        [],

      batchResults:
        [],
    };
  }

  const batchSize =
    normalizeBatchSize(
      options.batchSize,
    );

  const enrichedCases =
    await enrichRecoveryCasesForAI(
      recoveryCases,
    );

  const eligibleCases =
    enrichedCases.filter(
      (recoveryCase) =>
        !recoveryCase.policy.blocked,
    );

  const blockedCases =
    enrichedCases.filter(
      (recoveryCase) =>
        recoveryCase.policy.blocked,
    );

  const skipped =
    blockedCases.map(
      buildBlockedResult,
    );

  const batches =
    splitIntoBatches(
      eligibleCases,
      batchSize,
    );

  const allRecommendations =
    [];

  const batchResults =
    [];

  let failedBatches =
    0;

  let fallbackRecommendations =
    0;

  for (
    let batchIndex = 0;
    batchIndex < batches.length;
    batchIndex += 1
  ) {
    const batch =
      batches[batchIndex];

    console.log(
      `Processing TRUE AI batch ${batchIndex + 1}/${batches.length} (${batch.length} cases) -> 1 Gemini request`,
    );

    let recommendations;
    let usedFallback =
      false;

    try {
      const result =
        await analyzeRecoveryBatch(
          batch,
        );

      recommendations =
        result.recommendations;
    } catch (error) {
      failedBatches +=
        1;

      usedFallback =
        true;

      console.error(
        `AI batch ${batchIndex + 1} failed:`,
        error?.message ||
          error,
      );

      recommendations =
        batch.map(
          buildFallbackRecommendation,
        );
    }

    if (usedFallback) {
      fallbackRecommendations +=
        recommendations.length;
    }

    const validated =
      validateAIRecommendationsAgainstPolicy(
        recommendations,
        batch,
      );

    const batchResultsWithCases =
      validated.map(
        (result) => ({
          ...result,

          recoveryCase:
            batch.find(
              (item) =>
                String(
                  item.recoveryCaseId,
                ) ===
                String(
                  result.recoveryCaseId,
                ),
            ),
        }),
      );

    await persistBatchRecommendations(
      batchResultsWithCases,
    );

    allRecommendations.push(
      ...batchResultsWithCases,
    );

    batchResults.push({
      batchNumber:
        batchIndex + 1,

      totalBatches:
        batches.length,

      cases:
        batch.length,

      geminiRequests:
        1,

      usedFallback,

      recommendationCount:
        validated.length,
    });
  }

  return {
    totalCases:
      recoveryCases.length,

    eligibleCases:
      eligibleCases.length,

    skippedCases:
      blockedCases.length,

    batchSize,

    totalBatches:
      batches.length,

    geminiRequests:
      batches.length,

    recommendations:
      allRecommendations,

    skipped,

    failedBatches,

    fallbackRecommendations,

    batchResults,
  };
}

module.exports = {
  getBatchSize,
  splitIntoBatches,
  processRecoveryCasesInBatches,
  validateAIRecommendationsAgainstPolicy,
};