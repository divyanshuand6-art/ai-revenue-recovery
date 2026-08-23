const mongoose = require('mongoose');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const customerSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
      immutable: true,
    },
    externalCustomerId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    providerCustomerId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    fullName: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: emailPattern,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 32,
    },
    communicationConsent: {
      email: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
      updatedAt: { type: Date },
    },
    paymentHistory: {
      successfulPaymentCount: {
        type: Number,
        default: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'successfulPaymentCount must be a non-negative safe integer.',
        },
      },
      failedPaymentCount: {
        type: Number,
        default: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'failedPaymentCount must be a non-negative safe integer.',
        },
      },
      completedOrderCount: {
        type: Number,
        default: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'completedOrderCount must be a non-negative safe integer.',
        },
      },
      lifetimeValueMinor: {
        type: Number,
        default: 0,
        validate: {
          validator: isNonNegativeSafeInteger,
          message: 'lifetimeValueMinor must be a non-negative safe integer.',
        },
      },
      lastSuccessfulPaymentAt: { type: Date },
      lastFailedPaymentAt: { type: Date },
    },
  },
  {
    timestamps: true,
    strict: 'throw',
  },
);

customerSchema.index(
  { merchantId: 1, externalCustomerId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalCustomerId: { $type: 'string' } },
  },
);
customerSchema.index(
  { merchantId: 1, providerCustomerId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerCustomerId: { $type: 'string' } },
  },
);
customerSchema.index({ merchantId: 1, email: 1 });

module.exports = mongoose.model('Customer', customerSchema);
