import { useMemo, useState } from 'react';
import apiClient from '../api/client';

const STATUS_OPTIONS = [
  'ALL',
  'ACTION_REQUIRED',
  'OPEN',
  'ACTION_SCHEDULED',
  'ACTION_EXECUTED',
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'EXPIRED',
  'STOPPED',
];

const CASES_PER_PAGE = 25;

const ACTION_REQUIRED_STATUSES = new Set([
  'ACTION_SCHEDULED',
  'ACTION_EXECUTED',
  'ESCALATED',
]);

const TERMINAL_STATUSES = new Set([
  'RECOVERED',
  'FAILED',
  'EXPIRED',
  'STOPPED',
  'ESCALATED',
]);



function formatLabel(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) =>
      letter.toUpperCase(),
    );
}

function formatCurrency(minorUnits) {
  return `₹${(
    Number(minorUnits || 0) / 100
  ).toLocaleString('en-IN', {
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function RecoveryCases() {
  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] =
    useState(null);

  const [status, setStatus] =
    useState('ACTION_REQUIRED');

  const [search, setSearch] =
    useState('');

  const [currentPage, setCurrentPage] =
    useState(1);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState('');

  /*
   * --------------------------------------------------
   * AI STATE
   * --------------------------------------------------
   */

  const [aiLoading, setAiLoading] =
    useState(false);

  const [aiResults, setAiResults] =
    useState([]);

  const [aiRunSummary, setAiRunSummary] =
    useState(null);

  const [aiError, setAiError] =
    useState('');

  /*
   * --------------------------------------------------
   * EXECUTION STATE
   * --------------------------------------------------
   */

  const [
    executionLoading,
    setExecutionLoading,
  ] = useState(false);

  const [
    executionResult,
    setExecutionResult,
  ] = useState(null);

  const [
    actionConfirmation,
    setActionConfirmation,
  ] = useState(null);

  /*
   * --------------------------------------------------
   * PAYMENT CONFIRMATION STATE
   * --------------------------------------------------
   */

  const [
    paymentConfirmation,
    setPaymentConfirmation,
  ] = useState(null);

  const [
    paymentAmount,
    setPaymentAmount,
  ] = useState('');

  const [
    paymentTransactionId,
    setPaymentTransactionId,
  ] = useState('');

  /*
   * --------------------------------------------------
   * CUSTOMER + SOURCE TRANSACTION
   * --------------------------------------------------
   */

  const [customer, setCustomer] =
    useState(null);

  const [
    sourceTransaction,
    setSourceTransaction,
  ] = useState(null);

  /*
   * --------------------------------------------------
   * TIMELINE
   * --------------------------------------------------
   */

  const [timeline, setTimeline] =
    useState([]);

  const [
    timelineLoading,
    setTimelineLoading,
  ] = useState(false);

  const [
    timelineError,
    setTimelineError,
  ] = useState('');

  /*
   * --------------------------------------------------
   * LOAD CASES
   * --------------------------------------------------
   */

  async function loadCases(
    selectedStatus = status,
  ) {
    try {
      setLoading(true);
      setError('');

      const params =
        selectedStatus !== 'ALL' &&
        selectedStatus !==
          'ACTION_REQUIRED'
          ? {
              status: selectedStatus,
            }
          : {};

      const response =
        await apiClient.get(
          '/recovery/cases',
          {
            params,
          },
        );

      
       const loadedCases =
  response.data?.cases ||
  response.data?.data?.cases ||
  [];

      setCases(loadedCases);

      setSelectedCase(null);

      setTimeline([]);
      setTimelineError('');

      setCustomer(null);
      setSourceTransaction(null);

      setAiResults([]);
      setAiRunSummary(null);
      setAiError('');

      setExecutionResult(null);

      setCurrentPage(1);
    } catch (requestError) {
      setError(
        requestError.response?.data
          ?.message ||
          'Failed to load recovery cases.',
      );
    } finally {
      setLoading(false);
    }
  }

  /*
   * --------------------------------------------------
   * LOAD CASE CONTEXT + TIMELINE
   * --------------------------------------------------
   */

  async function loadTimeline(
    recoveryCaseId,
  ) {
    if (!recoveryCaseId) {
      return;
    }

    try {
      setTimelineLoading(true);
      setTimelineError('');

      setTimeline([]);

      setCustomer(null);
      setSourceTransaction(null);

      const response =
        await apiClient.get(
          `/recovery/cases/${recoveryCaseId}/timeline`,
        );

      const data =
        response.data?.data || {};

      setCustomer(
        data.customer || null,
      );

      setSourceTransaction(
        data.sourceTransaction ||
          null,
      );

      setTimeline(
        data.timeline || [],
      );
    } catch (requestError) {
      setTimelineError(
        requestError.response?.data
          ?.message ||
          'Failed to load case context.',
      );
    } finally {
      setTimelineLoading(false);
    }
  }

  /*
   * --------------------------------------------------
   * CASE SELECTION
   * --------------------------------------------------
   */

  function handleCaseSelect(item) {
    setSelectedCase(item);

    /*
     * Clear case-specific information first.
     */
    setTimeline([]);
    setTimelineError('');

    setCustomer(null);
    setSourceTransaction(null);

    setExecutionResult(null);

    /*
     * Remove any old error but DO NOT
     * automatically change the selected case.
     */
    setAiError('');

    /*
     * Load context belonging to this exact case.
     */
    loadTimeline(item._id);
  }

  /*
   * --------------------------------------------------
   * STATUS FILTER
   * --------------------------------------------------
   */

  async function handleStatusChange(
    event,
  ) {
    const nextStatus =
      event.target.value;

    setStatus(nextStatus);

    setCurrentPage(1);

    setSelectedCase(null);

    setAiResults([]);
    setAiRunSummary(null);
    setAiError('');

    setTimeline([]);
    setTimelineError('');

    setCustomer(null);
    setSourceTransaction(null);

    setExecutionResult(null);

    await loadCases(nextStatus);
  }

  /*
   * --------------------------------------------------
   * AI ANALYSIS
   * --------------------------------------------------
   *
   * IMPORTANT:
   *
   * AI analysis is tied to the case selected
   * by the merchant.
   *
   * We NEVER auto-select another case after
   * the AI response is received.
   * --------------------------------------------------
   */

  async function handleAIAnalysis() {
    const selectedCaseId =
      selectedCase?._id
        ? String(selectedCase._id)
        : null;

    if (!selectedCaseId) {
      setAiError(
        'Select a recovery case before running AI analysis.',
      );

      return;
    }

    /*
     * Terminal cases are already closed. Running AI again
     * would create duplicate AI/policy audit events and
     * can produce a recommendation that cannot be executed.
     */
    if (
      selectedCase?.status ===
      'ACTION_EXECUTED'
    ) {
      setAiError(
        'AI analysis is not available while this recovery action is awaiting payment confirmation.',
      );

      return;
    }

    if (
      TERMINAL_STATUSES.has(
        selectedCase?.status,
      )
    ) {
      setAiError(
        `AI analysis is not available for terminal cases (${formatLabel(
          selectedCase.status,
        )}).`,
      );

      return;
    }

    try {
      setAiLoading(true);
      setAiError('');
      setExecutionResult(null);

      /*
       * Send the exact selected case.
       */
      const response =
        await apiClient.post(
          '/recovery/ai-analysis',
          {
            recoveryCaseId:
              selectedCaseId,
          },
        );

      const result =
        response.data?.data || {};

      /*
       * Support both possible response forms.
       */
      let recommendations = [];

      if (
        Array.isArray(
          result.recommendations,
        )
      ) {
        recommendations =
          result.recommendations;
      } else if (
        result.recommendation
      ) {
        recommendations = [
          result.recommendation,
        ];
      }

      /*
       * Find recommendation for the
       * EXACT selected case.
       */
      const selectedRecommendation =
        recommendations.find(
          (recommendation) =>
            String(
              recommendation.recoveryCaseId,
            ) === selectedCaseId,
        );

      /*
       * If backend returned batch results,
       * retain them so existing matching works,
       * but never change the selected case.
       */
      setAiResults(
        recommendations,
      );

      setAiRunSummary({
        totalCases:
          result.totalCases ||
          recommendations.length ||
          1,

        totalBatches:
          result.totalBatches || 1,

        batchSize:
          result.batchSize || 1,

        recommendationCount:
          recommendations.length,
      });

      /*
       * The selected case remains unchanged.
       */
      if (!selectedRecommendation) {
        setAiError(
          'AI analysis completed, but no recommendation was returned for the selected recovery case.',
        );

        return;
      }

      /*
       * Success.
       */
      setAiError('');
    } catch (requestError) {
      console.error(
        'AI analysis error:',
        requestError,
      );

      const statusCode =
        requestError.response?.status;

      if (statusCode === 429) {
        setAiError(
          'AI service is temporarily rate-limited. Please wait a little and try again.',
        );

        return;
      }

      if (statusCode === 401) {
        setAiError(
          'Your authentication session has expired. Please log in again.',
        );

        return;
      }

      if (statusCode === 404) {
        setAiError(
          requestError.response?.data
            ?.message ||
            'Selected recovery case was not found.',
        );

        return;
      }

      if (statusCode === 400) {
        setAiError(
          requestError.response?.data
            ?.message ||
            'Invalid AI analysis request.',
        );

        return;
      }

      setAiError(
        requestError.response?.data
          ?.message ||
          'Failed to run AI analysis.',
      );
    } finally {
      setAiLoading(false);
    }
  }

  /*
   * --------------------------------------------------
   * EXECUTE FINAL ACTION
   * --------------------------------------------------
   */

  async function handleExecute() {
    if (!selectedCase) {
      return;
    }

    /*
     * ACTION_EXECUTED means the recovery action has already
     * been performed. Do not allow it to be executed twice.
     */
    if (
      selectedCase.status ===
      'ACTION_EXECUTED'
    ) {
      setExecutionResult({
        error:
          'This recovery action has already been executed and is awaiting payment confirmation.',
      });

      return;
    }

    if (selectedCaseIsTerminal) {
      setExecutionResult({
        error:
          `This case is already ${formatLabel(
            selectedCase.status,
          )}. No further recovery action can be executed.`,
      });

      return;
    }

    if (!selectedAIResult) {
      setExecutionResult({
        error:
          'Run AI Analysis for this case before executing the final recovery action.',
      });

      return;
    }

    const finalAction =
      selectedAIResult.finalAction;

    if (!finalAction) {
      setExecutionResult({
        error:
          'No deterministic final action is available for this case.',
      });

      return;
    }

    setExecutionResult(null);

    setActionConfirmation({
      caseId:
        selectedCase._id,

      action:
        finalAction,

      status:
        selectedCase.status,

      amountAtRiskMinor:
        selectedCase.amountAtRiskMinor,
    });
  }

  function closeActionConfirmation() {
    if (executionLoading) {
      return;
    }

    setActionConfirmation(null);
  }

  async function confirmExecute() {
    if (
      !actionConfirmation ||
      !selectedCase
    ) {
      return;
    }

    const caseId =
      String(
        actionConfirmation.caseId,
      );

    const finalAction =
      actionConfirmation.action;

    /*
     * Close modal immediately so a backend response
     * can never leave the confirmation window stuck.
     */
    setActionConfirmation(null);

    setExecutionLoading(true);
    setExecutionResult(null);

    try {
      const response =
        await apiClient.post(
          '/recovery/execute',
          {
            caseId,
            recoveryCaseId: caseId,
          },
        );

      const responseBody =
        response?.data ??
        response ??
        {};

      const responseData =
        responseBody?.data ??
        responseBody ??
        {};

      const execution =
        responseData?.execution ??
        responseBody?.execution ??
        null;

      const decision =
        responseData?.decision ??
        responseBody?.decision ??
        null;

      if (
        responseBody?.success === false
      ) {
        throw new Error(
          responseBody?.message ||
          responseData?.message ||
          'Recovery action was rejected by the server.',
        );
      }

      const nextStatus =
        execution?.status ||
        responseData?.currentStatus ||
        responseData?.status ||
        selectedCase.status;

      const nextAction =
        execution?.action ||
        decision?.action ||
        responseData?.action ||
        selectedCase.currentAction ||
        finalAction;

      const updatedCase = {
        ...selectedCase,

        status:
          nextStatus,

        currentAction:
          nextAction,

        actionTaken:
          selectedCase.actionTaken ||
          nextAction,
      };

      setSelectedCase(
        updatedCase,
      );

      setCases(
        (currentCases) =>
          currentCases.map(
            (item) =>
              String(item._id) ===
              String(updatedCase._id)
                ? {
                    ...item,
                    ...updatedCase,
                  }
                : item,
          ),
      );

      await loadTimeline(
        updatedCase._id,
      );

      if (
        execution?.blocked
      ) {
        setExecutionResult({
          blocked: true,

          message:
            execution.reason ||
            `The ${formatLabel(
              finalAction,
            )} action was blocked.`,

          finalAction,

          action:
            execution.action ||
            finalAction,

          status:
            nextStatus,
        });
      } else {
        setExecutionResult({
          success: true,

          waitingForConfirmation:
            nextStatus ===
            'ACTION_EXECUTED',

          message:
            nextStatus ===
            'ACTION_EXECUTED'
              ? `Recovery action ${formatLabel(
                  finalAction,
                )} was executed and is awaiting payment confirmation.`
              : `Recovery action ${formatLabel(
                  finalAction,
                )} was processed successfully.`,

          finalAction,

          status:
            nextStatus,
        });
      }
    } catch (requestError) {
      console.error(
        'Recovery execution error:',
        requestError,
      );

      setExecutionResult({
        error:
          requestError.response?.data
            ?.message ||
          requestError.message ||
          'Failed to execute recovery action.',
      });
    } finally {
      setExecutionLoading(false);
    }
  }

  /*
   * --------------------------------------------------
   * PAYMENT CONFIRMATION
   * --------------------------------------------------
   */

  function handleOpenPaymentConfirmation() {
    if (!selectedCase) {
      return;
    }

    if (
      selectedCase.status !==
      'ACTION_EXECUTED'
    ) {
      setExecutionResult({
        error:
          'Payment confirmation is available only after a recovery action has been executed.',
      });

      return;
    }

    const eligible =
      Number(
        selectedCase.eligibleAmountMinor ||
          0,
      );

    const recovered =
      Number(
        selectedCase.recoveredAmountMinor ||
          0,
      );

    const remaining =
      Math.max(
        eligible - recovered,
        0,
      );

    if (remaining <= 0) {
      setExecutionResult({
        error:
          'No eligible amount remains for payment confirmation.',
      });

      return;
    }

    setPaymentAmount(
      (remaining / 100).toFixed(2),
    );

    setPaymentTransactionId('');

    setPaymentConfirmation({
      caseId:
        selectedCase._id,

      action:
        selectedCase.currentAction,

      status:
        selectedCase.status,

      remainingAmountMinor:
        remaining,
    });

    setExecutionResult(null);
  }

  function closePaymentConfirmation() {
    if (executionLoading) {
      return;
    }

    setPaymentConfirmation(null);
  }

  async function confirmPayment() {
    if (
      !paymentConfirmation ||
      !selectedCase
    ) {
      return;
    }

    const amountRupees =
      Number(paymentAmount);

    if (
      !Number.isFinite(amountRupees) ||
      amountRupees <= 0
    ) {
      setExecutionResult({
        error:
          'Enter a valid recovered amount.',
      });

      return;
    }

    const recoveredAmountMinor =
      Math.round(
        amountRupees * 100,
      );

    if (
      recoveredAmountMinor >
      paymentConfirmation.remainingAmountMinor
    ) {
      setExecutionResult({
        error:
          `Recovered amount cannot exceed ${formatCurrency(
            paymentConfirmation.remainingAmountMinor,
          )}.`,
      });

      return;
    }

    const recoveryCaseId =
      String(
        paymentConfirmation.caseId,
      );

    /*
     * Close the modal immediately after confirmation.
     */
    setPaymentConfirmation(null);

    setExecutionLoading(true);
    setExecutionResult(null);

    try {
      const response =
        await apiClient.post(
          '/recovery/confirm',
          {
            recoveryCaseId,

            recoveredAmountMinor,

            paymentTransactionId:
              paymentTransactionId.trim() ||
              null,
          },
        );

      const responseBody =
        response?.data ??
        response ??
        {};

      const result =
        responseBody?.data ??
        responseBody ??
        {};

      if (
        responseBody?.success === false
      ) {
        throw new Error(
          responseBody?.message ||
          result?.message ||
          'Recovery confirmation was rejected by the server.',
        );
      }

      const totalRecovered =
        Number(
          result.totalRecoveredAmountMinor,
        );

      const currentRecovered =
        Number(
          selectedCase.recoveredAmountMinor ||
            0,
        );

      const updatedRecovered =
        Number.isFinite(
          totalRecovered,
        )
          ? totalRecovered
          : currentRecovered +
            recoveredAmountMinor;

      const nextStatus =
        result.status ||
        (
          result.fullyRecovered
            ? 'RECOVERED'
            : 'ACTION_EXECUTED'
        );

      const updatedCase = {
        ...selectedCase,

        recoveredAmountMinor:
          updatedRecovered,

        status:
          nextStatus,

        currentAction:
          nextStatus ===
          'RECOVERED'
            ? 'STOP'
            : selectedCase.currentAction,
      };

      setSelectedCase(
        updatedCase,
      );

      setCases(
        (currentCases) =>
          currentCases.map(
            (item) =>
              String(item._id) ===
              String(updatedCase._id)
                ? {
                    ...item,
                    ...updatedCase,
                  }
                : item,
          ),
      );

      await loadTimeline(
        recoveryCaseId,
      );

      setExecutionResult({
        success: true,

        paymentConfirmed:
          true,

        message:
          result.fullyRecovered
            ? 'Payment confirmed. The full eligible revenue has been recovered.'
            : 'Payment confirmed. Partial recovered revenue has been recorded.',

        status:
          nextStatus,

        finalAction:
          selectedCase.currentAction,

        recoveredAmountMinor,

        totalRecoveredAmountMinor:
          updatedRecovered,

        remainingAmountMinor:
          result.remainingAmountMinor ??
          Math.max(
            Number(
              selectedCase.eligibleAmountMinor ||
                0,
            ) -
            updatedRecovered,
            0,
          ),
      });

      /*
       * A fully recovered case is terminal, so remove its
       * stale AI recommendation from the client state.
       */
      if (
        nextStatus ===
        'RECOVERED'
      ) {
        setAiResults(
          (currentResults) =>
            currentResults.filter(
              (item) =>
                String(
                  item.recoveryCaseId,
                ) !==
                recoveryCaseId,
            ),
        );
      }
    } catch (requestError) {
      console.error(
        'Recovery confirmation error:',
        requestError,
      );

      setExecutionResult({
        error:
          requestError.response?.data
            ?.message ||
          requestError.message ||
          'Failed to confirm payment recovery.',
      });
    } finally {
      setExecutionLoading(false);
      setPaymentAmount('');
      setPaymentTransactionId('');
    }
  }

  /*
   * --------------------------------------------------
   * FILTER CASES
   * --------------------------------------------------
   */

  const visibleCases =
    useMemo(() => {
      let result = cases;

      if (
        status ===
        'ACTION_REQUIRED'
      ) {
        result = result.filter((item) =>
          ACTION_REQUIRED_STATUSES.has(
            item.status,
          ),
        );
      }

      const query =
        search.trim().toLowerCase();

      if (query) {
        result = result.filter(
          (item) =>
            [
              item._id,
              item.type,
              item.status,
              item.currentAction,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query),
        );
      }

      return result;
    }, [
      cases,
      status,
      search,
    ]);

  /*
   * --------------------------------------------------
   * PAGINATION
   * --------------------------------------------------
   */

  const totalPages = Math.max(
    1,
    Math.ceil(
      visibleCases.length /
        CASES_PER_PAGE,
    ),
  );

  const safeCurrentPage =
    Math.min(
      currentPage,
      totalPages,
    );

  const paginatedCases =
    visibleCases.slice(
      (safeCurrentPage - 1) *
        CASES_PER_PAGE,

      safeCurrentPage *
        CASES_PER_PAGE,
    );

  function goToPage(page) {
    setCurrentPage(
      Math.min(
        Math.max(page, 1),
        totalPages,
      ),
    );
  }

  function handleSearchChange(
    event,
  ) {
    setSearch(
      event.target.value,
    );

    setCurrentPage(1);
  }

  /*
   * --------------------------------------------------
   * SELECTED CASE AI RESULT
   * --------------------------------------------------
   */

  const selectedAIResult =
    selectedCase
      ? aiResults.find(
          (item) =>
            String(
              item.recoveryCaseId,
            ) ===
            String(
              selectedCase._id,
            ),
        )
      : null;

  const selectedCaseNeedsAction =
    selectedCase
      ? ACTION_REQUIRED_STATUSES.has(
          selectedCase.status,
        )
      : false;

  const selectedCaseIsTerminal =
    Boolean(
      selectedCase &&
      TERMINAL_STATUSES.has(
        selectedCase.status,
      ),
    );

  const selectedCaseAwaitingPayment =
    Boolean(
      selectedCase?.status ===
        'ACTION_EXECUTED',
    );

  const canRunAI =
    Boolean(selectedCase) &&
    !selectedCaseIsTerminal &&
    !selectedCaseAwaitingPayment &&
    !aiLoading;

  const canExecute =
    Boolean(
      selectedCase &&
      selectedAIResult &&
      selectedAIResult.finalAction,
    ) &&
    !selectedCaseIsTerminal &&
    !selectedCaseAwaitingPayment &&
    !TERMINAL_STATUSES.has(
      selectedCase?.status,
    );

  return (
    <div className="cases-page">

      {/* ==================================================
          HEADER
      ================================================== */}

      <div className="page-header">
        <div>
          <p className="eyebrow">
            RECOVERY OPERATIONS
          </p>

          <h1>
            Recovery Cases
          </h1>

          <p className="page-subtitle">
            Review revenue-risk cases,
            AI recommendations and
            deterministic recovery actions.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={
            handleAIAnalysis
          }
          disabled={!canRunAI}
          title={
            !selectedCase
              ? 'Select a recovery case first'
              : selectedCaseIsTerminal
                ? 'Terminal cases cannot be analyzed again'
                : 'Run AI analysis for the selected case'
          }
        >
          {aiLoading
            ? 'Analyzing...'
            : 'Run AI Analysis'}
        </button>
      </div>

      {/* ==================================================
          FILTER BAR
      ================================================== */}

      <div className="cases-toolbar">

        <div className="toolbar-field">
          <label htmlFor="case-status">
            View
          </label>

          <select
            id="case-status"
            value={status}
            onChange={
              handleStatusChange
            }
          >
            {STATUS_OPTIONS.map(
              (option) => (
                <option
                  key={option}
                  value={option}
                >
                  {option ===
                  'ACTION_REQUIRED'
                    ? 'Action Required'
                    : option === 'ALL'
                      ? 'All Cases'
                      : formatLabel(
                          option,
                        )}
                </option>
              ),
            )}
          </select>
        </div>

        <div className="toolbar-field search-field">
          <label htmlFor="case-search">
            Search
          </label>

          <input
            id="case-search"
            type="text"
            placeholder="ID, type, status, action..."
            value={search}
            onChange={
              handleSearchChange
            }
          />
        </div>

        <button
          className="secondary-button"
          onClick={() =>
            loadCases(status)
          }
          disabled={loading}
        >
          {loading
            ? 'Refreshing...'
            : 'Refresh'}
        </button>

      </div>

      {/* ==================================================
          ERROR
      ================================================== */}

      {error && (
        <div className="page-error">
          {error}
        </div>
      )}

      {aiError && (
        <div className="page-error">
          {aiError}
        </div>
      )}

      {/* ==================================================
          AI SUMMARY
      ================================================== */}

      {aiRunSummary && (
        <div className="ai-run-banner">

          <div>
            <strong>
              AI Analysis Complete
            </strong>

            <span>
              {
                aiRunSummary.recommendationCount
              }{' '}
              recommendations from{' '}
              {aiRunSummary.totalCases}{' '}
              cases
            </span>
          </div>

          <span>
            {aiRunSummary.totalBatches}{' '}
            batches
          </span>

        </div>
      )}

      {/* ==================================================
          CASE LAYOUT
      ================================================== */}

      <div className="cases-layout">

        {/* ==================================================
            CASE TABLE
        ================================================== */}

        <section className="cases-card">

          <div className="card-header">

            <div>
              <h2>
                Cases
              </h2>

              <p>
                {visibleCases.length.toLocaleString(
                  'en-IN',
                )}{' '}
                visible
              </p>
            </div>

            {visibleCases.length >
              0 && (
              <div className="pagination-summary">
                Page {safeCurrentPage}{' '}
                of {totalPages}
              </div>
            )}

          </div>

          {loading ? (
            <div className="empty-state">
              Loading cases...
            </div>
          ) : visibleCases.length ===
            0 ? (
            <div className="empty-state">
              No recovery cases found.
            </div>
          ) : (
            <>

              <div className="table-wrapper">

                <table className="cases-table">

                  <thead>
                    <tr>
                      <th>
                        Case
                      </th>

                      <th>
                        Type
                      </th>

                      <th>
                        Status
                      </th>

                      <th>
                        At Risk
                      </th>

                      <th>
                        Action
                      </th>
                    </tr>
                  </thead>

                  <tbody>

                    {paginatedCases.map(
                      (item) => {

                        const needsAction =
                          ACTION_REQUIRED_STATUSES.has(
                            item.status,
                          );

                        const hasAI =
                          aiResults.some(
                            (
                              result,
                            ) =>
                              String(
                                result.recoveryCaseId,
                              ) ===
                              String(
                                item._id,
                              ),
                          );

                        return (
                          <tr
                            key={
                              item._id
                            }
                            className={
                              String(
                                selectedCase?._id,
                              ) ===
                              String(
                                item._id,
                              )
                                ? 'selected-row'
                                : ''
                            }
                            onClick={() =>
                              handleCaseSelect(
                                item,
                              )
                            }
                          >

                            <td>

                              <div className="case-cell">

                                <span className="case-id">
                                  {String(
                                    item._id,
                                  ).slice(
                                    -8,
                                  )}
                                </span>

                                <div className="case-tags">

                                  {needsAction && (
                                    <span className="action-required-dot">
                                      Action Required
                                    </span>
                                  )}

                                  {hasAI && (
                                    <span className="ai-available-tag">
                                      AI Ready
                                    </span>
                                  )}

                                </div>

                              </div>

                            </td>

                            <td>
                              {formatLabel(
                                item.type,
                              )}
                            </td>

                            <td>

                              <span
                                className={`status-badge status-${String(
                                  item.status ||
                                    '',
                                ).toLowerCase()}`}
                              >
                                {formatLabel(
                                  item.status,
                                )}
                              </span>

                            </td>

                            <td>
                              {formatCurrency(
                                item.amountAtRiskMinor,
                              )}
                            </td>

                            <td>
                              {formatLabel(
                                item.currentAction,
                              )}
                            </td>

                          </tr>
                        );
                      },
                    )}

                  </tbody>

                </table>

              </div>

              {/* PAGINATION */}

              <div className="pagination">

                <button
                  className="pagination-button"
                  disabled={
                    safeCurrentPage ===
                    1
                  }
                  onClick={() =>
                    goToPage(
                      safeCurrentPage -
                        1,
                    )
                  }
                >
                  Previous
                </button>

                <div className="pagination-pages">

                  {Array.from(
                    {
                      length:
                        totalPages,
                    },
                    (_, index) =>
                      index + 1,
                  )
                    .filter(
                      (page) => {
                        if (
                          totalPages <=
                          7
                        ) {
                          return true;
                        }

                        return (
                          page ===
                            1 ||
                          page ===
                            totalPages ||
                          Math.abs(
                            page -
                              safeCurrentPage,
                          ) <= 1
                        );
                      },
                    )
                    .map(
                      (page) => (
                        <button
                          key={
                            page
                          }
                          className={
                            page ===
                            safeCurrentPage
                              ? 'pagination-button active'
                              : 'pagination-button'
                          }
                          onClick={() =>
                            goToPage(
                              page,
                            )
                          }
                        >
                          {page}
                        </button>
                      ),
                    )}

                </div>

                <button
                  className="pagination-button"
                  disabled={
                    safeCurrentPage ===
                    totalPages
                  }
                  onClick={() =>
                    goToPage(
                      safeCurrentPage +
                        1,
                    )
                  }
                >
                  Next
                </button>

              </div>

            </>
          )}

        </section>

        {/* ==================================================
            CASE DETAILS
        ================================================== */}

        <aside className="case-details-card">

          {!selectedCase ? (
            <div className="empty-state details-empty">
              Select a recovery case
              to view details.
            </div>
          ) : (
            <>

              {/* CASE HEADER */}

              <div className="card-header case-detail-header">

                <div>
                  <p className="eyebrow">
                    CASE DETAILS
                  </p>

                  <h2>
                    {selectedCase._id}
                  </h2>
                </div>

                {selectedCaseNeedsAction && (
                  <span className="action-required-badge">
                    Action Required
                  </span>
                )}

              </div>

              {/* CASE DETAILS */}

              <div className="detail-list">

                <div>
                  <span>
                    Type
                  </span>

                  <strong>
                    {formatLabel(
                      selectedCase.type,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Status
                  </span>

                  <strong>
                    {formatLabel(
                      selectedCase.status,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Revenue at Risk
                  </span>

                  <strong>
                    {formatCurrency(
                      selectedCase.amountAtRiskMinor,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Eligible
                  </span>

                  <strong>
                    {formatCurrency(
                      selectedCase.eligibleAmountMinor,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Recovered
                  </span>

                  <strong>
                    {formatCurrency(
                      selectedCase.recoveredAmountMinor,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Current Action
                  </span>

                  <strong>
                    {formatLabel(
                      selectedCase.currentAction,
                    )}
                  </strong>
                </div>

                <div>
                  <span>
                    Retry Attempts
                  </span>

                  <strong>
                    {
                      selectedCase.retryAttemptCount
                    }
                  </strong>
                </div>

                <div>
                  <span>
                    Reminders
                  </span>

                  <strong>
                    {
                      selectedCase.reminderCount
                    }
                  </strong>
                </div>

              </div>

              {/* ==================================================
                  CUSTOMER + TRANSACTION
              ================================================== */}

              {(customer ||
                sourceTransaction) && (
                <div className="context-card">

                  <div className="context-section">

                    <p className="eyebrow">
                      CUSTOMER
                    </p>

                    {customer ? (
                      <div className="context-grid">

                        <div>
                          <span>
                            Name
                          </span>

                          <strong>
                            {customer.fullName ||
                              '—'}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Email
                          </span>

                          <strong>
                            {customer.email ||
                              '—'}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Phone
                          </span>

                          <strong>
                            {customer.phone ||
                              '—'}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Customer ID
                          </span>

                          <strong className="mono-value">
                            {customer.externalCustomerId ||
                              customer.providerCustomerId ||
                              customer._id}
                          </strong>
                        </div>

                      </div>
                    ) : (
                      <p className="context-empty">
                        Customer information unavailable.
                      </p>
                    )}

                  </div>

                  <div className="context-divider" />

                  <div className="context-section">

                    <p className="eyebrow">
                      SOURCE TRANSACTION
                    </p>

                    {sourceTransaction ? (
                      <div className="context-grid">

                        <div>
                          <span>
                            Transaction ID
                          </span>

                          <strong className="mono-value">
                            {
                              sourceTransaction._id
                            }
                          </strong>
                        </div>

                        <div>
                          <span>
                            Amount
                          </span>

                          <strong>
                            {formatCurrency(
                              sourceTransaction.amountMinor,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Payment Method
                          </span>

                          <strong>
                            {formatLabel(
                              sourceTransaction.paymentMethod,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Failure Category
                          </span>

                          <strong>
                            {formatLabel(
                              sourceTransaction.failureCategory,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Failure Reason
                          </span>

                          <strong>
                            {sourceTransaction.failureReason ||
                              '—'}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Occurred At
                          </span>

                          <strong>
                            {formatDateTime(
                              sourceTransaction.occurredAt,
                            )}
                          </strong>
                        </div>

                      </div>
                    ) : (
                      <p className="context-empty">
                        Source transaction unavailable.
                      </p>
                    )}

                  </div>

                </div>
              )}

              {/* ==================================================
                  AI RECOMMENDATION
              ================================================== */}

              {selectedAIResult ? (
                <div className="ai-result-card">

                  <div className="ai-result-heading">

                    <p className="eyebrow">
                      AI RECOMMENDATION
                    </p>

                    <span className="ai-ready-badge">
                      AI Ready
                    </span>

                  </div>

                  <div className="ai-result-row">

                    <span>
                      Suggested Action
                    </span>

                    <strong>
                      {formatLabel(
                        selectedAIResult
                          .aiRecommendation
                          .action,
                      )}
                    </strong>

                  </div>

                  <div className="ai-result-row">

                    <span>
                      Confidence
                    </span>

                    <strong>
                      {Math.round(
                        selectedAIResult
                          .aiRecommendation
                          .confidence *
                          100,
                      )}
                      %
                    </strong>

                  </div>

                  <div className="ai-result-row">

                    <span>
                      Risk
                    </span>

                    <strong>
                      {
                        selectedAIResult
                          .aiRecommendation
                          .riskLevel
                      }
                    </strong>

                  </div>

                  <div className="ai-result-row">

                    <span>
                      Policy Decision
                    </span>

                    <strong>
                      {formatLabel(
                        selectedAIResult
                          .policyValidation
                          .policyDecision
                          .action,
                      )}
                    </strong>

                  </div>

                  <div className="ai-result-row">

                    <span>
                      Final Action
                    </span>

                    <strong>
                      {formatLabel(
                        selectedAIResult
                          .finalAction,
                      )}
                    </strong>

                  </div>

                  <div
                    className={
                      selectedAIResult
                        .policyValidation
                        .accepted
                        ? 'policy-accepted'
                        : 'policy-rejected'
                    }
                  >
                    {selectedAIResult
                      .policyValidation
                      .accepted
                      ? 'AI recommendation accepted by policy.'
                      : 'AI recommendation rejected by policy. Deterministic policy remains authoritative.'}
                  </div>

                  {/* POLICY OVERRIDE */}

                  {!selectedAIResult
                    .policyValidation
                    .accepted && (
                    <div className="policy-override-card">

                      <div className="policy-override-header">

                        <span className="policy-override-label">
                          POLICY OVERRIDE
                        </span>

                        <span className="policy-override-badge">
                          Policy Authority
                        </span>

                      </div>

                      <div className="policy-override-row">

                        <span>
                          AI suggested
                        </span>

                        <strong>
                          {formatLabel(
                            selectedAIResult
                              .aiRecommendation
                              .action,
                          )}
                        </strong>

                      </div>

                      <div className="policy-override-row">

                        <span>
                          Policy selected
                        </span>

                        <strong>
                          {formatLabel(
                            selectedAIResult
                              .policyValidation
                              .policyDecision
                              .action,
                          )}
                        </strong>

                      </div>

                      <div className="policy-override-reason">

                        <span>
                          Reason
                        </span>

                        <p>
                          {
                            selectedAIResult
                              .policyValidation
                              .policyDecision
                              .reason
                          }
                        </p>

                      </div>

                    </div>
                  )}

                  <p className="ai-reason">
                    {
                      selectedAIResult
                        .aiRecommendation
                        .reason
                    }
                  </p>

                </div>
              ) : (
                <div className="ai-empty-card">

                  <p className="eyebrow">
                    AI RECOMMENDATION
                  </p>

                  <p>
                    Select a case and click
                    “Run AI Analysis” to
                    generate its recommendation.
                  </p>

                </div>
              )}

              {/* ==================================================
                  RECOVERY TIMELINE
              ================================================== */}

              <div className="timeline-card">

                <div className="timeline-header">

                  <div>
                    <p className="eyebrow">
                      RECOVERY TIMELINE
                    </p>

                    <h3>
                      Case History
                    </h3>
                  </div>

                  {timeline.length >
                    0 && (
                    <span className="timeline-count">
                      {timeline.length}{' '}
                      events
                    </span>
                  )}

                </div>

                {timelineLoading ? (
                  <div className="timeline-state">
                    Loading timeline...
                  </div>
                ) : timelineError ? (
                  <div className="timeline-error">
                    {timelineError}
                  </div>
                ) : timeline.length ===
                  0 ? (
                  <div className="timeline-state">
                    No audit events found.
                  </div>
                ) : (
                  <div className="timeline">

                    {timeline.map(
                      (event) => (
                        <div
                          className="timeline-item"
                          key={
                            event._id
                          }
                        >

                          <div className="timeline-marker" />

                          <div className="timeline-content">

                            <div className="timeline-top">

                              <div>

                                <strong>
                                  {formatLabel(
                                    event.eventType,
                                  )}
                                </strong>

                                <span className="timeline-actor">
                                  {formatLabel(
                                    event.actorType,
                                  )}
                                </span>

                              </div>

                              <time>
                                {formatDateTime(
                                  event.occurredAt,
                                )}
                              </time>

                            </div>

                            <p>
                              {
                                event.message
                              }
                            </p>

                            <div className="timeline-meta">

                              {event.action && (
                                <span>
                                  Action:{' '}
                                  {formatLabel(
                                    event.action,
                                  )}
                                </span>
                              )}

                              {event.result && (
                                <span>
                                  Result:{' '}
                                  {formatLabel(
                                    event.result,
                                  )}
                                </span>
                              )}

                            </div>

                          </div>

                        </div>
                      ),
                    )}

                  </div>
                )}

              </div>

              {/* ==================================================
                  EXECUTION RESULT
              ================================================== */}

              {executionResult && (
                <div
                  className={
                    executionResult.error
                      ? 'execution-error'
                      : executionResult.blocked
                        ? 'execution-warning'
                        : 'execution-success'
                  }
                  role={
                    executionResult.error
                      ? 'alert'
                      : 'status'
                  }
                >
                  {executionResult.error ? (
                    <span>
                      {executionResult.error}
                    </span>
                  ) : executionResult.blocked ? (
                    <>
                      <strong>
                        Action not executed
                      </strong>

                      <span>
                        {executionResult.message}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>
                        {executionResult.paymentConfirmed
                          ? '✓ Payment confirmed'
                          : executionResult.waitingForConfirmation
                            ? '✓ Recovery action executed'
                            : '✓ Recovery action processed'}
                      </strong>

                      <span>
                        {executionResult.message}
                      </span>

                      {executionResult.status && (
                        <span>
                          Case status:{' '}
                          <strong>
                            {formatLabel(
                              executionResult.status,
                            )}
                          </strong>
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ==================================================
                  PAYMENT CONFIRMATION
              ================================================== */}

              {selectedCaseAwaitingPayment && (
                <div className="payment-confirmation-card">
                  <div className="payment-confirmation-heading">
                    <div>
                      <p className="eyebrow">
                        PAYMENT CONFIRMATION
                      </p>

                      <h3>
                        Confirm Recovery Payment
                      </h3>
                    </div>

                    <span className="payment-pending-badge">
                      Payment Pending
                    </span>
                  </div>

                  <p className="payment-confirmation-description">
                    The recovery action has already been executed.
                    Confirm the successful payment before this revenue
                    is counted as recovered.
                  </p>

                  <div className="payment-confirmation-summary">
                    <div>
                      <span>
                        Recovery Action
                      </span>

                      <strong>
                        {formatLabel(
                          selectedCase.currentAction,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Eligible Revenue
                      </span>

                      <strong>
                        {formatCurrency(
                          selectedCase.eligibleAmountMinor,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Already Recovered
                      </span>

                      <strong>
                        {formatCurrency(
                          selectedCase.recoveredAmountMinor,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Remaining
                      </span>

                      <strong>
                        {formatCurrency(
                          Math.max(
                            Number(
                              selectedCase.eligibleAmountMinor ||
                                0,
                            ) -
                            Number(
                              selectedCase.recoveredAmountMinor ||
                                0,
                            ),
                            0,
                          ),
                        )}
                      </strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="primary-button full-width"
                    onClick={
                      handleOpenPaymentConfirmation
                    }
                    disabled={
                      executionLoading
                    }
                  >
                    Confirm Payment
                  </button>
                </div>
              )}

              {/* ==================================================
                  FINAL ACTION / CLOSED STATE
              ================================================== */}

              {selectedCaseIsTerminal ? (
                <div
                  className="terminal-action-state"
                  role="status"
                >
                  <strong
                    style={{
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    Case Closed
                  </strong>

                  <span
                    style={{
                      display: 'block',
                      lineHeight: 1.5,
                    }}
                  >
                    This case is now{' '}
                    <strong>
                      {formatLabel(
                        selectedCase.status,
                      )}
                    </strong>
                    . No further recovery action is available.
                  </span>
                </div>
              ) : selectedCaseAwaitingPayment ? (
                <div
                  className="terminal-action-state payment-awaiting-state"
                  role="status"
                >
                  <strong
                    style={{
                      display: 'block',
                      marginBottom: '4px',
                    }}
                  >
                    Recovery Awaiting Payment Confirmation
                  </strong>

                  <span
                    style={{
                      display: 'block',
                      lineHeight: 1.5,
                    }}
                  >
                    Do not execute another recovery action.
                    Confirm the payment above when the payment
                    has actually succeeded.
                  </span>
                </div>
              ) : (
                <button
                  className="primary-button full-width"
                  onClick={
                    handleExecute
                  }
                  disabled={
                    executionLoading ||
                    !canExecute
                  }
                >
                  {executionLoading
                    ? 'Processing...'
                    : selectedAIResult
                      ? `Execute Final Action: ${formatLabel(
                          selectedAIResult.finalAction,
                        )}`
                      : 'Run AI Analysis First'}
                </button>
              )}

              {/* ==================================================
                  ACTION CONFIRMATION MODAL
              ================================================== */}

              {actionConfirmation && (
                <div
                  className="action-modal-backdrop"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (
                      event.target ===
                      event.currentTarget
                    ) {
                      closeActionConfirmation();
                    }
                  }}
                >
                  <div
                    className="action-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="action-confirmation-title"
                    onMouseDown={(event) =>
                      event.stopPropagation()
                    }
                  >
                    <div className="action-modal-header">
                      <div>
                        <p className="eyebrow">
                          CONFIRM RECOVERY ACTION
                        </p>

                        <h3
                          id="action-confirmation-title"
                        >
                          Confirm {formatLabel(
                            actionConfirmation.action,
                          )}
                        </h3>
                      </div>

                      <button
                        type="button"
                        className="action-modal-close"
                        onClick={
                          closeActionConfirmation
                        }
                        disabled={
                          executionLoading
                        }
                        aria-label="Close confirmation"
                      >
                        ×
                      </button>
                    </div>

                    <div className="action-modal-body">
                      <p>
                        You are about to execute the
                        policy-approved recovery action for
                        this case.
                      </p>

                      <div className="action-modal-summary">
                        <div>
                          <span>
                            Current Status
                          </span>

                          <strong>
                            {formatLabel(
                              actionConfirmation.status,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Final Action
                          </span>

                          <strong>
                            {formatLabel(
                              actionConfirmation.action,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Revenue at Risk
                          </span>

                          <strong>
                            {formatCurrency(
                              actionConfirmation.amountAtRiskMinor,
                            )}
                          </strong>
                        </div>
                      </div>

                      {actionConfirmation.action ===
                        'STOP' && (
                        <div className="action-warning">
                          <strong>
                            Stop recovery?
                          </strong>

                          <span>
                            This will stop further automated
                            recovery attempts for this case.
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="action-modal-footer">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={
                          closeActionConfirmation
                        }
                        disabled={
                          executionLoading
                        }
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        className="primary-button"
                        onClick={
                          confirmExecute
                        }
                        disabled={
                          executionLoading
                        }
                      >
                        {executionLoading
                          ? 'Processing...'
                          : `Confirm ${formatLabel(
                              actionConfirmation.action,
                            )}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}


              {/* ==================================================
                  PAYMENT CONFIRMATION MODAL
              ================================================== */}

              {paymentConfirmation && (
                <div
                  className="action-modal-backdrop"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (
                      event.target ===
                      event.currentTarget
                    ) {
                      closePaymentConfirmation();
                    }
                  }}
                >
                  <div
                    className="action-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="payment-confirmation-title"
                    onMouseDown={(event) =>
                      event.stopPropagation()
                    }
                  >
                    <div className="action-modal-header">
                      <div>
                        <p className="eyebrow">
                          VERIFY RECOVERY PAYMENT
                        </p>

                        <h3
                          id="payment-confirmation-title"
                        >
                          Confirm Payment
                        </h3>
                      </div>

                      <button
                        type="button"
                        className="action-modal-close"
                        onClick={
                          closePaymentConfirmation
                        }
                        disabled={
                          executionLoading
                        }
                        aria-label="Close payment confirmation"
                      >
                        ×
                      </button>
                    </div>

                    <div className="action-modal-body">
                      <p>
                        Confirm the amount only after the customer
                        payment has actually succeeded.
                      </p>

                      <div className="action-modal-summary">
                        <div>
                          <span>
                            Case Status
                          </span>

                          <strong>
                            {formatLabel(
                              paymentConfirmation.status,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Recovery Action
                          </span>

                          <strong>
                            {formatLabel(
                              paymentConfirmation.action,
                            )}
                          </strong>
                        </div>

                        <div>
                          <span>
                            Remaining Eligible
                          </span>

                          <strong>
                            {formatCurrency(
                              paymentConfirmation.remainingAmountMinor,
                            )}
                          </strong>
                        </div>
                      </div>

                      <div
                        style={{
                          marginTop: '16px',
                          display: 'grid',
                          gap: '12px',
                        }}
                      >
                        <div className="toolbar-field">
                          <label htmlFor="recovered-amount">
                            Recovered Amount (₹)
                          </label>

                          <input
                            id="recovered-amount"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={
                              paymentAmount
                            }
                            onChange={(event) =>
                              setPaymentAmount(
                                event.target.value,
                              )
                            }
                            placeholder="799.00"
                            disabled={
                              executionLoading
                            }
                          />
                        </div>

                        <div className="toolbar-field">
                          <label htmlFor="payment-transaction-id">
                            Payment Transaction ID
                            <span
                              style={{
                                marginLeft: '5px',
                                fontWeight: 400,
                              }}
                            >
                              (optional)
                            </span>
                          </label>

                          <input
                            id="payment-transaction-id"
                            type="text"
                            value={
                              paymentTransactionId
                            }
                            onChange={(event) =>
                              setPaymentTransactionId(
                                event.target.value,
                              )
                            }
                            placeholder="Provider payment transaction ID"
                            disabled={
                              executionLoading
                            }
                          />
                        </div>
                      </div>

                      <div className="action-warning">
                        <strong>
                          Payment confirmation is authoritative
                        </strong>

                        <span>
                          Revenue will be counted as recovered only
                          after this confirmation is accepted by
                          the recovery service.
                        </span>
                      </div>
                    </div>

                    <div className="action-modal-footer">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={
                          closePaymentConfirmation
                        }
                        disabled={
                          executionLoading
                        }
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        className="primary-button"
                        onClick={
                          confirmPayment
                        }
                        disabled={
                          executionLoading
                        }
                      >
                        {executionLoading
                          ? 'Confirming...'
                          : 'Confirm Payment'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </>
          )}

        </aside>

      </div>
    </div>
  );
}

export default RecoveryCases;