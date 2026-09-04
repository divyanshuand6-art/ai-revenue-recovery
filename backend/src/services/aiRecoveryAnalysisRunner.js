const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');

const {
  getRecoveryPolicyConstraints,
} = require('./recoveryDecisionService');

const {
  validateAIRecommendation,
} = require('./aiRecommendationValidationService');

const {
  processRecoveryCasesInBatches,
} = require('./aiLargeBatchProcessor_true_batch');

/*
 * --------------------------------------------------
 * AI CONFIGURATION
 * --------------------------------------------------
 */

const AI_MODEL =
  process.env.GEMINI_MODEL ||
  'gemini-3.1-flash-lite';

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY;

/*
 * --------------------------------------------------
 * EXECUTABLE ACTIONS
 * --------------------------------------------------
 */

const EXECUTABLE_ACTIONS = Object.freeze([
  'PAYMENT_RETRY',
  'DELAYED_RETRY',
  'RECOVERY_LINK',
  'ALTERNATIVE_PAYMENT',
  'REMINDER',
  'FOLLOW_UP',
  'ESCALATE',
  'STOP',
]);

/*
 * --------------------------------------------------
 * HELPERS
 * --------------------------------------------------
 */

function createAuditMetadata(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(
        ([, value]) =>
          value !== undefined &&
          value !== null,
      )
      .map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value
          : JSON.stringify(value),
      ]),
  );
}

function clamp(value, min, max) {
  return Math.min(
    Math.max(value, min),
    max,
  );
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

/*
 * --------------------------------------------------
 * CLEAN GEMINI JSON
 * --------------------------------------------------
 */

function cleanJsonText(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/*
 * --------------------------------------------------
 * PARSE GEMINI RESPONSE
 * --------------------------------------------------
 */

function parseAIResponse(text) {
  const cleaned =
    cleanJsonText(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    /*
     * Sometimes the model adds explanatory text
     * around the JSON. Try to extract the first
     * JSON object.
     */

    const start =
      cleaned.indexOf('{');

    const end =
      cleaned.lastIndexOf('}');

    if (
      start >= 0 &&
      end > start
    ) {
      return JSON.parse(
        cleaned.slice(
          start,
          end + 1,
        ),
      );
    }

    throw new Error(
      'Gemini returned an invalid JSON response.',
    );
  }
}

/*
 * --------------------------------------------------
 * NORMALIZE AI RECOMMENDATION
 * --------------------------------------------------
 */

function normalizeAIRecommendation(raw) {
  const action = String(
    raw?.action || '',
  )
    .trim()
    .toUpperCase();

  if (
    !EXECUTABLE_ACTIONS.includes(
      action,
    )
  ) {
    throw new Error(
      `Gemini returned unsupported action: ${action}`,
    );
  }

  const confidence = clamp(
    toNumber(
      raw?.confidence,
      0,
    ),
    0,
    1,
  );

  const riskLevel =
    String(
      raw?.riskLevel ||
        raw?.risk_level ||
        'MEDIUM',
    )
      .trim()
      .toUpperCase();

  const allowedRiskLevels = [
    'LOW',
    'MEDIUM',
    'HIGH',
  ];

  const normalizedRisk =
    allowedRiskLevels.includes(
      riskLevel,
    )
      ? riskLevel
      : 'MEDIUM';

  const reason =
    String(
      raw?.reason ||
        raw?.rationale ||
        raw?.explanation ||
        '',
    ).trim();

  const customerMessage =
    String(
      raw?.customerMessage ||
        raw?.customer_message ||
        '',
    ).trim();

  const stopCondition =
    String(
      raw?.stopCondition ||
        raw?.stop_condition ||
        '',
    ).trim();

  const nextActionAt =
    raw?.nextActionAt ||
    raw?.next_action_at ||
    null;

  const reasonCode =
    String(
      raw?.reasonCode ||
        raw?.reason_code ||
        '',
    )
      .trim()
      .toUpperCase();

  /*
   * Gemini may return evaluatedActions.
   * Keep at most five candidates.
   */

  const rawEvaluatedActions =
    raw?.evaluatedActions ||
    raw?.evaluated_actions;

  const evaluatedActions =
    Array.isArray(
      rawEvaluatedActions,
    )
      ? rawEvaluatedActions
          .slice(0, 5)
          .map((candidate) => {
            const candidateAction =
              String(
                candidate?.action || '',
              )
                .trim()
                .toUpperCase();

            if (
              !EXECUTABLE_ACTIONS.includes(
                candidateAction,
              )
            ) {
              return null;
            }

            return {
              action:
                candidateAction,

              confidence: clamp(
                toNumber(
                  candidate?.confidence,
                  0,
                ),
                0,
                1,
              ),

              reason:
                String(
                  candidate?.reason ||
                    '',
                ).trim(),
            };
          })
          .filter(Boolean)
      : [];

  return {
    action,

    confidence,

    riskLevel:
      normalizedRisk,

    reason,

    rationale:
      reason,

    customerMessage,

    nextActionAt,

    stopCondition,

    reasonCode,

    evaluatedActions,
  };
}

/*
 * --------------------------------------------------
 * GEMINI REQUEST
 * --------------------------------------------------
 */

async function callGemini(input) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not configured.',
    );
  }

  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${encodeURIComponent(
        GEMINI_API_KEY,
      )}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          contents: [
            {
              role: 'user',

              parts: [
                {
                  text: input,
                },
              ],
            },
          ],

          generationConfig: {
            temperature: 0,

            responseMimeType:
              'application/json',
          },
        }),
      },
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    const error =
      new Error(
        `Gemini request failed with status ${response.status}.`,
      );

    error.status =
      response.status;

    error.details =
      errorText;

    throw error;
  }

  const payload =
    await response.json();

  const text =
    payload?.candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;

  if (!text) {
    throw new Error(
      'Gemini returned an empty response.',
    );
  }

  const parsed =
    parseAIResponse(text);

  return normalizeAIRecommendation(
    parsed,
  );
}

/*
 * --------------------------------------------------
 * BUILD AI INPUT
 * --------------------------------------------------
 */

function buildAIInput({
  recoveryCase,
  transaction,
  customer,
  policyConstraints,
}) {
  return `
You are an AI revenue recovery decision engine.

You MUST return ONLY valid JSON.

Do not invent facts.
Do not bypass deterministic policy.
The final action will be validated by a policy engine.

RECOVERY CASE:
${JSON.stringify(
  {
    id:
      recoveryCase?._id,

    type:
      recoveryCase?.type,

    status:
      recoveryCase?.status,

    amountAtRiskMinor:
      recoveryCase?.amountAtRiskMinor,

    eligibleAmountMinor:
      recoveryCase?.eligibleAmountMinor,

    recoveredAmountMinor:
      recoveryCase?.recoveredAmountMinor,

    retryCount:
      recoveryCase?.retryCount,

    reminderCount:
      recoveryCase?.reminderCount,

    currentAction:
      recoveryCase?.currentAction,

    actionTaken:
      recoveryCase?.actionTaken,

    recoveryWindowEndsAt:
      recoveryCase?.recoveryWindowEndsAt,
  },
  null,
  2,
)}

SOURCE TRANSACTION:
${JSON.stringify(
  {
    id:
      transaction?._id,

    type:
      transaction?.type,

    amountMinor:
      transaction?.amountMinor,

    failureCategory:
      transaction?.failureCategory,

    failureCode:
      transaction?.failureCode,

    failureReason:
      transaction?.failureReason,

    failureStage:
      transaction?.failureStage,

    paymentMethod:
      transaction?.paymentMethod,

    occurredAt:
      transaction?.occurredAt,
  },
  null,
  2,
)}

CUSTOMER:
${JSON.stringify(
  {
    id:
      customer?._id,

    communicationConsent:
      customer?.communicationConsent,

    paymentHistory:
      customer?.paymentHistory,
  },
  null,
  2,
)}

DETERMINISTIC POLICY CONSTRAINTS:
${JSON.stringify(
  policyConstraints,
  null,
  2,
)}

Choose the most appropriate recovery action.

Allowed executable actions:
${EXECUTABLE_ACTIONS.join(', ')}

JSON format:
{
  "action": "ONE_ALLOWED_ACTION",
  "confidence": 0.0,
  "riskLevel": "LOW|MEDIUM|HIGH",
  "reason": "brief reason",
  "customerMessage": "optional customer-facing message",
  "nextActionAt": null,
  "stopCondition": "optional stop condition",
  "reasonCode": "optional reason code",
  "evaluatedActions": []
}
`;
}

/*
 * --------------------------------------------------
 * CREATE FALLBACK RECOMMENDATION
 * --------------------------------------------------
 */

function buildFallbackRecommendation({
  policyConstraints,
}) {
  const policyAction =
    policyConstraints?.defaultAction ||
    policyConstraints?.fallbackAction ||
    policyConstraints?.allowedActions?.[0] ||
    'ESCALATE';

  return {
    action:
      EXECUTABLE_ACTIONS.includes(
        policyAction,
      )
        ? policyAction
        : 'ESCALATE',

    confidence:
      0,

    riskLevel:
      'HIGH',

    reason:
      'AI analysis failed; deterministic policy fallback was used.',

    rationale:
      'AI analysis failed; deterministic policy fallback was used.',

    customerMessage:
      '',

    nextActionAt:
      null,

    stopCondition:
      '',

    reasonCode:
      'AI_FALLBACK',

    evaluatedActions: [],
  };
}

/*
 * --------------------------------------------------
 * LOAD SOURCE CONTEXT
 * --------------------------------------------------
 */

async function loadSourceContext(
  recoveryCase,
) {
  const [
    transaction,
    customer,
  ] = await Promise.all([
    recoveryCase?.sourceTransactionId
      ? Transaction.findOne({
          _id:
            recoveryCase.sourceTransactionId,

          merchantId:
            recoveryCase.merchantId,
        }).lean()
      : null,

    recoveryCase?.customerId
      ? Customer.findOne({
          _id:
            recoveryCase.customerId,

          merchantId:
            recoveryCase.merchantId,
        }).lean()
      : null,
  ]);

  return {
    transaction,
    customer,
  };
}

/*
 * --------------------------------------------------
 * VALIDATE AGAINST POLICY
 * --------------------------------------------------
 */

async function validateAgainstPolicy({
  recoveryCase,
  transaction,
  customer,
  aiRecommendation,
  now,
}) {
  const policyConstraints =
    await getRecoveryPolicyConstraints({
      recoveryCase,
      transaction,
      customer,
      now,
    });

  const policyValidation =
    validateAIRecommendation({
      aiRecommendation,
      recoveryCase,
      transaction,
      customer,
      now,
    });

  return {
    ...policyValidation,

    policyConstraints,
  };
}

/*
 * --------------------------------------------------
 * AI AUDIT
 * --------------------------------------------------
 */

async function createAIAnalysisAudit({
  recoveryCase,
  aiRecommendation,
  policyValidation,
}) {
  await AuditLog.create({
    merchantId:
      recoveryCase.merchantId,

    recoveryCaseId:
      recoveryCase._id,

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
      policyValidation.reason ||
      aiRecommendation.reason ||
      'AI analysis completed.',

    metadata:
      createAuditMetadata({
        aiModel:
          AI_MODEL,

        recommendedAction:
          aiRecommendation.action,

        confidence:
          aiRecommendation.confidence,

        riskLevel:
          aiRecommendation.riskLevel,

        reasonCode:
          aiRecommendation.reasonCode,

        policyAccepted:
          policyValidation.accepted,

        finalAction:
          policyValidation.finalAction,

        executionAllowed:
          policyValidation.executionAllowed,

        policyReasonCode:
          policyValidation.reasonCode,

        evaluatedActions:
          aiRecommendation.evaluatedActions,
      }),

    occurredAt:
      new Date(),
  });
}

/*
 * --------------------------------------------------
 * PERSIST AI DECISION
 * --------------------------------------------------
 */

async function persistAIAnalysis({
  recoveryCase,
  aiRecommendation,
  policyValidation,
}) {
  recoveryCase.agentDecision = {
    ...(recoveryCase.agentDecision || {}),

    action:
      aiRecommendation.action,

    recommendedAction:
      aiRecommendation.action,

    finalAction:
      policyValidation.finalAction,

    policyAccepted:
      policyValidation.accepted,

    riskLevel:
      aiRecommendation.riskLevel,

    provider:
      'GEMINI',

    policyReasonCode:
      policyValidation.reasonCode,

    confidence:
      aiRecommendation.confidence,

    reasonCode:
      aiRecommendation.reasonCode,

    rationale:
      aiRecommendation.reason,

    customerMessage:
      aiRecommendation.customerMessage,

    nextActionAt:
      aiRecommendation.nextActionAt,

    stopCondition:
      aiRecommendation.stopCondition,

    analyzedAt:
      new Date(),
  };

  /*
   * Persist current approved action only when execution
   * is actually allowed.
   */

  if (
    policyValidation.executionAllowed &&
    policyValidation.finalAction
  ) {
    recoveryCase.currentAction =
      policyValidation.finalAction;
  }

  await recoveryCase.save();
}

/*
 * --------------------------------------------------
 * SINGLE CASE ANALYSIS
 * --------------------------------------------------
 */

async function analyzeSingleRecoveryCase({
  recoveryCase,
}) {
  const now =
    new Date();

  const {
    transaction,
    customer,
  } =
    await loadSourceContext(
      recoveryCase,
    );

  const policyConstraints =
    await getRecoveryPolicyConstraints({
      recoveryCase,
      transaction,
      customer,
      now,
    });

  const input =
    buildAIInput({
      recoveryCase,
      transaction,
      customer,
      policyConstraints,
    });

  /*
   * --------------------------------------------------
   * CALL GEMINI
   * --------------------------------------------------
   */

  let aiRecommendation;

  try {
    aiRecommendation =
      await callGemini(input);
  } catch (error) {
    console.error(
      `Gemini analysis failed for recovery case ${recoveryCase._id}:`,
      error,
    );

    aiRecommendation =
      buildFallbackRecommendation({
        policyConstraints,
      });
  }

  /*
   * --------------------------------------------------
   * POLICY VALIDATION
   * --------------------------------------------------
   */

  const policyValidation =
    await validateAgainstPolicy({
      recoveryCase,
      transaction,
      customer,
      aiRecommendation,
      now,
    });

  /*
   * --------------------------------------------------
   * AUDIT
   * --------------------------------------------------
   */

  await createAIAnalysisAudit({
    recoveryCase,
    aiRecommendation,
    policyValidation,
  });

  /*
   * --------------------------------------------------
   * PERSIST APPROVED DECISION
   * --------------------------------------------------
   */

  await persistAIAnalysis({
    recoveryCase,
    aiRecommendation,
    policyValidation,
  });

  /*
   * --------------------------------------------------
   * RETURN COMPLETE RESULT
   * --------------------------------------------------
   */

  return {
    recoveryCaseId:
      recoveryCase._id,

    aiRecommendation,

    policyValidation,

    finalAction:
      policyValidation.finalAction,

    blocked:
      policyValidation.executionAllowed
        ? false
        : !policyValidation.finalAction,

    skippedAI:
      false,
  };
}

/*
 * --------------------------------------------------
 * ACTIVE CASE QUERY
 * --------------------------------------------------
 */

function buildActiveCaseQuery(
  merchantId,
) {
  return {
    merchantId,

    status: {
      $nin: [
        'RECOVERED',
        'FAILED',
        'EXPIRED',
        'STOPPED',
      ],
    },
  };
}

/*
 * --------------------------------------------------
 * DATE RANGE
 * --------------------------------------------------
 */

function parseISTDateRange(
  from,
  to,
) {
  const isValid = (
    value,
  ) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(
      value,
    );

  if (
    !from &&
    !to
  ) {
    return {
      fromDate: null,
      toDateExclusive: null,
    };
  }

  if (
    !isValid(from) ||
    !isValid(to)
  ) {
    const error =
      new Error(
        'from and to must use YYYY-MM-DD format.',
      );

    error.status =
      400;

    throw error;
  }

  const fromDate =
    new Date(
      `${from}T00:00:00+05:30`,
    );

  const toDate =
    new Date(
      `${to}T00:00:00+05:30`,
    );

  if (
    Number.isNaN(
      fromDate.getTime(),
    ) ||
    Number.isNaN(
      toDate.getTime(),
    )
  ) {
    const error =
      new Error(
        'Invalid AI analysis date range.',
      );

    error.status =
      400;

    throw error;
  }

  const toDateExclusive =
    new Date(
      toDate.getTime() +
        24 * 60 * 60 * 1000,
    );

  if (
    fromDate >=
    toDateExclusive
  ) {
    const error =
      new Error(
        'Invalid AI analysis date range.',
      );

    error.status =
      400;

    throw error;
  }

  return {
    fromDate,
    toDateExclusive,
  };
}

/*
 * --------------------------------------------------
 * RUN AI RECOVERY ANALYSIS
 * --------------------------------------------------
 *
 * Supports:
 *
 * 1. Single case:
 *    { recoveryCaseId }
 *
 * 2. Batch:
 *    {
 *      limit,
 *      batchSize,
 *      activeOnly,
 *      from,
 *      to,
 *      status
 *    }
 *
 * --------------------------------------------------
 */

async function runAIRecoveryAnalysis({
  merchantId,
  recoveryCaseId,
  limit = 20,
  batchSize = 5,
  activeOnly = false,
  from,
  to,
  status,
}) {
  if (!merchantId) {
    throw new Error(
      'merchantId is required.',
    );
  }

  /*
   * --------------------------------------------------
   * SELECTED CASE MODE
   * --------------------------------------------------
   */

  if (recoveryCaseId) {
    const recoveryCase =
  await RecoveryCase.findOne({
    _id: recoveryCaseId,
    merchantId,
  });

    if (!recoveryCase) {
      const error =
        new Error(
          'Recovery case not found.',
        );

      error.status =
        404;

      throw error;
    }

    const recommendation =
      await analyzeSingleRecoveryCase({
        recoveryCase,
      });

    return {
      mode:
        'SINGLE_CASE',

      totalCases:
        1,

      batchSize:
        1,

      totalBatches:
        1,

      geminiRequests:
        1,

      recommendations: [
        recommendation,
      ],
    };
  }

  /*
   * --------------------------------------------------
   * BATCH MODE
   * --------------------------------------------------
   */

  const query = {
    ...(activeOnly
      ? buildActiveCaseQuery(
          merchantId,
        )
      : {
          merchantId,
        }),
  };

  /*
   * --------------------------------------------------
   * STATUS FILTER
   * --------------------------------------------------
   */

  if (
    status &&
    status !== 'ALL' &&
    status !== 'ACTION_REQUIRED'
  ) {
    query.status =
      status;
  }

  /*
   * --------------------------------------------------
   * IST DATE FILTER
   * --------------------------------------------------
   */

  const {
    fromDate,
    toDateExclusive,
  } =
    parseISTDateRange(
      from,
      to,
    );

  if (
    fromDate &&
    toDateExclusive
  ) {
    query.createdAt = {
      $gte:
        fromDate,

      $lt:
        toDateExclusive,
    };
  }

  /*
   * --------------------------------------------------
   * LIMITS
   * --------------------------------------------------
   */

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 20,
        1,
      ),
      100,
    );

  const safeBatchSize =
    Math.min(
      Math.max(
        Number(batchSize) || 5,
        1,
      ),
      safeLimit,
    );

  /*
   * --------------------------------------------------
   * LOAD CASES
   * --------------------------------------------------
   */

  const recoveryCases =
    await RecoveryCase.find(
      query,
    )
      .sort({
        createdAt:
          -1,
      })
      .limit(
        safeLimit,
      )
      .lean();

  /*
   * --------------------------------------------------
   * TRUE AI BATCH PROCESSING
   * --------------------------------------------------
   *
   * IMPORTANT:
   * batchSize = 20 means:
   *
   * 20 cases -> 1 Gemini request
   *
   * not:
   *
   * 20 cases -> 20 Gemini requests
   *
   * --------------------------------------------------
   */

  if (
    recoveryCases.length === 0
  ) {
    return {
      mode:
        'BATCH',

      totalCases:
        0,

      batchSize:
        safeBatchSize,

      totalBatches:
        0,

      geminiRequests:
        0,

      failedBatches:
        0,

      fallbackRecommendations:
        0,

      batchResults:
        [],

      recommendations:
        [],
    };
  }

  console.log(
    `Starting TRUE AI batch analysis: ${recoveryCases.length} cases, batchSize=${safeBatchSize}`,
  );

  const batchResult =
    await processRecoveryCasesInBatches(
      recoveryCases,
      {
        batchSize:
          safeBatchSize,
      },
    );

  console.log(
    `TRUE AI batch analysis completed: ${batchResult.totalCases} cases, ${batchResult.geminiRequests} Gemini requests`,
  );

  return {
    mode:
      'BATCH',

    totalCases:
      batchResult.totalCases,

    batchSize:
      batchResult.batchSize,

    totalBatches:
      batchResult.totalBatches,

    geminiRequests:
      batchResult.geminiRequests,

    failedBatches:
      batchResult.failedBatches,

    fallbackRecommendations:
      batchResult.fallbackRecommendations,

    batchResults:
      batchResult.batchResults,

    recommendations:
      batchResult.recommendations,
  };
}

/*
 * --------------------------------------------------
 * EXPORT
 * --------------------------------------------------
 */

module.exports = {
  runAIRecoveryAnalysis,
};