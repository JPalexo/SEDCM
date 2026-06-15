# CLAUDE.md

Este archivo provee orientación a Claude Code (claude.ai/code) al trabajar con el código de este repositorio.

## Descripción del Proyecto y Misión

**SEDCM** (Smart Edge Data Center Manager) es un sistema distribuido de grado industrial (IoT / Edge Computing) para el monitoreo y control automatizado de infraestructura crítica. El sistema procesa la telemetría simulada (CPU, RAM, Red, Temperatura y Humedad) generada en los nodos de borde (Edge Nodes). El "Cerebro" (Motor de Reglas en Node.js) evalúa esta telemetría contra umbrales predefinidos, despacha comandos de mitigación de forma autónoma (ej. reinicios o ajustes de HVAC) y actualiza el estado en tiempo real en un Dashboard React (Near Real-Time).

> **Regla de Oro de la Arquitectura:** El sistema es 100% asíncrono y desacoplado. El Backend y los Nodos de Borde NUNCA se comunican directamente por HTTP; toda la comunicación bidireccional (Telemetría, Control y Acuses de Recibo) pasa obligatoriamente por el Broker MQTT.

> **Autonomía y Control Manual Seguro:** El Motor de Reglas central dispara las mitigaciones (ej. `soft_reboot`, `hard_shutdown`, `set_hvac_mode`) de forma automática al detectar anomalías. Sin embargo, el Dashboard Web (React) provee una interfaz para que el operador emita comandos manuales hacia el borde para recuperar servicios. Específicamente, el sistema cuenta con un botón de **"Recuperar Nodo"** (que envía el comando `start_node`). Toda intervención manual está sujeta a bloqueos de seguridad cruzados: este botón solo se habilitará en la UI si el nodo está en estado `OFFLINE` **y** la temperatura actual de su rack es ≤ 42°C.

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

- **Ubicación:** Directorio `Aplicacion/edge-agent/` (Diseñado como repositorio independiente para despliegue distribuido).
- **Lenguaje:** Estrictamente Python. (Cualquier simulador heredado en Node.js en la capa de borde queda depreciado).
- **`collector.py` (Agente de Ingesta):** Extrae la carga (CPU/RAM) y la termodinámica del rack. Publica constantemente en `dc/telemetria/#`. Utiliza un modelo híbrido determinista (no 100% aleatorio) para forzar estados críticos en la demostración.
    - **Regla Termodinámica (Inercia):** El ciclo de vida del nodo es independiente del rack. Si un contenedor se apaga (`hard_shutdown`), la telemetría del nodo afectado se detiene (o reporta 0), pero la telemetría del `ambiente` (Temperatura/Humedad) DEBE continuar publicándose ininterrumpidamente, simulando un enfriamiento progresivo.
- **`executor.py` (Actuador Directo):** Suscrito a `dc/control/zona/{Z}/rack/{R}`. Traduce comandos estructurados en acciones hacia la simulación o la API local de Docker:
    - `soft_reboot`: Reinicia variables lógicas simuladas a un estado base (15%).
    - `hard_shutdown`: Ejecuta `docker stop` al contenedor real.
    - `start_node`: Ejecuta `docker start` al contenedor y resetea la simulación para que el nodo despierte "sano" (CPU/RAM base).
    - `set_hvac_mode`: Altera la fórmula de enfriamiento ambiental.
    - **Importante:** Las acciones de mitigación se aplican *localmente* en el host. El tópico `dc/actuator/#` no debe utilizarse para bucles internos; tras ejecutar la acción, el executor publica un `ACK` directo al Backend.
    
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
| `docs/arquitectura-tecnica.md` | Arquitectura técnica actual del sistema (estado final) |
| `docs/frontend-integration-contract.md` | Contrato REST + WebSocket entre frontend y backend |
| `db/schema.md` | Documentación completa del esquema PostgreSQL |
| `README_DEMO.md` | Guía de arranque con Docker y ejemplos curl |
| `src/config/env.ts` | Todas las variables de entorno configurables |
