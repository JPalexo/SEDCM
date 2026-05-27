# SEDCM — Smart Edge Data Center Manager

Sistema distribuido de monitoreo y control automatizado de infraestructura crítica de datacenter. Procesa telemetría en tiempo real desde nodos edge, evalúa umbrales mediante un motor de reglas y visualiza el estado en un dashboard React.

```
Edge Agents (Python)
       │ MQTT
       ▼
  Broker Mosquitto
       │ MQTT
       ▼
  Backend (Node.js/TypeScript)
       │ WebSocket + REST
       ▼
  Dashboard (React + Vite)
```

---

## Requisitos previos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (incluye Docker Compose)
- [Git](https://git-scm.com/)

---

## Levantar el stack completo

```bash
# 1. Clonar el repositorio
git clone https://github.com/<usuario>/SEDCM.git
cd SEDCM

# 2. Entrar al directorio del backend (aquí vive el docker-compose.yml)
cd Aplicacion/Back-End/backend_SEDCM

# 3. Construir e iniciar todos los servicios
docker compose up --build
```

El primer arranque tarda ~2–3 minutos mientras Docker descarga imágenes y compila el backend.

### Verificar que todo funciona

| Servicio | URL |
|---|---|
| Backend API | http://localhost:3000/health |
| Dashboard (frontend) | http://localhost:5173 |
| PostgreSQL | localhost:5432 |
| MQTT Broker | localhost:1883 |

### Detener el stack

```bash
docker compose down
```

---

## Servicios que levanta Docker

| Contenedor | Descripción |
|---|---|
| `sedcm-backend` | API REST + WebSocket + motor de reglas (Node.js/TS) |
| `sedcm-postgres` | Base de datos PostgreSQL 16 |
| `sedcm-mosquitto` | Broker MQTT Eclipse Mosquitto 2 |
| `edge-collector-a1` / `a2` / `b1` / `b2` | Simuladores de telemetría por rack (Node.js) |
| `edge-executor-a1` / `a2` / `b1` / `b2` | Simuladores de ejecución de comandos por rack (Node.js) |

> **Frontend:** El dashboard React corre fuera de Docker. Para levantarlo:
> ```bash
> cd Aplicacion/Front-End/SEDCMFront
> npm install
> npm run dev   # disponible en http://localhost:5173
> ```

---

## Edge Agent Python (opcional)

El directorio `Aplicacion/edge-agent/` contiene los agentes edge reales en Python (no simulados), diseñados para ejecutarse en hardware físico o una VM conectada a la misma red que el broker MQTT.

Ver instrucciones en [Aplicacion/edge-agent/README.md](Aplicacion/edge-agent/README.md).

---

## Estructura del repositorio

```
SEDCM/
├── Aplicacion/
│   ├── Back-End/backend_SEDCM/   # Backend Node.js/TypeScript + Docker Compose
│   ├── Front-End/SEDCMFront/     # Dashboard React + Vite
│   └── edge-agent/               # Agentes edge Python (collector + executor)
├── docs/
│   ├── SEDCM_CONTEXT.md          # Diseño original del sistema
│   └── constitution.md           # Principios arquitectónicos
└── CLAUDE.md                     # Guía de desarrollo para Claude Code
```

---

## Tecnologías

| Capa | Stack |
|---|---|
| Backend | Node.js 20, TypeScript, MQTT.js, pg (PostgreSQL) |
| Frontend | React 18, Vite, WebSocket nativo |
| Base de datos | PostgreSQL 16 |
| Mensajería | Eclipse Mosquitto 2 (MQTT) |
| Infraestructura | Docker Compose |
| Edge (Python) | Python 3.10+, paho-mqtt 2, docker SDK |
