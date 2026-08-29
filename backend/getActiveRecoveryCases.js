require('dotenv').config();

const { configureDnsServers } = require('./src/config/dns');
const mongoose = require('mongoose');
const RecoveryCase = require('./src/models/RecoveryCase');

(async () => {
  configureDnsServers();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  const cases = await RecoveryCase.find({
    merchantId: '6a8f07b14f278ad7b4354a5a',
    status: {
      $in: [
        'OPEN',
        'ACTION_SCHEDULED',
        'ACTION_EXECUTED',
      ],
    },
  })
    .select(
      '_id type status amountAtRiskMinor eligibleAmountMinor recoveredAmountMinor currentAction recoveryWindowEndsAt'
    )
    .limit(5)
    .lean();

  console.log(JSON.stringify(cases, null, 2));

  await mongoose.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
