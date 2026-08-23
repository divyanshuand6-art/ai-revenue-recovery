const mongoose = require('mongoose');

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

const auditLogSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      immutable: true,
    },

    recoveryCaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryCase',
      required: true,
      index: true,
      immutable: true,
    },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      immutable: true,
    },

    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      immutable: true,
    },

    actorType: {
      type: String,
      required: true,
      enum: [
        'SYSTEM',
        'AI_AGENT',
        'POLICY_ENGINE',
        'RECOVERY_ENGINE',
        'RAZORPAY',
        'MERCHANT',
      ],
      immutable: true,
    },

    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      immutable: true,
    },

    eventType: {
      type: String,
      required: true,
      enum: [
        'RECOVERY_CASE_CREATED',
        'PAYMENT_FAILURE_DETECTED',
        'CHECKOUT_ABANDONED_DETECTED',
        'SUBSCRIPTION_PAYMENT_FAILED',
        'AI_ANALYSIS_COMPLETED',
        'RECOVERY_ACTION_SELECTED',
        'POLICY_VALIDATED',
        'POLICY_REJECTED',
        'RECOVERY_ACTION_EXECUTED',
        'PAYMENT_SUCCEEDED',
        'PAYMENT_FAILED',
        'RECOVERY_COMPLETED',
        'RECOVERY_STOPPED',
        'RECOVERY_ESCALATED',
      ],
      immutable: true,
    },

    action: {
      type: String,
      enum: recoveryActions,
      immutable: true,
    },

    result: {
      type: String,
      required: true,
      enum: [
        'SUCCEEDED',
        'FAILED',
        'PENDING',
        'SKIPPED',
        'REJECTED',
        'INFO',
      ],
      immutable: true,
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
      immutable: true,
    },

    metadata: {
      type: Map,
      of: String,
      immutable: true,
    },

    externalEventId: {
      type: String,
      trim: true,
      maxlength: 128,
      immutable: true,
    },

    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  {
    timestamps: {
      createdAt: 'recordedAt',
      updatedAt: false,
    },

    strict: 'throw',
  },
);

auditLogSchema.index({
  merchantId: 1,
  recoveryCaseId: 1,
  occurredAt: 1,
});

auditLogSchema.index({
  merchantId: 1,
  transactionId: 1,
  occurredAt: 1,
});

auditLogSchema.index(
  {
    merchantId: 1,
    externalEventId: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      externalEventId: {
        $type: 'string',
      },
    },
  },
);

module.exports = mongoose.model(
  'AuditLog',
  auditLogSchema,
);