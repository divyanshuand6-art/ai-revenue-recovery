const RecoveryCase =
  require('../models/RecoveryCase');

const Transaction =
  require('../models/Transaction');

const AuditLog =
  require('../models/AuditLog');

const {
  confirmRecovery,
} = require('./recoveryConfirmationService');

const SUCCESSFUL_PAYMENT_STATUS =
  'CAPTURED';

const SYNTHETIC_SOURCE =
  'SYNTHETIC';

/*
 * --------------------------------------------------
 * CREATE PAYMENT AUDIT METADATA
 * --------------------------------------------------
 */

function createPaymentAuditMetadata(
  data = {},
) {
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
 * --------------------------------------------------
 * PAYMENT SUCCESS AUDIT
 * --------------------------------------------------
 */

async function createPaymentSucceededAudit({
  recoveryCase,
  paymentTransaction,
  actorType = 'SYSTEM',
  simulated = false,
  externalEventId = null,
}) {
  const eventId =
    externalEventId ||
    `payment-success-${paymentTransaction._id.toString()}`;

  /*
   * Idempotency protection.
   */

  const existing =
    await AuditLog.findOne({
      merchantId:
        recoveryCase.merchantId,

      externalEventId:
        eventId,
    }).lean();

  if (existing) {
    return existing;
  }

  return AuditLog.create({
    merchantId:
      recoveryCase.merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      paymentTransaction._id,

    actorType,

    eventType:
      'PAYMENT_SUCCEEDED',

    /*
     * AuditLog.action accepts recovery actions.
     */

    action:
      recoveryCase.currentAction ||
      'STOP',

    result:
      'SUCCEEDED',

    message:
      simulated
        ? 'Synthetic payment success recorded for recovery confirmation.'
        : 'Payment success received from the payment provider.',

    metadata:
      createPaymentAuditMetadata({
        paymentTransactionId:
          paymentTransaction._id,

        /*
         * For real Razorpay payments this contains the
         * Razorpay payment ID.
         *
         * For retry simulator this contains the synthetic
         * provider payment ID.
         */

        razorpayPaymentId:
          paymentTransaction.providerPaymentId,

        providerPaymentId:
          paymentTransaction.providerPaymentId,

        paymentStatus:
          paymentTransaction.status,

        amountMinor:
          paymentTransaction.amountMinor,

        currency:
          paymentTransaction.currency,

        source:
          paymentTransaction.source,

        simulated,
      }),

    externalEventId:
      eventId,

    occurredAt:
      paymentTransaction.occurredAt ||
      new Date(),
  });
}

/*
 * --------------------------------------------------
 * PROCESS A SUCCESSFUL PAYMENT
 * --------------------------------------------------
 *
 * This is the authoritative successful-payment path.
 *
 * Used by:
 *
 * 1. Real Razorpay webhook
 * 2. Synthetic/demo payment
 * 3. PAYMENT_RETRY simulator
 */

async function processSuccessfulPayment({
  recoveryCaseId,
  merchantId,
  paymentTransactionId,
  actor = 'SYSTEM',
  externalEventId = null,
}) {
  /*
   * --------------------------------------------------
   * 1. BASIC VALIDATION
   * --------------------------------------------------
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

  if (!paymentTransactionId) {
    throw new Error(
      'paymentTransactionId is required.',
    );
  }

  /*
   * --------------------------------------------------
   * 2. LOAD RECOVERY CASE
   * --------------------------------------------------
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
   * Successful payment can close only an
   * ACTION_EXECUTED case.
   */

  if (
    recoveryCase.status !==
    'ACTION_EXECUTED'
  ) {
    throw new Error(
      `Successful payment can only close an ACTION_EXECUTED recovery case. Current status: ${recoveryCase.status}.`,
    );
  }

  /*
   * --------------------------------------------------
   * 3. LOAD PAYMENT TRANSACTION
   * --------------------------------------------------
   */

  const paymentTransaction =
    await Transaction.findOne({
      _id:
        paymentTransactionId,

      merchantId,
    })
      .select(
        [
          '_id',
          'merchantId',
          'customerId',
          'recoveryCaseId',
          'status',
          'amountMinor',
          'currency',
          'source',
          'occurredAt',
          'providerPaymentId',
          'providerEventId',
        ].join(' '),
      )
      .lean();

  if (!paymentTransaction) {
    throw new Error(
      'Payment transaction was not found for this merchant.',
    );
  }

  /*
   * --------------------------------------------------
   * 4. VERIFY PAYMENT SUCCESS
   * --------------------------------------------------
   */

  if (
    paymentTransaction.status !==
    SUCCESSFUL_PAYMENT_STATUS
  ) {
    throw new Error(
      `Payment transaction is not successful. Current status: ${
        paymentTransaction.status ||
        'UNKNOWN'
      }.`,
    );
  }

  /*
   * --------------------------------------------------
   * 5. VERIFY RECOVERY CASE OWNERSHIP
   * --------------------------------------------------
   */

  if (
    paymentTransaction.recoveryCaseId &&
    String(
      paymentTransaction.recoveryCaseId,
    ) !==
      String(
        recoveryCase._id,
      )
  ) {
    throw new Error(
      'Payment transaction is linked to a different recovery case.',
    );
  }

  /*
   * --------------------------------------------------
   * 6. VERIFY CUSTOMER OWNERSHIP
   * --------------------------------------------------
   */

  if (
    paymentTransaction.customerId &&
    String(
      paymentTransaction.customerId,
    ) !==
      String(
        recoveryCase.customerId,
      )
  ) {
    throw new Error(
      'Payment transaction does not belong to the customer for this recovery case.',
    );
  }

  /*
   * --------------------------------------------------
   * 7. CALCULATE AMOUNT TO RECOVER
   * --------------------------------------------------
   */

  const remainingAmount =
    Math.max(
      Number(
        recoveryCase
          .eligibleAmountMinor ||
          0,
      ) -
        Number(
          recoveryCase
            .recoveredAmountMinor ||
            0,
        ),
      0,
    );

  if (
    !Number.isSafeInteger(
      remainingAmount,
    ) ||
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  const paymentAmount =
    Number(
      paymentTransaction
        .amountMinor ||
        0,
    );

  if (
    !Number.isSafeInteger(
      paymentAmount,
    ) ||
    paymentAmount <= 0
  ) {
    throw new Error(
      'Payment amount is invalid.',
    );
  }

  /*
   * Never recover more than the remaining
   * eligible amount.
   */

  const amountToRecover =
    Math.min(
      paymentAmount,
      remainingAmount,
    );

  if (
    !Number.isSafeInteger(
      amountToRecover,
    ) ||
    amountToRecover <= 0
  ) {
    throw new Error(
      'Payment amount is not sufficient to recover any eligible revenue.',
    );
  }

  /*
   * --------------------------------------------------
   * 8. AUTHORITATIVE RECOVERY CONFIRMATION
   * --------------------------------------------------
   */

  const confirmation =
    await confirmRecovery({
      recoveryCaseId:
        recoveryCase._id,

      merchantId:
        recoveryCase.merchantId,

      recoveredAmountMinor:
        amountToRecover,

      paymentTransactionId:
        paymentTransaction._id,

      actor,
    });

  /*
   * --------------------------------------------------
   * 9. SUCCESS AUDIT
   * --------------------------------------------------
   */

  await createPaymentSucceededAudit({
    recoveryCase,

    paymentTransaction,

    actorType:
      actor,

    simulated:
      paymentTransaction.source ===
      SYNTHETIC_SOURCE,

    externalEventId:
      externalEventId ||
      paymentTransaction
        .providerEventId ||
      null,
  });

  /*
   * --------------------------------------------------
   * 10. LINK RECOVERY TRANSACTION
   * --------------------------------------------------
   */

  await RecoveryCase.updateOne(
    {
      _id:
        recoveryCase._id,

      merchantId:
        recoveryCase.merchantId,
    },
    {
      $set: {
        recoveryTransactionId:
          paymentTransaction._id,
      },
    },
  );

  /*
   * --------------------------------------------------
   * 11. RETURN
   * --------------------------------------------------
   */

  return {
    confirmed:
      true,

    paymentTransactionId:
      paymentTransaction._id,

    razorpayPaymentId:
      paymentTransaction.providerPaymentId,

    paymentStatus:
      paymentTransaction.status,

    amountMinor:
      paymentTransaction.amountMinor,

    currency:
      paymentTransaction.currency,

    source:
      paymentTransaction.source,

    confirmation,
  };
}

/*
 * --------------------------------------------------
 * SIMULATE SUCCESSFUL RECOVERY PAYMENT
 * --------------------------------------------------
 *
 * DEMO / TESTING ONLY.
 *
 * Creates synthetic CAPTURED payment and sends it
 * through processSuccessfulPayment().
 */

async function simulateSuccessfulRecoveryPayment({
  recoveryCaseId,
  merchantId,
}) {
  /*
   * --------------------------------------------------
   * 1. VALIDATION
   * --------------------------------------------------
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

  /*
   * --------------------------------------------------
   * 2. LOAD CASE
   * --------------------------------------------------
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

  if (
    recoveryCase.status !==
    'ACTION_EXECUTED'
  ) {
    throw new Error(
      `A successful recovery payment can only be simulated after an action is executed. Current status: ${recoveryCase.status}.`,
    );
  }

  /*
   * --------------------------------------------------
   * 3. REMAINING AMOUNT
   * --------------------------------------------------
   */

  const remainingAmount =
    Math.max(
      Number(
        recoveryCase
          .eligibleAmountMinor ||
          0,
      ) -
        Number(
          recoveryCase
            .recoveredAmountMinor ||
            0,
        ),
      0,
    );

  if (
    !Number.isSafeInteger(
      remainingAmount,
    ) ||
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  /*
   * --------------------------------------------------
   * 4. SOURCE TRANSACTION
   * --------------------------------------------------
   */

  const sourceTransaction =
    await Transaction.findOne({
      _id:
        recoveryCase
          .sourceTransactionId,

      merchantId,
    })
      .select(
        '_id currency paymentMethod',
      )
      .lean();

  if (!sourceTransaction) {
    throw new Error(
      'Source transaction for this recovery case was not found.',
    );
  }

  /*
   * --------------------------------------------------
   * 5. CREATE SYNTHETIC CAPTURED PAYMENT
   * --------------------------------------------------
   */

  const now =
    new Date();

  const uniqueSuffix =
    `${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

  const paymentTransaction =
    await Transaction.create({
      merchantId:
        recoveryCase.merchantId,

      customerId:
        recoveryCase.customerId,

      recoveryCaseId:
        recoveryCase._id,

      type:
        'PAYMENT',

      status:
        SUCCESSFUL_PAYMENT_STATUS,

      amountMinor:
        remainingAmount,

      currency:
        sourceTransaction.currency ||
        recoveryCase.currency ||
        'INR',

      source:
        SYNTHETIC_SOURCE,

      paymentMethod:
        sourceTransaction.paymentMethod ||
        'UNKNOWN',

      providerOrderId:
        `synthetic-order-${uniqueSuffix}`,

      providerPaymentId:
        `synthetic-payment-${uniqueSuffix}`,

      occurredAt:
        now,
    });

  /*
   * --------------------------------------------------
   * 6. USE SAME SUCCESS CONFIRMATION PATH
   * --------------------------------------------------
   */

  try {
    return await processSuccessfulPayment({
      recoveryCaseId:
        recoveryCase._id,

      merchantId:
        recoveryCase.merchantId,

      paymentTransactionId:
        paymentTransaction._id,

      actor:
        'SYSTEM',
    });
  } catch (error) {
    await Transaction.deleteOne({
      _id:
        paymentTransaction._id,

      merchantId:
        recoveryCase.merchantId,
    });

    throw error;
  }
}

/*
 * --------------------------------------------------
 * EXECUTE PAYMENT RETRY
 * --------------------------------------------------
 *
 * DEMO / LOCAL PROVIDER SIMULATOR.
 *
 * This is used for:
 *
 * PAYMENT_RETRY
 * DELAYED_RETRY
 *
 * It does NOT create a customer-facing payment link.
 *
 * Instead:
 *
 * action executed
 *      ↓
 * retry attempt counted
 *      ↓
 * synthetic provider payment
 *      ↓
 * CAPTURED
 *      ↓
 * processSuccessfulPayment()
 *      ↓
 * RECOVERED
 */

async function executePaymentRetry({
  recoveryCaseId,
  merchantId,
  action = 'PAYMENT_RETRY',
}) {
  /*
   * --------------------------------------------------
   * 1. VALIDATION
   * --------------------------------------------------
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
    action !== 'PAYMENT_RETRY' &&
    action !== 'DELAYED_RETRY'
  ) {
    throw new Error(
      `Unsupported retry action: ${action}.`,
    );
  }

  /*
   * --------------------------------------------------
   * 2. LOAD RECOVERY CASE
   * --------------------------------------------------
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

  if (
    recoveryCase.status !==
      'ACTION_EXECUTED' ||
    recoveryCase.currentAction !==
      action
  ) {
    throw new Error(
      `${action} can only run after that same action has been executed. Current status: ${recoveryCase.status}, current action: ${
        recoveryCase.currentAction ||
        'NONE'
      }.`,
    );
  }

  /*
   * --------------------------------------------------
   * 3. REMAINING AMOUNT
   * --------------------------------------------------
   */

  const remainingAmount =
    Math.max(
      Number(
        recoveryCase
          .eligibleAmountMinor ||
          0,
      ) -
        Number(
          recoveryCase
            .recoveredAmountMinor ||
            0,
        ),
      0,
    );

  if (
    !Number.isSafeInteger(
      remainingAmount,
    ) ||
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for retry recovery.',
    );
  }

  /*
   * --------------------------------------------------
   * 4. SOURCE TRANSACTION
   * --------------------------------------------------
   */

  const sourceTransaction =
    await Transaction.findOne({
      _id:
        recoveryCase
          .sourceTransactionId,

      merchantId,
    })
      .select(
        [
          '_id',
          'currency',
          'paymentMethod',
        ].join(' '),
      )
      .lean();

  if (!sourceTransaction) {
    throw new Error(
      'Source transaction for this recovery case was not found.',
    );
  }

  /*
   * --------------------------------------------------
   * 5. RETRY ATTEMPT NUMBER
   * --------------------------------------------------
   */

  const attemptNumber =
    Number(
      recoveryCase
        .retryAttemptCount ||
        0,
    ) + 1;

  /*
   * --------------------------------------------------
   * 6. RETRY LIMIT
   * --------------------------------------------------
   */

  const maxRetries =
    Number(
      recoveryCase
        .policySnapshot
        ?.maxPaymentRetries ||
        3,
    );

  if (
    attemptNumber >
    maxRetries
  ) {
    throw new Error(
      `Maximum payment retry limit of ${maxRetries} has already been reached.`,
    );
  }

  /*
   * --------------------------------------------------
   * 7. UPDATE ATTEMPT COUNT
   * --------------------------------------------------
   */

  recoveryCase.retryAttemptCount =
    attemptNumber;

  recoveryCase.nextActionAt =
    null;

  await recoveryCase.save();

  /*
   * --------------------------------------------------
   * 8. RETRY START AUDIT
   * --------------------------------------------------
   */

  await AuditLog.create({
    merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      recoveryCase.sourceTransactionId,

    actorType:
      'RECOVERY_ENGINE',

    eventType:
      'RECOVERY_ACTION_EXECUTED',

    action,

    result:
      'PENDING',

    message:
      action ===
      'DELAYED_RETRY'
        ? `Delayed payment retry attempt #${attemptNumber} started.`
        : `Payment retry attempt #${attemptNumber} started.`,

    metadata:
      createPaymentAuditMetadata({
        retryAttemptCount:
          attemptNumber,

        maxPaymentRetries:
          maxRetries,

        retryMode:
          process.env
            .RECOVERY_RETRY_SIMULATION_MODE ||
          'SUCCESS',
      }),

    occurredAt:
      new Date(),
  });

  /*
   * --------------------------------------------------
   * 9. TEST MODE
   * --------------------------------------------------
   *
   * Supported:
   *
   * SUCCESS
   * FAIL_FIRST
   * ALWAYS_FAIL
   *
   * Default = SUCCESS
   */

  const simulationMode =
    String(
      process.env
        .RECOVERY_RETRY_SIMULATION_MODE ||
        'SUCCESS',
    )
      .trim()
      .toUpperCase();

  const shouldFail =
    simulationMode ===
      'ALWAYS_FAIL' ||
    (
      simulationMode ===
        'FAIL_FIRST' &&
      attemptNumber === 1
    );

  /*
   * --------------------------------------------------
   * 10. SIMULATED FAILURE
   * --------------------------------------------------
   */

  if (shouldFail) {
    const uniqueSuffix =
      `${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;

    const failedTransaction =
      await Transaction.create({
        merchantId:
          recoveryCase.merchantId,

        customerId:
          recoveryCase.customerId,

        recoveryCaseId:
          recoveryCase._id,

        type:
          'PAYMENT',

        status:
          'FAILED',

        amountMinor:
          remainingAmount,

        currency:
          sourceTransaction.currency ||
          recoveryCase.currency ||
          'INR',

        source:
          SYNTHETIC_SOURCE,

        paymentMethod:
          sourceTransaction.paymentMethod ||
          'UNKNOWN',

        providerStatus:
          'failed',

        providerOrderId:
          `retry-order-${uniqueSuffix}`,

        providerPaymentId:
          `retry-payment-${uniqueSuffix}`,

        failureCategory:
          'NETWORK_ERROR',

        failureCode:
          'SIMULATED_RETRY_FAILURE',

        failureReason:
          'Synthetic retry failure used for controlled recovery testing.',

        failureStage:
          'CAPTURE',

        occurredAt:
          new Date(),
      });

    /*
     * ------------------------------------------------
     * FAILURE RESULT
     * ------------------------------------------------
     *
     * The action is finished, but another recovery
     * attempt can happen when the policy allows it.
     *
     * We clear currentAction so the next execution
     * does not get blocked as a duplicate scheduled
     * action.
     */

    recoveryCase.status =
      'ACTION_SCHEDULED';

    recoveryCase.currentAction =
      null;

    recoveryCase.nextActionAt =
      new Date();

    await recoveryCase.save();

    /*
     * ------------------------------------------------
     * FAILURE AUDIT
     * ------------------------------------------------
     */

    await AuditLog.create({
      merchantId,

      recoveryCaseId:
        recoveryCase._id,

      transactionId:
        failedTransaction._id,

      actorType:
        'RECOVERY_ENGINE',

      eventType:
        'PAYMENT_FAILED',

      action,

      result:
        'FAILED',

      message:
        `Payment retry attempt #${attemptNumber} failed. The recovery case remains eligible for another policy-controlled action.`,

      metadata:
        createPaymentAuditMetadata({
          retryAttemptCount:
            attemptNumber,

          maxPaymentRetries:
            maxRetries,

          paymentTransactionId:
            failedTransaction._id,

          providerPaymentId:
            failedTransaction.providerPaymentId,

          paymentStatus:
            failedTransaction.status,

          failureCategory:
            failedTransaction.failureCategory,

          failureCode:
            failedTransaction.failureCode,

          retryMode:
            simulationMode,

          nextPolicyEvaluation:
            attemptNumber >= maxRetries
              ? 'RETRY_LIMIT_REACHED'
              : 'RETRY_REMAINING',
        }),

      occurredAt:
        failedTransaction.occurredAt,
    });

    return {
      confirmed:
        false,

      recovered:
        false,

      retrySucceeded:
        false,

      paymentTransactionId:
        failedTransaction._id,

      paymentStatus:
        failedTransaction.status,

      failureCategory:
        failedTransaction.failureCategory,

      failureCode:
        failedTransaction.failureCode,

      retryAttemptCount:
        attemptNumber,

      maxPaymentRetries:
        maxRetries,

      retryMode:
        simulationMode,

      nextActionAt:
        recoveryCase.nextActionAt,

      caseStatus:
        recoveryCase.status,

      message:
        attemptNumber >=
        maxRetries
          ? `Retry attempt #${attemptNumber} failed and the configured retry limit has been reached.`
          : `Retry attempt #${attemptNumber} failed. Another policy-controlled retry is still available.`,
    };
  }

  /*
   * --------------------------------------------------
   * 11. SIMULATED SUCCESS
   * --------------------------------------------------
   */

  const uniqueSuffix =
    `${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

  const paymentTransaction =
    await Transaction.create({
      merchantId:
        recoveryCase.merchantId,

      customerId:
        recoveryCase.customerId,

      recoveryCaseId:
        recoveryCase._id,

      type:
        'PAYMENT',

      status:
        SUCCESSFUL_PAYMENT_STATUS,

      amountMinor:
        remainingAmount,

      currency:
        sourceTransaction.currency ||
        recoveryCase.currency ||
        'INR',

      source:
        SYNTHETIC_SOURCE,

      paymentMethod:
        sourceTransaction.paymentMethod ||
        'UNKNOWN',

      providerStatus:
        'captured',

      providerOrderId:
        `retry-order-${uniqueSuffix}`,

      providerPaymentId:
        `retry-payment-${uniqueSuffix}`,

      occurredAt:
        new Date(),
    });

  /*
   * --------------------------------------------------
   * 12. PROCESS SUCCESS THROUGH AUTHORITATIVE PATH
   * --------------------------------------------------
   */

  try {
    const result =
      await processSuccessfulPayment({
        recoveryCaseId:
          recoveryCase._id,

        merchantId:
          recoveryCase.merchantId,

        paymentTransactionId:
          paymentTransaction._id,

        actor:
          'RECOVERY_ENGINE',
      });

    return {
      ...result,

      retrySucceeded:
        true,

      recovered:
        true,

      retryAttemptCount:
        attemptNumber,

      maxPaymentRetries:
        maxRetries,

      retryMode:
        simulationMode,

      message:
        `Payment retry attempt #${attemptNumber} succeeded and the recovery case was marked recovered.`,
    };
  } catch (error) {
    await Transaction.deleteOne({
      _id:
        paymentTransaction._id,

      merchantId:
        recoveryCase.merchantId,
    });

    throw error;
  }
}


/*
 * --------------------------------------------------
 * EXPORTS
 * --------------------------------------------------
 */

module.exports = {
  processSuccessfulPayment,

  simulateSuccessfulRecoveryPayment,

  executePaymentRetry,
};