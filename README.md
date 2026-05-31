# SEDCM — Smart Edge Data Center Manager

Sistema distribuido de monitoreo y control automatizado de infraestructura crítica de datacenter. Procesa telemetría en tiempo real desde nodos edge, evalúa umbrales mediante un motor de reglas autónomo y visualiza el estado en un dashboard React con capacidad de recuperación manual de nodos.

```
Edge Agents (Python — 1 proceso por rack)
       │ MQTT  dc/telemetria/#
       ▼
  Broker Mosquitto
       │ MQTT
       ▼
  Backend (Node.js/TypeScript)
  ├── Motor de reglas  →  MQTT  dc/control/#  →  Edge Agents
  ├── API REST  (puerto 3000)
  └── WebSocket (puerto 3000/ws)
       │
       ▼
  Dashboard (React + Vite — puerto 5173)
```

---

## Requisitos previos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (incluye Docker Compose)
- [Node.js 20+](https://nodejs.org/) y npm (solo para el frontend)
- [Git](https://git-scm.com/)

---

## Levantar el stack completo

### 1 — Backend + Edge Agents + Base de datos (Docker)

```bash
# Clonar el repositorio
git clone https://github.com/JPalexo/SEDCM.git
cd SEDCM

# Entrar al directorio que contiene el docker-compose.yml
cd Aplicacion/Back-End/backend_SEDCM

# Construir e iniciar todos los servicios
docker compose up --build
```

El primer arranque tarda ~2–3 minutos mientras Docker descarga imágenes y compila el backend TypeScript. Las migraciones SQL se aplican automáticamente al iniciar PostgreSQL.

### 2 — Frontend (fuera de Docker)

Abre una segunda terminal:

```bash
cd Aplicacion/Front-End/SEDCMFront
npm install
npm run dev
```

El dashboard queda disponible en **http://localhost:5173**

### Verificar que todo funciona

| Servicio | URL / Puerto |
|---|---|
| Backend — API REST | http://localhost:3000/health |
| Dashboard React | http://localhost:5173 |
| PostgreSQL | localhost:5432 |
| MQTT Broker | localhost:1883 |

### Detener el stack

```bash
# En el directorio Aplicacion/Back-End/backend_SEDCM/
docker compose down
```

---

## Servicios Docker

| Contenedor | Descripción |
|---|---|
| `sedcm-backend` | API REST + WebSocket + motor de reglas (Node.js/TypeScript) |
| `sedcm-postgres` | Base de datos PostgreSQL 16 — migraciones automáticas al iniciar |
| `sedcm-mosquitto` | Broker MQTT Eclipse Mosquitto 2 |
| `sedcm-edge-agent-a1` | Agente Python — Zona A / Rack A1 / Nodo N1 |
| `sedcm-edge-agent-a2` | Agente Python — Zona A / Rack A2 / Nodo N2 |
| `sedcm-edge-agent-b1` | Agente Python — Zona B / Rack B1 / Nodo N3 |
| `sedcm-edge-agent-b2` | Agente Python — Zona B / Rack B2 / Nodo N4 |

Cada agente edge ejecuta `agent.py`: un proceso unificado que publica telemetría (CPU, RAM, Red, Temperatura, Humedad) y ejecuta comandos de control (reinicios, apagados, HVAC, recuperación de nodo) sobre los emuladores Python locales, sin intermediarios MQTT adicionales.

---

## Cómo funciona el sistema

### Telemetría y motor de reglas (automático)

1. Cada agente edge publica métricas cada 5 s en `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` y cada 10 s en `.../ambiente`.
2. El backend valida, deduplica y persiste la telemetría en PostgreSQL.
3. El motor de reglas evalúa umbrales y escala automáticamente:
   - **Warning** → HVAC en modo `cooling`
   - **Crítico** → `soft_reboot` al nodo
   - **Crítico persistente** (sin mejora en 30 s) → `hard_shutdown`
4. Si un nodo deja de enviar telemetría por más de 30 s, el monitor offline lo marca como `OFFLINE`.
5. El dashboard recibe todos los cambios en tiempo real vía WebSocket.

### Recuperación manual de nodo (desde el dashboard)

1. Selecciona una zona → un rack → aparece el detalle de servidores.
2. Cuando un nodo está en estado **APAGADO (OFFLINE)**, aparece el botón **"Recuperar Nodo"**.
3. El botón se habilita únicamente si la **temperatura ambiental del rack es ≤ 42 °C** (seguridad térmica).
4. Al hacer clic, el backend publica `start_node` al agente edge correspondiente vía MQTT. El agente reinicia el emulador a estado base (CPU 15 %, RAM 512 MB) y reanuda la publicación de telemetría.

---

## Estructura del repositorio

```
SEDCM/
├── Aplicacion/
│   ├── Back-End/backend_SEDCM/
│   │   ├── src/                  # Backend TypeScript (reglas, MQTT, REST, WebSocket)
│   │   ├── db/migrations/        # Migraciones SQL (aplicadas automáticamente)
│   │   ├── infra/mosquitto/      # Configuración del broker MQTT
│   │   └── docker-compose.yml    # Orquestación de los 7 servicios
│   ├── Front-End/SEDCMFront/     # Dashboard React + Vite
│   └── edge-agent/
│       ├── agent.py              # Proceso unificado: collector + executor por rack
│       ├── emuladores.py         # NodeEmulator y EnvironmentSimulator (física simulada)
│       ├── Dockerfile
│       └── requirements.txt
├── db/                           # (referencia) esquema y documentación de la BD
├── docs/
│   ├── SEDCM_CONTEXT.md          # Diseño original del sistema
│   ├── constitution.md           # Principios arquitectónicos no negociables
│   ├── arquitectura-tecnica.md   # Documento técnico detallado
│   └── frontend-integration-contract.md
└── CLAUDE.md                     # Guía de desarrollo para Claude Code
```

---

## Tecnologías

| Capa | Stack |
|---|---|
| Backend | Node.js 20, TypeScript, MQTT.js, pg (PostgreSQL) |
| Frontend | React 18, Vite, WebSocket nativo |
| Base de datos | PostgreSQL 16 |
| Mensajería | Eclipse Mosquitto 2 (MQTT v5) |
| Infraestructura | Docker Compose (7 servicios) |
| Edge | Python 3.11, paho-mqtt 2, docker SDK |

---

## Tópicos MQTT

| Tópico | Publicador | Suscriptor |
|---|---|---|
| `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` | Edge Agent | Backend |
| `dc/telemetria/zona/{Z}/rack/{R}/ambiente` | Edge Agent | Backend |
| `dc/control/zona/{Z}/rack/{R}` | Backend | Edge Agent |
| `dc/ack/zona/{Z}/rack/{R}` | Edge Agent | Backend |
