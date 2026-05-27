import React, { useEffect, useRef, useState } from 'react'

export default function LineChart({ data = [], metric, width=680, height=260 }){
  const w = width
  const h = height
  const windowMs = 60000 // show last 60s window
  const [now, setNow] = useState(Date.now())
  const rafRef = useRef()
  const containerRef = useRef()
  const [tooltip, setTooltip] = useState(null)

  useEffect(()=>{
    let mounted = true
    function tick(){
      if(!mounted) return
      setNow(Date.now())
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return ()=>{ mounted=false; cancelAnimationFrame(rafRef.current) }
  }, [])

  const points = data.map(d=>({ t: d.t, v: Number(d.v) }))
  const values = points.map(p=>p.v)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : min + 1
  const range = max - min || 1

  function pxFromTime(t){
    const start = now - windowMs
    return 20 + ((t - start)/windowMs) * (w-40)
  }
  function pyFromValue(v){
    return 20 + (1 - (v - min)/range) * (h-40)
  }

  // build smooth path from timestamped points (only those inside window)
  const visible = points.filter(p=> (pxFromTime(p.t) >= 0 - 40 && pxFromTime(p.t) <= w + 40) )
  const pts = visible.map(p=>({ x: pxFromTime(p.t), y: pyFromValue(p.v), v: p.v, t: p.t }))

  let pathD = ''
  if(pts.length===1){ pathD = `M ${pts[0].x} ${pts[0].y}` }
  else if(pts.length>1){
    pathD = `M ${pts[0].x} ${pts[0].y}`
    for(let i=1;i<pts.length;i++){
      const p0 = pts[i-1]
      const p1 = pts[i]
      const dx = (p1.x - p0.x) * 0.25
      const x1 = p0.x + dx
      const y1 = p0.y
      const x2 = p1.x - dx
      const y2 = p1.y
      pathD += ` C ${x1} ${y1} ${x2} ${y2} ${p1.x} ${p1.y}`
    }
  }
  const areaD = pathD ? (pathD + ` L ${w-20} ${h-20} L 20 ${h-20} Z`) : ''
  const last = values.length ? values[values.length-1] : '--'

  // ticks based on window
  const ticks = []
  const tickCount = 6
  for(let i=0;i<tickCount;i++){
    const t = now - windowMs + i*(windowMs/(tickCount-1))
    ticks.push({ x: pxFromTime(t), label: new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) })
  }

  function handleMove(e){
    const rect = containerRef.current.getBoundingClientRect()
    const cx = e.clientX - rect.left
    // find nearest point
    let nearest = null; let best = Infinity
    for(const p of pts){ const d = Math.abs(p.x - cx); if(d < best){ best = d; nearest = p } }
    if(nearest && best < 30){
      setTooltip({ x: nearest.x, y: nearest.y, v: nearest.v, t: nearest.t })
    } else setTooltip(null)
  }
  function handleLeave(){ setTooltip(null) }

  return (
    <div className="linechart" ref={containerRef} onMouseMove={handleMove} onMouseLeave={handleLeave} style={{width: w}}>
      <div className="chart-header">
        <div className="metric-title">{metric.toUpperCase()}</div>
        <div className="metric-value">{last}</div>
      </div>
      {pts.length ? (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#66d9ef" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#66d9ef" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path className="chart-area" d={areaD} fill="url(#g1)" opacity="0.9" />
          <path className="chart-line" d={pathD} fill="none" stroke="#66d9ef" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {ticks.map((t,i)=>(
            <g key={i}>
              <line x1={t.x} y1={h-20} x2={t.x} y2={h-16} stroke="rgba(255,255,255,0.03)" />
              <text x={t.x} y={h-4} fontSize="10" textAnchor="middle" fill="rgba(230,238,243,0.55)">{t.label}</text>
            </g>
          ))}
        </svg>
      ) : (
        <div className="no-data">Sin datos</div>
      )}

      {tooltip && (
        <div className="chart-tooltip" style={{left: tooltip.x, top: tooltip.y - 36}}>
          <div className="tt-time">{new Date(tooltip.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</div>
          <div className="tt-val">{tooltip.v}</div>
        </div>
      )}
    </div>
  )
}
