# Nova Chat — Asistente de IA Local para Escritorio

> Nova Chat es una aplicación de escritorio que proporciona una experiencia de IA local con una **UI Inteligente** inspirada en el estilo Cyberpunk. Incluye corrección gramatical tipo Grammarly, autocompletado por IA, y conversación con modelos locales de Ollama.

## Características

### 🤖 IA Local (Ollama)
- Conversación en tiempo real con modelos locales de Ollama
- Streaming de respuestas (NDJSON)
- Selección de modelo desde la interfaz
- Configuración de parámetros (temperature, num_ctx, top_p, etc.)

### ✍️ Corrección Gramatical (tipo Grammarly)
- Detección de problemas de gramática, ortografía, claridad y tono
- Subrayados coloreados en la página web (cuando se usa en navegador)
- Popups de corrección con opciones "Aplicar" / "Ignorar"
- Panel de estadísticas con puntuación 0-100
- Corrección masiva de todo el texto

### 🔮 Autocompletado por IA
- Sugerencias en tiempo real mientras escribes
- Activado con Tab/Enter para aceptar
- Navegación con flechas entre sugerencias
- Debounce optimizado (450ms)

### 🎨 UI Inteligente (Cyberpunk)
- Tema oscuro, OLED y claro
- Efectos neon, pulse, scanlines y rejilla de fondo
- Esquinas HUD y bordes con gradiente
- Animaciones suaves y responsive

### 🖥️ Escritorio (Electron)
- Bandeja del sistema (tray)
- Atajo global: `Ctrl+Shift+Space` / `Cmd+Shift+Space`
- Minimizar a bandeja
- Barra de título personalizada

## Instalación

### Requisitos
- Node.js 18+
- Ollama instalado y corriendo (`ollama serve`)
- Al menos un modelo descargado (ej: `ollama pull gemma2:2b`)

### Desarrollo
```bash
cd nova-chat
npm install
npm run dev
```

### Producción
```bash
npm run build
```

## Estructura del Proyecto

```
nova-chat/
├── package.json
├── src/
│   ├── main/
│   │   ├── electron.main.js   # Proceso principal de Electron
│   │   └── preload.js          # Script de preload (IPC seguro)
│   ├── renderer/
│   │   ├── index.html          # HTML principal
│   │   ├── renderer.js         # Lógica del renderer
│   │   └── styles/
│   │       ├── main.css        # Estilos principales
│   │       ├── components.css  # Componentes UI
│   │       └── cyberpunk.css   # Estilos cyberpunk
│   └── assets/
│       └── icon.png            # Icono de la aplicación
├── tests/
├── docs/
└── scripts/
```

## Uso

1. Inicia Ollama: `ollama serve`
2. Descarga un modelo: `ollama pull gemma2:2b`
3. Inicia Nova Chat: `npm start`
4. Escribe en el compositor y presiona Enter para enviar
5. Activa la corrección gramatical desde Configuración
6. Usa `Ctrl+Shift+Space` para mostrar/ocultar la aplicación

## Configuración

| Ajuste | Valor por defecto | Descripción |
|--------|------------------|-------------|
| URL base Ollama | `http://127.0.0.1:11434` | Dirección de tu instancia local |
| Modelo | `gemma2:2b` | Modelo a utilizar |
| Temperature | 0.2 | Creatividad del modelo |
| num_ctx | 8192 | Ventana de contexto |
| Gramática | Desactivado | Corrección tipo Grammarly |
| Autocompletado | Activado | Sugerencias mientras escribes |
| Tema | Oscuro | Oscuro / OLED / Claro |

## Atajos de Teclado

| Acción | Tecla |
|--------|-------|
| Mostrar/Ocultar Nova | `Ctrl+Shift+Space` / `Cmd+Shift+Space` |
| Enviar mensaje | `Enter` |
| Salto de línea | `Shift+Enter` |
| Aceptar autocompletado | `Tab` |
| Navegar sugerencias | `↑` / `↓` |
| Cerrar sugerencias | `Esc` |

## Licencia

MIT
