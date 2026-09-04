const {
  ACTIONS,
  getRecoveryPolicyConstraints,
} = require('./recoveryDecisionService');

/*
 * --------------------------------------------------
 * ALLOWED AI ACTIONS
 * --------------------------------------------------
 *
 * AI can only recommend actions that exist in the
 * recovery action definition.
 *
 * This does NOT mean every action is executable.
 * The active recovery policy decides that later.
 */
const ALLOWED_AI_ACTIONS = new Set(
  Object.values(ACTIONS),
);

/*
 * --------------------------------------------------
 * NORMALIZE ACTION
 * --------------------------------------------------
 */

function normalizeAction(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

/*
 * --------------------------------------------------
 * NORMALIZE RISK LEVEL
 * --------------------------------------------------
 */

function normalizeRiskLevel(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

/*
 * --------------------------------------------------
 * VALIDATE AI RECOMMENDATION
 * --------------------------------------------------
 *
 * Responsibilities:
 *
 * 1. Verify recommendation belongs to the recovery case.
 * 2. Validate action.
 * 3. Validate confidence.
 * 4. Validate risk level.
 * 5. Validate reason.
 * 6. Ask recovery policy what is permitted.
 * 7. Never allow AI to bypass policy.
 * 8. Return either:
 *      - accepted AI action
 *      - deterministic policy fallback
 *
 * IMPORTANT:
 *
 * This service does NOT execute an action.
 * This service does NOT modify the recovery case.
 */

function validateAIRecommendation({
  aiRecommendation,
  recoveryCase,
  transaction,
  customer = null,
  now = new Date(),
}) {
  /*
   * --------------------------------------------------
   * 1. BASIC VALIDATION
   * --------------------------------------------------
   */

  if (!aiRecommendation) {
    throw new Error(
      'AI recommendation is required.',
    );
  }

  if (!recoveryCase) {
    throw new Error(
      'Recovery case is required.',
    );
  }

  /*
   * --------------------------------------------------
   * 2. READ AI RECOMMENDATION
   * --------------------------------------------------
   */

  const {
    recoveryCaseId,
    confidence,
    reason,
  } = aiRecommendation;

  const recommendedAction = normalizeAction(
    aiRecommendation.recommendedAction ||
      aiRecommendation.action,
  );

  const riskLevel = normalizeRiskLevel(
    aiRecommendation.riskLevel,
  );

  /*
   * --------------------------------------------------
   * 3. ASK POLICY ENGINE
   * --------------------------------------------------
   *
   * Step 1 is the source of truth.
   *
   * The AI does NOT decide what is allowed.
   */

  const constraints =
    getRecoveryPolicyConstraints({
      failureCategory:
        transaction?.failureCategory ||
        'UNKNOWN',

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

      communicationConsent:
        customer?.communicationConsent || {},

      now,
    });

  /*
   * --------------------------------------------------
   * 4. NORMALIZED POLICY DECISION
   * --------------------------------------------------
   */

  const policyDecision = {
    action:
      constraints.policyDecision.action,

    reasonCode:
      constraints.policyDecision.reasonCode,

    reason:
      constraints.policyDecision.reason,

    bounded:
      constraints.policyDecision.bounded,

    requiresCustomerAction:
      constraints.policyDecision
        .requiresCustomerAction,

    allowedActions:
      constraints.allowedActions,
  };

  /*
   * --------------------------------------------------
   * 5. RECOVERY CASE ID CHECK
   * --------------------------------------------------
   *
   * The recommendation must belong to the exact
   * recovery case being processed.
   */

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

      aiRecommendation: null,

      policyDecision,

      finalAction: null,

      executionAllowed: false,
    };
  }

  /*
   * --------------------------------------------------
   * 6. POLICY BLOCK CHECK
   * --------------------------------------------------
   *
   * If policy blocks the case, AI cannot override it.
   */

  if (constraints.blocked) {
    return {
      accepted: false,

      reasonCode:
        constraints.reasonCode,

      message:
        constraints.message,

      aiRecommendation: {
        action:
          recommendedAction || null,

        confidence,

        riskLevel,

        reason:
          String(reason || '').trim(),
      },

      policyDecision,

      finalAction: null,

      executionAllowed: false,
    };
  }

  /*
   * --------------------------------------------------
   * 7. VALIDATE ACTION
   * --------------------------------------------------
   */

  const hasValidAction =
    ALLOWED_AI_ACTIONS.has(
      recommendedAction,
    );

  /*
   * --------------------------------------------------
   * 8. VALIDATE CONFIDENCE
   * --------------------------------------------------
   *
   * Confidence must be:
   *
   * - number
   * - finite
   * - >= 0
   * - <= 1
   */

  const hasValidConfidence =
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1;

  /*
   * --------------------------------------------------
   * 9. VALIDATE RISK LEVEL
   * --------------------------------------------------
   */

  const hasValidRiskLevel = [
    'LOW',
    'MEDIUM',
    'HIGH',
  ].includes(riskLevel);

  /*
   * --------------------------------------------------
   * 10. VALIDATE REASON
   * --------------------------------------------------
   */

  const normalizedReason =
    String(reason || '').trim();

  const hasValidReason =
    normalizedReason.length > 0;

  /*
   * --------------------------------------------------
   * 11. COMPLETE AI VALIDATION
   * --------------------------------------------------
   */

  const validRecommendation =
    hasValidAction &&
    hasValidConfidence &&
    hasValidRiskLevel &&
    hasValidReason;

  /*
   * --------------------------------------------------
   * 12. CHECK POLICY PERMISSION
   * --------------------------------------------------
   *
   * A structurally valid AI recommendation is still
   * rejected if the active policy does not permit it.
   */

  const actionIsAllowed =
    validRecommendation &&
    constraints.allowedActions.includes(
      recommendedAction,
    );

  /*
   * --------------------------------------------------
   * 13. DETERMINE FINAL ACTION
   * --------------------------------------------------
   *
   * CASE 1:
   * AI recommendation is valid AND permitted.
   *
   *     finalAction = AI action
   *
   * CASE 2:
   * AI recommendation is invalid OR not permitted.
   *
   *     finalAction = deterministic policy fallback
   *
   * The AI can NEVER override this fallback.
   */

  const finalAction = actionIsAllowed
    ? recommendedAction
    : constraints.fallbackAction;

  /*
   * --------------------------------------------------
   * 14. RETURN RESULT
   * --------------------------------------------------
   */

  return {
    accepted: actionIsAllowed,

    reasonCode: actionIsAllowed
      ? 'AI_RECOMMENDATION_ACCEPTED'
      : validRecommendation
        ? 'AI_ACTION_NOT_ALLOWED_BY_POLICY'
        : 'AI_RECOMMENDATION_INVALID',

    message: actionIsAllowed
      ? 'AI recommendation is within the active recovery policy constraints.'
      : `AI recommendation was not executable. Policy selected ${finalAction} as the bounded fallback action.`,

    aiRecommendation: {
      action:
        recommendedAction || null,

      confidence:
        hasValidConfidence
          ? confidence
          : null,

      riskLevel:
        hasValidRiskLevel
          ? riskLevel
          : null,

      reason:
        normalizedReason || null,
    },

    policyDecision,

    finalAction,

    executionAllowed:
      Boolean(finalAction),
  };
}

/*
 * --------------------------------------------------
 * EXPORT
 * --------------------------------------------------
 */

module.exports = {
  validateAIRecommendation,
};