require('dotenv').config();

const { configureDnsServers } = require('./src/config/dns');
const mongoose = require('mongoose');
const User = require('./src/models/User');
const RecoveryCase = require('./src/models/RecoveryCase');

(async () => {
  configureDnsServers();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  const merchant = await User.findOne({
    email: 'demo.merchant@ai-revenue-recovery.local',
  }).select('_id');

  if (!merchant) {
    throw new Error('Demo merchant not found.');
  }

  const cases = await RecoveryCase.find({
    merchantId: merchant._id,
    status: 'OPEN',
  })
    .select(
      '_id type status amountAtRiskMinor eligibleAmountMinor currentAction recoveryWindowEndsAt',
    )
    .limit(5)
    .lean();

  console.log(JSON.stringify(cases, null, 2));

  await mongoose.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
