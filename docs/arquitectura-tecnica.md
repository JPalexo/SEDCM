# Arquitectura Técnica — SEDCM

## 1. Introducción

**SEDCM** (Smart Edge Data Center Manager) es un sistema distribuido de monitoreo y control automatizado de infraestructura crítica de datacenter. Su función es:

- Recolectar métricas de nodos de cómputo (CPU, RAM, red) y del ambiente de cada rack (temperatura, humedad) en tiempo real.
- Evaluar esas métricas contra umbrales definidos mediante un motor de reglas.
- Despachar automáticamente comandos de mitigación (reinicio, apagado, control HVAC) cuando se detectan condiciones críticas.
- Mostrar el estado completo del datacenter en un dashboard web en tiempo real.

### Regla de Oro del sistema

> **El Backend y los Nodos de Borde NUNCA se comunican directamente por HTTP. Toda comunicación entre capas pasa obligatoriamente por el Broker MQTT.**

Esta decisión de diseño garantiza desacoplamiento total: si el backend cae, los nodos siguen publicando; si un nodo cae, el backend lo detecta por ausencia de telemetría.

### Autonomía y Control Manual Seguro

El Motor de Reglas dispara mitigaciones automáticas. Adicionalmente, el Dashboard Web provee el botón **"Recuperar Nodo"** para que el operador emita el comando `start_node` manualmente. Este botón está sujeto a **bloqueos de seguridad cruzados de doble capa**:

- **Capa 1 — Frontend (React):** el botón solo se habilita si `health_status === 'OFFLINE'` **Y** la temperatura ambiental del rack es `≤ 42°C` **Y** no hay ya un comando de recuperación en vuelo (`!isRecovering`).
- **Capa 2 — Backend (HTTP 409):** antes de publicar el comando en MQTT, el servidor verifica en PostgreSQL que no exista un `start_node` con estado `PENDING` para ese nodo en los últimos 30 segundos. Si existe, rechaza la petición con HTTP 409 Conflict.

---

## 2. Arquitectura General

```
┌─────────────────────────────────────────────────────────┐
│  CAPA EDGE (Python — agent.py unificado)                │
│  Colector + Ejecutor + Emulación física en un proceso   │
│  ──publica telemetría──►   ◄──recibe comandos──         │
│  ──publica ACK──►                                       │
└────────────────────────┬────────────────────────────────┘
                         │ MQTT (puerto 1883)
┌────────────────────────▼────────────────────────────────┐
│  BROKER MQTT — Eclipse Mosquitto 2                      │
│  Escucha en 0.0.0.0:1883 (accesible desde toda la LAN) │
└────────────────────────┬────────────────────────────────┘
                         │ MQTT
┌────────────────────────▼────────────────────────────────┐
│  BACKEND — Control Plane (Node.js / TypeScript)         │
│  Ingesta → Validación → Reglas → Comandos → WebSocket   │
│  API REST: http://0.0.0.0:3000                          │
│  WebSocket: ws://0.0.0.0:3000/ws                        │
└──────────────┬──────────────────────┬───────────────────┘
               │ REST + WebSocket      │ SQL
        ┌──────▼──────┐        ┌──────▼──────┐
        │  FRONTEND   │        │ PostgreSQL  │
        │  React/Vite │        │  Puerto 5432│
        │  Puerto 5173│        └─────────────┘
        └─────────────┘
```

### Tecnologías por capa

| Capa | Tecnología principal | Puerto |
|---|---|---|
| Edge | Python 3.10+, paho-mqtt 2.x | — |
| Broker MQTT | Eclipse Mosquitto 2 | 1883 |
| Backend | Node.js 20, TypeScript, pg (PostgreSQL) | 3000 |
| Base de datos | PostgreSQL 16 | 5432 |
| Frontend | React 18, Vite | 5173 |

---

## 3. Capa Edge — Agente Python Unificado

**Directorio:** `Aplicacion/edge-agent/` (Git Submodule → `JPalexo/sedcm-edge-agent`)

### 3.1 Transición a microservicio unificado: `agent.py`

La arquitectura inicial separaba la colección de telemetría (`collector.py`) de la ejecución de comandos (`executor.py`), comunicándolos a través de un tópico MQTT interno `dc/actuator/`. Esta separación fue reemplazada por un **proceso unificado `agent.py`** que consolida ambas responsabilidades.

**Ventaja clave:** Los comandos del backend actúan **directamente sobre los objetos de emulación en memoria** (instancias de `NodeEmulator` y `EnvironmentSimulator`), eliminando la latencia del round-trip por MQTT interno y el punto de fallo del tópico `dc/actuator/`.

```
Arquitectura anterior (dos procesos):
  Backend ─MQTT control─► executor.py ─MQTT actuator─► collector.py

Arquitectura actual (proceso unificado):
  Backend ─MQTT control─► agent.py ──── acceso directo a objeto nodo/rack
                                   └──► publica ACK directo al Backend
```

El proceso `agent.py` expone un único loop principal con tres responsabilidades:

| Responsabilidad | Frecuencia | Función |
|---|---|---|
| Publicar telemetría de nodo | Cada `NODE_INTERVAL_S` s (default: 5 s) | `publicar_nodo()` |
| Publicar telemetría ambiental del rack | Cada `ENV_INTERVAL_S` s (default: 10 s) | `publicar_ambiente()` |
| Ejecutar comandos del backend | Reactivo (al recibir mensaje MQTT) | `_ejecutar_comando()` |

Los comandos se procesan en **hilos separados** (`threading.Thread`) para no bloquear el loop MQTT mientras se ejecutan operaciones de Docker o esperas de ACK.

---

### 3.2 `emuladores.py` — Simuladores de física del rack

Importado por `agent.py`. Define las clases que modelan el comportamiento de los dispositivos con inercia y realismo.

**`NodeEmulator`**
- Emula un nodo de cómputo (servidor). Mantiene estado de CPU %, RAM MB y tráfico de red.
- Implementa "fugas de recursos": con 5 % de probabilidad en cada ciclo, el nodo comienza a degradarse (CPU sube, RAM aumenta).
- Soporta recuperación espontánea (1 % de probabilidad) o forzada por `soft_reboot()`, que resetea CPU y RAM a valores saludables (~15 %).
- `get_payload()` genera el JSON de telemetría listo para publicar por MQTT.
- La propiedad `is_leaking` indica si el nodo está en modo de degradación activa (se marca en el log del agente).

**`EnvironmentSimulator`**
- Emula el ambiente térmico de un rack. Mantiene temperatura °C y humedad %.
- La temperatura objetivo se calcula en función de la carga CPU efectiva del rack.
- Modos HVAC: `off`, `cooling`, `humidify`, `dehumidify`. Cada modo desplaza la temperatura/humedad objetivo.
- `set_hvac_mode(modo)` permite al `_ejecutar_comando` cambiar el modo cuando recibe un `set_hvac_mode`.

**`build_seeded_rng()`** — Crea un generador de números aleatorios determinístico usando `SIM_SEED`. Ambas instancias (`nodo` y `rack`) comparten el mismo RNG para comportamiento reproducible.

---

### 3.3 Inercia Térmica — Principio del Ciclo de Vida Independiente

> **Regla de diseño:** El ciclo de vida del nodo de cómputo es independiente del ciclo de vida del rack ambiental.

Cuando un nodo recibe `hard_shutdown`, el proceso ejecuta un **apagado puramente lógico** (ver §3.5 — Patrón BMC):
1. Llama a `nodo.soft_reboot()` — resetea métricas a estado base (CPU 15 %, RAM 512 MB).
2. Marca `_nodo_apagado = True` (bandera protegida por `threading.Lock()`).

El contenedor **no se detiene**. El proceso `agent.py` continúa ejecutándose y escuchando el tópico MQTT de control.

A partir de ese momento:

```python
# publicar_nodo: silenciado cuando _nodo_apagado == True
def publicar_nodo(client):
    if _is_node_shutdown():
        print(f"[SILENCIO] Nodo APAGADO — sin telemetría de {NODO_ID}")
        return           # ← no publica NADA

# publicar_ambiente: SIEMPRE publica, pero con carga CPU = 0
def publicar_ambiente(client):
    carga_cpu = 0.0 if _is_node_shutdown() else nodo.get_payload()["cpu_usage_pct"]
    rack.update_environment(carga_cpu)   # ← temperatura baja gradualmente
    ...
```

El `EnvironmentSimulator` recibe `cpu_efectiva = 0.0`, lo que desplaza su temperatura objetivo hacia abajo, **simulando el enfriamiento progresivo del rack** tras el apagado del servidor. La telemetría ambiental continúa publicándose ininterrumpidamente, lo que permite al Frontend mostrar la curva de descenso de temperatura mientras el nodo está OFFLINE.

**Comportamiento del Frontend ante esta inercia (ver §6.3):** cuando el nodo está OFFLINE, el Frontend recibe los eventos `telemetry_environment_received` y actualiza `temp` y `humidity` en las métricas del nodo (para mostrar la temperatura actual del rack y evaluar el desbloqueo del botón de recuperación), pero **no agrega esos puntos al historial** de la gráfica (evita trazar una línea "fantasma" congelada).

---

### 3.4 Guardia Anti Fan-out — Cláusula de Identidad de Nodo

Todos los agentes de un rack suscriben al **mismo tópico** `dc/control/zona/{Z}/rack/{R}`. Sin filtrado, un comando `hard_shutdown` dirigido a N1 sería ejecutado por N2, N3, etc. del mismo rack.

La solución es una **cláusula de guarda** en `_ejecutar_comando`:

```python
NODE_LEVEL_ACTIONS = {"soft_reboot", "hard_shutdown", "start_node"}

if action in NODE_LEVEL_ACTIONS and target_type == "nodo" and target_id != NODO_ID:
    print(f"[IGNORADO] '{action}' para '{target_id}' — este nodo es '{NODO_ID}'")
    return
```

Solo `set_hvac_mode` omite la guardia, ya que opera sobre el rack completo y debe ejecutarse en todos los agentes del rack.

---

### 3.5 Patrón BMC — Apagado Lógico sin Suicidio de Contenedor

El **Patrón BMC** (Bare-Metal Container) es la solución adoptada para mantener vivo el listener MQTT durante un `hard_shutdown`, garantizando que el comando `start_node` siempre pueda ser recibido.

#### El Problema Original

La implementación inicial de `hard_shutdown` llamaba a `docker stop` sobre el contenedor propio del agente vía la API del Docker SDK:

```python
# ❌ Implementación original — causaba suicidio del contenedor
_docker_stop(MY_CONTAINER_NAME)  # ejecuta "docker stop" sobre sí mismo
```

Esto producía la siguiente secuencia fatal:
1. `agent.py` recibe `hard_shutdown` y llama `docker stop` sobre sí mismo.
2. Docker envía `SIGTERM` al proceso PID 1 del contenedor (el propio `agent.py`).
3. El proceso muere con **Exit Code 137** a mitad de `_ejecutar_comando`.
4. La telemetría ambiental deja de publicarse → ruptura de la inercia térmica.
5. Nadie queda suscrito a `dc/control` para recibir el `start_node` posterior.
6. **Bug "Recuperando… infinito":** el Dashboard mostraba el nodo en estado "Recuperando…" de forma permanente porque el agente no podía escuchar el comando de arranque.

#### La Solución — Apagado Puramente Lógico

`hard_shutdown` y `start_node` son ahora **operaciones completamente lógicas** sobre el estado interno del agente:

```python
# ✅ Patrón BMC — el contenedor nunca se detiene

def _set_node_shutdown(value: bool):
    global _nodo_apagado
    with _shutdown_lock:
        _nodo_apagado = value

# hard_shutdown: silencia telemetría del nodo y resetea métricas
nodo.soft_reboot()            # CPU/RAM vuelven a estado base (15%)
_set_node_shutdown(True)      # publicar_nodo() deja de emitir

# start_node: reactiva el nodo
nodo.soft_reboot()            # CPU/RAM reseteados a estado saludable
_set_node_shutdown(False)     # publicar_nodo() reanuda la emisión
```

El proceso `agent.py` **permanece vivo** durante todo el ciclo de vida del contenedor. No se detiene, no se reinicia y no usa el Docker SDK.

#### Garantías del Patrón

| Propiedad | Garantía |
|---|---|
| Listener MQTT siempre activo | El cliente MQTT no muere nunca: puede recibir `start_node` en cualquier momento |
| Inercia térmica ininterrumpida | `publicar_ambiente()` sigue corriendo con `cpu=0.0` → enfriamiento progresivo visible en el Dashboard |
| Recuperación determinística | `start_node` siempre tiene un receptor → el ciclo OFFLINE → Normal es 100 % confiable |
| Sin dependencia del Docker SDK | La dependencia `docker` fue eliminada de `requirements.txt`; el socket `/var/run/docker.sock` ya no es necesario |

#### Limpieza de Código y Seguridad

Como parte de este fix se eliminaron del repositorio:
- Las funciones `_docker_stop()` y `_docker_start()`.
- La variable `MY_CONTAINER_NAME` y el import del SDK de Docker.
- Los scripts `collector.py` y `executor.py` (scripts standalone legacy que no se ejecutaban en Docker).

El archivo `.env` (con la IP del broker MQTT y configuración de zona) fue asegurado en `.gitignore`, evitando que credenciales de red sean publicadas accidentalmente en el repositorio público. El archivo `.env.example` sirve como plantilla documentada sin valores sensibles.

---

### 3.6 Variables de entorno (`config.env.example`)

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `MQTT_HOST` | `127.0.0.1` | IP del broker MQTT |
| `MQTT_PORT` | `1883` | Puerto del broker |
| `EDGE_ZONE` | `A` | Identificador de zona del rack |
| `EDGE_RACK` | `A1` | Identificador del rack |
| `NODE_ID` | `nodo_web_01` | Identificador del nodo |
| `NODE_INTERVAL_S` | `5` | Segundos entre publicaciones de nodo |
| `ENV_INTERVAL_S` | `10` | Segundos entre publicaciones de ambiente |
| `SIM_SEED` | _(vacío)_ | Semilla RNG para reproducibilidad |
| `EXECUTOR_ID` | `executor-{Z}-{R}` | Identificador del ejecutor (en ACKs) |
| `ACK_DELAY_S` | `0.5` | Segundos de espera antes de enviar ACK |

---

## 4. Capa Middleware — Broker MQTT

Eclipse Mosquitto 2 actúa como intermediario de mensajes. No tiene lógica de negocio: su único rol es recibir mensajes publicados en un tópico y distribuirlos a todos los suscriptores de ese tópico.

Mosquitto está configurado para escuchar en `0.0.0.0:1883`, lo que lo hace accesible desde cualquier PC en la misma red LAN. Esto permite que las zonas invitadas (compañeros de clase con el repositorio standalone) publiquen su telemetría al mismo broker del servidor central.

### Tópicos del sistema

| Tópico | Publicador | Suscriptor | Propósito |
|---|---|---|---|
| `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` | Edge Agent | Backend | Métricas de nodo (CPU, RAM, red) |
| `dc/telemetria/zona/{Z}/rack/{R}/ambiente` | Edge Agent | Backend | Métricas ambientales (temp, humedad) |
| `dc/control/zona/{Z}/rack/{R}` | Backend | Edge Agent | Comandos de mitigación |
| `dc/ack/zona/{Z}/rack/{R}` | Edge Agent | Backend | Confirmación de ejecución (ACK) |

> **{Z}** = código de zona (ej: `A`, `B`)  
> **{R}** = código de rack (ej: `A1`, `B2`)  
> **{N}** = ID de nodo (ej: `N1`, `BN1`)

> **Nota:** El tópico `dc/actuator/` de la arquitectura anterior ha sido eliminado. El agente unificado `agent.py` actúa directamente sobre los objetos de emulación sin necesitar ese canal intermediario.

---

## 5. Capa Backend — Control Plane

**Directorio:** `Aplicacion/Back-End/backend_SEDCM/src/`

Es el núcleo del sistema. Recibe toda la telemetría, aplica las reglas de operación, persiste datos en PostgreSQL, despacha comandos y transmite el estado al frontend en tiempo real.

### 5.1 Punto de entrada — `app.ts`

Archivo que inicia el sistema. Coordina en orden:
1. Carga de configuración (`config/env.ts`)
2. Verificación de conexión a PostgreSQL
3. Inicio del servidor HTTP (`bootstrap/http.ts`)
4. Conexión al broker MQTT (`bootstrap/mqtt.ts`)
5. Activación de suscripciones de telemetría (`mqtt/subscriptions.ts`)
6. Inicio del monitor de nodos offline (`rules/offline-monitor.ts`)
7. Manejo de señales de terminación (SIGINT, SIGTERM) para cierre limpio

---

### 5.2 Configuración — `config/env.ts`

Centraliza todas las variables de entorno con valores por defecto seguros. Define el tipo `AppEnv` con:
- `PORT`: puerto HTTP (default: 3000)
- `MQTT_BROKER_URL`: URL del broker (default: `mqtt://localhost:1883`)
- `OFFLINE_TIMEOUT_MS`: tiempo sin telemetría para declarar nodo offline (default: 30 000 ms)
- `ESCALATION_GRACE_MS`: tiempo de espera entre soft_reboot y hard_shutdown (default: 30 000 ms)
- Variables de conexión PostgreSQL (DATABASE_URL o PGHOST/PGPORT/etc.)

---

### 5.3 Pipeline de ingesta — `mqtt/subscriptions.ts`

Es el módulo más importante del backend. Orquesta el flujo completo desde que llega un mensaje MQTT hasta que se dispara una acción.

**Flujo para cada mensaje de telemetría:**

```
1. Parseo del tópico  → mqtt/topic-parser.ts
2. Validación         → ingest/validators/
3. Normalización      → ingest/normalizers/
4. Deduplicación      → ingest/dedupe/dedupe-key.ts
5. Persistencia       → repositories/telemetry.repository.ts
6. Broadcast WS       → realtime/ws-server.ts
7. Evaluación reglas  → rules/rules-engine.ts
8. Actualizar estado  → applyNodeStatus / applyRackEnvironmentStatus
9. Despachar comando  → commands/command-dispatcher.ts
10. Detectar deadlock → detectDeadlock()
```

---

### 5.4 Parseo de tópicos — `mqtt/topic-parser.ts`

Valida y extrae metadatos de los tópicos MQTT.

- **Formato nodo:** `dc/telemetria/zona/A/rack/A1/nodo/N1` → 8 segmentos
- **Formato ambiente:** `dc/telemetria/zona/A/rack/A1/ambiente` → 7 segmentos
- Rechaza tópicos mal formados con un resultado de error detallado.

---

### 5.5 Validación — `ingest/validators/`

Dos validadores según el tipo de telemetría:

**`node-telemetry.validator.ts`**
- Verifica que el timestamp esté dentro de la ventana ±120 segundos del tiempo actual.
- Valida que `dc_zone`, `dc_rack`, `node_id` no estén vacíos y coincidan con el tópico.
- Valida rangos: `cpu_usage_pct` (0–100), `ram_usage_mb` (≥0), `net_rx/tx_bytes_sec` (≥0).

**`environment-telemetry.validator.ts`**
- Misma lógica de timestamp.
- Valida `temperature_c` (−10 a 85 °C) y `humidity_pct` (0–100 %).

---

### 5.6 Normalización — `ingest/normalizers/`

Transforma la telemetría validada al formato interno del sistema y detecta eventos fuera de orden.

- Si el timestamp del nuevo mensaje es anterior al último recibido para ese nodo/rack, lo marca con `out_of_order: true` en lugar de rechazarlo (se acepta pero queda anotado).

---

### 5.7 Deduplicación — `ingest/dedupe/dedupe-key.ts`

Genera una clave única por mensaje combinando: `topic | zona | rack | nodo | timestamp | SHA256(payload)`.

- Mantiene un Set en memoria de claves ya procesadas.
- Si el mismo mensaje llega duplicado (p. ej. por retry del broker), se descarta silenciosamente.
- El Set se reinicia en cada arranque del backend.

---

### 5.8 Motor de reglas — `rules/rules-engine.ts`

Evalúa las métricas y decide el estado de salud de nodos y racks.

**Umbrales de nodo (evalúa CPU y RAM, toma el máximo):**

| Estado | CPU | RAM |
|---|---|---|
| Normal | < 80 % | < 8 192 MB |
| Warning | 80–94 % | 8 192–12 287 MB |
| Crítico | ≥ 95 % | ≥ 12 288 MB |

> **Regla de 3 ciclos:** El estado Warning solo se activa si las métricas superan el umbral en **3 telemetrías consecutivas**. Un pico aislado no genera alerta. El estado Crítico es inmediato.

**Umbrales de ambiente (rack):**

| Estado | Temperatura | Humedad |
|---|---|---|
| Normal | 0–27 °C | 40–60 % |
| Warning | 28–44 °C | 20–39 % o 61–80 % |
| Crítico | ≥ 45 °C | < 20 % o > 80 % |

**Detección de deadlock (`detectDeadlock`):**  
Si `cpu_usage_pct ≥ 100` Y `net_rx_bytes_sec = 0` Y `net_tx_bytes_sec = 0` al mismo tiempo, se considera que el nodo está bloqueado (proceso colgado, sin tráfico de red). Se despacha `soft_reboot` inmediatamente sin esperar los 3 ciclos.

---

### 5.9 Despacho de comandos — `commands/command-dispatcher.ts`

Genera, publica y audita los comandos de mitigación.

**Lógica de escalación para nodo en estado Crítico:**

```
¿Hay soft_reboot PENDING o ACKED en los últimos 300 s?
   NO  →  Publicar soft_reboot
   SÍ  →  ¿Hay hard_shutdown PENDING?
              SÍ → No hacer nada (ya escalado)
              NO → ¿Han pasado ≥ 30 s desde el soft_reboot?
                       SÍ → Publicar hard_shutdown
                       NO → Esperar (se reevaluará en próxima telemetría)
```

**Comandos de ambiente (rack Warning/Crítico):**

| Condición | Comando despachado |
|---|---|
| Temp ≥ 45 °C o Humedad fuera rango crítico | `hard_shutdown` (todo el rack) |
| Humedad < 40 % | `set_hvac_mode humidify` |
| Humedad > 60 % | `set_hvac_mode dehumidify` |
| Temperatura 28–44 °C | `set_hvac_mode cooling` |

Cada comando se registra en `audit_command_log` con estado `PENDING` y se transmite por WebSocket (`command_published`).

---

### 5.10 Monitor offline — `rules/offline-monitor.ts`

Proceso paralelo que se ejecuta cada 10 segundos (configurable). En cada barrido:
1. Calcula el corte de tiempo: `ahora − 30 segundos`.
2. Marca como `OFFLINE` todos los nodos cuyo `last_seen_at` sea anterior al corte.
3. Hace lo mismo para racks.
4. Transmite los cambios por WebSocket.

Un nodo que recupera telemetría vuelve automáticamente a `Normal` en la siguiente evaluación del motor de reglas.

---

### 5.11 Manejador de ACKs — `mqtt/ack-handler.ts`

Procesa las confirmaciones que llegan por `dc/ack/zona/{Z}/rack/{R}`:
1. Valida el payload JSON (`{command_id, status, timestamp_ack}`).
2. Actualiza el registro en `audit_command_log` con `ack_status = ACKED | FAILED`.
3. Transmite el evento `command_ack_received` por WebSocket al dashboard.

---

### 5.12 API REST y Protección Anti-Spam — `bootstrap/http.ts`

Servidor HTTP **nativo de Node.js** (sin Express ni frameworks externos). Expone endpoints de lectura y un endpoint de comando manual con validación de doble capa.

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor |
| GET | `/api/v1/inventory` | Jerarquía zonas → racks → nodos con estado actual |
| GET | `/api/v1/nodes` | Lista plana de nodos con `health_status` |
| GET | `/api/v1/racks` | Lista plana de racks con `environment_status` |
| GET | `/api/v1/telemetry/node` | Historial de métricas de nodo (`?node_id&zone_code&rack_code&limit`) |
| GET | `/api/v1/telemetry/environment` | Historial ambiental de rack (`?zone_code&rack_code&limit`) |
| GET | `/api/v1/audit/commands` | Bitácora de comandos (`?zone_code&rack_code&node_id&action&limit`) |
| POST | `/api/v1/commands` | Despacho manual de comando |

#### Flujo de validación en `POST /api/v1/commands`

```
Petición POST llega con JSON body
         ↓
1. readJsonBody()        — parseo del body crudo
         ↓
2. validateManualCommandBody()  — validación semántica:
   • zone_code, rack_code, target_type, target_id, action, reason: requeridos
   • target_type ∈ {"nodo", "rack"}
   • action ∈ {"soft_reboot", "hard_shutdown", "set_hvac_mode", "start_node"}
   • soft_reboot y start_node requieren target_type="nodo"
   • set_hvac_mode requiere target_type="rack" y campo mode presente
         ↓ (si falla → HTTP 400)
3. ¿MQTT client disponible?
         ↓ (si no → HTTP 503)
4. ¿action === "start_node"?
   → hasRecentNodeCommandByStatuses({ statuses: ["PENDING"], windowSeconds: 30 })
   → Consulta PostgreSQL: ¿existe start_node PENDING para este node_id en últimos 30 s?
         ↓ (si existe → HTTP 409 Conflict "command_already_pending")
5. dispatchManualCommand()  — publica en MQTT + registra en audit_command_log
         ↓
   → HTTP 202 Accepted { command_id, action, mqtt_topic, ack_status: "PENDING" }
```

La protección del paso 4 usa la función `hasRecentNodeCommandByStatuses` del repositorio de auditoría, que ejecuta la siguiente consulta SQL:

```sql
SELECT EXISTS (
  SELECT 1
  FROM audit_command_log
  WHERE node_id = $1
    AND target_type = 'nodo'
    AND action = $2
    AND ack_status = ANY($3::text[])
    AND issued_at >= now() - make_interval(secs => $4)
) AS exists
```

La lista de `statuses` es parametrizable (`ANY($3::text[])`), lo que permite al motor de reglas reutilizar esta función con diferentes combinaciones de estado (por ejemplo, la lógica de escalación verifica `["PENDING", "ACKED"]`).

---

### 5.13 WebSocket — `realtime/ws-server.ts`

Mantiene conexiones WebSocket con el frontend en `ws://localhost:3000/ws`. Cuando ocurre cualquier evento relevante, hace broadcast a todos los clientes conectados.

**Eventos emitidos:**

| Evento | Cuándo se emite | Datos clave |
|---|---|---|
| `telemetry_node_received` | Telemetría de nodo ingresada | `zone_code, rack_code, node_id, metrics` |
| `telemetry_environment_received` | Telemetría ambiental ingresada | `zone_code, rack_code, environment` |
| `node_status_changed` | Estado de nodo cambia | `zone_code, rack_code, node_id, new_status` |
| `rack_status_changed` | Estado de rack cambia | `zone_code, rack_code, new_status` |
| `command_published` | Comando enviado al broker | `zone_code, rack_code, action, node_id, reason, mode` |
| `command_ack_received` | ACK recibido del edge | `command_id, status, zone_code, rack_code` |
| `escalation_event` | Cambio en proceso de escalación | `stage, zone_code, rack_code, node_id` |

---

### 5.14 Repositorios — `repositories/`

Capa de acceso a datos. Toda interacción con PostgreSQL pasa por aquí.

| Archivo | Responsabilidad |
|---|---|
| `db.ts` | Pool de conexiones PostgreSQL; `withDbClient()` para transacciones |
| `telemetry.repository.ts` | Inserta telemetría en tablas de hechos; hace UPSERT en inventario |
| `command-audit.repository.ts` | Registra comandos; detecta duplicados en ventana de 30–300 s; actualiza ACKs |
| `query.repository.ts` | Consultas de lectura para la API REST (inventario, historial, bitácora) |

---

## 6. Capa Frontend — Dashboard React

**Directorio:** `Aplicacion/Front-End/SEDCMFront/src/`

### 6.1 Árbol de componentes

```
App.jsx  (estado global + WebSocket + REST)
├── ZoneSelector.jsx    (sidebar: lista de zonas)
├── LogsPanel.jsx       (sidebar: log de eventos en tiempo real)
├── RackList.jsx        (grid de cards de racks)  — o bien:
├── RackDetail.jsx      (vista detallada de un rack)
│   └── LineChart.jsx   (gráfica SVG de historial de métrica)
└── ZoneControls.jsx    (panel derecho de controles)
    ├── HVACControl.jsx     (indicador de modo HVAC — solo lectura)
    └── ExtractorControl.jsx (indicador visual de extractores)
```

---

### 6.2 `App.jsx` — Componente raíz y estado global

Es el cerebro del frontend. Contiene todo el estado global y gestiona las conexiones con el backend.

**Estado principal:**
- `zones`: árbol completo del inventario (zonas → racks → servidores con métricas e historial)
- `selectedZone` / `selectedRack`: navegación actual del usuario
- `hvacModeByRack`: mapa `{rack_id: "cooling"|"humidify"|"dehumidify"|"off"}` actualizado por WebSocket
- `logs`: últimos 200 eventos para el panel de logs
- `wsStatus`: estado de la conexión WebSocket (`"conectando"` | `"conectado"` | `"reconectando"` | `"error"`)
- `recoveringNodes`: Set de IDs de nodos con un comando `start_node` en vuelo (ver §6.3)

**Al iniciar la aplicación:**
1. Hace GET `/api/v1/inventory` y construye el árbol de zonas en `buildZonesFromInventory()`.
2. Abre conexión WebSocket y empieza a recibir eventos en tiempo real.
3. Al conectar el WebSocket, carga los últimos 50 comandos de `/api/v1/audit/commands` para poblar el log inicial.

**Al seleccionar un rack:**
- Hace GET `/api/v1/telemetry/node` y GET `/api/v1/telemetry/environment` en paralelo (hasta 60 puntos históricos).
- Combina el historial de nodo con el ambiental más cercano por timestamp y fusiona con los puntos ya en vivo del WebSocket, sin duplicar.

**Conversiones de métricas (backend → frontend):**

| Campo del backend | Unidad | Campo interno | Conversión |
|---|---|---|---|
| `cpu_usage_pct` | % | `cpu` | Sin conversión |
| `ram_usage_mb` | MB | `ram` | `(MB / 16384) × 100` (asume 16 GB máx) |
| `temperature_c` | °C | `temp` | Sin conversión |
| `humidity_pct` | % | `humidity` | Sin conversión |
| `net_rx + net_tx bytes/s` | bytes/s | `net` | `bytes/s ÷ 125 000` (→ Mbps) |

**Comportamiento especial de nodos OFFLINE:**

Cuando llega `node_status_changed` con `new_status === "OFFLINE"`:
1. Los campos `cpu`, `ram`, `net` se zerean en las métricas actuales.
2. Se agrega un punto final al historial con esos valores en cero, para que la gráfica muestre la caída antes de detenerse.

Cuando llega `telemetry_environment_received` y el nodo está OFFLINE:
- Se actualizan `temp` y `humidity` en las métricas actuales (para el criterio del botón de recuperación y el indicador de HVAC).
- **No** se agrega el punto al historial (evita trazar una línea "fantasma" mientras el nodo está apagado).

---

### 6.3 Estado Transaccional — `recoveringNodes` y el Botón de Recuperación

El botón **"Recuperar Nodo"** implementa un **patrón de actualización optimista** para evitar doble clic y dar retroalimentación visual inmediata al operador.

**Flujo completo:**

```
Operador hace clic en "Recuperar Nodo"
         ↓
sendCommand({ action: "start_node", target_id: server.id, … })
         ↓ fetch POST /api/v1/commands
         ↓
¿Respuesta OK (202)?
   SÍ → setRecoveringNodes(prev => new Set([...prev, target_id]))
         Botón cambia a "Recuperando…" (disabled)
   NO → pushLog({ level: "warn", text: "Error al despachar…" })
         Botón permanece habilitado

         ↑ (mientras tanto, en el backend: agent.py ejecuta start_node,
            reanuda publicación de telemetría, el nodo sale de OFFLINE)

Llega evento WebSocket: node_status_changed { new_status: "Normal" }
         ↓
if (data.new_status !== "OFFLINE"):
   setRecoveringNodes(prev → prev.delete(data.node_id))
         Botón desaparece (el nodo ya no está OFFLINE)
```

**Condiciones para que el botón "Recuperar Nodo" esté habilitado:**

```javascript
// En RackDetail.jsx
const canRecover = isOffline && rackAmbientTemp <= 42 && !isRecovering
```

| Condición | Descripción |
|---|---|
| `isOffline` | `health_status === "OFFLINE"` |
| `rackAmbientTemp <= 42` | Temperatura promedio del rack ≤ 42 °C (evita reiniciar un servidor en un rack caliente) |
| `!isRecovering` | No hay un `start_node` en vuelo para este nodo |

La **temperatura del rack** se calcula como el promedio de `metrics.temp` de todos los nodos del rack (todos comparten la misma fuente ambiental publicada por `publicar_ambiente()` del agente). Esto es correcto porque la telemetría ambiental continúa llegando incluso con el nodo OFFLINE, gracias a la inercia térmica del agente.

**Texto del tooltip del botón:**
- `isRecovering`: `"Comando de recuperación en progreso — esperando confirmación del nodo"`
- `canRecover` (no recovering): `"Enviar comando start_node al nodo"`
- `!canRecover && !isRecovering`: `"Rack a XX.X°C — espera enfriamiento (≤ 42°C)"`

---

### 6.4 Componentes de presentación

| Componente | Props principales | Propósito |
|---|---|---|
| `ZoneSelector` | `zones, onSelect, selected` | Botones de selección de zona en el sidebar |
| `RackList` | `zone, onSelect` | Grid de cards de racks con estado de color (Normal/Warning/Crítico) |
| `RackDetail` | `rack, onBack, onCommand, recoveringNodes` | Vista detallada: grid de servidores + historial expandible + botón de recuperación |
| `ZoneControls` | `zone, controls, onChange, selectedRack, hvacMode` | Contenedor del panel derecho |
| `HVACControl` | `rack, hvacMode` | Indicador de modo HVAC actual (solo lectura, controlado automáticamente por el Motor de Reglas) |
| `ExtractorControl` | `value, simulate` | Indicador visual de uso de extractores |
| `LogsPanel` | `logs` | Lista de eventos con auto-scroll y colores por nivel |
| `LineChart` | `data, metric, width, height` | Gráfica SVG con curva Bézier, área rellena y tooltip |

> **Nota sobre HVACControl:** El HVAC se activa **automáticamente** según las reglas del Motor de Reglas del backend. El componente es un indicador de solo lectura. No hay botones de control manual de HVAC.

---

## 7. Flujo de extremo a extremo

### Escenario A — Telemetría normal

```
1. agent.py publica cada 5 s en dc/telemetria/zona/A/rack/A1/nodo/N1
2. Backend recibe → valida → normaliza → deduplica → persiste en PostgreSQL
3. broadcastRealtimeEvent("telemetry_node_received", {...métricas})
4. App.jsx recibe por WebSocket → actualiza metrics del servidor en el estado
5. RackDetail / LineChart se re-renderizan con los nuevos valores
```

### Escenario B — CPU crítica y escalación a hard_shutdown

```
1. CPU del nodo sube a 96 % en 3 telemetrías consecutivas
   → 1er ciclo: contador = 1, status = "Normal" (todavía)
   → 2do ciclo: contador = 2, status = "Normal"
   → 3er ciclo: contador = 3, status sube a "Warning"

2. CPU llega a 97 % (≥ 95 %) → status = "Crítico" de inmediato

3. command-dispatcher verifica: no hay soft_reboot reciente
   → Publica soft_reboot en dc/control/zona/A/rack/A1
   → Registra en audit_command_log (PENDING)
   → WebSocket emite command_published

4. agent.py recibe el comando en _ejecutar_comando
   → Guardia: target_id coincide con NODO_ID → se ejecuta
   → nodo.soft_reboot() resetea CPU/RAM a estado base directamente en objeto
   → Publica ACK en dc/ack/zona/A/rack/A1 con status=ACKED

5. ack-handler recibe ACK
   → Actualiza audit_command_log (ACKED)
   → WebSocket emite command_ack_received

6. Si en la siguiente telemetría el nodo sigue Crítico
   y han pasado ≥ 30 s desde el soft_reboot:
   → command-dispatcher publica hard_shutdown
   → escalation_event emitido por WebSocket (stage: hard_shutdown_selected)

7. agent.py recibe hard_shutdown (Patrón BMC — ver §3.5)
   → Guardia: target_id == NODO_ID → se ejecuta
   → nodo.soft_reboot() — resetea CPU/RAM a estado base
   → _set_node_shutdown(True) — telemetría de nodo silenciada
   → El contenedor sigue vivo; publicar_ambiente() continúa con carga_cpu=0.0 (inercia térmica)
   → Publica ACK status=ACKED en dc/ack/zona/A/rack/A1
```

### Escenario C — Temperatura alta y activación de HVAC

```
1. agent.py publica temperatura = 32 °C en dc/telemetria/.../ambiente
2. Backend evalúa: 28 ≤ 32 < 45 → status = "Warning" ambiental
3. command-dispatcher: Temp en Warning → set_hvac_mode cooling
   → Publica en dc/control/zona/A/rack/A1
   → WebSocket emite command_published {action: "set_hvac_mode", mode: "cooling"}

4. App.jsx recibe el evento → hvacModeByRack["A-A1"] = "cooling"
5. HVACControl.jsx muestra: "Enfriamiento activo" (color azul)

6. agent.py recibe el comando en _ejecutar_comando
   → set_hvac_mode NO pasa por la guardia de node_id (es una acción de rack)
   → rack.set_hvac_mode("cooling") actúa directamente sobre el objeto
   → La temperatura empieza a bajar gradualmente en próximas telemetrías
   → Publica ACK en dc/ack con status=ACKED
```

### Escenario D — Recuperación manual de nodo OFFLINE

```
1. Nodo en estado OFFLINE (sin telemetría > 30 s)
   Temperatura del rack = 35 °C (≤ 42 °C)
   → Botón "Recuperar Nodo" habilitado en el Dashboard

2. Operador hace clic
   → Frontend envía POST /api/v1/commands { action: "start_node", target_id: "N1", … }
   → Frontend agrega "N1" a recoveringNodes → botón cambia a "Recuperando…"

3. http.ts recibe la petición
   → validateManualCommandBody: OK
   → hasRecentNodeCommandByStatuses(node_id="N1", action="start_node",
       statuses=["PENDING"], windowSeconds=30) → false (no hay duplicado)
   → dispatchManualCommand: publica en dc/control/zona/A/rack/A1
   → Registra start_node PENDING en audit_command_log
   → Responde HTTP 202 { command_id, action, mqtt_topic, ack_status: "PENDING" }

4. Si el operador vuelve a hacer clic antes de 30 s:
   → http.ts consulta PostgreSQL → start_node PENDING encontrado
   → Responde HTTP 409 { error: "command_already_pending", detail: "…" }
   → Frontend registra aviso en el LogsPanel (no duplica el comando)

5. agent.py recibe start_node en dc/control/zona/A/rack/A1 (Patrón BMC — ver §3.5)
   → Guardia: target_id=="N1" == NODO_ID → se ejecuta
   → nodo.soft_reboot() → CPU/RAM reseteados a ~15 %
   → _set_node_shutdown(False) → publicar_nodo() reanuda
   → Publica ACK status=ACKED en dc/ack
   (El contenedor nunca fue detenido; no se necesita docker start)

6. Backend recibe ACK → actualiza audit_command_log (ACKED)
   → WebSocket emite command_ack_received

7. El nodo comienza a publicar telemetría
   → offline-monitor detecta last_seen_at actualizado → health_status = "Normal"
   → WebSocket emite node_status_changed { new_status: "Normal" }

8. Frontend recibe node_status_changed:
   → setRecoveringNodes → elimina "N1" del Set
   → health_status del nodo actualizado en el árbol de zonas
   → Botón "Recuperar Nodo" desaparece (el nodo ya no es OFFLINE)
```

---

## 8. Base de Datos PostgreSQL

**Migraciones:** `Aplicacion/Back-End/backend_SEDCM/db/migrations/`

### Tablas principales

| Tabla | Propósito |
|---|---|
| `inventory_zone` | Catálogo de zonas. Se crea automáticamente al recibir la primera telemetría de una zona. |
| `inventory_rack` | Racks por zona. Incluye `environment_status` (Normal/Warning/Crítico/OFFLINE) y `last_seen_at`. |
| `inventory_node` | Nodos por rack. Incluye `health_status` y `last_seen_at`. Se mueve a otro rack si cambia de ubicación. |
| `inventory_node_location_history` | Historial de reubicaciones de un nodo entre racks. |
| `telemetry_node` | Serie de tiempo de métricas de nodo (CPU %, RAM MB, red bytes/s). Un registro por evento MQTT. |
| `telemetry_environment` | Serie de tiempo de ambiente por rack (temp °C, humedad %). |
| `audit_command_log` | Registro de todos los comandos emitidos (manuales y automáticos), su payload MQTT y el resultado del ACK. |

### Estados posibles

| Estado | Significado |
|---|---|
| `Normal` | Métricas dentro de rangos esperados |
| `Warning` | Métricas en zona de precaución; se aplican medidas preventivas |
| `Critico` | Métricas fuera de rango seguro; se disparan acciones de mitigación |
| `OFFLINE` | Sin telemetría durante más de 30 segundos |

---

## 9. Topología Distribuida LAN y Retos de Concurrencia Superados

### 9.1 Topología final

El sistema opera en red LAN con dos tipos de nodos:

**Servidor Central (PC de Alejandro)**

Levanta 7 servicios con `docker compose up --build` desde `Aplicacion/Back-End/backend_SEDCM/`:

| Servicio | Descripción |
|---|---|
| `sedcm-postgres` | PostgreSQL 16 |
| `sedcm-mosquitto` | Eclipse Mosquitto 2, escucha en `0.0.0.0:1883` |
| `sedcm-backend` | Node.js/TypeScript, expuesto en `0.0.0.0:3000` |
| `sedcm-edge-agent-a1-n1` | Zona A, Rack A1, Nodo N1 |
| `sedcm-edge-agent-a1-n2` | Zona A, Rack A1, Nodo N2 |
| `sedcm-edge-agent-a2-n3` | Zona A, Rack A2, Nodo N3 |
| `sedcm-edge-agent-a2-n4` | Zona A, Rack A2, Nodo N4 |

**PC Invitada (compañeros de clase)**

Clonan el repositorio standalone `JPalexo/sedcm-edge-agent`, crean un `.env` con `MQTT_HOST=<IP_LAN>` y `EDGE_ZONE=B` (o C, D…) y ejecutan `docker compose up --build -d`. Esto levanta 4 contenedores que aparecen como una nueva zona en el dashboard.

`Aplicacion/edge-agent/` en el monorepo es un **Git Submodule** que apunta a `JPalexo/sedcm-edge-agent`. Esto permite al repositorio del monorepo referenciar una versión específica del agente sin copiar su código, y a los compañeros clonar el repositorio del agente de forma independiente para sus PCs invitadas.

---

### 9.2 Reto 1 — Fan-out sin filtrado en MQTT

**Síntoma:** Con 2 nodos por rack, un `hard_shutdown` para N1 también silenciaba a N2. Ambos nodos del rack aparecían OFFLINE y el rack completo mostraba `0.0°C` ("nodo fantasma").

**Causa raíz:** Todos los agentes de un rack suscriben al mismo tópico de control `dc/control/zona/{Z}/rack/{R}`. El `_ejecutar_comando` original no verificaba si el comando era para su propio `NODO_ID`, ejecutando `_set_node_shutdown(True)` en todos los nodos del rack. Además, `_docker_stop` usaba el `node_id` crudo (ej. `"N1"`) como nombre de contenedor Docker, pero el nombre real es `"sedcm-edge-agent-a1-n1"`, causando fallos silenciosos.

**Fix implementado en `agent.py` (en dos commits — `ffd7ac3` + `dc9f5ef`):**

```python
# Guardia en _ejecutar_comando: ignorar comandos de nodo dirigidos a otro nodo
NODE_LEVEL_ACTIONS = {"soft_reboot", "hard_shutdown", "start_node"}
if action in NODE_LEVEL_ACTIONS and target_type == "nodo" and target_id != NODO_ID:
    print(f"[IGNORADO] '{action}' para '{target_id}' — este nodo es '{NODO_ID}'")
    return
```

> El fix original también incluía `MY_CONTAINER_NAME` y llamadas al Docker SDK. Esas partes fueron eliminadas en el fix **Patrón BMC** (ver §3.5): `hard_shutdown` y `start_node` son ahora lógicos y no necesitan conocer el nombre del contenedor.

**Resultado:** Cada agente solo ejecuta los comandos que le corresponden. `set_hvac_mode` no requiere guardia porque opera sobre el rack completo y debe ejecutarse en todos los agentes del rack.

---

### 9.3 Reto 2 — Colisión de Clave Primaria en PostgreSQL

**Síntoma:** Al conectar una Zona B con NODE_IDs `N1-N4`, los racks de Zona B aparecían vacíos y los de Zona A perdían sus nodos intermitentemente.

**Causa raíz:** El repositorio de telemetría usaba `ON CONFLICT (node_id)` con `node_id` como única clave (sin incluir zona ni rack). Cuando Zona B publicaba telemetría con `node_id=N1`, el `ON CONFLICT` actualizaba la fila existente de Zona A, reasignando N1 de la Zona A a la Zona B. Las dos zonas se "robaban" los nodos ciclo a ciclo en una carrera de escrituras.

**Fix en `edge-agent/docker-compose.yml`:** Los NODE_IDs del compose standalone llevan **prefijo de zona**:

```yaml
NODE_ID: ${EDGE_ZONE:-B}N1   # → BN1 con EDGE_ZONE=B, CN1 con EDGE_ZONE=C
```

La Zona A (servidor central) conserva N1–N4. Cada zona invitada usa IDs únicos globalmente (BN1–BN4, CN1–CN4, etc.), eliminando la colisión en la clave única de PostgreSQL.

---

### 9.4 Convención de nombres

| Ubicación | Patrón `container_name` | Patrón `NODE_ID` | Ejemplo |
|---|---|---|---|
| Servidor Central (Zona A) | `sedcm-edge-agent-{rack}-{nodo}` | `N{n}` | `sedcm-edge-agent-a1-n1` / `N1` |
| PC Invitada | `sedcm-edge-{ZONE}{rack_num}-n{n}` | `{ZONE}N{n}` | `sedcm-edge-B1-n1` / `BN1` |

---

## 10. Referencia rápida — ¿Dónde está cada cosa?

| Necesito cambiar... | Archivo |
|---|---|
| Umbrales de CPU/RAM | `src/rules/rules-engine.ts` |
| Umbrales de temperatura/humedad | `src/rules/rules-engine.ts` |
| Tiempo de gracia antes de hard_shutdown | `src/config/env.ts` → `ESCALATION_GRACE_MS` |
| Tiempo para declarar nodo OFFLINE | `src/config/env.ts` → `OFFLINE_TIMEOUT_MS` |
| Lógica de escalación de comandos | `src/commands/command-dispatcher.ts` |
| Ventana de anti-spam del botón de recuperación | `src/bootstrap/http.ts` → `windowSeconds: 30` |
| Umbral de temperatura para habilitar recuperación | `Aplicacion/Front-End/SEDCMFront/src/components/RackDetail.jsx` → `rackAmbientTemp <= 42` |
| Endpoints de la API REST | `src/bootstrap/http.ts` |
| Eventos WebSocket | `src/realtime/ws-server.ts` |
| Consultas a la base de datos | `src/repositories/query.repository.ts` |
| Comportamiento del simulador de nodo/rack | `Aplicacion/edge-agent/emuladores.py` |
| Lógica del agente Edge (colector + ejecutor) | `Aplicacion/edge-agent/agent.py` |
| Estado global del dashboard | `Aplicacion/Front-End/SEDCMFront/src/App.jsx` |
| Estilos y colores del dashboard | `Aplicacion/Front-End/SEDCMFront/src/styles.css` |
| Esquema de la base de datos | `Aplicacion/Back-End/backend_SEDCM/db/schema.md` |
| Convención de nombres de contenedores (LAN) | `Aplicacion/edge-agent/docker-compose.yml` |
