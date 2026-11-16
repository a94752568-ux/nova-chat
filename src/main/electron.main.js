const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, globalShortcut, dialog } = require("electron");
const path = require("path");
const os = require("os");
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

// Fondo de la ventana acorde al tema activo (evita flash del color equivocado)
const BG_BY_THEME = {
  dark: "#0b0817",
  cp2077: "#050a14",
  oled: "#000000",
  light: "#f8fafc"
};

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
  soundEnabled: true,
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
// Web: busqueda (DuckDuckGo, sin API key) y lector de paginas
// ============================================================================
const WEB_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NovaChat/1.0";

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return " "; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return " "; }
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&aacute;/g, "\u00e1")
    .replace(/&eacute;/g, "\u00e9")
    .replace(/&iacute;/g, "\u00ed")
    .replace(/&oacute;/g, "\u00f3")
    .replace(/&uacute;/g, "\u00fa")
    .replace(/&Ntilde;/g, "\u00d1")
    .replace(/&ntilde;/g, "\u00f1")
    .replace(/&uuml;/g, "\u00fc")
    .replace(/&iexcl;/g, "\u00a1")
    .replace(/&iquest;/g, "\u00bf")
    .replace(/&deg;/g, "\u00b0")
    .replace(/&middot;/g, "\u00b7")
    .replace(/&laquo;/g, "\u00ab")
    .replace(/&raquo;/g, "\u00bb")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, "\"")
    .replace(/&mdash;/g, "-")
    .replace(/&hellip;/g, "...");
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, "");
}

// Resultados del endpoint HTML de DuckDuckGo: enlaces .result__a con snippets
// .result__snippet. Los href pueden venir envueltos en el redirect /l/?uddg=.
function parseDuckResults(html) {
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let match;
  while ((match = linkRe.exec(html)) !== null) links.push(match);
  const snippets = [];
  while ((match = snippetRe.exec(html)) !== null) snippets.push(match);
  for (let i = 0; i < links.length; i++) {
    let url = links[i][1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]); } catch (_) { /* url directa */ }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtmlEntities(stripTags(links[i][2])).trim();
    const snippet = snippets[i] ? decodeHtmlEntities(stripTags(snippets[i][1])).trim() : "";
    if (title && !results.some((r) => r.url === url)) results.push({ title, url, snippet });
    if (results.length >= 8) break;
  }
  return results;
}

// HTML a texto plano: fuera scripts/estilos/comentarios, saltos de linea en
// tags de bloque, entidades decodificadas, espacios colapsados.
function htmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    backgroundColor: BG_BY_THEME[settings.theme] || "#0b0817",
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

  // Historial de conversaciones (userData/conversations.json)
  // Formato nuevo: [{ id, title, updatedAt, messages: [...] }]. El formato
  // viejo ({ messages: [...] }) se migra automaticamente al leerlo.
  const conversationsFile = function () {
    return path.join(app.getPath("userData"), "conversations.json");
  };
  const deriveTitle = function (messages) {
    const firstUser = (messages || []).find(function (m) { return m && m.role === "user" && m.content; });
    const clean = String(firstUser ? firstUser.content : "").replace(/\s+/g, " ").trim();
    if (!clean) return "Conversacion";
    return clean.length > 48 ? clean.slice(0, 48) + "..." : clean;
  };
  const readConversations = function () {
    try {
      const parsed = JSON.parse(fs.readFileSync(conversationsFile(), "utf8"));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
        return [{
          id: "conv_migrada_" + Date.now(),
          title: deriveTitle(parsed.messages),
          updatedAt: parsed.savedAt || new Date().toISOString(),
          messages: parsed.messages
        }];
      }
      return [];
    } catch (_) {
      return [];
    }
  };
  const writeConversations = function (list) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(conversationsFile(), JSON.stringify(list, null, 2), "utf8");
  };

  ipcMain.handle("conversations:save", (event, payload) => {
    try {
      const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
      if (!messages.length) return { ok: true };
      const list = readConversations();
      const id = (payload && payload.id) || ("conv_" + Date.now());
      const record = {
        id,
        title: deriveTitle(messages),
        updatedAt: new Date().toISOString(),
        messages
      };
      const existing = list.findIndex(function (c) { return c.id === id; });
      if (existing >= 0) list[existing] = record;
      else list.unshift(record);
      // Cap de 50 conversaciones: el disco no es infinito
      writeConversations(list.slice(0, 50));
      return { ok: true, id };
    } catch (error) {
      console.error("[Nova] No se pudo guardar la conversacion:", error.message);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("conversations:list", () => {
    try {
      const list = readConversations();
      const conversations = list.map(function (c) {
        return {
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          count: Array.isArray(c.messages) ? c.messages.length : 0
        };
      });
      return { ok: true, conversations };
    } catch (_) {
      return { ok: true, conversations: [] };
    }
  });
  ipcMain.handle("conversations:load", (event, id) => {
    try {
      const list = readConversations();
      if (id) {
        const conv = list.find(function (c) { return c.id === id; });
        return conv ? { ok: true, conversation: conv } : { ok: false, error: "No encontrada" };
      }
      // Sin id: la mas reciente
      return list.length ? { ok: true, conversation: list[0] } : { ok: true, conversation: null };
    } catch (_) {
      return { ok: true, conversation: null };
    }
  });
  ipcMain.handle("conversations:delete", (event, id) => {
    try {
      writeConversations(readConversations().filter(function (c) { return c.id !== id; }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });


  // ---------------------------------------------------------------------------
  // Notas locales (RAG ligero): texto libre del usuario que el renderer
  // inyecta por relevancia en el system prompt. Todo vive en notes.json.
  // ---------------------------------------------------------------------------
  const notesFile = function () {
    return path.join(app.getPath("userData"), "notes.json");
  };
  const readNotes = function () {
    try {
      const data = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  };
  const writeNotes = function (list) {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(notesFile(), JSON.stringify(list, null, 2), "utf8");
  };

  ipcMain.handle("notes:list", () => {
    try {
      return { ok: true, notes: readNotes() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("notes:add", (event, text) => {
    try {
      const clean = typeof text === "string" ? text.trim().slice(0, 2000) : "";
      if (!clean) return { ok: false, error: "Nota vacia" };
      const list = readNotes();
      // Sin duplicados exactos: guardar dos veces lo mismo no aporta contexto
      if (list.some((n) => n.text === clean)) return { ok: true, duplicate: true };
      list.unshift({
        id: "note_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
        text: clean,
        createdAt: new Date().toISOString()
      });
      // Cap de 200 notas: el system prompt solo usa 3, pero el disco no es infinito
      writeNotes(list.slice(0, 200));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("notes:delete", (event, id) => {
    try {
      writeNotes(readNotes().filter((n) => n.id !== id));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
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
              content: `Eres un corrector ortográfico y gramatical experto en español. Analiza el texto del usuario y detecta problemas de gramática, ortografía, claridad y tono. Responde ÚNICAMENTE con JSON válido, sin markdown ni texto adicional: {"issues": [{"start": numero, "end": numero, "text": "texto", "suggestion": "corrección", "type": "grammar|spelling|clarity|tone", "explanation": "explicación"}]}. REGLAS: "start" y "end" son índices basados en 0 sobre el texto analizado, SIN contar el prefijo "Analiza:" ni las comillas; "text" debe ser EXACTAMENTE la subcadena del texto original en esa posición; si no hay problemas devuelve {"issues": []}.`
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

  // Exportar conversacion como Markdown con dialogo nativo de guardado
  ipcMain.handle("export:markdown", async (event, payload) => {
    try {
      if (!mainWindow) return { ok: false, error: "Sin ventana" };
      const content = payload && typeof payload.content === "string" ? payload.content : "";
      if (!content) return { ok: false, error: "Contenido vacio" };
      const defaultName = (payload && payload.defaultName) || "nova-conversacion.md";
      // Sanitizar el nombre: solo caracteres seguros, sin rutas trampa
      const safeName = defaultName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Exportar conversacion",
        defaultPath: safeName,
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "Texto", extensions: ["txt"] }
        ]
      });
      if (result.canceled || !result.filePath) return { ok: true, saved: false };
      fs.writeFileSync(result.filePath, content, "utf8");
      return { ok: true, saved: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Informe del sistema para las habilidades locales del chat:
  // RAM, disco, CPU, uptime y bateria (si existe). Todo lectura, nada de riesgo.
  ipcMain.handle("system:info", async () => {
    try {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      let disk = null;
      try {
        // fs.statfs: Node >= 18.15 (Electron 28 lo trae)
        const st = await fs.promises.statfs(app.getPath("userData"));
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        disk = { totalBytes: total, freeBytes: free, usedBytes: total - free };
      } catch (_) {
        /* sin dato de disco: se omite en el informe */
      }
      let battery = null;
      try {
        // Linux: /sys/class/power_supply/BAT0 (portatil de Alberto: existe)
        const base = "/sys/class/power_supply/BAT0";
        const percent = parseInt(fs.readFileSync(path.join(base, "capacity"), "utf8"), 10);
        let status = "?";
        try {
          status = fs.readFileSync(path.join(base, "status"), "utf8").trim();
        } catch (_) { /* sin status */ }
        if (Number.isFinite(percent)) battery = { percent, status };
      } catch (_) {
        /* sin bateria (desktop): se omite en el informe */
      }
      return {
        ok: true,
        info: {
          platform: process.platform,
          os: os.type() + " " + os.release(),
          arch: os.arch(),
          cpuModel: cpus.length ? cpus[0].model.trim() : "?",
          cpuCores: cpus.length,
          loadAvg1m: os.loadavg()[0],
          uptimeSec: os.uptime(),
          mem: { totalBytes: totalMem, usedBytes: totalMem - freeMem, freeBytes: freeMem },
          disk,
          battery
        }
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Informe del SERVIDOR Ollama para las habilidades locales del chat: el
  // "sistema" que importa es el equipo que sirve los modelos (baseUrl),
  // no la laptop donde corre Nova. Consulta la API HTTP de Ollama.
  ipcMain.handle("system:server-info", async () => {
    const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
    const started = Date.now();
    const getJson = async (apiPath) => {
      const res = await withTimeout(fetch(baseUrl + apiPath), 4000, "Ollama " + apiPath);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    };
    try {
      // /api/ps y /api/tags no son vitales: si fallan, el informe sigue en linea
      const [version, ps, tags] = await Promise.all([
        getJson("/api/version"),
        getJson("/api/ps").catch(() => null),
        getJson("/api/tags").catch(() => null)
      ]);
      return {
        ok: true,
        online: true,
        baseUrl,
        latencyMs: Date.now() - started,
        version: version && version.version ? version.version : "?",
        loaded: ps && Array.isArray(ps.models) ? ps.models : [],
        installed: tags && Array.isArray(tags.models) ? tags.models : []
      };
    } catch (error) {
      return {
        ok: true,
        online: false,
        baseUrl,
        latencyMs: Date.now() - started,
        error: error.message
      };
    }
  });

  // Busqueda web real: DuckDuckGo (endpoint HTML, sin API key ni cuenta).
  // Devuelve hasta 8 resultados {title, url, snippet}.
  ipcMain.handle("web:search", async (event, query) => {
    const q = String(query || "").trim();
    if (!q) return { ok: false, error: "Busqueda vacia" };
    try {
      const url = "https://html.duckduckgo.com/html/?kl=mx-es&q=" + encodeURIComponent(q);
      const res = await withTimeout(fetch(url, {
        headers: { "User-Agent": WEB_UA, "Accept-Language": "es-MX,es;q=0.9,en;q=0.5" }
      }), 8000, "web:search");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const results = parseDuckResults(await res.text());
      return { ok: true, query: q, results };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Lector de paginas (scraper): descarga la URL, la convierte a texto plano
  // y la recorta a 12000 chars para que quepa en el contexto del modelo.
  ipcMain.handle("web:scrap", async (event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, error: "URL no permitida: solo http/https" };
    }
    try {
      const res = await withTimeout(fetch(target, {
        headers: { "User-Agent": WEB_UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8" },
        redirect: "follow"
      }), 10000, "web:scrap");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const type = String(res.headers.get("content-type") || "");
      if (type && !/text\/html|text\/plain|application\/xhtml|text\/xml|application\/xml|json/i.test(type)) {
        return { ok: false, error: "Tipo de contenido no soportado: " + type };
      }
      const buf = await res.arrayBuffer();
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 2000000));
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? decodeHtmlEntities(stripTags(titleMatch[1])).trim() : "";
      let text = htmlToText(raw);
      const truncated = text.length > 12000;
      if (truncated) text = text.slice(0, 12000);
      if (!text) return { ok: false, error: "La pagina no devolvio texto util" };
      return { ok: true, url: res.url || target, title, text, truncated };
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





