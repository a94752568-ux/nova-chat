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
let settings = {
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
  minimizeToTray: true
};

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
    await ollamaClient.list();
    return true;
  } catch (error) {
    return false;
  }
}

async function listModels() {
  if (!ollamaClient) return [];
  try {
    const response = await ollamaClient.list();
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
    icon: path.join(__dirname, "../renderer/assets/icon.png"),
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
  const iconPath = path.join(__dirname, "../renderer/assets/icon.png");
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon);
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
  globalShortcut.register("CmdOrCtrl+Shift+Space", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
}

// ============================================================================
// Manejadores de IPC (Comunicación Main ↔ Renderer)
// ============================================================================
function registerIpcHandlers() {
  // Configuración
  ipcMain.handle("app:get-settings", () => settings);
  ipcMain.handle("app:set-settings", (event, newSettings) => {
    settings = { ...settings, ...newSettings };
    if (newSettings.baseUrl) {
      initOllama();
    }
    return settings;
  });

  // Ollama
  ipcMain.handle("ollama:health", checkOllamaHealth);
  ipcMain.handle("ollama:models", listModels);
  ipcMain.handle("ollama:chat", async (event, payload) => {
    if (!ollamaClient) throw new Error("Ollama no inicializado");
    const response = await ollamaClient.chat({
      model: payload.model || settings.model,
      messages: payload.messages,
      stream: false,
      keep_alive: settings.keepAlive,
      options: {
        temperature: payload.temperature ?? settings.temperature,
        top_p: payload.topP ?? settings.topP,
        num_ctx: payload.numCtx ?? settings.numCtx,
        repeat_penalty: payload.repeatPenalty ?? settings.repeatPenalty
      }
    });
    return response;
  });

  ipcMain.handle("ollama:stream", async (event, payload) => {
    if (!ollamaClient) throw new Error("Ollama no inicializado");
    const stream = await ollamaClient.chat({
      model: payload.model || settings.model,
      messages: payload.messages,
      stream: true,
      keep_alive: settings.keepAlive,
      options: {
        temperature: payload.temperature ?? settings.temperature,
        top_p: payload.topP ?? settings.topP,
        num_ctx: payload.numCtx ?? settings.numCtx,
        repeat_penalty: payload.repeatPenalty ?? settings.repeatPenalty
      }
    });
    return stream;
  });

  // Gramática (tipo Grammarly)
  ipcMain.handle("grammar:check", async (event, { text, model }) => {
    if (!ollamaClient) return { ok: false, error: "Ollama no disponible" };
    try {
      const response = await ollamaClient.chat({
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
      });
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
  ipcMain.handle("app:minimize", () => mainWindow.minimize());
  ipcMain.handle("app:maximize", () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("shell:openExternal", async (event, url) => {
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
