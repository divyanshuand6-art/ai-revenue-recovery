import { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';

function formatCurrency(value) {
  const amount = Number(value || 0);

  return `₹${amount.toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  })}`;
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatLabel(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) =>
      letter.toUpperCase(),
    );
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getDefaultFromDate() {
  const date = new Date();

  date.setDate(
    date.getDate() - 30,
  );

  return formatLocalDate(date);
}

function getDefaultToDate() {
  return formatLocalDate(new Date());
}

function getRecoveryRate(item) {
  return Number(
    item?.caseRecoveryRatePercent || 0,
  );
}

function getRevenueRecoveryRate(item) {
  return Number(
    item?.revenueRecoveryRatePercent || 0,
  );
}

function Dashboard() {
  const [from, setFrom] =
    useState(getDefaultFromDate());

  const [to, setTo] =
    useState(getDefaultToDate());

  const [dashboard, setDashboard] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState('');

  const fromRef = useRef(from);
  const toRef = useRef(to);
  const dashboardRequestInFlightRef = useRef(false);

  fromRef.current = from;
  toRef.current = to;

  /*
   * --------------------------------------------------
   * LOAD DASHBOARD
   * --------------------------------------------------
   */

  async function loadDashboard(
    selectedFrom = fromRef.current,
    selectedTo = toRef.current,
  ) {
    if (dashboardRequestInFlightRef.current) {
      return;
    }

    dashboardRequestInFlightRef.current = true;

    try {
      setLoading(true);
      setError('');

      const response =
        await apiClient.get(
          '/analytics/dashboard',
          {
            params: {
              from: selectedFrom,
              to: selectedTo,
            },
          },
        );

      setDashboard(
        response.data?.data || null,
      );
    } catch (requestError) {
      console.error(
        'Dashboard analytics error:',
        requestError,
      );

      setError(
        requestError.response?.data
          ?.message ||
          'Failed to load dashboard analytics.',
      );
    } finally {
      dashboardRequestInFlightRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDashboard();

    const refreshInterval = window.setInterval(() => {
      loadDashboard(
        fromRef.current,
        toRef.current,
      );
    }, 5000);

    const handleFocus = () => {
      loadDashboard(
        fromRef.current,
        toRef.current,
      );
    };

    window.addEventListener('focus', handleFocus);

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', handleFocus);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * --------------------------------------------------
   * APPLY FILTER
   * --------------------------------------------------
   */

  function handleApplyFilter() {
    if (!from || !to) {
      setError(
        'Both From and To dates are required.',
      );

      return;
    }

    if (from > to) {
      setError(
        'From date cannot be later than To date.',
      );

      return;
    }

    loadDashboard(
      from,
      to,
    );
  }

  /*
   * --------------------------------------------------
   * DATA
   * --------------------------------------------------
   */

  const recovery =
    dashboard?.recovery || {};
    const aiSummary =
  dashboard?.aiSummary || {};

const aiRecommendationRows =
  Object.entries(
    aiSummary.recommendationsByAction || {},
  )
    .map(
      ([name, count]) => ({
        name,
        count: Number(count || 0),
      }),
    )
    .sort(
      (a, b) =>
        b.count - a.count,
    );

const aiPolicyResults =
  Object.entries(
    aiSummary.policyResults || {},
  )
    .map(
      ([name, count]) => ({
        name,
        count: Number(count || 0),
      }),
    )
    .sort(
      (a, b) =>
        b.count - a.count,
    );

const aiTotal =
  Number(
    aiSummary.totalAnalyses || 0,
  );

const aiAccepted =
  Number(
    aiSummary.acceptedPolicies || 0,
  );

const aiRejected =
  Number(
    aiSummary.rejectedPolicies || 0,
  );

const aiOverrides =
  Number(
    aiSummary.policyOverrides || 0,
  );

const aiLowConfidence =
  Number(
    aiSummary.lowConfidenceCount || 0,
  );

const aiConfidence =
  Number(
    aiSummary.averageConfidence || 0,
  );

const aiAcceptanceRate =
  aiTotal > 0
    ? (
        (aiAccepted /
          aiTotal) *
        100
      ).toFixed(1)
    : '0.0';

const maxAIRecommendationCount =
  Math.max(
    ...aiRecommendationRows.map(
      (item) => item.count,
    ),
    1,
  );

  const statusSummary =
    dashboard?.statusSummary || {};

  const casesByFailureReason =
    dashboard
      ?.casesByFailureReason || {};

  const casesByIntervention =
    dashboard
      ?.casesByIntervention || {};

  const casesByPaymentMethod =
    dashboard
      ?.casesByPaymentMethod || {};

  const casesByType =
    dashboard?.casesByType || {};

  /*
   * --------------------------------------------------
   * FAILURE ANALYSIS
   * --------------------------------------------------
   */

  const failureRows =
    useMemo(() => {
      return Object.entries(
        casesByFailureReason,
      )
        .map(
          ([name, value]) => ({
            name,
            ...value,
          }),
        )
        .sort(
          (a, b) =>
            b.cases -
            a.cases,
        );
    }, [
      casesByFailureReason,
    ]);

  /*
   * --------------------------------------------------
   * INTERVENTION ANALYSIS
   * --------------------------------------------------
   */

  const interventionRows =
    useMemo(() => {
      return Object.entries(
        casesByIntervention,
      )
        .map(
          ([name, value]) => ({
            name,
            ...value,
          }),
        )
        .sort(
          (a, b) =>
            getRecoveryRate(b) -
            getRecoveryRate(a),
        );
    }, [
      casesByIntervention,
    ]);

  /*
   * --------------------------------------------------
   * PAYMENT METHOD ANALYSIS
   * --------------------------------------------------
   */

  const paymentRows =
  useMemo(() => {
    return Object.entries(
      casesByPaymentMethod,
    )
      .filter(
        ([name]) =>
          String(name).toUpperCase() !==
          'UNKNOWN',
      )
      .map(
        ([name, value]) => ({
          name,
          ...value,
        }),
      )
      .sort(
        (a, b) =>
          getRevenueRecoveryRate(b) -
          getRevenueRecoveryRate(a),
      );
  }, [
    casesByPaymentMethod,
  ]);


  /*
   * --------------------------------------------------
   * CASE TYPES
   * --------------------------------------------------
   */

  const typeRows =
    useMemo(() => {
      return Object.entries(
        casesByType,
      )
        .map(
          ([name, value]) => ({
            name,
            ...value,
          }),
        )
        .sort(
          (a, b) =>
            b.cases -
            a.cases,
        );
    }, [
      casesByType,
    ]);

  /*
   * --------------------------------------------------
   * MAX VALUES FOR BARS
   * --------------------------------------------------
   */

  const maxFailureCases =
    Math.max(
      ...failureRows.map(
        (item) =>
          Number(
            item.cases || 0,
          ),
      ),
      1,
    );

  const maxInterventionRate =
    Math.max(
      ...interventionRows.map(
        (item) =>
          getRecoveryRate(item),
      ),
      1,
    );

  const maxPaymentRate =
    Math.max(
      ...paymentRows.map(
        (item) =>
          getRevenueRecoveryRate(
            item,
          ),
      ),
      1,
    );

  const maxTypeCases =
    Math.max(
      ...typeRows.map(
        (item) =>
          Number(
            item.cases || 0,
          ),
      ),
      1,
    );

  /*
   * --------------------------------------------------
   * DERIVED INSIGHTS
   * --------------------------------------------------
   */

  const topFailure =
    failureRows[0] || null;

  const bestIntervention =
    [...interventionRows]
      .sort(
        (a, b) =>
          getRecoveryRate(b) -
          getRecoveryRate(a),
      )[0] || null;

  const bestPaymentMethod =
    [...paymentRows]
      .sort(
        (a, b) =>
          getRevenueRecoveryRate(
            b,
          ) -
          getRevenueRecoveryRate(
            a,
          ),
      )[0] || null;

  const biggestRevenueRisk =
    [...failureRows]
      .sort(
        (a, b) =>
          Number(
            b.unrecoveredRevenue ||
              0,
          ) -
          Number(
            a.unrecoveredRevenue ||
              0,
          ),
      )[0] || null;

  const totalCases =
    Number(
      recovery.casesAnalyzed || 0,
    );

  const recoveredCases =
    Number(
      recovery.recoveredCases || 0,
    );

  const recoveryRate =
    Number(
      recovery.revenueRecoveryRatePercent ||
        0,
    );

  const unrecoveredRevenue =
    Number(
      recovery.unrecoveredRevenue ||
        0,
    );

  const recoveryOpportunity =
    unrecoveredRevenue;

  const recoveredCaseShare =
    totalCases > 0
      ? (
          (recoveredCases /
            totalCases) *
          100
        ).toFixed(1)
      : '0.0';

  /*
   * --------------------------------------------------
   * LOADING
   * --------------------------------------------------
   */

  if (
    loading &&
    !dashboard
  ) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-loading">
          Loading recovery intelligence...
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">

      {/* ==================================================
          HEADER
      ================================================== */}

      <header className="dashboard-hero">

        <div>
          <div className="dashboard-eyebrow-row">

            <span className="dashboard-eyebrow">
              REVENUE OPERATIONS
            </span>

            <span className="live-dot">
              Live Analytics
            </span>

          </div>

          <h1>
            AI Revenue Recovery
          </h1>

          <p className="dashboard-description">
            Monitor revenue at risk, recovery
            performance, intervention effectiveness,
            and payment behavior from one control
            center.
          </p>

          <div className="dashboard-period-pill">
            {dashboard?.period?.from ||
              from}
            <span>→</span>
            {dashboard?.period?.to ||
              to}
          </div>
        </div>

        <button
          className="dashboard-refresh-button"
          onClick={() =>
            loadDashboard(
              from,
              to,
            )
          }
          disabled={loading}
        >
          <span className="refresh-icon">
            ↻
          </span>

          {loading
            ? 'Refreshing...'
            : 'Refresh'}
        </button>

      </header>

      {/* ==================================================
          FILTERS
      ================================================== */}

      <section className="dashboard-filter">

        <div className="filter-title">
          <span className="filter-icon">
            ◴
          </span>

          Analysis Period
        </div>

        <div className="dashboard-filter-fields">

          <div className="dashboard-date-field">
            <label htmlFor="dashboard-from">
              From
            </label>

            <input
              id="dashboard-from"
              type="date"
              value={from}
              onChange={(event) =>
                setFrom(
                  event.target.value,
                )
              }
            />
          </div>

          <div className="dashboard-date-field">
            <label htmlFor="dashboard-to">
              To
            </label>

            <input
              id="dashboard-to"
              type="date"
              value={to}
              onChange={(event) =>
                setTo(
                  event.target.value,
                )
              }
            />
          </div>

          <button
            className="dashboard-apply-button"
            onClick={
              handleApplyFilter
            }
          >
            Apply Filter
          </button>

        </div>

      </section>

      {/* ==================================================
          ERROR
      ================================================== */}

      {error && (
        <div className="dashboard-error">
          <strong>
            Unable to load analytics
          </strong>

          <span>
            {error}
          </span>
        </div>
      )}

      {/* ==================================================
          KPI STRIP
      ================================================== */}

      <section className="dashboard-kpi-grid">

        <article className="dashboard-kpi revenue-risk">

          <div className="kpi-topline">
            <span>
              Revenue at Risk
            </span>

            <span className="kpi-icon">
              !
            </span>
          </div>

          <strong>
            {formatCurrency(
              recovery.revenueAtRisk,
            )}
          </strong>

          <div className="kpi-footer">
            <span>
              Total exposed revenue
            </span>
          </div>

        </article>

        <article className="dashboard-kpi revenue-recovered">

          <div className="kpi-topline">
            <span>
              Revenue Recovered
            </span>

            <span className="kpi-icon">
              ✓
            </span>
          </div>

          <strong>
            {formatCurrency(
              recovery.revenueRecovered,
            )}
          </strong>

          <div className="kpi-footer positive">
            <span>
              {recoveryRate.toFixed(
                2,
              )}
              % of eligible revenue
            </span>
          </div>

        </article>

        <article className="dashboard-kpi recovery-rate">

          <div className="kpi-topline">
            <span>
              Recovery Rate
            </span>

            <span className="kpi-icon">
              %
            </span>
          </div>

          <strong>
            {formatPercent(
              recovery.revenueRecoveryRatePercent,
            )}
          </strong>

          <div className="kpi-progress">
            <div
              style={{
                width: `${Math.min(
                  100,
                  recoveryRate,
                )}%`,
              }}
            />
          </div>

          <div className="kpi-footer">
            <span>
              Revenue efficiency
            </span>
          </div>

        </article>

        <article className="dashboard-kpi case-volume">

          <div className="kpi-topline">
            <span>
              Cases Analyzed
            </span>

            <span className="kpi-icon">
              #
            </span>
          </div>

          <strong>
            {totalCases.toLocaleString(
              'en-IN',
            )}
          </strong>

          <div className="kpi-footer">
            <span>
              {recoveredCaseShare}%
              successfully recovered
            </span>
          </div>

        </article>

      </section>

      {/* ==================================================
          EXECUTIVE INSIGHT
      ================================================== */}

      <section className="insight-grid">

        <article className="insight-card insight-warning">

          <div className="insight-icon">
            !
          </div>

          <div>
            <span className="insight-label">
              Recovery opportunity
            </span>

            <strong>
              {formatCurrency(
                recoveryOpportunity,
              )}
            </strong>

            <p>
              Revenue remains unrecovered
              in the selected period.
            </p>
          </div>

        </article>

        <article className="insight-card">

          <div className="insight-icon neutral">
            ↑
          </div>

          <div>
            <span className="insight-label">
              Largest failure segment
            </span>

            <strong>
              {topFailure
                ? formatLabel(
                    topFailure.name,
                  )
                : '—'}
            </strong>

            <p>
              {topFailure
                ? `${topFailure.cases} cases represent the largest failure volume.`
                : 'No failure data available.'}
            </p>
          </div>

        </article>

        <article className="insight-card insight-positive">

          <div className="insight-icon positive">
            ✓
          </div>

          <div>
            <span className="insight-label">
              Best intervention
            </span>

            <strong>
              {bestIntervention
                ? formatLabel(
                    bestIntervention.name,
                  )
                : '—'}
            </strong>

            <p>
              {bestIntervention
                ? `${formatPercent(
                    bestIntervention.caseRecoveryRatePercent,
                  )} case recovery rate.`
                : 'No intervention data available.'}
            </p>
          </div>

        </article>

        <article className="insight-card">

          <div className="insight-icon neutral">
            ₹
          </div>

          <div>
            <span className="insight-label">
              Biggest revenue leak
            </span>

            <strong>
              {biggestRevenueRisk
                ? formatLabel(
                    biggestRevenueRisk.name,
                  )
                : '—'}
            </strong>

            <p>
              {biggestRevenueRisk
                ? `${formatCurrency(
                    biggestRevenueRisk.unrecoveredRevenue,
                  )} remains unrecovered.`
                : 'No revenue-risk data available.'}
            </p>
          </div>

        </article>

      </section>

      {/* ==================================================
          FINANCIAL OVERVIEW
      ================================================== */}

      <section className="dashboard-panel financial-panel">

        <div className="panel-heading">

          <div>
            <span className="section-kicker">
              FINANCIAL OVERVIEW
            </span>

            <h2>
              Recovery Economics
            </h2>

            <p>
              How exposed revenue is translating
              into recovered value.
            </p>
          </div>

        </div>

        <div className="financial-grid">

          <div className="financial-main">

            <div className="financial-visual">

              <div
                className="financial-donut"
                style={{
                  '--recovery-angle': `${Math.min(
                    100,
                    recoveryRate,
                  ) * 3.6}deg`,
                }}
              >
                <div>
                  <strong>
                    {Math.round(
                      recoveryRate,
                    )}
                    %
                  </strong>

                  <span>
                    recovered
                  </span>
                </div>
              </div>

              <div className="financial-legend">

                <div>
                  <span className="legend-dot recovered" />
                  <span>
                    Recovered
                  </span>
                  <strong>
                    {formatCurrency(
                      recovery.revenueRecovered,
                    )}
                  </strong>
                </div>

                <div>
                  <span className="legend-dot unrecovered" />
                  <span>
                    Unrecovered
                  </span>
                  <strong>
                    {formatCurrency(
                      recovery.unrecoveredRevenue,
                    )}
                  </strong>
                </div>

              </div>

            </div>

          </div>

          <div className="financial-metrics">

            <div className="financial-metric">
              <span>
                Revenue at Risk
              </span>

              <strong>
                {formatCurrency(
                  recovery.revenueAtRisk,
                )}
              </strong>
            </div>

            <div className="financial-metric">
              <span>
                Eligible Revenue
              </span>

              <strong>
                {formatCurrency(
                  recovery.eligibleRevenue,
                )}
              </strong>
            </div>

            <div className="financial-metric">
              <span>
                Revenue Recovered
              </span>

              <strong className="metric-positive">
                {formatCurrency(
                  recovery.revenueRecovered,
                )}
              </strong>
            </div>

            <div className="financial-metric">
              <span>
                Unrecovered Revenue
              </span>

              <strong className="metric-warning">
                {formatCurrency(
                  recovery.unrecoveredRevenue,
                )}
              </strong>
            </div>

          </div>

        </div>

      </section>

      {/* ==================================================
          CASE STATUS + CASE TYPES
      ================================================== */}

      <div className="dashboard-two-column">

        <section className="dashboard-panel">

          <div className="panel-heading">

            <div>
              <span className="section-kicker">
                CASE STATUS
              </span>

              <h2>
                Recovery Pipeline
              </h2>
            </div>

            <span className="panel-total">
              {totalCases.toLocaleString(
                'en-IN',
              )}{' '}
              cases
            </span>

          </div>

          <div className="status-list-modern">

            {Object.entries(
              statusSummary,
            )
              .sort(
                (a, b) =>
                  b[1] - a[1],
              )
              .map(
                ([statusName, count]) => {

                  const percentage =
                    totalCases >
                    0
                      ? (
                          (Number(
                            count,
                          ) /
                            totalCases) *
                          100
                        )
                      : 0;

                  return (
                    <div
                      className="status-modern-row"
                      key={
                        statusName
                      }
                    >

                      <div className="status-modern-top">

                        <div>
                          <span
                            className={`status-marker status-marker-${String(
                              statusName,
                            ).toLowerCase()}`}
                          />

                          <span>
                            {formatLabel(
                              statusName,
                            )}
                          </span>
                        </div>

                        <strong>
                          {Number(
                            count,
                          ).toLocaleString(
                            'en-IN',
                          )}
                        </strong>

                      </div>

                      <div className="modern-progress">

                        <div
                          style={{
                            width: `${percentage}%`,
                          }}
                        />

                      </div>

                      <span className="status-percent">
                        {percentage.toFixed(
                          1,
                        )}
                        %
                      </span>

                    </div>
                  );
                },
              )}

          </div>

        </section>

        <section className="dashboard-panel">

          <div className="panel-heading">

            <div>
              <span className="section-kicker">
                CASE MIX
              </span>

              <h2>
                Revenue Events
              </h2>
            </div>

          </div>

          <div className="type-list">

            {typeRows.map(
              (item) => (
                <div
                  className="type-row"
                  key={
                    item.name
                  }
                >

                  <div className="type-row-top">

                    <span>
                      {formatLabel(
                        item.name,
                      )}
                    </span>

                    <strong>
                      {item.cases}
                    </strong>

                  </div>

                  <div className="type-bar">

                    <div
                      style={{
                        width: `${(
                          (item.cases /
                            maxTypeCases) *
                          100
                        ).toFixed(2)}%`,
                      }}
                    />

                  </div>

                  <div className="type-row-bottom">

                    <span>
                      {formatCurrency(
                        item.revenueAtRisk,
                      )}{' '}
                      at risk
                    </span>

                    <span className="metric-positive">
                      {formatCurrency(
                        item.revenueRecovered,
                      )}{' '}
                      recovered
                    </span>

                  </div>

                </div>
              ),
            )}

            {typeRows.length ===
              0 && (
              <div className="dashboard-empty">
                No case type data
                available.
              </div>
            )}

          </div>

        </section>

      </div>

      {/* ==================================================
          FAILURE REASON
      ================================================== */}

      <section className="dashboard-panel">

        <div className="panel-heading">

          <div>
            <span className="section-kicker">
              FAILURE ANALYSIS
            </span>

            <h2>
              Where Revenue Loss Starts
            </h2>

            <p>
              Failure volume and recovery
              performance by root cause.
            </p>
          </div>

          <div className="analysis-badge">
            {failureRows.length}{' '}
            categories
          </div>

        </div>

        <div className="failure-table">

          <div className="failure-head">
            <span>
              Failure reason
            </span>

            <span>
              Cases
            </span>

            <span>
              Recovery
            </span>

            <span>
              Revenue recovered
            </span>
          </div>

          {failureRows.map(
            (item) => {

              const volume =
                (
                  (item.cases /
                    maxFailureCases) *
                  100
                ).toFixed(2);

              return (
                <div
                  className="failure-row"
                  key={
                    item.name
                  }
                >

                  <div className="failure-name">
                    <strong>
                      {formatLabel(
                        item.name,
                      )}
                    </strong>

                    <div className="failure-volume-bar">
                      <div
                        style={{
                          width: `${volume}%`,
                        }}
                      />
                    </div>
                  </div>

                  <strong>
                    {item.cases.toLocaleString(
                      'en-IN',
                    )}
                  </strong>

                  <span
                    className={
                      getRecoveryRate(
                        item,
                      ) >= 60
                        ? 'analysis-positive'
                        : getRecoveryRate(
                              item,
                            ) >= 40
                          ? 'analysis-neutral'
                          : 'analysis-warning'
                    }
                  >
                    {formatPercent(
                      item.revenueRecoveryRatePercent,
                    )}
                  </span>

                  <strong>
                    {formatCurrency(
                      item.revenueRecovered,
                    )}
                  </strong>

                </div>
              );
            },
          )}

        </div>

      </section>

      {/* ==================================================
          INTERVENTION + PAYMENT
      ================================================== */}

      <div className="dashboard-two-column">

        {/* INTERVENTION */}

        <section className="dashboard-panel">

          <div className="panel-heading">

            <div>
              <span className="section-kicker">
                RECOVERY ACTIONS
              </span>

              <h2>
                Intervention Effectiveness
              </h2>

              <p>
                Which actions actually recover
                the most cases?
              </p>
            </div>

          </div>

          <div className="effectiveness-list">

            {interventionRows.map(
              (item) => {

                const rate =
                  getRecoveryRate(
                    item,
                  );

                return (
                  <div
                    className="effectiveness-row"
                    key={
                      item.name
                    }
                  >

                    <div className="effectiveness-top">

                      <div>
                        <strong>
                          {formatLabel(
                            item.name,
                          )}
                        </strong>

                        <span>
                          {item.cases}{' '}
                          cases
                        </span>
                      </div>

                      <strong
                        className={
                          rate >= 70
                            ? 'analysis-positive'
                            : rate >=
                                40
                              ? 'analysis-neutral'
                              : 'analysis-warning'
                        }
                      >
                        {formatPercent(
                          item.caseRecoveryRatePercent,
                        )}
                      </strong>

                    </div>

                    <div className="effectiveness-track">

                      <div
                        style={{
                          width: `${Math.min(
                            100,
                            (rate /
                              maxInterventionRate) *
                              100,
                          )}%`,
                        }}
                      />

                    </div>

                    <div className="effectiveness-bottom">

                      <span>
                        Case recovery
                      </span>

                      <span>
                        {formatCurrency(
                          item.revenueRecovered,
                        )}{' '}
                        recovered
                      </span>

                    </div>

                  </div>
                );
              },
            )}

          </div>

        </section>

        {/* PAYMENT METHOD */}

        <section className="dashboard-panel">

          <div className="panel-heading">

            <div>
              <span className="section-kicker">
                PAYMENT METHODS
              </span>

              <h2>
                Payment Performance
              </h2>

              <p>
                Revenue recovery efficiency
                across payment channels.
              </p>
            </div>

            {bestPaymentMethod && (
              <div className="best-channel-badge">
                Best:{' '}
                {formatLabel(
                  bestPaymentMethod.name,
                )}
              </div>
            )}

          </div>

          <div className="payment-list">

            {paymentRows.map(
              (item) => {

                const rate =
                  getRevenueRecoveryRate(
                    item,
                  );

                return (
                  <div
                    className="payment-row"
                    key={
                      item.name
                    }
                  >

                    <div className="payment-row-header">

                      <div className="payment-method-name">
                        <span className="payment-method-icon">
                          {String(
                            item.name,
                          )
                            .slice(
                              0,
                              1,
                            )
                            .toUpperCase()}
                        </span>

                        <strong>
                          {formatLabel(
                            item.name,
                          )}
                        </strong>
                      </div>

                      <strong>
                        {formatPercent(
                          item.revenueRecoveryRatePercent,
                        )}
                      </strong>

                    </div>

                    <div className="payment-track">

                      <div
                        style={{
                          width: `${Math.min(
                            100,
                            (rate /
                              maxPaymentRate) *
                              100,
                          )}%`,
                        }}
                      />

                    </div>

                    <div className="payment-bottom">

                      <span>
                        {item.cases}{' '}
                        cases
                      </span>

                      <span>
                        {formatCurrency(
                          item.revenueRecovered,
                        )}{' '}
                        recovered
                      </span>

                    </div>

                  </div>
                );
              },
            )}

          </div>

        </section>

      </div>

      {/* ==================================================
    AI DECISION INTELLIGENCE
================================================== */}

<section className="dashboard-panel ai-intelligence-panel">

  <div className="panel-heading">

    <div>
      <span className="section-kicker">
        AI DECISION INTELLIGENCE
      </span>

      <h2>
        AI & Policy Governance
      </h2>

      <p>
        AI recommendations are evaluated against
        deterministic recovery policy before a
        final action is allowed.
      </p>
    </div>

    <div className="ai-governance-badge">
      Policy Governed
    </div>

  </div>


  {/* ==================================================
      AI KPI CARDS
  ================================================== */}

  <div className="ai-kpi-grid">

    <div className="ai-kpi-card">

      <div className="ai-kpi-icon blue">
        AI
      </div>

      <div>
        <span>
          AI Analyses
        </span>

        <strong>
          {aiTotal.toLocaleString(
            'en-IN',
          )}
        </strong>

        <small>
          Recommendations generated
        </small>
      </div>

    </div>


    <div className="ai-kpi-card">

      <div className="ai-kpi-icon green">
        ✓
      </div>

      <div>
        <span>
          Policy Accepted
        </span>

        <strong>
          {aiAccepted.toLocaleString(
            'en-IN',
          )}
        </strong>

        <small className="ai-positive">
          {aiAcceptanceRate}% acceptance
        </small>
      </div>

    </div>


    <div className="ai-kpi-card">

      <div className="ai-kpi-icon orange">
        !
      </div>

      <div>
        <span>
          Policy Rejected
        </span>

        <strong>
          {aiRejected.toLocaleString(
            'en-IN',
          )}
        </strong>

        <small className="ai-warning">
          Requires policy override
        </small>
      </div>

    </div>


    <div className="ai-kpi-card">

      <div className="ai-kpi-icon purple">
        %
      </div>

      <div>
        <span>
          Avg Confidence
        </span>

        <strong>
          {aiConfidence.toFixed(1)}%
        </strong>

        <small>
          {aiLowConfidence} low-confidence analyses
        </small>
      </div>

    </div>

  </div>


  {/* ==================================================
      GOVERNANCE SIGNAL
  ================================================== */}

  <div className="ai-governance-strip">

    <div className="ai-governance-flow">

      <div className="governance-step">
        <span className="governance-number">
          01
        </span>

        <div>
          <strong>
            AI Recommendation
          </strong>

          <span>
            Predictive recovery suggestion
          </span>
        </div>
      </div>


      <div className="governance-arrow">
        →
      </div>


      <div className="governance-step">
        <span className="governance-number">
          02
        </span>

        <div>
          <strong>
            Deterministic Policy
          </strong>

          <span>
            Validate allowed action
          </span>
        </div>
      </div>


      <div className="governance-arrow">
        →
      </div>


      <div className="governance-step">
        <span className="governance-number">
          03
        </span>

        <div>
          <strong>
            Final Action
          </strong>

          <span>
            Execute only approved action
          </span>
        </div>
      </div>

    </div>

  </div>


  {/* ==================================================
      AI ANALYSIS BODY
  ================================================== */}

  <div className="ai-analysis-grid">

    {/* RECOMMENDATIONS */}

    <div className="ai-analysis-card">

      <div className="ai-analysis-card-header">

        <div>
          <strong>
            Recommended Actions
          </strong>

          <span>
            Distribution of AI suggestions
          </span>
        </div>

        {aiSummary.topRecommendedAction && (
          <div className="ai-top-action">
            Top:{' '}
            {formatLabel(
              aiSummary.topRecommendedAction
                .action,
            )}
          </div>
        )}

      </div>


      <div className="ai-action-list">

        {aiRecommendationRows.length ===
        0 ? (
          <div className="dashboard-empty">
            No AI recommendation data
            available for this period.
          </div>
        ) : (
          aiRecommendationRows.map(
            (item) => (
              <div
                className="ai-action-row"
                key={item.name}
              >

                <div className="ai-action-row-top">

                  <span>
                    {formatLabel(
                      item.name,
                    )}
                  </span>

                  <strong>
                    {item.count}
                  </strong>

                </div>

                <div className="ai-action-track">

                  <div
                    style={{
                      width: `${(
                        (item.count /
                          maxAIRecommendationCount) *
                        100
                      ).toFixed(2)}%`,
                    }}
                  />

                </div>

              </div>
            ),
          )
        )}

      </div>

    </div>


    {/* POLICY OUTCOME */}

    <div className="ai-analysis-card">

      <div className="ai-analysis-card-header">

        <div>
          <strong>
            Policy Outcomes
          </strong>

          <span>
            Governance decisions applied to AI output
          </span>
        </div>

      </div>


      <div className="policy-outcome-list">

        <div className="policy-outcome-row">

          <div>
            <span className="policy-status-dot accepted" />

            <span>
              Accepted
            </span>
          </div>

          <strong>
            {aiAccepted}
          </strong>

        </div>


        <div className="policy-outcome-row">

          <div>
            <span className="policy-status-dot rejected" />

            <span>
              Rejected
            </span>
          </div>

          <strong>
            {aiRejected}
          </strong>

        </div>


        <div className="policy-outcome-row">

          <div>
            <span className="policy-status-dot override" />

            <span>
              Policy Overrides
            </span>
          </div>

          <strong>
            {aiOverrides}
          </strong>

        </div>

      </div>


      <div className="policy-summary-box">

        <strong>
          Deterministic policy remains authoritative.
        </strong>

        <p>
          AI suggestions never bypass recovery
          limits. A rejected recommendation is
          replaced by the policy-approved action.
        </p>

      </div>

    </div>

  </div>

</section>

      {/* ==================================================
          OPERATIONAL TAKEAWAYS
      ================================================== */}

      <section className="dashboard-panel takeaways-panel">

        <div className="panel-heading">

          <div>
            <span className="section-kicker">
              DECISION SUPPORT
            </span>

            <h2>
              Operational Takeaways
            </h2>

            <p>
              Quick signals derived directly from
              the selected-period recovery data.
            </p>
          </div>

        </div>

        <div className="takeaways-grid">

          <div className="takeaway">
            <span className="takeaway-number">
              01
            </span>

            <div>
              <strong>
                Largest volume
              </strong>

              <p>
                {topFailure
                  ? `${formatLabel(
                      topFailure.name,
                    )} is the largest source of recovery cases with ${topFailure.cases} cases.`
                  : 'No failure data available.'}
              </p>
            </div>
          </div>

          <div className="takeaway">
            <span className="takeaway-number">
              02
            </span>

            <div>
              <strong>
                Best recovery lever
              </strong>

              <p>
                {bestIntervention
                  ? `${formatLabel(
                      bestIntervention.name,
                    )} currently has the strongest case recovery performance at ${formatPercent(
                      bestIntervention.caseRecoveryRatePercent,
                    )}.`
                  : 'No intervention data available.'}
              </p>
            </div>
          </div>

          <div className="takeaway">
            <span className="takeaway-number">
              03
            </span>

            <div>
              <strong>
                Biggest value risk
              </strong>

              <p>
                {biggestRevenueRisk
                  ? `${formatLabel(
                      biggestRevenueRisk.name,
                    )} has the largest unrecovered revenue exposure at ${formatCurrency(
                      biggestRevenueRisk.unrecoveredRevenue,
                    )}.`
                  : 'No revenue-risk data available.'}
              </p>
            </div>
          </div>

          <div className="takeaway">
            <span className="takeaway-number">
              04
            </span>

            <div>
              <strong>
                Payment signal
              </strong>

              <p>
                {bestPaymentMethod
                  ? `${formatLabel(
                      bestPaymentMethod.name,
                    )} leads payment-method revenue recovery at ${formatPercent(
                      bestPaymentMethod.revenueRecoveryRatePercent,
                    )}.`
                  : 'No payment-method data available.'}
              </p>
            </div>
          </div>

        </div>

      </section>

      {/* ==================================================
          FOOTER
      ================================================== */}

      {dashboard?.generatedAt && (
        <div className="dashboard-footer">
          Analytics generated{' '}
          {new Date(
            dashboard.generatedAt,
          ).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </div>
      )}

    </div>
  );
}

export default Dashboard;