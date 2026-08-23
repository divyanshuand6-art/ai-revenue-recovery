const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = require('./app');
const {
  connectToDatabase,
  disconnectFromDatabase,
} = require('./config/db');
const { configureDnsServers } = require('./config/dns');

const port = Number.parseInt(process.env.PORT, 10) || 5000;

async function startServer() {
  configureDnsServers();
  await connectToDatabase();

  const server = app.listen(port, () => {
    console.info(`AI Revenue Recovery backend listening on port ${port}.`);
  });

  const shutdown = async (signal) => {
    console.info(`${signal} received. Shutting down gracefully.`);

    server.close(async (closeError) => {
      if (closeError) {
        console.error('HTTP server shutdown failed:', closeError.message);
        process.exit(1);
      }

      try {
        await disconnectFromDatabase();
        process.exit(0);
      } catch (databaseError) {
        console.error('MongoDB shutdown failed:', databaseError.message);
        process.exit(1);
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  server.on('error', (error) => {
    console.error('HTTP server startup failed:', error.message);
    process.exit(1);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Backend startup failed:', error.message);
    process.exit(1);
  });
}

module.exports = { startServer };
