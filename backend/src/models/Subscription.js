const mongoose = require('mongoose');

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const subscriptionSchema = new mongoose.Schema(
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
    providerSubscriptionId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    status: {
      type: String,
      required: true,
      enum: ['CREATED', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'COMPLETED', 'EXPIRED'],
      default: 'CREATED',
    },
    planName: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    amountMinor: {
      type: Number,
      required: true,
      validate: {
        validator: isPositiveSafeInteger,
        message: 'amountMinor must be a positive safe integer in the smallest currency unit.',
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
    intervalUnit: {
      type: String,
      required: true,
      enum: ['DAY', 'WEEK', 'MONTH', 'YEAR'],
    },
    intervalCount: {
      type: Number,
      required: true,
      default: 1,
      validate: {
        validator: isPositiveSafeInteger,
        message: 'intervalCount must be a positive safe integer.',
      },
    },
    failureCount: {
      type: Number,
      default: 0,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'failureCount must be a non-negative safe integer.',
      },
    },
    nextBillingAt: { type: Date },
    recoveryWindowEndsAt: { type: Date },
    lastPaymentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    activeRecoveryCaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryCase',
    },
    startedAt: { type: Date },
    cancelledAt: { type: Date },
  },
  {
    timestamps: true,
    strict: 'throw',
  },
);

subscriptionSchema.index({ merchantId: 1, customerId: 1, status: 1 });
subscriptionSchema.index({ merchantId: 1, nextBillingAt: 1 });
subscriptionSchema.index(
  { merchantId: 1, providerSubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSubscriptionId: { $type: 'string' } },
  },
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
