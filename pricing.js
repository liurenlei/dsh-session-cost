/**
 * Price sources for the session-cost plugin.
 *
 * Two machine-readable sources are used:
 * - DeepSeek's official Chinese pricing page, fetched as Markdown. It is the
 *   only source with peak/idle (高峰/空闲) rates and it is denominated in CNY.
 * - models.dev's public catalog, a JSON map of providers and models with a
 *   `cost` block in USD per one million tokens. It covers every other provider.
 *
 * A built-in DeepSeek table keeps the plugin useful before the first fetch and
 * when the machine is offline. Manual overrides always win.
 *
 * Prices are stored per one million tokens.
 */

/** DeepSeek's official pricing page as served to the Markdown viewer. */
export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md'

/** models.dev's whole public catalog. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

const ZERO_BUCKETS = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/** Built-in copy of the official DeepSeek rates (CNY per 1M tokens). */
export const DEFAULT_DEEPSEEK = {
  source: 'built-in',
  fetchedAt: 0,
  aliases: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
  models: {
    'deepseek-flash': {
      idle: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    },
    'deepseek-v4-pro': {
      idle: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
      peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
    },
  },
}

/**
 * Split one Markdown table row into trimmed cells.
 * @param {string} line - one `|`-prefixed table line.
 * @returns {string[]} cell text without the outer pipes.
 */
function splitRow(line) {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner
  return body.split('|').map(cell => cell.trim())
}

/** Strip Markdown emphasis, links, and footnote markers from a cell. */
function cleanCell(cell) {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\(\d+\)/g, '')
    .trim()
}

/** Map a DeepSeek price row label to its token bucket. */
function bucketOf(label) {
  if (label.includes('未命中')) return 'input'
  if (label.includes('缓存命中')) return 'cacheRead'
  if (label.includes('输出')) return 'output'
  return null
}

/** Read the first decimal number out of a price cell such as `0.02元`. */
function numberFrom(cell) {
  const match = /-?\d+(?:\.\d+)?/.exec(cleanCell(cell))
  return match === null ? null : Number.parseFloat(match[0])
}

/**
 * Parse DeepSeek's pricing Markdown into the internal model table.
 * Returns null when the page no longer has the expected shape.
 * @param {string} markdown - the fetched Markdown document.
 * @returns {{source: string, fetchedAt: number, aliases: Record<string, string>, models: Record<string, {idle: object, peak: object}>} | null}
 */
export function parseDeepSeekMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return null
  const lines = markdown.split('\n')

  // The model header is the first table row that names a DeepSeek model column.
  const headerIndex = lines.findIndex(line => line.trim().startsWith('|') && line.includes('deepseek-'))
  if (headerIndex < 0) return null
  const header = splitRow(lines[headerIndex])
  const modelStart = header.findIndex(cell => /deepseek-/i.test(cell))
  if (modelStart < 0) return null
  const modelNames = header.slice(modelStart).map(cleanCell).filter(name => /deepseek-/i.test(name))
  if (modelNames.length === 0) return null

  const models = {}
  for (const name of modelNames) {
    models[name] = { idle: ZERO_BUCKETS(), peak: ZERO_BUCKETS() }
  }
  let sawPrice = false
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim().startsWith('|')) continue
    if (!line.includes('价格')) continue
    const cells = splitRow(line)
    if (cells.length < modelStart + 1) continue
    const label = cells[1] ?? ''
    const periodCell = cells[2] ?? ''
    const bucket = bucketOf(label)
    if (bucket === null) continue
    const period = periodCell.includes('高峰') ? 'peak' : periodCell.includes('空闲') ? 'idle' : null
    if (period === null) continue
    const values = cells.slice(-modelNames.length)
    for (let index = 0; index < modelNames.length; index += 1) {
      const value = numberFrom(values[index] ?? '')
      if (value === null) continue
      models[modelNames[index]][period][bucket] = value
      sawPrice = true
    }
  }
  if (!sawPrice) return null

  const aliases = { ...DEFAULT_DEEPSEEK.aliases }
  const footnote = lines.find(line => line.includes('旧模型名'))
  if (footnote !== undefined) {
    const recommended = /请使用\s*`([^`]+)`/.exec(footnote)
    const recommendedName = recommended === null ? undefined : cleanCell(recommended[1])
    const others = [...footnote.matchAll(/`([^`]+)`/g)].map(match => cleanCell(match[1]))
    if (recommendedName !== undefined) {
      for (const other of others) {
        if (other !== recommendedName && other.length > 0) aliases[other] = recommendedName
      }
    }
  }

  return { source: 'deepseek-official', fetchedAt: Date.now(), aliases, models }
}

/** A finite non-negative number, else the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Index models.dev's catalog down to the fields this plugin prices with.
 * @param {unknown} catalog - parsed JSON from models.dev's `api.json`.
 * @returns {Map<string, Map<string, {input: number, output: number, cacheRead: number, cacheWrite?: number}>> | null}
 */
export function indexModelsDev(catalog) {
  if (catalog === null || typeof catalog !== 'object') return null
  const providers = new Map()
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (provider === null || typeof provider !== 'object' || provider.models === null || typeof provider.models !== 'object') {
      continue
    }
    const models = new Map()
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model === null || typeof model !== 'object') continue
      const cost = model.cost
      if (cost === null || typeof cost !== 'object') continue
      const input = numberOr(cost.input, null)
      const output = numberOr(cost.output, null)
      if (input === null || output === null) continue
      models.set(modelId, {
        input,
        output,
        cacheRead: numberOr(cost.cache_read, 0),
        // Absent cache_write pricing is approximated by the input rate when resolved.
        cacheWrite: numberOr(cost.cache_write, undefined),
      })
    }
    if (models.size > 0) providers.set(providerId, models)
  }
  return providers.size > 0 ? providers : null
}

/** Fetch a URL as text with a bounded wait. */
async function fetchText(url, timeoutMs = 20_000) {
  const response = await fetch(url, {
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
    headers: { accept: '*/*' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.text()
}

/** Case-insensitive Map lookup, used for provider and model ids. */
function lookupCaseInsensitive(map, key) {
  const direct = map.get(key)
  if (direct !== undefined) return direct
  const lowered = key.toLowerCase()
  for (const [candidate, value] of map) {
    if (candidate.toLowerCase() === lowered) return value
    if (candidate.toLowerCase().endsWith(`/${lowered}`)) return value
  }
  return undefined
}

/** Convert an amount between the priced currency and the display currency. */
export function convertToDisplay(amount, from, config) {
  if (from === config.currency) return amount
  if (from === 'USD' && config.currency === 'CNY') return amount * config.usdToCny
  if (from === 'CNY' && config.currency === 'USD') return amount / config.usdToCny
  return amount
}

/**
 * Create the live pricing table: built-in defaults, background refresh, and
 * route resolution against overrides, DeepSeek, then models.dev.
 * @param {object} config - resolved plugin configuration.
 * @param {{warn: Function}} logger - host logger for refresh failures.
 */
export function createPricing(config, logger) {
  let deepseek = DEFAULT_DEEPSEEK
  let modelsDev = null
  let updatedAt = 0
  let generation = 0

  /** Resolve one provider/model route to prices in their source currency. */
  function resolve(provider, model) {
    const override = config.overrides[`${provider}/${model}`]
    if (override !== undefined) {
      const flat = {
        input: numberOr(override.input, 0),
        cacheRead: numberOr(override.cacheRead, 0),
        cacheWrite: numberOr(override.cacheWrite, 0),
        output: numberOr(override.output, 0),
      }
      return { currency: config.currency, idle: flat, peak: flat, source: 'override' }
    }

    const mappedProvider = String(config.providerMap[provider] ?? provider).toLowerCase()
    // DeepSeek's own auth adapters are named `deepseek-account` and
    // `deepseek-api-key`; both bill at the official rates.
    const isDeepSeek = mappedProvider === 'deepseek' || mappedProvider.startsWith('deepseek-')
    let priceProvider = mappedProvider
    if (isDeepSeek) {
      const name = (deepseek.aliases[model] ?? model).toLowerCase()
      const entry = deepseek.models[name]
      if (entry !== undefined) {
        return { currency: 'CNY', idle: entry.idle, peak: entry.peak, source: deepseek.source }
      }
      // A model the official page does not list yet still belongs to the
      // DeepSeek catalog on models.dev.
      priceProvider = 'deepseek'
    }

    if (modelsDev !== null) {
      let group = modelsDev.get(priceProvider)
      if (group === undefined) {
        for (const [candidate, models] of modelsDev) {
          if (candidate.toLowerCase() === priceProvider) { group = models; break }
        }
      }
      if (group === undefined && priceProvider !== mappedProvider) {
        for (const [candidate, models] of modelsDev) {
          if (candidate.toLowerCase() === mappedProvider) { group = models; break }
        }
      }
      if (group !== undefined) {
        const candidates = [model, model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model]
        let entry
        for (const candidate of candidates) {
          entry = lookupCaseInsensitive(group, candidate)
          if (entry !== undefined) break
        }
        if (entry !== undefined) {
          const flat = {
            input: entry.input,
            output: entry.output,
            cacheRead: entry.cacheRead,
            cacheWrite: entry.cacheWrite ?? entry.input,
          }
          return { currency: 'USD', idle: flat, peak: flat, source: 'models.dev' }
        }
      }
    }

    return null
  }

  /** Refresh both sources; each success is applied independently. */
  async function refresh() {
    const results = await Promise.allSettled([
      fetchText(DEEPSEEK_PRICING_URL),
      fetchText(MODELS_DEV_URL),
    ])
    let changed = false

    if (results[0].status === 'fulfilled') {
      const parsed = parseDeepSeekMarkdown(results[0].value)
      if (parsed === null) {
        logger.warn('session-cost: DeepSeek pricing page no longer matches the expected table')
      } else {
        deepseek = parsed
        updatedAt = Date.now()
        changed = true
      }
    } else {
      logger.warn(`session-cost: DeepSeek pricing fetch failed: ${String(results[0].reason?.message ?? results[0].reason)}`)
    }

    if (results[1].status === 'fulfilled') {
      try {
        const indexed = indexModelsDev(JSON.parse(results[1].value))
        if (indexed === null) {
          logger.warn('session-cost: models.dev catalog carried no priced models')
        } else {
          modelsDev = indexed
          updatedAt = Date.now()
          changed = true
        }
      } catch (error) {
        logger.warn(`session-cost: models.dev catalog could not be parsed: ${String(error?.message ?? error)}`)
      }
    } else {
      logger.warn(`session-cost: models.dev fetch failed: ${String(results[1].reason?.message ?? results[1].reason)}`)
    }

    if (changed) generation += 1
    return { changed, updatedAt }
  }

  return {
    resolve,
    refresh,
    get updatedAt() { return updatedAt },
    get generation() { return generation },
  }
}
