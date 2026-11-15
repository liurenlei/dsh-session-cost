/**
 * Session cost: a host-side `sessionCost` projection unit plus its price
 * refresh. The client half renders the dock pill from the wire view.
 *
 * The unit folds each settlement's provider-reported usage into per-route
 * buckets split by DeepSeek's peak/idle clock. Money is computed in
 * `wire.view`, so a price refresh changes every rendered cost without touching
 * stored state and without replaying the session log.
 */

import { createPricing, convertToDisplay } from './pricing.js'
import { applyEvent, buildView, initialState } from './fold.js'

// A profile-installed bundle cannot resolve shipped packages by bare import,
// so the native Schemastery schema is only declared when the runtime serves
// it (a source checkout or a future layout that exposes it). Without it the
// row's config still reaches `apply`, normalized by `settingsOf` below.
const Schema = await import('@deepseek-ai/schemastery')
  .then(module => module.default ?? module)
  .catch(() => null)

/** Cordis plugin name. */
export const name = 'session-cost'

/** The projection registry is the one hard dependency. */
export const inject = ['sessionProjections']

/*
 * The projection registry only calls `schema.parse(value)` (state checkpoints
 * and wire payloads), so the two schemas are small strict validators instead
 * of a full schema-library dependency.
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseBuckets(value, where) {
  if (!isRecord(value)) throw new Error(`sessionCost: ${where} is not an object`)
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
    if (!isCount(value[key])) throw new Error(`sessionCost: ${where}.${key} is not a non-negative integer`)
  }
  return value
}

function parseRoute(value, where) {
  if (value === null) return null
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') {
    throw new Error(`sessionCost: ${where} is not a provider/model route`)
  }
  return value
}

function parseRoutes(value) {
  if (!isRecord(value)) throw new Error('sessionCost: state.routes is not an object')
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
      throw new Error(`sessionCost: state.routes[${key}] is not a route entry`)
    }
    parseBuckets(entry.idle, `state.routes[${key}].idle`)
    parseBuckets(entry.peak, `state.routes[${key}].peak`)
  }
  return value
}

function parseUnpriced(value) {
  if (!isRecord(value)) throw new Error('sessionCost: state.unpriced is not an object')
  parseBuckets(value.idle, 'state.unpriced.idle')
  parseBuckets(value.peak, 'state.unpriced.peak')
  return value
}

function parseLast(value) {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('sessionCost: state.last is not an object')
  if (!isCount(value.turn) || !isCount(value.step)) throw new Error('sessionCost: state.last turn/step is invalid')
  if (value.key !== null && typeof value.key !== 'string') throw new Error('sessionCost: state.last.key is invalid')
  if (value.period !== 'idle' && value.period !== 'peak') throw new Error('sessionCost: state.last.period is invalid')
  parseBuckets(value.buckets, 'state.last.buckets')
  return value
}

const stateSchema = {
  parse(value) {
    if (!isRecord(value)) throw new Error('sessionCost: state is not an object')
    parseRoute(value.route, 'state.route')
    parseRoutes(value.routes)
    parseUnpriced(value.unpriced)
    parseLast(value.last)
    return value
  },
}

const viewSchema = {
  parse(value) {
    if (!isRecord(value)) throw new Error('sessionCost: view is not an object')
    if (value.currency !== 'CNY' && value.currency !== 'USD') throw new Error('sessionCost: view.currency is invalid')
    if (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0) {
      throw new Error('sessionCost: view.total is invalid')
    }
    for (const key of ['totalTokens', 'pricedTokens', 'unpricedTokens']) {
      if (!isCount(value[key])) throw new Error(`sessionCost: view.${key} is invalid`)
    }
    if (typeof value.pricesUpdatedAt !== 'number' || !Number.isFinite(value.pricesUpdatedAt)) {
      throw new Error('sessionCost: view.pricesUpdatedAt is invalid')
    }
    if (!Array.isArray(value.routes)) throw new Error('sessionCost: view.routes is not an array')
    for (const route of value.routes) {
      if (!isRecord(route) || typeof route.provider !== 'string' || typeof route.model !== 'string') {
        throw new Error('sessionCost: view route is invalid')
      }
      parseBuckets(route.tokens, 'view route tokens')
      if (typeof route.cost !== 'number' || !Number.isFinite(route.cost) || route.cost < 0) {
        throw new Error('sessionCost: view route cost is invalid')
      }
      if (typeof route.priced !== 'boolean' || typeof route.source !== 'string') {
        throw new Error('sessionCost: view route flags are invalid')
      }
    }
    return value
  },
}

/** Plugin configuration; every tunable lives here so a user patch survives upgrades. */
export const Config = Schema === null ? undefined : Schema.object({
  currency: Schema.union([Schema.const('CNY'), Schema.const('USD')]).default('CNY')
    .description('Display currency for the cost reading. DeepSeek official prices are CNY; models.dev prices are USD and converted.'),
  usdToCny: Schema.number().min(0.01).max(1000).default(7.1)
    .description('Conversion rate used when a route price and the display currency differ.'),
  autoUpdate: Schema.boolean().default(true)
    .description('Fetch DeepSeek official prices and the models.dev catalog in the background.'),
  refreshHours: Schema.number().min(1).max(720).default(12)
    .description('Hours between automatic price refreshes.'),
  holidays: Schema.array(Schema.string()).default([])
    .description('Beijing dates (YYYY-MM-DD) treated as DeepSeek idle periods even on weekdays.'),
  providerMap: Schema.dict(Schema.string()).default({})
    .description('Map a Harness provider id to a DeepSeek/models.dev provider id, such as {"my-api":"deepseek"}.'),
  overrides: Schema.dict(Schema.object({
    input: Schema.number().min(0),
    cacheRead: Schema.number().min(0).default(0),
    cacheWrite: Schema.number().min(0).default(0),
    output: Schema.number().min(0),
  })).default({})
    .description('Manual "provider/model" prices per 1M tokens in the display currency; they win over both sources.'),
})

/** Normalize the validated config to plain settings the fold and view can trust. */
function settingsOf(config) {
  return {
    currency: config?.currency === 'USD' ? 'USD' : 'CNY',
    usdToCny: Number.isFinite(config?.usdToCny) && config.usdToCny > 0 ? config.usdToCny : 7.1,
    autoUpdate: config?.autoUpdate !== false,
    refreshHours: Number.isFinite(config?.refreshHours) && config.refreshHours >= 1 ? config.refreshHours : 12,
    holidays: new Set(
      Array.isArray(config?.holidays)
        ? config.holidays.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        : [],
    ),
    providerMap: config?.providerMap ?? {},
    overrides: config?.overrides ?? {},
  }
}

/**
 * Mount the projection unit and start the price refresh.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} config - validated plugin configuration.
 */
export async function apply(ctx, config) {
  const settings = settingsOf(config)
  const pricing = createPricing(settings, ctx.logger)

  // The wire view is re-derived only when the folded state or a price refresh
  // changes, so unrelated events keep the same reference and publish nothing.
  let cachedState = null
  let cachedGeneration = -1
  let cachedView = null
  function viewOf(state) {
    const generation = pricing.generation
    if (state === cachedState && generation === cachedGeneration) return cachedView
    cachedView = buildView(state, pricing.resolve, settings, convertToDisplay, pricing.updatedAt)
    cachedState = state
    cachedGeneration = generation
    return cachedView
  }

  await ctx.sessionProjections.register({
    key: 'sessionCost',
    stateVersion: 1,
    stateSchema,
    init: () => initialState(),
    apply: (state, event) => applyEvent(state, event, settings),
    wire: {
      viewSchema,
      view: viewOf,
      summary: false,
    },
  })

  if (!settings.autoUpdate) return

  ctx.effect(() => {
    let stopped = false
    let timer = null
    const tick = async () => {
      if (stopped) return
      try {
        await pricing.refresh()
      } catch (error) {
        ctx.logger.warn(`session-cost: price refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!stopped) {
        timer = setTimeout(tick, settings.refreshHours * 3_600_000)
        if (typeof timer.unref === 'function') timer.unref()
      }
    }
    void tick()
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    }
  }, 'session-cost: price refresh')
}
