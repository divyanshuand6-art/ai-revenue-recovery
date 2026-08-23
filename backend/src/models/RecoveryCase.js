const mongoose = require('mongoose');

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

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

const recoveryCaseSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      immutable: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    sourceTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
      immutable: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['PAYMENT_FAILURE', 'CHECKOUT_ABANDONMENT', 'SUBSCRIPTION_PAYMENT_FAILURE'],
    },
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
    amountAtRiskMinor: {
      type: Number,
      required: true,
      validate: {
        validator: (value) => Number.isSafeInteger(value) && value > 0,
        message: 'amountAtRiskMinor must be a positive safe integer in the smallest currency unit.',
      },
    },
    eligibleAmountMinor: {
      type: Number,
      default: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'eligibleAmountMinor must be a non-negative safe integer.',
      },
    },
    recoveredAmountMinor: {
      type: Number,
      default: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'recoveredAmountMinor must be a non-negative safe integer.',
      },
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      default: 'INR',
    },
    retryAttemptCount: {
      type: Number,
      default: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'retryAttemptCount must be a non-negative safe integer.',
      },
    },
    reminderCount: {
      type: Number,
      default: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'reminderCount must be a non-negative safe integer.',
      },
    },
    currentAction: {
      type: String,
      enum: recoveryActions,
    },
    nextActionAt: { type: Date },
    recoveryWindowEndsAt: {
      type: Date,
      required: true,
    },
    policySnapshot: {
      maxPaymentRetries: {
        type: Number,
        min: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'maxPaymentRetries must be a non-negative safe integer.',
        },
      },
      maxReminders: {
        type: Number,
        min: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'maxReminders must be a non-negative safe integer.',
        },
      },
      recoveryWindowHours: {
        type: Number,
        min: 1,
        validate: {
          validator: (value) => value === undefined || (Number.isSafeInteger(value) && value > 0),
          message: 'recoveryWindowHours must be a positive safe integer.',
        },
      },
    },
    agentDecision: {
      action: { type: String, enum: recoveryActions },
      confidence: { type: Number, min: 0, max: 1 },
      reasonCode: { type: String, trim: true, maxlength: 100 },
      rationale: { type: String, trim: true, maxlength: 1000 },
      customerMessage: { type: String, trim: true, maxlength: 1000 },
      nextActionAt: { type: Date },
      stopCondition: { type: String, trim: true, maxlength: 100 },
      analyzedAt: { type: Date },
    },
    recoveryTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    recoveredAt: { type: Date },
    stopReason: { type: String, trim: true, maxlength: 500 },
    escalationReason: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    strict: 'throw',
  },
);

recoveryCaseSchema.pre('validate', function validateRecoveryAmounts(next) {
  if (this.eligibleAmountMinor > this.amountAtRiskMinor) {
    this.invalidate('eligibleAmountMinor', 'eligibleAmountMinor cannot exceed amountAtRiskMinor.');
  }

  if (this.recoveredAmountMinor > this.amountAtRiskMinor) {
    this.invalidate('recoveredAmountMinor', 'recoveredAmountMinor cannot exceed amountAtRiskMinor.');
  }

  next();
});

recoveryCaseSchema.index(
  { merchantId: 1, sourceTransactionId: 1 },
  {
    unique: true,
  },
);
recoveryCaseSchema.index({ merchantId: 1, status: 1, nextActionAt: 1 });
recoveryCaseSchema.index({ merchantId: 1, createdAt: -1 });

module.exports = mongoose.model('RecoveryCase', recoveryCaseSchema);
