const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not configured.');
  }

  return secret;
}

async function authenticateUser({ email, password }) {
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await User.findOne({
    email: normalizedEmail,
  }).select('+passwordHash');

  if (!user) {
    throw new Error('Invalid email or password.');
  }

  if (user.status !== 'ACTIVE') {
    throw new Error('User account is suspended.');
  }

  const passwordMatches = await bcrypt.compare(
    password,
    user.passwordHash,
  );

  if (!passwordMatches) {
    throw new Error('Invalid email or password.');
  }

  const token = jwt.sign(
    {
      userId: user._id.toString(),
      role: user.role,
    },
    getJwtSecret(),
    {
      expiresIn: '1h',
    },
  );

  return {
    token,
    user: {
      id: user._id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  };
}

module.exports = {
  authenticateUser,
};