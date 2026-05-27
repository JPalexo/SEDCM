import React, { useState } from 'react'
import LineChart from './LineChart'
// import HistoryModal from './HistoryModal'

const METRICS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'ram', label: 'RAM' },
  { key: 'temp', label: 'Temp' },
  { key: 'humidity', label: 'Humedad' },
  { key: 'net', label: 'Red' },
  { key: 'power', label: 'Consumo' }
]

export default function RackDetail({ rack, onBack }){
  const [metric, setMetric] = useState('cpu');
  const [expandedServer, setExpandedServer] = useState(null);

  React.useEffect(()=>{
    setExpandedServer(rack && rack.servers && rack.servers[0] ? rack.servers[0].id : null)
  }, [rack])

  function getDataForMetric(server, metricKey){
    const history = server.metricsHistory || []
    return history.map(h=>({ t: h.t, v: h[metricKey] }))
  }

  return (
    <div className="rack-detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>← Volver</button>
        <h2>{rack.name} — Detalle de servidores</h2>
      </div>
      <div className="servers-grid">
        {rack.servers.map(s=> (
          <div key={s.id} className="server-card">
            <div className="server-head">
              <div>
                <div className="server-name">{s.name}</div>
                <div className="server-host">{s.host}</div>
              </div>
              <div className="server-actions">
                <button className="history-btn" onClick={()=>{ setExpandedServer(s.id); setMetric('cpu') }}>
                  Ver historial
                </button>
              </div>
            </div>
            <div className="server-metrics">
              <div><span className="label">CPU</span><strong>{s.metrics.cpu}%</strong></div>
              <div><span className="label">RAM</span><strong>{s.metrics.ram}%</strong></div>
              <div><span className="label">Temp</span><strong>{s.metrics.temp}°C</strong></div>
              <div><span className="label">Humedad</span><strong>{s.metrics.humidity}%</strong></div>
              <div><span className="label">Red</span><strong>{s.metrics.net} Mbps</strong></div>
              <div><span className="label">Consumo</span><strong>{s.metrics.power}%</strong></div>
            </div>

            {/* small inline chart removed - expanded chart shown below by default */}

          </div>
        ))}
      </div>

      {expandedServer && (() => {
        const srv = rack.servers.find(x=>x.id===expandedServer)
        if(!srv) return null
        const history = srv.metricsHistory || []
        const data = history.map(h=>({ t: h.t, v: h[metric] }))
        return (
          <div className="expanded-panel">
            <div className="expanded-header">
              <div>
                <div className="expanded-title">{srv.name} — Historial expandido</div>
                <div className="expanded-sub">{srv.host}</div>
              </div>
              <div className="expanded-actions">
                <div className="metric-selector">
                  {METRICS.map(m=> (
                    <button key={m.key} className={m.key===metric? 'metric-btn active' : 'metric-btn'} onClick={()=>setMetric(m.key)}>{m.label}</button>
                  ))}
                </div>
                <button className="close-exp" onClick={()=>setExpandedServer(null)}>Cerrar</button>
              </div>
            </div>
            <div className="expanded-chart-wrap">
              <LineChart data={data} metric={metric} width={980} height={300} />
            </div>
          </div>
        )
      })()}
    </div>
  )
}
