require('dotenv').config();

const { configureDnsServers } = require('../config/dns');
configureDnsServers();

const mongoose = require('mongoose');
const { connectToDatabase, disconnectFromDatabase } = require('../config/db');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Transaction = require('../models/Transaction');
const Subscription = require('../models/Subscription');
const RecoveryCase = require('../models/RecoveryCase');
const AuditLog = require('../models/AuditLog');

/*
 * ============================================================
 * FULL RECOVERY TEST DATASET
 * ============================================================
 *
 * IMPORTANT:
 * This script is intentionally destructive.
 *
 * It deletes ALL records from the application database and then
 * creates a clean recovery-testing dataset.
 *
 * Use only on the development / hackathon database.
 *
 * ============================================================
 */

const TEST_RUN_ID = Date.now();
const TEST_PREFIX = `TEST-RR-${TEST_RUN_ID}-`;

const DEMO_MERCHANT_EMAIL =
  'demo.merchant@ai-revenue-recovery.local';

const DEMO_MERCHANT_PASSWORD_HASH =
  '$2b$12$GZWPIKFgZCkznFinVBIYGu.Zu8h2GQS9QCxZMTw.jdyTBCGqRbIYy';

const POLICY_SNAPSHOT = {
  maxPaymentRetries: 2,
  maxReminders: 2,
  recoveryWindowHours: 48,
};

const BASE_AMOUNT_MINOR = 49900;

function buildProviderId(scenarioId, suffix) {
  return `${TEST_PREFIX}${scenarioId}-${suffix}`;
}

function hoursFromNow(hours) {
  return new Date(
    Date.now() + hours * 60 * 60 * 1000,
  );
}

function minutesFromNow(minutes) {
  return new Date(
    Date.now() + minutes * 60 * 1000,
  );
}

/*
 * ============================================================
 * SCENARIOS
 * ============================================================
 */

const scenarios = [
  {
    id: '001',
    name: 'Insufficient funds',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'INSUFFICIENT_FUNDS',
    failureReason:
      'Customer account has insufficient available funds.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 49900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'DELAYED_RETRY',
  },

  {
    id: '002',
    name: 'Bank declined',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'BANK_DECLINED',
    failureReason:
      'Payment was declined by the issuing bank.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 99900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'ALTERNATIVE_PAYMENT',
  },

  {
    id: '003',
    name: 'Network error',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'NETWORK_TIMEOUT',
    failureReason:
      'Payment provider request timed out.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 149900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'PAYMENT_RETRY',
  },

  {
    id: '004',
    name: 'Authentication failed',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'AUTHENTICATION_FAILED',
    failureCode: 'AUTH_FAILED',
    failureReason:
      'Customer payment authentication was unsuccessful.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 199900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'RECOVERY_LINK',
  },

  {
    id: '005',
    name: 'Mandate error',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'MANDATE_ERROR',
    failureCode: 'MANDATE_FAILED',
    failureReason:
      'Recurring payment mandate could not be processed.',
    failureStage: 'MANDATE',
    paymentMethod: 'NETBANKING',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 299900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'ALTERNATIVE_PAYMENT',
  },

  {
    id: '006',
    name: 'Unknown failure',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'UNKNOWN',
    failureCode: 'UNKNOWN_FAILURE',
    failureReason:
      'Payment provider returned an unknown failure.',
    failureStage: 'UNKNOWN',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 399900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'FOLLOW_UP',
  },

  {
    id: '007',
    name: 'Checkout abandonment',
    transactionType: 'CHECKOUT',
    transactionStatus: 'ABANDONED',
    failureCategory: undefined,
    failureCode: undefined,
    failureReason: undefined,
    failureStage: 'CHECKOUT',
    paymentMethod: 'CARD',
    caseType: 'CHECKOUT_ABANDONMENT',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 79900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'RECOVERY_LINK',
  },

  {
    id: '008',
    name: 'Subscription insufficient funds',
    transactionType: 'SUBSCRIPTION_PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'SUBSCRIPTION_FUNDS',
    failureReason:
      'Subscription renewal failed because funds were unavailable.',
    failureStage: 'MANDATE',
    paymentMethod: 'CARD',
    caseType: 'SUBSCRIPTION_PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 129900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'DELAYED_RETRY',
    subscription: true,
  },

  {
    id: '009',
    name: 'Subscription network failure',
    transactionType: 'SUBSCRIPTION_PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'SUBSCRIPTION_NETWORK',
    failureReason:
      'Subscription payment provider timed out.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
    caseType: 'SUBSCRIPTION_PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 199900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'PAYMENT_RETRY',
    subscription: true,
  },

  {
    id: '010',
    name: 'Subscription mandate failure',
    transactionType: 'SUBSCRIPTION_PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'MANDATE_ERROR',
    failureCode: 'SUBSCRIPTION_MANDATE',
    failureReason:
      'Subscription mandate was rejected.',
    failureStage: 'MANDATE',
    paymentMethod: 'CARD',
    caseType: 'SUBSCRIPTION_PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 249900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'ALTERNATIVE_PAYMENT',
    subscription: true,
  },

  {
    id: '011',
    name: 'Retry limit reached',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'RETRY_LIMIT_TEST',
    failureReason:
      'Payment has already reached the configured retry limit.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 249900,
    retryAttemptCount: 2,
    reminderCount: 0,
    expectedAction: 'STOP',
  },

  {
    id: '012',
    name: 'Retry and reminder limits reached',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'ALL_LIMITS_TEST',
    failureReason:
      'Retry and reminder limits have both been exhausted.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 299900,
    retryAttemptCount: 2,
    reminderCount: 2,
    expectedAction: 'ESCALATE',
  },

  {
    id: '013',
    name: 'Duplicate scheduled action',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'INSUFFICIENT_FUNDS',
    failureCode: 'DUPLICATE_ACTION_TEST',
    failureReason:
      'Payment is already waiting for a delayed retry.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'ACTION_SCHEDULED',
    currentAction: 'DELAYED_RETRY',
    amountMinor: 349900,
    retryAttemptCount: 1,
    reminderCount: 0,
    expectedAction: 'STOP',
  },

  {
    id: '014',
    name: 'Expired recovery window',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'EXPIRED_TEST',
    failureReason:
      'Recovery window has expired.',
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
    stopReason:
      'Recovery window expired without a verified payment result.',
  },

  {
    id: '015',
    name: 'Action executed awaiting payment',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'ACTION_EXECUTED_TEST',
    failureReason:
      'Recovery action was executed and is awaiting customer payment confirmation.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'ACTION_EXECUTED',
    currentAction: 'PAYMENT_RETRY',
    amountMinor: 79900,
    retryAttemptCount: 1,
    reminderCount: 0,
    expectedAction: 'PAYMENT_RETRY',
  },

  {
    id: '016',
    name: 'No communication consent',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'AUTHENTICATION_FAILED',
    failureCode: 'NO_CONSENT_TEST',
    failureReason:
      'Customer does not permit recovery communication.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 89900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'STOP',
    consent: {
      email: false,
      sms: false,
      whatsapp: false,
    },
  },

  {
    id: '017',
    name: 'Email only consent',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'AUTHENTICATION_FAILED',
    failureCode: 'EMAIL_ONLY_TEST',
    failureReason:
      'Customer has email consent but no SMS consent.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 109900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'RECOVERY_LINK',
    consent: {
      email: true,
      sms: false,
      whatsapp: false,
    },
  },

  {
    id: '018',
    name: 'High risk customer',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'HIGH_RISK_TEST',
    failureReason:
      'High-risk customer payment was declined.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 179900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'ALTERNATIVE_PAYMENT',
    customerSegment: 'HIGH_RISK',
  },

  {
    id: '019',
    name: 'Large value payment',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'LARGE_VALUE_TEST',
    failureReason:
      'Large-value transaction encountered a transient network failure.',
    failureStage: 'CAPTURE',
    paymentMethod: 'NETBANKING',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 2500000,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'PAYMENT_RETRY',
  },

  {
    id: '020',
    name: 'Reminder available after retry exhaustion',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'NETWORK_ERROR',
    failureCode: 'REMINDER_AVAILABLE_TEST',
    failureReason:
      'Payment retry limit reached while reminder capacity remains.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 219900,
    retryAttemptCount: 2,
    reminderCount: 0,
    expectedAction: 'REMINDER',
  },

  {
    id: '021',
    name: 'Checkout reminder limit',
    transactionType: 'CHECKOUT',
    transactionStatus: 'ABANDONED',
    failureStage: 'CHECKOUT',
    paymentMethod: 'UPI',
    caseType: 'CHECKOUT_ABANDONMENT',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 399900,
    retryAttemptCount: 0,
    reminderCount: 2,
    expectedAction: 'ESCALATE',
  },

  {
    id: '022',
    name: 'Processing error',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'PROCESSING_ERROR',
    failureCode: 'PROCESSING_ERROR',
    failureReason:
      'Payment processor failed while capturing the payment.',
    failureStage: 'CAPTURE',
    paymentMethod: 'NETBANKING',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 159900,
    retryAttemptCount: 0,
    reminderCount: 0,
    expectedAction: 'PAYMENT_RETRY',
  },

  {
    id: '023',
    name: 'Partial recovery edge case',
    transactionType: 'PAYMENT',
    transactionStatus: 'FAILED',
    failureCategory: 'BANK_DECLINED',
    failureCode: 'PARTIAL_RECOVERY_TEST',
    failureReason:
      'Case already contains a small verified recovered amount.',
    failureStage: 'AUTHORIZATION',
    paymentMethod: 'UPI',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERY_PENDING',
    amountMinor: 499900,
    retryAttemptCount: 0,
    reminderCount: 0,
    recoveredAmountMinor: 49900,
    expectedAction: 'ALTERNATIVE_PAYMENT',
  },

  {
    id: '024',
    name: 'Already recovered guard',
    transactionType: 'PAYMENT',
    transactionStatus: 'CAPTURED',
    failureCategory: undefined,
    failureCode: undefined,
    failureReason: undefined,
    failureStage: 'CAPTURE',
    paymentMethod: 'CARD',
    caseType: 'PAYMENT_FAILURE',
    caseStatus: 'RECOVERED',
    currentAction: 'PAYMENT_RETRY',
    amountMinor: 599900,
    recoveredAmountMinor: 599900,
    retryAttemptCount: 1,
    reminderCount: 0,
    recovered: true,
    expectedAction: 'STOP',
  },
];

/*
 * ============================================================
 * DATABASE RESET
 * ============================================================
 */

async function deleteEntireDatabase() {
  console.log('\n========================================');
  console.log('DELETING EXISTING DATABASE DATA');
  console.log('========================================\n');

  const results = await Promise.all([
    AuditLog.deleteMany({}),
    RecoveryCase.deleteMany({}),
    Transaction.deleteMany({}),
    Subscription.deleteMany({}),
    Customer.deleteMany({}),
    User.deleteMany({}),
  ]);

  console.log(
    `AuditLogs deleted: ${results[0].deletedCount}`,
  );

  console.log(
    `RecoveryCases deleted: ${results[1].deletedCount}`,
  );

  console.log(
    `Transactions deleted: ${results[2].deletedCount}`,
  );

  console.log(
    `Subscriptions deleted: ${results[3].deletedCount}`,
  );

  console.log(
    `Customers deleted: ${results[4].deletedCount}`,
  );

  console.log(
    `Users deleted: ${results[5].deletedCount}`,
  );

  console.log('\nDatabase cleared successfully.\n');
}

/*
 * ============================================================
 * MERCHANT
 * ============================================================
 */

async function createMerchant() {
  const merchantId = new mongoose.Types.ObjectId();

  return User.create({
    _id: merchantId,
    displayName: 'Recovery Full Test Merchant',
    email: DEMO_MERCHANT_EMAIL,
    passwordHash: DEMO_MERCHANT_PASSWORD_HASH,
    role: 'OWNER',
    status: 'ACTIVE',
  });
}

/*
 * ============================================================
 * CUSTOMER
 * ============================================================
 */

async function createCustomer(merchantId, scenario) {
  const segment =
    scenario.customerSegment || 'REGULAR';

  const consent = scenario.consent || {
    email: true,
    sms: true,
    whatsapp: false,
  };

  const successCount =
    segment === 'HIGH_RISK'
      ? 1
      : 6;

  const failureCount =
    segment === 'HIGH_RISK'
      ? 6
      : 1;

  return Customer.create({
    merchantId,

    externalCustomerId:
      buildProviderId(
        scenario.id,
        'CUSTOMER',
      ),

    providerCustomerId:
      buildProviderId(
        scenario.id,
        'PROVIDER_CUSTOMER',
      ),

    fullName:
      `Recovery Test Customer ${scenario.id}`,

    email:
      `test-recovery-${TEST_RUN_ID}-${scenario.id}@demo.local`,

    phone:
      `9${String(
        TEST_RUN_ID % 1000000000,
      ).padStart(9, '0')}`.slice(0, 10),

    communicationConsent: {
      email: Boolean(consent.email),
      sms: Boolean(consent.sms),
      whatsapp: Boolean(consent.whatsapp),
      updatedAt: new Date(),
    },

    paymentHistory: {
      successfulPaymentCount: successCount,
      failedPaymentCount: failureCount,
      completedOrderCount: successCount,
      lifetimeValueMinor: 1500000,
    },
  });
}

/*
 * ============================================================
 * SUBSCRIPTION
 * ============================================================
 */

async function createSubscription(
  merchantId,
  customerId,
  scenario,
) {
  if (!scenario.subscription) {
    return null;
  }

  const now = new Date();

  return Subscription.create({
    merchantId,
    customerId,

    providerSubscriptionId:
      buildProviderId(
        scenario.id,
        'SUBSCRIPTION',
      ),

    status: 'PAST_DUE',

    planName:
      'Recovery Full Test Monthly Plan',

    amountMinor:
      scenario.amountMinor,

    currency: 'INR',

    intervalUnit: 'MONTH',
    intervalCount: 1,

    failureCount: 1,

    nextBillingAt:
      new Date(
        now.getTime() +
          30 *
            24 *
            60 *
            60 *
            1000,
      ),

    recoveryWindowEndsAt:
      hoursFromNow(48),

    startedAt: now,
  });
}

/*
 * ============================================================
 * SOURCE TRANSACTION
 * ============================================================
 */

async function createTransaction(
  merchantId,
  customerId,
  subscriptionId,
  scenario,
) {
  const now = new Date();

  return Transaction.create({
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
      String(
        scenario.transactionStatus,
      ).toLowerCase(),

    providerOrderId:
      buildProviderId(
        scenario.id,
        'ORDER',
      ),

    providerPaymentId:
      scenario.caseStatus ===
      'RECOVERED'
        ? buildProviderId(
            scenario.id,
            'PAYMENT',
          )
        : undefined,

    providerEventId:
      buildProviderId(
        scenario.id,
        'EVENT',
      ),

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
}

/*
 * ============================================================
 * RECOVERY CASE
 * ============================================================
 */

async function createRecoveryCase(
  merchantId,
  customerId,
  transactionId,
  subscriptionId,
  scenario,
) {
  const recoveryHours =
    scenario.recoveryHours ?? 48;

  const recoveryWindowEndsAt =
    hoursFromNow(recoveryHours);

  const isScheduled =
    scenario.caseStatus ===
    'ACTION_SCHEDULED';

  const isExecuted =
    scenario.caseStatus ===
    'ACTION_EXECUTED';

  const isRecovered =
    scenario.recovered === true;

  const recoveredAmountMinor =
    scenario.recoveredAmountMinor ??
    (isRecovered
      ? scenario.amountMinor
      : 0);

  return RecoveryCase.create({
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

    recoveredAmountMinor,

    currency: 'INR',

    retryAttemptCount:
      scenario.retryAttemptCount,

    reminderCount:
      scenario.reminderCount,

    currentAction:
      scenario.currentAction,

    actionTaken:
      isExecuted
        ? scenario.currentAction
        : undefined,

    nextActionAt:
      isScheduled
        ? minutesFromNow(60)
        : undefined,

    recoveryWindowEndsAt,

    policySnapshot: {
      ...POLICY_SNAPSHOT,
    },

    agentDecision: {
      action:
        scenario.currentAction ||
        undefined,

      confidence:
        scenario.currentAction
          ? 0.90
          : undefined,

      riskLevel:
        scenario.customerSegment ===
        'HIGH_RISK'
          ? 'HIGH'
          : 'MEDIUM',

      reasonCode:
        scenario.failureCategory ||
        scenario.caseType,

      rationale:
        `Full recovery test scenario: ${scenario.name}.`,

      customerMessage:
        'Your payment could not be completed. Please use the available recovery option.',

      nextActionAt:
        isScheduled
          ? minutesFromNow(60)
          : undefined,

      stopCondition:
        'MAX_RETRIES_OR_RECOVERY_WINDOW',

      analyzedAt: new Date(),
    },

    stopReason:
      scenario.stopReason,

    recoveryTransactionId:
      isRecovered
        ? transactionId
        : undefined,

    recoveredAt:
      isRecovered
        ? new Date()
        : undefined,
  });
}

/*
 * ============================================================
 * AUDIT LOG
 * ============================================================
 */

async function createAuditLog(
  merchantId,
  recoveryCase,
  transaction,
  scenario,
) {
  let eventType =
    'RECOVERY_CASE_CREATED';

  let result = 'INFO';

  let action =
    scenario.currentAction || null;

  if (
    scenario.caseStatus ===
    'RECOVERED'
  ) {
    eventType =
      'RECOVERY_COMPLETED';

    result =
      'SUCCEEDED';
  }

  else if (
    scenario.caseStatus ===
    'EXPIRED'
  ) {
    eventType =
      'RECOVERY_STOPPED';

    result =
      'SKIPPED';

    action = 'STOP';
  }

  else if (
    scenario.caseStatus ===
    'ACTION_EXECUTED'
  ) {
    eventType =
      'RECOVERY_ACTION_EXECUTED';

    result =
      'PENDING';
  }

  else if (
    scenario.currentAction
  ) {
    eventType =
      'RECOVERY_ACTION_SELECTED';

    result =
      'PENDING';
  }

  return AuditLog.create({
    merchantId,

    recoveryCaseId:
      recoveryCase._id,

    transactionId:
      transaction._id,

    actorType: 'SYSTEM',

    eventType,

    action,

    result,

    message:
      `Created full recovery test scenario ${scenario.id}: ${scenario.name}.`,

    metadata: {
      testRunId: TEST_RUN_ID,

      testScenario:
        `${TEST_PREFIX}${scenario.id}`,

      expectedAction:
        scenario.expectedAction,

      failureCategory:
        scenario.failureCategory ||
        'NONE',

      caseStatus:
        scenario.caseStatus,

      currentAction:
        scenario.currentAction ||
        null,
    },

    externalEventId:
      buildProviderId(
        scenario.id,
        'AUDIT',
      ),

    occurredAt: new Date(),
  });
}

/*
 * ============================================================
 * MAIN SEED
 * ============================================================
 */

async function seedRecoveryFullTestData() {
  try {
    await connectToDatabase();

    /*
     * 1. DELETE EVERYTHING
     */
    await deleteEntireDatabase();

    /*
     * 2. CREATE FRESH MERCHANT
     */
    const merchant =
      await createMerchant();

    console.log(
      `Fresh merchant created: ${merchant._id}`,
    );

    const created = [];

    /*
     * 3. CREATE ALL TEST SCENARIOS
     */
    for (const scenario of scenarios) {
      const customer =
        await createCustomer(
          merchant._id,
          scenario,
        );

      const subscription =
        await createSubscription(
          merchant._id,
          customer._id,
          scenario,
        );

      const transaction =
        await createTransaction(
          merchant._id,
          customer._id,
          subscription?._id,
          scenario,
        );

      const recoveryCase =
        await createRecoveryCase(
          merchant._id,
          customer._id,
          transaction._id,
          subscription?._id,
          scenario,
        );

      /*
       * Keep source transaction linked
       * with recovery case.
       */
      transaction.recoveryCaseId =
        recoveryCase._id;

      await transaction.save();

      /*
       * Keep subscription linked.
       */
      if (subscription) {
        subscription.activeRecoveryCaseId =
          recoveryCase._id;

        subscription.lastPaymentTransactionId =
          transaction._id;

        await subscription.save();
      }

      /*
       * Audit trail.
       */
      await createAuditLog(
        merchant._id,
        recoveryCase,
        transaction,
        scenario,
      );

      created.push({
        testId:
          `${TEST_PREFIX}${scenario.id}`,

        name:
          scenario.name,

        recoveryCaseId:
          String(
            recoveryCase._id,
          ),

        transactionId:
          String(
            transaction._id,
          ),

        status:
          recoveryCase.status,

        currentAction:
          recoveryCase.currentAction ||
          null,

        expectedAction:
          scenario.expectedAction,

        amountMinor:
          scenario.amountMinor,
      });

      console.log(
        `[${scenario.id}] ${scenario.name} -> ${scenario.expectedAction}`,
      );
    }

    /*
     * 4. SUMMARY
     */
    const recoveryCases =
      await RecoveryCase.find({
        merchantId:
          merchant._id,
      })
        .select(
          'status amountAtRiskMinor recoveredAmountMinor',
        )
        .lean();

    const recoveredCases =
      recoveryCases.filter(
        (item) =>
          item.status ===
          'RECOVERED',
      );

    const revenueAtRiskMinor =
      recoveryCases.reduce(
        (sum, item) =>
          sum +
          Number(
            item.amountAtRiskMinor ||
              0,
          ),
        0,
      );

    const revenueRecoveredMinor =
      recoveryCases.reduce(
        (sum, item) =>
          sum +
          Number(
            item.recoveredAmountMinor ||
              0,
          ),
        0,
      );

    console.log(
      '\n========================================',
    );

    console.log(
      'FULL RECOVERY TEST DATASET READY',
    );

    console.log(
      '========================================\n',
    );

    console.log(
      JSON.stringify(
        {
          testRunId: TEST_RUN_ID,

          testPrefix: TEST_PREFIX,

          merchantId:
            String(
              merchant._id,
            ),

          merchantEmail:
            DEMO_MERCHANT_EMAIL,

          scenarios:
            scenarios.length,

          recoveryCases:
            recoveryCases.length,

          recoveredCases:
            recoveredCases.length,

          revenueAtRiskMinor,

          revenueRecoveredMinor,

          recoveryRatePercent:
            recoveryCases.length === 0
              ? 0
              : Number(
                  (
                    (recoveredCases.length /
                      recoveryCases.length) *
                    100
                  ).toFixed(2),
                ),

          cases: created,
        },
        null,
        2,
      ),
    );
  } finally {
    await disconnectFromDatabase();
  }
}

/*
 * ============================================================
 * RUN
 * ============================================================
 */

seedRecoveryFullTestData().catch(
  (error) => {
    console.error(
      '\nFULL RECOVERY TEST SEED FAILED:\n',
      error.stack ||
        error.message ||
        error,
    );

    process.exitCode = 1;
  },
);