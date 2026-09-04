const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

const {
  createRecoveryPaymentLink,
} = require('./razorpayRecoveryService');

/*
 * ============================================================
 * EXECUTABLE ACTIONS
 * ============================================================
 */

const EXECUTABLE_ACTIONS =
  Object.freeze([
    'PAYMENT_RETRY',
    'DELAYED_RETRY',
    'RECOVERY_LINK',
    'ALTERNATIVE_PAYMENT',
    'REMINDER',
    'FOLLOW_UP',
    'ESCALATE',
    'STOP',
  ]);

/*
 * ============================================================
 * CUSTOMER PAYMENT-LINK ACTIONS
 * ============================================================
 */

const PAYMENT_LINK_ACTIONS =
  new Set([
    'RECOVERY_LINK',
    'ALTERNATIVE_PAYMENT',
    'REMINDER',
    'PAYMENT_RETRY',
    'DELAYED_RETRY',
  ]);

/*
 * ============================================================
 * TERMINAL STATUSES
 * ============================================================
 */

const TERMINAL_STATUSES =
  Object.freeze([
    'RECOVERED',
    'FAILED',
    'ESCALATED',
    'EXPIRED',
    'STOPPED',
  ]);

/*
 * ============================================================
 * AUDIT METADATA
 * ============================================================
 */

function createAuditMetadata(
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
        String(value),
      ]),
  );
}

/*
 * ============================================================
 * AUDIT
 * ============================================================
 */

async function createRecoveryAuditLog({
  recoveryCase,
  eventType,
  action,
  result,
  message,
  metadata = {},
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

    eventType,

    action,

    result,

    message,

    metadata:
      createAuditMetadata(
        metadata,
      ),
  });
}

/*
 * ============================================================
 * EXECUTE RECOVERY ACTION
 * ============================================================
 */

async function executeRecoveryAction({
  recoveryCaseId,
  action,
  reason,
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

  if (
    !EXECUTABLE_ACTIONS.includes(
      action,
    )
  ) {
    throw new Error(
      `Unsupported recovery action: ${action}`,
    );
  }

  /*
   * ----------------------------------------------------------
   * 2. LOAD CASE
   * ----------------------------------------------------------
   */

  const recoveryCase =
    await RecoveryCase.findById(
      recoveryCaseId,
    );

  if (!recoveryCase) {
    throw new Error(
      'Recovery case not found.',
    );
  }

  /*
   * ----------------------------------------------------------
   * 3. TERMINAL PROTECTION
   * ----------------------------------------------------------
   */

  if (
    TERMINAL_STATUSES.includes(
      recoveryCase.status,
    )
  ) {
    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'RECOVERY_STOPPED',

      action:
        'STOP',

      result:
        'SKIPPED',

      message:
        `Recovery action ${action} was blocked because the case is already ${recoveryCase.status}.`,

      metadata: {
        requestedAction:
          action,

        existingStatus:
          recoveryCase.status,
      },
    });

    return {
      executed: false,

      blocked: true,

      action:
        'STOP',

      reason:
        `Recovery case is already ${recoveryCase.status}.`,

      status:
        recoveryCase.status,
    };
  }

  /*
   * ----------------------------------------------------------
   * 4. STOP
   * ----------------------------------------------------------
   */

  if (action === 'STOP') {
    const previousStatus =
      recoveryCase.status;

    recoveryCase.status =
      'STOPPED';

    recoveryCase.currentAction =
      'STOP';

    recoveryCase.stopReason =
      reason ||
      'Recovery workflow stopped by policy.';

    recoveryCase.nextActionAt =
      null;

    await recoveryCase.save();

    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'RECOVERY_STOPPED',

      action:
        'STOP',

      result:
        'SUCCEEDED',

      message:
        reason ||
        'Recovery workflow stopped by policy.',

      metadata: {
        previousStatus,
      },
    });

    return {
      executed: true,

      blocked: false,

      action:
        'STOP',

      status:
        'STOPPED',

      recovered: false,

      awaitingPaymentConfirmation:
        false,

      message:
        'Recovery workflow stopped successfully.',
    };
  }

  /*
   * ----------------------------------------------------------
   * 5. ESCALATE
   * ----------------------------------------------------------
   */

  if (action === 'ESCALATE') {
    const previousStatus =
      recoveryCase.status;

    recoveryCase.status =
      'ESCALATED';

    recoveryCase.currentAction =
      'ESCALATE';

    recoveryCase.escalationReason =
      reason ||
      'Recovery requires manual intervention.';

    recoveryCase.nextActionAt =
      null;

    await recoveryCase.save();

    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'RECOVERY_ESCALATED',

      action:
        'ESCALATE',

      result:
        'SUCCEEDED',

      message:
        reason ||
        'Recovery case escalated for manual intervention.',

      metadata: {
        previousStatus,
      },
    });

    return {
      executed: true,

      blocked: false,

      action:
        'ESCALATE',

      status:
        'ESCALATED',

      recovered: false,

      awaitingPaymentConfirmation:
        false,

      message:
        'Recovery case escalated successfully.',
    };
  }

  /*
   * ----------------------------------------------------------
   * 6. DUPLICATE SCHEDULED ACTION
   * ----------------------------------------------------------
   */

  if (
    recoveryCase.status ===
      'ACTION_SCHEDULED' &&
    recoveryCase.currentAction
  ) {
    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'POLICY_REJECTED',

      action:
        recoveryCase.currentAction,

      result:
        'REJECTED',

      message:
        `Recovery action ${action} was rejected because ${recoveryCase.currentAction} is already scheduled.`,

      metadata: {
        requestedAction:
          action,

        existingAction:
          recoveryCase.currentAction,

        status:
          recoveryCase.status,
      },
    });

    return {
      executed: false,

      blocked: true,

      action:
        recoveryCase.currentAction,

      reason:
        'An action is already scheduled for this recovery case.',

      status:
        recoveryCase.status,
    };
  }

  /*
   * ----------------------------------------------------------
   * 7. ALREADY EXECUTED
   * ----------------------------------------------------------
   */

  if (
    recoveryCase.status ===
    'ACTION_EXECUTED'
  ) {
    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'POLICY_REJECTED',

      action:
        recoveryCase.currentAction ||
        action,

      result:
        'REJECTED',

      message:
        'Recovery action has already been executed and is awaiting payment confirmation.',

      metadata: {
        requestedAction:
          action,

        existingAction:
          recoveryCase.currentAction,

        status:
          recoveryCase.status,
      },
    });

    return {
      executed: false,

      blocked: true,

      action:
        recoveryCase.currentAction ||
        action,

      reason:
        'Recovery action has already been executed and is awaiting payment confirmation.',

      status:
        recoveryCase.status,

      awaitingPaymentConfirmation:
        true,
    };
  }

  /*
   * ----------------------------------------------------------
   * 8. CUSTOMER PAYMENT FLOW
   * ----------------------------------------------------------
   *
   * IMPORTANT:
   *
   * We DO NOT save ACTION_EXECUTED before creating the
   * Razorpay payment link.
   *
   * This prevents:
   *
   * ACTION_EXECUTED
   *      ↓
   * Razorpay 429
   *      ↓
   * false-looking execution history
   *
   * Instead:
   *
   * Razorpay link
   *      ↓
   * success
   *      ↓
   * ACTION_EXECUTED
   */

  if (
    PAYMENT_LINK_ACTIONS.has(
      action,
    )
  ) {
    let paymentLink;

    try {
      /*
       * Create/reuse Razorpay link while the case is still
       * in the original state.
       */
      paymentLink =
        await createRecoveryPaymentLink({
          recoveryCaseId:
            recoveryCase._id,

          merchantId:
            recoveryCase.merchantId,

          action,

          allowPendingExecution:
            true,
        });
    } catch (error) {
      /*
       * No ACTION_EXECUTED state has been committed yet.
       *
       * Therefore no rollback is required.
       */

      await createRecoveryAuditLog({
        recoveryCase,

        eventType:
          'POLICY_REJECTED',

        action,

        result:
          'FAILED',

        message:
          `Recovery action ${action} could not be completed because the Razorpay payment link could not be created.`,

        metadata: {
          previousStatus:
            recoveryCase.status,

          razorpayError:
            error.message,
        },
      });

      throw new Error(
        `Recovery action ${action} could not be completed: ${error.message}`,
      );
    }

    /*
     * --------------------------------------------------------
     * 8A. LINK SUCCESS → COMMIT ACTION_EXECUTED
     * --------------------------------------------------------
     */

    const previousStatus =
      recoveryCase.status;

    recoveryCase.status =
      'ACTION_EXECUTED';

    recoveryCase.currentAction =
      action;

    recoveryCase.nextActionAt =
      null;

    if (
      action ===
        'PAYMENT_RETRY' ||
      action ===
        'DELAYED_RETRY'
    ) {
      recoveryCase.retryAttemptCount =
        Number(
          recoveryCase.retryAttemptCount ||
            0,
        ) + 1;
    }

    await recoveryCase.save();

    /*
     * --------------------------------------------------------
     * 8B. ACTION EXECUTED AUDIT
     * --------------------------------------------------------
     */

    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'RECOVERY_ACTION_EXECUTED',

      action,

      result:
        'PENDING',

      message:
        reason ||
        `Recovery action ${action} executed and is awaiting payment confirmation.`,

      metadata: {
        previousStatus,

        amountAtRiskMinor:
          recoveryCase.amountAtRiskMinor,

        eligibleAmountMinor:
          recoveryCase.eligibleAmountMinor,

        recoveredAmountMinor:
          recoveryCase.recoveredAmountMinor,

        retryAttemptCount:
          recoveryCase.retryAttemptCount,

        reminderCount:
          recoveryCase.reminderCount,

        customerFacingAction:
          true,

        paymentLinkCreated:
          true,
      },
    });

    return {
      executed: true,

      blocked: false,

      action,

      status:
        'ACTION_EXECUTED',

      recovered: false,

      awaitingPaymentConfirmation:
        true,

      customerOutreach: true,

      paymentLink: {
        created:
          paymentLink.created,

        reused:
          paymentLink.reused,

        paymentLinkId:
          paymentLink.paymentLinkId,

        paymentLinkUrl:
          paymentLink.paymentLinkUrl,

        status:
          paymentLink.status,

        amountMinor:
          paymentLink.amountMinor,

        currency:
          paymentLink.currency,

        referenceId:
          paymentLink.referenceId,

        expiresAt:
          paymentLink.expiresAt,

        notification:
          paymentLink.notification,
      },

      message:
        'Recovery action executed and Razorpay payment link created. Revenue will be counted as recovered only after successful payment confirmation.',
    };
  }

  /*
   * ----------------------------------------------------------
   * 9. NON-CUSTOMER ACTIONS
   * ----------------------------------------------------------
   *
   * FOLLOW_UP currently records the action only.
   *
   * It does not create a payment link and does not mark
   * the customer as recovered.
   */

  const previousStatus =
    recoveryCase.status;

  recoveryCase.status =
    'ACTION_EXECUTED';

  recoveryCase.currentAction =
    action;

  recoveryCase.nextActionAt =
    null;

  await recoveryCase.save();

  await createRecoveryAuditLog({
    recoveryCase,

    eventType:
      'RECOVERY_ACTION_EXECUTED',

    action,

    result:
      'PENDING',

    message:
      reason ||
      `Recovery action ${action} executed and is awaiting payment confirmation.`,

    metadata: {
      previousStatus,

      amountAtRiskMinor:
        recoveryCase.amountAtRiskMinor,

      eligibleAmountMinor:
        recoveryCase.eligibleAmountMinor,

      recoveredAmountMinor:
        recoveryCase.recoveredAmountMinor,

      customerFacingAction:
        false,
    },
  });

  return {
    executed: true,

    blocked: false,

    action,

    status:
      'ACTION_EXECUTED',

    recovered: false,

    awaitingPaymentConfirmation:
      true,

    customerOutreach: false,

    paymentLink: null,

    message:
      'Recovery action recorded. Revenue will be counted as recovered only after successful payment confirmation.',
  };
}

module.exports = {
  executeRecoveryAction,
};