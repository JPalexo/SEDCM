import React, { useEffect, useState } from 'react'

export default function ExtractorControl({ value, simulate = true, simInterval = 2000 }){
  const [internal, setInternal] = useState(typeof value === 'number' ? value : 50)
  const current = typeof value === 'number' ? value : internal

  useEffect(()=>{
    if(typeof value === 'number') return
    if(!simulate) return
    const id = setInterval(()=>{
      setInternal(prev=>{
        const change = (Math.random() - 0.45) * 8
        let next = Math.round(prev + change)
        if(next < 0) next = 0
        if(next > 100) next = 100
        return next
      })
    }, simInterval)
    return ()=>clearInterval(id)
  }, [simulate, simInterval, value])

  return (
    <div className="extractor-control">
      <div className="ctrl-title">Extractores</div>
      <div className="ctrl-row" style={{flexDirection:'column',alignItems:'stretch',gap:8}}>
        <div className="hvac-bar">
          <div className="hvac-fill" style={{width:`${current}%`}} />
        </div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div className="ctrl-value">{current}%</div>
          <div className="label" style={{fontSize:12,color:'var(--muted)'}}>Uso actual</div>
        </div>
      </div>
    </div>
  )
}
