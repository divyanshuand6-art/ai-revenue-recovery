const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');

const {
  decideRecoveryAction,
} = require('./recoveryDecisionService');

const AI_MODEL =
  process.env.GEMINI_MODEL ||
  'gemini-3.1-flash-lite';

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY;

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
        String(value),
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

function cleanJsonText(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseAIResponse(text) {
  const cleaned =
    cleanJsonText(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    /*
     * Sometimes the model adds explanatory
     * text around the JSON. Extract the first
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

function normalizeAIRecommendation(
  raw,
) {
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

  return {
    action,

    confidence: Number(
      confidence.toFixed(2),
    ),

    riskLevel:
      allowedRiskLevels.includes(
        riskLevel,
      )
        ? riskLevel
        : 'MEDIUM',

    reason:
      String(
        raw?.reason ||
          'No explanation was provided.',
      ).trim(),

    provider: 'GEMINI',
  };
}

function buildAIInput({
  recoveryCase,
  transaction,
  customer,
}) {
  return {
    recoveryCase: {
      id: String(
        recoveryCase._id,
      ),

      type:
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
        recoveryCase.retryAttemptCount,

      reminderCount:
        recoveryCase.reminderCount,

      currentAction:
        recoveryCase.currentAction,

      recoveryWindowEndsAt:
        recoveryCase.recoveryWindowEndsAt,

      policySnapshot:
        recoveryCase.policySnapshot ||
        {},
    },

    transaction: transaction
      ? {
          id: String(
            transaction._id,
          ),

          type:
            transaction.type,

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

    customer: customer
      ? {
          id: String(
            customer._id,
          ),

          name:
            customer.fullName ||
            customer.name ||
            null,

          email:
            customer.email ||
            null,

          phone:
            customer.phone ||
            null,
        }
      : null,
  };
}

function buildPrompt(input) {
  return `
You are the AI analysis component of a revenue recovery system.

Analyze ONLY the single recovery case provided below.

Your job is to recommend the most appropriate bounded recovery action.

Allowed actions:
PAYMENT_RETRY
DELAYED_RETRY
RECOVERY_LINK
ALTERNATIVE_PAYMENT
REMINDER
FOLLOW_UP
ESCALATE
STOP

Do NOT invent transaction facts.
Do NOT claim payment was recovered.
Do NOT execute any action.
The deterministic policy engine will make the final decision.

Return ONLY valid JSON with this exact shape:

{
  "action": "PAYMENT_RETRY",
  "confidence": 0.90,
  "riskLevel": "LOW",
  "reason": "short explanation"
}

confidence must be a number from 0 to 1.

riskLevel must be one of:
LOW
MEDIUM
HIGH

Recovery case data:
${JSON.stringify(
  input,
  null,
  2,
)}
`;
}

async function callGemini(
  input,
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not configured.',
    );
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY,
    )}`;

  const response =
    await fetch(endpoint, {
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
                text:
                  buildPrompt(
                    input,
                  ),
              },
            ],
          },
        ],

        generationConfig: {
          temperature: 0.1,

          responseMimeType:
            'application/json',
        },
      }),
    });

  if (!response.ok) {
    let details = '';

    try {
      const body =
        await response.json();

      details =
        body?.error?.message ||
        '';
    } catch {
      details = '';
    }

    const error =
      new Error(
        `Gemini API request failed with status ${response.status}.${
          details
            ? ` ${details}`
            : ''
        }`,
      );

    error.status =
      response.status;

    throw error;
  }

  const data =
    await response.json();

  const text =
    data?.candidates?.[0]
      ?.content?.parts
      ?.map(
        (part) =>
          part?.text || '',
      )
      .join('') || '';

  if (!text) {
    throw new Error(
      'Gemini returned an empty response.',
    );
  }

  return normalizeAIRecommendation(
    parseAIResponse(text),
  );
}

function buildFallbackRecommendation({
  transaction,
}) {
  const failureCategory =
    transaction
      ?.failureCategory ||
    null;

  let action = 'ESCALATE';

  let reason =
    'No reliable AI recommendation was available, so the system falls back to a bounded safe action.';

  let confidence = 0;

  if (
    failureCategory ===
      'NETWORK_ERROR' ||
    failureCategory ===
      'PROCESSING_ERROR'
  ) {
    action =
      'PAYMENT_RETRY';

    confidence = 0.85;

    reason =
      'Transient payment failure detected; a bounded retry is the safest fallback.';
  } else if (
    failureCategory ===
    'INSUFFICIENT_FUNDS'
  ) {
    action =
      'DELAYED_RETRY';

    confidence = 0.5;

    reason =
      'Insufficient funds detected; an immediate retry is avoided in favour of a delayed bounded recovery attempt.';
  } else if (
    failureCategory ===
      'AUTHENTICATION_FAILED' ||
    failureCategory ===
      'CARD_EXPIRED'
  ) {
    action =
      'ALTERNATIVE_PAYMENT';

    confidence = 0.5;

    reason =
      'The current payment instrument is unlikely to succeed again, so an alternative payment method is safer.';
  } else if (
    failureCategory ===
      'BANK_DECLINED' ||
    failureCategory ===
      'MANDATE_ERROR'
  ) {
    action =
      'ALTERNATIVE_PAYMENT';

    confidence = 0.5;

    reason =
      'The payment method has a bank or mandate issue, so another supported payment method is preferred.';
  } else if (
    failureCategory ===
      'FRAUD_SUSPECTED' ||
    failureCategory ===
      'CARD_BLOCKED'
  ) {
    action =
      'ESCALATE';

    confidence = 0.15;

    reason =
      'The payment failure may require manual review rather than automated retries.';
  }

  return {
    action,

    confidence,

    riskLevel:
      action ===
      'ESCALATE'
        ? 'HIGH'
        : 'MEDIUM',

    reason,

    provider:
      'RULE_BASED_FALLBACK',
  };
}

async function validateAgainstPolicy({
  recoveryCase,
  transaction,
  aiRecommendation,
}) {
  const policyDecision =
    decideRecoveryAction({
      failureCategory:
        transaction
          ?.failureCategory,

      caseType:
        recoveryCase.type,

      status:
        recoveryCase.status,

      retryAttemptCount:
        recoveryCase
          .retryAttemptCount ||
        0,

      reminderCount:
        recoveryCase
          .reminderCount ||
        0,

      eligibleAmountMinor:
        recoveryCase
          .eligibleAmountMinor ||
        0,

      recoveredAmountMinor:
        recoveryCase
          .recoveredAmountMinor ||
        0,

      recoveryWindowEndsAt:
        recoveryCase.recoveryWindowEndsAt,

      policySnapshot:
        recoveryCase.policySnapshot ||
        {},

      currentAction:
        recoveryCase.currentAction ||
        null,
    });

  const accepted =
    aiRecommendation.action ===
    policyDecision.action;

  return {
    accepted,

    reasonCode: accepted
      ? 'AI_RECOMMENDATION_ACCEPTED'
      : 'AI_RECOMMENDATION_REJECTED',

    message: accepted
      ? 'AI recommendation was accepted by the deterministic recovery policy.'
      : 'AI recommendation was rejected because the deterministic recovery policy selected a different action.',

    aiRecommendation,

    policyDecision,

    finalAction:
      policyDecision.action,
  };
}

async function createAIAnalysisAudit({
  recoveryCase,
  aiRecommendation,
  policyValidation,
}) {
  try {
    await AuditLog.create({
      merchantId:
        recoveryCase.merchantId,

      recoveryCaseId:
        recoveryCase._id,

      transactionId:
        recoveryCase.sourceTransactionId,

      actorType:
        'AI_AGENT',

      eventType:
        'AI_ANALYSIS_COMPLETED',

      action:
        aiRecommendation.action,

      result:
        policyValidation.accepted
          ? 'ACCEPTED'
          : 'REJECTED',

      message:
        aiRecommendation.reason,

      metadata:
        createAuditMetadata({
          provider:
            aiRecommendation.provider,

          confidence:
            aiRecommendation.confidence,

          riskLevel:
            aiRecommendation.riskLevel,

          policyAction:
            policyValidation
              .policyDecision
              .action,

          finalAction:
            policyValidation
              .finalAction,
        }),
    });
  } catch (auditError) {
    /*
     * Analysis should still succeed even if
     * an audit write fails.
     */
    console.error(
      'AI analysis audit log error:',
      auditError,
    );
  }
}

async function analyzeSingleRecoveryCase({
  recoveryCase,
}) {
  const [
    transaction,
    customer,
  ] = await Promise.all([
    Transaction.findOne({
      _id:
        recoveryCase.sourceTransactionId,

      merchantId:
        recoveryCase.merchantId,
    })
      .select(
        '_id type status amountMinor currency paymentMethod failureCategory failureCode failureReason failureStage occurredAt',
      )
      .lean(),

    Customer.findOne({
      _id:
        recoveryCase.customerId,

      merchantId:
        recoveryCase.merchantId,
    })
      .select(
        '_id fullName name email phone',
      )
      .lean(),
  ]);

  const input =
    buildAIInput({
      recoveryCase,
      transaction,
      customer,
    });

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
        transaction,
      });
  }

  const policyValidation =
    await validateAgainstPolicy({
      recoveryCase,
      transaction,
      aiRecommendation,
    });

  await createAIAnalysisAudit({
    recoveryCase,
    aiRecommendation,
    policyValidation,
  });

  return {
    recoveryCaseId:
      recoveryCase._id,

    aiRecommendation,

    policyValidation,

    finalAction:
      policyValidation.finalAction,
  };
}

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

/**
 * Supports BOTH:
 *
 * 1. Selected-case analysis
 *    { recoveryCaseId }
 *
 * 2. Existing batch analysis
 *    { limit, batchSize, activeOnly }
 */
async function runAIRecoveryAnalysis({
  merchantId,
  recoveryCaseId,
  limit = 20,
  batchSize = 5,
  activeOnly = false,
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
      }).lean();

    if (!recoveryCase) {
      const error =
        new Error(
          'Recovery case not found.',
        );

      error.status = 404;

      throw error;
    }

    const recommendation =
      await analyzeSingleRecoveryCase({
        recoveryCase,
      });

    return {
      mode: 'SINGLE_CASE',

      totalCases: 1,

      batchSize: 1,

      totalBatches: 1,

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

  const query = activeOnly
    ? buildActiveCaseQuery(
        merchantId,
      )
    : {
        merchantId,
      };

  const safeLimit = Math.min(
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

  const recoveryCases =
    await RecoveryCase.find(query)
      .sort({
        createdAt: -1,
      })
      .limit(safeLimit)
      .lean();

  const recommendations = [];

  for (
    let index = 0;
    index <
    recoveryCases.length;
    index += safeBatchSize
  ) {
    const batch =
      recoveryCases.slice(
        index,
        index + safeBatchSize,
      );

    /*
     * Process cases sequentially inside
     * this demo implementation so rate-limit
     * errors are easier to control.
     */
    for (const recoveryCase of batch) {
      const recommendation =
        await analyzeSingleRecoveryCase({
          recoveryCase,
        });

      recommendations.push(
        recommendation,
      );
    }
  }

  return {
    mode: 'BATCH',

    totalCases:
      recoveryCases.length,

    batchSize:
      safeBatchSize,

    totalBatches:
      recoveryCases.length
        ? Math.ceil(
            recoveryCases.length /
              safeBatchSize,
          )
        : 0,

    recommendations,
  };
}

module.exports = {
  runAIRecoveryAnalysis,
};