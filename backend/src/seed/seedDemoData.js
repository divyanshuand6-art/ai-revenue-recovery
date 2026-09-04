const assert = require('node:assert/strict');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

dotenv.config({
  path: path.resolve(
    __dirname,
    '..',
    '..',
    '.env',
  ),
});

const {
  connectToDatabase,
  disconnectFromDatabase,
} = require('../config/db');

const {
  configureDnsServers,
} = require('../config/dns');

const AuditLog =
  require('../models/AuditLog');

const RecoveryCase =
  require('../models/RecoveryCase');

const Customer =
  require('../models/Customer');

const Subscription =
  require('../models/Subscription');

const Transaction =
  require('../models/Transaction');

const User =
  require('../models/User');

/*
 * =========================================================
 * FRESH TEST DATASET
 * =========================================================
 */

const DATASET_SEED = 20260904;

const DEMO_MERCHANT_EMAIL =
  'demo@revenue-recovery.test';

const DATASET_START = new Date(
  '2026-08-05T00:00:00.000Z',
);

const DATASET_END = new Date(
  '2026-09-04T23:59:59.999Z',
);

/*
 * 10 source successful payments
 * 10 source revenue-at-risk events
 *
 * Total source events = 20
 * Recovery cases = 0 BEFORE REVENUE RISK DETECTION
 */
const EVENT_COUNTS = Object.freeze({
  successfulPayments: 10,
  failedPayments: 4,
  checkoutAbandonments: 3,
  subscriptionFailures: 3,
});

const CUSTOMER_COUNT = 10;

const SUBSCRIPTION_COUNT = 4;

/*
 * =========================================================
 * DEMO CUSTOMER DATA
 * =========================================================
 */

const firstNames = [
  'Aarav',
  'Aditi',
  'Akash',
  'Ananya',
  'Arjun',
  'Asha',
  'Dev',
  'Diya',
  'Isha',
  'Kabir',
  'Kavya',
  'Meera',
  'Neha',
  'Nikhil',
  'Priya',
  'Rahul',
  'Riya',
  'Rohan',
  'Sana',
  'Vikram',
];

const lastNames = [
  'Agarwal',
  'Bansal',
  'Chauhan',
  'Das',
  'Gupta',
  'Iyer',
  'Jain',
  'Kapoor',
  'Mehta',
  'Nair',
  'Patel',
  'Rao',
  'Shah',
  'Sharma',
  'Singh',
  'Verma',
];

/*
 * =========================================================
 * DETERMINISTIC RANDOM HELPERS
 * =========================================================
 */

function createPrng(seed) {
  let state = seed >>> 0;

  return function random() {
    state =
      (state * 1664525 + 1013904223) >>>
      0;

    return state / 4294967296;
  };
}

function randomInt(
  random,
  minimum,
  maximum,
) {
  return (
    Math.floor(
      random() *
        (maximum - minimum + 1),
    ) + minimum
  );
}

function choose(
  random,
  values,
) {
  return values[
    randomInt(
      random,
      0,
      values.length - 1,
    )
  ];
}

function weightedChoose(
  random,
  choices,
) {
  const totalWeight =
    choices.reduce(
      (total, choice) =>
        total + choice.weight,
      0,
    );

  let threshold =
    random() * totalWeight;

  for (const choice of choices) {
    threshold -= choice.weight;

    if (threshold <= 0) {
      return choice.value;
    }
  }

  return choices.at(-1).value;
}

function shuffle(
  random,
  values,
) {
  const result = [...values];

  for (
    let index =
      result.length - 1;
    index > 0;
    index -= 1
  ) {
    const replacementIndex =
      randomInt(
        random,
        0,
        index,
      );

    [
      result[index],
      result[replacementIndex],
    ] = [
      result[replacementIndex],
      result[index],
    ];
  }

  return result;
}

function dateBetween(
  random,
  start,
  end,
) {
  const timestamp =
    randomInt(
      random,
      start.getTime(),
      end.getTime(),
    );

  return new Date(timestamp);
}

function addMinutes(
  date,
  minutes,
) {
  return new Date(
    date.getTime() +
      minutes * 60 * 1000,
  );
}

/*
 * =========================================================
 * CUSTOMER PROFILES
 * =========================================================
 */

function buildCustomerProfiles(
  random,
  merchantId,
) {
  const profiles = [];

  for (
    let index = 1;
    index <= CUSTOMER_COUNT;
    index += 1
  ) {
    const segment =
      weightedChoose(
        random,
        [
          {
            value: 'LOYAL',
            weight: 24,
          },
          {
            value: 'REGULAR',
            weight: 46,
          },
          {
            value: 'NEW',
            weight: 20,
          },
          {
            value: 'HIGH_RISK',
            weight: 10,
          },
        ],
      );

    const successfulPaymentCount =
      {
        LOYAL:
          randomInt(
            random,
            8,
            28,
          ),

        REGULAR:
          randomInt(
            random,
            3,
            14,
          ),

        NEW:
          randomInt(
            random,
            0,
            2,
          ),

        HIGH_RISK:
          randomInt(
            random,
            0,
            5,
          ),
      }[segment];

    const failedPaymentCount =
      {
        LOYAL:
          randomInt(
            random,
            0,
            2,
          ),

        REGULAR:
          randomInt(
            random,
            1,
            4,
          ),

        NEW:
          randomInt(
            random,
            0,
            3,
          ),

        HIGH_RISK:
          randomInt(
            random,
            3,
            8,
          ),
      }[segment];

    const averagePaymentMinor =
      {
        LOYAL:
          randomInt(
            random,
            90000,
            350000,
          ),

        REGULAR:
          randomInt(
            random,
            50000,
            250000,
          ),

        NEW:
          randomInt(
            random,
            30000,
            150000,
          ),

        HIGH_RISK:
          randomInt(
            random,
            25000,
            180000,
          ),
      }[segment];

    const firstName =
      choose(
        random,
        firstNames,
      );

    const lastName =
      choose(
        random,
        lastNames,
      );

    const profileId =
      new mongoose.Types.ObjectId();

    const emailSlug =
      `${firstName}.${lastName}.${index}`.toLowerCase();

    profiles.push({
      id: profileId,

      segment,

      document: {
        _id: profileId,

        merchantId,

        externalCustomerId:
          `customer_demo_${String(
            index,
          ).padStart(4, '0')}`,

        providerCustomerId:
          `cust_demo_${String(
            index,
          ).padStart(4, '0')}`,

        fullName:
          `${firstName} ${lastName}`,

        email:
          `${emailSlug}@example.test`,

        phone:
          `+91${randomInt(
            random,
            6000000000,
            9999999999,
          )}`,

        /*
         * ALL 10 customers have email
         * communication consent so all
         * recovery cases remain eligible.
         */
        communicationConsent: {
          email: true,

          sms:
            random() < 0.62,

          whatsapp:
            random() < 0.48,

          updatedAt:
            dateBetween(
              random,
              DATASET_START,
              DATASET_END,
            ),
        },

        paymentHistory: {
          successfulPaymentCount,

          failedPaymentCount,

          completedOrderCount:
            successfulPaymentCount,

          lifetimeValueMinor:
            successfulPaymentCount *
            averagePaymentMinor,

          lastSuccessfulPaymentAt:
            dateBetween(
              random,
              DATASET_START,
              DATASET_END,
            ),

          lastFailedPaymentAt:
            dateBetween(
              random,
              DATASET_START,
              DATASET_END,
            ),
        },
      },
    });
  }

  return profiles;
}

/*
 * =========================================================
 * SUBSCRIPTIONS
 * =========================================================
 */

function buildSubscriptions(
  random,
  merchantId,
  customerProfiles,
) {
  const selectedProfiles =
    shuffle(
      random,
      customerProfiles,
    ).slice(
      0,
      SUBSCRIPTION_COUNT,
    );

  return selectedProfiles.map(
    (profile, index) => ({
      _id:
        new mongoose.Types.ObjectId(),

      merchantId,

      customerId:
        profile.id,

      providerSubscriptionId:
        `sub_demo_${String(
          index + 1,
        ).padStart(4, '0')}`,

      /*
       * Keep seeded subscriptions active.
       * Their failure transactions below
       * will mark them PAST_DUE.
       */
      status: 'ACTIVE',

      planName:
        choose(
          random,
          [
            'Growth Monthly',
            'Pro Monthly',
            'Business Annual',
          ],
        ),

      amountMinor:
        choose(
          random,
          [
            29900,
            49900,
            79900,
            99900,
            149900,
          ],
        ),

      currency:
        'INR',

      intervalUnit:
        random() < 0.9
          ? 'MONTH'
          : 'YEAR',

      intervalCount:
        1,

      failureCount:
        0,

      nextBillingAt:
        dateBetween(
          random,
          DATASET_START,
          DATASET_END,
        ),

      startedAt:
        dateBetween(
          random,
          new Date(
            '2025-01-01T00:00:00.000Z',
          ),
          DATASET_START,
        ),
    }),
  );
}

/*
 * =========================================================
 * FAILURE GENERATORS
 * =========================================================
 */

function paymentFailureDetails(
  random,
) {
  return weightedChoose(
    random,
    [
      {
        value: {
          category:
            'NETWORK_ERROR',

          code:
            'NETWORK_TIMEOUT',

          reason:
            'The bank response timed out during authorization.',

          stage:
            'AUTHORIZATION',

          method:
            choose(
              random,
              [
                'UPI',
                'CARD',
                'NETBANKING',
              ],
            ),
        },

        weight: 36,
      },

      {
        value: {
          category:
            'BANK_DECLINED',

          code:
            'BANK_DECLINED',

          reason:
            'The issuing bank declined the payment attempt.',

          stage:
            'AUTHORIZATION',

          method:
            choose(
              random,
              [
                'CARD',
                'UPI',
              ],
            ),
        },

        weight: 26,
      },

      {
        value: {
          category:
            'INSUFFICIENT_FUNDS',

          code:
            'INSUFFICIENT_FUNDS',

          reason:
            'The selected payment source did not have sufficient funds.',

          stage:
            'AUTHORIZATION',

          method:
            choose(
              random,
              [
                'CARD',
                'UPI',
                'NETBANKING',
              ],
            ),
        },

        weight: 20,
      },

      {
        value: {
          category:
            'AUTHENTICATION_FAILED',

          code:
            'AUTHENTICATION_FAILED',

          reason:
            'Payment authentication was not completed.',

          stage:
            'AUTHORIZATION',

          method:
            choose(
              random,
              [
                'CARD',
                'UPI',
              ],
            ),
        },

        weight: 11,
      },

      {
        value: {
          category:
            'PROCESSING_ERROR',

          code:
            'PROCESSING_ERROR',

          reason:
            'The payment provider could not process the request.',

          stage:
            'CAPTURE',

          method:
            choose(
              random,
              [
                'CARD',
                'UPI',
                'NETBANKING',
              ],
            ),
        },

        weight: 7,
      },
    ],
  );
}

function subscriptionFailureDetails(
  random,
) {
  if (random() < 0.36) {
    return {
      category:
        'MANDATE_ERROR',

      code:
        'MANDATE_DECLINED',

      reason:
        'The recurring-payment mandate could not be completed.',

      stage:
        'MANDATE',

      method:
        'UNKNOWN',
    };
  }

  return paymentFailureDetails(
    random,
  );
}

/*
 * =========================================================
 * BUILD DATASET
 * =========================================================
 */

function buildDemoDataset() {
  const random =
    createPrng(
      DATASET_SEED,
    );

  const merchantId =
    new mongoose.Types.ObjectId();

  const customerProfiles =
    buildCustomerProfiles(
      random,
      merchantId,
    );

  const subscriptions =
    buildSubscriptions(
      random,
      merchantId,
      customerProfiles,
    );

  const transactions = [];

  /*
   * IMPORTANT:
   * Recovery cases are NOT created by the seed.
   *
   * They are created ONLY after the real
   * Revenue Risk Detection stage analyzes
   * these source transactions.
   */
  const recoveryCases = [];

  const subscriptionById =
    new Map(
      subscriptions.map(
        (subscription) => [
          String(
            subscription._id,
          ),
          subscription,
        ],
      ),
    );

  /*
   * =======================================================
   * DEMO MERCHANT
   * =======================================================
   *
   * Password:
   *
   * Demo@12345
   */

  const merchant = {
    _id:
      merchantId,

    displayName:
      'Demo Revenue Operations Merchant',

    email:
      DEMO_MERCHANT_EMAIL,

    passwordHash:
      bcrypt.hashSync(
        'Demo@12345',
        12,
      ),

    role:
      'OWNER',

    status:
      'ACTIVE',
  };

  let sourceSequence =
    1;

  function sourceIdentifiers() {
    const formatted =
      String(
        sourceSequence,
      ).padStart(
        6,
        '0',
      );

    sourceSequence += 1;

    return {
      providerOrderId:
        `order_demo_${formatted}`,

      providerPaymentId:
        `pay_demo_${formatted}`,

      providerEventId:
        `evt_demo_${formatted}`,
    };
  }

  /*
   * =======================================================
   * SUCCESSFUL SOURCE PAYMENT
   * =======================================================
   */

  function addSuccessfulPayment() {
    const profile =
      choose(
        random,
        customerProfiles,
      );

    const identifiers =
      sourceIdentifiers();

    transactions.push({
      _id:
        new mongoose.Types.ObjectId(),

      merchantId,

      customerId:
        profile.id,

      type:
        'PAYMENT',

      status:
        'CAPTURED',

      amountMinor:
        choose(
          random,
          [
            29900,
            49900,
            79900,
            99900,
            149900,
            199900,
            299900,
            499900,
          ],
        ),

      currency:
        'INR',

      source:
        'SYNTHETIC',

      providerStatus:
        'captured',

      ...identifiers,

      paymentMethod:
        choose(
          random,
          [
            'UPI',
            'CARD',
            'NETBANKING',
          ],
        ),

      occurredAt:
        dateBetween(
          random,
          DATASET_START,
          DATASET_END,
        ),
    });
  }

  /*
   * =======================================================
   * AT-RISK SOURCE EVENT
   * =======================================================
   *
   * These are ONLY source transactions.
   *
   * Recovery cases will be created by
   * revenueRiskDetectionService.js.
   */

  function addAtRiskEvent(
    caseType,
    subscription,
  ) {
    const profile =
      subscription
        ? customerProfiles.find(
            (candidate) =>
              String(
                candidate.id,
              ) ===
              String(
                subscription.customerId,
              ),
          )
        : choose(
            random,
            customerProfiles,
          );

    if (!profile) {
      throw new Error(
        'Customer profile could not be resolved for source transaction.',
      );
    }

    const identifiers =
      sourceIdentifiers();

    /*
     * For Stage 1 testing, source
     * risk events should be recent.
     *
     * This avoids the seeded event being
     * already outside the recovery window.
     */
    const occurredAt =
      new Date();

    const amountMinor =
      subscription
        ? subscription.amountMinor
        : caseType ===
          'CHECKOUT_ABANDONMENT'
          ? choose(
              random,
              [
                59900,
                89900,
                149900,
                249900,
                449900,
                749900,
              ],
            )
          : choose(
              random,
              [
                49900,
                99900,
                149900,
                299900,
                499900,
                999900,
              ],
            );

    const failure =
      caseType ===
      'CHECKOUT_ABANDONMENT'
        ? null
        : caseType ===
          'SUBSCRIPTION_PAYMENT_FAILURE'
          ? subscriptionFailureDetails(
              random,
            )
          : paymentFailureDetails(
              random,
            );

    const sourceTransaction =
      {
        _id:
          new mongoose.Types.ObjectId(),

        merchantId,

        customerId:
          profile.id,

        subscriptionId:
          subscription?._id,

        type:
          caseType ===
          'CHECKOUT_ABANDONMENT'
            ? 'CHECKOUT'
            : caseType ===
              'SUBSCRIPTION_PAYMENT_FAILURE'
              ? 'SUBSCRIPTION_PAYMENT'
              : 'PAYMENT',

        status:
          caseType ===
          'CHECKOUT_ABANDONMENT'
            ? 'ABANDONED'
            : 'FAILED',

        amountMinor,

        currency:
          'INR',

        source:
          'SYNTHETIC',

        providerStatus:
          caseType ===
          'CHECKOUT_ABANDONMENT'
            ? 'abandoned'
            : 'failed',

        ...identifiers,

        failureCategory:
          failure?.category,

        failureCode:
          failure?.code,

        failureReason:
          failure?.reason,

        failureStage:
          caseType ===
          'CHECKOUT_ABANDONMENT'
            ? 'CHECKOUT'
            : failure?.stage,

        paymentMethod:
          caseType ===
          'CHECKOUT_ABANDONMENT'
            ? choose(
                random,
                [
                  'UPI',
                  'CARD',
                  'NETBANKING',
                ],
              )
            : failure?.method,

        occurredAt,
      };

    transactions.push(
      sourceTransaction,
    );
  }

  /*
   * =======================================================
   * GENERATE EXACTLY 20 SOURCE EVENTS
   * =======================================================
   */

  for (
    let index = 0;
    index <
    EVENT_COUNTS.successfulPayments;
    index += 1
  ) {
    addSuccessfulPayment();
  }

  /*
   * 4 PAYMENT FAILURES
   */

  for (
    let index = 0;
    index <
    EVENT_COUNTS.failedPayments;
    index += 1
  ) {
    addAtRiskEvent(
      'PAYMENT_FAILURE',
    );
  }

  /*
   * 3 CHECKOUT ABANDONMENTS
   */

  for (
    let index = 0;
    index <
    EVENT_COUNTS.checkoutAbandonments;
    index += 1
  ) {
    addAtRiskEvent(
      'CHECKOUT_ABANDONMENT',
    );
  }

  /*
   * 3 SUBSCRIPTION FAILURES
   */

  for (
    let index = 0;
    index <
    EVENT_COUNTS.subscriptionFailures;
    index += 1
  ) {
    addAtRiskEvent(
      'SUBSCRIPTION_PAYMENT_FAILURE',
      subscriptions[index],
    );
  }

  return {
    merchant,

    customerDocuments:
      customerProfiles.map(
        (profile) =>
          profile.document,
      ),

    subscriptions,

    transactions,

    recoveryCases,

    sourceEventCount:
      sourceSequence - 1,

    subscriptionById,
  };
}

/*
 * =========================================================
 * VALIDATION
 * =========================================================
 *
 * Fresh seed state:
 *
 * 20 transactions
 * 10 risky transactions
 * 0 recovery cases
 *
 * The actual 10 recovery cases must be
 * created later by Revenue Risk Detection.
 * =========================================================
 */

function validateDataset(
  dataset,
) {
  assert.equal(
    dataset.sourceEventCount,
    20,
    'Synthetic source event count must be exactly 20.',
  );

  assert.equal(
    dataset.transactions.length,
    20,
    'Synthetic test dataset must contain exactly 20 transactions.',
  );

  assert.equal(
    dataset.recoveryCases.length,
    0,
    'Fresh seeded dataset must contain zero recovery cases before risk detection.',
  );

  const recoveryLinkedTransactions =
    dataset.transactions.filter(
      (transaction) =>
        transaction.recoveryCaseId,
    );

  assert.equal(
    recoveryLinkedTransactions.length,
    0,
    'Fresh seeded transactions must not be linked to recovery cases.',
  );

  const providerEventIds =
    dataset.transactions.map(
      (transaction) =>
        transaction.providerEventId,
    );

  assert.equal(
    new Set(providerEventIds).size,
    providerEventIds.length,
    'Provider event identifiers must be unique.',
  );

  const riskySourceTransactions =
    dataset.transactions.filter(
      (transaction) =>
        (
          transaction.status ===
            'FAILED' &&
          [
            'PAYMENT',
            'SUBSCRIPTION_PAYMENT',
          ].includes(
            transaction.type,
          )
        ) ||
        (
          transaction.status ===
            'ABANDONED' &&
          transaction.type ===
            'CHECKOUT'
        ),
    );

  assert.equal(
    riskySourceTransactions.length,
    10,
    'Fresh seeded dataset must contain exactly 10 risky source transactions for Stage 1 detection.',
  );

  /*
   * Every risky source event must carry
   * enough evidence for risk detection.
   */

  for (
    const transaction
      of riskySourceTransactions
  ) {
    assert.ok(
      transaction.amountMinor > 0,
      'Every risky source transaction must have a positive amount.',
    );

    assert.ok(
      transaction.customerId,
      'Every risky source transaction must have a customer.',
    );

    assert.ok(
      transaction.occurredAt,
      'Every risky source transaction must have occurredAt.',
    );

    if (
      transaction.status ===
        'FAILED'
    ) {
      assert.ok(
        transaction.failureCategory,
        'Every failed risky transaction must contain failureCategory.',
      );
    }
  }
}

/*
 * =========================================================
 * SUMMARY
 * =========================================================
 */

function summarizeDataset(
  dataset,
) {
  const recoveredCases =
    dataset.recoveryCases.filter(
      (recoveryCase) =>
        recoveryCase.status ===
        'RECOVERED',
    );

  const revenueAtRiskMinor =
    dataset.recoveryCases.reduce(
      (
        total,
        recoveryCase,
      ) =>
        total +
        recoveryCase.amountAtRiskMinor,
      0,
    );

  const revenueRecoveredMinor =
    recoveredCases.reduce(
      (
        total,
        recoveryCase,
      ) =>
        total +
        recoveryCase.recoveredAmountMinor,
      0,
    );

  return {
    sourceRevenueEvents:
      dataset.sourceEventCount,

    storedTransactions:
      dataset.transactions.length,

    customers:
      dataset.customerDocuments.length,

    subscriptions:
      dataset.subscriptions.length,

    recoveryCases:
      dataset.recoveryCases.length,

    recoveredCases:
      recoveredCases.length,

    revenueAtRiskMinor,

    revenueRecoveredMinor,

    recoveryRatePercent:
      dataset.recoveryCases.length >
      0
        ? Number(
            (
              (
                recoveredCases.length /
                dataset.recoveryCases.length
              ) *
              100
            ).toFixed(2),
          )
        : 0,
  };
}

/*
 * =========================================================
 * COMPLETE DATABASE RESET
 * =========================================================
 *
 * --reset means:
 *
 * Delete ALL current demo/test records
 * from these collections.
 *
 * Then insert one fresh dataset.
 * =========================================================
 */

async function removeExistingDemoData() {
  console.info(
    'Deleting ALL existing demo/test data...',
  );

  await AuditLog.deleteMany({});

  await RecoveryCase.deleteMany({});

  await Transaction.deleteMany({});

  await Subscription.deleteMany({});

  await Customer.deleteMany({});

  await User.deleteMany({});

  console.info(
    'All existing demo/test data deleted.',
  );
}

/*
 * =========================================================
 * PERSIST DATASET
 * =========================================================
 *
 * IMPORTANT:
 * RecoveryCase collection is intentionally
 * NOT populated here.
 *
 * Stage 1 will create RecoveryCases.
 * =========================================================
 */

async function persistDataset(
  dataset,
  shouldReset,
) {
  await Promise.all([
    User.init(),

    Customer.init(),

    Transaction.init(),

    Subscription.init(),
  ]);

  if (!shouldReset) {
    const existingMerchant =
      await User.findOne({
        email:
          DEMO_MERCHANT_EMAIL,
      })
        .select('_id')
        .lean();

    if (existingMerchant) {
      throw new Error(
        'Demo data already exists. Run "npm.cmd run seed:demo -- --reset" to replace the test dataset.',
      );
    }
  }

  if (shouldReset) {
    await removeExistingDemoData();
  }

  await User.create(
    dataset.merchant,
  );

  await Customer.insertMany(
    dataset.customerDocuments,
    {
      ordered: true,
    },
  );

  await Subscription.insertMany(
    dataset.subscriptions,
    {
      ordered: true,
    },
  );

  await Transaction.insertMany(
    dataset.transactions,
    {
      ordered: true,
    },
  );
}

/*
 * =========================================================
 * MAIN
 * =========================================================
 */

async function main() {
  const argumentsList =
    process.argv.slice(2);

  const isDryRun =
    argumentsList.includes(
      '--dry-run',
    );

  const shouldReset =
    argumentsList.includes(
      '--reset',
    );

  /*
   * Build first.
   *
   * No database changes happen
   * until validation succeeds.
   */

  const dataset =
    buildDemoDataset();

  validateDataset(
    dataset,
  );

  const summary =
    summarizeDataset(
      dataset,
    );

  /*
   * =======================================================
   * DRY RUN
   * =======================================================
   */

  if (isDryRun) {
    console.info(
      'Fresh 20-transaction seed dry run passed. No database records were written.',
    );

    console.info(
      JSON.stringify(
        summary,
        null,
        2,
      ),
    );

    return;
  }

  /*
   * =======================================================
   * DATABASE
   * =======================================================
   */

  configureDnsServers();

  const isConnected =
    await connectToDatabase();

  if (!isConnected) {
    throw new Error(
      'MongoDB is unavailable. Configure MONGODB_URI before running the seed command.',
    );
  }

  try {
    await persistDataset(
      dataset,
      shouldReset,
    );

    console.info(
      'Fresh 20-transaction demo dataset created successfully. Recovery cases will be created by revenue risk detection.',
    );

    console.info(
      JSON.stringify(
        summary,
        null,
        2,
      ),
    );
  } finally {
    await disconnectFromDatabase();
  }
}

/*
 * =========================================================
 * ERROR HANDLING
 * =========================================================
 */

main().catch(
  (error) => {
    console.error(
      'Synthetic data seed failed:',
      error.stack ||
        error.message,
    );

    process.exitCode = 1;
  },
);