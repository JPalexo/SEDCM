SEDCMFront — Frontend minimal

Proyecto React + Vite minimal que simula un sistema de monitoreo para un datacenter.

Características:
- Pantalla para seleccionar zonas
- Listado de racks con métricas básicas (estado por color, temp, humedad, potencia)
- Detalle por rack con 3 servidores y métricas detalladas
- Datos generados aleatoriamente cada 2s (simula backend REST futuro)

Instrucciones:

1) Instalar dependencias

```
cd SEDCMFront
npm install
```

2) Iniciar servidor de desarrollo

```
npm run dev
```

El backend REST se integrará en el futuro; ahora los datos son aleatorios en el cliente.
