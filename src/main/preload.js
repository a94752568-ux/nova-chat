const { contextBridge, ipcRenderer } = require("electron");

// ============================================================================
// API expuesta al renderer (solo lo permitido)
// ============================================================================
contextBridge.exposeInMainWorld("novaAPI", {
  // Configuración
  getSettings: () => ipcRenderer.invoke("app:get-settings"),
  setSettings: (settings) => ipcRenderer.invoke("app:set-settings", settings),

  // Ollama
  checkOllamaHealth: () => ipcRenderer.invoke("ollama:health"),
  listModels: () => ipcRenderer.invoke("ollama:models"),
  chat: (payload) => ipcRenderer.invoke("ollama:chat", payload),

  // Chat en streaming: main reenvía los fragmentos por eventos IPC filtrados
  // por requestId. Devuelve { cancel, cleanup } para abortar la generación.
  chatStream: (payload, handlers) => {
    const requestId = payload && payload.requestId;
    const matches = (data) => data && data.requestId === requestId;

    const onChunk = (_e, data) => {
      if (matches(data) && handlers && handlers.onChunk) handlers.onChunk(data.chunk);
    };
    const onDone = (_e, data) => {
      if (matches(data)) {
        cleanup();
        if (handlers && handlers.onDone) handlers.onDone(data);
      }
    };
    const onAborted = (_e, data) => {
      if (matches(data)) {
        cleanup();
        if (handlers && handlers.onAborted) handlers.onAborted(data);
      }
    };
    const onError = (_e, data) => {
      if (matches(data)) {
        cleanup();
        if (handlers && handlers.onError) handlers.onError(data && data.error);
      }
    };
    const cleanup = () => {
      ipcRenderer.removeListener("ollama:chunk", onChunk);
      ipcRenderer.removeListener("ollama:done", onDone);
      ipcRenderer.removeListener("ollama:aborted", onAborted);
      ipcRenderer.removeListener("ollama:error", onError);
    };

    ipcRenderer.on("ollama:chunk", onChunk);
    ipcRenderer.on("ollama:done", onDone);
    ipcRenderer.on("ollama:aborted", onAborted);
    ipcRenderer.on("ollama:error", onError);

    ipcRenderer.invoke("ollama:chat-stream", payload).catch((error) => {
      cleanup();
      if (handlers && handlers.onError) handlers.onError(error && error.message);
    });

    return {
      cancel: () => ipcRenderer.invoke("ollama:abort", requestId),
      cleanup
    };
  },

  // Historial de conversaciones
  saveConversation: (payload) => ipcRenderer.invoke("conversations:save", payload),
  loadConversation: (id) => ipcRenderer.invoke("conversations:load", id),
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  deleteConversation: (id) => ipcRenderer.invoke("conversations:delete", id),

  // Notas locales (RAG ligero)
  listNotes: () => ipcRenderer.invoke("notes:list"),
  addNote: (text) => ipcRenderer.invoke("notes:add", text),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),

  // Gramática (tipo Grammarly)
  checkGrammar: ({ text, model }) =>
    ipcRenderer.invoke("grammar:check", { text, model }),

  // Exportar conversacion (dialogo nativo de guardado)
  exportMarkdown: (payload) => ipcRenderer.invoke("export:markdown", payload),

  // Informe del sistema (habilidades locales del chat)
  systemInfo: () => ipcRenderer.invoke("system:info"),

  // Sistema
  quit: () => ipcRenderer.invoke("app:quit"),
  minimize: () => ipcRenderer.invoke("app:minimize"),
  maximize: () => ipcRenderer.invoke("app:maximize"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Eventos
  on: (channel, listener) => {
    const validChannels = ["app:settings-changed", "ollama:status-changed"];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, listener);
    }
  },
  off: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener);
  },
  send: (channel, data) => {
    const validSendChannels = ["app:open-settings"];
    if (validSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  }
});



