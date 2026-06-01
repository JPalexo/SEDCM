import React, { useEffect, useRef, useState } from 'react'
import ZoneSelector from './components/ZoneSelector'
import RackList from './components/RackList'
import RackDetail from './components/RackDetail'
import ZoneControls from './components/ZoneControls'
import LogsPanel from './components/LogsPanel'

const API = 'http://127.0.0.1:3000'
const WS_URL = 'ws://127.0.0.1:3000/ws'

// Convierte la respuesta de GET /api/v1/inventory a la estructura interna
// que usan ZoneSelector, RackList y RackDetail.
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

// Mapea métricas del backend (unidades reales) a las keys que usan los componentes
function mapNodeMetrics(backendMetrics) {
  return {
    cpu: Number((backendMetrics.cpu_usage_pct ?? 0).toFixed(1)),
    // ram: MB absolutos → % asumiendo 16 GB máx
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

// Formatea un evento WebSocket en entrada de log legible
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
  const [backendError, setBackendError] = useState(null)
  const [wsStatus, setWsStatus] = useState('conectando')

  const [selectedZone, setSelectedZone] = useState(null)
  const [selectedRack, setSelectedRack] = useState(null)
  const [zoneControls, setZoneControls] = useState({})
  const [logs, setLogs] = useState([])
  // Mapa rackKey → último modo HVAC conocido, actualizado por eventos command_published
  const [hvacModeByRack, setHvacModeByRack] = useState({})
  // Nodos con start_node en vuelo — se limpian al recibir node_status_changed a estado activo
  const [recoveringNodes, setRecoveringNodes] = useState(new Set())

  const wsRef = useRef(null)
  const zonesRef = useRef(zones)
  zonesRef.current = zones

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
        }
      } else {
        pushLog({ t: Date.now(), level: 'warn', text: `Error al despachar '${action}': ${data.detail || data.error || res.status}` })
      }
    } catch (e) {
      pushLog({ t: Date.now(), level: 'warn', text: `Error de red al despachar '${action}': ${e.message}` })
    }
  }

  // ── Carga inicial: GET /api/v1/inventory ─────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/v1/inventory`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        const built = buildZonesFromInventory(data)
        setZones(built)
        setZoneControls(Object.fromEntries(built.map(z => [z.id, { hvac: 50, extractor: 50 }])))
        pushLog({ t: Date.now(), level: 'info', text: `Inventario cargado: ${built.length} zona(s), ${built.reduce((s, z) => s + z.racks.length, 0)} rack(s)` })
        setLoading(false)
      })
      .catch(err => {
        setBackendError(err.message)
        setLoading(false)
        pushLog({ t: Date.now(), level: 'critical', text: `Error conectando al backend: ${err.message}` })
      })
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
        // Cargar historial de auditoría solo una vez al conectar
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

        // Actualizar métricas de nodo
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

        // Actualizar métricas ambientales del rack (temp + humidity a todos los nodos del rack)
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
                    // Nodo OFFLINE: actualiza temp/humidity para el indicador de HVAC y el botón
                    // de recuperación, pero NO agrega puntos al historial (evita trazar línea congelada)
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

        // Actualizar health_status del nodo
        if (type === 'node_status_changed') {
          // Si el nodo sale de OFFLINE, ya no está en proceso de recuperación
          if (data.new_status !== 'OFFLINE') {
            setRecoveringNodes(prev => {
              if (!prev.has(data.node_id)) return prev
              const next = new Set(prev)
              next.delete(data.node_id)
              return next
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
                    // Al pasar a OFFLINE: zerear cpu/ram/net y agregar punto final al historial
                    // para que la gráfica muestre la caída antes de detenerse
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

        // Actualizar environment_status del rack
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

        // Registrar modo HVAC cuando el sistema despacha set_hvac_mode automáticamente
        if (type === 'command_published' && data.action === 'set_hvac_mode' && data.mode) {
          const rackKey = `${data.zone_code}-${data.rack_code}`
          setHvacModeByRack(prev => ({ ...prev, [rackKey]: data.mode }))
        }

        // Agregar al panel de logs
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

      // Agrupar historial de nodo por node_id, ordenado de más antiguo a más reciente
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

      // Historial ambiental compartido para todos los nodos del rack, ordenado de más antiguo a más reciente
      const envHistory = [...(envData.items || [])].reverse().map(item => ({
        t: new Date(item.event_time).getTime(),
        ...mapEnvMetrics({ temperature_c: item.temperature_c, humidity_pct: item.humidity_pct })
      }))

      // Fusionar historial en el estado — solo para el rack seleccionado
      setZones(prev => prev.map(z => {
        if (z.zone_code !== rack.zone_code) return z
        return {
          ...z,
          racks: z.racks.map(r => {
            if (r.rack_code !== rack.rack_code) return r
            return {
              ...r,
              servers: r.servers.map(s => {
                // Combinar puntos históricos de nodo y ambiente por timestamp
                const nHist = nodeHistory[s.id] || []
                // Para cada punto de nodo, buscar el punto ambiental más cercano
                const merged = nHist.map(np => {
                  const closest = envHistory.reduce((best, ep) =>
                    Math.abs(ep.t - np.t) < Math.abs((best?.t ?? Infinity) - np.t) ? ep : best
                  , null)
                  return { ...np, ...(closest ? { temp: closest.temp, humidity: closest.humidity } : {}) }
                })
                // Si no hay historial de nodo pero sí ambiental, usar solo ambiental
                const baseHistory = merged.length ? merged : envHistory.map(ep => ({ ...s.metrics, ...ep }))
                // Fusionar con lo que ya tiene (puntos en vivo del WS), sin duplicar por timestamp
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

  // Limpiar rack seleccionado al cambiar de zona
  useEffect(() => {
    if (selectedZone) setSelectedRack(null)
  }, [selectedZone])

  function updateZoneControls(zoneId, controls) {
    setZoneControls(prev => ({ ...prev, [zoneId]: controls }))
  }

  const wsIndicatorClass = wsStatus === 'conectado' ? 'ws-ok' : wsStatus === 'conectando' ? 'ws-wait' : 'ws-err'

  if (loading) {
    return (
      <div className="app-root">
        <header className="topbar"><h1>SEDCM — Monitor Datacenter</h1></header>
        <div className="container" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ color: '#aaa', fontSize: '1.1rem' }}>Conectando al backend…</div>
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
          {backendError && (
            <div className="placeholder" style={{ color: '#f87171' }}>
              No se pudo conectar al backend: {backendError}<br />
              <small>Asegúrate de que el backend esté corriendo en {API}</small>
            </div>
          )}
          {!backendError && !selectedZone && (
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
            />
          )}
        </main>
        <aside className="rightpanel">
          <ZoneControls
            zone={selectedZone ? zones.find(z => z.id === selectedZone.id) : null}
            controls={selectedZone ? (zoneControls[selectedZone.id] || { hvac: 50, extractor: 50 }) : {}}
            onChange={updateZoneControls}
            selectedRack={selectedRack ? (zones.flatMap(z => z.racks).find(r => r.id === selectedRack.id) || selectedRack) : null}
            hvacMode={selectedRack ? (hvacModeByRack[selectedRack.id] || 'off') : 'off'}
          />
        </aside>
      </div>
      <footer className="footer">
        Conectado al backend — datos en tiempo real vía WebSocket
      </footer>
    </div>
  )
}
