# SEDCM — Smart Edge Data Center Manager

Sistema distribuido de monitoreo y control automatizado de infraestructura crítica de datacenter. Procesa telemetría en tiempo real desde nodos edge, evalúa umbrales mediante un motor de reglas autónomo y visualiza el estado en un dashboard React con capacidad de recuperación manual de nodos.

```
Edge Agents (Python — 1 proceso por nodo)
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

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (incluye Docker Compose) — para backend, base de datos, MQTT y agentes edge
- [Node.js 20+](https://nodejs.org/) y npm — solo para el frontend (fuera de Docker)
- [Git](https://git-scm.com/)

---

## Levantar el stack desde cero

### Paso 1 — Clonar el repositorio

```bash
git clone https://github.com/JPalexo/SEDCM.git
cd SEDCM
```

### Paso 2 — Crear el archivo `.env` (obligatorio)

El backend y la base de datos leen credenciales desde un archivo `.env` que **no está en el repositorio** (por seguridad). Cópialo desde la plantilla y define una contraseña:

```bash
cd Aplicacion/Back-End/backend_SEDCM
cp .env.example .env
```

Edita `.env` y cambia `cambia_esta_contrasena` por la contraseña que prefieras:

```env
POSTGRES_DB=sedcm_db
POSTGRES_USER=sedcm_admin
POSTGRES_PASSWORD=tu_contrasena_aqui

DATABASE_URL=postgresql://sedcm_admin:tu_contrasena_aqui@localhost:5433/sedcm_db
```

> Sin este archivo, `docker compose up` falla con errores de variable de entorno vacía.

### Paso 3 — Levantar backend, base de datos y agentes edge

Desde `Aplicacion/Back-End/backend_SEDCM/`:

```bash
docker compose up --build
```

El primer arranque tarda 2–3 minutos mientras Docker descarga las imágenes base y compila el backend TypeScript. Las migraciones SQL se aplican automáticamente al iniciar PostgreSQL — no se necesita configuración manual de la base de datos.

### Paso 4 — Levantar el frontend

Abre una segunda terminal desde la raíz del repositorio:

```bash
cd Aplicacion/Front-End/SEDCMFront
npm install
npm run dev
```

El dashboard queda disponible en **http://localhost:5173**

---

## Verificar que todo funciona

| Servicio | URL / Puerto | Qué esperar |
|---|---|---|
| Backend — health check | http://localhost:3000/health | `{"status":"ok"}` |
| Backend — inventario | http://localhost:3000/api/v1/inventory | JSON con zonas, racks y nodos |
| Dashboard React | http://localhost:5173 | Interfaz gráfica del sistema |
| MQTT Broker | `localhost:1883` | Acepta conexiones MQTT |
| PostgreSQL (host) | `localhost:5433` | Acepta conexiones SQL |

Después de ~30 segundos del arranque, el inventario ya debería mostrar los nodos con telemetría en vivo.

---

## Acceder a la base de datos localmente

PostgreSQL está expuesto en el **puerto 5433** del host (no 5432, para evitar conflicto con instalaciones locales de Postgres).

### Con psql (línea de comandos)

```bash
psql -h localhost -p 5433 -U sedcm_admin -d sedcm_db
```

### Con pgAdmin 4

1. Abre pgAdmin → "Add New Server"
2. En la pestaña **Connection**:
   - Host: `localhost`
   - Port: `5433`
   - Database: `sedcm_db`
   - Username: `sedcm_admin`
   - Password: la que pusiste en `.env`
3. Guarda y conecta.

### Con DBeaver / TablePlus / DataGrip

Usa los mismos parámetros: host `localhost`, puerto `5433`, base de datos `sedcm_db`, usuario `sedcm_admin`.

### Consultas útiles de referencia

```sql
-- Ver todos los nodos y su estado actual
SELECT node_id, zone_code, rack_code, health_status, last_seen_at
FROM inventory_node
ORDER BY zone_code, rack_code, node_id;

-- Últimas 20 telemetrías de CPU del nodo N1
SELECT event_time, cpu_usage_pct, ram_usage_mb
FROM telemetry_node
WHERE node_id = 'N1'
ORDER BY event_time DESC
LIMIT 20;

-- Historial de ambiente del rack A1
SELECT event_time, temperature_c, humidity_pct
FROM telemetry_environment
WHERE zone_code = 'A' AND rack_code = 'A1'
ORDER BY event_time DESC
LIMIT 20;

-- Bitácora de comandos emitidos (automáticos y manuales)
SELECT issued_at, zone_code, rack_code, node_id, action, ack_status
FROM audit_command_log
ORDER BY issued_at DESC
LIMIT 20;
```

---

## Qué verás en el dashboard

Al abrir **http://localhost:5173**, el dashboard muestra:

- **Sidebar izquierdo:** lista de zonas activas detectadas automáticamente. Haz clic en una zona para ver sus racks.
- **Grid de racks:** cada card muestra el estado ambiental del rack (Normal / Warning / Crítico) con código de color. Haz clic en un rack para entrar al detalle.
- **Vista detalle de rack:** grilla de servidores con métricas en vivo (CPU %, RAM %, Red Mbps, Temperatura °C, Humedad %). Cada servidor tiene una gráfica histórica expandible de los últimos 60 puntos.
- **Panel de logs (sidebar izquierdo):** flujo en tiempo real de eventos: cambios de estado, comandos publicados, ACKs recibidos y escalaciones.
- **Indicador WebSocket:** badge en la barra superior que muestra `conectado` / `reconectando`. Si el backend se reinicia, el dashboard se reconecta automáticamente en 3 segundos.

### Estados de los nodos

| Color | Estado | Significado |
|---|---|---|
| Verde | Normal | Métricas dentro de rangos seguros |
| Amarillo | Warning | Precaución — se activa HVAC o medidas preventivas |
| Rojo | Crítico | Fuera de rango seguro — se despachan comandos de mitigación |
| Gris | OFFLINE | Sin telemetría por más de 30 s |

---

## Cómo funciona el sistema

### Escalación automática (sin intervención humana)

1. Cada agente edge publica métricas cada **5 s** (nodo) y cada **10 s** (ambiente del rack).
2. El backend valida, deduplica y persiste en PostgreSQL.
3. El motor de reglas evalúa y escala automáticamente:

| Condición | Acción automática |
|---|---|
| CPU/RAM en Warning por 3 ciclos seguidos | Registra estado Warning; activa HVAC `cooling` si aplica |
| CPU ≥ 95 % (Crítico inmediato) | Publica `soft_reboot` al nodo |
| Sin mejora 30 s después del `soft_reboot` | Escala a `hard_shutdown` |
| Temp ≥ 45 °C o Humedad fuera de rango crítico | Publica `hard_shutdown` al rack completo |
| Sin telemetría > 30 s | Monitor offline marca nodo como `OFFLINE` |

4. Todos los cambios llegan al dashboard en tiempo real vía WebSocket.

### Recuperación manual de nodo OFFLINE

1. Selecciona una zona → un rack → aparece la vista de detalle.
2. Cuando un nodo está **OFFLINE**, aparece el botón **"Recuperar Nodo"**.
3. El botón se habilita solo si la **temperatura del rack es ≤ 42 °C** (seguridad térmica).
4. Al hacer clic, el backend publica `start_node` al agente edge vía MQTT. El agente reactiva el emulador (CPU 15 %, RAM base) y reanuda la publicación de telemetría.
5. Si el nodo no responde en **10 segundos**, el dashboard muestra un mensaje de error y libera el botón.

> El agente edge **nunca detiene su proceso ni su contenedor** durante un `hard_shutdown` — solo silencia la telemetría del nodo. Esto garantiza que siempre haya un listener MQTT activo para recibir el `start_node`.

---

## Comandos útiles

```bash
# Ver logs en tiempo real de cada servicio
docker compose logs -f backend
docker compose logs -f sedcm-edge-agent-a1-n1
docker compose logs -f sedcm-postgres

# Detener todo (conserva datos en volumen pgdata)
docker compose down

# Detener y borrar todos los datos de la base de datos
docker compose down -v

# Reconstruir solo el backend (tras cambios en TypeScript)
docker compose up --build backend

# Ver estado de los contenedores
docker compose ps
```

---

## Servicios Docker

Todos levantados desde `Aplicacion/Back-End/backend_SEDCM/` con `docker compose up --build`.

| Contenedor | Descripción |
|---|---|
| `sedcm-postgres` | PostgreSQL 16 — aplica las 6 migraciones SQL automáticamente al arrancar |
| `sedcm-mosquitto` | Eclipse Mosquitto 2 — broker MQTT, escucha en `0.0.0.0:1883` |
| `sedcm-backend` | API REST + WebSocket + motor de reglas (Node.js/TypeScript) |
| `sedcm-edge-agent-a1-n1` | Agente Python — Zona A / Rack A1 / Nodo N1 |
| `sedcm-edge-agent-a1-n2` | Agente Python — Zona A / Rack A1 / Nodo N2 |
| `sedcm-edge-agent-a2-n3` | Agente Python — Zona A / Rack A2 / Nodo N3 |
| `sedcm-edge-agent-a2-n4` | Agente Python — Zona A / Rack A2 / Nodo N4 |

Cada agente ejecuta `agent.py`: un proceso unificado que publica telemetría (CPU, RAM, Red, Temperatura, Humedad) y ejecuta comandos de control (reinicios, apagados, HVAC, recuperación) directamente sobre los emuladores Python en memoria.

---

## Añadir una zona invitada (para compañeros de clase)

Si otro equipo quiere conectar su PC al sistema como una zona adicional:

1. Clonar el repositorio standalone del agente edge:
   ```bash
   git clone https://github.com/JPalexo/sedcm-edge-agent.git
   cd sedcm-edge-agent
   ```

2. Crear un `.env` apuntando al broker MQTT del servidor central:
   ```env
   MQTT_HOST=<IP_LAN_DEL_SERVIDOR>
   MQTT_PORT=1883
   EDGE_ZONE=B
   EDGE_RACK=B1
   ```

3. Levantar los agentes:
   ```bash
   docker compose up --build -d
   ```

Los agentes de la PC invitada aparecerán automáticamente como **Zona B** en el dashboard del servidor central. Para zonas adicionales, usar `EDGE_ZONE=C`, `D`, etc.

> Los NODE_IDs de zonas invitadas usan prefijo de zona (`BN1`, `BN2`, etc.) para evitar colisiones de clave primaria en PostgreSQL.

---

## Estructura del repositorio

```
SEDCM/
├── Aplicacion/
│   ├── Back-End/backend_SEDCM/
│   │   ├── src/                    # Backend TypeScript
│   │   │   ├── ingest/             # Validación, normalización y deduplicación
│   │   │   ├── rules/              # Motor de reglas y monitor offline
│   │   │   ├── commands/           # Despacho de comandos MQTT
│   │   │   ├── repositories/       # Acceso a PostgreSQL
│   │   │   ├── mqtt/               # Suscripciones MQTT y ACK handler
│   │   │   └── realtime/           # Servidor WebSocket
│   │   ├── db/migrations/          # 6 migraciones SQL (aplicadas automáticamente)
│   │   ├── infra/mosquitto/        # Configuración del broker MQTT
│   │   ├── docker-compose.yml      # Orquestación de los 7 servicios
│   │   └── .env.example            # Plantilla de variables de entorno
│   ├── Front-End/SEDCMFront/       # Dashboard React + Vite
│   │   └── src/
│   │       ├── App.jsx             # Estado global + WebSocket + REST
│   │       └── components/         # ZoneSelector, RackList, RackDetail, LogsPanel, LineChart
│   └── edge-agent/                 # Agente Python (Git Submodule → JPalexo/sedcm-edge-agent)
│       ├── agent.py                # Proceso unificado: colector + ejecutor por nodo
│       ├── emuladores.py           # NodeEmulator y EnvironmentSimulator
│       ├── Dockerfile
│       └── requirements.txt
├── docs/
│   ├── arquitectura-tecnica.md     # Documento técnico detallado del sistema
│   ├── SEDCM_CONTEXT.md            # Diseño original y contratos
│   ├── constitution.md             # Principios arquitectónicos no negociables
│   └── frontend-integration-contract.md
└── db/
    └── schema.md                   # Documentación del esquema PostgreSQL
```

---

## Tecnologías

| Capa | Stack |
|---|---|
| Backend | Node.js 20, TypeScript, MQTT.js, pg (PostgreSQL nativo) |
| Frontend | React 18, Vite, WebSocket nativo |
| Base de datos | PostgreSQL 16 |
| Mensajería | Eclipse Mosquitto 2 (MQTT v5) |
| Infraestructura | Docker Compose (7 servicios) |
| Edge | Python 3.11, paho-mqtt 2 |

---

## API REST — Referencia rápida

Base URL: `http://localhost:3000`

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor |
| GET | `/api/v1/inventory` | Jerarquía zonas → racks → nodos con estado actual |
| GET | `/api/v1/nodes` | Lista plana de nodos con `health_status` |
| GET | `/api/v1/racks` | Lista plana de racks con `environment_status` |
| GET | `/api/v1/telemetry/node` | Historial de métricas (`?node_id=N1&zone_code=A&rack_code=A1&limit=60`) |
| GET | `/api/v1/telemetry/environment` | Historial ambiental (`?zone_code=A&rack_code=A1&limit=60`) |
| GET | `/api/v1/audit/commands` | Bitácora de comandos (`?node_id=N1&action=hard_shutdown&limit=20`) |
| POST | `/api/v1/commands` | Despacho manual de comando |

### Ejemplo de comando manual con curl

```bash
curl -X POST http://localhost:3000/api/v1/commands \
  -H "Content-Type: application/json" \
  -d '{
    "zone_code": "A",
    "rack_code": "A1",
    "target_type": "nodo",
    "target_id": "N1",
    "action": "start_node",
    "reason": "recuperacion manual"
  }'
```

---

## Tópicos MQTT

| Tópico | Publicador | Suscriptor |
|---|---|---|
| `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` | Edge Agent | Backend |
| `dc/telemetria/zona/{Z}/rack/{R}/ambiente` | Edge Agent | Backend |
| `dc/control/zona/{Z}/rack/{R}` | Backend | Edge Agent |
| `dc/ack/zona/{Z}/rack/{R}` | Edge Agent | Backend |
