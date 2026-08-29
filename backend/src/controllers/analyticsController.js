const mongoose = require('mongoose');

const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

/*
 * =========================================================
 * DATE HELPERS
 * =========================================================
 */

function isValidDateInput(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  );
}

function getISTStartOfDay(dateString) {
  return new Date(
    `${dateString}T00:00:00.000+05:30`,
  );
}

function getISTEndExclusive(dateString) {
  const date = new Date(
    `${dateString}T00:00:00.000+05:30`,
  );

  date.setUTCDate(
    date.getUTCDate() + 1,
  );

  return date;
}

function formatDateForResponse(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

/*
 * =========================================================
 * MONEY / PERCENTAGE HELPERS
 * =========================================================
 */

function calculatePercentage(
  numerator,
  denominator,
) {
  if (!denominator) {
    return 0;
  }

  return Number(
    (
      (Number(numerator || 0) /
        Number(denominator || 0)) *
      100
    ).toFixed(2),
  );
}

/*
 * =========================================================
 * BREAKDOWN HELPERS
 * =========================================================
 */

function makeBreakdown(rows) {
  const result = {};

  for (const row of rows || []) {
    const key = row._id || 'UNKNOWN';

    const cases = Number(
      row.cases || 0,
    );

    const recoveredCases =
      Number(
        row.recoveredCases || 0,
      );

    const revenueAtRiskMinor =
      Number(
        row.revenueAtRiskMinor || 0,
      );

    const eligibleRevenueMinor =
      Number(
        row.eligibleRevenueMinor || 0,
      );

    const revenueRecoveredMinor =
      Number(
        row.revenueRecoveredMinor || 0,
      );

    const unrecoveredRevenueMinor =
      Math.max(
        eligibleRevenueMinor -
          revenueRecoveredMinor,
        0,
      );

    result[key] = {
      cases,

      recoveredCases,

      revenueAtRiskMinor,

      eligibleRevenueMinor,

      revenueRecoveredMinor,

      unrecoveredRevenueMinor,

      caseRecoveryRatePercent:
        calculatePercentage(
          recoveredCases,
          cases,
        ),

      revenueRecoveryRatePercent:
        calculatePercentage(
          revenueRecoveredMinor,
          eligibleRevenueMinor,
        ),

      revenueAtRisk:
        revenueAtRiskMinor / 100,

      eligibleRevenue:
        eligibleRevenueMinor / 100,

      revenueRecovered:
        revenueRecoveredMinor / 100,

      unrecoveredRevenue:
        unrecoveredRevenueMinor / 100,
    };
  }

  return result;
}

/*
 * =========================================================
 * DASHBOARD ANALYTICS
 * =========================================================
 */

async function getDashboardAnalytics(req, res) {
  try {
    /*
     * -----------------------------------------------------
     * 1. AUTHENTICATED MERCHANT
     * -----------------------------------------------------
     */

    const merchantId =
      req.merchant?._id ||
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    /*
     * -----------------------------------------------------
     * 2. DATE RANGE
     * -----------------------------------------------------
     *
     * Dashboard dates are interpreted as IST.
     *
     * 29-08-2026 means:
     *
     * 29-Aug 00:00 IST
     * through
     * 30-Aug 00:00 IST exclusive
     */

    const today = new Date();

    let fromDate;
    let toDateExclusive;

    /*
     * Default = last 30 days.
     */

    if (!req.query.from && !req.query.to) {
      fromDate = new Date(today);

      fromDate.setUTCDate(
        fromDate.getUTCDate() - 30,
      );

      toDateExclusive =
        new Date(today);

      toDateExclusive.setUTCDate(
        toDateExclusive.getUTCDate() + 1,
      );
    } else {
      if (
        !req.query.from ||
        !req.query.to
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Both "from" and "to" dates are required.',
        });
      }

      if (
        !isValidDateInput(
          req.query.from,
        ) ||
        !isValidDateInput(
          req.query.to,
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Invalid date format. Use YYYY-MM-DD.',
        });
      }

      fromDate =
        getISTStartOfDay(
          req.query.from,
        );

      toDateExclusive =
        getISTEndExclusive(
          req.query.to,
        );
    }

    if (
      Number.isNaN(
        fromDate.getTime(),
      ) ||
      Number.isNaN(
        toDateExclusive.getTime(),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid date value. Use a valid YYYY-MM-DD date.',
      });
    }

    if (
      fromDate >=
      toDateExclusive
    ) {
      return res.status(400).json({
        success: false,
        message:
          '"from" date cannot be later than "to" date.',
      });
    }

    /*
     * -----------------------------------------------------
     * 3. MERCHANT OBJECT ID
     * -----------------------------------------------------
     */

    if (
      !mongoose.Types.ObjectId.isValid(
        merchantId,
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid merchantId.',
      });
    }

    const merchantObjectId =
      new mongoose.Types.ObjectId(
        merchantId,
      );

    /*
     * -----------------------------------------------------
     * 4. CASE MATCH
     * -----------------------------------------------------
     *
     * A case belongs to the selected period if:
     *
     * 1. It was created during the selected period
     *
     * OR
     *
     * 2. It was recovered during the selected period
     *
     * This is required for:
     *
     * Original failure: 28-Aug
     * Recovery:         29-Aug
     */

    const caseMatch = {
      merchantId:
        merchantObjectId,

      $or: [
        {
          createdAt: {
            $gte: fromDate,
            $lt: toDateExclusive,
          },
        },

        {
          status:
            'RECOVERED',

          recoveredAt: {
            $gte: fromDate,
            $lt: toDateExclusive,
          },
        },
      ],
    };

    /*
     * -----------------------------------------------------
     * 5. AUDIT MATCH
     * -----------------------------------------------------
     */

    const auditMatch = {
      merchantId:
        merchantObjectId,

      occurredAt: {
        $gte: fromDate,
        $lt: toDateExclusive,
      },
    };

    /*
     * -----------------------------------------------------
     * 6. RUN ALL ANALYTICS IN PARALLEL
     * -----------------------------------------------------
     */

    const [
      summaryRows,
      typeRows,
      failureRows,
      interventionRows,
      paymentMethodRows,
      statusRows,
      aiSummaryRows,
      aiActionRows,
      aiResultRows,
    ] = await Promise.all([
      /*
       * ===============================================
       * OVERALL SUMMARY
       * ===============================================
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $group: {
            _id: null,

            casesAnalyzed: {
              $sum: 1,
            },

            recoveredCases: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      '$status',
                      'RECOVERED',
                    ],
                  },

                  1,
                  0,
                ],
              },
            },

            revenueAtRiskMinor: {
              $sum:
                '$amountAtRiskMinor',
            },

            eligibleRevenueMinor: {
              $sum:
                '$eligibleAmountMinor',
            },

            revenueRecoveredMinor: {
              $sum:
                '$recoveredAmountMinor',
            },
          },
        },

        {
          $project: {
            _id: 0,

            casesAnalyzed: 1,

            recoveredCases: 1,

            revenueAtRiskMinor: 1,

            eligibleRevenueMinor: 1,

            revenueRecoveredMinor: 1,
          },
        },
      ]),

      /*
       * ===============================================
       * CASE TYPE
       * ===============================================
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $group: {
            _id: {
              $ifNull: [
                '$type',
                'UNKNOWN',
              ],
            },

            cases: {
              $sum: 1,
            },

            recoveredCases: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      '$status',
                      'RECOVERED',
                    ],
                  },

                  1,
                  0,
                ],
              },
            },

            revenueAtRiskMinor: {
              $sum:
                '$amountAtRiskMinor',
            },

            eligibleRevenueMinor: {
              $sum:
                '$eligibleAmountMinor',
            },

            revenueRecoveredMinor: {
              $sum:
                '$recoveredAmountMinor',
            },
          },
        },

        {
          $sort: {
            cases: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * FAILURE REASON
       * ===============================================
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $lookup: {
            from:
              'transactions',

            localField:
              'sourceTransactionId',

            foreignField:
              '_id',

            as:
              'sourceTransaction',
          },
        },

        {
          $unwind: {
            path:
              '$sourceTransaction',

            preserveNullAndEmptyArrays:
              true,
          },
        },

        {
          $group: {
            _id: {
              $cond: [
                {
                  $eq: [
                    '$type',
                    'CHECKOUT_ABANDONMENT',
                  ],
                },

                'CHECKOUT_ABANDONMENT',

                {
                  $ifNull: [
                    '$sourceTransaction.failureCategory',

                    {
                      $ifNull: [
                        '$sourceTransaction.failureReason',

                        'UNKNOWN',
                      ],
                    },
                  ],
                },
              ],
            },

            cases: {
              $sum: 1,
            },

            recoveredCases: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      '$status',
                      'RECOVERED',
                    ],
                  },

                  1,
                  0,
                ],
              },
            },

            revenueAtRiskMinor: {
              $sum:
                '$amountAtRiskMinor',
            },

            eligibleRevenueMinor: {
              $sum:
                '$eligibleAmountMinor',
            },

            revenueRecoveredMinor: {
              $sum:
                '$recoveredAmountMinor',
            },
          },
        },

        {
          $sort: {
            cases: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * ACTUAL INTERVENTION
       * ===============================================
       *
       * VERY IMPORTANT:
       *
       * currentAction is the current workflow state.
       *
       * A recovered case may have:
       *
       * currentAction = STOP
       *
       * because there is nothing left to recover.
       *
       * But the actual recovery intervention may have
       * been:
       *
       * PAYMENT_RETRY
       *
       * Therefore actionTaken is preferred.
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $group: {
            _id: {
              $ifNull: [
                '$actionTaken',

                {
                  $ifNull: [
                    '$currentAction',
                    'UNKNOWN',
                  ],
                },
              ],
            },

            cases: {
              $sum: 1,
            },

            recoveredCases: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      '$status',
                      'RECOVERED',
                    ],
                  },

                  1,
                  0,
                ],
              },
            },

            revenueAtRiskMinor: {
              $sum:
                '$amountAtRiskMinor',
            },

            eligibleRevenueMinor: {
              $sum:
                '$eligibleAmountMinor',
            },

            revenueRecoveredMinor: {
              $sum:
                '$recoveredAmountMinor',
            },
          },
        },

        {
          $sort: {
            cases: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * PAYMENT METHOD
       * ===============================================
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $lookup: {
            from:
              'transactions',

            localField:
              'sourceTransactionId',

            foreignField:
              '_id',

            as:
              'transaction',
          },
        },

        {
          $unwind: {
            path:
              '$transaction',

            preserveNullAndEmptyArrays:
              true,
          },
        },

        {
          $group: {
            _id: {
              $ifNull: [
                '$transaction.paymentMethod',
                'UNKNOWN',
              ],
            },

            cases: {
              $sum: 1,
            },

            recoveredCases: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      '$status',
                      'RECOVERED',
                    ],
                  },

                  1,
                  0,
                ],
              },
            },

            revenueAtRiskMinor: {
              $sum:
                '$amountAtRiskMinor',
            },

            eligibleRevenueMinor: {
              $sum:
                '$eligibleAmountMinor',
            },

            revenueRecoveredMinor: {
              $sum:
                '$recoveredAmountMinor',
            },
          },
        },

        {
          $sort: {
            cases: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * STATUS SUMMARY
       * ===============================================
       */

      RecoveryCase.aggregate([
        {
          $match:
            caseMatch,
        },

        {
          $group: {
            _id: {
              $ifNull: [
                '$status',
                'UNKNOWN',
              ],
            },

            cases: {
              $sum: 1,
            },
          },
        },

        {
          $sort: {
            cases: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * AI SUMMARY
       * ===============================================
       */

      AuditLog.aggregate([
        {
          $match: {
            ...auditMatch,

            actorType:
              'AI_AGENT',

            eventType:
              'AI_ANALYSIS_COMPLETED',
          },
        },

        {
          $group: {
            _id: null,

            totalAnalyses: {
              $sum: 1,
            },

            averageConfidence: {
              $avg: {
                $convert: {
                  input:
                    '$metadata.confidence',

                  to:
                    'double',

                  onError:
                    null,

                  onNull:
                    null,
                },
              },
            },

            lowConfidenceCount: {
              $sum: {
                $cond: [
                  {
                    $lt: [
                      {
                        $convert: {
                          input:
                            '$metadata.confidence',

                          to:
                            'double',

                          onError:
                            0,

                          onNull:
                            0,
                        },
                      },

                      0.6,
                    ],
                  },

                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      /*
       * ===============================================
       * AI RECOMMENDED ACTIONS
       * ===============================================
       */

      AuditLog.aggregate([
        {
          $match: {
            ...auditMatch,

            actorType:
              'AI_AGENT',

            eventType:
              'AI_ANALYSIS_COMPLETED',
          },
        },

        {
          $project: {
            action: {
              $ifNull: [
                '$metadata.decision',
                '$action',
              ],
            },
          },
        },

        {
          $group: {
            _id: {
              $ifNull: [
                '$action',
                'UNKNOWN',
              ],
            },

            count: {
              $sum: 1,
            },
          },
        },

        {
          $sort: {
            count: -1,
          },
        },
      ]),

      /*
       * ===============================================
       * POLICY RESULTS
       * ===============================================
       */

      AuditLog.aggregate([
        {
          $match: {
            ...auditMatch,

            eventType: {
              $in: [
                'POLICY_VALIDATED',
                'POLICY_REJECTED',
              ],
            },
          },
        },

        {
          $group: {
            _id: '$result',

            count: {
              $sum: 1,
            },
          },
        },

        {
          $sort: {
            count: -1,
          },
        },
      ]),
    ]);

    /*
     * -----------------------------------------------------
     * 7. SUMMARY DEFAULTS
     * -----------------------------------------------------
     */

    const summary =
      summaryRows[0] || {
        casesAnalyzed: 0,

        recoveredCases: 0,

        revenueAtRiskMinor: 0,

        eligibleRevenueMinor: 0,

        revenueRecoveredMinor: 0,
      };

    /*
     * -----------------------------------------------------
     * 8. OVERALL FINANCIAL METRICS
     * -----------------------------------------------------
     */

    const casesAnalyzed =
      Number(
        summary.casesAnalyzed || 0,
      );

    const recoveredCases =
      Number(
        summary.recoveredCases || 0,
      );

    const revenueAtRiskMinor =
      Number(
        summary.revenueAtRiskMinor ||
          0,
      );

    const eligibleRevenueMinor =
      Number(
        summary.eligibleRevenueMinor ||
          0,
      );

    const revenueRecoveredMinor =
      Number(
        summary.revenueRecoveredMinor ||
          0,
      );

    /*
     * Unrecovered revenue is based on eligible revenue.
     *
     * This prevents recovered money from creating a
     * negative unrecovered value.
     */

    const unrecoveredRevenueMinor =
      Math.max(
        eligibleRevenueMinor -
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
        eligibleRevenueMinor,
      );

    /*
     * -----------------------------------------------------
     * 9. AI METRICS
     * -----------------------------------------------------
     */

    const aiBase =
      aiSummaryRows[0] || {
        totalAnalyses: 0,
        averageConfidence: 0,
        lowConfidenceCount: 0,
      };

    const totalAIAnalyses =
      Number(
        aiBase.totalAnalyses || 0,
      );

    const averageAIConfidence =
      Number(
        (
          Number(
            aiBase.averageConfidence ||
              0,
          ) * 100
        ).toFixed(2),
      );

    const lowConfidenceCount =
      Number(
        aiBase.lowConfidenceCount ||
          0,
      );

    const acceptedPolicies =
      Number(
        aiResultRows.find(
          (row) =>
            row._id ===
            'SUCCEEDED',
        )?.count || 0,
      );

    const rejectedPolicies =
      Number(
        aiResultRows.find(
          (row) =>
            row._id ===
            'REJECTED',
        )?.count || 0,
      );

    const policyOverrides =
      Number(
        await AuditLog.countDocuments({
          ...auditMatch,

          eventType:
            'POLICY_REJECTED',
        }),
      );

    /*
     * -----------------------------------------------------
     * 10. FINAL RESPONSE
     * -----------------------------------------------------
     */

    const responseFrom =
      req.query.from ||
      formatDateForResponse(
        fromDate,
      );

    const responseTo =
      req.query.to ||
      formatDateForResponse(
        new Date(
          toDateExclusive.getTime() -
            1,
        ),
      );

    return res.status(200).json({
      success: true,

      data: {
        /*
         * ==============================================
         * PERIOD
         * ==============================================
         */

        period: {
          from:
            responseFrom,

          to:
            responseTo,
        },

        timezone:
          'Asia/Kolkata',

        /*
         * ==============================================
         * OVERALL METRICS
         * ==============================================
         */

        casesAnalyzed,

        recoveredCases,

        revenueAtRiskMinor,

        eligibleRevenueMinor,

        revenueRecoveredMinor,

        unrecoveredRevenueMinor,

        caseRecoveryRatePercent,

        revenueRecoveryRatePercent,

        revenueAtRisk:
          revenueAtRiskMinor /
          100,

        eligibleRevenue:
          eligibleRevenueMinor /
          100,

        revenueRecovered:
          revenueRecoveredMinor /
          100,

        unrecoveredRevenue:
          unrecoveredRevenueMinor /
          100,

        /*
         * ==============================================
         * RECOVERY SUMMARY
         * ==============================================
         */

        recovery: {
          casesAnalyzed,

          recoveredCases,

          revenueAtRisk:
            revenueAtRiskMinor /
            100,

          eligibleRevenue:
            eligibleRevenueMinor /
            100,

          revenueRecovered:
            revenueRecoveredMinor /
            100,

          unrecoveredRevenue:
            unrecoveredRevenueMinor /
            100,

          caseRecoveryRatePercent,

          revenueRecoveryRatePercent,
        },

        /*
         * ==============================================
         * CASE TYPE
         * ==============================================
         */

        casesByType:
          makeBreakdown(
            typeRows,
          ),

        /*
         * ==============================================
         * FAILURE REASON
         * ==============================================
         */

        casesByFailureReason:
          makeBreakdown(
            failureRows,
          ),

        /*
         * ==============================================
         * ACTUAL INTERVENTION
         * ==============================================
         */

        casesByIntervention:
          makeBreakdown(
            interventionRows,
          ),

        /*
         * ==============================================
         * PAYMENT METHOD
         * ==============================================
         */

        casesByPaymentMethod:
          makeBreakdown(
            paymentMethodRows,
          ),

        /*
         * ==============================================
         * STATUS
         * ==============================================
         */

        statusSummary:
          Object.fromEntries(
            statusRows.map(
              (row) => [
                row._id ||
                  'UNKNOWN',

                Number(
                  row.cases || 0,
                ),
              ],
            ),
          ),

        /*
         * ==============================================
         * AI DECISION INTELLIGENCE
         * ==============================================
         */

        aiSummary: {
          totalAnalyses:
            totalAIAnalyses,

          averageConfidence:
            averageAIConfidence,

          acceptedPolicies,

          rejectedPolicies,

          policyOverrides,

          lowConfidenceCount,

          topRecommendedAction:
            aiActionRows.length > 0
              ? {
                  action:
                    aiActionRows[0]
                      ._id ||
                    'UNKNOWN',

                  count:
                    Number(
                      aiActionRows[0]
                        .count || 0,
                    ),
                }
              : null,

          recommendationsByAction:
            Object.fromEntries(
              aiActionRows.map(
                (row) => [
                  row._id ||
                    'UNKNOWN',

                  Number(
                    row.count || 0,
                  ),
                ],
              ),
            ),

          policyResults:
            Object.fromEntries(
              aiResultRows.map(
                (row) => [
                  row._id ||
                    'UNKNOWN',

                  Number(
                    row.count || 0,
                  ),
                ],
              ),
            ),
        },

        generatedAt:
          new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      'Dashboard analytics error:',
      error,
    );

    if (
      error.name ===
      'CastError'
    ) {
      return res.status(400).json({
        success: false,

        message:
          'Invalid merchant or dashboard parameter.',
      });
    }

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        'Failed to load dashboard analytics.',
    });
  }
}

module.exports = {
  getDashboardAnalytics,
};