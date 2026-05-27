import React from 'react'

const MODE_META = {
  cooling:     { label: 'Enfriando',       cls: 'hvac-cooling' },
  humidify:    { label: 'Humidificando',   cls: 'hvac-humidify' },
  dehumidify:  { label: 'Deshumidificando', cls: 'hvac-dehumidify' },
  off:         { label: 'Apagado',          cls: 'hvac-off' },
}

export default function HVACControl({ rack, hvacMode }) {
  const mode = hvacMode || 'off'
  const meta = MODE_META[mode] || MODE_META.off

  return (
    <div className="hvac-control">
      <div className="ctrl-title">HVAC</div>
      {!rack ? (
        <div className="hvac-no-rack">Selecciona un rack para ver el estado del HVAC</div>
      ) : (
        <div className={`hvac-status ${meta.cls}`}>
          <div className="hvac-mode-label">{meta.label}</div>
          <div className="hvac-rack-info">
            <span>{rack.rack_code}</span>
            {rack.servers && rack.servers[0] && (
              <>
                <span>· {rack.servers[0].metrics?.temp ?? '—'}°C</span>
                <span>· {rack.servers[0].metrics?.humidity ?? '—'}%</span>
              </>
            )}
          </div>
          <div className="hvac-auto-label">Controlado automáticamente por el sistema</div>
        </div>
      )}
    </div>
  )
}
