const Transaction = require('../models/Transaction');
const RecoveryCase = require('../models/RecoveryCase');

function parseDateRange(from, to) {
  if (!from || !to) {
    throw new Error('Both "from" and "to" dates are required.');
  }

  // Require the API date format YYYY-MM-DD.
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (!datePattern.test(from) || !datePattern.test(to)) {
    throw new Error('Invalid date format. Use YYYY-MM-DD.');
  }

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDateExclusive = new Date(`${to}T00:00:00.000Z`);

  if (
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(toDateExclusive.getTime())
  ) {
    throw new Error('Invalid date value. Use a valid YYYY-MM-DD date.');
  }

  if (fromDate > toDateExclusive) {
    throw new Error('"from" date cannot be later than "to" date.');
  }

  // Make the "to" date inclusive.
  // Example:
  // 2026-08-01 → 2026-08-15
  // means everything from the beginning of Aug 1
  // until the beginning of Aug 16.
  toDateExclusive.setUTCDate(toDateExclusive.getUTCDate() + 1);

  return {
    fromDate,
    toDateExclusive,
  };
}

function toRupees(minorUnits) {
  return Number((minorUnits / 100).toFixed(2));
}

function calculatePercentage(numerator, denominator) {
  if (!denominator) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

function incrementMap(map, key, amount, isRecovered) {
  const safeKey = key || 'UNKNOWN';

  if (!map[safeKey]) {
    map[safeKey] = {
      cases: 0,
      recoveredCases: 0,
      revenueAtRiskMinor: 0,
      eligibleRevenueMinor: 0,
      revenueRecoveredMinor: 0,
    };
  }

  map[safeKey].cases += 1;

  if (isRecovered) {
    map[safeKey].recoveredCases += 1;
  }

  map[safeKey].revenueAtRiskMinor += amount.amountAtRiskMinor;
  map[safeKey].eligibleRevenueMinor += amount.eligibleAmountMinor;
  map[safeKey].revenueRecoveredMinor += amount.recoveredAmountMinor;
}

function finalizeBreakdown(breakdown) {
  return Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => {
      const unrecoveredRevenueMinor =
        value.revenueAtRiskMinor - value.revenueRecoveredMinor;

      return [
        key,
        {
          cases: value.cases,

          recoveredCases: value.recoveredCases,

          revenueAtRiskMinor: value.revenueAtRiskMinor,

          eligibleRevenueMinor: value.eligibleRevenueMinor,

          revenueRecoveredMinor: value.revenueRecoveredMinor,

          unrecoveredRevenueMinor,

          caseRecoveryRatePercent: calculatePercentage(
            value.recoveredCases,
            value.cases,
          ),

          revenueRecoveryRatePercent: calculatePercentage(
            value.revenueRecoveredMinor,
            value.revenueAtRiskMinor,
          ),

          revenueAtRisk: toRupees(value.revenueAtRiskMinor),

          eligibleRevenue: toRupees(value.eligibleRevenueMinor),

          revenueRecovered: toRupees(value.revenueRecoveredMinor),

          unrecoveredRevenue: toRupees(unrecoveredRevenueMinor),
        },
      ];
    }),
  );
}

async function getRecoveryAnalytics({ merchantId, from, to }) {
  if (!merchantId) {
    throw new Error('merchantId is required.');
  }

  const { fromDate, toDateExclusive } = parseDateRange(from, to);

  /*
   * STEP 1
   *
   * Find source transactions whose revenue-loss event occurred
   * inside the selected date range.
   *
   * Transaction.occurredAt is used because it represents the
   * original revenue event date.
   */

  const sourceTransactions = await Transaction.find({
    merchantId,

    occurredAt: {
      $gte: fromDate,
      $lt: toDateExclusive,
    },

    recoveryCaseId: {
      $exists: true,
      $ne: null,
    },
  })
    .select(
      [
        '_id',
        'recoveryCaseId',
        'type',
        'failureCategory',
        'failureReason',
        'paymentMethod',
        'occurredAt',
        'amountMinor',
      ].join(' '),
    )
    .lean();

  /*
   * If no matching revenue-loss transactions exist,
   * return a valid empty analytics response.
   */

  if (sourceTransactions.length === 0) {
    return {
      period: {
        from,
        to,
      },

      timezone: 'UTC',

      casesAnalyzed: 0,

      recoveredCases: 0,

      revenueAtRiskMinor: 0,

      eligibleRevenueMinor: 0,

      revenueRecoveredMinor: 0,

      unrecoveredRevenueMinor: 0,

      caseRecoveryRatePercent: 0,

      revenueRecoveryRatePercent: 0,

      revenueAtRisk: 0,

      eligibleRevenue: 0,

      revenueRecovered: 0,

      unrecoveredRevenue: 0,

      casesByType: {},

      casesByFailureReason: {},

      casesByIntervention: {},

      casesByPaymentMethod: {},

      generatedAt: new Date().toISOString(),
    };
  }

  /*
   * STEP 2
   *
   * Get the RecoveryCase documents connected to
   * the source transactions found above.
   */

  const sourceTransactionIds = sourceTransactions.map(
    (transaction) => transaction._id,
  );

  const recoveryCases = await RecoveryCase.find({
    merchantId,

    sourceTransactionId: {
      $in: sourceTransactionIds,
    },
  })
    .select(
      [
        '_id',
        'sourceTransactionId',
        'type',
        'status',
        'amountAtRiskMinor',
        'eligibleAmountMinor',
        'recoveredAmountMinor',
        'currentAction',
      ].join(' '),
    )
    .lean();

  /*
   * Create a lookup map:

   sourceTransactionId
          ↓
   RecoveryCase

   This allows us to efficiently connect each
   source transaction to its recovery case.
   */

  const recoveryCasesBySourceId = new Map();

  for (const recoveryCase of recoveryCases) {
    recoveryCasesBySourceId.set(
      String(recoveryCase.sourceTransactionId),
      recoveryCase,
    );
  }

  /*
   * STEP 3
   *
   * Initialize the aggregate financial metrics.
   */

  let casesAnalyzed = 0;

  let recoveredCases = 0;

  let revenueAtRiskMinor = 0;

  let eligibleRevenueMinor = 0;

  let revenueRecoveredMinor = 0;

  const casesByType = {};

  const casesByFailureReason = {};

  const casesByIntervention = {};

  const casesByPaymentMethod = {};

  /*
   * STEP 4
   *
   * Process each source transaction and its recovery case.
   */

  for (const transaction of sourceTransactions) {
    const recoveryCase = recoveryCasesBySourceId.get(
      String(transaction._id),
    );

    /*
     * A source transaction without a recovery case
     * should not contribute to recovery analytics.
     */

    if (!recoveryCase) {
      continue;
    }

    casesAnalyzed += 1;

    const amount = {
      amountAtRiskMinor: Number(
        recoveryCase.amountAtRiskMinor || 0,
      ),

      eligibleAmountMinor: Number(
        recoveryCase.eligibleAmountMinor || 0,
      ),

      recoveredAmountMinor: Number(
        recoveryCase.recoveredAmountMinor || 0,
      ),
    };

    const isRecovered =
      recoveryCase.status === 'RECOVERED';

    /*
     * Overall financial totals.
     */

    revenueAtRiskMinor +=
      amount.amountAtRiskMinor;

    eligibleRevenueMinor +=
      amount.eligibleAmountMinor;

    revenueRecoveredMinor +=
      amount.recoveredAmountMinor;

    if (isRecovered) {
      recoveredCases += 1;
    }

    /*
     * Breakdowns.
     */

    incrementMap(
      casesByType,
      recoveryCase.type,
      amount,
      isRecovered,
    );

    incrementMap(
      casesByFailureReason,
      transaction.failureCategory || 'UNKNOWN',
      amount,
      isRecovered,
    );

    incrementMap(
      casesByIntervention,
      recoveryCase.currentAction || 'UNKNOWN',
      amount,
      isRecovered,
    );

    incrementMap(
      casesByPaymentMethod,
      transaction.paymentMethod || 'UNKNOWN',
      amount,
      isRecovered,
    );
  }

  /*
   * STEP 5
   *
   * Calculate final financial metrics.
   */

  const unrecoveredRevenueMinor =
    Math.max(
      revenueAtRiskMinor - revenueRecoveredMinor,
      0,
    );

  const caseRecoveryRatePercent =
    calculatePercentage(
      recoveredCases,
      casesAnalyzed,
    );

  const revenueRecoveryRatePercent =
    calculatePercentage(
      revenueRecoveredMinor,
      revenueAtRiskMinor,
    );

  /*
   * STEP 6
   *
   * Build the final analytics response.
   */

  return {
    period: {
      from,
      to,
    },

    timezone: 'UTC',

    casesAnalyzed,

    recoveredCases,

    revenueAtRiskMinor,

    eligibleRevenueMinor,

    revenueRecoveredMinor,

    unrecoveredRevenueMinor,

    caseRecoveryRatePercent,

    revenueRecoveryRatePercent,

    /*
     * Human-readable rupee values.
     * Internal calculations remain in minor units.
     */

    revenueAtRisk: toRupees(
      revenueAtRiskMinor,
    ),

    eligibleRevenue: toRupees(
      eligibleRevenueMinor,
    ),

    revenueRecovered: toRupees(
      revenueRecoveredMinor,
    ),

    unrecoveredRevenue: toRupees(
      unrecoveredRevenueMinor,
    ),

    /*
     * Detailed breakdowns.
     */

    casesByType:
      finalizeBreakdown(casesByType),

    casesByFailureReason:
      finalizeBreakdown(casesByFailureReason),

    casesByIntervention:
      finalizeBreakdown(casesByIntervention),

    casesByPaymentMethod:
      finalizeBreakdown(casesByPaymentMethod),

    generatedAt:
      new Date().toISOString(),
  };
}

module.exports = {
  getRecoveryAnalytics,
};