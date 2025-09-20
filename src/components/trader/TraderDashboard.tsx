'use client';

import { ChangeEvent, FormEvent, HTMLInputTypeAttribute, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Doc, Id } from '../../../convex/_generated/dataModel';

const defaultForm = {
  name: 'Crypto Momentum Agent',
  instrument: 'BTC_USD',
  granularity: 'M5',
  shortWindow: 9,
  longWindow: 21,
  tradeUnits: 1,
  takeProfitMultiplier: 0.01,
  stopLossMultiplier: 0.005,
  neutralThreshold: 0.0005,
};

type FormState = typeof defaultForm;
type SessionDoc = Doc<'traderSessions'>;
type PositionDoc = Doc<'traderPositions'>;
type LogDoc = Doc<'traderLogs'>;

const numericFields: (keyof FormState)[] = [
  'shortWindow',
  'longWindow',
  'tradeUnits',
  'takeProfitMultiplier',
  'stopLossMultiplier',
  'neutralThreshold',
];

const actionButtonClasses =
  'inline-flex items-center px-4 py-2 rounded-lg border border-clay-600 bg-clay-800/80 text-white hover:bg-clay-700 transition disabled:opacity-60 disabled:cursor-not-allowed';

export default function TraderDashboard() {
  const sessions = useQuery(api.trader.listSessions, {});
  const [selectedSessionId, setSelectedSessionId] = useState<Id<'traderSessions'> | null>(null);

  useEffect(() => {
    if (!selectedSessionId && sessions && sessions.length > 0) {
      setSelectedSessionId(sessions[0]._id);
    }
  }, [sessions, selectedSessionId]);

  const logs = useQuery(api.trader.listLogs, {
    sessionId: selectedSessionId ?? undefined,
    limit: 120,
  });
  const positions = useQuery(api.trader.listPositions, {
    sessionId: selectedSessionId ?? undefined,
  });

  const createSession = useMutation(api.trader.createSession);
  const updateSession = useMutation(api.trader.updateSession);
  const startSession = useMutation(api.trader.startSession);
  const stopSession = useMutation(api.trader.stopSession);
  const requestTick = useMutation(api.trader.requestImmediateTick);

  const [formState, setFormState] = useState<FormState>(defaultForm);
  const [isSubmitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const selectedSession = useMemo(
    () => sessions?.find((session) => session._id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const openPositions = useMemo(
    () => positions?.filter((position) => position.status !== 'closed') ?? [],
    [positions],
  );

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormState((previous) => ({
      ...previous,
      [name]: numericFields.includes(name as keyof FormState) ? Number(value) : value,
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setStatusMessage(null);
    try {
      const sessionId = await createSession(formState);
      setFormState(defaultForm);
      setSelectedSessionId(sessionId);
      setStatusMessage('Created a new trading session.');
    } catch (error) {
      setStatusMessage(formatError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const applySelectedConfig = () => {
    if (!selectedSession) return;
    setFormState({
      name: selectedSession.name,
      instrument: selectedSession.instrument,
      granularity: selectedSession.granularity,
      shortWindow: selectedSession.shortWindow,
      longWindow: selectedSession.longWindow,
      tradeUnits: selectedSession.tradeUnits,
      takeProfitMultiplier: selectedSession.takeProfitMultiplier,
      stopLossMultiplier: selectedSession.stopLossMultiplier,
      neutralThreshold: selectedSession.neutralThreshold,
    });
    setStatusMessage('Loaded configuration from the selected session. Use "Save changes" to persist.');
  };

  const handleSaveChanges = async () => {
    if (!selectedSessionId) return;
    setSubmitting(true);
    setStatusMessage(null);
    try {
      await updateSession({ sessionId: selectedSessionId, config: formState });
      setStatusMessage('Session configuration updated.');
    } catch (error) {
      setStatusMessage(formatError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const performStart = async () => {
    if (!selectedSessionId) return;
    setStatusMessage(null);
    try {
      await startSession({ sessionId: selectedSessionId });
      setStatusMessage('Session started. The agent will evaluate once per minute.');
    } catch (error) {
      setStatusMessage(formatError(error));
    }
  };

  const performStop = async (closeOpen = true) => {
    if (!selectedSessionId) return;
    setStatusMessage(null);
    try {
      await stopSession({ sessionId: selectedSessionId, closePositions: closeOpen });
      setStatusMessage(closeOpen ? 'Session stopped and flattening positions.' : 'Session stopped.');
    } catch (error) {
      setStatusMessage(formatError(error));
    }
  };

  const performTick = async () => {
    if (!selectedSessionId) return;
    setStatusMessage(null);
    try {
      await requestTick({ sessionId: selectedSessionId });
      setStatusMessage('Manual evaluation requested.');
    } catch (error) {
      setStatusMessage(formatError(error));
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      <header className="bg-clay-800/70 text-white rounded-xl p-6 shadow-solid border border-clay-600">
        <h1 className="text-4xl font-display tracking-wide mb-2">Autonomous OANDA Crypto Trader</h1>
        <p className="text-lg text-clay-200 max-w-3xl">
          Deploy a fully autonomous agent that monitors OANDA cryptocurrency markets, reacts to momentum
          shifts, and manages positions automatically. Configure the risk model below, then start the
          trader to let it run around the clock.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr,3fr]">
        <section className="space-y-6">
          <div className="bg-clay-900/80 border border-clay-700 rounded-xl shadow-solid">
            <header className="flex items-center justify-between px-6 py-4 border-b border-clay-700">
              <h2 className="text-2xl text-white font-display">Trading Sessions</h2>
              <button
                className="text-sm text-clay-200 underline decoration-dotted hover:text-white"
                onClick={() => setSelectedSessionId(null)}
              >
                Deselect
              </button>
            </header>
            <div className="divide-y divide-clay-800">
              {sessions && sessions.length > 0 ? (
                sessions.map((session) => (
                  <SessionListRow
                    key={session._id}
                    session={session}
                    selected={selectedSessionId === session._id}
                    onSelect={() => setSelectedSessionId(session._id)}
                  />
                ))
              ) : (
                <p className="p-6 text-clay-300">No sessions yet. Create one using the form below.</p>
              )}
            </div>
            {selectedSession && (
              <div className="px-6 py-4 border-t border-clay-800 space-y-4 text-sm text-clay-100">
                <SelectedSessionSummary session={selectedSession} openPositions={openPositions} />
                <div className="flex flex-wrap gap-3">
                  <button className={actionButtonClasses} onClick={performStart}>
                    Start session
                  </button>
                  <button className={actionButtonClasses} onClick={() => performStop(true)}>
                    Stop &amp; close positions
                  </button>
                  <button className={actionButtonClasses} onClick={() => performStop(false)}>
                    Stop (leave positions)
                  </button>
                  <button className={actionButtonClasses} onClick={performTick}>
                    Evaluate now
                  </button>
                  <button className={actionButtonClasses} onClick={applySelectedConfig}>
                    Load config into form
                  </button>
                  <button
                    className={actionButtonClasses}
                    onClick={handleSaveChanges}
                    disabled={isSubmitting || !selectedSessionId}
                  >
                    Save changes
                  </button>
                </div>
              </div>
            )}
          </div>

          <form
            className="bg-clay-900/80 border border-clay-700 rounded-xl shadow-solid p-6 space-y-4"
            onSubmit={handleSubmit}
          >
            <h2 className="text-2xl text-white font-display">Configure a trading agent</h2>
            <p className="text-sm text-clay-200">
              Define the parameters for a new momentum-based trader. The agent uses dual moving averages to
              detect directional bias and will open long or short positions accordingly.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <LabeledInput
                label="Session name"
                name="name"
                value={formState.name}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Instrument"
                name="instrument"
                value={formState.instrument}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Candle granularity"
                name="granularity"
                value={formState.granularity}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Short moving average"
                name="shortWindow"
                type="number"
                min={1}
                value={formState.shortWindow}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Long moving average"
                name="longWindow"
                type="number"
                min={2}
                value={formState.longWindow}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Units per trade"
                name="tradeUnits"
                type="number"
                min={0.01}
                step={0.01}
                value={formState.tradeUnits}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Take profit multiplier"
                name="takeProfitMultiplier"
                type="number"
                min={0.0001}
                step={0.0001}
                value={formState.takeProfitMultiplier}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Stop loss multiplier"
                name="stopLossMultiplier"
                type="number"
                min={0.0001}
                step={0.0001}
                value={formState.stopLossMultiplier}
                onChange={handleInputChange}
              />
              <LabeledInput
                label="Neutral threshold"
                name="neutralThreshold"
                type="number"
                min={0}
                step={0.0001}
                value={formState.neutralThreshold}
                onChange={handleInputChange}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <button className={actionButtonClasses} type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Create new session'}
              </button>
              <button
                className={actionButtonClasses}
                type="button"
                onClick={() => setFormState(defaultForm)}
                disabled={isSubmitting}
              >
                Reset to defaults
              </button>
            </div>
          </form>
        </section>

        <section className="bg-clay-900/80 border border-clay-700 rounded-xl shadow-solid flex flex-col">
          <header className="px-6 py-4 border-b border-clay-700">
            <h2 className="text-2xl text-white font-display">Agent activity log</h2>
            <p className="text-sm text-clay-300">
              Detailed trace of the trader&apos;s decisions, broker communication and analytics insights.
            </p>
          </header>
          <div className="flex-1 overflow-y-auto max-h-[520px]">
            {logs && logs.length > 0 ? (
              <ul className="divide-y divide-clay-800">
                {logs.map((log) => (
                  <LogRow key={log._id} log={log} />
                ))}
              </ul>
            ) : (
              <p className="p-6 text-clay-300">Select a session to inspect its log output.</p>
            )}
          </div>
        </section>
      </div>

      {statusMessage && (
        <div className="bg-clay-800/90 border border-clay-600 text-clay-100 rounded-xl px-6 py-4 shadow-solid">
          {statusMessage}
        </div>
      )}
    </div>
  );
}

type SessionListRowProps = {
  session: SessionDoc;
  selected: boolean;
  onSelect: () => void;
};

function SessionListRow({ session, selected, onSelect }: SessionListRowProps) {
  return (
    <button
      className={`w-full text-left px-6 py-4 transition-colors ${
        selected ? 'bg-clay-800 text-white' : 'text-clay-200 hover:bg-clay-800/60'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-lg font-semibold">{session.name}</p>
          <p className="text-sm text-clay-300">
            {session.instrument} • {session.granularity} • Status: {session.status}
          </p>
        </div>
        <div className="text-right text-sm text-clay-400">
          <p>Last signal: {session.lastSignal}</p>
          <p>
            Last price: {session.lastPrice ? session.lastPrice.toFixed(5) : '—'}
          </p>
        </div>
      </div>
    </button>
  );
}

type SelectedSessionSummaryProps = {
  session: SessionDoc;
  openPositions: PositionDoc[];
};

function SelectedSessionSummary({ session, openPositions }: SelectedSessionSummaryProps) {
  return (
    <div className="grid sm:grid-cols-2 gap-4 text-sm">
      <div>
        <h3 className="uppercase tracking-wide text-clay-400 text-xs mb-1">Performance</h3>
        <p>Last evaluation: {session.lastEvaluationTime ? formatTime(session.lastEvaluationTime) : '—'}</p>
        <p>
          Last moving averages: {formatMaybeNumber(session.lastShortMA)} / {formatMaybeNumber(session.lastLongMA)}
        </p>
        <p>Neutral threshold: {(session.neutralThreshold * 100).toFixed(2)}%</p>
      </div>
      <div>
        <h3 className="uppercase tracking-wide text-clay-400 text-xs mb-1">Open exposure</h3>
        {openPositions.length > 0 ? (
          <ul className="space-y-1">
            {openPositions.map((position) => (
              <li key={position._id}>
                {position.direction.toUpperCase()} {position.units} @ {position.entryPrice.toFixed(5)}{' '}
                {position.oandaTradeId ? `(#${position.oandaTradeId})` : '(paper)'}
              </li>
            ))}
          </ul>
        ) : (
          <p>No open positions.</p>
        )}
      </div>
    </div>
  );
}

type LabeledInputProps = {
  label: string;
  name: keyof FormState;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  type?: HTMLInputTypeAttribute;
  min?: number;
  step?: number;
};

function LabeledInput({ label, name, value, onChange, type = 'text', min, step }: LabeledInputProps) {
  return (
    <label className="flex flex-col text-sm text-clay-200 gap-1">
      <span className="font-semibold text-clay-100">{label}</span>
      <input
        className="bg-clay-950/60 border border-clay-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-clay-400"
        name={name}
        value={value}
        onChange={onChange}
        type={type}
        min={min}
        step={step}
        required
      />
    </label>
  );
}

type LogRowProps = {
  log: LogDoc;
};

function LogRow({ log }: LogRowProps) {
  const details = log.details ? formatDetails(log.details) : null;
  return (
    <li className="px-6 py-4 text-sm text-clay-100">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold capitalize text-clay-200">{log.level}</p>
          <p className="text-clay-100">{log.message}</p>
          {details && <pre className="mt-2 bg-clay-950/60 rounded-lg p-3 text-xs overflow-x-auto">{details}</pre>}
        </div>
        <time className="text-xs text-clay-400">{formatTime(log.createdAt)}</time>
      </div>
    </li>
  );
}

function formatMaybeNumber(value: number | undefined | null) {
  if (value === undefined || value === null) return '—';
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(5);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

function formatDetails(details: unknown) {
  try {
    return typeof details === 'string' ? details : JSON.stringify(details, null, 2);
  } catch (error) {
    return String(details);
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
