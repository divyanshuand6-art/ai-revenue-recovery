const mongoose = require('mongoose');

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function isNonNegativeSafeInteger(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/*
 * =========================================================
 * RECOVERY ACTIONS
 * =========================================================
 */

const recoveryActions = [
  'PAYMENT_RETRY',
  'DELAYED_RETRY',
  'ALTERNATIVE_PAYMENT',
  'RECOVERY_LINK',
  'REMINDER',
  'FOLLOW_UP',
  'ESCALATE',
  'STOP',
];

/*
 * =========================================================
 * RECOVERY CASE SCHEMA
 * =========================================================
 */

const recoveryCaseSchema =
  new mongoose.Schema(
    {
      /*
       * ---------------------------------------------------
       * MERCHANT
       * ---------------------------------------------------
       */

      merchantId: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: 'User',

        required: true,

        index: true,

        immutable: true,
      },

      /*
       * ---------------------------------------------------
       * CUSTOMER
       * ---------------------------------------------------
       */

      customerId: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: 'Customer',

        required: true,

        index: true,
      },

      /*
       * ---------------------------------------------------
       * ORIGINAL REVENUE-LOSS TRANSACTION
       * ---------------------------------------------------
       */

      sourceTransactionId: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: 'Transaction',

        required: true,

        immutable: true,
      },

      /*
       * ---------------------------------------------------
       * SUBSCRIPTION
       * ---------------------------------------------------
       */

      subscriptionId: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: 'Subscription',

        index: true,
      },

      /*
       * ---------------------------------------------------
       * CASE TYPE
       * ---------------------------------------------------
       */

      type: {
        type: String,

        required: true,

        enum: [
          'PAYMENT_FAILURE',
          'CHECKOUT_ABANDONMENT',
          'SUBSCRIPTION_PAYMENT_FAILURE',
        ],
      },

      /*
       * ---------------------------------------------------
       * CASE STATUS
       * ---------------------------------------------------
       */

      status: {
        type: String,

        required: true,

        enum: [
          'DETECTED',
          'ANALYZING',
          'RECOVERY_PENDING',
          'ACTION_SCHEDULED',
          'ACTION_EXECUTED',
          'CUSTOMER_RESPONDED',
          'RECOVERED',
          'FAILED',
          'ESCALATED',
          'EXPIRED',
          'STOPPED',
        ],

        default: 'DETECTED',
      },

      /*
       * ---------------------------------------------------
       * MONEY AT RISK
       * ---------------------------------------------------
       */

      amountAtRiskMinor: {
        type: Number,

        required: true,

        validate: {
          validator: (value) =>
            Number.isSafeInteger(value) &&
            value > 0,

          message:
            'amountAtRiskMinor must be a positive safe integer in the smallest currency unit.',
        },
      },

      /*
       * ---------------------------------------------------
       * ELIGIBLE MONEY
       * ---------------------------------------------------
       */

      eligibleAmountMinor: {
        type: Number,

        default: 0,

        validate: {
          validator:
            isNonNegativeSafeInteger,

          message:
            'eligibleAmountMinor must be a non-negative safe integer.',
        },
      },

      /*
       * ---------------------------------------------------
       * RECOVERED MONEY
       * ---------------------------------------------------
       */

      recoveredAmountMinor: {
        type: Number,

        default: 0,

        validate: {
          validator:
            isNonNegativeSafeInteger,

          message:
            'recoveredAmountMinor must be a non-negative safe integer.',
        },
      },

      /*
       * ---------------------------------------------------
       * CURRENCY
       * ---------------------------------------------------
       */

      currency: {
        type: String,

        required: true,

        trim: true,

        uppercase: true,

        minlength: 3,

        maxlength: 3,

        default: 'INR',
      },

      /*
       * ---------------------------------------------------
       * RETRY / REMINDER COUNTERS
       * ---------------------------------------------------
       */

      retryAttemptCount: {
        type: Number,

        default: 0,

        validate: {
          validator:
            isNonNegativeSafeInteger,

          message:
            'retryAttemptCount must be a non-negative safe integer.',
        },
      },

      reminderCount: {
        type: Number,

        default: 0,

        validate: {
          validator:
            isNonNegativeSafeInteger,

          message:
            'reminderCount must be a non-negative safe integer.',
        },
      },

      /*
       * ---------------------------------------------------
       * CURRENT ACTION
       * ---------------------------------------------------
       *
       * This represents the CURRENT state/action of the
       * recovery workflow.
       *
       * A fully recovered case may intentionally have:
       *
       * currentAction = STOP
       *
       * because there is no further recovery action.
       */

      currentAction: {
        type: String,

        enum: recoveryActions,
      },

      /*
       * ---------------------------------------------------
       * ACTUAL ACTION TAKEN
       * ---------------------------------------------------
       *
       * IMPORTANT:
       *
       * currentAction != actionTaken
       *
       * Example:
       *
       * Payment Retry
       *      ↓
       * Payment successful
       *      ↓
       * Case RECOVERED
       *      ↓
       * currentAction = STOP
       *
       * The action that actually recovered the money
       * remains:
       *
       * actionTaken = PAYMENT_RETRY
       *
       * Dashboard intervention analytics uses this field.
       */

      actionTaken: {
        type: String,

        enum: recoveryActions,

        index: true,
      },

      /*
       * ---------------------------------------------------
       * NEXT ACTION
       * ---------------------------------------------------
       */

      nextActionAt: {
        type: Date,
      },

      /*
       * ---------------------------------------------------
       * RECOVERY WINDOW
       * ---------------------------------------------------
       */

      recoveryWindowEndsAt: {
        type: Date,

        required: true,
      },

      /*
       * ---------------------------------------------------
       * POLICY SNAPSHOT
       * ---------------------------------------------------
       */

      policySnapshot: {
        maxPaymentRetries: {
          type: Number,

          min: 0,

          validate: {
            validator:
              isNonNegativeSafeInteger,

            message:
              'maxPaymentRetries must be a non-negative safe integer.',
          },
        },

        maxReminders: {
          type: Number,

          min: 0,

          validate: {
            validator:
              isNonNegativeSafeInteger,

            message:
              'maxReminders must be a non-negative safe integer.',
          },
        },

        recoveryWindowHours: {
          type: Number,

          min: 1,

          validate: {
            validator: (value) =>
              value === undefined ||
              (
                Number.isSafeInteger(
                  value,
                ) &&
                value > 0
              ),

            message:
              'recoveryWindowHours must be a positive safe integer.',
          },
        },
      },

      /*
       * ---------------------------------------------------
       * AI DECISION
       * ---------------------------------------------------
       */

      agentDecision: {
        action: {
          type: String,

          enum: recoveryActions,
        },

        confidence: {
          type: Number,

          min: 0,

          max: 1,
        },

        reasonCode: {
          type: String,

          trim: true,

          maxlength: 100,
        },

        rationale: {
          type: String,

          trim: true,

          maxlength: 1000,
        },

        customerMessage: {
          type: String,

          trim: true,

          maxlength: 1000,
        },

        nextActionAt: {
          type: Date,
        },

        stopCondition: {
          type: String,

          trim: true,

          maxlength: 100,
        },

        analyzedAt: {
          type: Date,
        },
      },

      /*
       * ---------------------------------------------------
       * SUCCESSFUL RECOVERY TRANSACTION
       * ---------------------------------------------------
       */

      recoveryTransactionId: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: 'Transaction',
      },

      /*
       * ---------------------------------------------------
       * RECOVERY COMPLETION TIME
       * ---------------------------------------------------
       *
       * This is the timestamp used for recovery-date
       * analytics.
       */

      recoveredAt: {
        type: Date,
      },

      /*
       * ---------------------------------------------------
       * STOP / ESCALATION REASONS
       * ---------------------------------------------------
       */

      stopReason: {
        type: String,

        trim: true,

        maxlength: 500,
      },

      escalationReason: {
        type: String,

        trim: true,

        maxlength: 500,
      },
    },

    {
      timestamps: true,

      /*
       * Reject unknown fields.
       *
       * actionTaken is explicitly defined above so it
       * remains compatible with strict mode.
       */

      strict: 'throw',
    },
  );

/*
 * =========================================================
 * VALIDATE MONEY RELATIONSHIPS
 * =========================================================
 */

recoveryCaseSchema.pre(
  'validate',
  function validateRecoveryAmounts(
    next,
  ) {
    if (
      this.eligibleAmountMinor >
      this.amountAtRiskMinor
    ) {
      this.invalidate(
        'eligibleAmountMinor',

        'eligibleAmountMinor cannot exceed amountAtRiskMinor.',
      );
    }

    if (
      this.recoveredAmountMinor >
      this.amountAtRiskMinor
    ) {
      this.invalidate(
        'recoveredAmountMinor',

        'recoveredAmountMinor cannot exceed amountAtRiskMinor.',
      );
    }

    if (
      this.recoveredAmountMinor >
      this.eligibleAmountMinor
    ) {
      this.invalidate(
        'recoveredAmountMinor',

        'recoveredAmountMinor cannot exceed eligibleAmountMinor.',
      );
    }

    /*
     * A recovered case must have a recovery timestamp.
     */

    if (
      this.status ===
        'RECOVERED' &&
      !this.recoveredAt
    ) {
      this.invalidate(
        'recoveredAt',

        'recoveredAt is required when status is RECOVERED.',
      );
    }

    next();
  },
);

/*
 * =========================================================
 * INDEXES
 * =========================================================
 */

recoveryCaseSchema.index(
  {
    merchantId: 1,
    sourceTransactionId: 1,
  },
  {
    unique: true,
  },
);

recoveryCaseSchema.index({
  merchantId: 1,
  status: 1,
  nextActionAt: 1,
});

recoveryCaseSchema.index({
  merchantId: 1,
  createdAt: -1,
});

recoveryCaseSchema.index({
  merchantId: 1,
  recoveredAt: -1,
});

recoveryCaseSchema.index({
  merchantId: 1,
  actionTaken: 1,
});

/*
 * =========================================================
 * EXPORT
 * =========================================================
 */

module.exports =
  mongoose.model(
    'RecoveryCase',
    recoveryCaseSchema,
  );