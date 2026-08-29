const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

/*
 * --------------------------------------------------
 * EXECUTABLE ACTIONS
 * --------------------------------------------------
 */

const EXECUTABLE_ACTIONS = Object.freeze([
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
 * --------------------------------------------------
 * TERMINAL STATUSES
 * --------------------------------------------------
 *
 * A terminal case must never be executed again.
 */

const TERMINAL_STATUSES = Object.freeze([
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'EXPIRED',
  'STOPPED',
]);

/*
 * --------------------------------------------------
 * NORMALIZE AUDIT METADATA
 * --------------------------------------------------
 *
 * AuditLog metadata is stored as strings.
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
        String(value),
      ]),
  );
}

/*
 * --------------------------------------------------
 * CREATE AUDIT LOG
 * --------------------------------------------------
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
      createAuditMetadata(metadata),
  });
}

/*
 * --------------------------------------------------
 * EXECUTE RECOVERY ACTION
 * --------------------------------------------------
 */

async function executeRecoveryAction({
  recoveryCaseId,
  action,
  reason,
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
   * --------------------------------------------------
   * 2. LOAD RECOVERY CASE
   * --------------------------------------------------
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
   * --------------------------------------------------
   * 3. TERMINAL CASE PROTECTION
   * --------------------------------------------------
   *
   * Already recovered / failed / escalated /
   * expired / stopped cases cannot be processed again.
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
   * --------------------------------------------------
   * 4. STOP
   * --------------------------------------------------
   *
   * STOP is an actual successful state transition
   * when the case is not already terminal.
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

    await recoveryCase.save();

    await createRecoveryAuditLog({
      recoveryCase,

      eventType:
        'RECOVERY_STOPPED',

      action:
        'STOP',

      /*
       * IMPORTANT:
       *
       * This STOP was actually executed.
       * Therefore it must NOT be SKIPPED.
       */
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

      message:
        'Recovery workflow stopped successfully.',
    };
  }

  /*
   * --------------------------------------------------
   * 5. ESCALATE
   * --------------------------------------------------
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

      message:
        'Recovery case escalated successfully.',
    };
  }

  /*
   * --------------------------------------------------
   * 6. DUPLICATE SCHEDULED ACTION PROTECTION
   * --------------------------------------------------
   *
   * A case that already has a scheduled action should
   * not receive another automatic action of a different
   * type.
   *
   * STOP and ESCALATE are handled above because they
   * intentionally change the case state.
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
   * --------------------------------------------------
   * 7. NORMAL BOUNDED RECOVERY ACTION
   * --------------------------------------------------
   *
   * Executing the recovery action does NOT prove
   * that money has been recovered.
   *
   * The provider/payment confirmation endpoint
   * must confirm the successful payment separately.
   */

  const previousStatus =
    recoveryCase.status;

  recoveryCase.status =
    'ACTION_EXECUTED';

  recoveryCase.currentAction =
    action;

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

      retryAttemptCount:
        recoveryCase.retryAttemptCount,

      reminderCount:
        recoveryCase.reminderCount,
    },
  });

  return {
    executed: true,

    blocked: false,

    action,

    status:
      'ACTION_EXECUTED',

    recovered: false,

    message:
      'Recovery action recorded. Payment recovery must be confirmed separately.',
  };
}

/*
 * --------------------------------------------------
 * EXPORT
 * --------------------------------------------------
 */

module.exports = {
  executeRecoveryAction,
};