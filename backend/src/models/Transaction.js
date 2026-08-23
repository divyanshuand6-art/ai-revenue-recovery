const mongoose = require('mongoose');

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const transactionSchema = new mongoose.Schema(
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
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      index: true,
    },
    recoveryCaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryCase',
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['PAYMENT', 'CHECKOUT', 'SUBSCRIPTION_PAYMENT'],
    },
    status: {
      type: String,
      required: true,
      enum: [
        'CREATED',
        'AUTHORIZED',
        'CAPTURED',
        'FAILED',
        'ABANDONED',
        'CANCELLED',
        'REFUNDED',
      ],
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
    source: {
      type: String,
      required: true,
      enum: ['RAZORPAY', 'SYNTHETIC', 'MANUAL'],
    },
    providerStatus: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    providerOrderId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    providerPaymentId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    providerEventId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    failureCategory: {
      type: String,
      enum: [
        'BANK_DECLINED',
        'INSUFFICIENT_FUNDS',
        'NETWORK_ERROR',
        'AUTHENTICATION_FAILED',
        'PROCESSING_ERROR',
        'MANDATE_ERROR',
        'UNKNOWN',
      ],
    },
    failureCode: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    failureStage: {
      type: String,
      enum: ['CHECKOUT', 'AUTHORIZATION', 'CAPTURE', 'MANDATE', 'UNKNOWN'],
    },
    paymentMethod: {
      type: String,
      enum: ['CARD', 'UPI', 'NETBANKING', 'WALLET', 'EMI', 'UNKNOWN'],
    },
    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    providerCreatedAt: { type: Date },
    providerUpdatedAt: { type: Date },
  },
  {
    timestamps: true,
    strict: 'throw',
  },
);

transactionSchema.index({ merchantId: 1, occurredAt: -1 });
transactionSchema.index({ merchantId: 1, status: 1, occurredAt: -1 });
transactionSchema.index({ merchantId: 1, providerOrderId: 1 });
transactionSchema.index(
  { merchantId: 1, providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerPaymentId: { $type: 'string' } },
  },
);
transactionSchema.index(
  { merchantId: 1, providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerEventId: { $type: 'string' } },
  },
);

module.exports = mongoose.model('Transaction', transactionSchema);
