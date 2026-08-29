import { useState } from 'react';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import RecoveryCases from './pages/RecoveryCases';

function App() {
  const [authenticated, setAuthenticated] =
    useState(
      Boolean(
        localStorage.getItem(
          'accessToken',
        ),
      ),
    );

  const [page, setPage] =
    useState('dashboard');

  function handleLogout() {
    localStorage.removeItem(
      'accessToken',
    );

    setAuthenticated(false);
  }

  if (!authenticated) {
    return (
      <Login
        onLogin={() =>
          setAuthenticated(true)
        }
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            AR
          </div>

          <div>
            <strong>
              AI Revenue
            </strong>

            <span>
              Recovery
            </span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={
              page === 'dashboard'
                ? 'nav-item active'
                : 'nav-item'
            }
            onClick={() =>
              setPage('dashboard')
            }
          >
            <span>Dashboard</span>
          </button>

          <button
            className={
              page === 'cases'
                ? 'nav-item active'
                : 'nav-item'
            }
            onClick={() =>
              setPage('cases')
            }
          >
            <span>Recovery Cases</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <button
            className="logout-button"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      </aside>

      <main className="main-content">
        {page === 'dashboard' ? (
          <Dashboard />
        ) : (
          <RecoveryCases />
        )}
      </main>
    </div>
  );
}

export default App;