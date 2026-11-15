/**
 * Session cost, browser half: one extra `conversation.composer.dock` entry
 * (id `cost`, after the shipped `activity` and `usage` pills) that reads the
 * host's `sessionCost` projection. Clicking the reading opens a per-route
 * breakdown. Money is computed on the host; this file only formats it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-cost',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'session-cost'

    const EN = {
      'cost.title': 'Session cost',
      'cost.pill': '≈{amount}',
      'cost.input': 'Input (cache miss)',
      'cost.cacheRead': 'Input (cache hit)',
      'cost.cacheWrite': 'Cache write',
      'cost.output': 'Output',
      'cost.unpriced': 'Unpriced models: {tokens} tokens',
      'cost.updated': 'Prices updated {time}',
      'cost.builtin': 'Built-in prices',
      'cost.note': 'Estimated from published prices; DeepSeek peak/idle follows each message time.',
      'cost.noPrice': '—',
      'cost.unavailable': 'Price unavailable',
      'cost.aria': 'Session cost: {amount}',
    }

    const ZH = {
      'cost.title': '会话花费',
      'cost.pill': '≈{amount}',
      'cost.input': '输入（缓存未命中）',
      'cost.cacheRead': '输入（缓存命中）',
      'cost.cacheWrite': '缓存写入',
      'cost.output': '输出',
      'cost.unpriced': '未计价模型：{tokens} tokens',
      'cost.updated': '价格更新于 {time}',
      'cost.builtin': '内置价格',
      'cost.note': '按公开价格估算；DeepSeek 高峰/空闲按每条消息的时间区分。',
      'cost.noPrice': '—',
      'cost.unavailable': '暂无价格',
      'cost.aria': '会话花费：{amount}',
    }

    // The pill copies the shipped statistics control's size, radius, and
    // hover treatment; the dialog copies the shipped statistics dialog skin.
    const CSS = `
.dsc-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.dsc-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.dsc-pill svg{width:14px;height:14px;flex:none}
.dsc-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.dsc-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dsc-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsc-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:auto;outline:none}
.dsc-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dsc-title-label{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsc-title-label svg{width:14px;height:14px;flex:none}
.dsc-title-value{font-variant-numeric:tabular-nums}
.dsc-rule{margin-bottom:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsc-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.dsc-details dt,.dsc-details dd{min-width:0;margin:0}
.dsc-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.dsc-route{overflow-wrap:anywhere}
.dsc-token-details{margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsc-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary)}
`

    /** A currency-neutral price tag, so the glyph never contradicts the amount. */
    function CostIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'M8.4 2.4h5.2v5.2l-5.7 5.7-5.2-5.2z' }),
      h('circle', { cx: 11.1, cy: 4.9, r: 0.95 }))
    }

    /** The client locale service captured at activation, for money and time. */
    let localeService = null

    function activeLocale() {
      try {
        const snapshot = localeService?.getSnapshot?.()
        if (snapshot !== null && typeof snapshot?.active === 'string' && snapshot.active.length > 0) {
          return snapshot.active
        }
      } catch {
        /* fall through to the browser locale */
      }
      return navigator.language || 'en'
    }

    /** Compact token count: 999, 1.2K, 3.4M. */
    function formatTokens(value) {
      const count = Number.isFinite(value) ? value : 0
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
      if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
      return String(Math.round(count))
    }

    function fractionDigits(value) {
      if (value > 0 && value < 0.01) return 4
      if (value < 1) return 3
      return 2
    }

    /** Currency text in the UI locale, with enough precision for small sessions. */
    function formatMoney(value, currency) {
      const digits = fractionDigits(value)
      try {
        return new Intl.NumberFormat(activeLocale(), {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(value)
      } catch {
        return `${currency} ${value.toFixed(digits)}`
      }
    }

    function formatTime(time) {
      try {
        return new Date(time).toLocaleTimeString(activeLocale(), { hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(time).toISOString().slice(11, 16)
      }
    }

    /** A hook-shaped no-op used only when the slot omits the standard seat. */
    function useNoProjection() {
      return undefined
    }

    function CostPill(props) {
      const translate = typeof props.t === 'function' ? props.t : null
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : useNoProjection
      const projection = useProjection('sessionCost')

      const [open, setOpen] = React.useState(false)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [position, setPosition] = React.useState(null)
      const focusedRef = React.useRef(false)
      const panelId = React.useId ? React.useId() : 'dsc-cost-panel'

      const t = (key, params) => (translate === null ? key : translate(key, params))

      const updatePosition = React.useCallback(() => {
        const trigger = triggerRef.current
        if (trigger === null) return
        const rect = trigger.getBoundingClientRect()
        const width = Math.min(360, window.innerWidth - 24)
        setPosition({
          left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
          width,
          bottom: Math.max(12, window.innerHeight - rect.top + 8),
          // The panel grows upward from 8px above the trigger; cap it at the
          // viewport edge so a tall breakdown scrolls inside the panel.
          maxHeight: Math.max(0, rect.top - 20),
        })
      }, [])

      React.useLayoutEffect(() => {
        if (open) updatePosition()
      }, [open, updatePosition])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        // Capture phase: activating a sibling pill by keyboard emits only
        // `click`, so a pointerdown-only guard would stack both dialogs.
        const onClick = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
          if (triggerRef.current !== null) triggerRef.current.focus()
        }
        document.addEventListener('pointerdown', onPointer)
        document.addEventListener('click', onClick, true)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', updatePosition)
        document.addEventListener('scroll', updatePosition, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer)
          document.removeEventListener('click', onClick, true)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', updatePosition)
          document.removeEventListener('scroll', updatePosition, true)
        }
      }, [open, updatePosition])

      React.useEffect(() => {
        if (!open) {
          focusedRef.current = false
          return
        }
        if (position === null || panelRef.current === null || focusedRef.current) return
        focusedRef.current = true
        panelRef.current.focus()
      }, [open, position])

      if (projection === undefined || projection === null || !(projection.totalTokens > 0)) return null

      const hasPrice = projection.pricedTokens > 0
      const totalText = hasPrice ? formatMoney(projection.total, projection.currency) : t('cost.noPrice')
      const reading = hasPrice ? t('cost.pill', { amount: totalText }) : t('cost.unavailable')

      const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const route of projection.routes) {
        tokens.input += route.tokens.input
        tokens.cacheRead += route.tokens.cacheRead
        tokens.cacheWrite += route.tokens.cacheWrite
        tokens.output += route.tokens.output
      }

      const rows = []
      for (const route of projection.routes) {
        rows.push(h('dt', { key: `route-${route.provider}-${route.model}`, className: 'dsc-route' },
          `${route.provider} / ${route.model}`))
        rows.push(h('dd', { key: `cost-${route.provider}-${route.model}` },
          route.priced ? `≈${formatMoney(route.cost, projection.currency)}` : t('cost.noPrice')))
      }

      const tokenRows = [
        ['cost.input', tokens.input],
        ['cost.cacheRead', tokens.cacheRead],
        ...(tokens.cacheWrite > 0 ? [['cost.cacheWrite', tokens.cacheWrite]] : []),
        ['cost.output', tokens.output],
      ]

      const footer = projection.pricesUpdatedAt > 0
        ? t('cost.updated', { time: formatTime(projection.pricesUpdatedAt) })
        : t('cost.builtin')

      const panel = open && position !== null && ReactDOM.createPortal(
        h('div', {
          ref: panelRef,
          id: panelId,
          className: 'dsc-panel',
          role: 'dialog',
          tabIndex: -1,
          'aria-label': t('cost.title'),
          style: {
            left: position.left,
            width: position.width,
            bottom: position.bottom,
            maxHeight: position.maxHeight,
          },
        },
        h('div', { className: 'dsc-title' },
          h('span', { className: 'dsc-title-label' }, h(CostIcon), t('cost.title')),
          h('span', { className: 'dsc-title-value' }, hasPrice ? `≈${totalText}` : totalText)),
        h('div', { className: 'dsc-rule' }),
        rows.length > 0 && h('dl', { className: 'dsc-details' }, rows),
        h('dl', { className: 'dsc-details dsc-token-details' },
          tokenRows.flatMap(([key, value]) => [
            h('dt', { key: `dt-${key}` }, t(key)),
            h('dd', { key: `dd-${key}` }, formatTokens(value)),
          ])),
        projection.unpricedTokens > 0 && h('p', { className: 'dsc-note' },
          t('cost.unpriced', { tokens: formatTokens(projection.unpricedTokens) })),
        h('p', { className: 'dsc-note' }, `${footer} · ${t('cost.note')}`)),
        document.body)

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('span', { className: 'dsc-anchor', 'data-composer-stat': 'cost' },
          h('button', {
            ref: triggerRef,
            type: 'button',
            className: 'dsc-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-controls': open ? panelId : undefined,
            'aria-label': t('cost.aria', { amount: reading }),
            onClick: () => setOpen(!open),
          },
          h(CostIcon),
          h('span', { className: 'dsc-label' }, reading))),
        panel)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'session-cost: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost',
          order: 2,
          locale: NS,
        }, CostPill))
      },
    }
  },
})
