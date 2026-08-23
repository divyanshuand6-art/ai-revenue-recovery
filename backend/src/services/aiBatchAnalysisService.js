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

Analyze the supplied recovery cases.

Your job is ONLY to recommend a bounded recovery action.
Do not execute payments.
Do not invent actions.
Do not modify database records.

Allowed actions:

PAYMENT_RETRY
DELAYED_RETRY
RECOVERY_LINK
ALTERNATIVE_PAYMENT
REMINDER
FOLLOW_UP
ESCALATE
STOP

For every recovery case, return exactly one recommendation.

Return ONLY valid JSON in this structure:

{
  "recommendations": [
    {
      "recoveryCaseId": "string",
      "recommendedAction": "one allowed action",
      "confidence": 0.0,
      "riskLevel": "LOW | MEDIUM | HIGH",
      "reason": "short explanation"
    }
  ]
}

Rules:

- recoveryCaseId must exactly match the supplied case.
- recommendedAction must be one of the allowed actions.
- confidence must be between 0 and 1.
- riskLevel must be LOW, MEDIUM, or HIGH.
- Do not create recommendations for cases that were not supplied.
- Do not omit supplied cases.
- Keep reasons concise.
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
          String(recoveryCase.recoveryCaseId),
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

  const prompt =
    buildBatchPrompt(
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
  } catch (error) {
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