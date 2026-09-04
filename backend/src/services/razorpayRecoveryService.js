const RecoveryCase = require('../models/RecoveryCase');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');
const razorpay = require('../config/razorpay');

/*
 * ============================================================
 * CUSTOMER-FACING ACTIONS
 * ============================================================
 */

const CUSTOMER_OUTREACH_ACTIONS = new Set([
  'RECOVERY_LINK',
  'REMINDER',
  'ALTERNATIVE_PAYMENT',
  'PAYMENT_RETRY',
  'DELAYED_RETRY',
]);

/*
 * ============================================================
 * RAZORPAY REQUEST CONTROL
 * ============================================================
 *
 * All payment-link requests are serialized globally inside
 * this Node process.
 *
 * This protects against:
 * - Execute All
 * - multiple browser requests
 * - multiple users/actions
 *
 * Default minimum gap = 5000 ms.
 *
 * Environment override:
 *
 * RECOVERY_RAZORPAY_THROTTLE_MS=5000
 */

const RAZORPAY_MIN_REQUEST_GAP_MS = Math.max(
  5000,
  Number(
    process.env.RECOVERY_RAZORPAY_THROTTLE_MS ||
      5000,
  ) || 5000,
);

const RAZORPAY_MAX_RATE_LIMIT_RETRIES = 4;

let razorpayQueue = Promise.resolve();

let lastRazorpayRequestAt = 0;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimitError(error) {
  const description =
    String(
      error?.error?.description ||
        error?.message ||
        '',
    );

  return (
    error?.statusCode === 429 ||
    error?.status === 429 ||
    /too many requests/i.test(
      description,
    )
  );
}

function getRateLimitRetryDelay(attempt) {
  /*
   * 5s → 10s → 20s → 30s
   */
  return Math.min(
    30000,
    5000 * 2 ** attempt,
  );
}

/*
 * Every Razorpay payment-link request enters this queue.
 */
function queueRazorpayRequest(requestFn) {
  const run = razorpayQueue.then(
    async () => {
      let lastError = null;

      for (
        let attempt = 0;
        attempt <=
          RAZORPAY_MAX_RATE_LIMIT_RETRIES;
        attempt += 1
      ) {
        try {
          const elapsed =
            Date.now() -
            lastRazorpayRequestAt;

          const remaining =
            RAZORPAY_MIN_REQUEST_GAP_MS -
            elapsed;

          if (remaining > 0) {
            await sleep(remaining);
          }

          /*
           * Mark immediately before the actual
           * provider request.
           */
          lastRazorpayRequestAt =
            Date.now();

          return await requestFn();
        } catch (error) {
          lastError = error;

          if (
            !isRateLimitError(error) ||
            attempt ===
              RAZORPAY_MAX_RATE_LIMIT_RETRIES
          ) {
            throw error;
          }

          const retryDelay =
            getRateLimitRetryDelay(
              attempt,
            );

          console.warn(
            `Razorpay rate limit hit. Retrying in ${retryDelay}ms (retry ${attempt + 1}/${RAZORPAY_MAX_RATE_LIMIT_RETRIES}).`,
          );

          await sleep(
            retryDelay,
          );
        }
      }

      throw lastError;
    },
  );

  /*
   * Keep queue alive even when one request fails.
   */
  razorpayQueue =
    run.catch(() => undefined);

  return run;
}

/*
 * ============================================================
 * AUDIT METADATA
 * ============================================================
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

/*
 * ============================================================
 * REMAINING RECOVERY AMOUNT
 * ============================================================
 */

function getRemainingRecoveryAmount(
  recoveryCase,
) {
  const eligibleAmount =
    Number(
      recoveryCase.eligibleAmountMinor ||
        0,
    );

  const recoveredAmount =
    Number(
      recoveryCase.recoveredAmountMinor ||
        0,
    );

  if (
    !Number.isSafeInteger(
      eligibleAmount,
    ) ||
    eligibleAmount < 0
  ) {
    throw new Error(
      'Eligible recovery amount is invalid.',
    );
  }

  if (
    !Number.isSafeInteger(
      recoveredAmount,
    ) ||
    recoveredAmount < 0
  ) {
    throw new Error(
      'Recovered amount is invalid.',
    );
  }

  if (
    recoveredAmount >
    eligibleAmount
  ) {
    throw new Error(
      'Recovered amount cannot exceed eligible recovery amount.',
    );
  }

  const remaining =
    eligibleAmount -
    recoveredAmount;

  if (
    !Number.isSafeInteger(
      remaining,
    )
  ) {
    throw new Error(
      'Recovery amount is invalid.',
    );
  }

  return remaining;
}

/*
 * ============================================================
 * PAYMENT-LINK EXPIRY
 * ============================================================
 */

function getPaymentLinkExpiry(
  recoveryWindowEndsAt,
) {
  if (!recoveryWindowEndsAt) {
    throw new Error(
      'Recovery window is required to create a payment link.',
    );
  }

  const windowEnd =
    new Date(
      recoveryWindowEndsAt,
    );

  if (
    Number.isNaN(
      windowEnd.getTime(),
    )
  ) {
    throw new Error(
      'Recovery window end time is invalid.',
    );
  }

  const expirySeconds =
    Math.floor(
      windowEnd.getTime() / 1000,
    );

  const nowSeconds =
    Math.floor(
      Date.now() / 1000,
    );

  if (
    expirySeconds <=
    nowSeconds
  ) {
    throw new Error(
      'Recovery window has already expired.',
    );
  }

  return expirySeconds;
}

/*
 * ============================================================
 * CUSTOMER NOTIFICATION SETTINGS
 * ============================================================
 */

function buildNotificationSettings(
  customer,
) {
  const consent =
    customer?.communicationConsent ||
    {};

  return {
    email:
      Boolean(
        customer?.email &&
          consent.email,
      ),

    sms:
      Boolean(
        customer?.phone &&
          consent.sms,
      ),
  };
}

/*
 * ============================================================
 * COMMUNICATION VALIDATION
 * ============================================================
 */

function ensureCommunicationChannel(
  notification,
) {
  if (
    !notification.email &&
    !notification.sms
  ) {
    throw new Error(
      'No permitted customer communication channel is available for this recovery action.',
    );
  }
}

/*
 * ============================================================
 * DESCRIPTION
 * ============================================================
 */

function buildDescription({
  action,
  recoveryCase,
}) {
  const actionDescriptions = {
    RECOVERY_LINK:
      'Payment recovery request',

    REMINDER:
      'Payment reminder',

    ALTERNATIVE_PAYMENT:
      'Alternative payment recovery request',

    PAYMENT_RETRY:
      'Payment retry recovery request',

    DELAYED_RETRY:
      'Delayed payment retry recovery request',
  };

  const description =
    actionDescriptions[action] ||
    'Revenue recovery payment request';

  return `${description} for recovery case ${String(
    recoveryCase._id,
  )}.`;
}

/*
 * ============================================================
 * LINK AUDIT
 * ============================================================
 */

async function createPaymentLinkAudit({
  recoveryCase,
  action,
  paymentLink,
  notification,
}) {
  return AuditLog.create({
    merchantId:
      recoveryCase.merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      recoveryCase.sourceTransactionId,

    actorType:
      'RECOVERY_ENGINE',

    eventType:
      'RECOVERY_ACTION_SELECTED',

    action,

    result:
      'SUCCEEDED',

    message:
      `Razorpay payment link created for ${action}.`,

    metadata:
      createAuditMetadata({
        razorpayPaymentLinkId:
          paymentLink.id,

        paymentLinkUrl:
          paymentLink.short_url,

        referenceId:
          paymentLink.reference_id,

        amountMinor:
          paymentLink.amount,

        currency:
          paymentLink.currency,

        notificationEmail:
          notification.email,

        notificationSms:
          notification.sms,

        paymentLinkStatus:
          paymentLink.status,
      }),
  });
}

/*
 * ============================================================
 * CREATE RECOVERY PAYMENT LINK
 * ============================================================
 */

async function createRecoveryPaymentLink({
  recoveryCaseId,
  merchantId,
  action,

  /*
   * Internal execution flow can create the payment link
   * before the case is finally persisted as ACTION_EXECUTED.
   *
   * Normal callers should leave this false.
   */
  allowPendingExecution = false,
}) {
  /*
   * ----------------------------------------------------------
   * 1. BASIC VALIDATION
   * ----------------------------------------------------------
   */

  if (!recoveryCaseId) {
    throw new Error(
      'recoveryCaseId is required.',
    );
  }

  if (!merchantId) {
    throw new Error(
      'merchantId is required.',
    );
  }

  if (
    !CUSTOMER_OUTREACH_ACTIONS.has(
      action,
    )
  ) {
    throw new Error(
      `Razorpay payment links are not supported for action: ${action}`,
    );
  }

  /*
   * ----------------------------------------------------------
   * 2. LOAD RECOVERY CASE
   * ----------------------------------------------------------
   */

  const recoveryCase =
    await RecoveryCase.findOne({
      _id:
        recoveryCaseId,

      merchantId,
    });

  if (!recoveryCase) {
    throw new Error(
      'Recovery case not found.',
    );
  }

  /*
   * Normal API usage requires ACTION_EXECUTED.
   *
   * The internal execution path is allowed to create
   * the provider link before committing ACTION_EXECUTED.
   */
  const validCaseStatus =
    recoveryCase.status ===
    'ACTION_EXECUTED' ||
    (
      allowPendingExecution &&
      (
        recoveryCase.status ===
          'RECOVERY_PENDING' ||
        recoveryCase.status ===
          'DETECTED' ||
        recoveryCase.status ===
          'ANALYZING'
      )
    );

  if (!validCaseStatus) {
    throw new Error(
      `Recovery payment link can only be created for an executable recovery case. Current status: ${recoveryCase.status}.`,
    );
  }

  /*
   * ----------------------------------------------------------
   * 3. REUSE EXISTING LINK
   * ----------------------------------------------------------
   */

  const existingLinkAudit =
    await AuditLog.findOne({
      merchantId,

      recoveryCaseId:
        recoveryCase._id,

      action,

      eventType:
        'RECOVERY_ACTION_SELECTED',

      result:
        'SUCCEEDED',

      'metadata.razorpayPaymentLinkId':
        {
          $exists: true,
        },
    })
      .sort({
        occurredAt: -1,
      })
      .lean();

  if (existingLinkAudit) {
    return {
      created: false,

      reused: true,

      recoveryCaseId:
        recoveryCase._id,

      action,

      paymentLinkId:
        existingLinkAudit
          .metadata
          ?.razorpayPaymentLinkId ||
        null,

      paymentLinkUrl:
        existingLinkAudit
          .metadata
          ?.paymentLinkUrl ||
        null,

      status:
        existingLinkAudit
          .metadata
          ?.paymentLinkStatus ||
        'created',

      amountMinor:
        Number(
          existingLinkAudit
            .metadata
            ?.amountMinor ||
            0,
        ),

      currency:
        existingLinkAudit
          .metadata
          ?.currency ||
        recoveryCase.currency ||
        'INR',

      referenceId:
        existingLinkAudit
          .metadata
          ?.referenceId ||
        null,

      expiresAt:
        null,

      notification: {
        email:
          existingLinkAudit
            .metadata
            ?.notificationEmail ===
          'true',

        sms:
          existingLinkAudit
            .metadata
            ?.notificationSms ===
          'true',
      },

      message:
        'An existing Razorpay recovery payment link was already created for this case.',
    };
  }

  /*
   * ----------------------------------------------------------
   * 4. LOAD CUSTOMER
   * ----------------------------------------------------------
   */

  const customer =
    await Customer.findOne({
      _id:
        recoveryCase.customerId,

      merchantId,
    })
      .select(
        [
          '_id',
          'fullName',
          'name',
          'email',
          'phone',
          'communicationConsent',
        ].join(' '),
      )
      .lean();

  if (!customer) {
    throw new Error(
      'Customer for this recovery case was not found.',
    );
  }

  /*
   * ----------------------------------------------------------
   * 5. CUSTOMER CONSENT
   * ----------------------------------------------------------
   */

  const notification =
    buildNotificationSettings(
      customer,
    );

  ensureCommunicationChannel(
    notification,
  );

  /*
   * ----------------------------------------------------------
   * 6. AMOUNT
   * ----------------------------------------------------------
   */

  const remainingAmount =
    getRemainingRecoveryAmount(
      recoveryCase,
    );

  if (
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  /*
   * ----------------------------------------------------------
   * 7. EXPIRY
   * ----------------------------------------------------------
   */

  const expireBy =
    getPaymentLinkExpiry(
      recoveryCase.recoveryWindowEndsAt,
    );

  /*
   * ----------------------------------------------------------
   * 8. UNIQUE REFERENCE
   * ----------------------------------------------------------
   */

  const referenceId =
    `RC-${String(
      recoveryCase._id,
    )}-${Date.now()}`
      .slice(0, 40);

  /*
   * ----------------------------------------------------------
   * 9. RAZORPAY REQUEST
   * ----------------------------------------------------------
   */

  let paymentLink;

  try {
    paymentLink =
      await queueRazorpayRequest(
        () =>
          razorpay.paymentLink.create({
            amount:
              remainingAmount,

            currency:
              recoveryCase.currency ||
              'INR',

            accept_partial:
              false,

            expire_by:
              expireBy,

            reference_id:
              referenceId,

            description:
              buildDescription({
                action,
                recoveryCase,
              }),

            customer: {
              name:
                customer.fullName ||
                customer.name ||
                undefined,

              email:
                notification.email
                  ? customer.email
                  : undefined,

              contact:
                notification.sms
                  ? customer.phone
                  : undefined,
            },

            notify:
              notification,

            reminder_enable:
              action === 'REMINDER' ||
              action ===
                'RECOVERY_LINK' ||
              action ===
                'ALTERNATIVE_PAYMENT',

            notes: {
              recovery_case_id:
                String(
                  recoveryCase._id,
                ),

              action,

              merchant_id:
                String(
                  recoveryCase.merchantId,
                ),
            },
          }),
      );
  } catch (error) {
    console.error(
      'Razorpay payment link creation error:',
      error,
    );

    throw new Error(
      error?.error?.description ||
        error?.message ||
        'Failed to create Razorpay payment link.',
    );
  }

  /*
   * ----------------------------------------------------------
   * 10. AUDIT SUCCESSFUL LINK
   * ----------------------------------------------------------
   */

  await createPaymentLinkAudit({
    recoveryCase,

    action,

    paymentLink,

    notification,
  });

  /*
   * ----------------------------------------------------------
   * 11. RETURN
   * ----------------------------------------------------------
   */

  return {
    created: true,

    reused: false,

    recoveryCaseId:
      recoveryCase._id,

    action,

    paymentLinkId:
      paymentLink.id,

    paymentLinkUrl:
      paymentLink.short_url,

    status:
      paymentLink.status,

    amountMinor:
      paymentLink.amount,

    currency:
      paymentLink.currency,

    referenceId:
      paymentLink.reference_id,

    expiresAt:
      paymentLink.expire_by
        ? new Date(
            paymentLink.expire_by *
              1000,
          )
        : null,

    notification: {
      email:
        notification.email,

      sms:
        notification.sms,
    },

    message:
      'Razorpay recovery payment link created successfully.',
  };
}

module.exports = {
  createRecoveryPaymentLink,
};