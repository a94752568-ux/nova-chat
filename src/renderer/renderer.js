/**
 * Nova Chat — Renderer Process
 * UI Inteligente para escritorio con corrección gramatical tipo Grammarly
 * y autocompletado por IA local (Ollama)
 */

// ============================================================================
// Estado de la aplicación
// ============================================================================
const state = {
  settings: {
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
  },
  models: [],
  selectedModel: "",
  messages: [],
  generating: false,
  activeStreamCancel: null,
  grammar: {
    enabled: false,
    issues: [],
    score: 100,
    counts: { grammar: 0, spelling: 0, clarity: 0, tone: 0 }
  },
  autocomplete: {
    suggestions: [],
    selectedIndex: -1,
    active: false,
    prefix: "",
    abortController: null
  }
};

// ============================================================================
// Referencias DOM
// ============================================================================
const dom = {};

function cacheDom() {
  // Título y estado
  dom.titleSubtitle = $("#chat-subtitle");
  dom.ollamaDot = $("#ollama-dot");
  dom.ollamaText = $("#ollama-text");

  // Navegación
  dom.navItems = $$(".nav-item");
  dom.panels = $$(".panel");

  // Botones principales
  dom.btnMinimize = $("#btn-minimize");
  dom.btnMaximize = $("#btn-maximize");
  dom.btnClose = $("#btn-close");
  dom.btnSettings = $("#btn-settings");
  dom.btnOllamaStatus = $("#btn-ollama-status");
  dom.btnNewChat = $("#btn-new-chat");
  dom.btnClearChat = $("#btn-clear-chat");

  // Chat
  dom.messages = $("#messages");
  dom.typingIndicator = $("#typing-indicator");
  dom.scrollBottomBtn = $("#scroll-bottom-btn");
  dom.composerForm = $("#composer-form");
  dom.promptInput = $("#prompt-input");
  dom.composerHint = $("#composer-hint");
  dom.btnStop = $("#btn-stop");
  dom.btnSend = $("#btn-send");
  dom.chips = $("#chips");
  dom.autocompleteDropdown = $("#autocomplete-dropdown");
  dom.autocompleteItems = $$(".autocomplete-item");

  // Gramática
  dom.grammarStats = $("#grammar-stats");
  dom.grammarScore = $("#grammar-score");
  dom.grammarList = $("#grammar-list");
  dom.grammarEmpty = $("#grammar-empty");
  dom.grammarCountGrammar = $("#grammar-count-grammar");
  dom.grammarCountSpelling = $("#grammar-count-spelling");
  dom.grammarCountClarity = $("#grammar-count-clarity");
  dom.grammarCountTone = $("#grammar-count-tone");

  // Panel de gramática
  dom.grammarInput = $("#grammar-input");
  dom.btnCheckCurrent = $("#btn-check-current");
  dom.btnFixAll = $("#btn-fix-all");
  dom.btnClearGrammar = $("#btn-clear-grammar");
  dom.grammarOutput = $("#grammar-output");

  // Configuración
  dom.settingBaseUrl = $("#setting-base-url");
  dom.settingModel = $("#setting-model");
  dom.settingGrammarEnabled = $("#setting-grammar-enabled");
  dom.settingAutocompleteEnabled = $("#setting-autocomplete-enabled");
  dom.settingTemperature = $("#setting-temperature");
  dom.settingNumCtx = $("#setting-num-ctx");
  dom.settingTimeout = $("#setting-timeout");
  dom.settingTheme = $("#setting-theme");
  dom.settingMinimizeTray = $("#setting-minimize-tray");
  dom.settingAutoStart = $("#setting-auto-start");
  dom.btnSaveSettings = $("#btn-save-settings");
  dom.btnResetSettings = $("#btn-reset-settings");

  // Modelo del sidebar
  dom.sidebarModelSelect = $("#sidebar-model-select");

  // Notificaciones
  dom.toasts = $("#toasts");
}

// Helpers DOM
function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// ============================================================================
// Inicialización
// ============================================================================
async function init() {
  if (!window.novaAPI) {
    console.error("[Nova] window.novaAPI no disponible - preload script no cargado");
    toast("Error: API de Nova no disponible", "error");
    return;
  }
  cacheDom();
  setupEventListeners();
  await loadSettings();
  // Sin await: si Ollama tarda o no responde, el resto de la UI sigue viva.
  // Los timeouts están en main (5s salud/modelos), así que esto resuelve
  // siempre y actualiza el estado cuando llegue la respuesta.
  checkOllamaStatus();
  loadModels();
  await loadConversation();
  applyTheme();

  // Verificar Ollama periódicamente
  setInterval(checkOllamaStatus, 90000);
}

function setupEventListeners() {
  // Control de ventana - validar elementos y novaAPI
  if (dom.btnMinimize && window.novaAPI) {
    dom.btnMinimize.addEventListener("click", () => window.novaAPI.minimize());
  }
  if (dom.btnMaximize && window.novaAPI) {
    dom.btnMaximize.addEventListener("click", () => window.novaAPI.maximize());
  }
  if (dom.btnClose && window.novaAPI) {
    dom.btnClose.addEventListener("click", () => window.novaAPI.quit());
  }

  // Clic en el indicador de estado = reintentar conexión y recargar modelos
  if (dom.btnOllamaStatus) {
    dom.btnOllamaStatus.addEventListener("click", async () => {
      if (dom.ollamaDot) dom.ollamaDot.dataset.state = "checking";
      if (dom.ollamaText) dom.ollamaText.textContent = "Verificando…";
      const ok = await checkOllamaStatus();
      if (ok) loadModels();
    });
  }

  // Navegación
  dom.navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const section = item.dataset.section;
      switchSection(section);
    });
  });

  // Configuración
  if (dom.btnSettings) {
    dom.btnSettings.addEventListener("click", () => switchSection("settings"));
  }

  // Chat
  if (dom.composerForm) {
    dom.composerForm.addEventListener("submit", handleSendMessage);
  }
  if (dom.promptInput) {
    dom.promptInput.addEventListener("input", handleComposerInput);
    dom.promptInput.addEventListener("keydown", handleComposerKeydown);
  }
  if (dom.btnStop) {
    dom.btnStop.addEventListener("click", stopGeneration);
  }
  // El botón enviar es type="submit": el submit nativo del form ya dispara
  // handleSendMessage. Un dispatch manual aquí duplicaría el envío.
  if (dom.btnClearChat) {
    dom.btnClearChat.addEventListener("click", clearChat);
  }

  // Nueva conversación
  if (dom.btnNewChat) {
    dom.btnNewChat.addEventListener("click", clearChat);
  }

  // Chips de acción rápida
  if (dom.chips) {
    dom.chips.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      const action = chip.dataset.action;
      handleQuickAction(action);
    });
  }

  // Autocompletado
  setupAutocompleteListeners();

  // Gramática
  setupGrammarListeners();

  // Configuración
  setupSettingsListeners();

  // Scroll al final
  if (dom.scrollBottomBtn) {
    dom.scrollBottomBtn.addEventListener("click", scrollToBottom);
  }
}

function setupAutocompleteListeners() {
  let autocompleteDebounce = null;

  dom.promptInput.addEventListener("input", () => {
    clearTimeout(autocompleteDebounce);
    autocompleteDebounce = setTimeout(() => {
      triggerAutocomplete();
    }, 450);
  });

  dom.promptInput.addEventListener("keydown", (event) => {
    if (!state.autocomplete.active) return;

    if (event.key === "Tab") {
      event.preventDefault();
      acceptAutocomplete();
    } else if (event.key === "Enter") {
      event.preventDefault();
      acceptAutocomplete();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      navigateAutocomplete(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navigateAutocomplete(-1);
    } else if (event.key === "Escape") {
      hideAutocomplete();
    }
  });

  dom.autocompleteDropdown.addEventListener("click", (event) => {
    const item = event.target.closest(".autocomplete-item");
    if (!item) return;
    const index = Number(item.dataset.index);
    acceptAutocomplete(index);
  });

  dom.promptInput.addEventListener("blur", () => {
    setTimeout(hideAutocomplete, 150);
  });
}

function setupSettingsListeners() {
  dom.settingBaseUrl.addEventListener("change", (e) => {
    state.settings.baseUrl = e.target.value;
  });

  dom.settingModel.addEventListener("change", (e) => {
    state.settings.model = e.target.value;
    state.selectedModel = e.target.value;
  });

  dom.settingGrammarEnabled.addEventListener("change", (e) => {
    state.settings.grammarEnabled = e.target.checked;
    state.grammar.enabled = e.target.checked;
    toggleGrammarInPage(e.target.checked);
  });

  dom.settingAutocompleteEnabled.addEventListener("change", (e) => {
    state.settings.autocompleteEnabled = e.target.checked;
  });

  dom.settingTemperature.addEventListener("input", (e) => {
    state.settings.temperature = Number(e.target.value);
    $("#temp-value").textContent = e.target.value;
  });

  dom.settingNumCtx.addEventListener("input", (e) => {
    state.settings.numCtx = Number(e.target.value);
    $("#num-ctx-value").textContent = e.target.value;
  });

  dom.settingTimeout.addEventListener("change", (e) => {
    state.settings.requestTimeoutMs = Number(e.target.value);
  });

  dom.settingTheme.addEventListener("change", (e) => {
    state.settings.theme = e.target.value;
    applyTheme();
  });

  dom.settingMinimizeTray.addEventListener("change", (e) => {
    state.settings.minimizeToTray = e.target.checked;
  });

  dom.settingAutoStart.addEventListener("change", (e) => {
    state.settings.autoStart = e.target.checked;
  });

  dom.btnSaveSettings.addEventListener("click", saveSettings);
  dom.btnResetSettings.addEventListener("click", resetSettings);

  // Modelo del sidebar
  dom.sidebarModelSelect.addEventListener("change", (e) => {
    state.selectedModel = e.target.value;
    state.settings.model = e.target.value;
  });
}

// ============================================================================
// Configuración y ajustes
// ============================================================================
async function loadSettings() {
  try {
    const settings = await window.novaAPI.getSettings();
    state.settings = { ...state.settings, ...settings };
    state.selectedModel = state.settings.model || "";

    // Actualizar UI
    dom.settingBaseUrl.value = state.settings.baseUrl;
    dom.settingModel.value = state.settings.model;
    dom.settingGrammarEnabled.checked = state.settings.grammarEnabled;
    dom.settingAutocompleteEnabled.checked = state.settings.autocompleteEnabled;
    dom.settingTemperature.value = state.settings.temperature;
    dom.settingNumCtx.value = state.settings.numCtx;
    dom.settingTimeout.value = state.settings.requestTimeoutMs || 30000;
    dom.settingTheme.value = state.settings.theme;
    dom.settingMinimizeTray.checked = state.settings.minimizeToTray;
    dom.settingAutoStart.checked = state.settings.autoStart;

    $("#temp-value").textContent = state.settings.temperature;
    $("#num-ctx-value").textContent = state.settings.numCtx;

    state.grammar.enabled = state.settings.grammarEnabled;

    // Aplicar tema
    applyTheme();
  } catch (error) {
    console.error("[Nova] Error cargando ajustes:", error);
    toast("Error al cargar la configuración", "error");
  }
}

async function saveSettings() {
  try {
    await window.novaAPI.setSettings(state.settings);
    toast("Configuración guardada", "ok");
  } catch (error) {
    toast("Error al guardar la configuración", "error");
  }
}

function resetSettings() {
  state.settings = {
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
  state.selectedModel = "gemma2:2b";
  applyTheme();
  updateSettingsUI();
  toast("Valores restablecidos", "ok");
}

function updateSettingsUI() {
  dom.settingBaseUrl.value = state.settings.baseUrl;
  dom.settingModel.value = state.settings.model;
  dom.settingGrammarEnabled.checked = state.settings.grammarEnabled;
  dom.settingAutocompleteEnabled.checked = state.settings.autocompleteEnabled;
  dom.settingTemperature.value = state.settings.temperature;
  dom.settingNumCtx.value = state.settings.numCtx;
  dom.settingTimeout.value = state.settings.requestTimeoutMs || 30000;
  dom.settingTheme.value = state.settings.theme;
  dom.settingMinimizeTray.checked = state.settings.minimizeToTray;
  dom.settingAutoStart.checked = state.settings.autoStart;
  $("#temp-value").textContent = state.settings.temperature;
  $("#num-ctx-value").textContent = state.settings.numCtx;
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.settings.theme);
  // Tema Cyberpunk 2077: activa scanlines y rejilla de fondo futurista.
  // Los overlays son pointer-events: none, no interfieren con la UI.
  const fxOn = state.settings.theme === "cp2077";
  ["grid-bg", "scanline-overlay"].forEach((cls) => {
    let el = document.querySelector("." + cls);
    if (fxOn && !el) {
      el = document.createElement("div");
      el.className = cls;
      el.setAttribute("aria-hidden", "true");
      document.body.prepend(el);
    } else if (!fxOn && el) {
      el.remove();
    }
  });
}

// ============================================================================
// Ollama y modelos
// ============================================================================
async function checkOllamaStatus() {
  try {
    const healthy = await window.novaAPI.checkOllamaHealth();
    if (dom.ollamaDot) dom.ollamaDot.dataset.state = healthy ? "ready" : "error";
    if (dom.ollamaText) dom.ollamaText.textContent = healthy ? "Conectado · Ollama" : "Ollama no disponible";
    if (dom.titleSubtitle) dom.titleSubtitle.textContent = healthy ? "IA local · Ollama" : "Ollama no disponible";
    if (dom.composerHint && !state.generating) {
      dom.composerHint.textContent = healthy ? "Conectado a Ollama" : "Sin conexión con Ollama";
    }
    if (dom.btnOllamaStatus) dom.btnOllamaStatus.classList.toggle("connected", healthy);
    return healthy;
  } catch (error) {
    if (dom.ollamaDot) dom.ollamaDot.dataset.state = "error";
    if (dom.ollamaText) dom.ollamaText.textContent = "Error";
    if (dom.composerHint && !state.generating) dom.composerHint.textContent = "Sin conexión con Ollama";
    return false;
  }
}

async function loadModels() {
  try {
    const models = await window.novaAPI.listModels();
    state.models = models;

    // Actualizar selectores
    updateModelSelectors(models);
  } catch (error) {
    console.error("[Nova] Error cargando modelos:", error);
    // Aviso claro en el selector en vez de dejar "Cargando modelos…" eterno
    if (dom.sidebarModelSelect) {
      dom.sidebarModelSelect.innerHTML = "";
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Sin modelos — ¿Ollama está corriendo?";
      dom.sidebarModelSelect.appendChild(option);
    }
  }
}

function updateModelSelectors(models) {
  // Sidebar
  dom.sidebarModelSelect.innerHTML = "";
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Sin modelos — ¿Ollama está corriendo?";
    dom.sidebarModelSelect.appendChild(option);
  }
  models.forEach((m) => {
    const option = document.createElement("option");
    option.value = m.name || m.model;
    option.textContent = m.name || m.model;
    if (option.value === state.selectedModel) option.selected = true;
    dom.sidebarModelSelect.appendChild(option);
  });

  // Configuración (mantener opciones predefinidas + agregar modelos detectados)
  const predefined = ["", "gemma2:2b", "gemma4:e2b-it-qat", "qwen3.5:4b", "phi4-mini:3.8b"];
  const existing = new Set(Array.from(dom.settingModel.options).map((o) => o.value));

  models.forEach((m) => {
    const name = m.name || m.model;
    if (!existing.has(name)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      dom.settingModel.appendChild(option);
      existing.add(name);
    }
  });

  if (state.selectedModel && !existing.has(state.selectedModel)) {
    const option = document.createElement("option");
    option.value = state.selectedModel;
    option.textContent = state.selectedModel;
    option.selected = true;
    dom.settingModel.appendChild(option);
  } else if (state.selectedModel) {
    dom.settingModel.value = state.selectedModel;
  }
}

// ============================================================================
// Chat y mensajería
// ============================================================================

// Auto-crecer el textarea mientras el usuario escribe.
function handleComposerInput() {
  autoResizeTextarea();
}

// Enter envía, Shift+Enter salto de línea. Si el dropdown de autocompletado
// está activo, SU listener decide (aceptar/navegar) y aquí no se envía.
function handleComposerKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey && !state.autocomplete.active) {
    event.preventDefault();
    if (typeof dom.composerForm.requestSubmit === "function") {
      dom.composerForm.requestSubmit();
    } else {
      dom.composerForm.dispatchEvent(new Event("submit"));
    }
  }
}

async function handleSendMessage(event) {
  event.preventDefault();

  if (!window.novaAPI) {
    toast("Error: API de Nova no disponible", "error");
    return;
  }

  const text = dom.promptInput.value.trim();
  if (!text || state.generating) return;

  // Ocultar autocompletado
  hideAutocomplete();

  // Añadir mensaje de usuario
  addUserMessage(text);
  dom.promptInput.value = "";
  autoResizeTextarea();
  dom.composerHint.textContent = "Generando respuesta…";

  // Mostrar indicador de escritura
  showTyping();

  try {
    const model = state.selectedModel || state.settings.model || "";
    // addUserMessage ya pusheó el mensaje del usuario a state.messages:
    // NO volver a agregarlo (antes viajaba duplicado a Ollama).
    const messages = state.messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content
    }));

    await runChatStream(model, messages);

  } catch (error) {
    console.error("[Nova] Error en chat:", error);
    hideTyping();
    dom.composerHint.textContent = "Error al generar respuesta";
    toast("Error al conectar con Ollama", "error");
  }
}

// Chat por streaming real: main itera la respuesta de Ollama y reenvía los
// fragmentos por eventos IPC (ollama:chunk / done / aborted / error).
async function runChatStream(model, messages) {
  state.generating = true;
  dom.btnStop.hidden = false;
  dom.btnSend.hidden = true;

  const assistantMessage = {
    id: generateId(),
    role: "assistant",
    content: "",
    model,
    createdAt: Date.now()
  };
  state.messages.push(assistantMessage);

  const messageElement = createMessageElement(assistantMessage);
  dom.messages.appendChild(messageElement);
  scrollToBottom();

  const contentElement = messageElement.querySelector(".bubble");
  let fullContent = "";
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    state.generating = false;
    state.activeStreamCancel = null;
    hideTyping();
    dom.btnStop.hidden = true;
    dom.btnSend.hidden = false;

    if (fullContent.trim()) {
      assistantMessage.durationMs = Date.now() - assistantMessage.createdAt;
      updateMessageMeta(messageElement, assistantMessage);
      if (state.settings.grammarEnabled && fullContent.trim().length > 3) {
        checkGrammarForText(fullContent, assistantMessage.id);
      }
      dom.composerHint.textContent = "Respuesta generada";
    } else {
      dom.composerHint.textContent = "Sin respuesta del modelo";
    }
    saveConversation();
  };

  const stream = window.novaAPI.chatStream(
    {
      requestId: "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
      model,
      messages,
      temperature: state.settings.temperature,
      topP: state.settings.topP,
      numCtx: state.settings.numCtx,
      repeatPenalty: state.settings.repeatPenalty
    },
    {
      onChunk: (chunk) => {
        if (chunk && chunk.message && chunk.message.content) {
          fullContent += chunk.message.content;
          assistantMessage.content = fullContent;
          contentElement.textContent = fullContent;
          scrollToBottom();
        }
      },
      onDone: finish,
      onAborted: () => {
        if (!fullContent.trim()) {
          // Abortado sin contenido: descartar la burbuja vacía
          state.messages = state.messages.filter((m) => m.id !== assistantMessage.id);
          messageElement.remove();
        }
        dom.composerHint.textContent = "Generación detenida";
        finish();
      },
      onError: (error) => {
        console.error("[Nova] Error en stream:", error);
        contentElement.textContent = "Error al generar la respuesta.";
        contentElement.classList.add("bubble--error");
        dom.composerHint.textContent = "Error al generar respuesta";
        toast("Error al conectar con Ollama", "error");
        finish();
      }
    }
  );
  state.activeStreamCancel = stream.cancel;
}

function addUserMessage(text) {
  const message = {
    id: generateId(),
    role: "user",
    content: text,
    createdAt: Date.now()
  };
  state.messages.push(message);

  const messageElement = createMessageElement(message);
  dom.messages.appendChild(messageElement);
  scrollToBottom();
  saveConversation();
}

function createMessageElement(message) {
  const isUser = message.role === "user";
  const article = document.createElement("article");
  article.className = `msg msg--${message.role}`;
  article.dataset.id = message.id;

  const avatar = document.createElement("div");
  avatar.className = `avatar avatar--${isUser ? "user" : "asst"}`;
  avatar.textContent = isUser ? "Tú" : "N";
  avatar.setAttribute("aria-hidden", "true");

  const column = document.createElement("div");
  column.className = "bubble-col";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = message.content;

  const meta = document.createElement("div");
  meta.className = "msg__meta";

  if (message.model) {
    const modelSpan = document.createElement("span");
    modelSpan.className = "msg__model";
    modelSpan.textContent = message.model;
    meta.appendChild(modelSpan);
    meta.appendChild(document.createTextNode(" · "));
  }

  if (Number.isFinite(message.durationMs)) {
    const durationSpan = document.createElement("span");
    durationSpan.className = "msg__duration";
    durationSpan.textContent = `~${formatDuration(message.durationMs)}`;
    meta.appendChild(durationSpan);
  }

  column.appendChild(bubble);
  column.appendChild(meta);
  article.appendChild(avatar);
  article.appendChild(column);

  return article;
}

function updateMessageMeta(element, message) {
  const meta = element.querySelector(".msg__meta");
  if (!meta) return;

  // Limpiar meta existente
  meta.innerHTML = "";

  if (message.model) {
    const modelSpan = document.createElement("span");
    modelSpan.className = "msg__model";
    modelSpan.textContent = message.model;
    meta.appendChild(modelSpan);
    meta.appendChild(document.createTextNode(" · "));
  }

  if (Number.isFinite(message.durationMs)) {
    const durationSpan = document.createElement("span");
    durationSpan.className = "msg__duration";
    durationSpan.textContent = `~${formatDuration(message.durationMs)}`;
    meta.appendChild(durationSpan);
  }
}

function showTyping() {
  dom.typingIndicator.hidden = false;
  scrollToBottom();
}

function hideTyping() {
  dom.typingIndicator.hidden = true;
}

function stopGeneration() {
  // Abort real: pide a main que cancele la petición HTTP de Ollama.
  // El flujo termina vía onAborted (conserva la respuesta parcial).
  if (state.activeStreamCancel) {
    state.activeStreamCancel();
  }
}

function clearChat() {
  if (!confirm("¿Estás seguro de que quieres limpiar la conversación?")) return;
  state.messages = [];
  dom.messages.innerHTML = "";
  saveConversation();
}

function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

// ============================================================================
// Autocompletado por IA
// ============================================================================
function triggerAutocomplete() {
  if (!state.settings.autocompleteEnabled || state.generating) return;

  const textarea = dom.promptInput;
  const value = textarea.value;
  const cursorPos = textarea.selectionStart;
  const beforeCursor = value.slice(0, cursorPos);

  if (!beforeCursor.trim() || /[\s\n]$/.test(beforeCursor)) {
    hideAutocomplete();
    return;
  }

  const words = beforeCursor.split(/\s+/);
  const lastWord = words[words.length - 1];
  if (lastWord.length < 2) {
    hideAutocomplete();
    return;
  }

  state.autocomplete.prefix = lastWord;
  requestAutocomplete(beforeCursor);
}

// Contador de peticiones de autocompletado: si el usuario siguió tecleando,
// las respuestas que llegan tarde se descartan (evita sugerencias obsoletas).
let autocompleteRequestId = 0;

async function requestAutocomplete(textBeforeCursor) {
  const model = state.selectedModel || state.settings.model || "";
  const requestId = ++autocompleteRequestId;

  try {
    const response = await window.novaAPI.chat({
      model,
      messages: [
        {
          role: "system",
          content: "Eres un asistente de autocompletado de texto en español. Completa el texto que el usuario está escribiendo de manera natural, concisa y útil. Solo devuelve el fragmento de completado, sin comillas, sin explicaciones, sin markdown, sin saltos de línea adicionales. Máximo 2 oraciones. No repitas lo que el usuario ya escribió."
        },
        { role: "user", content: `Completa este texto de forma natural: "${textBeforeCursor}"` }
      ],
      stream: false,
      temperature: 0.3,
      topP: 0.9,
      numCtx: 2048,
      repeatPenalty: 1.1
    });

    if (requestId !== autocompleteRequestId) return; // respuesta obsoleta

    const content = response.message && response.message.content ? response.message.content : "";
    const clean = content.trim().replace(/\n+/g, " ").slice(0, 200);

    if (!clean) {
      hideAutocomplete();
      return;
    }

    const suggestions = [
      clean,
      clean.charAt(0).toUpperCase() + clean.slice(1),
      clean.endsWith(".") ? clean : clean + "."
    ];

    showAutocomplete(suggestions);

  } catch (error) {
    hideAutocomplete();
    toast("Autocompletado: no se pudo conectar con Ollama", "error");
  }
}

function showAutocomplete(suggestions) {
  state.autocomplete.suggestions = suggestions;
  state.autocomplete.selectedIndex = 0;
  state.autocomplete.active = true;

  dom.autocompleteItems.forEach((item, index) => {
    const preview = item.querySelector(".autocomplete-item__preview") || item;
    const accept = item.querySelector(".autocomplete-item__accept");
    if (preview) preview.textContent = suggestions[index] || "";
    if (accept) accept.textContent = "Tab para aceptar";
    item.setAttribute("data-selected", index === 0 ? "true" : "false");
  });

  dom.autocompleteDropdown.hidden = false;
}

function hideAutocomplete() {
  state.autocomplete.suggestions = [];
  state.autocomplete.selectedIndex = -1;
  state.autocomplete.active = false;
  state.autocomplete.prefix = "";
  dom.autocompleteDropdown.hidden = true;
}

function acceptAutocomplete(index = state.autocomplete.selectedIndex) {
  const suggestion = state.autocomplete.suggestions[index];
  if (!suggestion || !state.autocomplete.active) return false;

  const textarea = dom.promptInput;
  const value = textarea.value;
  const cursorPos = textarea.selectionStart;
  const beforeCursor = value.slice(0, cursorPos);
  const afterCursor = value.slice(cursorPos);

  const lastSpace = beforeCursor.lastIndexOf(" ");
  const startPos = lastSpace === -1 ? 0 : lastSpace + 1;

  const newValue = beforeCursor.slice(0, startPos) + suggestion + " " + afterCursor;
  textarea.value = newValue;

  const newCursorPos = startPos + suggestion.length + 1;
  textarea.selectionStart = newCursorPos;
  textarea.selectionEnd = newCursorPos;

  hideAutocomplete();
  textarea.focus({ preventScroll: true });
  autoResizeTextarea();
  return true;
}

function navigateAutocomplete(delta) {
  if (!state.autocomplete.active) return;
  const newIndex = state.autocomplete.selectedIndex + delta;
  if (newIndex < 0 || newIndex >= state.autocomplete.suggestions.length) return;

  state.autocomplete.selectedIndex = newIndex;
  dom.autocompleteItems.forEach((item, index) => {
    item.setAttribute("data-selected", index === newIndex ? "true" : "false");
  });
}

// ============================================================================
// Gramática (tipo Grammarly)
// ============================================================================
async function toggleGrammarInPage(enabled) {
  if (enabled) {
    await checkOllamaStatus();
  }
  state.grammar.enabled = enabled;
  dom.grammarStats.hidden = !enabled;
  if (enabled) {
    await requestGrammarCheckForPage();
  } else {
    state.grammar.issues = [];
    state.grammar.score = 100;
    state.grammar.counts = { grammar: 0, spelling: 0, clarity: 0, tone: 0 };
    renderGrammarStats();
  }
}

async function requestGrammarCheckForPage() {
  if (!state.settings.grammarEnabled) return;

  try {
    // Obtener texto del compositor o del editor de gramática
    const text = dom.promptInput.value || dom.grammarInput.value || "";
    if (!text.trim()) return;

    const response = await window.novaAPI.checkGrammar({
      text,
      model: state.selectedModel || state.settings.model || ""
    });

    if (response.ok && response.issues) {
      state.grammar.issues = response.issues;
      computeGrammarScore();
      renderGrammarStats();
    }
  } catch (error) {
    console.error("[Nova] Error checking grammar:", error);
  }
}

async function checkGrammarInEditor() {
  const text = dom.grammarInput.value.trim();
  if (!text) {
    toast("Ingresa texto para revisar", "info");
    return;
  }

  try {
    const response = await window.novaAPI.checkGrammar({
      text,
      model: state.selectedModel || state.settings.model || ""
    });

    if (response.ok && response.issues) {
      state.grammar.issues = response.issues;
      computeGrammarScore();
      renderGrammarStats();
      displayGrammarIssues(response.issues);
    }
  } catch (error) {
    toast("Error al revisar gramática", "error");
  }
}

// Tipos de issue válidos: el "type" viene del JSON del modelo y se interpola
// en atributos class — whitelist para evitar inyección de HTML.
const ISSUE_TYPES = ["grammar", "spelling", "clarity", "tone"];

function safeIssueType(issue) {
  return issue && ISSUE_TYPES.includes(issue.type) ? issue.type : "grammar";
}

async function fixAllGrammar() {
  if (state.grammar.issues.length === 0) return;

  try {
    const text = dom.grammarInput.value;
    let corrected = text;

    // Aplicar correcciones de derecha a izquierda para preservar índices.
    // Los índices los inventa el modelo: validarlos ANTES de cortar el texto.
    const sorted = [...state.grammar.issues].sort((a, b) => b.start - a.start);
    let applied = 0;
    for (const issue of sorted) {
      if (!issue.suggestion) continue;
      const start = Number(issue.start);
      const end = Number(issue.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      if (start < 0 || start >= end || end > corrected.length) continue;

      if (corrected.slice(start, end) === issue.text) {
        corrected = corrected.slice(0, start) + issue.suggestion + corrected.slice(end);
        applied++;
        continue;
      }
      // Índice equivocado: intentar localizar el texto exacto del issue
      const found = corrected.indexOf(issue.text);
      if (found !== -1) {
        corrected = corrected.slice(0, found) + issue.suggestion + corrected.slice(found + issue.text.length);
        applied++;
      }
    }

    if (applied === 0) {
      toast("Ninguna corrección se pudo aplicar con seguridad", "info");
      return;
    }

    dom.grammarInput.value = corrected;
    state.grammar.issues = [];
    state.grammar.score = 100;
    state.grammar.counts = { grammar: 0, spelling: 0, clarity: 0, tone: 0 };
    renderGrammarStats();
    dom.grammarOutput.innerHTML = '<div class="grammar-stats__empty">✨ Texto corregido</div>';
    toast("Gramática corregida", "ok");
  } catch (error) {
    toast("Error al aplicar correcciones", "error");
  }
}

function clearGrammarEditor() {
  dom.grammarInput.value = "";
  dom.grammarOutput.innerHTML = "";
  state.grammar.issues = [];
  state.grammar.score = 100;
  state.grammar.counts = { grammar: 0, spelling: 0, clarity: 0, tone: 0 };
  renderGrammarStats();
}

async function checkGrammarForText(text, messageId) {
  try {
    const response = await window.novaAPI.checkGrammar({
      text,
      model: state.selectedModel || state.settings.model || ""
    });

    if (response.ok && response.issues) {
      // Almacenar issues asociados al mensaje
      // En una implementación completa, se mostrarían en el mensaje
      console.log(`[Nova] Issues para mensaje ${messageId}:`, response.issues);
    }
  } catch (error) {
    // Silencioso para no interrumpir el chat
  }
}

function computeGrammarScore() {
  const { issues } = state.grammar;
  const total = issues.length;

  if (total === 0) {
    state.grammar.score = 100;
    state.grammar.counts = { grammar: 0, spelling: 0, clarity: 0, tone: 0 };
    return;
  }

  const counts = { grammar: 0, spelling: 0, clarity: 0, tone: 0 };
  for (const issue of issues) {
    if (counts[issue.type] !== undefined) counts[issue.type] += 1;
  }
  state.grammar.counts = counts;

  const weight = 5;
  state.grammar.score = Math.max(0, 100 - total * weight);
}

function renderGrammarStats() {
  if (!dom.grammarStats || !dom.grammarScore) return;

  const { score, counts, issues } = state.grammar;

  dom.grammarScore.textContent = score;
  dom.grammarScore.className = "grammar-stats__score";
  if (score >= 90) dom.grammarScore.classList.add("grammar-stats__score--good");
  else if (score >= 70) dom.grammarScore.classList.add("grammar-stats__score--warn");
  else dom.grammarScore.classList.add("grammar-stats__score--poor");

  if (dom.grammarCountGrammar) dom.grammarCountGrammar.textContent = `${counts.grammar} gramática`;
  if (dom.grammarCountSpelling) dom.grammarCountSpelling.textContent = `${counts.spelling} ortografía`;
  if (dom.grammarCountClarity) dom.grammarCountClarity.textContent = `${counts.clarity} claridad`;
  if (dom.grammarCountTone) dom.grammarCountTone.textContent = `${counts.tone} tono`;

  if (dom.grammarList && dom.grammarEmpty) {
    dom.grammarList.innerHTML = "";
    if (issues.length === 0) {
      dom.grammarEmpty.style.display = "block";
      dom.grammarList.style.display = "none";
    } else {
      dom.grammarEmpty.style.display = "none";
      dom.grammarList.style.display = "flex";

      const typeLabels = {
        grammar: "Gramática",
        spelling: "Ortografía",
        clarity: "Claridad",
        tone: "Tono"
      };

      for (const issue of issues.slice(0, 10)) {
        const type = safeIssueType(issue);
        const item = document.createElement("div");
        item.className = `grammar-stats__item grammar-stats__item--${type}`;
        item.innerHTML = `
          <span class="grammar-stats__item-type grammar-stats__item-type--${type}">${typeLabels[type]}</span>
          <span class="grammar-stats__item-text">${escapeHtml(issue.text)}</span>
          <span class="grammar-stats__item-suggestion">→ ${escapeHtml(issue.suggestion || issue.text)}</span>
        `;
        dom.grammarList.appendChild(item);
      }
    }
  }
}

function displayGrammarIssues(issues) {
  if (!dom.grammarOutput) return;

  if (issues.length === 0) {
    dom.grammarOutput.innerHTML = '<div class="grammar-stats__empty">✨ Sin problemas de redacción</div>';
    return;
  }

  const typeLabels = {
    grammar: "Gramática",
    spelling: "Ortografía",
    clarity: "Claridad",
    tone: "Tono"
  };

  dom.grammarOutput.innerHTML = issues.map((issue) => {
    const type = safeIssueType(issue);
    return `
    <div class="grammar-stats__item grammar-stats__item--${type}">
      <span class="grammar-stats__item-type grammar-stats__item-type--${type}">${typeLabels[type]}</span>
      <span class="grammar-stats__item-text">${escapeHtml(issue.text)}</span>
      <span class="grammar-stats__item-suggestion">→ ${escapeHtml(issue.suggestion || issue.text)}</span>
    </div>
  `;
  }).join("");
}

// ============================================================================
// Acciones rápidas (chips)
// ============================================================================
async function handleQuickAction(action) {
  const text = dom.promptInput.value.trim();
  if (!text) return;

  const prompts = {
    summarize: "Resume el siguiente texto de forma concisa en viñetas:",
    translate: "Traduce el siguiente texto al español:",
    explain: "Explica el siguiente texto de forma clara y sencilla:",
    grammar: "Corrige la gramática y ortografía del siguiente texto:"
  };

  const prompt = prompts[action];
  if (!prompt) return;

  dom.promptInput.value = `${prompt}\n\n${text}`;
  autoResizeTextarea();
  if (typeof dom.composerForm.requestSubmit === "function") {
    dom.composerForm.requestSubmit();
  } else {
    dom.composerForm.dispatchEvent(new Event("submit"));
  }
}

// ============================================================================
// Utilidades
// ============================================================================
function generateId() {
  return "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function autoResizeTextarea() {
  const textarea = dom.promptInput;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function toast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
  `;
  dom.toasts.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function switchSection(section) {
  // Actualizar navegación
  dom.navItems.forEach((item) => {
    item.classList.toggle("nav-item--active", item.dataset.section === section);
  });

  // Actualizar paneles
  dom.panels.forEach((panel) => {
    panel.classList.toggle("panel--active", panel.id === `panel-${section}`);
  });

  // Si es gramática, cargar estadísticas
  if (section === "grammar" && state.settings.grammarEnabled) {
    renderGrammarStats();
  }
}

// ============================================================================
// Persistencia
// ============================================================================
async function saveConversation() {
  if (!window.novaAPI || !window.novaAPI.saveConversation) return;
  try {
    await window.novaAPI.saveConversation(state.messages);
  } catch (_) {
    /* silencioso: persistir no debe romper el chat */
  }
}

async function loadConversation() {
  if (!window.novaAPI || !window.novaAPI.loadConversation) return;
  try {
    const result = await window.novaAPI.loadConversation();
    if (result && result.ok && Array.isArray(result.messages) && result.messages.length > 0) {
      state.messages = result.messages;
      for (const message of state.messages) {
        dom.messages.appendChild(createMessageElement(message));
      }
      scrollToBottom();
    }
  } catch (_) {
    /* silencioso */
  }
}

// Iniciar la aplicación
init().catch((error) => {
  console.error("[Nova] init falló:", error);
  toast("Error al iniciar Nova Chat", "error");
});
