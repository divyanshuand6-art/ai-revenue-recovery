import { useState } from 'react';
import apiClient from '../api/client';

function Login({ onLogin }) {
  const [email, setEmail] = useState(
    'demo.merchant@ai-revenue-recovery.local',
  );

  const [password, setPassword] = useState(
    'Demo@12345',
  );

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    setError('');
    setLoading(true);

    try {
      const response = await apiClient.post(
        '/auth/login',
        {
          email,
          password,
        },
      );

      const token =
        response.data?.data?.token;

      if (!token) {
        throw new Error(
          'Login response did not contain a token.',
        );
      }

      localStorage.setItem(
        'accessToken',
        token,
      );

      onLogin();
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ||
          requestError.message ||
          'Login failed.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={handleSubmit}
      >
        <h1>AI Revenue Recovery</h1>

        <p>
          Sign in to Revenue Operations
        </p>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) =>
              setEmail(event.target.value)
            }
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) =>
              setPassword(event.target.value)
            }
            required
          />
        </label>

        {error && (
          <div className="login-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
        >
          {loading
            ? 'Signing in...'
            : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default Login;