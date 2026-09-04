import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDefaultFromDate() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return formatDateInput(date);
}

function getDefaultToDate() {
  return formatDateInput(new Date());
}

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
  /*
   * The details panel is the actual scroll container.
   * We preserve its scroll position while the 3-second
   * payment-status polling refreshes the timeline.
   */
  const detailsCardRef = useRef(null);
  const timelineScrollPositionRef = useRef(null);
  const timelineLoadedRef = useRef(false);
  const timelineRef = useRef([]);
  const timelineRequestInFlightRef = useRef(false);

  const [cases, setCases] = useState([]);
  const [selectedCase, setSelectedCase] =
    useState(null);

  const [status, setStatus] =
    useState('ACTION_REQUIRED');

  const [fromDate, setFromDate] =
    useState(getDefaultFromDate);

  const [toDate, setToDate] =
    useState(getDefaultToDate);

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

    const [riskAnalysisLoading, setRiskAnalysisLoading] = useState(false);

 const [aiResults, setAiResults] = useState([]);
const [bulkAIResults, setBulkAIResults] = useState([]);

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

  const [
    bulkActionConfirmation,
    setBulkActionConfirmation,
  ] = useState(null);

  const [
    bulkExecutionLoading,
    setBulkExecutionLoading,
  ] = useState(false);

  /*
   * --------------------------------------------------
   * CUSTOMER PAYMENT LINK STATE
   * --------------------------------------------------
   */

  const [paymentLink, setPaymentLink] =
    useState(null);

  const [paymentResult, setPaymentResult] =
    useState(null);

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

      timelineScrollPositionRef.current =
        null;
      timelineLoadedRef.current = false;
      timelineRef.current = [];

      setTimeline([]);
      setTimelineError('');

      setCustomer(null);
      setSourceTransaction(null);

      setAiResults([]);
      setBulkAIResults([]);
      setAiRunSummary(null);
      setAiError('');

      setExecutionResult(null);
      setPaymentLink(null);

      setPaymentResult(null);

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
    if (!recoveryCaseId || timelineRequestInFlightRef.current) {
      return;
    }

    timelineRequestInFlightRef.current = true;

    const isInitialTimelineLoad =
      !timelineLoadedRef.current;

    try {
      if (isInitialTimelineLoad) {
        setTimelineLoading(true);
      }
      setTimelineError('');

      const response =
        await apiClient.get(
          `/recovery/cases/${recoveryCaseId}/timeline`,
        );

      const data =
        response.data?.data || {};

      const caseData =
        data.case || null;

      if (caseData) {
        setSelectedCase((currentCase) => {
          if (!currentCase) {
            return currentCase;
          }

          const fields = [
            '_id','status','currentAction','actionTaken',
            'amountAtRiskMinor','eligibleAmountMinor','recoveredAmountMinor',
            'recoveryTransactionId','recoveredAt','retryAttemptCount',
            'reminderCount','nextActionAt',
          ];

          const unchanged = fields.every(
            (field) => currentCase[field] === caseData[field],
          );

          return unchanged ? currentCase : { ...currentCase, ...caseData };
        });

        setCases((currentCases) =>
          currentCases.map((item) => {
            if (String(item._id) !== String(caseData._id)) return item;
            const fields = [
              '_id','status','currentAction','actionTaken',
              'amountAtRiskMinor','eligibleAmountMinor','recoveredAmountMinor',
              'recoveryTransactionId','recoveredAt','retryAttemptCount',
              'reminderCount','nextActionAt',
            ];
            const unchanged = fields.every(
              (field) => item[field] === caseData[field],
            );
            return unchanged ? item : { ...item, ...caseData };
          }),
        );
      }

      const nextCustomer = data.customer || null;
      const nextSourceTransaction = data.sourceTransaction || null;

      setCustomer((currentCustomer) => {
        if (!currentCustomer && !nextCustomer) return currentCustomer;
        if (!currentCustomer || !nextCustomer) return nextCustomer;
        const unchanged =
          String(currentCustomer._id || '') === String(nextCustomer._id || '') &&
          currentCustomer.fullName === nextCustomer.fullName &&
          currentCustomer.email === nextCustomer.email &&
          currentCustomer.phone === nextCustomer.phone;
        return unchanged ? currentCustomer : nextCustomer;
      });

      setSourceTransaction((currentTransaction) => {
        if (!currentTransaction && !nextSourceTransaction) return currentTransaction;
        if (!currentTransaction || !nextSourceTransaction) return nextSourceTransaction;
        const unchanged =
          String(currentTransaction._id || '') === String(nextSourceTransaction._id || '') &&
          currentTransaction.status === nextSourceTransaction.status &&
          currentTransaction.amountMinor === nextSourceTransaction.amountMinor &&
          currentTransaction.currency === nextSourceTransaction.currency &&
          currentTransaction.paymentMethod === nextSourceTransaction.paymentMethod &&
          currentTransaction.occurredAt === nextSourceTransaction.occurredAt;
        return unchanged ? currentTransaction : nextSourceTransaction;
      });

      const loadedTimeline =
        Array.isArray(data.timeline)
          ? data.timeline
          : [];

      const previousTimeline =
        timelineRef.current;

      const timelineChanged =
        previousTimeline.length !==
          loadedTimeline.length ||
        previousTimeline.some(
          (previousEvent, index) => {
            const nextEvent =
              loadedTimeline[index];

            if (!nextEvent) {
              return true;
            }

            return (
              String(previousEvent?._id) !==
                String(nextEvent?._id) ||
              previousEvent?.occurredAt !==
                nextEvent?.occurredAt ||
              previousEvent?.eventType !==
                nextEvent?.eventType ||
              previousEvent?.result !==
                nextEvent?.result ||
              previousEvent?.message !==
                nextEvent?.message
            );
          },
        );

      if (timelineChanged) {
        /*
         * Capture the user's current position only when the
         * timeline is actually going to change. Routine polling
         * with unchanged audit events must not cause a repaint.
         */
        const detailsCard =
          detailsCardRef.current;

        if (detailsCard) {
          const maxScrollTop =
            Math.max(
              0,
              detailsCard.scrollHeight -
                detailsCard.clientHeight,
            );

          const currentScrollTop =
            detailsCard.scrollTop;

          timelineScrollPositionRef.current = {
            scrollTop: currentScrollTop,
            distanceFromBottom:
              Math.max(
                0,
                maxScrollTop -
                  currentScrollTop,
              ),
            wasAtBottom:
              maxScrollTop > 0 &&
              maxScrollTop -
                currentScrollTop <= 8,
          };
        } else {
          timelineScrollPositionRef.current =
            null;
        }

        timelineRef.current =
          loadedTimeline;
        setTimeline(loadedTimeline);
      }

      timelineLoadedRef.current = true;
      /*
       * --------------------------------------------------
       * FIND LATEST RAZORPAY PAYMENT LINK
       * --------------------------------------------------
       */

      const paymentLinkEvent =
        [...loadedTimeline]
          .reverse()
          .find((event) => {
            if (
              event.eventType !==
              'RECOVERY_ACTION_SELECTED'
            ) {
              return false;
            }

            const metadata =
              event.metadata || {};

            return Boolean(
              metadata.razorpayPaymentLinkId &&
              metadata.paymentLinkUrl,
            );
          });

      if (paymentLinkEvent) {
        const metadata = paymentLinkEvent.metadata || {};
        const nextPaymentLink = {
          created: true, reused: true,
          paymentLinkId: metadata.razorpayPaymentLinkId,
          paymentLinkUrl: metadata.paymentLinkUrl,
          amountMinor: Number(metadata.amountMinor || metadata.paymentLinkAmountMinor || 0),
          currency: metadata.currency || caseData?.currency || 'INR',
          status: metadata.paymentLinkStatus || 'CREATED',
          referenceId: metadata.referenceId || null,
          expiresAt: metadata.expiresAt || null,
          notification: {
            email: String(metadata.notificationEmail) === 'true',
            sms: String(metadata.notificationSms) === 'true',
          },
        };
        setPaymentLink((current) => {
          if (!current) return nextPaymentLink;
          const same =
            current.paymentLinkId === nextPaymentLink.paymentLinkId &&
            current.paymentLinkUrl === nextPaymentLink.paymentLinkUrl &&
            current.amountMinor === nextPaymentLink.amountMinor &&
            current.currency === nextPaymentLink.currency &&
            current.status === nextPaymentLink.status &&
            current.referenceId === nextPaymentLink.referenceId &&
            current.expiresAt === nextPaymentLink.expiresAt &&
            current.notification?.email === nextPaymentLink.notification.email &&
            current.notification?.sms === nextPaymentLink.notification.sms;
          return same ? current : nextPaymentLink;
        });
      } else if (
        caseData?.status !==
        'ACTION_EXECUTED'
      ) {
        setPaymentLink(null);
      }

      /*
       * --------------------------------------------------
       * FIND SUCCESSFUL PAYMENT
       * --------------------------------------------------
       */

      const paymentSuccessEvent =
        [...loadedTimeline]
          .reverse()
          .find(
            (event) =>
              event.eventType ===
              'PAYMENT_SUCCEEDED',
          );

      if (paymentSuccessEvent) {
        const metadata =
          paymentSuccessEvent.metadata || {};

        const nextPaymentResult = {
          success: true,

          provider:
            paymentSuccessEvent.actorType ===
            'RAZORPAY'
              ? 'Razorpay'
              : paymentSuccessEvent.actorType,

          /* Our MongoDB transaction ID. */
          paymentTransactionId:
            metadata.paymentTransactionId ||
            caseData?.recoveryTransactionId ||
            null,

          /* Razorpay provider payment ID. */
          razorpayPaymentId:
            metadata.razorpayPaymentId ||
            metadata.providerPaymentId ||
            null,

          paymentStatus:
            metadata.paymentStatus ||
            'CAPTURED',

          amountMinor:
            Number(
              metadata.amountMinor ||
                0,
            ),

          currency:
            metadata.currency ||
            caseData?.currency ||
            'INR',

          source:
            metadata.source ||
            'RAZORPAY',

          recoveredAmountMinor:
            Number(
              caseData?.recoveredAmountMinor ||
                metadata.amountMinor ||
                0,
            ),

          recoveredAt:
            caseData?.recoveredAt ||
            paymentSuccessEvent.occurredAt ||
            null,
        };

        setPaymentResult((current) => {
          if (!current) return nextPaymentResult;
          const keys = ['provider','paymentTransactionId','razorpayPaymentId','paymentStatus','amountMinor','currency','source','recoveredAmountMinor','recoveredAt'];
          return keys.every((key) => current[key] === nextPaymentResult[key]) ? current : nextPaymentResult;
        });
      } else {
        setPaymentResult((current) =>
          current === null ? current : null,
        );
      }
    } catch (requestError) {
      setTimelineError(
        requestError.response?.data
          ?.message ||
          'Failed to load case context.',
      );
    } finally {
      timelineRequestInFlightRef.current =
        false;

      if (isInitialTimelineLoad) {
        setTimelineLoading(false);
      }
    }
  }

  /*
   * Restore the details-card scroll position after React has
   * committed the refreshed timeline DOM.
   *
   * useLayoutEffect runs before the browser paints, so the user
   * does not see the panel jump to the top between frames.
   */
  useLayoutEffect(() => {
    const saved =
      timelineScrollPositionRef.current;

    const detailsCard =
      detailsCardRef.current;

    if (!saved || !detailsCard) {
      return;
    }

    const maxScrollTop =
      Math.max(
        0,
        detailsCard.scrollHeight -
          detailsCard.clientHeight,
      );

    if (saved.wasAtBottom) {
      detailsCard.scrollTop =
        maxScrollTop;
    } else {
      detailsCard.scrollTop =
        Math.min(
          saved.scrollTop,
          maxScrollTop,
        );
    }

    timelineScrollPositionRef.current =
      null;
  }, [timeline]);

  useEffect(() => {
    loadCases(status);
    // Initial data load only. Subsequent status/refresh actions
    // explicitly call loadCases().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !selectedCase?._id ||
      selectedCase.status !==
        'ACTION_EXECUTED'
    ) {
      return undefined;
    }

    const pollId =
      window.setInterval(() => {
        loadTimeline(
          selectedCase._id,
        );
      }, 3000);

    return () => {
      window.clearInterval(
        pollId,
      );
    };
  }, [
    selectedCase?._id,
    selectedCase?.status,
  ]);

  /*
   * --------------------------------------------------
   * CASE SELECTION
   * --------------------------------------------------
   */

  function handleCaseSelect(item) {
    /*
     * A new case should start at the top. Subsequent polling
     * will preserve whatever position the user chooses.
     */
    timelineScrollPositionRef.current =
      null;
    timelineLoadedRef.current = false;
    timelineRef.current = [];

    if (detailsCardRef.current) {
      detailsCardRef.current.scrollTop = 0;
    }

    setSelectedCase(item);

    /*
     * Clear case-specific information first.
     */
    setTimeline([]);
    setTimelineError('');

    setCustomer(null);
    setSourceTransaction(null);

    setExecutionResult(null);
    setPaymentLink(null);
    setPaymentResult(null);

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

    timelineScrollPositionRef.current =
      null;
    timelineLoadedRef.current = false;
    timelineRef.current = [];

    setAiResults([]);
    setBulkAIResults([]);
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

  async function handleTransactionRiskAnalysis() {
  try {
    setRiskAnalysisLoading(true);
    setError('');

    const response = await apiClient.post(
      '/recovery/analyze-transactions',
      {}
    );

    const result = response.data?.data || {};

    setSelectedCase(null);
    setAiResults([]);
    setBulkAIResults([]);
    setAiRunSummary(null);
    setExecutionResult(null);
    setPaymentLink(null);
    setPaymentResult(null);

    // Reload recovery cases created by Stage 1
    await loadCases();

    console.log('Transaction risk analysis completed:', result);
  } catch (error) {
    console.error('Transaction risk analysis failed:', error);

    setError(
      error.response?.data?.message ||
      'Transaction risk analysis failed. Please try again.'
    );
  } finally {
    setRiskAnalysisLoading(false);
  }
}

  async function handleBatchAIAnalysis() {
    if (fromDate && toDate && fromDate > toDate) {
      setAiError('From date cannot be later than To date.');
      return;
    }

    try {
      setAiLoading(true);
      setAiError('');
      setExecutionResult(null);

      const response = await apiClient.post(
        '/recovery/ai-analysis',
        {
          batchMode: true,
          from: fromDate || undefined,
          to: toDate || undefined,
          status: status === 'ALL' ? 'ALL' : status,
          limit: 100,
          batchSize: 10,
          activeOnly: true,
        },
      );

      const result =
        response.data?.data || {};

      const recommendations =
        Array.isArray(result.recommendations)
          ? result.recommendations
          : [];

      setAiResults(recommendations);
      setBulkAIResults(recommendations);

      setAiRunSummary({
        totalCases: Number(result.totalCases || 0),
        eligibleCases: Number(
          result.eligibleCases ??
          result.totalCases ??
          0,
        ),
        skippedCases: Number(
          result.skippedCases || 0,
        ),
        totalBatches: Number(
          result.totalBatches || 0,
        ),
        batchSize: Number(
          result.batchSize || 20,
        ),
        recommendationCount: recommendations.length,
        geminiRequests: Number(
          result.geminiRequests || 0,
        ),
        failedBatches: Number(
          result.failedBatches || 0,
        ),
        fallbackRecommendations: Number(
          result.fallbackRecommendations || 0,
        ),
        from: fromDate || null,
        to: toDate || null,
      });

      if (recommendations.length === 0 && result.totalCases > 0) {
        setAiError(
          'AI analysis returned no recommendations for the selected recovery cases.',
        );
        return;
      }

      // Keep the merchant's currently selected case and all existing
      // detail/timeline UI intact. Only refresh its timeline when needed.
      if (selectedCase?._id) {
        await loadTimeline(selectedCase._id);
      }
    } catch (requestError) {
      console.error(
        'Batch AI analysis error:',
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

      if (statusCode === 400) {
        setAiError(
          requestError.response?.data?.message ||
            'Invalid batch AI analysis request.',
        );
        return;
      }

      setAiError(
        requestError.response?.data?.message ||
          'Failed to run batch AI analysis.',
      );
    } finally {
      setAiLoading(false);
    }
  }

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
   * BULK EXECUTION
   * --------------------------------------------------
   *
   * Execute exactly the final actions produced by the
   * most recent batch AI run. The backend performs the
   * authoritative current-state revalidation for every case.
   */

  function getBulkExecutionCandidates() {
  return bulkAIResults
    .filter((result) => {
      if (
        !result ||
        !result.recoveryCaseId ||
        !result.finalAction
      ) {
        return false;
      }

      return true;
    })
    .map((result) => ({
      ...result,
      recoveryCase: null,
    }));
}

  function openBulkExecutionConfirmation() {
    const candidates =
      getBulkExecutionCandidates();

    if (candidates.length === 0) {
      setExecutionResult({
        error:
          'No current AI recommendations are available for bulk execution.',
      });
      return;
    }

    const actionCounts = candidates.reduce(
      (counts, result) => {
        const action =
          result.finalAction ||
          'UNKNOWN';

        counts[action] =
          (counts[action] || 0) + 1;

        return counts;
      },
      {},
    );

    setBulkActionConfirmation({
      caseIds: candidates.map(
        (result) =>
          String(result.recoveryCaseId),
      ),
      count: candidates.length,
      actionCounts,
    });

    setExecutionResult(null);
  }

  function closeBulkExecutionConfirmation() {
    if (bulkExecutionLoading) {
      return;
    }

    setBulkActionConfirmation(null);
  }

  async function confirmBulkExecute() {
    if (
      !bulkActionConfirmation ||
      bulkActionConfirmation.caseIds.length === 0
    ) {
      return;
    }

    setBulkActionConfirmation(null);
    setBulkExecutionLoading(true);
    setExecutionResult(null);

    try {
      const response =
        await apiClient.post(
          '/recovery/execute-batch',
          {
            recoveryCaseIds:
              bulkActionConfirmation.caseIds,
          },
        );

      const data =
        response?.data?.data || {};

      if (
        response?.data?.success === false
      ) {
        throw new Error(
          response?.data?.message ||
            'Bulk recovery execution was rejected by the server.',
        );
      }

      const results =
        Array.isArray(data.results)
          ? data.results
          : [];

      const resultMap = new Map(
        results.map((item) => [
          String(item.recoveryCaseId),
          item,
        ]),
      );

      setCases((currentCases) =>
        currentCases.map((item) => {
          const result =
            resultMap.get(
              String(item._id),
            );

          if (!result || !result.executed) {
            return item;
          }

          return {
            ...item,
            status:
              result.status ||
              item.status,
            currentAction:
              result.action ||
              item.currentAction,
            actionTaken:
              item.actionTaken ||
              result.action ||
              item.currentAction,
          };
        }),
      );

      await loadCases(status);

      if (selectedCase) {
        const selectedResult =
          resultMap.get(
            String(selectedCase._id),
          );

        if (
          selectedResult?.executed
        ) {
          const updatedSelectedCase = {
            ...selectedCase,
            status:
              selectedResult.status ||
              selectedCase.status,
            currentAction:
              selectedResult.action ||
              selectedCase.currentAction,
            actionTaken:
              selectedCase.actionTaken ||
              selectedResult.action ||
              selectedCase.currentAction,
          };

          setSelectedCase(
            updatedSelectedCase,
          );

          await loadTimeline(
            updatedSelectedCase._id,
          );

          setPaymentLink(
            selectedResult.paymentLink
              ?.paymentLinkUrl
              ? selectedResult.paymentLink
              : null,
          );
        }
      }

      setExecutionResult({
        success: true,
        bulk: true,
        summary:
          data.summary || {
            requested:
              bulkActionConfirmation.count,
          },
        message:
          'Bulk execution completed. Each recommendation was processed independently; payment confirmation is still required where applicable.',
      });
    } catch (requestError) {
      console.error(
        'Bulk recovery execution error:',
        requestError,
      );

      setExecutionResult({
        error:
          requestError.response?.data
            ?.message ||
          requestError.message ||
          'Failed to execute recovery actions in bulk.',
      });
    } finally {
      setBulkExecutionLoading(false);
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

      const returnedPaymentLink =
        execution?.paymentLink || null;

      setPaymentLink(
        returnedPaymentLink?.paymentLinkUrl
          ? returnedPaymentLink
          : null,
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

          paymentLink:
            returnedPaymentLink,
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
   * CUSTOMER PAYMENT LINK
   * --------------------------------------------------
   */

  function openCustomerPaymentLink() {
    const url =
      paymentLink?.paymentLinkUrl;

    if (!url) {
      setExecutionResult({
        error:
          'No customer payment link is available for this recovery action.',
      });
      return;
    }

    window.open(
      url,
      '_blank',
      'noopener,noreferrer',
    );
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

  const bulkExecutionCandidates =
    getBulkExecutionCandidates();

  const canBulkExecute =
    bulkExecutionCandidates.length > 0 &&
    !aiLoading &&
    !bulkExecutionLoading &&
    !executionLoading;

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

        <div className="header-actions">
          <button
  className="secondary-button"
  onClick={handleTransactionRiskAnalysis}
  disabled={riskAnalysisLoading}
  title="Analyze all transactions and create recovery cases for risky transactions"
>
  {riskAnalysisLoading
    ? 'Analyzing Transactions...'
    : 'Analyze Transactions'}
</button>
          <button
            className="secondary-button"
            onClick={handleBatchAIAnalysis}
            disabled={
              aiLoading ||
              Boolean(
                fromDate &&
                toDate &&
                fromDate > toDate,
              )
            }
            title="Analyze all eligible recovery cases in the selected date range"
          >
            {aiLoading
              ? 'Analyzing Batch...'
              : 'Analyze All Eligible'}
          </button>

          <button
            className="secondary-button bulk-execute-button"
            onClick={openBulkExecutionConfirmation}
            disabled={!canBulkExecute}
            title="Execute the currently approved final action for every case in the latest batch result"
          >
            {bulkExecutionLoading
              ? 'Executing...'
              : `Execute All${bulkExecutionCandidates.length ? ` (${bulkExecutionCandidates.length})` : ''}`}
          </button>

          <button
            className="primary-button"
            onClick={handleAIAnalysis}
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

        <div className="toolbar-field">
          <label htmlFor="analysis-from">
            AI From
          </label>

          <input
            id="analysis-from"
            type="date"
            value={fromDate}
            onChange={(event) => {
              setFromDate(event.target.value);
              setAiResults([]);
              setBulkAIResults([]);
              setAiRunSummary(null);
              setAiError('');
            }}
          />
        </div>

        <div className="toolbar-field">
          <label htmlFor="analysis-to">
            AI To
          </label>

          <input
            id="analysis-to"
            type="date"
            value={toDate}
            onChange={(event) => {
              setToDate(event.target.value);
              setAiResults([]);
              setBulkAIResults([]);
              setAiRunSummary(null);
              setAiError('');
            }}
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
              {aiRunSummary.recommendationCount} recommendations from{' '}
              {aiRunSummary.totalCases} eligible cases
              {aiRunSummary.from || aiRunSummary.to
                ? ` • ${aiRunSummary.from || '…'} to ${aiRunSummary.to || '…'}`
                : ''}
            </span>
          </div>

          <span>
            {aiRunSummary.totalBatches} batches • {aiRunSummary.geminiRequests || 0} Gemini requests
            {aiRunSummary.fallbackRecommendations > 0
              ? ` • ${aiRunSummary.fallbackRecommendations} fallbacks`
              : ''}
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

        <aside
          ref={detailsCardRef}
          className="case-details-card"
        >

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
                          </strong></div>

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
                  SUCCESSFUL PAYMENT RESULT
              ================================================== */}

              {paymentResult?.success &&
                selectedCase?.status ===
                  'RECOVERED' && (
                <div
                  className="payment-success-card"
                  role="status"
                >
                  <div className="payment-success-heading">
                    <div>
                      <p className="eyebrow">
                        PAYMENT SUCCEEDED
                      </p>

                      <h3>
                        Recovery Payment Confirmed
                      </h3>
                    </div>

                    <span className="payment-success-badge">
                      Success
                    </span>
                  </div>

                  <p className="payment-success-description">
                    Razorpay confirmed the successful payment.
                    The payment was recorded as a captured
                    transaction and the eligible revenue has
                    been marked as recovered.
                  </p>

                  <div className="payment-success-summary">
                    <div>
                      <span>
                        Payment Provider
                      </span>

                      <strong>
                        {paymentResult.provider ||
                          'Razorpay'}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Payment Status
                      </span>

                      <strong>
                        {paymentResult.paymentStatus ||
                          'CAPTURED'}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Payment Amount
                      </span>

                      <strong>
                        {formatCurrency(
                          paymentResult.amountMinor,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Recovered Amount
                      </span>

                      <strong>
                        {formatCurrency(
                          paymentResult.recoveredAmountMinor,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Payment Source
                      </span>

                      <strong>
                        {paymentResult.source ||
                          'RAZORPAY'}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Currency
                      </span>

                      <strong>
                        {paymentResult.currency ||
                          selectedCase.currency ||
                          'INR'}
                      </strong>
                    </div>
                  </div>

                  <div className="payment-success-detail">
                    <span>
                      Razorpay Payment ID
                    </span>

                    <strong className="mono-value">
                      {paymentResult.razorpayPaymentId ||
                        'Not available in audit metadata'}
                    </strong>
                  </div>

                  <div className="payment-success-detail">
                    <span>
                      Recovery Transaction ID
                    </span>

                    <strong className="mono-value">
                      {paymentResult.paymentTransactionId ||
                        selectedCase.recoveryTransactionId ||
                        '—'}
                    </strong>
                  </div>

                  <div className="payment-success-detail">
                    <span>
                      Payment Confirmed At
                    </span>

                    <strong>
                      {formatDateTime(
                        paymentResult.recoveredAt,
                      )}
                    </strong>
                  </div>

                  <div className="payment-success-detail">
                    <span>
                      Case Status
                    </span>

                    <strong>
                      RECOVERED
                    </strong>
                  </div>
                </div>
              )}

              {/* ==================================================
                  CUSTOMER PAYMENT LINK
              ================================================== */}

              {selectedCaseAwaitingPayment &&
                paymentLink?.paymentLinkUrl && (
                <div className="payment-confirmation-card">
                  <div className="payment-confirmation-heading">
                    <div>
                      <p className="eyebrow">
                        CUSTOMER PAYMENT
                      </p>

                      <h3>
                        Recovery Payment Link
                      </h3>
                    </div>

                    <span className="payment-pending-badge">
                      Payment Pending
                    </span>
                  </div>

                  <p className="payment-confirmation-description">
                    The recovery action has been executed and a Razorpay
                    payment link has been created for the customer.
                    Revenue is not counted as recovered until Razorpay
                    confirms successful payment.
                  </p>

                  <div className="payment-confirmation-summary payment-confirmation-summary-grid">
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
                        Payment Amount
                      </span>

                      <strong>
                        {formatCurrency(
                          paymentLink.amountMinor,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Link Status
                      </span>

                      <strong>
                        {formatLabel(
                          paymentLink.status,
                        )}
                      </strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="primary-button full-width"
                    onClick={
                      openCustomerPaymentLink
                    }
                    disabled={
                      executionLoading
                    }
                  >
                    Open Customer Payment Link
                  </button>
                </div>
              )}

              {selectedCaseAwaitingPayment &&
                !paymentLink?.paymentLinkUrl && (
                <div className="payment-confirmation-card">
                  <div className="payment-confirmation-heading">
                    <div>
                      <p className="eyebrow">
                        PAYMENT PENDING
                      </p>

                      <h3>
                        Awaiting Successful Payment
                      </h3>
                    </div>

                    <span className="payment-pending-badge">
                      Payment Pending
                    </span>
                  </div>

                  <p className="payment-confirmation-description">
                    The recovery action has already been executed.
                    Wait for the customer or payment provider to
                    complete and confirm the payment.
                  </p>
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
                    The customer must complete payment through
                    the Razorpay recovery link. This case will be
                    marked recovered after a verified successful payment.
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

            

            </>
          )}

        </aside>

      </div>

              {bulkActionConfirmation && (
                <div
                  className="action-modal-backdrop"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (
                      event.target ===
                      event.currentTarget
                    ) {
                      closeBulkExecutionConfirmation();
                    }
                  }}
                >
                  <div
                    className="action-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="bulk-execution-title"
                    onMouseDown={(event) =>
                      event.stopPropagation()
                    }
                  >
                    <div className="action-modal-header">
                      <div>
                        <p className="eyebrow">
                          BULK RECOVERY EXECUTION
                        </p>

                        <h3 id="bulk-execution-title">
                          Execute {bulkActionConfirmation.count} Recommended Actions?
                        </h3>
                      </div>

                      <button
                        type="button"
                        className="action-modal-close"
                        onClick={closeBulkExecutionConfirmation}
                        disabled={bulkExecutionLoading}
                        aria-label="Close bulk execution confirmation"
                      >
                        ×
                      </button>
                    </div>

                    <div className="action-modal-body">
                      <p>
                        The system will execute the saved, policy-approved final action for each case. No new AI analysis will run.
                      </p>

                      <div className="action-modal-summary">
                        {Object.entries(
                          bulkActionConfirmation.actionCounts,
                        ).map(([action, count]) => (
                          <div key={action}>
                            <span>
                              {formatLabel(action)}
                            </span>
                            <strong>
                              {count}
                            </strong>
                          </div>
                        ))}
                      </div>

                      <div className="action-warning">
                        <strong>
                          Payment confirmation may still be required.
                        </strong>
                        <span>
                          Executing an action does not mean revenue is recovered. Payment-link actions can remain pending until the customer completes payment, and payment retries follow the existing recovery/payment flow.
                        </span>
                      </div>
                    </div>

                    <div className="action-modal-footer">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={closeBulkExecutionConfirmation}
                        disabled={bulkExecutionLoading}
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        className="primary-button"
                        onClick={confirmBulkExecute}
                        disabled={bulkExecutionLoading}
                      >
                        {bulkExecutionLoading
                          ? 'Executing...'
                          : 'Execute All Recommended Actions'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

    </div>
  );
}

export default RecoveryCases;