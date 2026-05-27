import React, { useEffect, useRef } from 'react'

export default function LogsPanel({ logs = [] }){
  const panelRef = useRef()
  const prevLenRef = useRef((logs && logs.length) || 0)

  useEffect(()=>{
    const el = panelRef.current
    if(!el) return

    const prevLen = prevLenRef.current
    const currLen = logs.length

    // determine if user is near the bottom (within 80px)
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= 80

    // If this is initial population or user is at bottom, auto-scroll to bottom
    if(prevLen === 0 || atBottom){
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }

    prevLenRef.current = currLen
  }, [logs])

  // Render logs oldest -> newest so newest appears at the bottom
  const rendered = Array.isArray(logs) ? [...logs].slice().reverse() : []

  return (
    <div className="logs-panel" ref={panelRef}>
      <h3>Logs</h3>
      <div className="logs-list">
        {rendered.map((l,i)=>(
          <div key={i} className={`log-item log-${l.level}`}>
            <div className="log-time">{new Date(l.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</div>
            <div className="log-text">{l.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
