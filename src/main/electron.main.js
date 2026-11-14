const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { Ollama } = require("ollama");

// ============================================================================
// Configuración
// ============================================================================
const isDev = process.env.NODE_ENV === "development" || process.argv.includes("--dev");
const WINDOW_WIDTH = 1000;
const WINDOW_HEIGHT = 750;
const MIN_WIDTH = 600;
const MIN_HEIGHT = 450;

// Estado de la aplicación
let mainWindow = null;
let tray = null;
let ollamaClient = null;
const DEFAULT_SETTINGS = {
  baseUrl: "http://192.168.1.67:11434",
  model: "gemma2:2b",
  temperature: 0.2,
  topP: 0.9,
  numCtx: 8192,
  repeatPenalty: 1.1,
  keepAlive: "30m",
  grammarEnabled: false,
  autocompleteEnabled: true,
  theme: "dark",
  autoStart: false,
  minimizeToTray: true,
  requestTimeoutMs: 30000
};

// Los ajustes del usuario sobreviven al reinicio (userData/settings.json)
let settings = { ...DEFAULT_SETTINGS, ...loadSettingsFromDisk() };

// ============================================================================
// Persistencia de configuración (userData/settings.json)
// ============================================================================
function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettingsFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {}; // primera ejecución: no existe todavía
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("[Nova] No se pudo guardar settings.json:", error.message);
  }
}

// ============================================================================
// Utilidades
// ============================================================================
// Rechaza si la promesa no resuelve en ms: sin esto, un Ollama inalcanzable
// (paquetes descartados) cuelga el health check y la UI queda en "Conectando…"
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ": sin respuesta en " + ms + "ms")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ============================================================================
// Icono de la app
// ============================================================================
// Preferencia: icon.png real si algún día existe; si no, decodifica el
// sidecar icon.png.b64 (las herramientas de commit del repo solo aceptan
// texto, así que el PNG vive como base64 y se materializa en runtime).
function loadAppIcon() {
  const assetsDir = path.join(__dirname, "../renderer/assets");
  try {
    const fromPng = nativeImage.createFromPath(path.join(assetsDir, "icon.png"));
    if (!fromPng.isEmpty()) return fromPng;
  } catch (_) {
    // seguimos con el sidecar
  }
  try {
    const b64 = fs.readFileSync(path.join(assetsDir, "icon.png.b64"), "utf8").trim();
    const img = nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
    return img.isEmpty() ? null : img;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Inicialización de Ollama
// ============================================================================
function initOllama() {
  ollamaClient = new Ollama({ host: settings.baseUrl });
  return ollamaClient;
}

async function checkOllamaHealth() {
  if (!ollamaClient) return false;
  try {
    await withTimeout(ollamaClient.list(), 5000, "ollama:health");
    return true;
  } catch (error) {
    return false;
  }
}

async function listModels() {
  if (!ollamaClient) return [];
  try {
    const response = await withTimeout(ollamaClient.list(), 5000, "ollama:models");
    return response.models || [];
  } catch (error) {
    return [];
  }
}

// ============================================================================
// Ventana principal
// ============================================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: "#0f172a",
    icon: loadAppIcon() || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Minimizar a bandeja en lugar de cerrar
  mainWindow.on("minimize", (event) => {
    if (settings.minimizeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

// ============================================================================
// Bandeja del sistema (Tray)
// ============================================================================
function createTray() {
  try {
    const trayIcon = loadAppIcon();

    // Sin imagen válida, crear la Tray lanza en Linux y tumba la app en "ready".
    if (!trayIcon) {
      console.warn("[Nova] Icono de bandeja no disponible - bandeja deshabilitada");
      tray = null;
      return;
    }

    tray = new Tray(trayIcon);
  } catch (error) {
    console.error("[Nova] No se pudo crear la bandeja:", error.message);
    tray = null;
    return;
  }

  tray.setToolTip("Nova Chat - Asistente IA Local");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Nova Chat",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Mostrar Nova",
      click: () => {
        if (mainWindow) mainWindow.show();
      }
    },
    {
      label: "Configuración",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send("app:open-settings");
        }
      }
    },
    { type: "separator" },
    {
      label: "Salir",
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) mainWindow.show();
  });
}

// ============================================================================
// Atajos de teclado globales
// ============================================================================
function registerGlobalShortcuts() {
  const registered = globalShortcut.register("CmdOrCtrl+Shift+Space", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
  if (!registered) {
    console.warn("[Nova] No se pudo registrar Ctrl+Shift+Space (¿otra app lo está usando?)");
  }
}

// ============================================================================
// Manejadores de IPC (Comunicación Main ↔ Renderer)
// ============================================================================
function registerIpcHandlers() {
  // Configuración
  ipcMain.handle("app:get-settings", () => settings);
  ipcMain.handle("app:set-settings", (event, newSettings) => {
    if (!newSettings || typeof newSettings !== "object") return settings;
    settings = { ...settings, ...newSettings };
    persistSettings();
    if (newSettings.baseUrl) {
      initOllama();
    }
    return settings;
  });

  // Historial de conversación (userData/conversations.json)
  ipcMain.handle("conversations:save", (event, messages) => {
    try {
      const data = Array.isArray(messages) ? messages : [];
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(
        path.join(app.getPath("userData"), "conversations.json"),
        JSON.stringify({ messages: data, savedAt: new Date().toISOString() }, null, 2),
        "utf8"
      );
      return { ok: true };
    } catch (error) {
      console.error("[Nova] No se pudo guardar la conversación:", error.message);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("conversations:load", () => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(app.getPath("userData"), "conversations.json"), "utf8")
      );
      return { ok: true, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
    } catch (_) {
      return { ok: true, messages: [] };
    }
  });

  // Ollama
  ipcMain.handle("ollama:health", checkOllamaHealth);
  ipcMain.handle("ollama:models", listModels);
  ipcMain.handle("ollama:chat", async (event, payload) => {
    if (!ollamaClient) throw new Error("Ollama no inicializado");
    // Timeout configurado (requestTimeoutMs): un servidor colgado no debe
    // dejar el autocompletado/gramática esperando para siempre.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      (payload && payload.timeoutMs) || settings.requestTimeoutMs || 30000
    );
    try {
      const response = await ollamaClient.chat({
        model: payload.model || settings.model,
        messages: payload.messages,
        stream: false,
        keep_alive: settings.keepAlive,
        signal: controller.signal,
        options: {
          temperature: payload.temperature ?? settings.temperature,
          top_p: payload.topP ?? settings.topP,
          num_ctx: payload.numCtx ?? settings.numCtx,
          repeat_penalty: payload.repeatPenalty ?? settings.repeatPenalty
        }
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  });

  // Streaming real: los streams NO son serializables por IPC, así que main
  // itera y reenvía cada fragmento por eventos al renderer que los pidió.
  const activeStreams = new Map(); // requestId -> AbortController

  ipcMain.handle("ollama:chat-stream", async (event, payload) => {
    if (!ollamaClient) throw new Error("Ollama no inicializado");
    const requestId = payload && payload.requestId;
    if (!requestId) throw new Error("requestId requerido");

    const sender = event.sender;
    const send = (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data);
    };

    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    try {
      const stream = await ollamaClient.chat({
        model: payload.model || settings.model,
        messages: payload.messages,
        stream: true,
        keep_alive: settings.keepAlive,
        signal: controller.signal,
        options: {
          temperature: payload.temperature ?? settings.temperature,
          top_p: payload.topP ?? settings.topP,
          num_ctx: payload.numCtx ?? settings.numCtx,
          repeat_penalty: payload.repeatPenalty ?? settings.repeatPenalty
        }
      });
      for await (const part of stream) {
        send("ollama:chunk", { requestId, chunk: part });
        if (part.done) break;
      }
      send("ollama:done", { requestId });
      return { ok: true };
    } catch (error) {
      if (controller.signal.aborted) {
        send("ollama:aborted", { requestId });
        return { ok: false, aborted: true };
      }
      send("ollama:error", { requestId, error: error.message });
      return { ok: false, error: error.message };
    } finally {
      activeStreams.delete(requestId);
    }
  });

  ipcMain.handle("ollama:abort", (event, requestId) => {
    const controller = activeStreams.get(requestId);
    if (controller) controller.abort();
    return Boolean(controller);
  });

  // Gramática (tipo Grammarly)
  ipcMain.handle("grammar:check", async (event, { text, model }) => {
    if (!ollamaClient) return { ok: false, error: "Ollama no disponible" };
    try {
      const response = await withTimeout(
        ollamaClient.chat({
          model: model || settings.model,
          stream: false,
          messages: [
            {
              role: "system",
              content: `Eres un corrector ortográfico y gramatical experto en español. Analiza el texto y detecta problemas de gramática, ortografía, claridad y tono. Responde ÚNICAMENTE con JSON: {"issues": [{"id": "unique-id", "start": numero, "end": numero, "text": "texto", "suggestion": "corrección", "type": "grammar|spelling|clarity|tone", "explanation": "explicación"}]}. Sin texto adicional.`
            },
            { role: "user", content: `Analiza: "${text}"` }
          ],
          options: { temperature: 0.1 }
        }),
        settings.requestTimeoutMs || 30000,
        "grammar:check"
      );
      const content = response.message.content || "";
      const jsonStart = content.indexOf("{");
      const jsonEnd = content.lastIndexOf("}") + 1;
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
        return { ok: true, issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
      }
      return { ok: true, issues: [] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Sistema
  ipcMain.handle("app:quit", () => app.quit());
  ipcMain.handle("app:minimize", () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.handle("app:maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("shell:openExternal", async (event, url) => {
    // Solo http(s): nunca file:// ni esquemas raros desde el renderer
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error("URL no permitida: solo http/https");
    }
    await shell.openExternal(url);
  });
}

// ============================================================================
// Ciclo de vida de la aplicación
// ============================================================================
app.on("ready", () => {
  initOllama();
  createMainWindow();
  createTray();
  registerGlobalShortcuts();
  registerIpcHandlers();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // No salir, minimizar a bandeja si está configurado
    if (!settings.minimizeToTray || !tray) app.quit();
  }
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("will-quit", () => {
  if (ollamaClient) {
    // Ollama se encarga de sí mismo, solo limpiamos referencias
    ollamaClient = null;
  }
});

module.exports = { app, settings, createMainWindow, initOllama };
