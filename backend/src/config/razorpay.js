const Razorpay = require('razorpay');

const keyId =
  process.env.RAZORPAY_KEY_ID;

const keySecret =
  process.env.RAZORPAY_KEY_SECRET;

if (!keyId) {
  throw new Error(
    'RAZORPAY_KEY_ID is not configured.',
  );
}

if (!keySecret) {
  throw new Error(
    'RAZORPAY_KEY_SECRET is not configured.',
  );
}

if (
  !keyId.startsWith('rzp_test_')
) {
  throw new Error(
    'Only Razorpay Test Mode keys are allowed in this development environment.',
  );
}

const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

module.exports = razorpay;