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
    persona: "nova",
    grammarEnabled: false,
    autocompleteEnabled: true,
    theme: "dark",
    autoStart: false,
    minimizeToTray: true
  },
  models: [],
  selectedModel: "",
  messages: [],
  conversationId: null,
  notes: [],
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
  dom.grammarOverlay = $("#grammar-overlay");
  dom.btnCheckCurrent = $("#btn-check-current");
  dom.btnFixAll = $("#btn-fix-all");
  dom.btnClearGrammar = $("#btn-clear-grammar");
  dom.grammarOutput = $("#grammar-output");

  // Verbose en tiempo real (barras cyberpunk)
  dom.verbose = $("#nova-verbose");
  dom.verboseBars = $("#verbose-bars");
  dom.verboseLabel = $("#verbose-label");
  dom.verboseDetail = $("#verbose-detail");

  // Historial
  dom.historyList = $("#history-list");

  // Poder local
  dom.settingPersona = $("#setting-persona");
  dom.noteInput = $("#note-input");
  dom.btnAddNote = $("#btn-add-note");
  dom.notesList = $("#notes-list");

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
  state.conversationId = "conv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
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

  // Nueva conversacion (chat fresco; la anterior ya esta guardada)
  if (dom.btnNewChat) {
    dom.btnNewChat.addEventListener("click", startNewChat);
  }

  // Acciones de burbuja y bloques de codigo (delegacion)
  if (dom.messages) {
    dom.messages.addEventListener("click", handleBubbleActionClick);
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

// Los botones del editor de gramática (Revisar / Corregir todo / Limpiar).
// NOTA: esta función DEBE existir — setupEventListeners() la llama antes de
// setupSettingsListeners(); si falta, el ReferenceError mata init() y deja
// sin listeners el tema y TODA la configuración (bug del 2026-11-14).
function setupGrammarListeners() {
  if (dom.btnCheckCurrent) {
    dom.btnCheckCurrent.addEventListener("click", checkGrammarInEditor);
  }
  if (dom.btnFixAll) {
    dom.btnFixAll.addEventListener("click", fixAllGrammar);
  }
  if (dom.btnClearGrammar) {
    dom.btnClearGrammar.addEventListener("click", clearGrammarEditor);
  }
  if (dom.grammarInput) {
    // Fase 3: subrayados en vivo + re-check con debounce mientras escribes
    dom.grammarInput.addEventListener("input", handleGrammarInputLive);
    dom.grammarInput.addEventListener("scroll", syncGrammarOverlayScroll);
  }
  window.addEventListener("resize", renderGrammarOverlay);
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

  if (dom.settingPersona) {
    dom.settingPersona.addEventListener("change", (e) => {
      state.settings.persona = e.target.value;
    });
  }

  if (dom.btnAddNote) {
    dom.btnAddNote.addEventListener("click", addNoteFromInput);
  }
  if (dom.notesList) {
    dom.notesList.addEventListener("click", (e) => {
      const btn = e.target.closest(".note-item__delete");
      if (btn && btn.dataset.noteId) deleteNoteById(btn.dataset.noteId);
    });
  }

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
    if (dom.settingPersona) dom.settingPersona.value = state.settings.persona || "nova";
    dom.settingMinimizeTray.checked = state.settings.minimizeToTray;
    dom.settingAutoStart.checked = state.settings.autoStart;

    $("#temp-value").textContent = state.settings.temperature;
    $("#num-ctx-value").textContent = state.settings.numCtx;

    state.grammar.enabled = state.settings.grammarEnabled;
    // Si la gramática estaba activada, mostrar el panel de estadísticas
    // (antes quedaba oculto hasta que tocaras el checkbox otra vez)
    if (dom.grammarStats) dom.grammarStats.hidden = !state.grammar.enabled;

    // Aplicar tema
    applyTheme();

    // Notas locales (RAG ligero)
    loadNotes();
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
    persona: "nova",
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

  // Comandos slash: poder local, nunca llegan al modelo
  if (text.startsWith("/")) {
    handleSlashCommand(text);
    return;
  }

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
    // Los mensajes locales (comandos slash) jamás viajan al modelo.
    const systemPrompt = buildSystemPrompt(text);
    const messages = state.messages.slice(-10).filter((m) => !m.local).map((m) => ({
      role: m.role,
      content: m.content
    }));
    if (systemPrompt) messages.unshift({ role: "system", content: systemPrompt });

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
  showVerbose("TRANSMITIENDO · " + model);

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
    hideVerbose();
    dom.btnStop.hidden = true;
    dom.btnSend.hidden = false;

    if (fullContent.trim()) {
      assistantMessage.durationMs = Date.now() - assistantMessage.createdAt;
      updateMessageMeta(messageElement, assistantMessage);
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
          contentElement.innerHTML = renderMarkdown(fullContent);
          scrollToBottom();
          // Verbose en vivo: caracteres recibidos y velocidad
          const elapsed = (Date.now() - assistantMessage.createdAt) / 1000;
          const cps = elapsed > 0 ? fullContent.length / elapsed : 0;
          updateVerbose(fullContent.length + " chars · " + cps.toFixed(1) + " ch/s");
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
  if (isUser) {
    bubble.className = "bubble";
    bubble.textContent = message.content;
  } else {
    // Markdown renderizado (escape-first) para respuestas del modelo
    bubble.className = "bubble bubble--md";
    bubble.innerHTML = renderMarkdown(message.content);
  }

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

  const actions = document.createElement("div");
  actions.className = "bubble-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "bubble-action";
  copyBtn.dataset.action = "copy-msg";
  copyBtn.textContent = "Copiar";
  actions.appendChild(copyBtn);
  if (isUser) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "bubble-action";
    editBtn.dataset.action = "edit-msg";
    editBtn.textContent = "Editar";
    actions.appendChild(editBtn);
  } else {
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "bubble-action";
    regenBtn.dataset.action = "regen-msg";
    regenBtn.textContent = "Regenerar";
    actions.appendChild(regenBtn);
  }

  column.appendChild(bubble);
  column.appendChild(meta);
  column.appendChild(actions);
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
  if (!state.messages.length) return;
  if (!confirm("¿Estás seguro de que quieres limpiar la conversación?")) return;
  state.messages = [];
  dom.messages.innerHTML = "";
  // La conversacion limpiada tambien sale del historial
  if (window.novaAPI && window.novaAPI.deleteConversation && state.conversationId) {
    window.novaAPI.deleteConversation(state.conversationId).catch(function () {});
  }
}

function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

// ============================================================================
// Markdown ligero para respuestas del modelo (escape-first: el contenido del
// modelo NUNCA se inyecta como HTML sin escapar) + acciones de burbuja.
// ============================================================================

// Una sola pasada de tokens: strings, comentarios, keywords y numeros.
// Asi ningun reemplazo cae dentro del HTML insertado por el anterior.
const CODE_TOKEN_RE = new RegExp(
  "(\"[^\"\\n]*\"|'[^'\\n]*')" +
  "|(//[^\\n]*|/\\*[\\s\\S]*?\\*/)" +
  "|\\b(function|return|if|else|elif|for|while|const|let|var|class|import|from|export|def|new|in|of|true|false|null|undefined|None|True|False|async|await|try|catch|except|finally|switch|case|break|continue|print|echo|public|private|static|void|int|float|bool|this|self|super|extends|implements|interface|enum)\\b" +
  "|\\b(\\d+(?:\\.\\d+)?)\\b",
  "g"
);

function highlightCode(code) {
  return escapeHtml(code).replace(CODE_TOKEN_RE, function (m, str, com, kw, num) {
    if (str) return '<span class="tok-str">' + str + "</span>";
    if (com) return '<span class="tok-com">' + com + "</span>";
    if (kw) return '<span class="tok-kw">' + kw + "</span>";
    if (num) return '<span class="tok-num">' + num + "</span>";
    return m;
  });
}

function codeBlockHtml(block) {
  if (!block) return "";
  const lang = block.lang ? escapeHtml(block.lang) : "";
  return (
    '<div class="md-codeblock"><div class="md-codeblock__bar">' +
    '<span class="md-codeblock__lang">' + lang + "</span>" +
    '<button type="button" class="md-copy" data-action="copy-code" title="Copiar codigo">Copiar</button>' +
    "</div><pre><code>" + highlightCode(block.code) + "</code></pre></div>"
  );
}

function renderMarkdown(raw) {
  if (!raw) return "";
  const blocks = [];
  // 1) Bloques de codigo cercados -> placeholders antes de escapar
  let text = String(raw).replace(/```([A-Za-z0-9_+-]*)\r?\n?([\s\S]*?)```/g, function (m, lang, code) {
    blocks.push({ lang: lang || "", code: code.replace(/\r/g, "").replace(/\n$/, "") });
    return "\x01CB" + (blocks.length - 1) + "\x01";
  });
  // 2) Escapar TODO el resto (el modelo no puede inyectar HTML)
  text = escapeHtml(text);
  // 3) Inline: codigo, negritas, italicas y enlaces (solo http/https)
  text = text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // 4) Estructura por lineas: titulos, listas, separadores, parrafos
  const lines = text.split("\n");
  const out = [];
  let list = null;
  let para = [];
  const closeList = function () { if (list) { out.push("</" + list + ">"); list = null; } };
  const closePara = function () { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  for (const line of lines) {
    const t = line.trim();
    const cb = t.match(/^\x01CB(\d+)\x01$/);
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    const ul = t.match(/^[-*+]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (cb) { closePara(); closeList(); out.push(codeBlockHtml(blocks[Number(cb[1])])); continue; }
    if (!t) { closePara(); closeList(); continue; }
    if (h) { closePara(); closeList(); const lvl = Math.min(h[1].length + 2, 6); out.push("<h" + lvl + ">" + h[2] + "</h" + lvl + ">"); continue; }
    if (ul) { closePara(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + ul[1] + "</li>"); continue; }
    if (ol) { closePara(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + ol[1] + "</li>"); continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { closePara(); closeList(); out.push("<hr>"); continue; }
    para.push(t);
  }
  closePara();
  closeList();
  text = out.join("");
  // 5) Placeholders que quedaron a mitad de linea
  text = text.replace(/\x01CB(\d+)\x01/g, function (m, i) {
    return codeBlockHtml(blocks[Number(i)] || { lang: "", code: "" });
  });
  return text;
}

// Acciones de burbuja y bloques de codigo (delegacion en #messages)
function handleBubbleActionClick(event) {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const article = btn.closest(".msg");
  const messageId = article ? article.dataset.id : null;
  if (action === "copy-msg" && messageId) {
    const message = state.messages.find(function (m) { return m.id === messageId; });
    if (message) copyText(message.content);
  } else if (action === "copy-code") {
    const wrap = btn.closest(".md-codeblock");
    const code = wrap ? wrap.querySelector("code") : null;
    if (code) copyText(code.textContent);
  } else if (action === "regen-msg" && messageId) {
    regenerateMessage(messageId);
  } else if (action === "edit-msg" && messageId) {
    editMessage(messageId);
  }
}

function copyText(text) {
  const done = function () { toast("Copiado al portapapeles", "ok"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  } catch (_) {
    toast("No se pudo copiar", "error");
  }
}

// Regenerar: descarta esta respuesta (y todo lo posterior) y vuelve a pedirle
// al modelo con el mismo contexto.
function regenerateMessage(messageId) {
  if (state.generating) return;
  const index = state.messages.findIndex(function (m) { return m.id === messageId; });
  if (index === -1) return;
  const removed = state.messages.splice(index);
  removed.forEach(function (m) {
    const el = dom.messages.querySelector('.msg[data-id="' + m.id + '"]');
    if (el) el.remove();
  });
  const model = state.selectedModel || state.settings.model || "";
  showTyping();
  dom.composerHint.textContent = "Generando respuesta...";
  const messages = state.messages.slice(-10).filter(function (m) { return !m.local; }).map(function (m) {
    return { role: m.role, content: m.content };
  });
  // Regenerar tambien respeta personalidad + notas: el system prompt se
  // construye a partir del ultimo mensaje del usuario disponible.
  const lastUser = state.messages.filter(function (m) { return m.role === "user"; }).pop();
  const systemPrompt = buildSystemPrompt(lastUser ? lastUser.content : "");
  if (systemPrompt) messages.unshift({ role: "system", content: systemPrompt });
  runChatStream(model, messages).catch(function (error) {
    console.error("[Nova] Error al regenerar:", error);
    hideTyping();
    toast("Error al conectar con Ollama", "error");
  });
}

// Editar: devuelve el texto al compositor y trunca la conversacion desde ese
// mensaje; el reenvio lo hace el usuario con Enter (flujo tipo ChatGPT).
function editMessage(messageId) {
  if (state.generating) return;
  const index = state.messages.findIndex(function (m) { return m.id === messageId; });
  if (index === -1) return;
  dom.promptInput.value = state.messages[index].content;
  autoResizeTextarea();
  const removed = state.messages.splice(index);
  removed.forEach(function (m) {
    const el = dom.messages.querySelector('.msg[data-id="' + m.id + '"]');
    if (el) el.remove();
  });
  dom.promptInput.focus({ preventScroll: true });
  saveConversation();
}

// Nueva conversacion: chat fresco; la anterior ya quedo guardada.
function startNewChat() {
  state.conversationId = "conv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  state.messages = [];
  dom.messages.innerHTML = "";
  dom.composerHint.textContent = "Nueva conversacion";
  dom.promptInput.focus({ preventScroll: true });
}

// Panel Historial: lista de conversaciones guardadas (se refresca al abrir).
async function renderHistory() {
  if (!dom.historyList || !window.novaAPI || !window.novaAPI.listConversations) return;
  dom.historyList.innerHTML = '<div class="history-empty">Cargando...</div>';
  try {
    const result = await window.novaAPI.listConversations();
    const conversations = (result && result.conversations) || [];
    dom.historyList.innerHTML = "";
    if (!conversations.length) {
      dom.historyList.innerHTML = '<div class="history-empty">Aun no hay conversaciones guardadas</div>';
      return;
    }
    conversations.forEach(function (conv) {
      const item = document.createElement("div");
      item.className = "history-item";
      const main = document.createElement("button");
      main.type = "button";
      main.className = "history-item__main";
      const title = document.createElement("span");
      title.className = "history-item__title";
      title.textContent = conv.title || "Conversacion";
      const sub = document.createElement("span");
      sub.className = "history-item__sub";
      const when = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString() : "";
      sub.textContent = (conv.count || 0) + " mensajes - " + when;
      main.appendChild(title);
      main.appendChild(sub);
      main.addEventListener("click", async function () {
        if (state.generating) { toast("Espera a que termine la generacion", "info"); return; }
        await loadConversation(conv.id);
        switchSection("chat");
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "history-item__delete";
      del.innerHTML = "&times;";
      del.title = "Eliminar conversacion";
      del.setAttribute("aria-label", "Eliminar conversacion");
      del.addEventListener("click", async function (e) {
        e.stopPropagation();
        try { await window.novaAPI.deleteConversation(conv.id); } catch (_) {}
        if (state.conversationId === conv.id) {
          state.conversationId = null;
          state.messages = [];
          dom.messages.innerHTML = "";
        }
        renderHistory();
      });
      item.appendChild(main);
      item.appendChild(del);
      dom.historyList.appendChild(item);
    });
  } catch (_) {
    dom.historyList.innerHTML = '<div class="history-empty">No se pudo cargar el historial</div>';
  }
}

// ============================================================================
// Poder local: personalidades, notas (RAG ligero) y comandos slash
// ============================================================================

const PERSONAS = {
  nova: {
    name: "Nova",
    desc: "Asistente cercano y calido",
    prompt: "Eres Nova, un asistente cercano, calido y directo. Respondes en espanol, con tono amable y claro. Usas markdown cuando ayuda (listas, bloques de codigo)."
  },
  directa: {
    name: "Directa",
    desc: "Respuestas cortas, sin relleno",
    prompt: "Eres un asistente extremadamente conciso. Respondes en espanol con lo minimo necesario: sin saludos, sin relleno, sin repetir la pregunta. Si la respuesta cabe en una linea, una linea es."
  },
  mentor: {
    name: "Mentor",
    desc: "Explica paso a paso",
    prompt: "Eres un mentor paciente. Explicas paso a paso en espanol, con ejemplos concretos y analogias simples. Al final de una explicacion tecnica sugieres un siguiente ejercicio para practicar."
  },
  coder: {
    name: "Coder",
    desc: "Tecnico, codigo primero",
    prompt: "Eres un ingeniero de software senior. Priorizas el codigo: primero el bloque de codigo completo y funcional, despues una explicacion breve en espanol. Senalas errores y casos borde sin rodeos."
  }
};

function getPersona() {
  return PERSONAS[state.settings.persona] || PERSONAS.nova;
}

// RAG ligero: normaliza texto (minusculas, sin acentos) y lo parte en tokens.
function tokenizeForRag(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

// Puntua las notas del usuario contra el mensaje y devuelve las 3 mas
// relevantes (coincidencia de palabras de 4+ caracteres). Sin embeddings:
// suficiente para notas personales y cero latencia.
function buildRagContext(userText) {
  if (!state.notes || !state.notes.length) return "";
  const queryTokens = tokenizeForRag(userText).split(/\s+/).filter((t) => t.length >= 4);
  if (!queryTokens.length) return "";
  const scored = [];
  for (const note of state.notes) {
    const noteTokens = new Set(tokenizeForRag(note.text).split(/\s+/).filter((t) => t.length >= 4));
    let score = 0;
    for (const token of queryTokens) {
      if (noteTokens.has(token)) score += 1;
    }
    if (score > 0) scored.push({ note, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).map((s) => s.note);
  if (!top.length) return "";
  return top.map((note) => "- " + note.text.slice(0, 400)).join("\n").slice(0, 1500);
}

// System prompt = personalidad activa + notas relevantes. Null si no hay nada.
function buildSystemPrompt(userText) {
  const parts = [];
  const persona = getPersona();
  if (persona && persona.prompt) parts.push(persona.prompt);
  const rag = buildRagContext(userText);
  if (rag) {
    parts.push("Contexto de las notas locales del usuario (usalo si es util, sin mencionar que existe):\n" + rag);
  }
  return parts.length ? parts.join("\n\n") : null;
}

// ----------------------------------------------------------------------------
// Notas locales (RAG ligero)
// ----------------------------------------------------------------------------
async function loadNotes() {
  if (!window.novaAPI || !window.novaAPI.listNotes) return;
  try {
    const result = await window.novaAPI.listNotes();
    state.notes = result && result.ok && Array.isArray(result.notes) ? result.notes : [];
    renderNotes();
  } catch (_) {
    /* silencioso: las notas no deben romper el arranque */
  }
}

function renderNotes() {
  if (!dom.notesList) return;
  dom.notesList.innerHTML = "";
  if (!state.notes.length) {
    const empty = document.createElement("p");
    empty.className = "notes-empty";
    empty.textContent = "Sin notas todavia. Guarda datos, estilo o contexto y Nova los usara cuando sean relevantes.";
    dom.notesList.appendChild(empty);
    return;
  }
  for (const note of state.notes) {
    const item = document.createElement("div");
    item.className = "note-item";
    const text = document.createElement("p");
    text.className = "note-item__text";
    text.textContent = note.text;
    const del = document.createElement("button");
    del.className = "note-item__delete";
    del.dataset.noteId = note.id;
    del.textContent = "\u2715";
    del.title = "Eliminar nota";
    item.appendChild(text);
    item.appendChild(del);
    dom.notesList.appendChild(item);
  }
}

async function addNoteFromInput() {
  const text = dom.noteInput ? dom.noteInput.value.trim() : "";
  if (!text) {
    toast("Escribe el texto de la nota", "error");
    return;
  }
  if (!window.novaAPI || !window.novaAPI.addNote) return;
  try {
    const result = await window.novaAPI.addNote(text.slice(0, 2000));
    if (result && result.ok) {
      if (dom.noteInput) dom.noteInput.value = "";
      await loadNotes();
      toast("Nota guardada", "ok");
    } else {
      toast("No se pudo guardar la nota", "error");
    }
  } catch (_) {
    toast("No se pudo guardar la nota", "error");
  }
}

async function deleteNoteById(id) {
  if (!window.novaAPI || !window.novaAPI.deleteNote) return;
  try {
    await window.novaAPI.deleteNote(id);
    await loadNotes();
  } catch (_) {
    /* silencioso */
  }
}

// ----------------------------------------------------------------------------
// Comandos slash
// ----------------------------------------------------------------------------

// Mensaje local: se muestra en el chat pero NUNCA se envia al modelo
// (handleSendMessage y regenerar filtran los mensajes con local: true).
function addLocalMessage(text) {
  const message = {
    id: generateId(),
    role: "assistant",
    content: text,
    local: true,
    createdAt: Date.now()
  };
  state.messages.push(message);
  dom.messages.appendChild(createMessageElement(message));
  scrollToBottom();
  saveConversation();
}

function personaSummary() {
  return Object.keys(PERSONAS)
    .map((key) => "- **" + key + "** (" + PERSONAS[key].name + "): " + PERSONAS[key].desc)
    .join("\n");
}

// Devuelve true si el texto era un comando (ya se manejo aqui, no enviar).
function handleSlashCommand(raw) {
  const text = raw.trim();
  const spaceIndex = text.indexOf(" ");
  const cmd = (spaceIndex === -1 ? text : text.slice(0, spaceIndex)).toLowerCase();
  const arg = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  switch (cmd) {
    case "/ayuda":
    case "/help":
      addLocalMessage([
        "**Comandos disponibles**",
        "- `/api` — estado de la conexion (URL, modelo, temperatura...)",
        "- `/persona` — lista personalidades · `/persona directa` — cambia y guarda",
        "- `/modelo` — lista modelos · `/modelo llama3.2` — cambia de modelo",
        "- `/temp 0.7` — cambia la temperatura al vuelo",
        "- `/notas` — lista tus notas locales (RAG)",
        "- `/nota texto...` — guarda una nota nueva",
        "- `/ayuda` — esta ayuda"
      ].join("\n"));
      return true;

    case "/api": {
      const persona = getPersona();
      addLocalMessage([
        "**Estado de la API local**",
        "- URL: `" + (state.settings.baseUrl || "(sin definir)") + "`",
        "- Modelo: `" + (state.selectedModel || state.settings.model || "(ninguno)") + "`",
        "- Temperatura: `" + state.settings.temperature + "` · top_p: `" + state.settings.topP + "`",
        "- num_ctx: `" + state.settings.numCtx + "` · keep_alive: `" + (state.settings.keepAlive || "30m") + "`",
        "- Personalidad: **" + persona.name + " (" + state.settings.persona + ")**",
        "- Notas locales: **" + (state.notes ? state.notes.length : 0) + "**"
      ].join("\n"));
      return true;
    }

    case "/persona": {
      if (!arg) {
        addLocalMessage("**Personalidades disponibles**\n\n" + personaSummary() + "\n\nUsa `/persona <id>` para cambiar.");
        return true;
      }
      const key = arg.toLowerCase();
      if (!PERSONAS[key]) {
        addLocalMessage("No conozco la personalidad `" + arg + "`.\n\n" + personaSummary());
        return true;
      }
      state.settings.persona = key;
      if (dom.settingPersona) dom.settingPersona.value = key;
      saveSettings();
      addLocalMessage("Personalidad cambiada a **" + PERSONAS[key].name + "** (" + key + "). Se guarda en tus ajustes.");
      return true;
    }

    case "/modelo": {
      if (!arg) {
        const list = (state.models || [])
          .map((m) => "- `" + (typeof m === "string" ? m : (m && m.name) || "?") + "`")
          .join("\n");
        addLocalMessage(
          "**Modelos instalados**\n\n" + (list || "(no se pudo listar; revisa la conexion con Ollama)") +
          "\n\nActual: `" + (state.selectedModel || state.settings.model || "?") + "`" +
          "\nUsa `/modelo <nombre>` para cambiar."
        );
        return true;
      }
      const match = (state.models || []).find((m) => {
        const name = typeof m === "string" ? m : (m && m.name) || "";
        return name === arg || name.split(":")[0] === arg;
      });
      const chosen = match ? (typeof match === "string" ? match : match.name) : arg;
      state.selectedModel = chosen;
      state.settings.model = chosen;
      if (dom.sidebarModelSelect) dom.sidebarModelSelect.value = chosen;
      if (dom.settingModel) dom.settingModel.value = chosen;
      saveSettings();
      addLocalMessage(
        "Modelo cambiado a `" + chosen + "`. Se guarda en tus ajustes." +
        (match ? "" : "\n\nOjo: ese modelo no aparece en la lista de Ollama; si no existe, el chat fallara.")
      );
      return true;
    }

    case "/temp": {
      const value = Number(arg.replace(",", "."));
      if (!arg || isNaN(value) || value < 0 || value > 2) {
        addLocalMessage("Uso: `/temp <0-2>` — ejemplo: `/temp 0.7`. Actual: `" + state.settings.temperature + "`.");
        return true;
      }
      state.settings.temperature = value;
      if (dom.settingTemperature) dom.settingTemperature.value = String(value);
      const tempValue = $("#temp-value");
      if (tempValue) tempValue.textContent = String(value);
      saveSettings();
      addLocalMessage("Temperatura ajustada a `" + value + "`.");
      return true;
    }

    case "/notas": {
      if (!state.notes || !state.notes.length) {
        addLocalMessage("No tienes notas todavia. Crea una con `/nota <texto>` o desde Ajustes.");
        return true;
      }
      const list = state.notes
        .map((n, i) => (i + 1) + ". " + n.text.slice(0, 80).replace(/\n/g, " "))
        .join("\n");
      addLocalMessage(
        "**Notas locales (" + state.notes.length + ")**\n\n" + list +
        "\n\nNova usa automaticamente las 3 notas mas relevantes en cada mensaje."
      );
      return true;
    }

    case "/nota": {
      if (!arg) {
        addLocalMessage("Uso: `/nota <texto>` — ejemplo: `/nota Prefiero respuestas directas y sin emojis`.");
        return true;
      }
      if (!window.novaAPI || !window.novaAPI.addNote) {
        toast("API de notas no disponible", "error");
        return true;
      }
      window.novaAPI
        .addNote(arg.slice(0, 2000))
        .then((result) => {
          if (result && result.ok) {
            loadNotes();
            addLocalMessage("Nota guardada:\n\n> " + arg.slice(0, 200));
          } else {
            toast("No se pudo guardar la nota", "error");
          }
        })
        .catch(() => toast("No se pudo guardar la nota", "error"));
      return true;
    }

    default:
      toast("Comando desconocido: " + cmd + ". Escribe /ayuda", "error");
      return true;
  }
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
    renderGrammarOverlay();
  }
}

async function requestGrammarCheckForPage() {
  if (!state.settings.grammarEnabled) return;

  showVerbose("ESCANEO GRAMATICAL");
  updateVerbose("consultando al modelo...");
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
  } finally {
    hideVerbose();
  }
}

let grammarCheckInFlight = false;
let grammarRecheckTimer = null;
let grammarLastCheckedText = "";

async function checkGrammarInEditor() {
  const text = dom.grammarInput.value.trim();
  if (!text) {
    toast("Ingresa texto para revisar", "info");
    return;
  }
  if (grammarCheckInFlight) return; // sin doble petición por doble clic
  grammarCheckInFlight = true;
  if (dom.btnCheckCurrent) dom.btnCheckCurrent.disabled = true;
  showVerbose("ESCANEO GRAMATICAL");
  updateVerbose("consultando al modelo...");

  try {
    const response = await window.novaAPI.checkGrammar({
      text,
      model: state.selectedModel || state.settings.model || ""
    });

    if (response.ok && Array.isArray(response.issues)) {
      state.grammar.issues = response.issues;
      computeGrammarScore();
      renderGrammarStats();
      displayGrammarIssues(response.issues);
      grammarLastCheckedText = text;
      renderGrammarOverlay();
    } else {
      // Ollama caído, timeout o error: AVISAR (antes fallaba en silencio
      // y parecía que el botón no hacía nada)
      toast("No se pudo revisar: " + ((response && response.error) || "Ollama no disponible"), "error");
    }
  } catch (error) {
    toast("Error al revisar gramática", "error");
  } finally {
    grammarCheckInFlight = false;
    if (dom.btnCheckCurrent) dom.btnCheckCurrent.disabled = false;
    hideVerbose();
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
    grammarLastCheckedText = corrected;
    renderGrammarOverlay();
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
  grammarLastCheckedText = "";
  renderGrammarStats();
  renderGrammarOverlay();
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
    // Tipos desconocidos del modelo caen en "grammar" (whitelist):
    // antes bajaban el score sin aparecer en ningun contador
    counts[safeIssueType(issue)] += 1;
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
        // Clic en un issue = localizarlo en el texto (como Grammarly)
        item.style.cursor = "pointer";
        item.addEventListener("click", () => locateIssue(issue));
        // Fase 3: boton para corregir SOLO este issue
        const fixBtn = document.createElement("button");
        fixBtn.type = "button";
        fixBtn.className = "grammar-fix-btn";
        fixBtn.textContent = "Corregir";
        if (!issue.suggestion) fixBtn.hidden = true;
        fixBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          fixSingleIssue(issue);
        });
        item.appendChild(fixBtn);
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

  dom.grammarOutput.innerHTML = "";
  issues.forEach((issue) => {
    const type = safeIssueType(issue);
    const item = document.createElement("div");
    item.className = "grammar-stats__item grammar-stats__item--" + type;
    item.innerHTML =
      '<span class="grammar-stats__item-type grammar-stats__item-type--' + type + '">' + typeLabels[type] + '</span>' +
      '<span class="grammar-stats__item-text">' + escapeHtml(issue.text) + '</span>' +
      '<span class="grammar-stats__item-suggestion">→ ' + escapeHtml(issue.suggestion || issue.text) + '</span>';
    // Clic en un issue = localizarlo en el texto (como Grammarly)
    item.style.cursor = "pointer";
    item.addEventListener("click", () => locateIssue(issue));
    // Fase 3: boton para corregir SOLO este issue
    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "grammar-fix-btn";
    fixBtn.textContent = "Corregir";
    if (!issue.suggestion) fixBtn.hidden = true;
    fixBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      fixSingleIssue(issue);
    });
    item.appendChild(fixBtn);
    dom.grammarOutput.appendChild(item);
  });
}

// Localiza un issue en el textarea activo y lo selecciona (como Grammarly).
// Los índices del modelo son orientativos: se validan antes de usarlos.
function locateIssue(issue) {
  if (!issue || !issue.text) return;
  const targets = [dom.grammarInput, dom.promptInput].filter(Boolean);
  for (const textarea of targets) {
    const value = textarea.value;
    if (!value) continue;
    let start = Number(issue.start);
    let end = Number(issue.end);
    const valid = Number.isInteger(start) && Number.isInteger(end)
      && start >= 0 && start < end && end <= value.length
      && value.slice(start, end) === issue.text;
    if (!valid) {
      start = value.indexOf(issue.text);
      end = start === -1 ? -1 : start + issue.text.length;
    }
    if (start !== -1) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      // Aproximar el scroll para que la selección quede a la vista
      const line = value.slice(0, start).split("\n").length - 1;
      textarea.scrollTop = Math.max(0, line * 24 - textarea.clientHeight / 2);
      return;
    }
  }
}

// ----------------------------------------------------------------------------
// Fase 3: subrayados en vivo, correccion por issue y re-check con debounce
// ----------------------------------------------------------------------------

// Valida los indices de un issue contra el texto actual. Si el modelo se
// equivoco de posicion, intenta localizar el texto exacto. Null si ya no existe.
function normalizeIssueRange(issue, text) {
  if (!issue || !issue.text) return null;
  const start = Number(issue.start);
  const end = Number(issue.end);
  const valid = Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && start < end && end <= text.length
    && text.slice(start, end) === issue.text;
  if (valid) return { issue, start, end };
  const found = text.indexOf(issue.text);
  if (found === -1) return null;
  return { issue, start: found, end: found + issue.text.length };
}

// Redibuja los subrayados del overlay sobre el textarea de gramatica.
// El overlay es un espejo del texto (mismo font/padding/line-height, color
// transparente) con spans subrayados por tipo de issue. Todo se construye
// con textContent: el texto del usuario jamas se interpola como HTML.
function renderGrammarOverlay() {
  if (!dom.grammarOverlay || !dom.grammarInput) return;
  const text = dom.grammarInput.value;
  const overlay = dom.grammarOverlay;
  overlay.innerHTML = "";

  const placed = [];
  let cursor = 0;
  const ranges = (state.grammar.issues || [])
    .map((issue) => normalizeIssueRange(issue, text))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    if (range.start < cursor) continue; // sin solapes
    placed.push(range);
    cursor = range.end;
  }

  const frag = document.createDocumentFragment();
  cursor = 0;
  for (const range of placed) {
    if (range.start > cursor) {
      frag.appendChild(document.createTextNode(text.slice(cursor, range.start)));
    }
    const mark = document.createElement("span");
    mark.className = "gul gul--" + safeIssueType(range.issue);
    mark.textContent = text.slice(range.start, range.end);
    frag.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < text.length) {
    frag.appendChild(document.createTextNode(text.slice(cursor)));
  }
  overlay.appendChild(frag);
  syncGrammarOverlayScroll();
}

function syncGrammarOverlayScroll() {
  if (!dom.grammarOverlay || !dom.grammarInput) return;
  dom.grammarOverlay.scrollTop = dom.grammarInput.scrollTop;
}

// Tras editar, los indices viejos quedan desfasados: re-localiza cada issue
// por su texto exacto y suelta los que ya no existen en el texto.
function revalidateGrammarIssues() {
  const text = dom.grammarInput ? dom.grammarInput.value : "";
  if (!text) {
    state.grammar.issues = [];
  } else {
    state.grammar.issues = (state.grammar.issues || []).filter((issue) => {
      return normalizeIssueRange(issue, text) !== null;
    });
  }
  computeGrammarScore();
  renderGrammarStats();
}

// Corregir UN issue: aplica su suggestion, re-localiza los demas y refresca
// lista, stats y subrayados. Las ediciones manuales del usuario nunca se pisan.
function fixSingleIssue(issue) {
  if (!issue || !issue.suggestion) return;
  if (!dom.grammarInput) return;
  const text = dom.grammarInput.value;
  const range = normalizeIssueRange(issue, text);
  if (!range) {
    toast("Ese problema ya no esta en el texto", "info");
    revalidateGrammarIssues();
    renderGrammarOverlay();
    return;
  }
  const corrected = text.slice(0, range.start) + issue.suggestion + text.slice(range.end);
  dom.grammarInput.value = corrected;
  state.grammar.issues = (state.grammar.issues || []).filter((i) => i !== issue);
  revalidateGrammarIssues();
  renderGrammarOverlay();
  grammarLastCheckedText = corrected;
  toast("Corregido: " + issue.text.slice(0, 30), "ok");
}

// Re-check automatico con debounce: mientras escribes en el editor, espera a
// que pares 1.2s y manda la revision solo. Silencioso (sin toasts: el usuario
// esta escribiendo, no pidio una revision explicita) y sin chequeos repetidos
// del mismo texto.
function handleGrammarInputLive() {
  revalidateGrammarIssues();
  renderGrammarOverlay();
  scheduleGrammarRecheck();
}

function scheduleGrammarRecheck() {
  if (grammarRecheckTimer) clearTimeout(grammarRecheckTimer);
  grammarRecheckTimer = setTimeout(autoCheckGrammarEditor, 1200);
}

async function autoCheckGrammarEditor() {
  if (!dom.grammarInput) return;
  const text = dom.grammarInput.value.trim();
  if (!text) return;
  if (text === grammarLastCheckedText) return;
  if (grammarCheckInFlight) {
    // Hay un chequeo en vuelo: reintentar cuando termine
    scheduleGrammarRecheck();
    return;
  }
  grammarCheckInFlight = true;
  if (dom.btnCheckCurrent) dom.btnCheckCurrent.disabled = true;
  showVerbose("ESCANEO GRAMATICAL");
  updateVerbose("re-chequeo automatico...");
  try {
    const response = await window.novaAPI.checkGrammar({
      text,
      model: state.selectedModel || state.settings.model || ""
    });
    if (response.ok && Array.isArray(response.issues)) {
      state.grammar.issues = response.issues;
      computeGrammarScore();
      renderGrammarStats();
      displayGrammarIssues(response.issues);
      grammarLastCheckedText = text;
      renderGrammarOverlay();
    }
  } catch (_) {
    /* silencioso: es un chequeo automatico */
  } finally {
    grammarCheckInFlight = false;
    if (dom.btnCheckCurrent) dom.btnCheckCurrent.disabled = false;
    hideVerbose();
  }
}

// ============================================================================
// Verbose en tiempo real (equalizer cyberpunk)
// ============================================================================
// Muestra actividad de Ollama en vivo: barras animadas + etiqueta + detalle.
// Las barras se generan una sola vez y reutilizan la animacion CSS.
const VERBOSE_BAR_COUNT = 16;

function showVerbose(label) {
  if (!dom.verbose) return;
  if (dom.verboseBars && dom.verboseBars.childElementCount === 0) {
    for (let i = 0; i < VERBOSE_BAR_COUNT; i++) {
      const bar = document.createElement("span");
      bar.className = "nova-verbose__bar";
      // Desfase y duracion variables por barra: efecto equalizer organico
      bar.style.animationDelay = (i * 0.07).toFixed(2) + "s";
      bar.style.animationDuration = (0.55 + (i % 5) * 0.13).toFixed(2) + "s";
      dom.verboseBars.appendChild(bar);
    }
  }
  if (dom.verboseLabel) dom.verboseLabel.textContent = label;
  if (dom.verboseDetail) dom.verboseDetail.textContent = "";
  dom.verbose.hidden = false;
}

function updateVerbose(detail) {
  if (dom.verboseDetail) dom.verboseDetail.textContent = detail;
}

function hideVerbose() {
  if (dom.verbose) dom.verbose.hidden = true;
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

  // Historial: refrescar la lista cada vez que se abre el panel
  if (section === "history") {
    renderHistory();
  }
}

// ============================================================================
// Persistencia
// ============================================================================
async function saveConversation() {
  if (!window.novaAPI || !window.novaAPI.saveConversation) return;
  if (!state.messages.length) return; // nada que guardar
  try {
    await window.novaAPI.saveConversation({ id: state.conversationId, messages: state.messages });
  } catch (_) {
    /* silencioso: persistir no debe romper el chat */
  }
}

// Sin id: carga la conversacion mas reciente. Con id: esa exacta.
async function loadConversation(id) {
  if (!window.novaAPI || !window.novaAPI.loadConversation) return;
  try {
    const result = await window.novaAPI.loadConversation(id);
    const conv = result && result.conversation;
    if (result && result.ok && conv && Array.isArray(conv.messages) && conv.messages.length > 0) {
      state.conversationId = conv.id;
      state.messages = conv.messages;
      dom.messages.innerHTML = "";
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


