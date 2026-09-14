/**
 * 界面半边：DSH 原生右侧栏的监控 tab。
 * 经典脚本格式（window.__ModuleLoader__.load），只用基线模块 react，无 JSX。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fetch-router',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const NS = 'dsh-fetch-router'
    const KIND = 'dsh-fetch-router:monitor'
    const BASE = '/fetch-router'

    const T = {
      ink: 'var(--dsw-alias-label-primary, #1f1f1f)',
      inkSecondary: 'var(--dsw-alias-label-secondary, #757575)',
      border: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10))',
      danger: 'var(--dsw-alias-state-danger-primary, #c62828)',
      success: 'var(--dsw-alias-state-success-primary, #2e7d32)',
      warn: 'var(--dsw-alias-state-warn-primary, #b26a00)',
    }

    const cell = { padding: '4px 6px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'top', whiteSpace: 'nowrap' }
    const monospace = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' }

    const outcomeColor = (outcome) => outcome === 'error' ? T.danger
      : outcome === 'mock' ? T.warn
        : outcome === 'skipped' ? T.inkSecondary : T.success

    const headerRow = () => h('tr', null,
      ['时间', '目标', '方法', '规则', '头', '结果', '模型', '状态', '耗时'].map((label, index) =>
        h('th', {
          key: label,
          style: { ...cell, position: 'sticky', top: 0, background: 'var(--dsw-alias-bg-base, #fff)', textAlign: 'left', fontSize: '11px', color: T.inkSecondary },
        }, label)))

    const row = (entry, index) => h('tr', { key: `${entry.time}-${index}` },
      h('td', { style: { ...cell, ...monospace } }, new Date(entry.time).toLocaleTimeString()),
      h('td', { style: { ...cell, ...monospace }, title: entry.detail || '' }, entry.target),
      h('td', { style: { ...cell, ...monospace } }, entry.method),
      h('td', { style: { ...cell, ...monospace } }, entry.rule),
      h('td', { style: { ...cell, ...monospace } }, (entry.headers || []).join(' ') || '—'),
      h('td', { style: { ...cell, ...monospace, color: outcomeColor(entry.outcome) } }, entry.outcome),
      h('td', { style: { ...cell, ...monospace } }, [entry.provider, entry.model].filter(Boolean).join(' / ') || '—'),
      h('td', { style: { ...cell, ...monospace } }, entry.status === undefined ? '—' : String(entry.status)),
      h('td', { style: { ...cell, ...monospace } }, entry.ms === undefined ? '—' : `${entry.ms}ms`))

    const badge = (label, value, color) => h('span', {
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
        border: `1px solid ${T.border}`, color: color || T.ink,
      },
    }, `${label} ${value}`)

    const Monitor = (props) => {
      const t = props && props.t ? props.t : (key) => key
      const [state, setState] = react.useState({ status: 'loading', snapshot: undefined, error: undefined, paused: false })

      react.useEffect(() => {
        let live = true
        const apply = (snapshot) => {
          if (!live || snapshot === undefined) return
          setState((previous) => ({ ...previous, status: 'ready', snapshot, paused: snapshot.paused === true }))
        }
        fetch(`${BASE}/stats.json`)
          .then((response) => response.ok ? response.json() : Promise.reject(new Error(`stats ${response.status}`)))
          .then(apply)
          .catch((error) => { if (live) setState((previous) => ({ ...previous, status: 'unavailable', error: String(error && error.message || error) })) })
        let source
        try {
          source = new EventSource(`${BASE}/events`)
          source.onmessage = (event) => {
            try { apply(JSON.parse(event.data)) } catch { /* 忽略坏帧 */ }
          }
          source.onerror = () => { /* EventSource 自行重连 */ }
        } catch { /* 无 SSE 时退回首屏快照 */ }
        return () => { live = false; if (source) source.close() }
      }, [])

      const togglePaused = () => {
        const next = !state.paused
        setState((previous) => ({ ...previous, paused: next }))
        fetch(`${BASE}/recording`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: next }),
        }).catch(() => { /* 面板状态由下一次快照纠正 */ })
      }

      if (state.status === 'unavailable') {
        return h('div', { 'data-fetch-router': 'unavailable', style: { padding: '12px', fontSize: '12px', color: T.inkSecondary } },
          `${t('unavailable')}: ${state.error || ''}`)
      }
      const snapshot = state.snapshot
      const counters = snapshot ? snapshot.counters : {}
      const rows = snapshot ? snapshot.rows : []

      return h('div', { 'data-fetch-router': 'monitor', style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', color: T.ink, fontSize: '12px' } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
          badge(t('matched'), counters.matched || 0, T.success),
          badge(t('passthrough'), counters.passthrough || 0),
          badge(t('mock'), counters.mock || 0, T.warn),
          badge(t('error'), counters.error || 0, counters.error ? T.danger : undefined),
          h('button', {
            type: 'button',
            onClick: togglePaused,
            style: {
              marginLeft: 'auto', height: '24px', padding: '0 10px', cursor: 'pointer',
              border: `1px solid ${T.border}`, borderRadius: '8px', background: 'transparent',
              color: state.paused ? T.warn : T.inkSecondary, fontSize: '11px', fontFamily: 'inherit',
            },
          }, state.paused ? t('resume') : t('pause'))),
        h('div', { style: { ...monospace, color: T.inkSecondary } },
          `${t('rules')}: ${(snapshot ? snapshot.routes : []).map((route) => route.pattern).join('  ') || t('none')}`),
        rows.length === 0
          ? h('div', { style: { color: T.inkSecondary } }, t('empty'))
          : h('div', { style: { overflow: 'auto', maxHeight: '60vh' } },
            h('table', { style: { borderCollapse: 'collapse', width: '100%', ...monospace } },
              h('thead', null, headerRow()),
              h('tbody', null, rows.map(row)))),
        state.status === 'loading' ? h('div', { style: { color: T.inkSecondary } }, t('loading')) : null)
    }

    const Title = (props) => h('span', null, props && props.t ? props.t('title') : 'Fetch Router')

    return {
      name: 'dsh-fetch-router-client',
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const RouteIcon = ({ size }) => h('svg', {
          viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
          stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
          style: { flex: 'none' }, 'aria-hidden': 'true',
        },
        h('circle', { key: 'a', cx: '6', cy: '19', r: '3' }),
        h('path', { key: 'b', d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' }),
        h('circle', { key: 'c', cx: '18', cy: '5', r: '3' }))

        const Opener = (props) => {
          const wide = props === undefined || props.wide !== false
          const [hover, setHover] = react.useState(false)
          const open = () => {
            try {
              ctx.sidebarRight.openTab(KIND)
              if (ctx.sidebarRight.isExpanded() !== true) ctx.layout.openRightbar(false, false)
            } catch (error) {
              console.error('dsh-fetch-router: opening the monitor tab failed', error)
            }
          }
          // 对齐「自检 / 重启」那一列的行基线：同样的 42px 行高、同样的上下 margin，
          // 顶部对齐；但**不声明宽度**（flex:'none'），避免和重启控件组抢同一行。
          const wrapper = {
            display: 'flex',
            flexDirection: 'column',
            flex: 'none',
            alignSelf: 'flex-start',
            minWidth: 0,
          }
          const button = wide
            ? {
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                height: '42px', margin: '4px -2px', padding: '0 10px 0 8px',
                border: 'none', borderRadius: '12px', overflow: 'hidden',
                background: hover ? T.hover : 'transparent',
                color: T.ink, fontFamily: 'inherit', fontSize: '14px', cursor: 'pointer',
              }
            : {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0,
                width: '36px', height: '36px', margin: '8px 0 10px', padding: 0,
                border: 'none', borderRadius: '50%', overflow: 'hidden',
                background: hover ? T.hover : 'transparent',
                color: T.ink, fontFamily: 'inherit', fontSize: '14px', cursor: 'pointer',
              }
          return h('div', { style: wrapper },
            h('button', {
              type: 'button',
              'data-fetch-router-opener': '',
              title: t('open'),
              'aria-label': t('title'),
              onClick: open,
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              style: button,
            },
            h(RouteIcon, { size: wide ? 16 : 18 }),
            wide ? h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('title')) : null))
        }

        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            title: 'Fetch Router', open: '打开 Fetch Router 监控',
            matched: '命中', passthrough: '透传', mock: '本地应答', error: '错误',
            pause: '暂停记录', resume: '恢复记录', rules: '生效路由', none: '（未配置规则）',
            empty: '暂无命中记录', loading: '加载中…', unavailable: '数据面不可用（插件未启用？）',
          },
          en: {
            title: 'Fetch Router', open: 'Open the Fetch Router monitor',
            matched: 'matched', passthrough: 'passthrough', mock: 'mock', error: 'errors',
            pause: 'Pause recording', resume: 'Resume recording', rules: 'active routes', none: '(no rules configured)',
            empty: 'No matched requests yet', loading: 'Loading…', unavailable: 'Data plane unavailable (plugin off?)',
          },
        }))
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'dsh-fetch-router',
          kind: KIND,
          title: () => t('title'),
        }))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: 'dsh-fetch-router', locale: NS },
          Monitor,
        )))
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: 'dsh-fetch-router' },
          Title,
        )))
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'fetch-router', order: 60, label: () => t('title') },
          Opener,
        )))
      },
    }
  },
})
