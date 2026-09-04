const {
  createGeminiClient,
  getGeminiModel,
} = require('../config/ai');

const ALLOWED_ACTIONS = new Set([
  'PAYMENT_RETRY',
  'DELAYED_RETRY',
  'RECOVERY_LINK',
  'ALTERNATIVE_PAYMENT',
  'REMINDER',
  'FOLLOW_UP',
  'ESCALATE',
  'STOP',
]);

const ALLOWED_RISK_LEVELS = new Set([
  'LOW',
  'MEDIUM',
  'HIGH',
]);

function buildBatchPrompt(recoveryCases) {
  return `
You are an AI revenue recovery analysis system.

Analyze ALL supplied recovery cases independently, but in ONE batch.

Your job is ONLY to recommend a bounded recovery action for EACH case.
Do not execute payments.
Do not modify database records.
Do not claim that a payment succeeded unless the supplied evidence explicitly says so.

IMPORTANT POLICY RULE:
Every recovery case contains its own policy.allowedActions.
That list is the authoritative action boundary for THAT case.
You MUST choose recommendedAction from that case's policy.allowedActions.
Never choose an action merely because it exists in the global vocabulary.

Globally known action vocabulary:

PAYMENT_RETRY
DELAYED_RETRY
RECOVERY_LINK
ALTERNATIVE_PAYMENT
REMINDER
FOLLOW_UP
ESCALATE
STOP

For every supplied, AI-eligible recovery case, return exactly one recommendation.

Return ONLY valid JSON in this structure:

{
  "recommendations": [
    {
      "recoveryCaseId": "string",
      "recommendedAction": "one action from this case's policy.allowedActions",
      "confidence": 0.0,
      "riskLevel": "LOW | MEDIUM | HIGH",
      "reason": "short explanation"
    }
  ]
}

Rules:
- recoveryCaseId must exactly match a supplied recovery case.
- recommendedAction MUST be in that case's policy.allowedActions.
- If a case has an empty policy.allowedActions, that case should not be present in this prompt.
- confidence must be between 0 and 1.
- riskLevel must be LOW, MEDIUM, or HIGH.
- Return exactly one recommendation for each supplied case.
- Do not create recommendations for cases that were not supplied.
- Do not omit any supplied case.
- Keep reasons concise and evidence-based.
- Consider failure details, amount at risk, retry count, reminder count, recovery-window timing, payment history, communication consent, and the case-specific policy boundary.
- Prefer the least aggressive action that is well supported by the supplied evidence.
- Never claim that money was recovered merely because an action is recommended.

Recovery cases:

${JSON.stringify(recoveryCases, null, 2)}
`;
}

function validateRecommendation(
  recommendation,
  expectedCaseIds,
) {
  if (
    !recommendation ||
    typeof recommendation !== 'object'
  ) {
    throw new Error(
      'AI returned an invalid recommendation object.',
    );
  }

  const {
    recoveryCaseId,
    recommendedAction,
    confidence,
    riskLevel,
    reason,
  } = recommendation;

  if (
    typeof recoveryCaseId !== 'string' ||
    !expectedCaseIds.has(recoveryCaseId)
  ) {
    throw new Error(
      'AI returned an unknown recoveryCaseId.',
    );
  }

  if (
    !ALLOWED_ACTIONS.has(
      recommendedAction,
    )
  ) {
    throw new Error(
      `AI returned unsupported recovery action: ${recommendedAction}`,
    );
  }

  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error(
      `Invalid AI confidence for recovery case ${recoveryCaseId}.`,
    );
  }

  if (
    !ALLOWED_RISK_LEVELS.has(
      riskLevel,
    )
  ) {
    throw new Error(
      `Invalid AI risk level for recovery case ${recoveryCaseId}.`,
    );
  }

  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0
  ) {
    throw new Error(
      `AI reason is missing for recovery case ${recoveryCaseId}.`,
    );
  }

  return {
    recoveryCaseId,
    recommendedAction,
    confidence,
    riskLevel,
    reason: reason.trim(),
  };
}

function validateBatchResponse(
  parsedResponse,
  recoveryCases,
) {
  if (
    !parsedResponse ||
    typeof parsedResponse !== 'object'
  ) {
    throw new Error(
      'AI response must be a JSON object.',
    );
  }

  if (
    !Array.isArray(
      parsedResponse.recommendations,
    )
  ) {
    throw new Error(
      'AI response must contain a recommendations array.',
    );
  }

  const expectedCaseIds =
    new Set(
      recoveryCases.map(
        (recoveryCase) =>
          String(
            recoveryCase.recoveryCaseId,
          ),
      ),
    );

  if (
    parsedResponse.recommendations.length !==
    recoveryCases.length
  ) {
    throw new Error(
      `AI returned ${parsedResponse.recommendations.length} recommendations for ${recoveryCases.length} recovery cases.`,
    );
  }

  const seenCaseIds = new Set();

  const recommendations =
    parsedResponse.recommendations.map(
      (recommendation) => {
        const validated =
          validateRecommendation(
            recommendation,
            expectedCaseIds,
          );

        if (
          seenCaseIds.has(
            validated.recoveryCaseId,
          )
        ) {
          throw new Error(
            `AI returned duplicate recommendation for recovery case ${validated.recoveryCaseId}.`,
          );
        }

        seenCaseIds.add(
          validated.recoveryCaseId,
        );

        const sourceCase =
          recoveryCases.find(
            (recoveryCase) =>
              String(
                recoveryCase.recoveryCaseId,
              ) ===
              validated.recoveryCaseId,
          );

        if (!sourceCase) {
          throw new Error(
            `AI source case ${validated.recoveryCaseId} was not found.`,
          );
        }

        const allowedActions =
          sourceCase.policy
            ?.allowedActions || [];

        if (
          !allowedActions.includes(
            validated.recommendedAction,
          )
        ) {
          throw new Error(
            `AI action ${validated.recommendedAction} is not allowed for recovery case ${validated.recoveryCaseId}.`,
          );
        }

        return validated;
      },
    );

  for (const expectedCaseId of expectedCaseIds) {
    if (!seenCaseIds.has(expectedCaseId)) {
      throw new Error(
        `AI did not return a recommendation for recovery case ${expectedCaseId}.`,
      );
    }
  }

  return recommendations;
}

async function analyzeRecoveryBatch(
  recoveryCases,
) {
  if (!Array.isArray(recoveryCases)) {
    throw new Error(
      'recoveryCases must be an array.',
    );
  }

  if (recoveryCases.length === 0) {
    return {
      model: getGeminiModel(),
      recommendations: [],
    };
  }

  const client =
    createGeminiClient();

  const prompt = buildBatchPrompt(
    recoveryCases,
  );

  const response =
    await client.models.generateContent({
      model: getGeminiModel(),
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType:
          'application/json',
      },
    });

  const responseText =
    response.text;

  if (
    typeof responseText !== 'string' ||
    responseText.trim().length === 0
  ) {
    throw new Error(
      'Gemini returned an empty response.',
    );
  }

  let parsedResponse;

  try {
    parsedResponse =
      JSON.parse(responseText);
  } catch {
    throw new Error(
      'Gemini returned invalid JSON.',
    );
  }

  const recommendations =
    validateBatchResponse(
      parsedResponse,
      recoveryCases,
    );

  return {
    model: getGeminiModel(),
    recommendations,
  };
}

module.exports = {
  analyzeRecoveryBatch,
};
