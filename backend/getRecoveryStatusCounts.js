require('dotenv').config();

const { configureDnsServers } = require('./src/config/dns');
const mongoose = require('mongoose');
const RecoveryCase = require('./src/models/RecoveryCase');

(async () => {
  configureDnsServers();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  const result = await RecoveryCase.aggregate([
    {
      $match: {
        merchantId: new mongoose.Types.ObjectId(
          '6a8f01c39ce5f60506534292'
        ),
      },
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
    {
      $sort: {
        count: -1,
      },
    },
  ]);

  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
