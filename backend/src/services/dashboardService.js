const mongoose = require('mongoose');

const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

const {
  getRecoveryAnalytics,
} = require('./analyticsService');

async function getDashboardOverview({
  merchantId,
  from,
  to,
}) {
  if (!merchantId) {
    throw new Error('merchantId is required.');
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

  const merchantObjectId =
    new mongoose.Types.ObjectId(
      merchantId,
    );

  const analytics =
    await getRecoveryAnalytics({
      merchantId,
      from,
      to,
    });

  const statusBreakdown =
    await RecoveryCase.aggregate([
      {
        $match: {
          merchantId:
            merchantObjectId,
        },
      },
      {
        $group: {
          _id: '$status',

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
    ]);

  const aiAuditSummary =
    await AuditLog.aggregate([
      {
        $match: {
          merchantId:
            merchantObjectId,

          actorType: 'AI_AGENT',

          eventType:
            'AI_ANALYSIS_COMPLETED',
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
    ]);

  return {
    period:
      analytics.period,

    timezone:
      analytics.timezone,

    recovery: {
      casesAnalyzed:
        analytics.casesAnalyzed,

      recoveredCases:
        analytics.recoveredCases,

      revenueAtRiskMinor:
        analytics.revenueAtRiskMinor,

      eligibleRevenueMinor:
        analytics.eligibleRevenueMinor,

      revenueRecoveredMinor:
        analytics.revenueRecoveredMinor,

      unrecoveredRevenueMinor:
        analytics.unrecoveredRevenueMinor,

      caseRecoveryRatePercent:
        analytics.caseRecoveryRatePercent,

      revenueRecoveryRatePercent:
        analytics.revenueRecoveryRatePercent,

      revenueAtRisk:
        analytics.revenueAtRisk,

      eligibleRevenue:
        analytics.eligibleRevenue,

      revenueRecovered:
        analytics.revenueRecovered,

      unrecoveredRevenue:
        analytics.unrecoveredRevenue,
    },

    statusSummary:
      Object.fromEntries(
        statusBreakdown.map(
          (item) => [
            item._id ||
              'UNKNOWN',
            item.count,
          ],
        ),
      ),

    aiSummary:
      Object.fromEntries(
        aiAuditSummary.map(
          (item) => [
            item._id ||
              'UNKNOWN',
            item.count,
          ],
        ),
      ),

    generatedAt:
      new Date().toISOString(),
  };
}

module.exports = {
  getDashboardOverview,
};