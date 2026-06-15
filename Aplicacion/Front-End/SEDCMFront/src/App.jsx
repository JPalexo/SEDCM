import React, { useEffect, useRef, useState } from 'react'
import ZoneSelector from './components/ZoneSelector'
import RackList from './components/RackList'
import RackDetail from './components/RackDetail'
import LogsPanel from './components/LogsPanel'

const API = 'http://127.0.0.1:3000'
const WS_URL = 'ws://127.0.0.1:3000/ws'

function buildZonesFromInventory(inventory) {
  return inventory.zones.map(z => ({
    id: z.zone_code,
    name: `Zona ${z.zone_code}`,
    zone_code: z.zone_code,
    racks: (z.racks || []).map(r => ({
      id: `${z.zone_code}-${r.rack_code}`,
      name: `Rack ${r.rack_code}`,
      zone_code: z.zone_code,
      rack_code: r.rack_code,
      environment_status: r.environment_status || 'Normal',
      servers: (r.nodes || []).map(n => ({
        id: n.node_id,
        name: n.node_id,
        host: `${z.zone_code}/${r.rack_code}`,
        zone_code: z.zone_code,
        rack_code: r.rack_code,
        health_status: n.health_status || 'Normal',
        metrics: { cpu: 0, ram: 0, temp: 0, humidity: 0, net: 0 },
        metricsHistory: []
      }))
    }))
  }))
}

function mapNodeMetrics(backendMetrics) {
  return {
    cpu: Number((backendMetrics.cpu_usage_pct ?? 0).toFixed(1)),
    ram: Number(((backendMetrics.ram_usage_mb ?? 0) / 16384 * 100).toFixed(1)),
    net: Number((((backendMetrics.net_rx_bytes_sec ?? 0) + (backendMetrics.net_tx_bytes_sec ?? 0)) / 125000).toFixed(1))
  }
}

function mapEnvMetrics(backendEnv) {
  return {
    temp: Number((backendEnv.temperature_c ?? 0).toFixed(1)),
    humidity: Number((backendEnv.humidity_pct ?? 0).toFixed(1))
  }
}

function eventToLog(event) {
  const { type, data } = event
  const t = Date.now()

  if (type === 'node_status_changed') {
    const level = data.new_status === 'Critico' || data.new_status === 'OFFLINE' ? 'critical' : data.new_status === 'Warning' ? 'warn' : 'info'
    return { t, level, text: `[${data.zone_code}/${data.rack_code}] ${data.node_id}: estado → ${data.new_status}` }
  }
  if (type === 'rack_status_changed') {
    const level = data.new_status === 'Critico' ? 'critical' : data.new_status === 'Warning' ? 'warn' : 'info'
    return { t, level, text: `[${data.zone_code}/${data.rack_code}] Ambiente rack → ${data.new_status}` }
  }
  if (type === 'command_published') {
    return { t, level: 'warn', text: `CMD [${data.zone_code}/${data.rack_code}] ${data.action} sobre ${data.node_id ?? 'rack'} — razón: ${data.reason}` }
  }
  if (type === 'command_ack_received') {
    const level = data.status === 'FAILED' ? 'critical' : 'info'
    return { t, level, text: `ACK ${data.status} para comando ${String(data.command_id).slice(0, 8)}…` }
  }
  if (type === 'escalation_event') {
    const level = data.stage === 'hard_shutdown_selected' ? 'critical' : 'warn'
    return { t, level, text: `ESCALACIÓN [${data.zone_code}/${data.rack_code}] ${data.node_id ?? ''} etapa: ${data.stage}` }
  }
  return null
}

export default function App() {
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(true)
  const [wsStatus, setWsStatus] = useState('conectando')

  const [selectedZone, setSelectedZone] = useState(null)
  const [selectedRack, setSelectedRack] = useState(null)
  const [logs, setLogs] = useState([])

  // Nodos con start_node en vuelo — se limpian al recibir node_status_changed a estado activo
  const [recoveringNodes, setRecoveringNodes] = useState(new Set())
  // Mensajes de error por timeout de recuperación, keyed por node_id
  const [recoveryErrors, setRecoveryErrors] = useState({})

  const wsRef = useRef(null)
  const zonesRef = useRef(zones)
  zonesRef.current = zones
  // Timers de timeout para start_node, keyed por node_id
  const recoveryTimersRef = useRef({})
  // Distingue primera conexión WS de reconexiones
  const wsFirstConnectRef = useRef(true)

  function pushLog(entry) {
    setLogs(prev => [entry, ...prev].slice(0, 200))
  }

  async function sendCommand({ zone_code, rack_code, target_type, target_id, action, reason, mode }) {
    try {
      const res = await fetch(`${API}/api/v1/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone_code, rack_code, target_type, target_id, action, reason, mode })
      })
      const data = await res.json()
      if (res.ok) {
        pushLog({ t: Date.now(), level: 'info', text: `Comando '${action}' despachado → ${String(data.command_id).slice(0, 8)}…` })
        if (action === 'start_node') {
          setRecoveringNodes(prev => new Set([...prev, target_id]))
          setRecoveryErrors(prev => { const n = { ...prev }; delete n[target_id]; return n })

          // Paso 4: timeout de 10 s — si el nodo sigue OFFLINE, muestra error
          const timerId = setTimeout(() => {
            setRecoveringNodes(prev => {
              if (!prev.has(target_id)) return prev
              const next = new Set(prev)
              next.delete(target_id)
              return next
            })
            setRecoveryErrors(prev => ({ ...prev, [target_id]: 'Error: Servidor inalcanzable (Revisar contenedor)' }))
            delete recoveryTimersRef.current[target_id]
          }, 10000)
          recoveryTimersRef.current[target_id] = timerId
        }
      } else {
        pushLog({ t: Date.now(), level: 'warn', text: `Error al despachar '${action}': ${data.detail || data.error || res.status}` })
      }
    } catch (e) {
      pushLog({ t: Date.now(), level: 'warn', text: `Error de red al despachar '${action}': ${e.message}` })
    }
  }

  // ── Paso 3: Carga inicial con auto-retry cada 5 s hasta que el backend responda ──
  useEffect(() => {
    let cancelled = false
    let retryTimer = null

    async function tryFetch() {
      try {
        const r = await fetch(`${API}/api/v1/inventory`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        if (cancelled) return
        const built = buildZonesFromInventory(data)
        setZones(built)
        pushLog({ t: Date.now(), level: 'info', text: `Inventario cargado: ${built.length} zona(s), ${built.reduce((s, z) => s + z.racks.length, 0)} rack(s)` })
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        pushLog({ t: Date.now(), level: 'warn', text: `Backend no disponible — reintentando en 5 s… (${err.message})` })
        retryTimer = setTimeout(tryFetch, 5000)
      }
    }

    tryFetch()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  // ── WebSocket: actualizaciones en tiempo real ─────────────────────────────
  useEffect(() => {
    if (loading) return

    function connect() {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setWsStatus('conectado')
        pushLog({ t: Date.now(), level: 'info', text: 'WebSocket conectado al backend' })

        // Paso 3: en reconexión, re-fetch inventario para sincronizar estructura
        if (!wsFirstConnectRef.current) {
          fetch(`${API}/api/v1/inventory`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data) return
              const built = buildZonesFromInventory(data)
              setZones(built)
              pushLog({ t: Date.now(), level: 'info', text: 'Inventario actualizado tras reconexión' })
            })
            .catch(() => {})
        }
        wsFirstConnectRef.current = false

        fetch(`${API}/api/v1/audit/commands?limit=50`)
          .then(r => r.ok ? r.json() : { commands: [] })
          .then(data => {
            const auditLogs = (data.commands || []).map(c => ({
              t: new Date(c.dispatched_at).getTime(),
              level: c.ack_status === 'FAILED' ? 'warn' : 'info',
              text: `[AUDITORÍA] ${c.action} → ${c.node_id || c.rack_code} (${c.ack_status})`
            }))
            if (auditLogs.length) {
              setLogs(prev => [...prev, ...auditLogs].slice(0, 200))
            }
          })
          .catch(() => {})
      }

      ws.onmessage = (msg) => {
        let event
        try { event = JSON.parse(msg.data) } catch { return }

        const { type, data } = event

        if (type === 'telemetry_node_received') {
          const { dc_zone, dc_rack, node_id } = data.metadata
          const nodeMetrics = mapNodeMetrics(data.metrics)
          setZones(prev => prev.map(z => {
            if (z.zone_code !== dc_zone) return z
            return {
              ...z,
              racks: z.racks.map(r => {
                if (r.rack_code !== dc_rack) return r
                return {
                  ...r,
                  servers: r.servers.map(s => {
                    if (s.id !== node_id) return s
                    const merged = { ...s.metrics, ...nodeMetrics }
                    const history = [...(s.metricsHistory || []), { ...merged, t: Date.now() }].slice(-60)
                    return { ...s, metrics: merged, metricsHistory: history }
                  })
                }
              })
            }
          }))
        }

        if (type === 'telemetry_environment_received') {
          const { dc_zone, dc_rack } = data.metadata
          const envMetrics = mapEnvMetrics(data.environment)
          setZones(prev => prev.map(z => {
            if (z.zone_code !== dc_zone) return z
            return {
              ...z,
              racks: z.racks.map(r => {
                if (r.rack_code !== dc_rack) return r
                return {
                  ...r,
                  servers: r.servers.map(s => {
                    const merged = { ...s.metrics, ...envMetrics }
                    if (s.health_status === 'OFFLINE') {
                      return { ...s, metrics: merged }
                    }
                    const history = [...(s.metricsHistory || []), { ...merged, t: Date.now() }].slice(-60)
                    return { ...s, metrics: merged, metricsHistory: history }
                  })
                }
              })
            }
          }))
        }

        if (type === 'node_status_changed') {
          if (data.new_status !== 'OFFLINE') {
            setRecoveringNodes(prev => {
              if (!prev.has(data.node_id)) return prev
              const next = new Set(prev)
              next.delete(data.node_id)
              return next
            })
            // Paso 4: limpiar timer y error al recuperarse antes del timeout
            if (recoveryTimersRef.current[data.node_id]) {
              clearTimeout(recoveryTimersRef.current[data.node_id])
              delete recoveryTimersRef.current[data.node_id]
            }
            setRecoveryErrors(prev => {
              if (!(data.node_id in prev)) return prev
              const n = { ...prev }
              delete n[data.node_id]
              return n
            })
          }

          setZones(prev => prev.map(z => {
            if (z.zone_code !== data.zone_code) return z
            return {
              ...z,
              racks: z.racks.map(r => {
                if (r.rack_code !== data.rack_code) return r
                return {
                  ...r,
                  servers: r.servers.map(s => {
                    if (s.id !== data.node_id) return s
                    const base = { ...s, health_status: data.new_status }
                    if (data.new_status === 'OFFLINE') {
                      const zeroedMetrics = { ...s.metrics, cpu: 0, ram: 0, net: 0 }
                      base.metrics = zeroedMetrics
                      base.metricsHistory = [...(s.metricsHistory || []), { ...zeroedMetrics, t: Date.now() }].slice(-60)
                    }
                    return base
                  })
                }
              })
            }
          }))
        }

        if (type === 'rack_status_changed') {
          setZones(prev => prev.map(z => {
            if (z.zone_code !== data.zone_code) return z
            return {
              ...z,
              racks: z.racks.map(r =>
                r.rack_code === data.rack_code ? { ...r, environment_status: data.new_status } : r
              )
            }
          }))
        }

        const logEntry = eventToLog(event)
        if (logEntry) pushLog(logEntry)
      }

      ws.onclose = () => {
        setWsStatus('reconectando')
        setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        setWsStatus('error')
        ws.close()
      }
    }

    connect()
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
      }
    }
  }, [loading])

  // ── Fase C: carga historial de telemetría al seleccionar un rack ─────────
  async function selectRack(rack) {
    setSelectedRack(rack)

    try {
      const [nodeRes, envRes] = await Promise.all([
        fetch(`${API}/api/v1/telemetry/node?zone_code=${rack.zone_code}&rack_code=${rack.rack_code}&limit=60`),
        fetch(`${API}/api/v1/telemetry/environment?zone_code=${rack.zone_code}&rack_code=${rack.rack_code}&limit=60`)
      ])

      const [nodeData, envData] = await Promise.all([
        nodeRes.ok ? nodeRes.json() : { items: [] },
        envRes.ok ? envRes.json() : { items: [] }
      ])

      const nodeHistory = {}
      for (const item of [...(nodeData.items || [])].reverse()) {
        if (!nodeHistory[item.node_id]) nodeHistory[item.node_id] = []
        nodeHistory[item.node_id].push({
          t: new Date(item.event_time).getTime(),
          ...mapNodeMetrics({
            cpu_usage_pct: item.cpu_usage_pct,
            ram_usage_mb: item.ram_usage_mb,
            net_rx_bytes_sec: item.net_rx_bytes_sec,
            net_tx_bytes_sec: item.net_tx_bytes_sec
          })
        })
      }

      const envHistory = [...(envData.items || [])].reverse().map(item => ({
        t: new Date(item.event_time).getTime(),
        ...mapEnvMetrics({ temperature_c: item.temperature_c, humidity_pct: item.humidity_pct })
      }))

      setZones(prev => prev.map(z => {
        if (z.zone_code !== rack.zone_code) return z
        return {
          ...z,
          racks: z.racks.map(r => {
            if (r.rack_code !== rack.rack_code) return r
            return {
              ...r,
              servers: r.servers.map(s => {
                const nHist = nodeHistory[s.id] || []
                const merged = nHist.map(np => {
                  const closest = envHistory.reduce((best, ep) =>
                    Math.abs(ep.t - np.t) < Math.abs((best?.t ?? Infinity) - np.t) ? ep : best
                  , null)
                  return { ...np, ...(closest ? { temp: closest.temp, humidity: closest.humidity } : {}) }
                })
                const baseHistory = merged.length ? merged : envHistory.map(ep => ({ ...s.metrics, ...ep }))
                const existing = s.metricsHistory || []
                const existingTs = new Set(existing.map(p => p.t))
                const combined = [...baseHistory.filter(p => !existingTs.has(p.t)), ...existing]
                  .sort((a, b) => a.t - b.t)
                  .slice(-60)
                return { ...s, metricsHistory: combined }
              })
            }
          })
        }
      }))
    } catch {
      // El historial no es crítico — la gráfica seguirá mostrando datos del WS en vivo
    }
  }

  useEffect(() => {
    if (selectedZone) setSelectedRack(null)
  }, [selectedZone])

  const wsIndicatorClass = wsStatus === 'conectado' ? 'ws-ok' : wsStatus === 'conectando' ? 'ws-wait' : 'ws-err'

  if (loading) {
    return (
      <div className="app-root">
        <header className="topbar"><h1>SEDCM — Monitor Datacenter</h1></header>
        <div className="container" style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: '8px' }}>
          <div style={{ color: '#aaa', fontSize: '1.1rem' }}>Conectando al backend…</div>
          <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Reintentando automáticamente cada 5 s</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-root">
      <header className="topbar">
        <h1>SEDCM — Monitor Datacenter</h1>
        <span className={`ws-badge ${wsIndicatorClass}`} title={`WebSocket: ${wsStatus}`}>
          ● {wsStatus}
        </span>
      </header>
      <div className="container">
        <aside className="sidebar">
          <ZoneSelector zones={zones} onSelect={z => setSelectedZone(z)} selected={selectedZone} />
          <LogsPanel logs={logs} />
        </aside>
        <main className="main">
          {!selectedZone && (
            <div className="placeholder">Selecciona una zona para ver sus racks</div>
          )}
          {selectedZone && !selectedRack && (
            <RackList zone={zones.find(z => z.id === selectedZone.id)} onSelect={selectRack} />
          )}
          {selectedRack && (
            <RackDetail
              rack={zones.flatMap(z => z.racks).find(r => r.id === selectedRack.id) || selectedRack}
              onBack={() => setSelectedRack(null)}
              onCommand={sendCommand}
              recoveringNodes={recoveringNodes}
              recoveryErrors={recoveryErrors}
            />
          )}
        </main>
      </div>
      <footer className="footer">
        Conectado al backend — datos en tiempo real vía WebSocket
      </footer>
    </div>
  )
}
