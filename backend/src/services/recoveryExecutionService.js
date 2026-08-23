const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

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

const TERMINAL_STATUSES = Object.freeze([
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'EXPIRED',
  'STOPPED',
]);

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

async function createRecoveryAuditLog({
  recoveryCase,
  eventType,
  action,
  result,
  message,
  metadata = {},
}) {
  return AuditLog.create({
    merchantId: recoveryCase.merchantId,

    recoveryCaseId: recoveryCase._id,

    transactionId:
      recoveryCase.sourceTransactionId,

    actorType: 'RECOVERY_ENGINE',

    eventType,

    action,

    result,

    message,

    metadata:
      createAuditMetadata(metadata),
  });
}

async function executeRecoveryAction({
  recoveryCaseId,
  action,
  reason,
}) {
  if (!recoveryCaseId) {
    throw new Error(
      'recoveryCaseId is required.',
    );
  }

  if (!EXECUTABLE_ACTIONS.includes(action)) {
    throw new Error(
      `Unsupported recovery action: ${action}`,
    );
  }

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
   * TERMINAL CASE PROTECTION
   * --------------------------------------------------
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

      action: 'STOP',

      result: 'SKIPPED',

      message:
        `Recovery action ${action} was blocked because the case is already ${recoveryCase.status}.`,

      metadata: {
        requestedAction: action,

        existingStatus:
          recoveryCase.status,
      },
    });

    return {
      executed: false,

      blocked: true,

      action: 'STOP',

      reason:
        `Recovery case is already ${recoveryCase.status}.`,

      status:
        recoveryCase.status,
    };
  }

  /*
   * --------------------------------------------------
   * DUPLICATE SCHEDULED ACTION PROTECTION
   * --------------------------------------------------
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
        requestedAction: action,

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
   * STOP
   * --------------------------------------------------
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

      action: 'STOP',

      result:
        'SKIPPED',

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

      action: 'STOP',

      status: 'STOPPED',
    };
  }

  /*
   * --------------------------------------------------
   * ESCALATE
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
        'PENDING',

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
    };
  }

  /*
   * --------------------------------------------------
   * NORMAL BOUNDED RECOVERY ACTION
   * --------------------------------------------------
   *
   * IMPORTANT:
   *
   * Executing an action does NOT mean that money
   * has been recovered.
   *
   * Payment confirmation happens separately.
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
      recoveryCase.status,

    recovered: false,

    message:
      'Recovery action recorded. Payment recovery must be confirmed separately.',
  };
}

module.exports = {
  executeRecoveryAction,
};