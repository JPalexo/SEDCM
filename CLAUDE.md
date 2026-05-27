# CLAUDE.md

Este archivo provee orientación a Claude Code (claude.ai/code) al trabajar con el código de este repositorio.

## Descripción del Proyecto

**SEDCM** (Smart Edge Data Center Manager) es un sistema distribuido de grado industrial para el monitoreo y control automatizado de infraestructura crítica de datacenter. Procesa telemetría de nodos y ambiente, evalúa umbrales mediante un motor de reglas, despacha comandos de mitigación y visualiza el estado en tiempo real en un dashboard React.

> **Regla de Oro:** El sistema es 100% asíncrono y desacoplado. El Backend y los Nodos de Borde **NUNCA** se comunican directamente por HTTP. Toda comunicación pasa obligatoriamente por el Broker MQTT.

> **Actuadores automáticos:** El sistema dispara todos los actuadores (HVAC: cooling/humidify/dehumidify; soft_reboot; hard_shutdown) automáticamente por el motor de reglas. El usuario solo monitorea — no hay controles manuales de HVAC ni ambiente en la UI.

---

## Comandos de Desarrollo

### Backend (`Aplicacion/Back-End/backend_SEDCM/`)

```bash
npm install
npm run dev        # Ejecuta con tsx directamente (sin compilar, para desarrollo)
npm run build      # Compila TypeScript a dist/
npm start          # Ejecuta dist/app.js compilado
```

### Frontend (`Aplicacion/Front-End/SEDCMFront/`)

```bash
npm install
npm run dev        # Servidor Vite en puerto 5173
npm run build      # Build de producción
```

### Stack completo con Docker

```bash
# Desde Aplicacion/Back-End/backend_SEDCM/
docker compose up --build      # Levanta los 11 servicios
docker compose down
docker compose logs -f backend
docker compose logs -f edge-collector-a1
```

---

## Arquitectura por Capas

### Capa de Borde (Edge — Python)

- `Aplicacion/edge-agent/collector.py` — Publica telemetría de nodo y ambiente en MQTT. Acepta variable `SCENARIO`: `normal`, `warning`, `critical_node`, `critical_environment`.
- `Aplicacion/edge-agent/executor.py` — Suscribe a `dc/control/zona/{Z}/rack/{R}`, ejecuta comandos Docker y publica ACK + efectos de actuador.
- Los simuladores Node.js en `edge-collector/` y `edge-executor/` siguen activos en Docker para desarrollo.

### Capa Middleware

Broker MQTT Eclipse Mosquitto 2, puerto `1883` (sin TLS en desarrollo).

### Capa Central — Control Plane (`src/`)

```
MQTT Broker
  └─ dc/telemetria/#
       ↓
  mqtt/subscriptions.ts  ← enrutador + handler principal
       ↓
  [Validator] → [Deduplicator] → [Normalizer]
       ↓
  [repositories/]        ← persiste en PostgreSQL
       ↓
  [rules/rules-engine]   ← evalúa umbrales, actualiza status
       ↓
  [realtime/ws-server]   ← broadcast WebSocket a clientes
       ↓
  [commands/command-dispatcher] ← publica comando MQTT si status crítico
       ↓
  MQTT Broker → dc/control/zona/{Z}/rack/{R}

  rules/offline-monitor  ← proceso paralelo, cada 10 s marca OFFLINE
                           nodos sin telemetría por > 30 s
```

---

## Tópicos MQTT

Ver contratos completos en `docs/SEDCM_CONTEXT.md`.

| Tópico | Publicador | Suscriptor |
|---|---|---|
| `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` | Edge Collector | Backend |
| `dc/telemetria/zona/{Z}/rack/{R}/ambiente` | Edge Collector | Backend |
| `dc/control/zona/{Z}/rack/{R}` | Backend | Edge Executor |
| `dc/ack/zona/{Z}/rack/{R}` | Edge Executor | Backend |
| `dc/actuator/{Z}/{R}` | Edge Executor | Edge Collector |

---

## API REST — Base URL: `http://127.0.0.1:3000`

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor |
| GET | `/api/v1/inventory` | Jerarquía zonas → racks → nodos |
| GET | `/api/v1/nodes` | Lista plana de nodos con status |
| GET | `/api/v1/racks` | Lista plana de racks con status |
| GET | `/api/v1/telemetry/node` | Historial telemetría nodo (`?node_id&zone_code&rack_code&limit`) |
| GET | `/api/v1/telemetry/environment` | Historial telemetría ambiente (`?zone_code&rack_code&limit`) |
| GET | `/api/v1/audit/commands` | Bitácora de comandos (`?zone_code&rack_code&node_id&ack_status&action&limit`) |
| POST | `/api/v1/commands` | Despacho manual de comando |

## WebSocket — `ws://127.0.0.1:3000/ws`

Eventos emitidos por el backend (campo `event`):
`telemetry_node_received` · `telemetry_environment_received` · `node_status_changed` · `rack_status_changed` · `command_published` · `command_ack_received` · `escalation_event`

---

## Agentes de Trabajo

El proyecto tiene 4 agentes especializados en `Aplicacion/.claude/agents/`. Seleccionar el agente correcto antes de ejecutar cualquier tarea.

| Si la tarea involucra... | Usar agente |
|---|---|
| Componentes React, `App.jsx`, WebSocket del frontend, fetch a la API REST, UI, gráficas, LogsPanel | `frontend-agent` |
| Rutas HTTP del backend, motor de reglas, repositorios PostgreSQL, handlers MQTT, `subscriptions.ts`, `rules-engine.ts` | `backend-agent` |
| `docker-compose.yml`, migraciones SQL, Mosquitto, variables de entorno, Dockerfile | `infra-agent` |
| Verificar que algo funciona, diagnosticar un problema, validar contratos entre capas | `qa-agent` |

Tareas que cruzan capas → usar agentes en secuencia: `infra-agent` → `backend-agent` → `frontend-agent`.

| Agente | Archivo |
|---|---|
| `frontend-agent` | `Aplicacion/.claude/agents/frontend-agent.md` |
| `backend-agent` | `Aplicacion/.claude/agents/backend-agent.md` |
| `infra-agent` | `Aplicacion/.claude/agents/infra-agent.md` |
| `qa-agent` | `Aplicacion/.claude/agents/qa-agent.md` |

---

## Archivos Clave de Referencia

| Archivo | Propósito |
|---|---|
| `docs/SEDCM_CONTEXT.md` | Diseño original del sistema (arquitectura, contratos, payloads) |
| `docs/constitution.md` | Principios arquitectónicos no negociables del proyecto |
| `docs/frontend-integration-contract.md` | Contrato REST + WebSocket entre frontend y backend |
| `db/schema.md` | Documentación completa del esquema PostgreSQL |
| `docs/backend/phases/` | 13 fases de desarrollo documentadas con decisiones de diseño |
| `README_DEMO.md` | Guía de arranque con Docker y ejemplos curl |
| `src/config/env.ts` | Todas las variables de entorno configurables |
| `specs/` | Especificaciones de features con decisiones de diseño (Speckit) |
