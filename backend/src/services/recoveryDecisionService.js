const ACTIONS = Object.freeze({
  PAYMENT_RETRY: 'PAYMENT_RETRY',
  DELAYED_RETRY: 'DELAYED_RETRY',
  ALTERNATIVE_PAYMENT: 'ALTERNATIVE_PAYMENT',
  RECOVERY_LINK: 'RECOVERY_LINK',
  REMINDER: 'REMINDER',
  FOLLOW_UP: 'FOLLOW_UP',
  ESCALATE: 'ESCALATE',
  STOP: 'STOP',
});

const TERMINAL_STATUSES = Object.freeze([
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'EXPIRED',
  'STOPPED',
]);

const FAILURE_CATEGORIES = Object.freeze({
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  BANK_DECLINED: 'BANK_DECLINED',
  MANDATE_ERROR: 'MANDATE_ERROR',
});

function isRecoveryWindowExpired(recoveryWindowEndsAt, now = new Date()) {
  if (!recoveryWindowEndsAt) {
    return true;
  }

  const windowEnd = new Date(recoveryWindowEndsAt);

  if (Number.isNaN(windowEnd.getTime())) {
    return true;
  }

  return now >= windowEnd;
}

function getPolicyValue(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function decideRecoveryAction({
  failureCategory,
  caseType,
  status,
  retryAttemptCount = 0,
  reminderCount = 0,
  eligibleAmountMinor = 0,
  recoveredAmountMinor = 0,
  recoveryWindowEndsAt,
  policySnapshot = {},
  currentAction = null,
  now = new Date(),
}) {
  const maxPaymentRetries = getPolicyValue(
    policySnapshot.maxPaymentRetries,
    3,
  );

  const maxReminders = getPolicyValue(
    policySnapshot.maxReminders,
    2,
  );

  /*
   * ----------------------------------------------------
   * SAFETY CHECK 1
   * ----------------------------------------------------
   * Terminal cases must never be processed again.
   */

  if (TERMINAL_STATUSES.includes(status)) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'TERMINAL_CASE',
      reason: `Recovery case is already in terminal status: ${status}.`,
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * SAFETY CHECK 2
   * ----------------------------------------------------
   * Recovery window must still be active.
   */

  if (
    isRecoveryWindowExpired(
      recoveryWindowEndsAt,
      now,
    )
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'RECOVERY_WINDOW_EXPIRED',
      reason: 'Recovery window has expired.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * SAFETY CHECK 3
   * ----------------------------------------------------
   * Nothing is eligible for recovery.
   */

  if (eligibleAmountMinor <= 0) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'NO_ELIGIBLE_AMOUNT',
      reason: 'No eligible amount remains for recovery.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * SAFETY CHECK 4
   * ----------------------------------------------------
   * Full eligible amount has already been recovered.
   */

  if (recoveredAmountMinor >= eligibleAmountMinor) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'ALREADY_RECOVERED',
      reason: 'Eligible amount has already been recovered.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * SAFETY CHECK 5
   * ----------------------------------------------------
   * Prevent duplicate execution of an already scheduled
   * action.
   */

  if (
    status === 'ACTION_SCHEDULED' &&
    currentAction
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'ACTION_ALREADY_SCHEDULED',
      reason: `Action ${currentAction} is already scheduled.`,
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * CHECKOUT ABANDONMENT
   * ----------------------------------------------------
   */

  if (caseType === 'CHECKOUT_ABANDONMENT') {
    if (reminderCount >= maxReminders) {
      return {
        action: ACTIONS.ESCALATE,
        reasonCode: 'REMINDER_LIMIT_REACHED',
        reason:
          'Maximum checkout reminders have been reached.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    return {
      action: ACTIONS.RECOVERY_LINK,
      reasonCode: 'CHECKOUT_ABANDONMENT',
      reason:
        'Customer abandoned checkout; send a recovery link.',
      bounded: true,
      requiresCustomerAction: true,
    };
  }

  /*
   * ----------------------------------------------------
   * SUBSCRIPTION PAYMENT FAILURE
   * ----------------------------------------------------
   */

  if (
    caseType === 'SUBSCRIPTION_PAYMENT_FAILURE'
  ) {
    if (
      retryAttemptCount >= maxPaymentRetries
    ) {
      if (reminderCount < maxReminders) {
        return {
          action: ACTIONS.REMINDER,
          reasonCode: 'PAYMENT_RETRY_LIMIT_REACHED',
          reason:
            'Payment retry limit reached; send a controlled reminder.',
          bounded: true,
          requiresCustomerAction: true,
        };
      }

      return {
        action: ACTIONS.ESCALATE,
        reasonCode: 'RECOVERY_LIMIT_REACHED',
        reason:
          'Payment retries and reminders have reached their configured limits.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    if (
      failureCategory ===
      FAILURE_CATEGORIES.INSUFFICIENT_FUNDS
    ) {
      return {
        action: ACTIONS.DELAYED_RETRY,
        reasonCode: 'INSUFFICIENT_FUNDS',
        reason:
          'Insufficient funds detected; use a delayed retry instead of an immediate retry.',
        bounded: true,
        requiresCustomerAction: false,
      };
    }

    if (
      failureCategory ===
      FAILURE_CATEGORIES.MANDATE_ERROR
    ) {
      return {
        action: ACTIONS.ALTERNATIVE_PAYMENT,
        reasonCode: 'MANDATE_ERROR',
        reason:
          'Subscription mandate failed; use an alternative payment method.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    return {
      action: ACTIONS.PAYMENT_RETRY,
      reasonCode: 'SUBSCRIPTION_PAYMENT_FAILURE',
      reason:
        'Subscription payment failed and another bounded retry is allowed.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /*
   * ----------------------------------------------------
   * NORMAL PAYMENT FAILURE
   * ----------------------------------------------------
   */

  if (caseType === 'PAYMENT_FAILURE') {
    /*
     * Once payment retry limit is reached, don't keep
     * retrying indefinitely.
     */

    if (
      retryAttemptCount >= maxPaymentRetries
    ) {
      if (reminderCount < maxReminders) {
        return {
          action: ACTIONS.REMINDER,
          reasonCode: 'PAYMENT_RETRY_LIMIT_REACHED',
          reason:
            'Payment retry limit reached; customer reminder is allowed.',
          bounded: true,
          requiresCustomerAction: true,
        };
      }

      return {
        action: ACTIONS.ESCALATE,
        reasonCode: 'RECOVERY_LIMIT_REACHED',
        reason:
          'Payment retries and reminders have reached their configured limits.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    switch (failureCategory) {
      case FAILURE_CATEGORIES.NETWORK_ERROR:
        return {
          action: ACTIONS.PAYMENT_RETRY,
          reasonCode: 'NETWORK_ERROR',
          reason:
            'Temporary network failure detected; retry payment.',
          bounded: true,
          requiresCustomerAction: false,
        };

      case FAILURE_CATEGORIES.PROCESSING_ERROR:
        return {
          action: ACTIONS.PAYMENT_RETRY,
          reasonCode: 'PROCESSING_ERROR',
          reason:
            'Temporary processing error detected; retry payment.',
          bounded: true,
          requiresCustomerAction: false,
        };

      case FAILURE_CATEGORIES.INSUFFICIENT_FUNDS:
        return {
          action: ACTIONS.DELAYED_RETRY,
          reasonCode: 'INSUFFICIENT_FUNDS',
          reason:
            'Insufficient funds detected; wait before retrying.',
          bounded: true,
          requiresCustomerAction: false,
        };

      case FAILURE_CATEGORIES.AUTHENTICATION_FAILED:
        return {
          action: ACTIONS.RECOVERY_LINK,
          reasonCode: 'AUTHENTICATION_FAILED',
          reason:
            'Payment authentication failed; customer action is required.',
          bounded: true,
          requiresCustomerAction: true,
        };

      case FAILURE_CATEGORIES.BANK_DECLINED:
        return {
          action: ACTIONS.ALTERNATIVE_PAYMENT,
          reasonCode: 'BANK_DECLINED',
          reason:
            'Bank declined the payment; offer an alternative payment method.',
          bounded: true,
          requiresCustomerAction: true,
        };

      case FAILURE_CATEGORIES.MANDATE_ERROR:
        return {
          action: ACTIONS.ALTERNATIVE_PAYMENT,
          reasonCode: 'MANDATE_ERROR',
          reason:
            'Mandate failed; offer an alternative payment method.',
          bounded: true,
          requiresCustomerAction: true,
        };

      default:
        return {
          action: ACTIONS.FOLLOW_UP,
          reasonCode: 'UNKNOWN_FAILURE',
          reason:
            'Failure reason is unknown; use controlled follow-up instead of an automatic retry.',
          bounded: true,
          requiresCustomerAction: true,
        };
    }
  }

  /*
   * ----------------------------------------------------
   * UNKNOWN CASE TYPE
   * ----------------------------------------------------
   */

  return {
    action: ACTIONS.FOLLOW_UP,
    reasonCode: 'UNKNOWN_CASE_TYPE',
    reason:
      'Recovery case type is not recognized; controlled follow-up is required.',
    bounded: true,
    requiresCustomerAction: true,
  };
}

module.exports = {
  ACTIONS,
  FAILURE_CATEGORIES,
  decideRecoveryAction,
  isRecoveryWindowExpired,
};