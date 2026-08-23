const cors = require('cors');
const express = require('express');


const { getDatabaseStatus } = require('./config/db');
const analyticsRoutes = require('./routes/analyticsRoutes');
const recoveryRoutes = require('./routes/recoveryRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use('/api/analytics', analyticsRoutes);
app.use('/api/recovery', recoveryRoutes);
app.use('/api/auth', authRoutes);

app.get('/api/health', (_request, response) => {
  const db = getDatabaseStatus();
  const isDatabaseConnected = db === 'connected';

  response.status(isDatabaseConnected ? 200 : 503).json({
    status: isDatabaseConnected ? 'ok' : 'degraded',
    service: 'ai-revenue-recovery',
    db,
  });
});

app.use((_request, response) => {
  response.status(404).json({
    error: 'Route not found',
  });
});

app.use((error, _request, response, _next) => {
  console.error('Unhandled application error:', error);

  response.status(500).json({
    error: 'Internal server error',
  });
});

module.exports = app;
