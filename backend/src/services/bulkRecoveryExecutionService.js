const RecoveryCase = require('../models/RecoveryCase');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');

const {
  getRecoveryPolicyConstraints,
} = require('./recoveryDecisionService');

const {
  ACTIONS,
} = require('./recoveryDecisionService');

const {
  executeRecoveryAction,
} = require('./recoveryExecutionService');

const MAX_CASES_PER_REQUEST =
  100;

/*
 * ============================================================
 * LOCAL BULK THROTTLE
 * ============================================================
 *
 * The Razorpay service also has a global request queue.
 *
 * This local delay provides an additional safety layer for
 * one Execute All request.
 */

const RAZORPAY_THROTTLE_MS =
  Math.max(
    3000,
    Number(
      process.env.RECOVERY_RAZORPAY_THROTTLE_MS ||
        5000,
    ) || 5000,
  );

const RAZORPAY_PAYMENT_LINK_ACTIONS =
  new Set([
    'RECOVERY_LINK',
    'ALTERNATIVE_PAYMENT',
    'REMINDER',
    'PAYMENT_RETRY',
    'DELAYED_RETRY',
  ]);

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        ms,
      );
    },
  );
}

async function waitForRazorpayThrottle(
  lastRazorpayRequestAt,
) {
  if (
    !lastRazorpayRequestAt ||
    RAZORPAY_THROTTLE_MS <= 0
  ) {
    return;
  }

  const elapsed =
    Date.now() -
    lastRazorpayRequestAt;

  const remaining =
    RAZORPAY_THROTTLE_MS -
    elapsed;

  if (remaining > 0) {
    await sleep(
      remaining,
    );
  }
}

/*
 * ============================================================
 * TERMINAL STATUSES
 * ============================================================
 */

const TERMINAL_STATUSES =
  new Set([
    'RECOVERED',
    'STOPPED',
    'ESCALATED',
    'CANCELLED',
  ]);

const WAITING_FOR_PAYMENT_STATUS =
  'ACTION_EXECUTED';

/*
 * ============================================================
 * NORMALIZE IDs
 * ============================================================
 */

function normalizeCaseIds(
  recoveryCaseIds,
) {
  if (
    !Array.isArray(
      recoveryCaseIds,
    )
  ) {
    throw new Error(
      'recoveryCaseIds must be an array.',
    );
  }

  const normalized = [];

  const seen =
    new Set();

  for (
    const id of recoveryCaseIds
  ) {
    if (!id) {
      continue;
    }

    const normalizedId =
      String(id).trim();

    if (!normalizedId) {
      continue;
    }

    if (
      seen.has(
        normalizedId,
      )
    ) {
      continue;
    }

    seen.add(
      normalizedId,
    );

    normalized.push(
      normalizedId,
    );
  }

  if (
    normalized.length >
    MAX_CASES_PER_REQUEST
  ) {
    throw new Error(
      `A maximum of ${MAX_CASES_PER_REQUEST} recovery cases can be executed in one request.`,
    );
  }

  return normalized;
}

/*
 * ============================================================
 * COMMUNICATION CONSENT
 * ============================================================
 */

function getCommunicationConsent(
  customer,
) {
  return {
    email: Boolean(
      customer?.communicationConsent
        ?.email,
    ),

    sms: Boolean(
      customer?.communicationConsent
        ?.sms,
    ),

    whatsapp: Boolean(
      customer?.communicationConsent
        ?.whatsapp,
    ),
  };
}

/*
 * ============================================================
 * POLICY INPUT
 * ============================================================
 */

function buildPolicyInput(
  recoveryCase,
  transaction,
  customer,
) {
  return {
    failureCategory:
      transaction?.failureCategory ||
      'UNKNOWN',

    caseType:
      recoveryCase.type,

    status:
      recoveryCase.status,

    retryAttemptCount:
      recoveryCase.retryAttemptCount ||
      0,

    reminderCount:
      recoveryCase.reminderCount ||
      0,

    eligibleAmountMinor:
      recoveryCase.eligibleAmountMinor ||
      0,

    recoveredAmountMinor:
      recoveryCase.recoveredAmountMinor ||
      0,

    recoveryWindowEndsAt:
      recoveryCase.recoveryWindowEndsAt,

    policySnapshot:
      recoveryCase.policySnapshot ||
      {},

    currentAction:
      recoveryCase.currentAction ||
      null,

    paymentMethod:
      transaction?.paymentMethod ||
      null,

    transactionType:
      transaction?.type ||
      null,

    communicationConsent:
      getCommunicationConsent(
        customer,
      ),

    now:
      new Date(),
  };
}

/*
 * ============================================================
 * RESULT HELPERS
 * ============================================================
 */

function buildSkippedResult({
  recoveryCase,
  reason,
  action = null,
}) {
  return {
    recoveryCaseId:
      String(
        recoveryCase?._id,
      ),

    status:
      'SKIPPED',

    action,

    finalAction:
      action,

    recovered: false,

    awaitingPaymentConfirmation:
      recoveryCase?.status ===
      WAITING_FOR_PAYMENT_STATUS,

    reason,
  };
}

function buildFailedResult({
  recoveryCase,
  error,
}) {
  return {
    recoveryCaseId:
      String(
        recoveryCase?._id,
      ),

    status:
      'FAILED',

    action: null,

    finalAction: null,

    recovered: false,

    awaitingPaymentConfirmation:
      false,

    reason:
      error?.message ||
      'Recovery action execution failed.',
  };
}

/*
 * ============================================================
 * BULK EXECUTION
 * ============================================================
 */

async function executeRecoveryCasesInBulk({
  merchantId,
  recoveryCaseIds,
}) {
  const normalizedIds =
    normalizeCaseIds(
      recoveryCaseIds,
    );

  if (
    normalizedIds.length ===
    0
  ) {
    return {
      requested: 0,
      processed: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      recovered: 0,
      awaitingPaymentConfirmation:
        0,
      results: [],
    };
  }

  /*
   * ----------------------------------------------------------
   * LOAD CASES
   * ----------------------------------------------------------
   */

  const recoveryCases =
    await RecoveryCase.find({
      merchantId,

      _id: {
        $in:
          normalizedIds,
      },
    });

  const recoveryCaseMap =
    new Map(
      recoveryCases.map(
        (recoveryCase) => [
          String(
            recoveryCase._id,
          ),
          recoveryCase,
        ],
      ),
    );

  const results = [];

  let executedCount = 0;

  let skippedCount = 0;

  let failedCount = 0;

  let recoveredCount = 0;

  let awaitingPaymentCount =
    0;

  let lastRazorpayRequestAt =
    0;

  /*
   * ----------------------------------------------------------
   * SEQUENTIAL EXECUTION
   * ----------------------------------------------------------
   *
   * IMPORTANT:
   *
   * Never use Promise.all here.
   *
   * One case completes before the next case starts.
   */

  for (
    const recoveryCaseId of
      normalizedIds
  ) {
    const recoveryCase =
      recoveryCaseMap.get(
        recoveryCaseId,
      );

    /*
     * --------------------------------------------------------
     * CASE NOT FOUND
     * --------------------------------------------------------
     */

    if (!recoveryCase) {
      results.push({
        recoveryCaseId,

        status:
          'SKIPPED',

        action: null,

        finalAction: null,

        recovered: false,

        awaitingPaymentConfirmation:
          false,

        reason:
          'Recovery case was not found for this merchant.',
      });

      skippedCount += 1;

      continue;
    }

    /*
     * --------------------------------------------------------
     * TERMINAL CASE
     * --------------------------------------------------------
     */

    if (
      TERMINAL_STATUSES.has(
        recoveryCase.status,
      )
    ) {
      results.push(
        buildSkippedResult({
          recoveryCase,

          reason:
            `Case is already in terminal status: ${recoveryCase.status}.`,
        }),
      );

      skippedCount += 1;

      continue;
    }

    /*
     * --------------------------------------------------------
     * PAYMENT ALREADY PENDING
     * --------------------------------------------------------
     */

    if (
      recoveryCase.status ===
      WAITING_FOR_PAYMENT_STATUS
    ) {
      results.push(
        buildSkippedResult({
          recoveryCase,

          reason:
            'Recovery action was already executed and is waiting for payment confirmation.',
        }),
      );

      skippedCount += 1;

      awaitingPaymentCount +=
        1;

      continue;
    }

    /*
     * --------------------------------------------------------
     * LOAD SAVED AI ACTION
     * --------------------------------------------------------
     */

    const savedFinalAction =
      recoveryCase
        ?.agentDecision
        ?.finalAction ||
      recoveryCase
        ?.agentDecision
        ?.action ||
      null;

    if (!savedFinalAction) {
      results.push(
        buildSkippedResult({
          recoveryCase,

          reason:
            'No persisted final recovery action is available. Run AI analysis first.',
        }),
      );

      skippedCount += 1;

      continue;
    }

    /*
     * --------------------------------------------------------
     * ACTION NAME VALIDATION
     * --------------------------------------------------------
     */

    if (
      !Object.values(
        ACTIONS,
      ).includes(
        savedFinalAction,
      )
    ) {
      results.push(
        buildSkippedResult({
          recoveryCase,

          action:
            savedFinalAction,

          reason:
            `Saved final action "${savedFinalAction}" is not a valid recovery action.`,
        }),
      );

      skippedCount += 1;

      continue;
    }

    try {
      /*
       * ------------------------------------------------------
       * LOAD SOURCE TRANSACTION + CUSTOMER
       * ------------------------------------------------------
       */

      const [
        transaction,
        customer,
      ] =
        await Promise.all([
          Transaction.findOne({
            _id:
              recoveryCase.sourceTransactionId,

            merchantId,
          })
            .select(
              [
                '_id',
                'type',
                'status',
                'amountMinor',
                'currency',
                'paymentMethod',
                'failureCategory',
                'failureCode',
                'failureReason',
                'failureStage',
                'occurredAt',
              ].join(' '),
            )
            .lean(),

          Customer.findOne({
            _id:
              recoveryCase.customerId,

            merchantId,
          })
            .select(
              [
                '_id',
                'communicationConsent',
                'paymentHistory',
              ].join(' '),
            )
            .lean(),
        ]);

      /*
       * ------------------------------------------------------
       * TRANSACTION REQUIRED
       * ------------------------------------------------------
       */

      if (!transaction) {
        results.push(
          buildSkippedResult({
            recoveryCase,

            action:
              savedFinalAction,

            reason:
              'Source transaction was not found. Execution skipped for safety.',
          }),
        );

        skippedCount += 1;

        continue;
      }

      /*
       * ------------------------------------------------------
       * CURRENT POLICY
       * ------------------------------------------------------
       */

      const policy =
        getRecoveryPolicyConstraints(
          buildPolicyInput(
            recoveryCase,
            transaction,
            customer,
          ),
        );

      /*
       * ------------------------------------------------------
       * HARD POLICY BLOCK
       * ------------------------------------------------------
       */

      if (
        policy.blocked
      ) {
        results.push(
          buildSkippedResult({
            recoveryCase,

            action:
              savedFinalAction,

            reason:
              policy.message ||
              'Current policy blocks execution of this recovery case.',
          }),
        );

        skippedCount += 1;

        continue;
      }

      /*
       * ------------------------------------------------------
       * EXACT ACTION MUST REMAIN ALLOWED
       * ------------------------------------------------------
       */

      if (
        !policy.allowedActions.includes(
          savedFinalAction,
        )
      ) {
        results.push(
          buildSkippedResult({
            recoveryCase,

            action:
              savedFinalAction,

            reason:
              `Current policy no longer allows "${savedFinalAction}". Re-run AI analysis before executing.`,
          }),
        );

        skippedCount += 1;

        continue;
      }

      /*
       * ------------------------------------------------------
       * RAZORPAY LOCAL THROTTLE
       * ------------------------------------------------------
       */

      if (
        RAZORPAY_PAYMENT_LINK_ACTIONS.has(
          savedFinalAction,
        )
      ) {
        await waitForRazorpayThrottle(
          lastRazorpayRequestAt,
        );
      }

      /*
       * ------------------------------------------------------
       * EXECUTE EXACTLY ONE ACTION
       * ------------------------------------------------------
       */

      const execution =
        await executeRecoveryAction({
          recoveryCaseId:
            recoveryCase._id,

          action:
            savedFinalAction,

          reason:
            'Bulk execution initiated from Execute All.',
        });

      /*
       * The execution service internally serializes
       * all Razorpay requests globally.
       */
      if (
        RAZORPAY_PAYMENT_LINK_ACTIONS.has(
          savedFinalAction,
        )
      ) {
        lastRazorpayRequestAt =
          Date.now();
      }

      const isRecovered =
        Boolean(
          execution?.recovered,
        );

      const awaitingPaymentConfirmation =
        Boolean(
          execution
            ?.awaitingPaymentConfirmation,
        );

      if (isRecovered) {
        recoveredCount += 1;
      }

      if (
        awaitingPaymentConfirmation ||
        execution?.status ===
          WAITING_FOR_PAYMENT_STATUS
      ) {
        awaitingPaymentCount +=
          1;
      }

      if (
        execution?.executed !==
        false
      ) {
        executedCount += 1;
      }

      results.push({
        recoveryCaseId:
          String(
            recoveryCase._id,
          ),

        status:
          execution?.status ||
          'ACTION_EXECUTED',

        action:
          savedFinalAction,

        finalAction:
          savedFinalAction,

        recovered:
          isRecovered,

        awaitingPaymentConfirmation,

        reason:
          execution?.message ||
          'Recovery action processed successfully.',

        paymentLink:
          execution?.paymentLink ||
          null,

        execution:
          execution ||
          null,
      });
    } catch (error) {
      failedCount += 1;

      results.push(
        buildFailedResult({
          recoveryCase,

          error,
        }),
      );
    }
  }

  /*
   * ----------------------------------------------------------
   * FINAL RESULT
   * ----------------------------------------------------------
   */

  return {
    requested:
      normalizedIds.length,

    processed:
      results.length,

    executed:
      executedCount,

    skipped:
      skippedCount,

    failed:
      failedCount,

    recovered:
      recoveredCount,

    awaitingPaymentConfirmation:
      awaitingPaymentCount,

    results,
  };
}

module.exports = {
  executeRecoveryCasesInBulk,
  normalizeCaseIds,
};