# Contexto del Proyecto: Smart Edge Data Center Manager (SEDCM)

## 1. Resumen Ejecutivo
SEDCM es un sistema distribuido de grado industrial (IoT / Edge Computing) para el monitoreo y control automatizado de infraestructura crítica. Opera procesando reglas en el borde de la red (LAN) para tomar decisiones autónomas en milisegundos ante anomalías térmicas o de recursos.

**Regla de Oro:** El sistema es 100% asíncrono y desacoplado. El Backend y los Nodos de Borde NUNCA se comunican directamente por HTTP; toda la comunicación pasa obligatoriamente por el Broker MQTT.

## 2. Stack Tecnológico y Arquitectura
El sistema se divide en tres capas contenerizadas con Docker:

* **Capa de Borde (Edge - Python):**
    * `emuladores.py`: Scripts que simulan la carga de CPU/RAM y la física del rack (Temp/Humedad).
    * `collector.py`: Publica la telemetría en MQTT.
    * `executor.py`: Escucha comandos MQTT y actúa sobre los contenedores vía Docker API local.
* **Capa Middleware:** Broker MQTT (EMQX o Mosquitto) usando MQTTS (Puerto 1883/8883).
* **Capa Central (Control Plane - Node.js/TypeScript):**
    * Motor de reglas que evalúa la telemetría.
    * Base de datos PostgreSQL para persistencia de inventario, series de tiempo y auditoría.
    * Dashboard web en React conectado vía WebSockets para "Near Real-Time".

## 3. Arquitectura de Tópicos MQTT (Routing)
* **Telemetría de Nodo (Pub: Borde, Sub: Backend):** `dc/telemetria/zona/{Z}/rack/{R}/nodo/{N}`
* **Telemetría Ambiental (Pub: Borde, Sub: Backend):** `dc/telemetria/zona/{Z}/rack/{R}/ambiente`
* **Control y Mitigación (Pub: Backend, Sub: Borde):** `dc/control/zona/{Z}/rack/{R}`
* **Acuse de Recibo ACK (Pub: Borde, Sub: Backend):** `dc/ack/zona/{Z}/rack/{R}`
* **Estado LWT (Pub: Broker/Agente, Sub: Backend):** `dc/estado/zona/{Z}/agente/{A}`

## 4. Contratos de Datos (JSON Payloads)

### Payload de Telemetría (Nodo)
```json
{
  "timestamp": "2026-04-06T13:15:00Z",
  "metadata": {"dc_zone": "A", "dc_rack": "A1", "node_id": "nodo_web_01"},
  "metrics": {
    "cpu_usage_pct": 98.5,
    "ram_usage_mb": 2048.0,
    "net_rx_bytes_sec": 5000,
    "net_tx_bytes_sec": 8500
  }
}