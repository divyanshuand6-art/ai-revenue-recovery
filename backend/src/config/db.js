const mongoose = require('mongoose');

const DATABASE_STATE_NAMES = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
});

function getDatabaseStatus() {
  return DATABASE_STATE_NAMES[mongoose.connection.readyState] ?? 'unknown';
}

async function connectToDatabase() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.warn('MongoDB connection skipped: MONGODB_URI is not configured.');
    return false;
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });

    console.info('MongoDB connected.');
    return true;
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    return false;
  }
}

async function disconnectFromDatabase() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.disconnect();
  console.info('MongoDB disconnected.');
}

module.exports = {
  connectToDatabase,
  disconnectFromDatabase,
  getDatabaseStatus,
};
