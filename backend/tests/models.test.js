const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const AuditLog = require('../src/models/AuditLog');
const Customer = require('../src/models/Customer');
const RecoveryCase = require('../src/models/RecoveryCase');
const Subscription = require('../src/models/Subscription');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');

async function expectValidationError(document, path) {
  await assert.rejects(document.validate(), (error) => Boolean(error.errors?.[path]));
}

async function run() {
  const merchantId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const transactionId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId();
  const recoveryCaseId = new mongoose.Types.ObjectId();

  const user = new User({
    displayName: 'Demo Merchant',
    email: 'merchant@example.com',
    passwordHash: 'bcrypt-hash-placeholder',
  });
  await user.validate();
  assert.equal(user.toJSON().passwordHash, undefined);

  await new Customer({
    merchantId,
    externalCustomerId: 'customer_1001',
    fullName: 'Asha Sharma',
    email: 'asha@example.com',
    communicationConsent: { email: true },
  }).validate();

  await new Transaction({
    merchantId,
    customerId,
    type: 'PAYMENT',
    status: 'FAILED',
    amountMinor: 299900,
    currency: 'INR',
    source: 'SYNTHETIC',
    failureCategory: 'NETWORK_ERROR',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
  }).validate();

  await expectValidationError(
    new Transaction({
      merchantId,
      type: 'PAYMENT',
      status: 'FAILED',
      amountMinor: 2999.5,
      currency: 'INR',
      source: 'SYNTHETIC',
    }),
    'amountMinor',
  );

  await new Subscription({
    merchantId,
    customerId,
    providerSubscriptionId: 'sub_demo_1001',
    status: 'ACTIVE',
    amountMinor: 49900,
    currency: 'INR',
    intervalUnit: 'MONTH',
    intervalCount: 1,
  }).validate();

  await new RecoveryCase({
    merchantId,
    customerId,
    sourceTransactionId: transactionId,
    subscriptionId,
    type: 'SUBSCRIPTION_PAYMENT_FAILURE',
    amountAtRiskMinor: 49900,
    eligibleAmountMinor: 49900,
    recoveryWindowEndsAt: new Date('2026-08-24T10:00:00.000Z'),
  }).validate();

  await expectValidationError(
    new RecoveryCase({
      merchantId,
      customerId,
      sourceTransactionId: transactionId,
      type: 'PAYMENT_FAILURE',
      amountAtRiskMinor: 299900,
      eligibleAmountMinor: 300000,
      recoveryWindowEndsAt: new Date('2026-08-24T10:00:00.000Z'),
    }),
    'eligibleAmountMinor',
  );

  await new AuditLog({
    merchantId,
    recoveryCaseId,
    transactionId,
    actorType: 'SYSTEM',
    eventType: 'PAYMENT_FAILURE_DETECTED',
    result: 'INFO',
    message: 'Payment failure normalized from the provider event.',
    metadata: new Map([['failureCategory', 'NETWORK_ERROR']]),
  }).validate();

  console.info('Phase 2 model validation passed.');
}

run().catch((error) => {
  console.error('Phase 2 model validation failed:', error);
  process.exitCode = 1;
});
