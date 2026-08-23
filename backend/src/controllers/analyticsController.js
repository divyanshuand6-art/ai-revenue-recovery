const {
  getRecoveryAnalytics,
} = require('../services/analyticsService');

async function getRecoveryAnalyticsController(req, res) {
  try {
    const { from, to } = req.query;

    /*
     * For now, Phase 4 uses the demo merchant.
     *
     * We will replace this with the authenticated
     * merchant ID when authentication is implemented.
     */
    const merchantId = req.user?.userId;

if (!merchantId) {
  return res.status(401).json({
    success: false,
    message: 'Authenticated merchant could not be resolved.',
  });
}

    if (!merchantId) {
      return res.status(500).json({
        success: false,
        message: 'Merchant ID is not configured.',
      });
    }

    const analytics =
      await getRecoveryAnalytics({
        merchantId,
        from,
        to,
      });

    return res.status(200).json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    console.error(
      'Recovery analytics error:',
      error,
    );

    /*
     * Validation errors should return 400.
     * Unexpected server/database errors return 500.
     */

    const validationMessages = [
      'Both "from" and "to" dates are required.',
      'Invalid date format. Use YYYY-MM-DD.',
      'Invalid date value. Use a valid YYYY-MM-DD date.',
      '"from" date cannot be later than "to" date.',
    ];

    if (
      validationMessages.includes(error.message)
    ) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to generate recovery analytics.',
    });
  }
}

module.exports = {
  getRecoveryAnalyticsController,
};