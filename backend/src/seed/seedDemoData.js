const assert = require('node:assert/strict');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { connectToDatabase, disconnectFromDatabase } = require('../config/db');
const { configureDnsServers } = require('../config/dns');
const AuditLog = require('../models/AuditLog');
const Customer = require('../models/Customer');
const RecoveryCase = require('../models/RecoveryCase');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const DATASET_SEED = 20260822;
const DEMO_MERCHANT_EMAIL = 'demo.merchant@ai-revenue-recovery.local';
const DATASET_START = new Date('2026-07-08T00:00:00.000Z');
const DATASET_END = new Date('2026-08-21T23:59:59.999Z');

const EVENT_COUNTS = Object.freeze({
  successfulPayments: 4400,
  failedPayments: 900,
  checkoutAbandonments: 500,
  subscriptionFailures: 200,
});

const CUSTOMER_COUNT = 1200;
const SUBSCRIPTION_COUNT = 360;

const firstNames = [
  'Aarav', 'Aditi', 'Akash', 'Ananya', 'Arjun', 'Asha', 'Dev', 'Diya', 'Isha', 'Kabir',
  'Kavya', 'Meera', 'Neha', 'Nikhil', 'Priya', 'Rahul', 'Riya', 'Rohan', 'Sana', 'Vikram',
];
const lastNames = [
  'Agarwal', 'Bansal', 'Chauhan', 'Das', 'Gupta', 'Iyer', 'Jain', 'Kapoor', 'Mehta', 'Nair',
  'Patel', 'Rao', 'Shah', 'Sharma', 'Singh', 'Verma',
];

function createPrng(seed) {
  let state = seed >>> 0;

  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomInt(random, minimum, maximum) {
  return Math.floor(random() * (maximum - minimum + 1)) + minimum;
}

function choose(random, values) {
  return values[randomInt(random, 0, values.length - 1)];
}

function weightedChoose(random, choices) {
  const totalWeight = choices.reduce((total, choice) => total + choice.weight, 0);
  let threshold = random() * totalWeight;

  for (const choice of choices) {
    threshold -= choice.weight;
    if (threshold <= 0) {
      return choice.value;
    }
  }

  return choices.at(-1).value;
}

function shuffle(random, values) {
  const result = [...values];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacementIndex = randomInt(random, 0, index);
    [result[index], result[replacementIndex]] = [result[replacementIndex], result[index]];
  }

  return result;
}

function dateBetween(random, start, end) {
  const timestamp = randomInt(random, start.getTime(), end.getTime());
  return new Date(timestamp);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function buildCustomerProfiles(random, merchantId) {
  const profiles = [];

  for (let index = 1; index <= CUSTOMER_COUNT; index += 1) {
    const segment = weightedChoose(random, [
      { value: 'LOYAL', weight: 24 },
      { value: 'REGULAR', weight: 46 },
      { value: 'NEW', weight: 20 },
      { value: 'HIGH_RISK', weight: 10 },
    ]);

    const successfulPaymentCount = {
      LOYAL: randomInt(random, 8, 28),
      REGULAR: randomInt(random, 3, 14),
      NEW: randomInt(random, 0, 2),
      HIGH_RISK: randomInt(random, 0, 5),
    }[segment];
    const failedPaymentCount = {
      LOYAL: randomInt(random, 0, 2),
      REGULAR: randomInt(random, 1, 4),
      NEW: randomInt(random, 0, 3),
      HIGH_RISK: randomInt(random, 3, 8),
    }[segment];
    const averagePaymentMinor = {
      LOYAL: randomInt(random, 90000, 350000),
      REGULAR: randomInt(random, 50000, 250000),
      NEW: randomInt(random, 30000, 150000),
      HIGH_RISK: randomInt(random, 25000, 180000),
    }[segment];
    const firstName = choose(random, firstNames);
    const lastName = choose(random, lastNames);
    const profileId = new mongoose.Types.ObjectId();
    const emailSlug = `${firstName}.${lastName}.${index}`.toLowerCase();

    profiles.push({
      id: profileId,
      segment,
      document: {
        _id: profileId,
        merchantId,
        externalCustomerId: `customer_demo_${String(index).padStart(4, '0')}`,
        providerCustomerId: `cust_demo_${String(index).padStart(4, '0')}`,
        fullName: `${firstName} ${lastName}`,
        email: `${emailSlug}@example.test`,
        phone: `+91${randomInt(random, 6000000000, 9999999999)}`,
        communicationConsent: {
          email: random() < 0.94,
          sms: random() < 0.62,
          whatsapp: random() < 0.48,
          updatedAt: dateBetween(random, DATASET_START, DATASET_END),
        },
        paymentHistory: {
          successfulPaymentCount,
          failedPaymentCount,
          completedOrderCount: successfulPaymentCount,
          lifetimeValueMinor: successfulPaymentCount * averagePaymentMinor,
          lastSuccessfulPaymentAt: dateBetween(random, DATASET_START, DATASET_END),
          lastFailedPaymentAt: dateBetween(random, DATASET_START, DATASET_END),
        },
      },
    });
  }

  return profiles;
}

function buildSubscriptions(random, merchantId, customerProfiles) {
  const selectedProfiles = shuffle(random, customerProfiles).slice(0, SUBSCRIPTION_COUNT);

  return selectedProfiles.map((profile, index) => ({
    _id: new mongoose.Types.ObjectId(),
    merchantId,
    customerId: profile.id,
    providerSubscriptionId: `sub_demo_${String(index + 1).padStart(4, '0')}`,
    status: random() < 0.88 ? 'ACTIVE' : 'PAUSED',
    planName: choose(random, ['Growth Monthly', 'Pro Monthly', 'Business Annual']),
    amountMinor: choose(random, [29900, 49900, 79900, 99900, 149900]),
    currency: 'INR',
    intervalUnit: random() < 0.9 ? 'MONTH' : 'YEAR',
    intervalCount: 1,
    failureCount: 0,
    nextBillingAt: dateBetween(random, DATASET_START, DATASET_END),
    startedAt: dateBetween(random, new Date('2025-01-01T00:00:00.000Z'), DATASET_START),
  }));
}

function paymentFailureDetails(random) {
  return weightedChoose(random, [
    {
      value: {
        category: 'NETWORK_ERROR',
        code: 'NETWORK_TIMEOUT',
        reason: 'The bank response timed out during authorization.',
        stage: 'AUTHORIZATION',
        method: choose(random, ['UPI', 'CARD', 'NETBANKING']),
      },
      weight: 36,
    },
    {
      value: {
        category: 'BANK_DECLINED',
        code: 'BANK_DECLINED',
        reason: 'The issuing bank declined the payment attempt.',
        stage: 'AUTHORIZATION',
        method: choose(random, ['CARD', 'UPI']),
      },
      weight: 26,
    },
    {
      value: {
        category: 'INSUFFICIENT_FUNDS',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'The selected payment source did not have sufficient funds.',
        stage: 'AUTHORIZATION',
        method: choose(random, ['CARD', 'UPI', 'NETBANKING']),
      },
      weight: 20,
    },
    {
      value: {
        category: 'AUTHENTICATION_FAILED',
        code: 'AUTHENTICATION_FAILED',
        reason: 'Payment authentication was not completed.',
        stage: 'AUTHORIZATION',
        method: choose(random, ['CARD', 'UPI']),
      },
      weight: 11,
    },
    {
      value: {
        category: 'PROCESSING_ERROR',
        code: 'PROCESSING_ERROR',
        reason: 'The payment provider could not process the request.',
        stage: 'CAPTURE',
        method: choose(random, ['CARD', 'UPI', 'NETBANKING']),
      },
      weight: 7,
    },
  ]);
}

function subscriptionFailureDetails(random) {
  const details = paymentFailureDetails(random);

  if (random() < 0.36) {
    return {
      category: 'MANDATE_ERROR',
      code: 'MANDATE_DECLINED',
      reason: 'The recurring-payment mandate could not be completed.',
      stage: 'MANDATE',
      method: 'UNKNOWN',
    };
  }

  return details;
}

function recoveryActionFor(caseType, failureCategory) {
  if (caseType === 'CHECKOUT_ABANDONMENT') {
    return 'RECOVERY_LINK';
  }

  if (failureCategory === 'NETWORK_ERROR' || failureCategory === 'PROCESSING_ERROR') {
    return 'PAYMENT_RETRY';
  }

  if (failureCategory === 'INSUFFICIENT_FUNDS') {
    return 'DELAYED_RETRY';
  }

  if (failureCategory === 'AUTHENTICATION_FAILED') {
    return 'RECOVERY_LINK';
  }

  if (failureCategory === 'BANK_DECLINED' || failureCategory === 'MANDATE_ERROR') {
    return 'ALTERNATIVE_PAYMENT';
  }

  return 'FOLLOW_UP';
}

function recoveryProbability(profile, caseType, failureCategory, amountMinor) {
  let probability = {
    LOYAL: 0.7,
    REGULAR: 0.52,
    NEW: 0.36,
    HIGH_RISK: 0.16,
  }[profile.segment];

  probability += {
    NETWORK_ERROR: 0.18,
    PROCESSING_ERROR: 0.12,
    BANK_DECLINED: 0.02,
    INSUFFICIENT_FUNDS: -0.18,
    AUTHENTICATION_FAILED: -0.1,
    MANDATE_ERROR: -0.04,
  }[failureCategory] ?? 0;

  if (caseType === 'CHECKOUT_ABANDONMENT') {
    probability += 0.06;
  }

  if (caseType === 'SUBSCRIPTION_PAYMENT_FAILURE') {
    probability += 0.04;
  }

  if (amountMinor >= 500000) {
    probability -= 0.12;
  }

  return clamp(probability, 0.05, 0.92);
}

function auditEventTypeFor(caseType) {
  return {
    PAYMENT_FAILURE: 'PAYMENT_FAILURE_DETECTED',
    CHECKOUT_ABANDONMENT: 'CHECKOUT_ABANDONED_DETECTED',
    SUBSCRIPTION_PAYMENT_FAILURE: 'SUBSCRIPTION_PAYMENT_FAILED',
  }[caseType];
}

function createAuditEvents(caseDocument, sourceTransaction, recoveryTransaction) {
  const baseTime = sourceTransaction.occurredAt;
  const entries = [
    {
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'SYSTEM',
      eventType: auditEventTypeFor(caseDocument.type),
      result: 'INFO',
      message: 'Revenue-at-risk event detected and normalized.',
      metadata: {
        amountMinor: String(caseDocument.amountAtRiskMinor),
        caseType: caseDocument.type,
      },
      externalEventId: sourceTransaction.providerEventId,
      occurredAt: baseTime,
    },
    {
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'SYSTEM',
      eventType: 'RECOVERY_CASE_CREATED',
      result: 'INFO',
      message: 'Recovery case created within the merchant recovery window.',
      occurredAt: addMinutes(baseTime, 1),
    },
    {
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'AI_AGENT',
      eventType: 'AI_ANALYSIS_COMPLETED',
      result: 'INFO',
      message: 'Synthetic decision record created for the demo dataset.',
      metadata: {
        decision: caseDocument.agentDecision.action,
        confidence: String(caseDocument.agentDecision.confidence),
      },
      occurredAt: addMinutes(baseTime, 2),
    },
    {
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'POLICY_ENGINE',
      eventType: 'POLICY_VALIDATED',
      action: caseDocument.currentAction,
      result: caseDocument.eligibleAmountMinor > 0 ? 'SUCCEEDED' : 'REJECTED',
      message: caseDocument.eligibleAmountMinor > 0
        ? 'Recovery action is within the configured limits.'
        : 'Recovery case is not eligible for automated action.',
      occurredAt: addMinutes(baseTime, 3),
    },
  ];

  if (caseDocument.eligibleAmountMinor > 0) {
    entries.push({
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'RECOVERY_ENGINE',
      eventType: 'RECOVERY_ACTION_EXECUTED',
      action: caseDocument.currentAction,
      result: caseDocument.status === 'ACTION_SCHEDULED' ? 'PENDING' : 'SUCCEEDED',
      message: 'Bounded recovery action recorded for the demo workflow.',
      occurredAt: addMinutes(baseTime, 4),
    });
  }

  if (recoveryTransaction) {
    entries.push(
      {
        merchantId: caseDocument.merchantId,
        recoveryCaseId: caseDocument._id,
        transactionId: recoveryTransaction._id,
        subscriptionId: caseDocument.subscriptionId,
        actorType: 'RAZORPAY',
        eventType: 'PAYMENT_SUCCEEDED',
        action: caseDocument.currentAction,
        result: 'SUCCEEDED',
        message: 'Synthetic provider event verifies that the recovery payment succeeded.',
        metadata: { recoveredAmountMinor: String(caseDocument.recoveredAmountMinor) },
        externalEventId: recoveryTransaction.providerEventId,
        occurredAt: recoveryTransaction.occurredAt,
      },
      {
        merchantId: caseDocument.merchantId,
        recoveryCaseId: caseDocument._id,
        transactionId: recoveryTransaction._id,
        subscriptionId: caseDocument.subscriptionId,
        actorType: 'SYSTEM',
        eventType: 'RECOVERY_COMPLETED',
        result: 'SUCCEEDED',
        message: 'Recovered amount recorded from the verified synthetic provider result.',
        metadata: { recoveredAmountMinor: String(caseDocument.recoveredAmountMinor) },
        occurredAt: addMinutes(recoveryTransaction.occurredAt, 1),
      },
    );
  } else if (caseDocument.status === 'ESCALATED') {
    entries.push({
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'SYSTEM',
      eventType: 'RECOVERY_ESCALATED',
      action: 'ESCALATE',
      result: 'PENDING',
      message: 'Automated recovery requires merchant intervention.',
      occurredAt: addMinutes(baseTime, 2880),
    });
  } else if (['STOPPED', 'EXPIRED', 'FAILED'].includes(caseDocument.status)) {
    entries.push({
      merchantId: caseDocument.merchantId,
      recoveryCaseId: caseDocument._id,
      transactionId: sourceTransaction._id,
      subscriptionId: caseDocument.subscriptionId,
      actorType: 'SYSTEM',
      eventType: 'RECOVERY_STOPPED',
      action: 'STOP',
      result: 'SKIPPED',
      message: 'Automated recovery stopped within the configured policy limits.',
      occurredAt: addMinutes(baseTime, 2880),
    });
  }

  return entries;
}

function buildDemoDataset() {
  const random = createPrng(DATASET_SEED);
  const merchantId = new mongoose.Types.ObjectId();
  const customerProfiles = buildCustomerProfiles(random, merchantId);
  const subscriptions = buildSubscriptions(random, merchantId, customerProfiles);
  const transactions = [];
  const recoveryCases = [];
  const auditLogs = [];
  const subscriptionById = new Map(subscriptions.map((subscription) => [String(subscription._id), subscription]));

  const merchant = {
    _id: merchantId,
    displayName: 'Demo Revenue Operations Merchant',
    email: DEMO_MERCHANT_EMAIL,
    passwordHash: '$2b$12$X2eFOruSBVeTFeJC0ebZreXPQYnNkfOVypCjdCsgOhJTJaLrXLpTe',
    role: 'OWNER',
    status: 'ACTIVE',
  };

  let sourceSequence = 1;
  let recoverySequence = 1;

  function sourceIdentifiers() {
    const formatted = String(sourceSequence).padStart(6, '0');
    sourceSequence += 1;
    return {
      providerOrderId: `order_demo_${formatted}`,
      providerPaymentId: `pay_demo_${formatted}`,
      providerEventId: `evt_demo_${formatted}`,
    };
  }

  function addSuccessfulPayment() {
    const profile = choose(random, customerProfiles);
    const identifiers = sourceIdentifiers();

    transactions.push({
      _id: new mongoose.Types.ObjectId(),
      merchantId,
      customerId: profile.id,
      type: 'PAYMENT',
      status: 'CAPTURED',
      amountMinor: choose(random, [29900, 49900, 79900, 99900, 149900, 199900, 299900, 499900]),
      currency: 'INR',
      source: 'SYNTHETIC',
      providerStatus: 'captured',
      ...identifiers,
      paymentMethod: choose(random, ['UPI', 'CARD', 'NETBANKING']),
      occurredAt: dateBetween(random, DATASET_START, DATASET_END),
    });
  }

  function addAtRiskEvent(caseType, subscription) {
    const profile = subscription
      ? customerProfiles.find((candidate) => String(candidate.id) === String(subscription.customerId))
      : choose(random, customerProfiles);
    const identifiers = sourceIdentifiers();
    const occurredAt = dateBetween(random, DATASET_START, DATASET_END);
    const amountMinor = subscription
      ? subscription.amountMinor
      : caseType === 'CHECKOUT_ABANDONMENT'
        ? choose(random, [59900, 89900, 149900, 249900, 449900, 749900])
        : choose(random, [49900, 99900, 149900, 299900, 499900, 999900]);
    const failure = caseType === 'CHECKOUT_ABANDONMENT'
      ? null
      : caseType === 'SUBSCRIPTION_PAYMENT_FAILURE'
        ? subscriptionFailureDetails(random)
        : paymentFailureDetails(random);
    const sourceTransactionId = new mongoose.Types.ObjectId();
    const recoveryCaseId = new mongoose.Types.ObjectId();
    const failureCategory = failure?.category ?? 'UNKNOWN';
    const recommendedAction = recoveryActionFor(caseType, failureCategory);
    const automatedEligible = profile.document.communicationConsent.email
      && (profile.segment !== 'HIGH_RISK' || random() > 0.42)
      && random() > 0.07;
    const recoveryChance = recoveryProbability(profile, caseType, failureCategory, amountMinor);
    const wasRecovered = automatedEligible && random() < recoveryChance;
    let status;
    let currentAction = recommendedAction;
    let retryAttemptCount = 0;
    let reminderCount = 0;
    let nextActionAt;
    let recoveredAt;
    let stopReason;
    let escalationReason;

    if (!automatedEligible) {
      status = 'STOPPED';
      currentAction = 'STOP';
      stopReason = profile.document.communicationConsent.email
        ? 'Customer profile is outside the automated recovery policy.'
        : 'Customer communication consent is unavailable for recovery outreach.';
    } else if (wasRecovered) {
      status = 'RECOVERED';
      retryAttemptCount = ['PAYMENT_RETRY', 'DELAYED_RETRY'].includes(recommendedAction) ? 1 : 0;
      reminderCount = ['RECOVERY_LINK', 'FOLLOW_UP', 'ALTERNATIVE_PAYMENT'].includes(recommendedAction) ? 1 : 0;
      recoveredAt = addMinutes(occurredAt, randomInt(random, 20, 2400));
    } else {
      const terminalState = weightedChoose(random, [
        { value: 'ESCALATED', weight: 24 },
        { value: 'STOPPED', weight: 30 },
        { value: 'EXPIRED', weight: 21 },
        { value: 'ACTION_SCHEDULED', weight: 25 },
      ]);
      status = terminalState;
      retryAttemptCount = ['PAYMENT_RETRY', 'DELAYED_RETRY'].includes(recommendedAction)
        ? randomInt(random, 1, 2)
        : 0;
      reminderCount = ['RECOVERY_LINK', 'FOLLOW_UP', 'ALTERNATIVE_PAYMENT'].includes(recommendedAction)
        ? randomInt(random, 1, 2)
        : randomInt(random, 0, 1);

      if (status === 'ESCALATED') {
        currentAction = 'ESCALATE';
        escalationReason = 'Automated recovery exhausted before the recovery window closed.';
      } else if (status === 'STOPPED' || status === 'EXPIRED') {
        currentAction = 'STOP';
        stopReason = status === 'EXPIRED'
          ? 'Recovery window expired without a verified payment result.'
          : 'Configured retry and reminder limits were reached.';
      } else {
        nextActionAt = addMinutes(occurredAt, randomInt(random, 120, 2400));
      }
    }

    const sourceTransaction = {
      _id: sourceTransactionId,
      merchantId,
      customerId: profile.id,
      subscriptionId: subscription?._id,
      recoveryCaseId,
      type: caseType === 'CHECKOUT_ABANDONMENT'
        ? 'CHECKOUT'
        : caseType === 'SUBSCRIPTION_PAYMENT_FAILURE'
          ? 'SUBSCRIPTION_PAYMENT'
          : 'PAYMENT',
      status: caseType === 'CHECKOUT_ABANDONMENT' ? 'ABANDONED' : 'FAILED',
      amountMinor,
      currency: 'INR',
      source: 'SYNTHETIC',
      providerStatus: caseType === 'CHECKOUT_ABANDONMENT' ? 'abandoned' : 'failed',
      ...identifiers,
      failureCategory: failure?.category,
      failureCode: failure?.code,
      failureReason: failure?.reason,
      failureStage: caseType === 'CHECKOUT_ABANDONMENT' ? 'CHECKOUT' : failure.stage,
      paymentMethod: caseType === 'CHECKOUT_ABANDONMENT'
        ? choose(random, ['UPI', 'CARD', 'NETBANKING'])
        : failure.method,
      occurredAt,
    };

    const recoveryCase = {
      _id: recoveryCaseId,
      merchantId,
      customerId: profile.id,
      sourceTransactionId,
      subscriptionId: subscription?._id,
      type: caseType,
      status,
      amountAtRiskMinor: amountMinor,
      eligibleAmountMinor: automatedEligible ? amountMinor : 0,
      recoveredAmountMinor: wasRecovered ? amountMinor : 0,
      currency: 'INR',
      retryAttemptCount,
      reminderCount,
      currentAction,
      nextActionAt,
      recoveryWindowEndsAt: addMinutes(occurredAt, 2880),
      policySnapshot: {
        maxPaymentRetries: 2,
        maxReminders: 2,
        recoveryWindowHours: 48,
      },
      agentDecision: {
        action: currentAction,
        confidence: Number(clamp(0.52 + recoveryChance * 0.42 + random() * 0.05, 0.5, 0.98).toFixed(2)),
        reasonCode: caseType === 'CHECKOUT_ABANDONMENT'
          ? 'HIGH_VALUE_ABANDONED_CHECKOUT'
          : failureCategory,
        rationale: `${profile.segment} customer profile with ${failureCategory.toLowerCase().replaceAll('_', ' ')} context.`,
        customerMessage: automatedEligible
          ? 'Your payment could not be completed. You can continue securely using the recovery option.'
          : undefined,
        nextActionAt,
        stopCondition: 'MAX_RETRIES_OR_RECOVERY_WINDOW',
        analyzedAt: addMinutes(occurredAt, 2),
      },
      recoveredAt,
      stopReason,
      escalationReason,
    };

    let recoveryTransaction;
    if (wasRecovered) {
      const formatted = String(recoverySequence).padStart(6, '0');
      recoverySequence += 1;
      const recoveryTransactionId = new mongoose.Types.ObjectId();

      recoveryTransaction = {
        _id: recoveryTransactionId,
        merchantId,
        customerId: profile.id,
        subscriptionId: subscription?._id,
        recoveryCaseId,
        type: caseType === 'SUBSCRIPTION_PAYMENT_FAILURE' ? 'SUBSCRIPTION_PAYMENT' : 'PAYMENT',
        status: 'CAPTURED',
        amountMinor,
        currency: 'INR',
        source: 'SYNTHETIC',
        providerStatus: 'captured',
        providerOrderId: `order_recovery_${formatted}`,
        providerPaymentId: `pay_recovery_${formatted}`,
        providerEventId: `evt_recovery_${formatted}`,
        paymentMethod: recommendedAction === 'ALTERNATIVE_PAYMENT'
          ? choose(random, ['UPI', 'NETBANKING'])
          : sourceTransaction.paymentMethod,
        occurredAt: recoveredAt,
      };
      recoveryCase.recoveryTransactionId = recoveryTransactionId;

      if (subscription) {
        subscription.status = 'ACTIVE';
        subscription.lastPaymentTransactionId = recoveryTransactionId;
      }
    }

    if (subscription) {
      subscription.failureCount += 1;
      if (!wasRecovered && subscription.status === 'ACTIVE') {
        subscription.status = 'PAST_DUE';
      }
      if (['ACTION_SCHEDULED', 'RECOVERY_PENDING'].includes(status)) {
        subscription.activeRecoveryCaseId = recoveryCaseId;
      }
    }

    transactions.push(sourceTransaction);
    if (recoveryTransaction) {
      transactions.push(recoveryTransaction);
    }
    recoveryCases.push(recoveryCase);
    auditLogs.push(...createAuditEvents(recoveryCase, sourceTransaction, recoveryTransaction));
  }

  for (let index = 0; index < EVENT_COUNTS.successfulPayments; index += 1) {
    addSuccessfulPayment();
  }

  for (let index = 0; index < EVENT_COUNTS.failedPayments; index += 1) {
    addAtRiskEvent('PAYMENT_FAILURE');
  }

  for (let index = 0; index < EVENT_COUNTS.checkoutAbandonments; index += 1) {
    addAtRiskEvent('CHECKOUT_ABANDONMENT');
  }

  for (let index = 0; index < EVENT_COUNTS.subscriptionFailures; index += 1) {
    addAtRiskEvent('SUBSCRIPTION_PAYMENT_FAILURE', subscriptions[index]);
  }

  return {
    merchant,
    customerDocuments: customerProfiles.map((profile) => profile.document),
    subscriptions,
    transactions,
    recoveryCases,
    auditLogs,
    sourceEventCount: sourceSequence - 1,
    recoveredTransactionCount: recoverySequence - 1,
    subscriptionById,
  };
}

function validateDataset(dataset) {
  const expectedAtRiskCases = EVENT_COUNTS.failedPayments
    + EVENT_COUNTS.checkoutAbandonments
    + EVENT_COUNTS.subscriptionFailures;
  const transactionIds = new Set(dataset.transactions.map((transaction) => String(transaction._id)));
  const recoveryTransactionIds = new Set(
    dataset.transactions
      .filter((transaction) => transaction.providerPaymentId?.startsWith('pay_recovery_'))
      .map((transaction) => String(transaction._id)),
  );
  const providerEventIds = dataset.transactions.map((transaction) => transaction.providerEventId);

  assert.equal(dataset.sourceEventCount, 6000, 'Synthetic source event count must remain deterministic.');
  assert.equal(dataset.recoveryCases.length, expectedAtRiskCases, 'Every at-risk source event needs one recovery case.');
  assert.ok(dataset.transactions.length >= 6000, 'Dataset must contain at least 5,000 revenue events.');
  assert.equal(new Set(providerEventIds).size, providerEventIds.length, 'Provider event identifiers must be unique.');
  assert.ok(dataset.auditLogs.length > dataset.recoveryCases.length * 4, 'Cases need a meaningful audit trail.');

  for (const recoveryCase of dataset.recoveryCases) {
    assert.ok(transactionIds.has(String(recoveryCase.sourceTransactionId)), 'Case source transaction must exist.');
    assert.ok(recoveryCase.eligibleAmountMinor <= recoveryCase.amountAtRiskMinor);
    assert.ok(recoveryCase.recoveredAmountMinor <= recoveryCase.amountAtRiskMinor);
    assert.ok(recoveryCase.retryAttemptCount <= recoveryCase.policySnapshot.maxPaymentRetries);
    assert.ok(recoveryCase.reminderCount <= recoveryCase.policySnapshot.maxReminders);

    if (recoveryCase.status === 'RECOVERED') {
      assert.ok(recoveryCase.recoveryTransactionId, 'Recovered cases need a verified recovery transaction.');
      assert.ok(recoveryTransactionIds.has(String(recoveryCase.recoveryTransactionId)));
      assert.equal(recoveryCase.recoveredAmountMinor, recoveryCase.amountAtRiskMinor);
    }
  }
}

function summarizeDataset(dataset) {
  const recoveredCases = dataset.recoveryCases.filter((recoveryCase) => recoveryCase.status === 'RECOVERED');
  const revenueAtRiskMinor = dataset.recoveryCases
    .reduce((total, recoveryCase) => total + recoveryCase.amountAtRiskMinor, 0);
  const revenueRecoveredMinor = recoveredCases
    .reduce((total, recoveryCase) => total + recoveryCase.recoveredAmountMinor, 0);

  return {
    sourceRevenueEvents: dataset.sourceEventCount,
    storedTransactions: dataset.transactions.length,
    customers: dataset.customerDocuments.length,
    subscriptions: dataset.subscriptions.length,
    recoveryCases: dataset.recoveryCases.length,
    recoveredCases: recoveredCases.length,
    auditLogs: dataset.auditLogs.length,
    revenueAtRiskMinor,
    revenueRecoveredMinor,
    recoveryRatePercent: Number(((recoveredCases.length / dataset.recoveryCases.length) * 100).toFixed(2)),
  };
}

async function removeExistingDemoData(merchantId) {
  await AuditLog.deleteMany({ merchantId });
  await RecoveryCase.deleteMany({ merchantId });
  await Transaction.deleteMany({ merchantId });
  await Subscription.deleteMany({ merchantId });
  await Customer.deleteMany({ merchantId });
  await User.deleteOne({ _id: merchantId });
}

async function persistDataset(dataset, shouldReset) {
  await Promise.all([
    User.init(),
    Customer.init(),
    Transaction.init(),
    Subscription.init(),
    RecoveryCase.init(),
    AuditLog.init(),
  ]);

  const existingMerchant = await User.findOne({ email: DEMO_MERCHANT_EMAIL }).select('_id').lean();

  if (existingMerchant && !shouldReset) {
    throw new Error('Demo data already exists. Run "npm.cmd run seed:demo -- --reset" to replace only the demo dataset.');
  }

  if (existingMerchant) {
    await removeExistingDemoData(existingMerchant._id);
  }

  await User.create(dataset.merchant);
  await Customer.insertMany(dataset.customerDocuments, { ordered: true });
  await Subscription.insertMany(dataset.subscriptions, { ordered: true });
  await Transaction.insertMany(dataset.transactions, { ordered: true });
  await RecoveryCase.insertMany(dataset.recoveryCases, { ordered: true });
  await AuditLog.insertMany(dataset.auditLogs, { ordered: true });
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const isDryRun = argumentsList.includes('--dry-run');
  const shouldReset = argumentsList.includes('--reset');
  const dataset = buildDemoDataset();

  validateDataset(dataset);
  const summary = summarizeDataset(dataset);

  if (isDryRun) {
    console.info('Synthetic dataset dry run passed. No database records were written.');
    console.info(JSON.stringify(summary, null, 2));
    return;
  }

  configureDnsServers();
  const isConnected = await connectToDatabase();

  if (!isConnected) {
    throw new Error('MongoDB is unavailable. Configure MONGODB_URI before running the seed command.');
  }

  try {
    await persistDataset(dataset, shouldReset);
    console.info('Synthetic demo dataset created successfully.');
    console.info(JSON.stringify(summary, null, 2));
  } finally {
    await disconnectFromDatabase();
  }
}

main().catch((error) => {
  console.error('Synthetic data seed failed:', error.stack || error.message);
  process.exitCode = 1;
});
