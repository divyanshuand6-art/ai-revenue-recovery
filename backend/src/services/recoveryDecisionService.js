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

const CUSTOMER_OUTREACH_ACTIONS = Object.freeze([
  ACTIONS.RECOVERY_LINK,
  ACTIONS.ALTERNATIVE_PAYMENT,
  ACTIONS.REMINDER,
  ACTIONS.FOLLOW_UP,
]);

/**
 * ----------------------------------------------------
 * CHECK WHETHER RECOVERY WINDOW HAS EXPIRED
 * ----------------------------------------------------
 */
function isRecoveryWindowExpired(
  recoveryWindowEndsAt,
  now = new Date(),
) {
  if (!recoveryWindowEndsAt) {
    return true;
  }

  const windowEnd = new Date(recoveryWindowEndsAt);

  if (Number.isNaN(windowEnd.getTime())) {
    return true;
  }

  return now >= windowEnd;
}

/**
 * ----------------------------------------------------
 * GET SAFE POLICY VALUE
 * ----------------------------------------------------
 *
 * Only non-negative safe integers are accepted.
 * Otherwise the configured fallback is used.
 */
function getPolicyValue(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

/**
 * ----------------------------------------------------
 * DECIDE RECOVERY ACTION
 * ----------------------------------------------------
 *
 * This is the deterministic policy layer.
 *
 * IMPORTANT:
 * AI does NOT decide whether an action is allowed.
 * AI recommendations are checked against this policy.
 */
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

  /**
   * --------------------------------------------------
   * SAFETY CHECK 1
   * --------------------------------------------------
   *
   * Terminal cases must never be processed again.
   */
  if (TERMINAL_STATUSES.includes(status)) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'TERMINAL_CASE',
      reason:
        `Recovery case is already in terminal status: ${status}.`,
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * SAFETY CHECK 2
   * --------------------------------------------------
   *
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

  /**
   * --------------------------------------------------
   * SAFETY CHECK 3
   * --------------------------------------------------
   *
   * Nothing is eligible for recovery.
   */
  if (
    !Number.isFinite(eligibleAmountMinor) ||
    eligibleAmountMinor <= 0
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'NO_ELIGIBLE_AMOUNT',
      reason:
        'No eligible amount remains for recovery.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * SAFETY CHECK 4
   * --------------------------------------------------
   *
   * Full eligible amount has already been recovered.
   */
  if (
    Number.isFinite(recoveredAmountMinor) &&
    recoveredAmountMinor >= eligibleAmountMinor
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'ALREADY_RECOVERED',
      reason:
        'Eligible amount has already been recovered.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * SAFETY CHECK 5
   * --------------------------------------------------
   *
   * Prevent duplicate execution of an already
   * scheduled action.
   */
  if (
    status === 'ACTION_SCHEDULED' &&
    currentAction
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode: 'ACTION_ALREADY_SCHEDULED',
      reason:
        `Action ${currentAction} is already scheduled.`,
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * SAFETY CHECK 6
   * --------------------------------------------------
   *
   * Prevent another action while the previous
   * action is awaiting payment confirmation.
   */
  if (
    status === 'ACTION_EXECUTED' &&
    currentAction
  ) {
    return {
      action: ACTIONS.STOP,
      reasonCode:
        'ACTION_AWAITING_PAYMENT_CONFIRMATION',
      reason:
        `Action ${currentAction} is awaiting payment confirmation.`,
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * CHECKOUT ABANDONMENT
   * --------------------------------------------------
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

  /**
   * --------------------------------------------------
   * SUBSCRIPTION PAYMENT FAILURE
   * --------------------------------------------------
   */
  if (
    caseType === 'SUBSCRIPTION_PAYMENT_FAILURE'
  ) {
    /**
     * Retry limit reached.
     */
    if (
      retryAttemptCount >= maxPaymentRetries
    ) {
      /**
       * Retry limit reached but reminders
       * are still available.
       */
      if (reminderCount < maxReminders) {
        return {
          action: ACTIONS.REMINDER,
          reasonCode:
            'PAYMENT_RETRY_LIMIT_REACHED',
          reason:
            'Payment retry limit reached; send a controlled reminder.',
          bounded: true,
          requiresCustomerAction: true,
        };
      }

      /**
       * Both retry and reminder limits reached.
       */
      return {
        action: ACTIONS.ESCALATE,
        reasonCode: 'RECOVERY_LIMIT_REACHED',
        reason:
          'Payment retries and reminders have reached their configured limits.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    /**
     * Insufficient funds should not trigger
     * an immediate retry.
     */
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

    /**
     * Subscription mandate failure.
     */
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

    /**
     * Default subscription payment retry.
     */
    return {
      action: ACTIONS.PAYMENT_RETRY,
      reasonCode:
        'SUBSCRIPTION_PAYMENT_FAILURE',
      reason:
        'Subscription payment failed and another bounded retry is allowed.',
      bounded: true,
      requiresCustomerAction: false,
    };
  }

  /**
   * --------------------------------------------------
   * NORMAL PAYMENT FAILURE
   * --------------------------------------------------
   */
  if (caseType === 'PAYMENT_FAILURE') {
    /**
     * Retry limit reached.
     */
    if (
      retryAttemptCount >= maxPaymentRetries
    ) {
      /**
       * Reminder is still available.
       */
      if (reminderCount < maxReminders) {
        return {
          action: ACTIONS.REMINDER,
          reasonCode:
            'PAYMENT_RETRY_LIMIT_REACHED',
          reason:
            'Payment retry limit reached; customer reminder is allowed.',
          bounded: true,
          requiresCustomerAction: true,
        };
      }

      /**
       * No retries or reminders remain.
       */
      return {
        action: ACTIONS.ESCALATE,
        reasonCode: 'RECOVERY_LIMIT_REACHED',
        reason:
          'Payment retries and reminders have reached their configured limits.',
        bounded: true,
        requiresCustomerAction: true,
      };
    }

    /**
     * Failure-specific recovery strategy.
     */
    switch (failureCategory) {
      /**
       * Temporary network failure.
       */
      case FAILURE_CATEGORIES.NETWORK_ERROR:
        return {
          action: ACTIONS.PAYMENT_RETRY,
          reasonCode: 'NETWORK_ERROR',
          reason:
            'Temporary network failure detected; retry payment.',
          bounded: true,
          requiresCustomerAction: false,
        };

      /**
       * Temporary payment processing failure.
       */
      case FAILURE_CATEGORIES.PROCESSING_ERROR:
        return {
          action: ACTIONS.PAYMENT_RETRY,
          reasonCode: 'PROCESSING_ERROR',
          reason:
            'Temporary processing error detected; retry payment.',
          bounded: true,
          requiresCustomerAction: false,
        };

      /**
       * Insufficient funds.
       */
      case FAILURE_CATEGORIES.INSUFFICIENT_FUNDS:
        return {
          action: ACTIONS.DELAYED_RETRY,
          reasonCode: 'INSUFFICIENT_FUNDS',
          reason:
            'Insufficient funds detected; wait before retrying.',
          bounded: true,
          requiresCustomerAction: false,
        };

      /**
       * Authentication requires customer action.
       */
      case FAILURE_CATEGORIES.AUTHENTICATION_FAILED:
        return {
          action: ACTIONS.RECOVERY_LINK,
          reasonCode: 'AUTHENTICATION_FAILED',
          reason:
            'Payment authentication failed; customer action is required.',
          bounded: true,
          requiresCustomerAction: true,
        };

      /**
       * Bank declined the payment.
       */
      case FAILURE_CATEGORIES.BANK_DECLINED:
        return {
          action: ACTIONS.ALTERNATIVE_PAYMENT,
          reasonCode: 'BANK_DECLINED',
          reason:
            'Bank declined the payment; offer an alternative payment method.',
          bounded: true,
          requiresCustomerAction: true,
        };

      /**
       * Mandate failure.
       */
      case FAILURE_CATEGORIES.MANDATE_ERROR:
        return {
          action: ACTIONS.ALTERNATIVE_PAYMENT,
          reasonCode: 'MANDATE_ERROR',
          reason:
            'Mandate failed; offer an alternative payment method.',
          bounded: true,
          requiresCustomerAction: true,
        };

      /**
       * Unknown failure.
       *
       * Do not automatically retry an unknown
       * failure.
       */
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

  /**
   * --------------------------------------------------
   * UNKNOWN CASE TYPE
   * --------------------------------------------------
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

/**
 * ----------------------------------------------------
 * COMMUNICATION CONSENT
 * ----------------------------------------------------
 *
 * Customer-facing actions require at least one
 * permitted communication channel.
 */
function hasCommunicationConsent(
  communicationConsent = {},
) {
  return Boolean(
    communicationConsent.email ||
    communicationConsent.sms ||
    communicationConsent.whatsapp,
  );
}

/**
 * ----------------------------------------------------
 * GET RECOVERY POLICY CONSTRAINTS
 * ----------------------------------------------------
 *
 * This function converts the deterministic policy
 * decision into executable constraints for the AI
 * recommendation validator.
 */
function getRecoveryPolicyConstraints({
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
  communicationConsent = {},
  now = new Date(),
}) {
  const policyDecision =
    decideRecoveryAction({
      failureCategory,
      caseType,
      status,
      retryAttemptCount,
      reminderCount,
      eligibleAmountMinor,
      recoveredAmountMinor,
      recoveryWindowEndsAt,
      policySnapshot,
      currentAction,
      now,
    });

  /**
   * These conditions completely block execution.
   */
  const blockedReasonCodes = new Set([
    'TERMINAL_CASE',
    'RECOVERY_WINDOW_EXPIRED',
    'NO_ELIGIBLE_AMOUNT',
    'ALREADY_RECOVERED',
    'ACTION_ALREADY_SCHEDULED',
    'ACTION_AWAITING_PAYMENT_CONFIRMATION',
  ]);

  /**
   * These conditions force a specific action.
   */
  const forcedActionReasonCodes = new Set([
    'REMINDER_LIMIT_REACHED',
    'RECOVERY_LIMIT_REACHED',
  ]);

  /**
   * Completely blocked case.
   */
  if (
    blockedReasonCodes.has(
      policyDecision.reasonCode,
    )
  ) {
    return {
      blocked: true,
      reasonCode:
        policyDecision.reasonCode,
      message:
        policyDecision.reason,
      allowedActions: [],
      fallbackAction: null,
      policyDecision,
    };
  }

  /**
   * Policy requires a specific action.
   */
  if (
    forcedActionReasonCodes.has(
      policyDecision.reasonCode,
    )
  ) {
    return {
      blocked: false,
      reasonCode:
        policyDecision.reasonCode,
      message:
        policyDecision.reason,
      allowedActions: [
        policyDecision.action,
      ],
      fallbackAction:
        policyDecision.action,
      policyDecision,
    };
  }

  const maxPaymentRetries = getPolicyValue(
    policySnapshot.maxPaymentRetries,
    3,
  );

  const maxReminders = getPolicyValue(
    policySnapshot.maxReminders,
    2,
  );

  /**
   * STOP and ESCALATE are always available for
   * non-blocked recovery cases.
   */
  const allowedActions = new Set([
    ACTIONS.STOP,
    ACTIONS.ESCALATE,
  ]);

  /**
   * --------------------------------------------------
   * CHECKOUT ABANDONMENT ACTIONS
   * --------------------------------------------------
   */
  if (
    caseType === 'CHECKOUT_ABANDONMENT'
  ) {
    allowedActions.add(
      ACTIONS.RECOVERY_LINK,
    );

    allowedActions.add(
      ACTIONS.REMINDER,
    );

    allowedActions.add(
      ACTIONS.FOLLOW_UP,
    );
  }

  /**
   * --------------------------------------------------
   * PAYMENT FAILURE ACTIONS
   * --------------------------------------------------
   */
  else if (
    caseType === 'PAYMENT_FAILURE' ||
    caseType ===
      'SUBSCRIPTION_PAYMENT_FAILURE'
  ) {
    /**
     * Temporary technical errors.
     */
    if (
      failureCategory ===
        FAILURE_CATEGORIES.NETWORK_ERROR ||
      failureCategory ===
        FAILURE_CATEGORIES.PROCESSING_ERROR
    ) {
      allowedActions.add(
        ACTIONS.PAYMENT_RETRY,
      );

      allowedActions.add(
        ACTIONS.DELAYED_RETRY,
      );

      allowedActions.add(
        ACTIONS.RECOVERY_LINK,
      );

      allowedActions.add(
        ACTIONS.FOLLOW_UP,
      );
    }

    /**
     * Insufficient funds.
     */
    else if (
      failureCategory ===
      FAILURE_CATEGORIES.INSUFFICIENT_FUNDS
    ) {
      allowedActions.add(
        ACTIONS.DELAYED_RETRY,
      );

      allowedActions.add(
        ACTIONS.RECOVERY_LINK,
      );

      allowedActions.add(
        ACTIONS.REMINDER,
      );

      allowedActions.add(
        ACTIONS.FOLLOW_UP,
      );

      allowedActions.add(
        ACTIONS.ALTERNATIVE_PAYMENT,
      );
    }

    /**
     * Authentication, bank decline and mandate
     * failures require customer-facing recovery.
     */
    else if (
      failureCategory ===
        FAILURE_CATEGORIES.AUTHENTICATION_FAILED ||
      failureCategory ===
        FAILURE_CATEGORIES.BANK_DECLINED ||
      failureCategory ===
        FAILURE_CATEGORIES.MANDATE_ERROR
    ) {
      allowedActions.add(
        ACTIONS.RECOVERY_LINK,
      );

      allowedActions.add(
        ACTIONS.ALTERNATIVE_PAYMENT,
      );

      allowedActions.add(
        ACTIONS.REMINDER,
      );

      allowedActions.add(
        ACTIONS.FOLLOW_UP,
      );
    }

    /**
     * Unknown failure.
     */
    else {
      allowedActions.add(
        ACTIONS.RECOVERY_LINK,
      );

      allowedActions.add(
        ACTIONS.REMINDER,
      );

      allowedActions.add(
        ACTIONS.FOLLOW_UP,
      );
    }
  }

  /**
   * --------------------------------------------------
   * UNKNOWN CASE TYPE
   * --------------------------------------------------
   */
  else {
    allowedActions.add(
      ACTIONS.FOLLOW_UP,
    );
  }

  /**
   * --------------------------------------------------
   * RETRY LIMIT
   * --------------------------------------------------
   *
   * Once the retry limit has been reached,
   * neither immediate nor delayed retry is allowed.
   */
  if (
    retryAttemptCount >= maxPaymentRetries
  ) {
    allowedActions.delete(
      ACTIONS.PAYMENT_RETRY,
    );

    allowedActions.delete(
      ACTIONS.DELAYED_RETRY,
    );
  }

  /**
   * --------------------------------------------------
   * REMINDER LIMIT
   * --------------------------------------------------
   *
   * All customer-outreach actions represented by
   * CUSTOMER_OUTREACH_ACTIONS are removed once the
   * reminder limit has been reached.
   */
  if (
    reminderCount >= maxReminders
  ) {
    for (
      const action of CUSTOMER_OUTREACH_ACTIONS
    ) {
      allowedActions.delete(action);
    }
  }

  /**
   * --------------------------------------------------
   * COMMUNICATION CONSENT
   * --------------------------------------------------
   *
   * Never perform customer-facing outreach when
   * there is no communication consent.
   */
  if (
    !hasCommunicationConsent(
      communicationConsent,
    )
  ) {
    for (
      const action of CUSTOMER_OUTREACH_ACTIONS
    ) {
      allowedActions.delete(action);
    }
  }

  /**
   * --------------------------------------------------
   * DETERMINE FALLBACK
   * --------------------------------------------------
   */
  const defaultActionIsAllowed =
    allowedActions.has(
      policyDecision.action,
    );

  const fallbackAction =
    defaultActionIsAllowed
      ? policyDecision.action
      : allowedActions.has(
          ACTIONS.ESCALATE,
        )
        ? ACTIONS.ESCALATE
        : ACTIONS.STOP;

  return {
    blocked: false,
    reasonCode:
      policyDecision.reasonCode,
    message:
      policyDecision.reason,
    allowedActions:
      Array.from(allowedActions),
    fallbackAction,
    policyDecision,
  };
}

/**
 * ----------------------------------------------------
 * EXPORTS
 * ----------------------------------------------------
 */
module.exports = {
  ACTIONS,
  FAILURE_CATEGORIES,
  decideRecoveryAction,
  getRecoveryPolicyConstraints,
  isRecoveryWindowExpired,
};