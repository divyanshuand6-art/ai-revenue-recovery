const {
  ACTIONS,
  decideRecoveryAction,
} = require('./recoveryDecisionService');

const ALLOWED_AI_ACTIONS = new Set(
  Object.values(ACTIONS),
);

function validateAIRecommendation({
  aiRecommendation,
  recoveryCase,
  transaction,
  now = new Date(),
}) {
  if (!aiRecommendation) {
    throw new Error(
      'AI recommendation is required.',
    );
  }

  const {
    recoveryCaseId,
    recommendedAction,
    confidence,
    riskLevel,
    reason,
  } = aiRecommendation;

  if (
    String(recoveryCaseId) !==
    String(recoveryCase._id)
  ) {
    return {
      accepted: false,
      reasonCode:
        'RECOVERY_CASE_ID_MISMATCH',
      message:
        'AI recommendation does not belong to this recovery case.',
      finalAction: null,
    };
  }

  if (
    !ALLOWED_AI_ACTIONS.has(
      recommendedAction,
    )
  ) {
    return {
      accepted: false,
      reasonCode:
        'UNSUPPORTED_AI_ACTION',
      message:
        `AI recommended unsupported action: ${recommendedAction}.`,
      finalAction: null,
    };
  }

  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      accepted: false,
      reasonCode:
        'INVALID_AI_CONFIDENCE',
      message:
        'AI confidence must be a number between 0 and 1.',
      finalAction: null,
    };
  }

  if (
    !['LOW', 'MEDIUM', 'HIGH'].includes(
      riskLevel,
    )
  ) {
    return {
      accepted: false,
      reasonCode:
        'INVALID_AI_RISK_LEVEL',
      message:
        'AI risk level is invalid.',
      finalAction: null,
    };
  }

  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0
  ) {
    return {
      accepted: false,
      reasonCode:
        'INVALID_AI_REASON',
      message:
        'AI recommendation reason is missing.',
      finalAction: null,
    };
  }

  /*
   * The deterministic recovery policy
   * remains authoritative.
   */

  const policyDecision =
    decideRecoveryAction({
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

      now,
    });

  const aiAgrees =
    recommendedAction ===
    policyDecision.action;

  return {
    accepted: aiAgrees,

    reasonCode: aiAgrees
      ? 'AI_AGREES_WITH_POLICY'
      : 'AI_RECOMMENDATION_REJECTED',

    message: aiAgrees
      ? 'AI recommendation agrees with the deterministic recovery policy.'
      : 'AI recommendation was rejected because the deterministic recovery policy selected a different action.',

    aiRecommendation: {
      action:
        recommendedAction,

      confidence,

      riskLevel,

      reason:
        reason.trim(),
    },

    policyDecision: {
      action:
        policyDecision.action,

      reasonCode:
        policyDecision.reasonCode,

      reason:
        policyDecision.reason,

      bounded:
        policyDecision.bounded,

      requiresCustomerAction:
        policyDecision.requiresCustomerAction,
    },

    finalAction:
      policyDecision.action,
  };
}

module.exports = {
  validateAIRecommendation,
};