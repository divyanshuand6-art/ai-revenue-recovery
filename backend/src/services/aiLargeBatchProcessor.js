const {
  analyzeRecoveryBatch,
} = require('./aiBatchAnalysisService');

const {
  validateAIRecommendation,
} = require('./aiRecommendationValidationService');

const DEFAULT_BATCH_SIZE = 20;

function getBatchSize() {
  const configuredSize =
    Number(process.env.AI_BATCH_SIZE);

  if (
    !Number.isInteger(configuredSize) ||
    configuredSize <= 0
  ) {
    return DEFAULT_BATCH_SIZE;
  }

  return configuredSize;
}

function splitIntoBatches(
  items,
  batchSize = getBatchSize(),
) {
  if (!Array.isArray(items)) {
    throw new Error(
      'items must be an array.',
    );
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
    recoveryCases.map(
      (recoveryCase) => [
        String(
          recoveryCase.recoveryCaseId,
        ),
        recoveryCase,
      ],
    ),
  );
}

function createTransactionForValidation(
  recoveryCase,
) {
  return {
    failureCategory:
      recoveryCase.failureCategory ||
      'UNKNOWN',

    paymentMethod:
      recoveryCase.paymentMethod ||
      null,

    type:
      recoveryCase.transactionType ||
      null,

    amountMinor:
      recoveryCase.transactionAmountMinor ||
      null,

    occurredAt:
      recoveryCase.transactionOccurredAt ||
      null,
  };
}

function validateAIRecommendationsAgainstPolicy(
  recommendations,
  recoveryCases,
) {
  const recoveryCaseMap =
    createRecoveryCaseMap(
      recoveryCases,
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

          transaction:
            createTransactionForValidation(
              recoveryCase,
            ),
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

        policyValidation: validation,

        finalAction:
          validation.finalAction,
      };
    },
  );
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

  const batchSize =
    options.batchSize ||
    getBatchSize();

  const batches =
    splitIntoBatches(
      recoveryCases,
      batchSize,
    );

  const allRecommendations = [];

  for (
    let batchIndex = 0;
    batchIndex < batches.length;
    batchIndex += 1
  ) {
    const batch =
      batches[batchIndex];

    console.log(
      `Processing AI batch ${batchIndex + 1}/${batches.length} (${batch.length} cases)...`,
    );

    const result =
      await analyzeRecoveryBatch(
        batch,
      );

    const validatedRecommendations =
      validateAIRecommendationsAgainstPolicy(
        result.recommendations,
        batch,
      );

    allRecommendations.push(
      ...validatedRecommendations,
    );
  }

  return {
    totalCases:
      recoveryCases.length,

    batchSize,

    totalBatches:
      batches.length,

    recommendations:
      allRecommendations,
  };
}

module.exports = {
  splitIntoBatches,
  processRecoveryCasesInBatches,
  validateAIRecommendationsAgainstPolicy,
};