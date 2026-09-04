const crypto = require('node:crypto');

const RecoveryCase =
  require('../models/RecoveryCase');

const Transaction =
  require('../models/Transaction');

const AuditLog =
  require('../models/AuditLog');

const {
  processSuccessfulPayment,
} = require('./recoveryPaymentService');

/*
 * --------------------------------------------------
 * SUPPORTED WEBHOOK EVENTS
 * --------------------------------------------------
 */

const SUPPORTED_EVENTS = new Set([
  'payment_link.paid',
]);

/*
 * --------------------------------------------------
 * ENV
 * --------------------------------------------------
 */

function getWebhookSecret() {
  const secret =
    process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error(
      'RAZORPAY_WEBHOOK_SECRET is not configured.',
    );
  }

  return secret;
}

/*
 * --------------------------------------------------
 * VERIFY RAZORPAY WEBHOOK SIGNATURE
 * --------------------------------------------------
 *
 * Razorpay signs the RAW request body.
 *
 * Do not JSON.stringify(req.body).
 */

function verifyWebhookSignature({
  rawBody,
  signature,
}) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new Error(
      'Webhook body must be the raw request body.',
    );
  }

  if (!signature) {
    throw new Error(
      'Missing X-Razorpay-Signature header.',
    );
  }

  const expectedSignature =
    crypto
      .createHmac(
        'sha256',
        getWebhookSecret(),
      )
      .update(rawBody)
      .digest('hex');

  const expectedBuffer =
    Buffer.from(
      expectedSignature,
      'utf8',
    );

  const receivedBuffer =
    Buffer.from(
      String(signature),
      'utf8',
    );

  if (
    expectedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    receivedBuffer,
  );
}

/*
 * --------------------------------------------------
 * PARSE WEBHOOK
 * --------------------------------------------------
 */

function parseWebhookBody(
  rawBody,
) {
  try {
    return JSON.parse(
      rawBody.toString('utf8'),
    );
  } catch {
    throw new Error(
      'Webhook body contains invalid JSON.',
    );
  }
}

/*
 * --------------------------------------------------
 * GET PAYMENT LINK ENTITY
 * --------------------------------------------------
 */

function getPaymentLinkEntity(
  event,
) {
  return (
    event?.payload
      ?.payment_link
      ?.entity || null
  );
}

/*
 * --------------------------------------------------
 * GET PAYMENT ENTITY
 * --------------------------------------------------
 */

function getPaymentEntity(
  event,
) {
  return (
    event?.payload
      ?.payment
      ?.entity || null
  );
}

/*
 * --------------------------------------------------
 * GET RECOVERY CASE ID
 * --------------------------------------------------
 *
 * Our Payment Link service stores the case ID
 * inside Razorpay payment-link notes.
 *
 * Fallback:
 * reference_id begins with RC-<caseId>
 */

function getRecoveryCaseId(
  paymentLink,
) {
  const notes =
    paymentLink?.notes;

  if (
    notes &&
    typeof notes === 'object' &&
    !Array.isArray(notes)
  ) {
    const noteCaseId =
      notes.recovery_case_id;

    if (noteCaseId) {
      return String(
        noteCaseId,
      );
    }
  }

  const referenceId =
    paymentLink?.reference_id;

  if (
    typeof referenceId ===
    'string' &&
    referenceId.startsWith('RC-')
  ) {
    const remainder =
      referenceId.slice(3);

    const caseId =
      remainder.split('-')[0];

    return caseId || null;
  }

  return null;
}

/*
 * --------------------------------------------------
 * GET PAYMENT METHOD
 * --------------------------------------------------
 */

function normalizePaymentMethod(
  payment,
) {
  const method =
    String(
      payment?.method ||
        '',
    ).toLowerCase();

  const methodMap = {
    card: 'CARD',
    upi: 'UPI',
    netbanking: 'NETBANKING',
    wallet: 'WALLET',
    emi: 'EMI',
  };

  return (
    methodMap[method] ||
    'UNKNOWN'
  );
}

/*
 * --------------------------------------------------
 * CHECK EVENT IDEMPOTENCY
 * --------------------------------------------------
 */

async function isEventAlreadyProcessed({
  merchantId,
  externalEventId,
}) {
  if (!externalEventId) {
    return false;
  }

  const existing =
    await AuditLog.findOne({
      merchantId,

      externalEventId,
    }).lean();

  return Boolean(existing);
}

/*
 * --------------------------------------------------
 * CREATE RAZORPAY TRANSACTION
 * --------------------------------------------------
 */

async function createRazorpayTransaction({
  recoveryCase,
  payment,
  eventId,
  paymentLink,
}) {
  const paymentId =
    payment?.id;

  if (!paymentId) {
    throw new Error(
      'Razorpay webhook did not contain a payment ID.',
    );
  }

  /*
   * Payment ID is unique per merchant in our schema.
   */

  const existing =
    await Transaction.findOne({
      merchantId:
        recoveryCase.merchantId,

      providerPaymentId:
        paymentId,
    });

  if (existing) {
    return {
      transaction:
        existing,

      created: false,
    };
  }

  const amountMinor =
    Number(
      payment.amount,
    );

  if (
    !Number.isSafeInteger(
      amountMinor,
    ) ||
    amountMinor <= 0
  ) {
    throw new Error(
      'Razorpay payment amount is invalid.',
    );
  }

  const currency =
    String(
      payment.currency ||
        paymentLink.currency ||
        recoveryCase.currency ||
        'INR',
    ).toUpperCase();

  if (
    currency.length !== 3
  ) {
    throw new Error(
      'Razorpay payment currency is invalid.',
    );
  }

  const createdAt =
    payment.created_at
      ? new Date(
          Number(payment.created_at) *
            1000,
        )
      : new Date();

  const transaction =
    await Transaction.create({
      merchantId:
        recoveryCase.merchantId,

      customerId:
        recoveryCase.customerId,

      recoveryCaseId:
        recoveryCase._id,

      subscriptionId:
        recoveryCase.subscriptionId,

      type:
        'PAYMENT',

      status:
        'CAPTURED',

      amountMinor,

      currency,

      source:
        'RAZORPAY',

      providerStatus:
        payment.status ||
        'captured',

      providerOrderId:
        payment.order_id ||
        paymentLink.order_id ||
        undefined,

      providerPaymentId:
        paymentId,

      providerEventId:
        eventId ||
        undefined,

      paymentMethod:
        normalizePaymentMethod(
          payment,
        ),

      occurredAt:
        createdAt,

      providerCreatedAt:
        createdAt,

      providerUpdatedAt:
        new Date(),
    });

  return {
    transaction,
    created: true,
  };
}

/*
 * --------------------------------------------------
 * PROCESS PAYMENT LINK PAID
 * --------------------------------------------------
 */

async function processPaymentLinkPaid({
  event,
  eventId,
}) {
  const paymentLink =
    getPaymentLinkEntity(
      event,
    );

  const payment =
    getPaymentEntity(
      event,
    );

  if (!paymentLink) {
    throw new Error(
      'payment_link.paid event does not contain payment_link entity.',
    );
  }

  if (!payment) {
    throw new Error(
      'payment_link.paid event does not contain payment entity.',
    );
  }

  if (
    payment.captured !== true &&
    payment.status !== 'captured'
  ) {
    throw new Error(
      `Razorpay payment is not captured. Current status: ${
        payment.status ||
        'UNKNOWN'
      }.`,
    );
  }

  const recoveryCaseId =
    getRecoveryCaseId(
      paymentLink,
    );

  if (!recoveryCaseId) {
    throw new Error(
      'Could not identify recoveryCaseId from Razorpay payment link.',
    );
  }

  /*
   * Find recovery case by its ID first.
   *
   * Merchant ownership is established from the case
   * itself because this webhook belongs to our
   * configured Razorpay merchant account.
   */

  const recoveryCase =
    await RecoveryCase.findById(
      recoveryCaseId,
    );

  if (!recoveryCase) {
    throw new Error(
      'Recovery case referenced by Razorpay payment link was not found.',
    );
  }

  /*
   * Event-level idempotency.
   */

  if (
    await isEventAlreadyProcessed({
      merchantId:
        recoveryCase.merchantId,

      externalEventId:
        eventId,
    })
  ) {
    return {
      processed: false,

      duplicate: true,

      recoveryCaseId:
        recoveryCase._id,

      eventId,
    };
  }

  /*
   * Only ACTION_EXECUTED cases may be confirmed
   * automatically.
   */

  if (
    recoveryCase.status !==
    'ACTION_EXECUTED'
  ) {
    throw new Error(
      `Payment was received, but recovery case is not awaiting payment confirmation. Current status: ${recoveryCase.status}.`,
    );
  }

  /*
   * Payment link must belong to this case.
   */

  if (
    paymentLink.notes
      ?.recovery_case_id &&
    String(
      paymentLink.notes
        .recovery_case_id,
    ) !==
      String(
        recoveryCase._id,
      )
  ) {
    throw new Error(
      'Razorpay payment link does not belong to this recovery case.',
    );
  }

  /*
   * ------------------------------------------------
   * CUSTOMER CHECK
   * ------------------------------------------------
   *
   * Payment link customer information is optional
   * in Razorpay's payload. When present, we validate
   * it against the recovery customer's stored data.
   */

  const paymentContact =
    payment.contact
      ? String(payment.contact)
      : null;

  const paymentEmail =
    payment.email
      ? String(
          payment.email,
        ).toLowerCase()
      : null;

  /*
   * Don't reject solely because contact/email is absent.
   * Our authoritative ownership checks are:
   *
   * recoveryCase merchant
   * recoveryCase customer
   * recoveryCase/payment transaction link
   */

  const {
    transaction,
    created,
  } =
    await createRazorpayTransaction({
      recoveryCase,

      payment,

      eventId,

      paymentLink,
    });

  /*
   * ------------------------------------------------
   * AUTHORITATIVE RECOVERY CONFIRMATION
   * ------------------------------------------------
   *
   * This calls the existing confirmation service.
   *
   * It verifies:
   * - merchant
   * - transaction
   * - CAPTURED status
   * - customer
   * - amount
   * - eligible balance
   *
   * and then performs RECOVERED transition.
   */

  const confirmation =
    await processSuccessfulPayment({
      recoveryCaseId:
        recoveryCase._id,

      merchantId:
        recoveryCase.merchantId,

      paymentTransactionId:
        transaction._id,

      actor:
        'RAZORPAY',

      externalEventId:
        eventId,
    });

  return {
    processed: true,

    duplicate: false,

    createdTransaction:
      created,

    recoveryCaseId:
      recoveryCase._id,

    paymentTransactionId:
      transaction._id,

    razorpayPaymentId:
      payment.id,

    amountMinor:
      payment.amount,

    currency:
      payment.currency,

    paymentContact,

    paymentEmail,

    confirmation,
  };
}

/*
 * --------------------------------------------------
 * PROCESS WEBHOOK
 * --------------------------------------------------
 */

async function processRazorpayWebhook({
  rawBody,
  signature,
  eventId,
}) {
  const valid =
    verifyWebhookSignature({
      rawBody,
      signature,
    });

  if (!valid) {
    const error =
      new Error(
        'Invalid Razorpay webhook signature.',
      );

    error.status =
      400;

    throw error;
  }

  if (!eventId) {
    const error =
      new Error(
        'Missing x-razorpay-event-id header.',
      );

    error.status =
      400;

    throw error;
  }

  const event =
    parseWebhookBody(
      rawBody,
    );

  if (
    !event?.event
  ) {
    const error =
      new Error(
        'Razorpay webhook event name is missing.',
      );

    error.status =
      400;

    throw error;
  }

  if (
    !SUPPORTED_EVENTS.has(
      event.event,
    )
  ) {
    return {
      processed: false,

      ignored: true,

      event:
        event.event,

      message:
        'Webhook event is valid but not used by the recovery workflow.',
    };
  }

  switch (event.event) {
    case 'payment_link.paid':
      return processPaymentLinkPaid({
        event,

        eventId,
      });

    default:
      return {
        processed: false,

        ignored: true,

        event:
          event.event,
      };
  }
}

module.exports = {
  verifyWebhookSignature,
  processRazorpayWebhook,
};