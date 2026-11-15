/**
 * Pure fold and view for the `sessionCost` projection unit.
 *
 * The fold keeps per-route token buckets split by the DeepSeek peak/idle clock,
 * so a later price refresh changes the view without replaying the session log.
 * It mirrors token-meter's replacement rule: a second settlement for the same
 * Turn and Step replaces the first one, and `llm/retry-started` closes that
 * replacement slot.
 */

/** Token buckets of one route, in provider order. */
export const BUCKET_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']

/** A zeroed bucket set. */
export function emptyBuckets() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** The projection unit's initial state. */
export function initialState() {
  return {
    route: null,
    routes: {},
    unpriced: { idle: emptyBuckets(), peak: emptyBuckets() },
    last: null,
  }
}

/** A safe non-negative integer, else null. */
function intOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** The last `usage` chunk embedded in a compacted model stream. */
function lastUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object' || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage !== undefined) {
      return chunk.usage
    }
  }
  return undefined
}

/** Provider-reported usage of one settlement event. */
function usageOf(event) {
  if (event.type === 'assistant/message') {
    if (event.data.usage !== undefined) return event.data.usage
    return lastUsage(event.data.stream)
  }
  if (event.type === 'assistant/attempt') return lastUsage(event.data.stream)
  return undefined
}

/** Normalize a `TokenUsage` into the four buckets, or null when malformed. */
function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const input = intOrNull(usage.inputTokens)
  const output = intOrNull(usage.outputTokens)
  if (input === null || output === null) return null
  const cacheRead = intOrNull(usage.cacheReadTokens ?? 0)
  const cacheWrite = intOrNull(usage.cacheWriteTokens ?? 0)
  if (cacheRead === null || cacheWrite === null) return null
  return { input, cacheRead, cacheWrite, output }
}

/** The model route that produced one assistant message. */
function routeOfMessage(message) {
  if (message === null || typeof message !== 'object') return null
  const source = message.source
  if (source === null || typeof source !== 'object') return null
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return null
  if (source.provider.length === 0 || source.model.length === 0) return null
  return { provider: source.provider, model: source.model }
}

/** Stable map key for one provider/model route. */
export function routeKey(provider, model) {
  return `${provider}\u0000${model}`
}

/** Whether two routes name the same provider and model. */
function sameRoute(left, right) {
  return left !== null && right !== null && left.provider === right.provider && left.model === right.model
}

/** Whether two bucket sets are identical. */
function sameBuckets(left, right) {
  return BUCKET_KEYS.every(key => left[key] === right[key])
}

/** Whether a bucket set carries no tokens. */
function isZero(buckets) {
  return BUCKET_KEYS.every(key => buckets[key] === 0)
}

/** Sum two bucket sets. */
function addBuckets(left, right) {
  return {
    input: left.input + right.input,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
  }
}

/** Subtract without going below zero. */
function subtractBuckets(left, right) {
  return {
    input: Math.max(0, left.input - right.input),
    cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
    cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
    output: Math.max(0, left.output - right.output),
  }
}

/** Total tokens across a bucket set. */
function bucketTotal(buckets) {
  return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output
}

/**
 * Whether one instant falls in DeepSeek's peak window: Beijing time, Monday to
 * Friday, 09:00-12:00 or 14:00-18:00, excluding configured holidays. China has
 * no daylight saving, so a fixed +08:00 offset is exact.
 * @param {number} time - event timestamp in milliseconds.
 * @param {Set<string>} holidays - Beijing dates (`YYYY-MM-DD`) treated as idle.
 * @returns {boolean} true when the peak rate applies.
 */
export function isPeakTime(time, holidays) {
  const shifted = new Date(time + 8 * 3_600_000)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const dateKey = `${shifted.getUTCFullYear()}-${month}-${day}`
  if (holidays.has(dateKey)) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/**
 * Fold one committed session event.
 * @param {object} state - current unit state.
 * @param {object} event - committed `SessionEvent`.
 * @param {{holidays: Set<string>}} options - resolved clock options.
 * @returns {object} the next state, or the same reference when nothing changed.
 */
export function applyEvent(state, event, options) {
  const holidays = options.holidays

  if (event.type === 'model/selection' || event.type === 'request/context') {
    const provider = event.data?.provider
    const model = event.data?.model
    if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) {
      return state
    }
    const route = { provider, model }
    return sameRoute(state.route, route) ? state : { ...state, route }
  }

  if (event.type === 'llm/retry-started') {
    const last = state.last
    if (last === null) return state
    if (last.turn === event.data.turn && last.step === event.data.step) {
      return { ...state, last: null }
    }
    return state
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

  const usage = usageOf(event)
  if (usage === undefined) return state
  const buckets = bucketsOf(usage)
  if (buckets === null || isZero(buckets)) return state

  const turn = intOrNull(event.data.turn)
  const step = intOrNull(event.data.step)
  if (turn === null || step === null) return state

  const messageRoute = event.type === 'assistant/message' ? routeOfMessage(event.data.message) : null
  const route = messageRoute ?? state.route
  const nextRoute = messageRoute ?? state.route
  const key = route === null ? null : routeKey(route.provider, route.model)
  const period = isPeakTime(event.time, holidays) ? 'peak' : 'idle'

  const previous = state.last
  if (
    previous !== null
    && previous.turn === turn
    && previous.step === step
    && previous.key === key
    && previous.period === period
    && sameBuckets(previous.buckets, buckets)
  ) {
    return sameRoute(state.route, nextRoute) ? state : { ...state, route: nextRoute }
  }

  const routes = { ...state.routes }
  const unpriced = {
    idle: { ...state.unpriced.idle },
    peak: { ...state.unpriced.peak },
  }

  // Undo the contribution this settlement replaces, if any.
  if (previous !== null && previous.turn === turn && previous.step === step) {
    if (previous.key === null) {
      unpriced[previous.period] = subtractBuckets(unpriced[previous.period], previous.buckets)
    } else {
      const entry = routes[previous.key]
      if (entry !== undefined) {
        const idle = previous.period === 'idle'
          ? subtractBuckets(entry.idle, previous.buckets)
          : entry.idle
        const peak = previous.period === 'peak'
          ? subtractBuckets(entry.peak, previous.buckets)
          : entry.peak
        if (isZero(idle) && isZero(peak)) {
          delete routes[previous.key]
        } else {
          routes[previous.key] = { ...entry, idle, peak }
        }
      }
    }
  }

  // Add this settlement.
  if (key === null) {
    unpriced[period] = addBuckets(unpriced[period], buckets)
  } else {
    const entry = routes[key] ?? {
      provider: route.provider,
      model: route.model,
      idle: emptyBuckets(),
      peak: emptyBuckets(),
    }
    routes[key] = {
      ...entry,
      [period]: addBuckets(entry[period], buckets),
    }
  }

  return {
    route: nextRoute,
    routes,
    unpriced,
    last: { turn, step, key, period, buckets },
  }
}

/** Money for one bucket set under one rate card, in the card's currency. */
function costOf(buckets, rates) {
  return (
    buckets.input * rates.input
    + buckets.cacheRead * rates.cacheRead
    + buckets.cacheWrite * rates.cacheWrite
    + buckets.output * rates.output
  ) / 1_000_000
}

/**
 * Build the client-visible view: money totals in the display currency plus one
 * row per priced or unpriced route.
 * @param {object} state - current unit state.
 * @param {(provider: string, model: string) => object | null} resolve - price resolver.
 * @param {object} config - display settings (`currency`, `usdToCny`).
 * @param {(amount: number, from: string, config: object) => number} convert - currency converter.
 * @param {number} pricesUpdatedAt - last successful price refresh.
 * @returns {object} the wire view.
 */
export function buildView(state, resolve, config, convert, pricesUpdatedAt) {
  const routes = []
  let total = 0
  let totalTokens = 0
  let pricedTokens = 0

  for (const entry of Object.values(state.routes)) {
    const tokens = addBuckets(entry.idle, entry.peak)
    const count = bucketTotal(tokens)
    totalTokens += count
    const price = resolve(entry.provider, entry.model)
    if (price === null) {
      routes.push({
        provider: entry.provider,
        model: entry.model,
        tokens,
        cost: 0,
        priced: false,
        source: 'none',
      })
      continue
    }
    const sourceCost = costOf(entry.idle, price.idle) + costOf(entry.peak, price.peak)
    const cost = convert(sourceCost, price.currency, config)
    pricedTokens += count
    total += Number.isFinite(cost) && cost > 0 ? cost : 0
    routes.push({
      provider: entry.provider,
      model: entry.model,
      tokens,
      cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      priced: true,
      source: price.source,
    })
  }

  const unpricedBuckets = addBuckets(state.unpriced.idle, state.unpriced.peak)
  const unpricedTokens = bucketTotal(unpricedBuckets)
  totalTokens += unpricedTokens

  routes.sort((left, right) => (right.cost - left.cost) || left.model.localeCompare(right.model))

  return {
    currency: config.currency,
    total,
    totalTokens,
    pricedTokens,
    unpricedTokens,
    routes,
    pricesUpdatedAt,
  }
}
