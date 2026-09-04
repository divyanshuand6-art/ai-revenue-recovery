const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');
const Transaction = require('../models/Transaction');

/*
 * --------------------------------------------------
 * PAYMENT SUCCESS STATUSES
 * --------------------------------------------------
 *
 * Current Transaction model uses CAPTURED for a
 * successful payment.
 *
 * The other values are retained for compatibility
 * with possible provider integrations.
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
 *
 * ACTION_EXECUTED != RECOVERED
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
    !Number.isSafeInteger(
      recoveredAmountMinor,
    ) ||
    recoveredAmountMinor <= 0
  ) {
    throw new Error(
      'recoveredAmountMinor must be a positive safe integer.',
    );
  }

  /*
   * --------------------------------------------------
   * 2. LOAD RECOVERY CASE FOR THIS MERCHANT
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
   * An already RECOVERED case must never be credited
   * again.
   */

  if (
    recoveryCase.status === 'RECOVERED'
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
     * Repair missing completion audit if required.
     */
    if (!existingCompletionAudit) {
      await AuditLog.create({
        merchantId:
          recoveryCase.merchantId,

        recoveryCaseId:
          recoveryCase._id,

        transactionId:
          paymentTransactionId ||
          recoveryCase.recoveryTransactionId ||
          recoveryCase.sourceTransactionId,

        actorType:
          actor,

        eventType:
          'RECOVERY_COMPLETED',

        /*
         * AuditLog only accepts actual recovery actions.
         */
        action:
          recoveryCase.actionTaken ||
          'STOP',

        result:
          'SUCCEEDED',

        message:
          'Recovery was already complete; completion audit was repaired.',

        metadata: {
          recoveredAmountMinor:
            String(
              recoveryCase.recoveredAmountMinor ||
                0,
            ),

          totalRecoveredAmountMinor:
            String(
              recoveryCase.recoveredAmountMinor ||
                0,
            ),

          eligibleAmountMinor:
            String(
              recoveryCase.eligibleAmountMinor ||
                0,
            ),

          fullyRecovered:
            'true',

          paymentTransactionId:
            paymentTransactionId
              ? String(
                  paymentTransactionId,
                )
              : recoveryCase.recoveryTransactionId
                ? String(
                    recoveryCase.recoveryTransactionId,
                  )
                : null,
        },
      });
    }

    return {
      confirmed: false,

      duplicate: true,

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

      remainingAmountMinor: 0,

      fullyRecovered: true,

      status: 'RECOVERED',

      paymentTransactionId:
        recoveryCase.recoveryTransactionId ||
        null,
    };
  }

  /*
   * --------------------------------------------------
   * 4. TERMINAL STATE PROTECTION
   * --------------------------------------------------
   *
   * These states cannot be automatically converted
   * into RECOVERED.
   */

  if (
    recoveryCase.status === 'STOPPED' ||
    recoveryCase.status === 'ESCALATED' ||
    recoveryCase.status === 'EXPIRED' ||
    recoveryCase.status === 'FAILED'
  ) {
    throw new Error(
      `Cannot automatically confirm recovery for a ${recoveryCase.status} case.`,
    );
  }

  /*
   * --------------------------------------------------
   * 5. ACTION MUST HAVE BEEN EXECUTED
   * --------------------------------------------------
   *
   * A case should not become RECOVERED merely because
   * someone called /confirm.
   */

  if (
    recoveryCase.status !== 'ACTION_EXECUTED'
  ) {
    throw new Error(
      `Recovery case must be ACTION_EXECUTED before payment confirmation. Current status: ${recoveryCase.status}.`,
    );
  }

  /*
   * --------------------------------------------------
   * 6. VALIDATE PAYMENT TRANSACTION
   * --------------------------------------------------
   *
   * For a real payment confirmation, the payment
   * transaction should be supplied and verified.
   */

  let verifiedPaymentTransaction = null;

  if (paymentTransactionId) {
    verifiedPaymentTransaction =
      await Transaction.findOne({
        _id: paymentTransactionId,
        merchantId,
      })
        .select(
          [
            '_id',
            'status',
            'amountMinor',
            'type',
            'merchantId',
            'customerId',
            'recoveryCaseId',
          ].join(' '),
        )
        .lean();

    if (!verifiedPaymentTransaction) {
      throw new Error(
        'Payment transaction was not found for this merchant.',
      );
    }

    /*
     * --------------------------------------------------
     * 6A. PAYMENT MUST BELONG TO THIS RECOVERY CASE
     * --------------------------------------------------
     */

    if (
      verifiedPaymentTransaction.recoveryCaseId &&
      String(
        verifiedPaymentTransaction.recoveryCaseId,
      ) !==
        String(recoveryCase._id)
    ) {
      throw new Error(
        'Payment transaction does not belong to this recovery case.',
      );
    }

    /*
     * --------------------------------------------------
     * 6B. PAYMENT MUST BE SUCCESSFUL
     * --------------------------------------------------
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
        `Payment transaction is not successful. Current status: ${verifiedPaymentTransaction.status || 'UNKNOWN'}.`,
      );
    }

    /*
     * --------------------------------------------------
     * 6C. PAYMENT AMOUNT CHECK
     * --------------------------------------------------
     */

    if (
      Number.isFinite(
        Number(
          verifiedPaymentTransaction.amountMinor,
        ),
      ) &&
      Number(
        verifiedPaymentTransaction.amountMinor,
      ) < recoveredAmountMinor
    ) {
      throw new Error(
        'Recovered amount exceeds the verified payment amount.',
      );
    }

    /*
     * --------------------------------------------------
     * 6D. CUSTOMER OWNERSHIP CHECK
     * --------------------------------------------------
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
  } else {
    /*
     * For this project, require a concrete payment
     * transaction for an authoritative recovery
     * confirmation.
     */
    throw new Error(
      'paymentTransactionId is required to confirm a successful recovery.',
    );
  }

  /*
   * --------------------------------------------------
   * 7. CALCULATE RECOVERY AMOUNTS
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

  if (
    remainingAmount <= 0
  ) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  /*
   * Never over-credit the recovery case.
   */
  if (
    recoveredAmountMinor >
    remainingAmount
  ) {
    throw new Error(
      `Recovered amount exceeds remaining eligible amount. Maximum allowed: ${remainingAmount} minor units.`,
    );
  }

  const newRecoveredAmount =
    currentRecoveredAmount +
    recoveredAmountMinor;

  const fullyRecovered =
    newRecoveredAmount >=
    eligibleAmount;

  /*
   * --------------------------------------------------
   * 8. PRESERVE THE ACTION THAT CAUSED RECOVERY
   * --------------------------------------------------
   *
   * Before changing currentAction to STOP, remember
   * the action that actually led to the payment.
   */

  const actionThatLedToRecovery =
    recoveryCase.actionTaken ||
    recoveryCase.currentAction ||
    null;

  /*
   * --------------------------------------------------
   * 9. UPDATE RECOVERY CASE
   * --------------------------------------------------
   */

  recoveryCase.recoveredAmountMinor =
    newRecoveredAmount;

  if (actionThatLedToRecovery) {
    recoveryCase.actionTaken =
      actionThatLedToRecovery;
  }

  recoveryCase.recoveryTransactionId =
    verifiedPaymentTransaction._id;

  if (fullyRecovered) {
    recoveryCase.status =
      'RECOVERED';

    recoveryCase.currentAction =
      'STOP';

    recoveryCase.nextActionAt =
      null;

    recoveryCase.recoveredAt =
      new Date();
  }

  await recoveryCase.save();

  /*
   * --------------------------------------------------
   * 10. AUDIT SUCCESSFUL RECOVERY
   * --------------------------------------------------
   */

  await AuditLog.create({
    merchantId:
      recoveryCase.merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      verifiedPaymentTransaction._id,

    actorType:
      actor === 'SYSTEM'
        ? 'SYSTEM'
        : actor,

    eventType:
      'RECOVERY_COMPLETED',

    /*
     * Preserve the real action that caused recovery.
     */
    action:
      actionThatLedToRecovery ||
      'STOP',

    result:
      'SUCCEEDED',

    message:
      fullyRecovered
        ? 'Recovery fully confirmed after successful payment.'
        : 'Partial recovery confirmed after successful payment.',

    metadata: {
      recoveredAmountMinor:
        String(recoveredAmountMinor),

      totalRecoveredAmountMinor:
        String(newRecoveredAmount),

      eligibleAmountMinor:
        String(eligibleAmount),

      remainingAmountMinor:
        String(
          Math.max(
            eligibleAmount -
              newRecoveredAmount,
            0,
          ),
        ),

      fullyRecovered:
        String(fullyRecovered),

      paymentTransactionId:
        String(
          verifiedPaymentTransaction._id,
        ),

      paymentStatus:
        String(
          verifiedPaymentTransaction.status ||
            '',
        ),

      actionTaken:
        String(
          actionThatLedToRecovery ||
            '',
        ),
    },
  });

  /*
   * --------------------------------------------------
   * 11. RETURN AUTHORITATIVE RESULT
   * --------------------------------------------------
   */

  return {
    confirmed: true,

    duplicate: false,

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
      verifiedPaymentTransaction._id,
  };
}

/*
 * --------------------------------------------------
 * EXPORT
 * --------------------------------------------------
 */

module.exports = {
  confirmRecovery,
};