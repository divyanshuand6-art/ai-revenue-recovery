require('dotenv').config();

const { configureDnsServers } = require('../config/dns');

configureDnsServers();

const mongoose = require('mongoose');

const { connectToDatabase } = require('../config/db');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Transaction = require('../models/Transaction');
const Subscription = require('../models/Subscription');
const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');


const TEST_PREFIX = 'TEST-RR-';

const scenarios = [
  {
    id: '001',
    name: 'Insufficient funds',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'INSUFFICIENT_FUNDS',
    failureReason: 'Customer account has insufficient available funds.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 49900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'DELAYED_RETRY',
  },

  {
    id: '002',
    name: 'Bank declined',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'BANK_DECLINED',
    failureReason: 'Payment was declined by the issuing bank.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 99900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'ALTERNATIVE_PAYMENT',
  },

  {
    id: '003',
    name: 'Network error',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'NETWORK_TIMEOUT',
    failureReason: 'Payment provider request timed out.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 149900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'PAYMENT_RETRY',
  },

  {
    id: '004',
    name: 'Authentication failed',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'AUTHENTICATION_FAILED',
    failureCode: 'AUTH_FAILED',
    failureReason: 'Customer payment authentication was unsuccessful.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 199900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'RECOVERY_LINK',
  },

  {
    id: '005',
    name: 'Mandate error',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'MANDATE_ERROR',
    failureCode: 'MANDATE_FAILED',
    failureReason: 'Recurring payment mandate could not be processed.',
    failureStage: 'MANDATE',
    paymentMethod: 'NETBANKING',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 299900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'ALTERNATIVE_PAYMENT',
  },

  {
    id: '006',
    name: 'Unknown failure',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'UNKNOWN',
    failureCode: 'UNKNOWN_FAILURE',
    failureReason: 'Payment provider returned an unknown failure.',
    failureStage: 'UNKNOWN',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 399900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'FOLLOW_UP',
  },

  {
    id: '007',
    name: 'Checkout abandonment',
    transactionType: 'CHECKOUT',
    transactionStatus: 'ABANDONED',
    failureStage: 'CHECKOUT',
    paymentMethod: 'CARD',
    caseType: 'CHECKOUT_ABANDONMENT',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 79900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'RECOVERY_LINK',
  },

  {
    id: '008',
    name: 'Subscription payment failure',
    transactionType: 'SUBSCRIPTION_PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'SUBSCRIPTION_FUNDS',
    failureReason: 'Subscription renewal failed because funds were unavailable.',
    failureStage: 'MANDATE',
    paymentMethod: 'CARD',
    caseType: 'SUBSCRIPTION_PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 129900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'DELAYED_RETRY',
    subscription: true,
  },

  {
    id: '009',
    name: 'Retry limit reached',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'RETRY_LIMIT_TEST',
    failureReason: 'Payment has already reached the configured retry limit.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 249900,
    retryAttemptCount: 2,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'STOP',
  },

  {
    id: '010',
    name: 'Duplicate scheduled action',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'DUPLICATE_ACTION_TEST',
    failureReason: 'Payment is already waiting for a delayed retry.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'ACTION_SCHEDULED',
    currentAction: 'DELAYED_RETRY',
    amountMinor: 349900,
    retryAttemptCount: 1,
    reminderCount: 0,
    recoveryHours: 48,
    expectedAction: 'STOP',
  },

  {
    id: '011',
    name: 'Expired recovery window',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'EXPIRED_TEST',
    failureReason: 'Recovery window has expired.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'EXPIRED',
    currentAction: 'STOP',
    amountMinor: 449900,
    retryAttemptCount: 0,
    reminderCount: 2,
    recoveryHours: -24,
    expectedAction: 'STOP',
    stopReason: 'Recovery window expired without a verified payment result.',
  },

  {
    id: '012',
    name: 'Already recovered',
    transactionType: 'PAYMENT',
    transactionStatus: 'CAPTURED',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERED',
    currentAction: 'PAYMENT_RETRY',
    amountMinor: 599900,
    retryAttemptCount: 1,
    reminderCount: 0,
    recoveryHours: -24,
    recovered: true,
    expectedAction: 'STOP',
  },
];

function buildProviderId(id, suffix) {
  return `${TEST_PREFIX}${id}-${suffix}`;
}

async function findMerchant() {
  const merchant = await User.findOne({
    role: { $in: ['OWNER', 'merchant'] },
  }).select('_id');

  if (!merchant) {
    throw new Error(
      'No merchant user found. Run the normal demo seed first.',
    );
  }

  return merchant;
}

async function findOrCreateCustomer({
  merchantId,
  scenario,
}) {
  const externalCustomerId =
    buildProviderId(
      scenario.id,
      'CUSTOMER',
    );

  let customer =
    await Customer.findOne({
      merchantId,
      externalCustomerId,
    });

  if (customer) {
    return customer;
  }

  customer = await Customer.create({
    merchantId,

    externalCustomerId,

    providerCustomerId:
      buildProviderId(
        scenario.id,
        'PROVIDER_CUSTOMER',
      ),

    fullName:
      `Recovery Test Customer ${scenario.id}`,

    email:
      `test-recovery-${scenario.id}@demo.local`,

    phone:
      `90000000${scenario.id}`,

    communicationConsent: {
      email: true,
      sms: true,
      whatsapp: false,
      updatedAt: new Date(),
    },

    paymentHistory: {
      successfulPaymentCount: 3,
      failedPaymentCount: 1,
      completedOrderCount: 3,
      lifetimeValueMinor: 1500000,
    },
  });

  return customer;
}

async function findOrCreateSubscription({
  merchantId,
  customerId,
  scenario,
}) {
  if (!scenario.subscription) {
    return null;
  }

  const providerSubscriptionId =
    buildProviderId(
      scenario.id,
      'SUBSCRIPTION',
    );

  let subscription =
    await Subscription.findOne({
      merchantId,
      providerSubscriptionId,
    });

  if (subscription) {
    return subscription;
  }

  const now = new Date();

  subscription =
    await Subscription.create({
      merchantId,

      customerId,

      providerSubscriptionId,

      status: 'ACTIVE',

      planName:
        'Recovery Test Monthly Plan',

      amountMinor:
        scenario.amountMinor,

      currency: 'INR',

      intervalUnit: 'MONTH',

      intervalCount: 1,

      failureCount: 1,

      nextBillingAt:
        new Date(
          now.getTime() +
            30 * 24 * 60 * 60 * 1000,
        ),

      recoveryWindowEndsAt:
        new Date(
          now.getTime() +
            48 * 60 * 60 * 1000,
        ),

      startedAt: now,
    });

  return subscription;
}

async function findOrCreateTransaction({
  merchantId,
  customerId,
  subscriptionId,
  scenario,
}) {
  const providerEventId =
    buildProviderId(
      scenario.id,
      'EVENT',
    );

  let transaction =
    await Transaction.findOne({
      merchantId,
      providerEventId,
    });

  if (transaction) {
    return transaction;
  }

  const now = new Date();

  transaction =
    await Transaction.create({
      merchantId,

      customerId,

      subscriptionId:
        subscriptionId || undefined,

      type:
        scenario.transactionType,

      status:
        scenario.transactionStatus,

      amountMinor:
        scenario.amountMinor,

      currency: 'INR',

      source: 'MANUAL',

      providerStatus:
        scenario.transactionStatus,

      providerOrderId:
        buildProviderId(
          scenario.id,
          'ORDER',
        ),

      providerEventId,

      failureCategory:
        scenario.failureCategory,

      failureCode:
        scenario.failureCode,

      failureReason:
        scenario.failureReason,

      failureStage:
        scenario.failureStage,

      paymentMethod:
        scenario.paymentMethod,

      occurredAt: now,

      providerCreatedAt: now,

      providerUpdatedAt: now,
    });

  return transaction;
}

async function findOrCreateRecoveryCase({
  merchantId,
  customerId,
  transactionId,
  subscriptionId,
  scenario,
}) {
  let recoveryCase =
    await RecoveryCase.findOne({
      merchantId,
      sourceTransactionId:
        transactionId,
    });

  if (recoveryCase) {
    return recoveryCase;
  }

  const now = new Date();

  const recoveryWindowEndsAt =
    new Date(
      now.getTime() +
        scenario.recoveryHours *
          60 *
          60 *
          1000,
    );

  const scheduled =
    scenario.caseStatus ===
      'ACTION_SCHEDULED';

  const recoveryCaseData = {
    merchantId,

    customerId,

    sourceTransactionId:
      transactionId,

    subscriptionId:
      subscriptionId || undefined,

    type:
      scenario.caseType,

    status:
      scenario.caseStatus,

    amountAtRiskMinor:
      scenario.amountMinor,

    eligibleAmountMinor:
      scenario.amountMinor,

    recoveredAmountMinor:
      scenario.recovered
        ? scenario.amountMinor
        : 0,

    currency: 'INR',

    retryAttemptCount:
      scenario.retryAttemptCount,

    reminderCount:
      scenario.reminderCount,

    currentAction:
      scenario.currentAction,

    nextActionAt:
      scheduled
        ? new Date(
            now.getTime() +
              60 * 60 * 1000,
          )
        : undefined,

    recoveryWindowEndsAt,

    policySnapshot: {
      maxPaymentRetries: 2,
      maxReminders: 2,
      recoveryWindowHours: 48,
    },

    agentDecision: {
      action:
        scenario.currentAction,

      confidence:
        scenario.currentAction
          ? 0.9
          : undefined,

      reasonCode:
        scenario.failureCategory ||
        scenario.caseType,

      rationale:
        `Deterministic recovery test scenario: ${scenario.name}.`,

      customerMessage:
        'This is a controlled recovery test scenario.',

      nextActionAt:
        scheduled
          ? new Date(
              now.getTime() +
                60 * 60 * 1000,
            )
          : undefined,

      stopCondition:
        'MAX_RETRIES_OR_RECOVERY_WINDOW',

      analyzedAt: now,
    },

    stopReason:
      scenario.stopReason,

    recoveryTransactionId:
      scenario.recovered
        ? transactionId
        : undefined,

    recoveredAt:
      scenario.recovered
        ? now
        : undefined,
  };

  recoveryCase =
    await RecoveryCase.create(
      recoveryCaseData,
    );

  return recoveryCase;
}

async function createAuditLogIfMissing({
  merchantId,
  recoveryCase,
  transactionId,
  scenario,
}) {
  const externalEventId =
    buildProviderId(
      scenario.id,
      'AUDIT',
    );

  const existing =
    await AuditLog.findOne({
      merchantId,
      externalEventId,
    });

  if (existing) {
    return existing;
  }

  let eventType =
    'RECOVERY_CASE_CREATED';

  let result = 'INFO';

  if (
    scenario.caseStatus ===
    'RECOVERED'
  ) {
    eventType =
      'RECOVERY_COMPLETED';

    result = 'SUCCEEDED';
  } else if (
    scenario.caseStatus ===
    'EXPIRED'
  ) {
    eventType =
      'RECOVERY_STOPPED';

    result = 'SKIPPED';
  } else if (
    scenario.currentAction
  ) {
    eventType =
      'RECOVERY_ACTION_SELECTED';

    result = 'PENDING';
  }

  return AuditLog.create({
    merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId,

    actorType:
      'SYSTEM',

    eventType,

    action:
      scenario.currentAction,

    result,

    message:
      `Created deterministic recovery test scenario ${scenario.id}: ${scenario.name}.`,

    metadata: {
      testScenario:
        `${TEST_PREFIX}${scenario.id}`,

      expectedAction:
        scenario.expectedAction,

      failureCategory:
        scenario.failureCategory ||
        'NONE',
    },

    externalEventId,

    occurredAt: new Date(),
  });
}

async function seedRecoveryTestData() {
await connectToDatabase();

  const merchant =
    await findMerchant();

  const created = [];

  for (const scenario of scenarios) {
    const customer =
      await findOrCreateCustomer({
        merchantId:
          merchant._id,
        scenario,
      });

    const subscription =
      await findOrCreateSubscription({
        merchantId:
          merchant._id,
        customerId:
          customer._id,
        scenario,
      });

    const transaction =
      await findOrCreateTransaction({
        merchantId:
          merchant._id,
        customerId:
          customer._id,
        subscriptionId:
          subscription?._id,
        scenario,
      });

    const recoveryCase =
      await findOrCreateRecoveryCase({
        merchantId:
          merchant._id,
        customerId:
          customer._id,
        transactionId:
          transaction._id,
        subscriptionId:
          subscription?._id,
        scenario,
      });

    if (
      !transaction.recoveryCaseId ||
      String(
        transaction.recoveryCaseId,
      ) !==
        String(recoveryCase._id)
    ) {
      transaction.recoveryCaseId =
        recoveryCase._id;

      await transaction.save();
    }

    if (subscription) {
      if (
        !subscription.activeRecoveryCaseId ||
        String(
          subscription.activeRecoveryCaseId,
        ) !==
          String(recoveryCase._id)
      ) {
        subscription.activeRecoveryCaseId =
          recoveryCase._id;

        subscription.lastPaymentTransactionId =
          transaction._id;

        await subscription.save();
      }
    }

    await createAuditLogIfMissing({
      merchantId:
        merchant._id,

      recoveryCase,

      transactionId:
        transaction._id,

      scenario,
    });

    created.push({
      testId:
        `${TEST_PREFIX}${scenario.id}`,

      name:
        scenario.name,

      recoveryCaseId:
        String(recoveryCase._id),

      transactionId:
        String(transaction._id),

      status:
        recoveryCase.status,

      currentAction:
        recoveryCase.currentAction ||
        null,

      expectedAction:
        scenario.expectedAction,
    });
  }

  console.log(
    'Recovery test dataset created/verified successfully.',
  );

  console.log(
    JSON.stringify(
      {
        merchantId:
          String(merchant._id),

        scenarios:
          created.length,

        cases: created,
      },
      null,
      2,
    ),
  );
}

seedRecoveryTestData()
  .catch((error) => {
    console.error(
      'Recovery test dataset failed:',
      error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });