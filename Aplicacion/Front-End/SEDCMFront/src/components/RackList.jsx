import React from 'react'

// Mapea los estados del backend a las clases CSS existentes
function statusToClass(status) {
  if (status === 'Critico' || status === 'OFFLINE') return 'critico'
  if (status === 'Warning') return 'peligro'
  return 'estable'
}

export default function RackList({ zone, onSelect }) {
  return (
    <div className="rack-list">
      <h2>{zone.name} — Racks</h2>
      <div className="racks-grid">
        {zone.racks.map(r => {
          const statusClass = statusToClass(r.environment_status)
          const colorClass = `status-${statusClass}`

          // Promedios calculados desde métricas recibidas por WS
          const servers = r.servers || []
          const count = servers.length || 1
          const avgTemp = (servers.reduce((s, x) => s + (x.metrics?.temp ?? 0), 0) / count).toFixed(1)
          const avgHum = (servers.reduce((s, x) => s + (x.metrics?.humidity ?? 0), 0) / count).toFixed(1)

          return (
            <div key={r.id} className="rack-card" onClick={() => onSelect(r)}>
              <div className="rack-header">
                <div className={`status-dot ${colorClass}`}></div>
                <div className="rack-name">{r.name}</div>
              </div>
              <div className="rack-metrics">
                <div><span className="label">Ambiente</span><strong>{r.environment_status}</strong></div>
                <div><span className="label">Temp</span><strong>{avgTemp}°C</strong></div>
                <div><span className="label">Humedad</span><strong>{avgHum}%</strong></div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
