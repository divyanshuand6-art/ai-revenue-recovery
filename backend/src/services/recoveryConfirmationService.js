const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');
const Transaction = require('../models/Transaction');

/*
 * --------------------------------------------------
 * PAYMENT SUCCESS STATUSES
 * --------------------------------------------------
 *
 * Adjust only if your Transaction model uses a
 * different successful status name.
 */

const SUCCESSFUL_PAYMENT_STATUSES = new Set([
  'SUCCEEDED',
  'SUCCESS',
  'PAID',
  'COMPLETED',
  'CAPTURED',
]);

/*
 * --------------------------------------------------
 * CONFIRM RECOVERY
 * --------------------------------------------------
 *
 * Money becomes "recovered" only after a successful
 * payment transaction is confirmed.
 */

async function confirmRecovery({
  recoveryCaseId,
  merchantId,
  recoveredAmountMinor,
  paymentTransactionId = null,
  actor = 'SYSTEM',
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

  if (
    !Number.isInteger(
      recoveredAmountMinor,
    ) ||
    recoveredAmountMinor <= 0
  ) {
    throw new Error(
      'recoveredAmountMinor must be a positive integer.',
    );
  }

  /*
   * --------------------------------------------------
   * 2. LOAD CASE FOR THIS MERCHANT
   * --------------------------------------------------
   */

  const recoveryCase =
    await RecoveryCase.findOne({
      _id: recoveryCaseId,
      merchantId,
    });

  if (!recoveryCase) {
    throw new Error(
      'Recovery case not found.',
    );
  }

  /*
   * --------------------------------------------------
   * 3. DUPLICATE RECOVERY PROTECTION
   * --------------------------------------------------
   *
   * Never credit the same already-recovered case again.
   */

  if (
    recoveryCase.status ===
    'RECOVERED'
  ) {
    const existingCompletionAudit =
      await AuditLog.findOne({
        merchantId,
        recoveryCaseId:
          recoveryCase._id,
        eventType:
          'RECOVERY_COMPLETED',
      });

    /*
     * Repair a missing completion audit if the case
     * is already RECOVERED but the audit entry somehow
     * does not exist.
     */

    if (
      !existingCompletionAudit
    ) {
      await AuditLog.create({
        merchantId:
          recoveryCase.merchantId,

        recoveryCaseId:
          recoveryCase._id,

        transactionId:
          paymentTransactionId ||
          recoveryCase.sourceTransactionId,

        actorType:
          actor,

        eventType:
          'RECOVERY_COMPLETED',

        /*
         * IMPORTANT:
         * AuditLog.action accepts only actual recovery
         * actions. CONFIRM_RECOVERY is NOT a valid action.
         */
        action:
          recoveryCase.currentAction ||
          'STOP',

        result:
          'SUCCEEDED',

        message:
          'Recovery was already complete; completion audit was repaired.',

        metadata: {
          recoveredAmountMinor:
            recoveryCase.recoveredAmountMinor,

          totalRecoveredAmountMinor:
            recoveryCase.recoveredAmountMinor,

          eligibleAmountMinor:
            recoveryCase.eligibleAmountMinor,

          fullyRecovered:
            true,

          paymentTransactionId:
            paymentTransactionId
              ? String(
                  paymentTransactionId,
                )
              : null,
        },
      });
    }

    return {
      confirmed:
        false,

      duplicate:
        true,

      message:
        existingCompletionAudit
          ? 'Recovery has already been confirmed.'
          : 'Recovery was already confirmed; missing completion audit was repaired.',

      recoveryCaseId:
        recoveryCase._id,

      recoveredAmountMinor:
        recoveryCase.recoveredAmountMinor,

      totalRecoveredAmountMinor:
        recoveryCase.recoveredAmountMinor,

      eligibleAmountMinor:
        recoveryCase.eligibleAmountMinor,

      remainingAmountMinor:
        0,

      fullyRecovered:
        true,

      status:
        'RECOVERED',
    };
  }

  /*
   * --------------------------------------------------
   * 4. TERMINAL STATE PROTECTION
   * --------------------------------------------------
   *
   * STOPPED and ESCALATED cases must not be turned
   * into RECOVERED automatically.
   */

  if (
    recoveryCase.status ===
      'STOPPED' ||
    recoveryCase.status ===
      'ESCALATED'
  ) {
    throw new Error(
      `Cannot automatically confirm recovery for a ${recoveryCase.status} case.`,
    );
  }

  /*
   * --------------------------------------------------
   * 5. VALIDATE PAYMENT TRANSACTION
   * --------------------------------------------------
   *
   * If a payment transaction ID is supplied, verify:
   *
   * 1. It belongs to the same merchant.
   * 2. It is successful.
   * 3. Its amount is enough.
   * 4. It belongs to the same customer when possible.
   */

  let verifiedPaymentTransaction =
    null;

  if (paymentTransactionId) {
    verifiedPaymentTransaction =
      await Transaction.findOne({
        _id:
          paymentTransactionId,

        merchantId,
      })
        .select(
          '_id status amountMinor type merchantId customerId',
        )
        .lean();

    if (
      !verifiedPaymentTransaction
    ) {
      throw new Error(
        'Payment transaction was not found for this merchant.',
      );
    }

    /*
     * The supplied transaction must be a successful
     * payment transaction.
     */

    if (
      !SUCCESSFUL_PAYMENT_STATUSES.has(
        String(
          verifiedPaymentTransaction.status ||
            '',
        ).toUpperCase(),
      )
    ) {
      throw new Error(
        `Payment transaction is not successful. Current status: ${
          verifiedPaymentTransaction.status ||
          'UNKNOWN'
        }.`,
      );
    }

    /*
     * The verified payment must cover the amount
     * being credited as recovered.
     */

    if (
      Number.isFinite(
        Number(
          verifiedPaymentTransaction.amountMinor,
        ),
      ) &&
      Number(
        verifiedPaymentTransaction.amountMinor,
      ) <
        recoveredAmountMinor
    ) {
      throw new Error(
        'Recovered amount exceeds the verified payment amount.',
      );
    }

    /*
     * When customer IDs are available on both records,
     * make sure the payment belongs to the same customer.
     */

    if (
      recoveryCase.customerId &&
      verifiedPaymentTransaction.customerId &&
      String(
        recoveryCase.customerId,
      ) !==
        String(
          verifiedPaymentTransaction.customerId,
        )
    ) {
      throw new Error(
        'Payment transaction does not belong to the customer for this recovery case.',
      );
    }
  }

  /*
   * --------------------------------------------------
   * 6. CALCULATE RECOVERY AMOUNTS
   * --------------------------------------------------
   */

  const currentRecoveredAmount =
    Number(
      recoveryCase.recoveredAmountMinor ||
        0,
    );

  const eligibleAmount =
    Number(
      recoveryCase.eligibleAmountMinor ||
        0,
    );

  const remainingAmount =
    Math.max(
      eligibleAmount -
        currentRecoveredAmount,
      0,
    );

  /*
   * There must still be recoverable revenue.
   */

  if (
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  /*
   * Never allow the system to credit more than
   * the remaining eligible revenue.
   */

  if (
    recoveredAmountMinor >
    remainingAmount
  ) {
    throw new Error(
      `Recovered amount exceeds remaining eligible amount. Maximum allowed: ${remainingAmount} minor units.`,
    );
  }

  /*
   * --------------------------------------------------
   * 7. CALCULATE NEW RECOVERED AMOUNT
   * --------------------------------------------------
   */

  const newRecoveredAmount =
    currentRecoveredAmount +
    recoveredAmountMinor;

  const fullyRecovered =
    newRecoveredAmount >=
    eligibleAmount;

  /*
   * --------------------------------------------------
   * 8. UPDATE RECOVERY CASE
   * --------------------------------------------------
   */

  recoveryCase.recoveredAmountMinor =
    newRecoveredAmount;
    if (fullyRecovered) {
  recoveryCase.status =
    'RECOVERED';

  recoveryCase.currentAction =
    'STOP';

  recoveryCase.nextActionAt =
    null;

  /*
   * IMPORTANT:
   * Store the exact moment when the money became
   * fully recovered. Dashboard analytics uses this
   * timestamp for recovery-date filtering.
   */
  recoveryCase.recoveredAt =
    new Date();
}

  await recoveryCase.save();

  /*
   * --------------------------------------------------
   * 9. AUDIT SUCCESSFUL CONFIRMATION
   * --------------------------------------------------
   */

  await AuditLog.create({
    merchantId:
      recoveryCase.merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      verifiedPaymentTransaction
        ? verifiedPaymentTransaction._id
        : recoveryCase.sourceTransactionId,

    actorType:
      actor,

    eventType:
      'RECOVERY_COMPLETED',

    /*
     * IMPORTANT:
     * Use the actual recovery action.
     * CONFIRM_RECOVERY is not a valid AuditLog action.
     */
    action:
      recoveryCase.currentAction ||
      'STOP',

    result:
      'SUCCEEDED',

    message:
      fullyRecovered
        ? 'Recovery fully confirmed after successful payment.'
        : 'Partial recovery confirmed after successful payment.',

    metadata: {
      recoveredAmountMinor,

      totalRecoveredAmountMinor:
        newRecoveredAmount,

      eligibleAmountMinor:
        eligibleAmount,

      remainingAmountMinor:
        Math.max(
          eligibleAmount -
            newRecoveredAmount,
          0,
        ),

      fullyRecovered,

      paymentTransactionId:
        verifiedPaymentTransaction
          ? String(
              verifiedPaymentTransaction._id,
            )
          : null,

      paymentStatus:
        verifiedPaymentTransaction
          ? verifiedPaymentTransaction.status
          : null,
    },
  });

  /*
   * --------------------------------------------------
   * 10. RETURN AUTHORITATIVE RESULT
   * --------------------------------------------------
   */

  return {
    confirmed:
      true,

    duplicate:
      false,

    recoveryCaseId:
      recoveryCase._id,

    recoveredAmountMinor,

    totalRecoveredAmountMinor:
      newRecoveredAmount,

    eligibleAmountMinor:
      eligibleAmount,

    remainingAmountMinor:
      Math.max(
        eligibleAmount -
          newRecoveredAmount,
        0,
      ),

    fullyRecovered,

    status:
      recoveryCase.status,

    paymentTransactionId:
      verifiedPaymentTransaction
        ? verifiedPaymentTransaction._id
        : null,
  };
}

module.exports = {
  confirmRecovery,
};