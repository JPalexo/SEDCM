import React, { useState } from 'react'
import LineChart from './LineChart'

const METRICS = [
  { key: 'cpu',      label: 'CPU'     },
  { key: 'ram',      label: 'RAM'     },
  { key: 'temp',     label: 'Temp'    },
  { key: 'humidity', label: 'Humedad' },
  { key: 'net',      label: 'Red'     },
]

export default function RackDetail({ rack, onBack, onCommand, recoveringNodes = new Set(), recoveryErrors = {} }) {
  const [metric, setMetric] = useState('cpu')
  const [expandedServer, setExpandedServer] = useState(null)

  // Paso 2: usar rack.id como dependencia en lugar del objeto completo para que las
  // actualizaciones de telemetría (que recrean rack) no reseteen el nodo seleccionado
  React.useEffect(() => {
    setExpandedServer(rack && rack.servers && rack.servers[0] ? rack.servers[0].id : null)
  }, [rack.id])

  // Temperatura ambiental del rack — todos los nodos del rack comparten la misma fuente ambiental,
  // por lo que temp se mantiene actualizada incluso cuando el nodo está OFFLINE
  const rackAmbientTemp = rack.servers.length > 0
    ? rack.servers.reduce((sum, sv) => sum + (sv.metrics.temp || 0), 0) / rack.servers.length
    : 0

  function handleRecover(server) {
    onCommand({
      zone_code:   rack.zone_code,
      rack_code:   rack.rack_code,
      target_type: 'nodo',
      target_id:   server.id,
      action:      'start_node',
      reason:      'Recuperación manual desde Dashboard',
    })
  }

  return (
    <div className="rack-detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>← Volver</button>
        <h2>{rack.name} — Detalle de servidores</h2>
      </div>

      <div className="servers-grid">
        {rack.servers.map(s => {
          const isOffline = s.health_status === 'OFFLINE'
          const isRecovering = recoveringNodes.has(s.id)
          const canRecover = isOffline && rackAmbientTemp <= 42 && !isRecovering

          return (
            <div key={s.id} className={`server-card${isOffline ? ' server-offline' : ''}`}>
              <div className="server-head">
                <div>
                  <div className="server-name">{s.name}</div>
                  <div className="server-host">{s.host}</div>
                </div>
                <div className="server-actions">
                  {isOffline && (
                    <div>
                      <button
                        className="recover-btn"
                        disabled={!canRecover}
                        title={
                          isRecovering
                            ? 'Comando de recuperación en progreso — esperando confirmación del nodo'
                            : canRecover
                            ? 'Enviar comando start_node al nodo'
                            : `Rack a ${rackAmbientTemp.toFixed(1)}°C — espera enfriamiento (≤ 42°C)`
                        }
                        onClick={() => handleRecover(s)}
                      >
                        {isRecovering ? 'Recuperando…' : 'Recuperar Nodo'}
                      </button>
                      {recoveryErrors[s.id] && (
                        <div style={{ color: 'var(--danger)', fontSize: '11px', marginTop: '4px', maxWidth: '160px' }}>
                          {recoveryErrors[s.id]}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    className="history-btn"
                    onClick={() => { setExpandedServer(s.id); setMetric('cpu') }}
                  >
                    Ver historial
                  </button>
                </div>
              </div>

              {isOffline && (
                <div className="offline-banner">
                  <span className="offline-badge">APAGADO</span>
                  {rackAmbientTemp > 42 && (
                    <span className="offline-temp-warn">
                      Rack {rackAmbientTemp.toFixed(1)}°C — espera enfriamiento
                    </span>
                  )}
                </div>
              )}

              <div className="server-metrics">
                <div>
                  <span className="label">CPU</span>
                  <strong className={isOffline ? 'metric-offline' : ''}>{s.metrics.cpu}%</strong>
                </div>
                <div>
                  <span className="label">RAM</span>
                  <strong className={isOffline ? 'metric-offline' : ''}>{s.metrics.ram}%</strong>
                </div>
                <div>
                  <span className="label">Temp</span>
                  <strong>{s.metrics.temp}°C</strong>
                </div>
                <div>
                  <span className="label">Humedad</span>
                  <strong>{s.metrics.humidity}%</strong>
                </div>
                <div>
                  <span className="label">Red</span>
                  <strong className={isOffline ? 'metric-offline' : ''}>{s.metrics.net} Mbps</strong>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {expandedServer && (() => {
        const srv = rack.servers.find(x => x.id === expandedServer)
        if (!srv) return null
        const isOffline = srv.health_status === 'OFFLINE'
        const history = srv.metricsHistory || []
        const data = history.map(h => ({ t: h.t, v: h[metric] }))

        return (
          <div className="expanded-panel">
            <div className="expanded-header">
              <div>
                <div className="expanded-title">
                  {srv.name} — Historial expandido
                  {isOffline && <span className="offline-badge" style={{ marginLeft: '10px' }}>APAGADO</span>}
                </div>
                <div className="expanded-sub">{srv.host}</div>
              </div>
              <div className="expanded-actions">
                <div className="metric-selector">
                  {METRICS.map(m => (
                    <button
                      key={m.key}
                      className={m.key === metric ? 'metric-btn active' : 'metric-btn'}
                      onClick={() => setMetric(m.key)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <button className="close-exp" onClick={() => setExpandedServer(null)}>Cerrar</button>
              </div>
            </div>

            {isOffline && (
              <div className="offline-chart-note">
                Nodo APAGADO — trazado detenido. Se muestra el historial previo al apagado.
              </div>
            )}

            <div className="expanded-chart-wrap">
              <LineChart data={data} metric={metric} width={980} height={300} />
            </div>
          </div>
        )
      })()}
    </div>
  )
}
