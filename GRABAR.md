# 🎙️ Grabar y resumir

Pantalla **Grabar** del Centro de Enseñanza: graba una prédica o reunión, la transcribe en vivo, separa las voces y genera el resumen con Claude (enseñanza, versículos, mapa mental, o decisiones y tareas si es una reunión).

## Cómo funciona

1. **Micrófono:** se puede elegir cualquier entrada de audio del equipo (USB, micrófono 360 de conferencia, interfaz de la consola, etc.). Con micrófonos de conferencia conviene dejar apagado el procesamiento del navegador porque ya traen el suyo.
2. **En vivo:** el audio se manda a ElevenLabs **Scribe v2 Realtime** (WebSocket) y aparece el texto mientras se habla. Tocar un nombre marca quién está hablando. Este modo no separa voces por sí solo.
3. **Al detener:** la grabación completa se manda a ElevenLabs **Scribe v2** (por lotes) con `diarize=true`, que separa las voces. Las marcas en vivo se usan para sugerir el nombre de cada voz; se pueden corregir escuchando una muestra.
4. **Resumen:** `/api/summarize` manda la transcripción con nombres a Claude y devuelve el JSON del resumen y el mapa mental (Markmap).
5. **Guardar:** la transcripción y el resumen se guardan en el navegador (`localStorage`) y, si es prédica, también en el registro de Prédicas. El audio no se guarda en la app: se descarga con el botón **Descargar audio**.

También se puede subir un audio ya grabado (botón **Subir un audio grabado**).

La API key nunca llega al navegador: `/api/scribe-token` genera tokens de un solo uso (15 min) y el navegador habla directo con ElevenLabs. Así se evita el límite de 4.5 MB de las funciones de Vercel.

## Variables de entorno en Vercel

| Variable | Obligatoria | Para qué |
|---|---|---|
| `ELEVENLABS_API_KEY` | Sí | Transcripción (en vivo y por lotes) |
| `ANTHROPIC_API_KEY` | Sí (ya existe) | Resumen con Claude |
| `APP_PASSCODE` | No, recomendada | Si se define, la app pide esa clave antes de gastar créditos |
| `CLAUDE_MODEL` | No | Modelo para el resumen (por defecto `claude-sonnet-4-6`) |

## Archivos

- `grabar.js`, `grabar.css`: pantalla de grabación
- `pcm-worklet.js`: convierte el micrófono a PCM 16 kHz mono para el modo en vivo
- `api/scribe-token.js`: tokens de un solo uso de ElevenLabs
- `api/summarize.js`: resumen con Claude (`maxDuration` 300 s en `vercel.json`)

## Costos

Cada grabación usa créditos de ElevenLabs dos veces: en vivo y al separar las voces. Los términos personalizados (`keyterms`: Yeshúa, Torá, parashá…) suman un recargo. El resumen usa la API de Anthropic.
