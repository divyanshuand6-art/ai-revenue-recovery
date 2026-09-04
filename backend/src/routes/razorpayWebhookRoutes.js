const express = require('express');

const {
  processRazorpayWebhook,
} = require('../services/razorpayWebhookService');

const router =
  express.Router();

/*
 * IMPORTANT:
 *
 * This route uses express.raw().
 *
 * Do NOT put requireAuth here.
 * Razorpay calls this endpoint directly.
 */

router.post(
  '/razorpay',
  express.raw({
    type: 'application/json',
    limit: '200kb',
  }),
  async (req, res) => {
    const signature =
      req.headers[
        'x-razorpay-signature'
      ];

    const eventId =
      req.headers[
        'x-razorpay-event-id'
      ];

    try {
      const result =
        await processRazorpayWebhook({
          rawBody:
            req.body,

          signature,

          eventId,
        });

      return res.status(200).json({
        success: true,

        data: result,
      });
    } catch (error) {
      console.error(
        'Razorpay webhook error:',
        error,
      );

      const status =
        Number.isInteger(
          error.status,
        )
          ? error.status
          : 500;

      return res
        .status(status)
        .json({
          success: false,

          message:
            error.message ||
            'Failed to process Razorpay webhook.',
        });
    }
  },
);

module.exports = router;