const {
  authenticateUser,
} = require('../services/authService');

async function loginController(req, res) {
  try {
    const {
      email,
      password,
    } = req.body;

    const result = await authenticateUser({
      email,
      password,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(
      'Login error:',
      error,
    );

    if (
      error.message ===
        'Email and password are required.' ||
      error.message ===
        'Invalid email or password.' ||
      error.message ===
        'User account is suspended.'
    ) {
      return res.status(401).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Login failed.',
    });
  }
}

module.exports = {
  loginController,
};