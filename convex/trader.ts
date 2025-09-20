import { Infer, v } from 'convex/values';
import { Doc, Id } from './_generated/dataModel';
import {
  ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { internal } from './_generated/api';
import {
  TraderLog,
  TraderLogs,
  TraderPosition,
  TraderPositions,
  TraderSession,
  TraderSessions,
} from './schema';
import {
  closeTrade,
  fetchCandles,
  getOpenTrades,
  isOandaConfigured,
  placeMarketOrder,
  OandaOrderResponse,
} from './lib/oanda';

const sessionConfigFields = {
  name: v.string(),
  instrument: v.string(),
  granularity: v.string(),
  shortWindow: v.number(),
  longWindow: v.number(),
  tradeUnits: v.number(),
  takeProfitMultiplier: v.number(),
  stopLossMultiplier: v.number(),
  neutralThreshold: v.number(),
};
const sessionConfigValidator = v.object(sessionConfigFields);

const logLevelValidator = TraderLogs.fields.level;
const directionValidator = TraderPositions.fields.direction;
const statusValidator = TraderSessions.fields.status;
const signalValidator = TraderSessions.fields.lastSignal;

type LogLevel = TraderLog['level'];
type TradingDirection = TraderPosition['direction'];
type TradingSignal = TraderSession['lastSignal'];
type SessionConfig = Infer<typeof sessionConfigValidator>;

function requireSession(session: TraderSession | null, sessionId: Id<'traderSessions'>) {
  if (!session) {
    throw new Error(`Trader session ${sessionId} not found`);
  }
  return session;
}

export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('traderSessions').order('desc').collect();
  },
});

export const sessionById = query({
  args: { sessionId: v.id('traderSessions') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const listLogs = query({
  args: {
    sessionId: v.optional(v.id('traderSessions')),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const sessionId = args.sessionId;
    if (!sessionId) return [];
    const limit = Math.min(500, Math.max(1, args.limit ?? 100));
    return await ctx.db
      .query('traderLogs')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .order('desc')
      .take(limit);
  },
});

export const listPositions = query({
  args: { sessionId: v.optional(v.id('traderSessions')) },
  handler: async (ctx, args) => {
    const sessionId = args.sessionId;
    if (!sessionId) return [];
    return await ctx.db
      .query('traderPositions')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .order('desc')
      .collect();
  },
});

export const createSession = mutation({
  args: sessionConfigFields,
  handler: async (ctx, args: SessionConfig) => {
    validateConfig(args);
    const now = Date.now();
    const sessionId = await ctx.db.insert('traderSessions', {
      ...args,
      status: 'stopped',
      lastSignal: 'neutral',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('traderLogs', {
      sessionId,
      level: 'info',
      message: `Created trading session for ${args.instrument} (${args.granularity})`,
      createdAt: now,
    });
    return sessionId;
  },
});

export const updateSession = mutation({
  args: {
    sessionId: v.id('traderSessions'),
    config: sessionConfigValidator,
  },
  handler: async (ctx, { sessionId, config }) => {
    validateConfig(config);
    const now = Date.now();
    await ctx.db.patch(sessionId, { ...config, updatedAt: now });
    await ctx.db.insert('traderLogs', {
      sessionId,
      level: 'info',
      message: `Updated configuration for ${config.instrument}`,
      createdAt: now,
    });
  },
});

export const startSession = mutation({
  args: { sessionId: v.id('traderSessions') },
  handler: async (ctx, { sessionId }) => {
    const session = requireSession(await ctx.db.get(sessionId), sessionId);
    if (session.status === 'running') return;
    const now = Date.now();
    await ctx.db.patch(sessionId, {
      status: 'running',
      updatedAt: now,
      errorMessage: undefined,
    });
    await ctx.db.insert('traderLogs', {
      sessionId,
      level: 'info',
      message: 'Trading session started',
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.trader.evaluateSession, {
      sessionId,
      reason: 'manual-start',
    });
  },
});

export const stopSession = mutation({
  args: {
    sessionId: v.id('traderSessions'),
    closePositions: v.optional(v.boolean()),
  },
  handler: async (ctx, { sessionId, closePositions }) => {
    const session = requireSession(await ctx.db.get(sessionId), sessionId);
    const now = Date.now();
    await ctx.db.patch(sessionId, {
      status: 'stopped',
      updatedAt: now,
      errorMessage: undefined,
    });
    await ctx.db.insert('traderLogs', {
      sessionId,
      level: 'info',
      message: 'Trading session stopped',
      createdAt: now,
    });
    if (closePositions ?? true) {
      await ctx.scheduler.runAfter(0, internal.trader.closeSessionPositions, {
        sessionId: session._id,
        reason: 'manual-stop',
      });
    }
  },
});

export const requestImmediateTick = mutation({
  args: { sessionId: v.id('traderSessions') },
  handler: async (ctx, { sessionId }) => {
    requireSession(await ctx.db.get(sessionId), sessionId);
    const now = Date.now();
    await ctx.db.insert('traderLogs', {
      sessionId,
      level: 'info',
      message: 'Manual tick requested',
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.trader.evaluateSession, {
      sessionId,
      reason: 'manual-tick',
    });
  },
});

export const getSessionState = internalQuery({
  args: { sessionId: v.id('traderSessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    const openPositions = await ctx.db
      .query('traderPositions')
      .withIndex('by_session_status', (q) =>
        q.eq('sessionId', sessionId).eq('status', 'open'),
      )
      .collect();
    return { session, openPositions };
  },
});

export const getActiveSessionIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query('traderSessions')
      .withIndex('by_status', (q) => q.eq('status', 'running'))
      .collect();
    return sessions.map((session) => session._id);
  },
});

export const logEvent = internalMutation({
  args: {
    sessionId: v.id('traderSessions'),
    level: logLevelValidator,
    message: v.string(),
    details: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('traderLogs', {
      sessionId: args.sessionId,
      level: args.level,
      message: args.message,
      details: args.details,
      createdAt: Date.now(),
    });
  },
});

export const updateAnalytics = internalMutation({
  args: {
    sessionId: v.id('traderSessions'),
    lastShortMA: v.optional(v.number()),
    lastLongMA: v.optional(v.number()),
    lastPrice: v.optional(v.number()),
    lastSignal: v.optional(signalValidator),
    lastEvaluationTime: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<TraderSession> = {
      updatedAt: Date.now(),
    };
    if (args.lastShortMA !== undefined) patch.lastShortMA = args.lastShortMA;
    if (args.lastLongMA !== undefined) patch.lastLongMA = args.lastLongMA;
    if (args.lastPrice !== undefined) patch.lastPrice = args.lastPrice;
    if (args.lastSignal !== undefined) patch.lastSignal = args.lastSignal;
    if (args.lastEvaluationTime !== undefined)
      patch.lastEvaluationTime = args.lastEvaluationTime;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    await ctx.db.patch(args.sessionId, patch);
  },
});

export const setStatus = internalMutation({
  args: {
    sessionId: v.id('traderSessions'),
    status: statusValidator,
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<TraderSession> = {
      status: args.status,
      updatedAt: Date.now(),
    };
    if (args.errorMessage !== undefined) {
      patch.errorMessage = args.errorMessage;
    }
    await ctx.db.patch(args.sessionId, patch);
  },
});

export const createPositionRecord = internalMutation({
  args: {
    sessionId: v.id('traderSessions'),
    direction: directionValidator,
    units: v.number(),
    entryPrice: v.number(),
    takeProfitPrice: v.optional(v.number()),
    stopLossPrice: v.optional(v.number()),
    oandaTradeId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('traderPositions', {
      sessionId: args.sessionId,
      direction: args.direction,
      units: args.units,
      entryPrice: args.entryPrice,
      takeProfitPrice: args.takeProfitPrice,
      stopLossPrice: args.stopLossPrice,
      status: 'open',
      oandaTradeId: args.oandaTradeId,
      openedAt: Date.now(),
    });
    await ctx.db.patch(args.sessionId, { updatedAt: Date.now() });
  },
});

export const closePositionRecord = internalMutation({
  args: {
    positionId: v.id('traderPositions'),
    exitPrice: v.optional(v.number()),
    realizedPnl: v.optional(v.number()),
    closeReason: v.string(),
  },
  handler: async (ctx, args) => {
    const position = await ctx.db.get(args.positionId);
    if (!position) return;
    const patch: Partial<TraderPosition> = {
      status: 'closed',
      closedAt: Date.now(),
      closeReason: args.closeReason,
    };
    if (args.exitPrice !== undefined) patch.exitPrice = args.exitPrice;
    if (args.realizedPnl !== undefined) patch.realizedPnl = args.realizedPnl;
    await ctx.db.patch(args.positionId, patch);
    await ctx.db.patch(position.sessionId, { updatedAt: Date.now() });
  },
});

export const closeSessionPositions = internalAction({
  args: {
    sessionId: v.id('traderSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(internal.trader.getSessionState, {
      sessionId: args.sessionId,
    });
    if (!state) return;
    const { session, openPositions } = state;
    for (const position of openPositions) {
      await closePositionWithBroker(ctx, session, position, session.lastPrice ?? position.entryPrice, args.reason ?? 'manual');
    }
  },
});

export const tickActiveSessions = internalAction({
  args: {},
  handler: async (ctx) => {
    const sessionIds = await ctx.runQuery(internal.trader.getActiveSessionIds, {});
    for (const sessionId of sessionIds) {
      await ctx.runAction(internal.trader.evaluateSession, { sessionId });
    }
  },
});

export const evaluateSession = internalAction({
  args: {
    sessionId: v.id('traderSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(internal.trader.getSessionState, {
      sessionId: args.sessionId,
    });
    if (!state) return;
    const { session } = state;
    if (session.status !== 'running') {
      return;
    }

    const log = (level: LogLevel, message: string, details?: Record<string, any>) =>
      ctx.runMutation(internal.trader.logEvent, {
        sessionId: session._id,
        level,
        message,
        details,
      });

    try {
      const maxLookback = Math.max(session.longWindow * 2, session.longWindow + 5);
      const candles = await fetchCandles({
        instrument: session.instrument,
        granularity: session.granularity,
        count: maxLookback,
      });
      const completedCandles = candles.filter((candle) => candle.complete);
      const closes = completedCandles.map((candle) => parseFloat(candle.mid.c));
      if (closes.length < session.longWindow) {
        await log(
          'warn',
          `Not enough historical candles to evaluate strategy (have ${closes.length}, need ${session.longWindow})`,
        );
        return;
      }
      const shortMA = movingAverage(closes, session.shortWindow);
      const longMA = movingAverage(closes, session.longWindow);
      const latestPrice = closes[closes.length - 1];
      const previousSignal: TradingSignal = session.lastSignal ?? 'neutral';
      const signal = computeSignal(shortMA, longMA, session.neutralThreshold);

      await ctx.runMutation(internal.trader.updateAnalytics, {
        sessionId: session._id,
        lastShortMA: shortMA,
        lastLongMA: longMA,
        lastPrice: latestPrice,
        lastSignal: signal,
        lastEvaluationTime: Date.now(),
        errorMessage: undefined,
      });

      await log('analysis', 'Tick processed', {
        shortMA,
        longMA,
        latestPrice,
        signal,
        previousSignal,
        reason: args.reason ?? 'scheduled',
      });

      let openPositions = state.openPositions;
      if (openPositions.length && isOandaConfigured()) {
        try {
          const liveTrades = await getOpenTrades();
          const liveIds = new Set(
            liveTrades.map((trade) => trade.id ?? trade.tradeID ?? ''),
          );
          for (const position of openPositions) {
            if (position.oandaTradeId && !liveIds.has(position.oandaTradeId)) {
              await ctx.runMutation(internal.trader.closePositionRecord, {
                positionId: position._id,
                exitPrice: latestPrice,
                closeReason: 'broker-closed',
              });
              await log('trade', 'Detected broker-closed position', {
                positionId: position._id,
                tradeId: position.oandaTradeId,
              });
            }
          }
          openPositions = await ctx.runQuery(internal.trader.getSessionState, {
            sessionId: session._id,
          }).then((s) => s?.openPositions ?? []);
        } catch (error) {
          await log('warn', `Failed to sync open trades: ${formatError(error)}`);
        }
      }

      const activePosition = openPositions[0];
      if (activePosition) {
        if (signal === 'neutral' || signal !== activePosition.direction) {
          await log('info', 'Signal requires closing current position', {
            signal,
            activeDirection: activePosition.direction,
          });
          await closePositionWithBroker(
            ctx,
            session,
            activePosition,
            latestPrice,
            signal === 'neutral' ? 'neutral-signal' : 'signal-flip',
          );
          openPositions = await ctx.runQuery(internal.trader.getSessionState, {
            sessionId: session._id,
          }).then((s) => s?.openPositions ?? []);
        }
      }

      if (!openPositions.length && signal !== 'neutral' && signal !== previousSignal) {
        await log('info', 'Attempting to open new position', { signal });
        await openPositionWithBroker(ctx, session, signal, latestPrice);
      }
    } catch (error) {
      const message = formatError(error);
      await ctx.runMutation(internal.trader.logEvent, {
        sessionId: session._id,
        level: 'error',
        message: `Evaluation failed: ${message}`,
      });
      await ctx.runMutation(internal.trader.setStatus, {
        sessionId: session._id,
        status: 'error',
        errorMessage: message,
      });
    }
  },
});

function validateConfig(config: SessionConfig) {
  if (config.longWindow <= config.shortWindow) {
    throw new Error('Long window must be greater than short window.');
  }
  if (config.tradeUnits <= 0) {
    throw new Error('Trade units must be greater than zero.');
  }
  if (config.takeProfitMultiplier <= 0 || config.stopLossMultiplier <= 0) {
    throw new Error('Take profit and stop loss multipliers must be positive numbers.');
  }
  if (config.neutralThreshold < 0) {
    throw new Error('Neutral threshold must be zero or positive.');
  }
}

function movingAverage(series: number[], length: number) {
  if (series.length < length) {
    return series[series.length - 1];
  }
  const window = series.slice(series.length - length);
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / window.length;
}

function computeSignal(
  shortMA: number,
  longMA: number,
  neutralThreshold: number,
): TradingSignal {
  const diff = shortMA - longMA;
  if (Math.abs(longMA) < Number.EPSILON) {
    return diff > 0 ? 'long' : diff < 0 ? 'short' : 'neutral';
  }
  const ratio = Math.abs(diff) / Math.abs(longMA);
  if (ratio < neutralThreshold) {
    return 'neutral';
  }
  return diff > 0 ? 'long' : 'short';
}

function extractTradeId(response: OandaOrderResponse): string | undefined {
  const fill = response.orderFillTransaction ?? response.orderFillTransactions?.[0];
  if (!fill) return undefined;
  if (fill.tradeOpened?.tradeID) return fill.tradeOpened.tradeID;
  if (fill.tradesOpened && fill.tradesOpened.length > 0) {
    return fill.tradesOpened[0].tradeID;
  }
  if (fill.tradeReduced?.tradeID) return fill.tradeReduced.tradeID;
  if (fill.tradesClosed && fill.tradesClosed.length > 0) {
    return fill.tradesClosed[0].tradeID;
  }
  return undefined;
}

async function openPositionWithBroker(
  ctx: ActionCtx,
  session: TraderSession,
  signal: Exclude<TradingSignal, 'neutral'>,
  marketPrice: number,
) {
  const direction: TradingDirection = signal;
  const units = Math.abs(session.tradeUnits) * (direction === 'long' ? 1 : -1);
  const takeProfitPrice =
    direction === 'long'
      ? marketPrice * (1 + session.takeProfitMultiplier)
      : marketPrice * (1 - session.takeProfitMultiplier);
  const stopLossPrice =
    direction === 'long'
      ? marketPrice * (1 - session.stopLossMultiplier)
      : marketPrice * (1 + session.stopLossMultiplier);

  let tradeId: string | undefined;
  let entryPrice = marketPrice;
  if (isOandaConfigured()) {
    const response = await placeMarketOrder({
      instrument: session.instrument,
      units,
      takeProfitPrice,
      stopLossPrice,
    });
    tradeId = extractTradeId(response);
    const fill = response.orderFillTransaction ?? response.orderFillTransactions?.[0];
    if (fill?.price) {
      entryPrice = parseFloat(fill.price);
    } else if (fill?.fullPrice?.price) {
      entryPrice = parseFloat(fill.fullPrice.price);
    }
  }

  await ctx.runMutation(internal.trader.createPositionRecord, {
    sessionId: session._id,
    direction,
    units,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    oandaTradeId: tradeId,
  });
  await ctx.runMutation(internal.trader.logEvent, {
    sessionId: session._id,
    level: 'trade',
    message: `Opened ${direction.toUpperCase()} position (${units} units)`,
    details: {
      tradeId,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
    },
  });
}

async function closePositionWithBroker(
  ctx: ActionCtx,
  session: TraderSession,
  position: Doc<'traderPositions'>,
  marketPrice: number,
  reason: string,
) {
  let exitPrice = marketPrice;
  let realizedPnl: number | undefined;
  if (position.oandaTradeId && isOandaConfigured()) {
    const response = await closeTrade(position.oandaTradeId);
    const fill = response.orderFillTransaction ?? response.orderFillTransactions?.[0];
    if (fill?.price) {
      exitPrice = parseFloat(fill.price);
    } else if (fill?.fullPrice?.price) {
      exitPrice = parseFloat(fill.fullPrice.price);
    }
    if (fill?.pl) {
      realizedPnl = parseFloat(fill.pl);
    }
  }
  await ctx.runMutation(internal.trader.closePositionRecord, {
    positionId: position._id,
    exitPrice,
    realizedPnl,
    closeReason: reason,
  });
  await ctx.runMutation(internal.trader.logEvent, {
    sessionId: session._id,
    level: 'trade',
    message: `Closed position ${position._id} (${reason})`,
    details: {
      tradeId: position.oandaTradeId,
      exitPrice,
      realizedPnl,
    },
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
