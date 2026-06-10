# Cotizador de Embarque · FLS

Cotizador estático (HTML + CSS + JavaScript puro) para **GitHub Pages**, sin backend ni carpetas. Cotiza un envío con **múltiples bultos**, cada uno con su propia vía de transporte, peso y dimensiones, entregando un costo estimado y un tiempo de tránsito.

## Archivos (todos en la misma carpeta, sin subcarpetas)

- `index.html` — interfaz del cotizador.
- `cotizador.css` — estilos (identidad de marca FLS).
- `cotizador.js` — lógica de cálculo.
- `historico.json` — histórico de operaciones; de aquí salen los costos promedio por vía.
- `sla.json` — tabla de referencia de SLA.

## Cómo funciona

1. **Agregar bulto** crea una fila. Cada bulto tiene: vía de transporte, peso real (kg), dimensiones (L×A×H en cm) o volumen directo (m³), y cantidad.
2. Por cada bulto se calcula el **peso facturable** = mayor entre peso real y peso volumétrico (aéreo 167 kg/m³, marítimo 1000 kg/m³, etc.).
3. El **costo** se estima con el costo promedio histórico de esa vía (por kg y por m³, tomando el mayor) × cantidad.
4. El **tránsito del envío** es el SLA más largo entre las vías usadas.
5. Totales: costo total (CLP y USD si hay tipo de cambio), peso facturable, volumen y número de bultos.

## Publicar en GitHub Pages

1. Sube **todos los archivos a la raíz** del repositorio (sin carpetas).
2. Settings → Pages → Source: rama `main`, carpeta `/root`.
3. Abre `https://<usuario>.github.io/<repo>/`.

Para probar localmente: `python3 -m http.server 8000`.

## Tipo de cambio USD/CLP

Se obtiene en vivo desde una API pública con CORS (con fuente de respaldo). Si no está disponible, todo se muestra solo en CLP.

## Importante

Las estimaciones son **referenciales**, basadas en promedios históricos. No constituyen una tarifa oficial.
