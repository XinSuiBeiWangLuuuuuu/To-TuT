const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),

  exitFullscreen: () => ipcRenderer.invoke('window:exit-fullscreen'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setDefaultWindowMode: (mode) => ipcRenderer.invoke('settings:set-window-mode', mode),
  chooseMediaDir: () => ipcRenderer.invoke('settings:choose-media-dir'),
  setTutorialSeen: () => ipcRenderer.invoke('settings:set-tutorial-seen'),
  resetTutorial: () => ipcRenderer.invoke('settings:reset-tutorial'),
  setUserName: (name) => ipcRenderer.invoke('settings:set-username', name),
  getUserName: () => ipcRenderer.invoke('settings:get-username'),

  chooseSoftwareBgm: () => ipcRenderer.invoke('settings:choose-software-bgm'),
  clearSoftwareBgm: () => ipcRenderer.invoke('settings:clear-software-bgm'),

  loadDraft: () => ipcRenderer.invoke('draft:load'),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  clearDraft: () => ipcRenderer.invoke('draft:clear'),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('update-status', l);
    return () => ipcRenderer.removeListener('update-status', l);
  },

  onToast: (cb) => {
    const l = (_, m) => cb(m);
    ipcRenderer.on('toast', l);
    return () => ipcRenderer.removeListener('toast', l);
  },
  onMediaDirChanged: (cb) => {
    const l = () => cb();
    ipcRenderer.on('media-dir-changed', l);
    return () => ipcRenderer.removeListener('media-dir-changed', l);
  },
  onShowTutorial: (cb) => {
    const l = () => cb();
    ipcRenderer.on('show-tutorial', l);
    return () => ipcRenderer.removeListener('show-tutorial', l);
  },
  onShowNamePrompt: (cb) => {
    const l = () => cb();
    ipcRenderer.on('show-name-prompt', l);
    return () => ipcRenderer.removeListener('show-name-prompt', l);
  },
  onMilestone: (cb) => {
    const l = (_, d) => cb(d);
    ipcRenderer.on('celebrate-milestone', l);
    return () => ipcRenderer.removeListener('celebrate-milestone', l);
  },

  listCategories: () => ipcRenderer.invoke('categories:list'),
  addCategory: (name) => ipcRenderer.invoke('categories:add', name),
  renameCategory: (data) => ipcRenderer.invoke('categories:rename', data),
  deleteCategory: (id) => ipcRenderer.invoke('categories:delete', id),

  listPlaces: () => ipcRenderer.invoke('places:list'),
  addPlace: (data) => ipcRenderer.invoke('places:add', data),
  updatePlace: (data) => ipcRenderer.invoke('places:update', data),
  toggleFavorite: (id) => ipcRenderer.invoke('places:toggle-favorite', id),
  setPlaceBgm: (id) => ipcRenderer.invoke('places:set-bgm', id),
  clearPlaceBgm: (id) => ipcRenderer.invoke('places:clear-bgm', id),
  deletePlace: (id) => ipcRenderer.invoke('places:delete', id),
  deletePlacesBatch: (ids) => ipcRenderer.invoke('places:delete-batch', ids),

  listRevisions: (placeId) => ipcRenderer.invoke('revisions:list', placeId),
  restoreRevision: (data) => ipcRenderer.invoke('revisions:restore', data),
  deleteRevision: (id) => ipcRenderer.invoke('revisions:delete', id),

  listMedia: (placeId) => ipcRenderer.invoke('media:list', placeId),
  addMedia: (data) => ipcRenderer.invoke('media:add', data),
  savePastedMedia: (data) => ipcRenderer.invoke('media:save-buffer', data),
  deleteMedia: (photoId) => ipcRenderer.invoke('media:delete', photoId),

  search: (q) => ipcRenderer.invoke('geo:search', q),
  reverseGeo: (data) => ipcRenderer.invoke('geo:reverse', data)
});