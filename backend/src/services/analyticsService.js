const mongoose = require('mongoose');

const Transaction = require('../models/Transaction');
const RecoveryCase = require('../models/RecoveryCase');

/*
 * --------------------------------------------------
 * DATE RANGE
 * --------------------------------------------------
 *
 * API format:
 * YYYY-MM-DD
 *
 * The "to" date is inclusive.
 *
 * Example:
 *
 * 2026-08-29 -> 2026-08-29
 *
 * means:
 *
 * >= 2026-08-29 00:00:00 UTC
 * <  2026-08-30 00:00:00 UTC
 */

function parseDateRange(from, to) {
  if (!from || !to) {
    throw new Error(
      'Both "from" and "to" dates are required.',
    );
  }

  const datePattern =
    /^\d{4}-\d{2}-\d{2}$/;

  if (
    !datePattern.test(from) ||
    !datePattern.test(to)
  ) {
    throw new Error(
      'Invalid date format. Use YYYY-MM-DD.',
    );
  }

  /*
   * Dashboard dates are displayed to the user in
   * India Standard Time (Asia/Kolkata).
   *
   * Example:
   *
   * 29-08-2026 00:00 IST
   * =
   * 28-08-2026 18:30 UTC
   *
   * This is important because MongoDB stores Date
   * values as UTC internally.
   */

  const IST_OFFSET = '+05:30';

  const fromDate =
    new Date(
      `${from}T00:00:00.000${IST_OFFSET}`,
    );

  const toDateExclusive =
    new Date(
      `${to}T00:00:00.000${IST_OFFSET}`,
    );

  if (
    Number.isNaN(
      fromDate.getTime(),
    ) ||
    Number.isNaN(
      toDateExclusive.getTime(),
    )
  ) {
    throw new Error(
      'Invalid date value. Use a valid YYYY-MM-DD date.',
    );
  }

  if (fromDate > toDateExclusive) {
    throw new Error(
      '"from" date cannot be later than "to" date.',
    );
  }

  /*
   * Make "to" inclusive.
   *
   * 29-Aug-2026 means:
   *
   * >= 29-Aug 00:00 IST
   * <  30-Aug 00:00 IST
   */

  toDateExclusive.setUTCDate(
    toDateExclusive.getUTCDate() + 1,
  );

  return {
    fromDate,
    toDateExclusive,
  };
}

/*
 * --------------------------------------------------
 * MONEY HELPERS
 * --------------------------------------------------
 */

function toRupees(
  minorUnits,
) {
  return Number(
    (
      Number(minorUnits || 0) /
      100
    ).toFixed(2),
  );
}

function calculatePercentage(
  numerator,
  denominator,
) {
  if (!denominator) {
    return 0;
  }

  return Number(
    (
      (numerator /
        denominator) *
      100
    ).toFixed(2),
  );
}

/*
 * --------------------------------------------------
 * BREAKDOWN HELPERS
 * --------------------------------------------------
 */

function incrementMap(
  map,
  key,
  amount,
  isRecovered,
) {
  const safeKey =
    key || 'UNKNOWN';

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
    map[safeKey]
      .recoveredCases += 1;
  }

  map[safeKey]
    .revenueAtRiskMinor +=
    amount.amountAtRiskMinor;

  map[safeKey]
    .eligibleRevenueMinor +=
    amount.eligibleAmountMinor;

  map[safeKey]
    .revenueRecoveredMinor +=
    amount.recoveredAmountMinor;
}

function finalizeBreakdown(
  breakdown,
) {
  return Object.fromEntries(
    Object.entries(
      breakdown,
    ).map(
      ([key, value]) => {
        const unrecoveredRevenueMinor =
          Math.max(
            value.revenueAtRiskMinor -
              value.revenueRecoveredMinor,
            0,
          );

        return [
          key,
          {
            cases:
              value.cases,

            recoveredCases:
              value.recoveredCases,

            revenueAtRiskMinor:
              value.revenueAtRiskMinor,

            eligibleRevenueMinor:
              value.eligibleRevenueMinor,

            revenueRecoveredMinor:
              value.revenueRecoveredMinor,

            unrecoveredRevenueMinor,

            caseRecoveryRatePercent:
              calculatePercentage(
                value.recoveredCases,
                value.cases,
              ),

            revenueRecoveryRatePercent:
              calculatePercentage(
                value.revenueRecoveredMinor,
                value.revenueAtRiskMinor,
              ),

            revenueAtRisk:
              toRupees(
                value.revenueAtRiskMinor,
              ),

            eligibleRevenue:
              toRupees(
                value.eligibleRevenueMinor,
              ),

            revenueRecovered:
              toRupees(
                value.revenueRecoveredMinor,
              ),

            unrecoveredRevenue:
              toRupees(
                unrecoveredRevenueMinor,
              ),
          },
        ];
      },
    ),
  );
}

/*
 * --------------------------------------------------
 * EMPTY ANALYTICS
 * --------------------------------------------------
 */

function buildEmptyAnalytics(
  from,
  to,
) {
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

    generatedAt:
      new Date().toISOString(),
  };
}

/*
 * --------------------------------------------------
 * MAIN ANALYTICS
 * --------------------------------------------------
 */

async function getRecoveryAnalytics({
  merchantId,
  from,
  to,
}) {
  if (!merchantId) {
    throw new Error(
      'merchantId is required.',
    );
  }

  if (
    !mongoose.Types.ObjectId.isValid(
      merchantId,
    )
  ) {
    throw new Error(
      'Invalid merchantId.',
    );
  }

  const {
    fromDate,
    toDateExclusive,
  } = parseDateRange(
    from,
    to,
  );

  /*
   * ------------------------------------------------
   * STEP 1
   * ------------------------------------------------
   *
   * Find all recovery cases that are relevant to
   * the selected period.
   *
   * A case is relevant when:
   *
   * A) its original revenue-loss transaction occurred
   *    inside the period
   *
   * OR
   *
   * B) its recovery was completed inside the period
   *
   * This fixes the important situation where:
   *
   * FAILED PAYMENT = Aug 28
   * RECOVERY       = Aug 29
   *
   * and the user asks for Aug 29 analytics.
   */

  const sourceTransactions =
    await Transaction.find({
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
   * ------------------------------------------------
   * STEP 2
   * ------------------------------------------------
   *
   * Find recovery cases whose recovery completed
   * inside the selected period.
   *
   * recoveredAt is the correct timestamp for measuring
   * when money was actually recovered.
   */

  const recoveredCasesInPeriod =
    await RecoveryCase.find({
      merchantId,

      status:
        'RECOVERED',

      recoveredAt: {
        $gte: fromDate,
        $lt: toDateExclusive,
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
          'customerId',
          'recoveredAt',
        ].join(' '),
      )
      .lean();

  /*
   * ------------------------------------------------
   * STEP 3
   * ------------------------------------------------
   *
   * Build a unique set of recovery-case IDs.
   *
   * This is important because a case can satisfy BOTH:
   *
   * source transaction date filter
   * AND
   * recovery completion date filter.
   *
   * It must only be counted once.
   */

  const relevantCaseIds =
    new Set();

  for (
    const transaction of
      sourceTransactions
  ) {
    if (
      transaction.recoveryCaseId
    ) {
      relevantCaseIds.add(
        String(
          transaction.recoveryCaseId,
        ),
      );
    }
  }

  for (
    const recoveryCase of
      recoveredCasesInPeriod
  ) {
    relevantCaseIds.add(
      String(
        recoveryCase._id,
      ),
    );
  }

  /*
   * If absolutely nothing is relevant, return clean
   * zero analytics.
   */

  if (
    relevantCaseIds.size ===
    0
  ) {
    return buildEmptyAnalytics(
      from,
      to,
    );
  }

  /*
   * ------------------------------------------------
   * STEP 4
   * ------------------------------------------------
   *
   * Get the complete RecoveryCase documents for the
   * unique relevant case IDs.
   */

  const recoveryCases =
    await RecoveryCase.find({
      merchantId,

      _id: {
        $in:
          Array.from(
            relevantCaseIds,
          ).map(
            (id) =>
              new mongoose.Types.ObjectId(
                id,
              ),
          ),
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
          'customerId',
          'recoveredAt',
        ].join(' '),
      )
      .lean();

  /*
   * ------------------------------------------------
   * STEP 5
   * ------------------------------------------------
   *
   * Recovery case lookup.
   */

  const recoveryCasesById =
    new Map();

  for (
    const recoveryCase of
      recoveryCases
  ) {
    recoveryCasesById.set(
      String(
        recoveryCase._id,
      ),
      recoveryCase,
    );
  }

  /*
   * ------------------------------------------------
   * STEP 6
   * ------------------------------------------------
   *
   * Source transaction lookup.
   *
   * This ensures recovery-only cases (such as our
   * Aug 29 recovery) can still get payment method and
   * failure information from their original transaction.
   */

  const allSourceIds =
    new Set();

  for (
    const recoveryCase of
      recoveryCases
  ) {
    if (
      recoveryCase.sourceTransactionId
    ) {
      allSourceIds.add(
        String(
          recoveryCase.sourceTransactionId,
        ),
      );
    }
  }

  const additionalSourceTransactions =
    allSourceIds.size
      ? await Transaction.find({
          merchantId,

          _id: {
            $in:
              Array.from(
                allSourceIds,
              ).map(
                (id) =>
                  new mongoose.Types.ObjectId(
                    id,
                  ),
              ),
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
          .lean()
      : [];

  const transactionByCaseId =
    new Map();

  for (
    const transaction of
      additionalSourceTransactions
  ) {
    if (
      transaction.recoveryCaseId
    ) {
      transactionByCaseId.set(
        String(
          transaction.recoveryCaseId,
        ),
        transaction,
      );
    }
  }

  /*
   * ------------------------------------------------
   * STEP 7
   * ------------------------------------------------
   *
   * Initialize metrics.
   */

  let casesAnalyzed = 0;

  let recoveredCases = 0;

  let revenueAtRiskMinor = 0;

  let eligibleRevenueMinor = 0;

  let revenueRecoveredMinor = 0;

  const casesByType = {};

  const casesByFailureReason =
    {};

  const casesByIntervention =
    {};

  const casesByPaymentMethod =
    {};

  /*
   * ------------------------------------------------
   * STEP 8
   * ------------------------------------------------
   *
   * Process every relevant case exactly once.
   */

  for (
    const recoveryCase of
      recoveryCases
  ) {
    /*
     * Find original transaction information.
     */

    const transaction =
      transactionByCaseId.get(
        String(
          recoveryCase._id,
        ),
      );

    /*
     * Fallback to zero-safe transaction-like object.
     */

    const source =
      transaction || {
        failureCategory:
          'UNKNOWN',

        failureReason:
          null,

        paymentMethod:
          'UNKNOWN',
      };

    /*
     * ----------------------------------------------
     * Case amounts
     * ----------------------------------------------
     */

    const amount = {
      amountAtRiskMinor:
        Number(
          recoveryCase.amountAtRiskMinor ||
            0,
        ),

      eligibleAmountMinor:
        Number(
          recoveryCase.eligibleAmountMinor ||
            0,
        ),

      recoveredAmountMinor:
        Number(
          recoveryCase.recoveredAmountMinor ||
            0,
        ),
    };

    /*
     * A case counts as recovered only when its
     * current status is actually RECOVERED.
     */

    const isRecovered =
      recoveryCase.status ===
      'RECOVERED';

    /*
     * ----------------------------------------------
     * Overall metrics
     * ----------------------------------------------
     */

    casesAnalyzed += 1;

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
     * ----------------------------------------------
     * Breakdowns
     * ----------------------------------------------
     */

    incrementMap(
      casesByType,
      recoveryCase.type,
      amount,
      isRecovered,
    );

    incrementMap(
      casesByFailureReason,
      source.failureCategory ||
        'UNKNOWN',
      amount,
      isRecovered,
    );

    incrementMap(
      casesByIntervention,
      recoveryCase.currentAction ||
        'UNKNOWN',
      amount,
      isRecovered,
    );

    incrementMap(
      casesByPaymentMethod,
      source.paymentMethod ||
        'UNKNOWN',
      amount,
      isRecovered,
    );
  }

  /*
   * ------------------------------------------------
   * STEP 9
   * ------------------------------------------------
   *
   * Final calculations.
   */

  const unrecoveredRevenueMinor =
    Math.max(
      revenueAtRiskMinor -
        revenueRecoveredMinor,
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
   * ------------------------------------------------
   * STEP 10
   * ------------------------------------------------
   *
   * Final response.
   */

  return {
    period: {
      from,
      to,
    },

    timezone:
      'UTC',

    casesAnalyzed,

    recoveredCases,

    revenueAtRiskMinor,

    eligibleRevenueMinor,

    revenueRecoveredMinor,

    unrecoveredRevenueMinor,

    caseRecoveryRatePercent,

    revenueRecoveryRatePercent,

    revenueAtRisk:
      toRupees(
        revenueAtRiskMinor,
      ),

    eligibleRevenue:
      toRupees(
        eligibleRevenueMinor,
      ),

    revenueRecovered:
      toRupees(
        revenueRecoveredMinor,
      ),

    unrecoveredRevenue:
      toRupees(
        unrecoveredRevenueMinor,
      ),

    casesByType:
      finalizeBreakdown(
        casesByType,
      ),

    casesByFailureReason:
      finalizeBreakdown(
        casesByFailureReason,
      ),

    casesByIntervention:
      finalizeBreakdown(
        casesByIntervention,
      ),

    casesByPaymentMethod:
      finalizeBreakdown(
        casesByPaymentMethod,
      ),

    generatedAt:
      new Date().toISOString(),
  };
}

module.exports = {
  getRecoveryAnalytics,
};