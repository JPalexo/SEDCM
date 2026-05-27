import React from 'react'
import HVACControl from './HVACControl'
import ExtractorControl from './ExtractorControl'

export default function ZoneControls({ zone, controls, onChange, selectedRack, hvacMode }) {
  if (!zone) return (
    <div className="zone-controls empty">Selecciona una zona</div>
  )

  const handleExt = (v) => onChange(zone.id, { ...controls, extractor: v })

  return (
    <div className="zone-controls">
      <h3>{zone.name} — Controles</h3>
      <div className="controls-stack">
        <HVACControl rack={selectedRack} hvacMode={hvacMode} />
        <ExtractorControl value={controls.extractor} onChange={handleExt} />
      </div>
    </div>
  )
}
