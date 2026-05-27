import React from 'react'

export default function ZoneSelector({ zones, onSelect, selected }){
  return (
    <div className="zone-list">
      <h2>Zonas</h2>
      {zones.map(z=> (
        <button key={z.id} className={selected && selected.id===z.id ? 'zone-btn active' : 'zone-btn'} onClick={()=>onSelect(z)}>
          {z.name}
        </button>
      ))}
    </div>
  )
}
