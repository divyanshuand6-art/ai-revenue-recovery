const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');
const Transaction = require('../models/Transaction');

async function confirmRecovery({
  recoveryCaseId,
  merchantId,
  recoveredAmountMinor,
  paymentTransactionId = null,
  actor = 'SYSTEM',
}) {
  if (!recoveryCaseId) {
    throw new Error('recoveryCaseId is required.');
  }

  if (!merchantId) {
    throw new Error('merchantId is required.');
  }

  if (
    !Number.isInteger(recoveredAmountMinor) ||
    recoveredAmountMinor <= 0
  ) {
    throw new Error(
      'recoveredAmountMinor must be a positive integer.',
    );
  }

  /*
   * Find the recovery case belonging to the
   * authenticated merchant.
   *
   * This prevents one merchant from confirming
   * another merchant's recovery case.
   */
  const recoveryCase = await RecoveryCase.findOne({
    _id: recoveryCaseId,
    merchantId,
  });

  if (!recoveryCase) {
    throw new Error('Recovery case not found.');
  }

  /*
   * A case that is already recovered must not be
   * credited again.
   */
  if (recoveryCase.status === 'RECOVERED') {
    const existingCompletionAudit =
      await AuditLog.findOne({
        recoveryCaseId: recoveryCase._id,
        eventType: 'RECOVERY_COMPLETED',
      });

    if (!existingCompletionAudit) {
      await AuditLog.create({
        merchantId: recoveryCase.merchantId,
        recoveryCaseId: recoveryCase._id,
        transactionId:
          paymentTransactionId ||
          recoveryCase.sourceTransactionId,
        actorType: actor,
        eventType: 'RECOVERY_COMPLETED',
        result: 'SUCCEEDED',
        message:
          'Recovery fully confirmed after successful payment.',
        metadata: {
          recoveredAmountMinor:
            recoveryCase.recoveredAmountMinor,

          totalRecoveredAmountMinor:
            recoveryCase.recoveredAmountMinor,

          eligibleAmountMinor:
            recoveryCase.eligibleAmountMinor,

          fullyRecovered: true,

          paymentTransactionId:
            paymentTransactionId || null,
        },
      });
    }

    return {
      confirmed: false,

      duplicate: true,

      message: existingCompletionAudit
        ? 'Recovery has already been confirmed.'
        : 'Recovery was already confirmed; missing completion audit was repaired.',

      recoveryCaseId: recoveryCase._id,

      recoveredAmountMinor:
        recoveryCase.recoveredAmountMinor,
    };
  }

  /*
   * STOPPED and ESCALATED cases cannot automatically
   * become recovered without an explicit workflow.
   */
  if (
    recoveryCase.status === 'STOPPED' ||
    recoveryCase.status === 'ESCALATED'
  ) {
    throw new Error(
      `Cannot automatically confirm recovery for a ${recoveryCase.status} case.`,
    );
  }

  const currentRecoveredAmount = Number(
    recoveryCase.recoveredAmountMinor || 0,
  );

  const eligibleAmount = Number(
    recoveryCase.eligibleAmountMinor || 0,
  );

  const remainingAmount = Math.max(
    eligibleAmount - currentRecoveredAmount,
    0,
  );

  /*
   * Never allow the system to record more recovery
   * than the remaining eligible amount.
   */
  if (remainingAmount <= 0) {
    throw new Error(
      'No eligible amount remains for recovery.',
    );
  }

  if (recoveredAmountMinor > remainingAmount) {
    throw new Error(
      `Recovered amount exceeds remaining eligible amount. Maximum allowed: ${remainingAmount} minor units.`,
    );
  }

  /*
   * Calculate the new recovered amount.
   */
  const newRecoveredAmount =
    currentRecoveredAmount +
    recoveredAmountMinor;

  /*
   * If the complete eligible amount has now been
   * recovered, the case becomes RECOVERED.
   *
   * Otherwise it remains active for possible
   * bounded follow-up.
   */
  const fullyRecovered =
    newRecoveredAmount >= eligibleAmount;

  recoveryCase.recoveredAmountMinor =
    newRecoveredAmount;

  if (fullyRecovered) {
    recoveryCase.status = 'RECOVERED';
    recoveryCase.currentAction = 'STOP';
  }

  /*
   * If the payment system supplied a transaction ID,
   * verify that the transaction belongs to the same
   * authenticated merchant before storing it.
   */
  let verifiedPaymentTransaction = null;

  if (paymentTransactionId) {
    verifiedPaymentTransaction =
      await Transaction.findOne({
        _id: paymentTransactionId,
        merchantId,
      })
        .select(
          '_id status amountMinor type',
        )
        .lean();

    if (!verifiedPaymentTransaction) {
      throw new Error(
        'Payment transaction was not found for this merchant.',
      );
    }
  }

  await recoveryCase.save();

  /*
   * Record the successful recovery confirmation.
   */
  await AuditLog.create({
    merchantId: recoveryCase.merchantId,

    recoveryCaseId: recoveryCase._id,

    eventType: 'RECOVERY_COMPLETED',

    actorType: actor,

    result: 'SUCCEEDED',

    message: fullyRecovered
      ? 'Recovery fully confirmed after successful payment.'
      : 'Partial recovery confirmed after successful payment.',

    metadata: {
      recoveredAmountMinor,

      totalRecoveredAmountMinor:
        newRecoveredAmount,

      eligibleAmountMinor:
        eligibleAmount,

      fullyRecovered,

      paymentTransactionId:
        verifiedPaymentTransaction
          ? String(
              verifiedPaymentTransaction._id,
            )
          : null,
    },
  });

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
  };
}

module.exports = {
  confirmRecovery,
};