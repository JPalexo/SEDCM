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

---

## 2. Arquitectura General

```
┌─────────────────────────────────────────────────────────┐
│  CAPA EDGE (Python)                                     │
│  collector.py  ──publica telemetría──►                  │
│  executor.py   ◄──recibe comandos──  ──publica ACK──►   │
└────────────────────────┬────────────────────────────────┘
                         │ MQTT (puerto 1883)
┌────────────────────────▼────────────────────────────────┐
│  BROKER MQTT — Eclipse Mosquitto 2                      │
│  Enruta mensajes entre Edge ↔ Backend                   │
└────────────────────────┬────────────────────────────────┘
                         │ MQTT
┌────────────────────────▼────────────────────────────────┐
│  BACKEND — Control Plane (Node.js / TypeScript)         │
│  Ingesta → Validación → Reglas → Comandos → WebSocket   │
│  API REST: http://localhost:3000                        │
│  WebSocket: ws://localhost:3000/ws                      │
└──────────────┬──────────────────────┬───────────────────┘
               │ REST + WebSocket      │
┌──────────────▼──────────────────────▼───────────────────┐
│  FRONTEND — Dashboard React (Vite, puerto 5173)         │
│  Monitoreo en tiempo real del estado del datacenter     │
└─────────────────────────────────────────────────────────┘
```

### Tecnologías por capa

| Capa | Tecnología principal | Puerto |
|---|---|---|
| Edge | Python 3.10+, paho-mqtt 2 | — |
| Broker MQTT | Eclipse Mosquitto 2 | 1883 |
| Backend | Node.js 20, TypeScript, pg (PostgreSQL) | 3000 |
| Base de datos | PostgreSQL 16 | 5432 |
| Frontend | React 18, Vite | 5173 |

---

## 3. Capa Edge — Agente Python

**Directorio:** `Aplicacion/edge-agent/`

El agente edge simula o representa los dispositivos físicos del datacenter. Está compuesto por tres módulos Python independientes.

### 3.1 `emuladores.py` — Simuladores de física

Define las clases que modelan el comportamiento de los dispositivos con inercia y realismo.

**`NodeEmulator`**
- Emula un nodo de cómputo (servidor). Mantiene estado de CPU%, RAM MB y tráfico de red.
- Implementa "fugas de recursos": con 5% de probabilidad en cada ciclo, el nodo comienza a degradarse gradualmente (CPU sube, RAM aumenta).
- Soporta recuperación espontánea (1% de probabilidad) o forzada por el método `soft_reboot()`, que resetea el estado a valores saludables.
- `get_payload()` genera el JSON de telemetría listo para publicar por MQTT.

**`EnvironmentSimulator`**
- Emula el ambiente térmico de un rack. Mantiene temperatura °C y humedad %.
- La temperatura objetivo se calcula en función de la carga CPU promedio del rack (a más carga, más calor).
- Modos HVAC: `off`, `cooling`, `humidify`, `dehumidify`. Cada modo ajusta el destino térmico del simulador.
- `set_hvac_mode(modo)` permite al executor cambiar el modo cuando recibe un comando del backend.

**`build_seeded_rng()`** — Crea un generador de números aleatorios determinístico usando la variable `SIM_SEED` (útil para pruebas reproducibles).

---

### 3.2 `collector.py` — Publicador de telemetría

Es el proceso que corre continuamente publicando métricas al broker MQTT y reaccionando a efectos de actuadores.

**Flujo principal:**
1. Conecta al broker MQTT con credenciales de entorno.
2. Se suscribe a `dc/actuator/zona/{Z}/rack/{R}` para recibir efectos.
3. En cada ciclo publica:
   - Telemetría del nodo en `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` (cada `NODE_INTERVAL_S` segundos)
   - Telemetría ambiental en `dc/telemetria/zona/{Z}/rack/{R}/ambiente` (cada `ENV_INTERVAL_S` segundos)

**Efectos de actuadores (recibidos por `dc/actuator/`):**

| Efecto | Duración | Acción en el simulador |
|---|---|---|
| `cpu_cooldown` | 30 s | Aplica `soft_reboot()` en el nodo |
| `node_shutdown` | 45 s | Silencia la publicación de telemetría del nodo |
| `environment_cooling` | 45 s | Cambia el modo HVAC del simulador |

---

### 3.3 `executor.py` — Ejecutor de comandos

Escucha los comandos que el backend publica y los ejecuta. Luego informa el resultado.

**Flujo por comando recibido:**
1. Recibe mensaje en `dc/control/zona/{Z}/rack/{R}` con payload JSON `{command_id, action, ...}`.
2. Ejecuta la acción:
   - `soft_reboot`: pausa 2 segundos (simula reinicio de software).
   - `hard_shutdown`: apaga el contenedor Docker del nodo si el SDK de Docker está disponible; si no, simula la acción.
   - `set_hvac_mode`: configura el modo HVAC.
3. Publica el efecto correspondiente en `dc/actuator/zona/{Z}/rack/{R}` para que `collector.py` lo procese.
4. Publica el ACK en `dc/ack/zona/{Z}/rack/{R}` con estado `ACKED` o `FAILED`.

---

### 3.4 Variables de entorno (`config.env.example`)

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
| `EXECUTOR_ID` | `executor-{Z}-{R}` | Identificador del ejecutor |
| `ACK_DELAY_S` | `0.5` | Segundos de espera antes de enviar ACK |

---

## 4. Capa Middleware — Broker MQTT

Eclipse Mosquitto 2 actúa como intermediario de mensajes. No tiene lógica de negocio: su único rol es recibir mensajes publicados en un tópico y distribuirlos a todos los suscriptores de ese tópico.

### Tópicos del sistema

| Tópico | Publicador | Suscriptor | Propósito |
|---|---|---|---|
| `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}` | Edge Collector | Backend | Métricas de nodo (CPU, RAM, red) |
| `dc/telemetria/zona/{Z}/rack/{R}/ambiente` | Edge Collector | Backend | Métricas ambientales (temp, humedad) |
| `dc/control/zona/{Z}/rack/{R}` | Backend | Edge Executor | Comandos de mitigación |
| `dc/ack/zona/{Z}/rack/{R}` | Edge Executor | Backend | Confirmación de ejecución (ACK) |
| `dc/actuator/zona/{Z}/rack/{R}` | Edge Executor | Edge Collector | Efectos de actuadores (reinicio, HVAC) |

> **{Z}** = código de zona (ej: `A`, `B`)  
> **{R}** = código de rack (ej: `A1`, `B2`)  
> **{N}** = ID de nodo (ej: `nodo_web_01`)

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
- `OFFLINE_TIMEOUT_MS`: tiempo sin telemetría para declarar nodo offline (default: 30000 ms)
- `ESCALATION_GRACE_MS`: tiempo de espera entre soft_reboot y hard_shutdown (default: 30000 ms)
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

- **Formato nodo:** `dc/telemetria/zona/A/rack/A1/nodo/nodo_web_01` → 8 segmentos
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
- Valida `temperature_c` (−10 a 85 °C) y `humidity_pct` (0–100%).

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

### 5.12 API REST — `bootstrap/http.ts`

Servidor HTTP nativo (sin Express). Expone endpoints de lectura y un endpoint de comando manual.

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
| `command_published` | Comando enviado al broker | `zone_code, rack_code, action, node_id, reason` |
| `command_ack_received` | ACK recibido del edge | `command_id, status, zone_code, rack_code` |
| `escalation_event` | Cambio en proceso de escalación | `stage, zone_code, rack_code, node_id` |

---

### 5.14 Repositorios — `repositories/`

Capa de acceso a datos. Toda interacción con PostgreSQL pasa por aquí.

| Archivo | Responsabilidad |
|---|---|
| `db.ts` | Pool de conexiones PostgreSQL; `withDbClient()` para transacciones |
| `telemetry.repository.ts` | Inserta telemetría en tablas de hechos; hace UPSERT en inventario |
| `command-audit.repository.ts` | Registra comandos; detecta duplicados en ventana de 300 s; actualiza ACKs |
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

### 6.2 `App.jsx` — Componente raíz

Es el cerebro del frontend. Contiene todo el estado global y gestiona las conexiones con el backend.

**Estado principal:**
- `zones`: árbol completo del inventario (zonas → racks → servidores con métricas e historial)
- `selectedZone` / `selectedRack`: navegación actual del usuario
- `hvacModeByRack`: mapa `{rack_id: "cooling"|"humidify"|"dehumidify"|"off"}` actualizado por WebSocket
- `logs`: últimos 200 eventos para el panel de logs
- `wsStatus`: estado de la conexión WebSocket

**Al iniciar la aplicación:**
1. Hace GET `/api/v1/inventory` y construye el árbol de zonas en `buildZonesFromInventory()`.
2. Carga los últimos 50 comandos de `/api/v1/audit/commands` para poblar el log inicial.
3. Abre conexión WebSocket y empieza a recibir eventos en tiempo real.

**Al seleccionar un rack:**
- Hace GET `/api/v1/telemetry/node` y GET `/api/v1/telemetry/environment` para cargar hasta 60 puntos históricos.
- Fusiona esos datos con las métricas actuales de cada servidor.

**Conversiones de métricas (backend → frontend):**

| Campo del backend | Unidad | Campo interno | Conversión |
|---|---|---|---|
| `cpu_usage_pct` | % | `cpu` | Sin conversión |
| `ram_usage_mb` | MB | `ram` | `(MB / 16384) × 100` (asume 16 GB máx) |
| `temperature_c` | °C | `temp` | Sin conversión |
| `humidity_pct` | % | `humidity` | Sin conversión |
| `net_rx + net_tx bytes/s` | bytes/s | `net` | `bytes/s ÷ 125 000` (→ Mbps) |

---

### 6.3 Componentes de presentación

| Componente | Props principales | Propósito |
|---|---|---|
| `ZoneSelector` | `zones, onSelect, selected` | Botones de selección de zona en el sidebar |
| `RackList` | `zone, onSelect` | Grid de cards de racks con estado de color (Normal/Warning/Crítico) |
| `RackDetail` | `rack, onBack` | Vista detallada: grid de servidores + historial expandible |
| `ZoneControls` | `zone, controls, onChange, selectedRack, hvacMode` | Contenedor del panel derecho |
| `HVACControl` | `rack, hvacMode` | Indicador de modo HVAC actual (solo lectura, controlado automáticamente) |
| `ExtractorControl` | `value, simulate` | Indicador visual de uso de extractores |
| `LogsPanel` | `logs` | Lista de eventos con auto-scroll y colores por nivel |
| `LineChart` | `data, metric, width, height` | Gráfica SVG con curva Bézier, área rellena y tooltip |

> **Nota sobre HVACControl:** El sistema activa el HVAC automáticamente según las reglas de temperatura y humedad. El usuario solo puede ver el estado actual — no hay botones de control manual.

---

## 7. Flujo de extremo a extremo

### Escenario A — Telemetría normal

```
1. collector.py publica cada 5 s en dc/telemetria/zona/A/rack/A1/nodo/nodo_web_01
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

4. executor.py recibe el comando, simula reinicio (2 s)
   → Publica en dc/actuator: efecto cpu_cooldown (TTL 30 s)
   → Publica ACK en dc/ack/zona/A/rack/A1 con status=ACKED

5. ack-handler recibe ACK
   → Actualiza audit_command_log (ACKED)
   → WebSocket emite command_ack_received

6. Si en la siguiente telemetría el nodo sigue Crítico
   y han pasado ≥ 30 s desde el soft_reboot:
   → command-dispatcher publica hard_shutdown
   → escalation_event emitido por WebSocket (stage: hard_shutdown_selected)
```

### Escenario C — Temperatura alta y activación de HVAC

```
1. collector.py publica temperatura = 32 °C en dc/telemetria/.../ambiente
2. Backend evalúa: 28 ≤ 32 < 45 → status = "Warning" ambiental
3. command-dispatcher: Temp en Warning → set_hvac_mode cooling
   → Publica en dc/control/zona/A/rack/A1
   → WebSocket emite command_published {action: "set_hvac_mode", mode: "cooling"}

4. App.jsx recibe el evento → hvacModeByRack["A1"] = "cooling"
5. HVACControl.jsx muestra: "Enfriamiento activo" (color azul)

6. executor.py recibe el comando
   → Publica en dc/actuator: efecto environment_cooling (TTL 45 s)
   → collector.py recibe efecto → EnvironmentSimulator cambia modo a "cooling"
   → La temperatura empieza a bajar gradualmente en próximas telemetrías
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
| `telemetry_node` | Serie de tiempo de métricas de nodo (CPU%, RAM MB, red bytes/s). Un registro por evento MQTT. |
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

## 9. Referencia rápida — ¿Dónde está cada cosa?

| Necesito cambiar... | Archivo |
|---|---|
| Umbrales de CPU/RAM | `src/rules/rules-engine.ts` |
| Umbrales de temperatura/humedad | `src/rules/rules-engine.ts` |
| Tiempo de gracia antes de hard_shutdown | `src/config/env.ts` → `ESCALATION_GRACE_MS` |
| Tiempo para declarar nodo OFFLINE | `src/config/env.ts` → `OFFLINE_TIMEOUT_MS` |
| Lógica de escalación de comandos | `src/commands/command-dispatcher.ts` |
| Endpoints de la API REST | `src/bootstrap/http.ts` |
| Eventos WebSocket | `src/realtime/ws-server.ts` |
| Consultas a la base de datos | `src/repositories/query.repository.ts` |
| Comportamiento del simulador de nodo | `Aplicacion/edge-agent/emuladores.py` |
| Estado global del dashboard | `Aplicacion/Front-End/SEDCMFront/src/App.jsx` |
| Estilos y colores del dashboard | `Aplicacion/Front-End/SEDCMFront/src/styles.css` |
| Esquema de la base de datos | `Aplicacion/Back-End/backend_SEDCM/db/schema.md` |
