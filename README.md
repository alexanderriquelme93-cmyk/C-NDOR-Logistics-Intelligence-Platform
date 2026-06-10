# Cotizador de Embarque · FLS

Cotizador estático (HTML + CSS + JavaScript puro) para **GitHub Pages**, sin backend. Permite cotizar un envío con **múltiples bultos**, cada uno con su propia vía de transporte, peso y dimensiones, y entrega un costo estimado y un tiempo de tránsito.

## Archivos

- `index.html` — interfaz del cotizador.
- `cotizador.css` — estilos (identidad de marca FLS).
- `cotizador.js` — lógica de cálculo.
- `historico.json` — histórico de operaciones; de aquí salen los costos promedio por vía.
- `sla.json` — tabla de referencia de SLA.

## Cómo funciona

1. **Agregar bulto** crea una fila. Cada bulto tiene: vía de transporte, peso real (kg), dimensiones (L×A×H en cm) o volumen directo (m³), y cantidad.
2. Por cada bulto se calcula el **peso facturable** = mayor entre peso real y peso volumétrico (aéreo 167 kg/m³, marítimo 1000 kg/m³, etc.).
3. El **costo** se estima con el costo promedio histórico de esa vía (por kg y por m³, tomando el mayor como referencia conservadora) × cantidad.
4. El **tránsito del envío** es el SLA más largo entre las vías usadas (el envío no se completa hasta llegar lo más lento).
5. Totales: costo total (CLP y USD si hay tipo de cambio), peso facturable, volumen y número de bultos.

## Publicar en GitHub Pages

1. Sube los archivos al repositorio manteniendo `index.html` en la raíz y los JSON dentro de `data/`.
2. Settings → Pages → Source: rama `main`, carpeta `/root`.
3. Abre `https://<usuario>.github.io/<repo>/`.

Para probar localmente sírvelo por HTTP: `python3 -m http.server 8000`.

## Tipo de cambio USD/CLP

Se obtiene en vivo desde una API pública con CORS (con fuente de respaldo). Si no está disponible, todo se muestra solo en CLP.

## Importante

Las estimaciones son **referenciales**, basadas en promedios históricos. No constituyen una tarifa oficial.

## Conexión a SharePoint (Power Automate)

El cotizador solo necesita `data/historico.json` actualizado: mantener el Excel maestro en SharePoint, usar Power Automate para exportar el JSON y hacer commit al repositorio. GitHub Pages se actualiza solo.
