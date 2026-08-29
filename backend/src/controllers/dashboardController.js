const {
  getDashboardOverview,
} = require('../services/dashboardService');

async function getDashboardOverviewController(
  req,
  res,
) {
  try {
    const merchantId =
      req.user?.userId;

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        message:
          'Authenticated merchant could not be resolved.',
      });
    }

    const {
      from,
      to,
    } = req.query;

    const data =
      await getDashboardOverview({
        merchantId,
        from,
        to,
      });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(
      'Dashboard overview error:',
      error,
    );

    const validationMessages = [
      'Both "from" and "to" dates are required.',
      'Invalid date format. Use YYYY-MM-DD.',
      'Invalid date value. Use a valid YYYY-MM-DD date.',
      '"from" date cannot be later than "to" date.',
    ];

    if (
      validationMessages.includes(
        error.message,
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message:
        'Failed to generate dashboard overview.',
    });
  }
}

module.exports = {
  getDashboardOverviewController,
};