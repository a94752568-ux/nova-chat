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

  // Gramática (tipo Grammarly)
  checkGrammar: ({ text, model }) =>
    ipcRenderer.invoke("grammar:check", { text, model }),

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

// Tipo para TypeScript (opcional, solo documentación)
// window.novaAPI = novaAPI;
