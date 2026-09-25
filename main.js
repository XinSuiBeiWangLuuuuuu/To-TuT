const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;

let win = null;
let db = null;
let DB_PATH = '';
let settings = {
  defaultWindowMode: 'fullscreen',
  mediaDir: '',
  hasSeenTutorial: false,
  userName: '',
  defaultPlaceAdded: false,
  softwareBgmPath: ''
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'photo',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

// ---------- 设置 ----------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const s = JSON.parse(raw);
    return {
      defaultWindowMode: ['fullscreen', 'maximized', 'windowed'].includes(s.defaultWindowMode)
        ? s.defaultWindowMode
        : 'fullscreen',
      mediaDir: typeof s.mediaDir === 'string' ? s.mediaDir : '',
      hasSeenTutorial: s.hasSeenTutorial === true,
      userName: typeof s.userName === 'string' ? s.userName : '',
      defaultPlaceAdded: s.defaultPlaceAdded === true,
      softwareBgmPath: typeof s.softwareBgmPath === 'string' ? s.softwareBgmPath : ''
    };
  } catch {
    return {
      defaultWindowMode: 'fullscreen',
      mediaDir: '',
      hasSeenTutorial: false,
      userName: '',
      defaultPlaceAdded: false,
      softwareBgmPath: ''
    };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('[MemoryEarth] 保存设置失败：', e.message);
  }
}

function getMediaDir() {
  let dir = settings.mediaDir;
  if (!dir || !dir.trim()) {
    dir = path.join(app.getPath('userData'), 'photos');
    settings.mediaDir = dir;
    saveSettings();
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[MemoryEarth] 创建媒体目录失败：', e.message);
  }
  return dir;
}

function getBgmDir() {
  const dir = path.join(getMediaDir(), 'bgm');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

// ---------- 草稿 ----------
function draftPath() {
  return path.join(app.getPath('userData'), 'draft.json');
}
function loadDraft() {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(), 'utf-8'));
    if (d && typeof d === 'object' && typeof d.lat === 'number' && typeof d.lon === 'number') return d;
    return null;
  } catch {
    return null;
  }
}
function writeDraft(draft) {
  try {
    if (!draft) {
      try { fs.unlinkSync(draftPath()); } catch (_) {}
      return;
    }
    fs.writeFileSync(draftPath(), JSON.stringify(draft, null, 2));
  } catch (e) {
    console.error('[MemoryEarth] 保存草稿失败:', e.message);
  }
}

// ---------- 里程碑 ----------
const MILESTONES = {
  1: { emoji: '🌱', title: '第一个坐标', text: '从今以后，这颗星球上有了属于你的第一个地方。\n从这里开始，你的地球有了温度。' },
  10: { emoji: '✨', title: '十个地方', text: '十个坐标，十段回忆。\n你已经在地球上留下了一串小小的脚印。' },
  20: { emoji: '🌿', title: '二十个地方', text: '二十个地方了。\n回头看看，你已经走过了这么远。' },
  50: { emoji: '🌏', title: '五十个地方', text: '五十个坐标，像散落在地球上的星星。\n把它们连起来，就是你的故事。' },
  100: { emoji: '🌌', title: '一百个地方', text: '一百个地方。\n地球这么大，而你，已经认真地走过了这么多。' }
};

// ---------- 数据库 ----------
function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function dbOne(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDB();
}
function dbInsert(sql, params = []) {
  db.run(sql, params);
  const row = dbOne('SELECT last_insert_rowid() AS id');
  saveDB();
  return row ? row.id : null;
}

async function initDB() {
  const wasmBinary = fs.readFileSync(
    path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
  );
  const SQL = await initSqlJs({ wasmBinary });

  DB_PATH = path.join(app.getPath('userData'), 'memory.db');
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      feeling TEXT DEFAULT '',
      content TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      kind TEXT DEFAULT 'image',
      caption TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS place_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id INTEGER NOT NULL,
      name TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_photos_place ON photos(place_id);
    CREATE INDEX IF NOT EXISTS idx_revisions_place ON place_revisions(place_id);
  `);

  const placeCols = dbAll('PRAGMA table_info(places)');
  if (!placeCols.some((c) => c.name === 'category_id')) {
    db.exec('ALTER TABLE places ADD COLUMN category_id INTEGER DEFAULT NULL');
  }
  if (!placeCols.some((c) => c.name === 'content')) {
    db.exec("ALTER TABLE places ADD COLUMN content TEXT DEFAULT ''");
    db.exec("UPDATE places SET content = feeling WHERE (content IS NULL OR content = '') AND feeling IS NOT NULL AND feeling != ''");
  }
  if (!placeCols.some((c) => c.name === 'is_default')) {
    db.exec('ALTER TABLE places ADD COLUMN is_default INTEGER DEFAULT 0');
  }
  if (!placeCols.some((c) => c.name === 'is_favorite')) {
    db.exec('ALTER TABLE places ADD COLUMN is_favorite INTEGER DEFAULT 0');
  }
  if (!placeCols.some((c) => c.name === 'bgm_file')) {
    db.exec("ALTER TABLE places ADD COLUMN bgm_file TEXT DEFAULT ''");
  }

  const photoCols = dbAll('PRAGMA table_info(photos)');
  if (!photoCols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE photos ADD COLUMN kind TEXT DEFAULT 'image'");
  }
  if (!photoCols.some((c) => c.name === 'file_path')) {
    db.exec("ALTER TABLE photos ADD COLUMN file_path TEXT DEFAULT ''");
  }

  const legacyDir = path.join(app.getPath('userData'), 'photos');
  const needFill = dbAll("SELECT id, file_name FROM photos WHERE (file_path IS NULL OR file_path = '') AND file_name != ''");
  for (const p of needFill) {
    dbRun('UPDATE photos SET file_path = ? WHERE id = ?', [path.join(legacyDir, p.file_name), p.id]);
  }

  saveDB();
}

// ============================================================
// 数据迁移：旧版数据在安装目录下，新版迁到系统 userData
// ============================================================
function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile() && !fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

function migrateLegacyDataIfNeeded() {
  const appDataDir = app.getPath('userData');
  const appDataDB = path.join(appDataDir, 'memory.db');

  // 已有数据，不迁移
  if (fs.existsSync(appDataDB)) return;
  if (!app.isPackaged) return;

  // 检查旧的安装目录
  const installDir = path.dirname(app.getPath('exe'));
  const legacyDir = path.join(installDir, 'data');
  const legacyDB = path.join(legacyDir, 'memory.db');
  if (!fs.existsSync(legacyDB)) return;

  console.log('[MemoryEarth] 检测到旧版数据，开始迁移');
  console.log('  源：', legacyDir);
  console.log('  目标：', appDataDir);

  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.copyFileSync(legacyDB, appDataDB);

    for (const name of ['settings.json', 'draft.json']) {
      const src = path.join(legacyDir, name);
      const dst = path.join(appDataDir, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }

    const legacyPhotos = path.join(legacyDir, 'photos');
    const targetPhotos = path.join(appDataDir, 'photos');
    if (fs.existsSync(legacyPhotos)) {
      copyDirRecursive(legacyPhotos, targetPhotos);
    }

    console.log('[MemoryEarth] 数据迁移完成');
  } catch (e) {
    console.error('[MemoryEarth] 数据迁移失败：', e.message);
  }
}

function insertDefaultPlaceIfNeeded() {
  if (settings.defaultPlaceAdded) return;
  try {
    const row = dbOne('SELECT COUNT(*) AS c FROM places');
    const count = row ? row.c : 0;
    if (count === 0) {
      const id = dbInsert(
        'INSERT INTO places (name, lat, lon, category_id, is_default) VALUES (?, ?, ?, ?, 1)',
        ['记得找我玩', 31.11229, 121.05652, null]
      );
      console.log('[MemoryEarth] 已插入默认地点：记得找我玩（上海青浦区）');
    }
    settings.defaultPlaceAdded = true;
    saveSettings();
  } catch (e) {
    console.error('[MemoryEarth] 插入默认地点失败：', e.message);
  }
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '回忆地球',
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => {
    if (settings.defaultWindowMode === 'fullscreen') win.setFullScreen(true);
    else if (settings.defaultWindowMode === 'maximized') win.maximize();
  });

  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, 'dist', 'index.html'));

  win.on('closed', () => { win = null; });
}

// ---------- 菜单 ----------
function buildMenuTemplate() {
  const mode = settings.defaultWindowMode;
  return [
    { label: '文件', submenu: [{ label: '退出', accelerator: 'Alt+F4', click: () => app.quit() }] },
    {
      label: '视图',
      submenu: [
        { label: '全屏切换', accelerator: 'F11', click: () => { if (win) win.setFullScreen(!win.isFullScreen()); } },
        { label: '最大化切换', click: () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize(); } } },
        { type: 'separator' },
        {
          label: '默认屏幕设置（下次启动生效）',
          submenu: [
            { label: '启动时全屏', type: 'radio', checked: mode === 'fullscreen', click: () => setDefaultWindowMode('fullscreen') },
            { label: '启动时最大化', type: 'radio', checked: mode === 'maximized', click: () => setDefaultWindowMode('maximized') },
            { label: '启动时普通窗口', type: 'radio', checked: mode === 'windowed', click: () => setDefaultWindowMode('windowed') }
          ]
        },
        { type: 'separator' },
        { label: '设置媒体存放目录…', click: () => chooseMediaDir() },
        { label: '打开媒体存放目录', click: () => shell.openPath(getMediaDir()) },
        { label: '打开数据存放目录', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '新手教程', click: () => { if (win && !win.isDestroyed()) win.webContents.send('show-tutorial'); } },
        { label: '重新设置名字', click: () => { if (win && !win.isDestroyed()) win.webContents.send('show-name-prompt'); } },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: '回忆地球 MemoryEarth',
              detail: `版本: ${app.getVersion()}\n用户: ${settings.userName || '（未设置）'}\n数据目录: ${app.getPath('userData')}\n媒体目录: ${getMediaDir()}`,
              buttons: ['确定']
            });
          }
        }
      ]
    }
  ];
}

function rebuildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function setDefaultWindowMode(mode) {
  if (!['fullscreen', 'maximized', 'windowed'].includes(mode)) return;
  settings.defaultWindowMode = mode;
  saveSettings();
  rebuildMenu();
  const label = mode === 'fullscreen' ? '全屏' : mode === 'maximized' ? '最大化' : '普通窗口';
  if (win && !win.isDestroyed()) win.webContents.send('toast', `默认屏幕设置已保存为「${label}」，下次启动生效`);
}

// ---------- 媒体目录迁移 ----------
async function chooseMediaDir() {
  const currentDir = getMediaDir();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择媒体存放目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: currentDir
  });
  if (canceled || !filePaths.length) return;
  const newDir = filePaths[0];
  if (path.normalize(newDir) === path.normalize(currentDir)) return;

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '迁移现有文件',
    message: '是否把现有图片、视频、音乐迁移到新目录？',
    detail: `旧目录: ${currentDir}\n新目录: ${newDir}`,
    buttons: ['复制文件', '移动文件', '不迁移'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });

  const oldDir = currentDir;
  settings.mediaDir = newDir;
  saveSettings();
  fs.mkdirSync(newDir, { recursive: true });
  rebuildMenu();

  if (response === 0 || response === 1) {
    const mode = response === 0 ? 'copy' : 'move';
    const result = await migrateMediaFiles(oldDir, newDir, mode);
    // 更新 BGM 路径
    const placesWithBgm = dbAll("SELECT id, bgm_file FROM places WHERE bgm_file != ''");
    for (const p of placesWithBgm) {
      if (p.bgm_file && path.normalize(p.bgm_file).startsWith(path.normalize(oldDir))) {
        const rel = path.relative(oldDir, p.bgm_file);
        dbRun('UPDATE places SET bgm_file = ? WHERE id = ?', [path.join(newDir, rel), p.id]);
      }
    }
    if (settings.softwareBgmPath && path.normalize(settings.softwareBgmPath).startsWith(path.normalize(oldDir))) {
      const rel = path.relative(oldDir, settings.softwareBgmPath);
      settings.softwareBgmPath = path.join(newDir, rel);
      saveSettings();
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('toast', `已${mode === 'copy' ? '复制' : '移动'} ${result.done} 个文件`);
      win.webContents.send('media-dir-changed');
    }
  }
}

async function migrateMediaFiles(oldDir, newDir, mode) {
  const photos = dbAll('SELECT id, file_path FROM photos');
  const normalizedOld = path.normalize(oldDir);
  let done = 0, failed = 0;

  for (const p of photos) {
    if (!p.file_path) continue;
    if (!path.normalize(p.file_path).startsWith(normalizedOld + path.sep)) continue;
    const rel = path.relative(oldDir, p.file_path);
    const target = path.join(newDir, rel);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (mode === 'move') fs.renameSync(p.file_path, target);
      else fs.copyFileSync(p.file_path, target);
      dbRun('UPDATE photos SET file_path = ? WHERE id = ?', [target, p.id]);
      done++;
    } catch (e) {
      console.error('迁移失败', p.file_path, e.message);
      failed++;
    }
  }
  return { done, failed };
}

// ---------- MIME ----------
function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac'
  }[ext] || 'application/octet-stream';
}

// ---------- 更新 ----------
function sendUpdateStatus(status, data = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', { status, ...data });
}
function initAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => sendUpdateStatus('available', { version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Number(p.percent.toFixed(1)) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdateStatus('downloaded', { version: i.version }));
  autoUpdater.on('error', (e) => sendUpdateStatus('error', { message: e?.message || String(e) }));
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error('[MemoryEarth] 检查更新失败：', e.message));
  }, 5000);
}

// ---------- 搜索/反查 ----------
async function amapQuery(keywords) {
  const AMAP_KEY = '87255c0295b5d07a04ca05d5af2ac404';
  if (!AMAP_KEY || AMAP_KEY.includes('你的')) return [];
  try {
    const url = `https://restapi.amap.com/v3/place/text?key=${AMAP_KEY}&keywords=${encodeURIComponent(keywords)}&offset=6&page=1`;
    const res = await net.fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== '1' || !data.pois || !data.pois.length) return [];
    return data.pois.map((poi) => {
      const [lon, lat] = poi.location.split(',').map(Number);
      return { name: `${poi.name}（${poi.cityname || poi.adname || ''}）`, lat, lon, source: 'amap' };
    });
  } catch (e) {
    console.error('[amap]', e.message);
    return [];
  }
}
async function searchAmap(q) {
  let r = await amapQuery(q);
  if (r.length) return r;
  const suffixes = ['区', '市', '县', '镇', '街道'];
  if (suffixes.some((s) => q.endsWith(s))) return [];
  for (const s of suffixes) {
    r = await amapQuery(q + s);
    if (r.length) return r;
  }
  return [];
}
async function searchOpenMeteo(q) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
    const res = await net.fetch(url, { headers: { 'User-Agent': 'MemoryEarth/1.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.results || !data.results.length) return [];
    return data.results.map((r) => {
      const parts = [r.name, r.admin1, r.country].filter(Boolean);
      return { name: [...new Set(parts)].join('，'), lat: r.latitude, lon: r.longitude, source: 'openmeteo' };
    });
  } catch (e) {
    console.error('[openmeteo]', e.message);
    return [];
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function reverseGeoAmap(lat, lon) {
  const AMAP_KEY = '87255c0295b5d07a04ca05d5af2ac404';
  if (!AMAP_KEY || AMAP_KEY.includes('你的')) return '';
  try {
    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP_KEY}&location=${lon},${lat}&extensions=base`;
    const res = await fetchWithTimeout(url, {}, 3500);
    if (!res.ok) return '';
    const data = await res.json();
    if (data.status !== '1' || !data.regeocode) return '';
    return data.regeocode.formatted_address || '';
  } catch (e) {
    console.error('[amap reverse]', e.message);
    return '';
  }
}
async function reverseGeoWorld(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`;
    const res = await fetchWithTimeout(url, {}, 3500);
    if (!res.ok) return '';
    const data = await res.json();
    const parts = [data.locality, data.city, data.principalSubdivision].filter(Boolean);
    return [...new Set(parts)].join('，');
  } catch (e) {
    console.error('[world reverse]', e.message);
    return '';
  }
}

// ---------- IPC ----------
function registerIPC() {
  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    mediaDir: getMediaDir(),
    installDir: app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname,
    isPackaged: app.isPackaged
  }));

  ipcMain.handle('window:exit-fullscreen', () => { if (win) win.setFullScreen(false); return true; });
  ipcMain.handle('window:toggle-fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); return win ? win.isFullScreen() : false; });
  ipcMain.handle('window:is-fullscreen', () => (win ? win.isFullScreen() : false));

  ipcMain.handle('settings:get', () => ({
    defaultWindowMode: settings.defaultWindowMode,
    mediaDir: getMediaDir(),
    hasSeenTutorial: settings.hasSeenTutorial,
    userName: settings.userName,
    softwareBgmPath: settings.softwareBgmPath
  }));
  ipcMain.handle('settings:set-window-mode', (_, mode) => { setDefaultWindowMode(mode); return true; });
  ipcMain.handle('settings:choose-media-dir', () => chooseMediaDir());
  ipcMain.handle('settings:set-tutorial-seen', () => { settings.hasSeenTutorial = true; saveSettings(); return true; });
  ipcMain.handle('settings:reset-tutorial', () => {
    settings.hasSeenTutorial = false;
    saveSettings();
    if (win && !win.isDestroyed()) win.webContents.send('show-tutorial');
    return true;
  });
  ipcMain.handle('settings:set-username', (_, name) => {
    settings.userName = String(name || '').trim().slice(0, 30);
    saveSettings();
    return settings.userName;
  });
  ipcMain.handle('settings:get-username', () => settings.userName);

  // 软件 BGM
  ipcMain.handle('settings:choose-software-bgm', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择软件背景音乐',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }]
    });
    if (canceled || !filePaths.length) return null;
    const src = filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const fileName = `software-${Date.now()}${ext}`;
    const target = path.join(getBgmDir(), fileName);
    fs.copyFileSync(src, target);
    settings.softwareBgmPath = target;
    saveSettings();
    return target;
  });
  ipcMain.handle('settings:clear-software-bgm', () => {
    settings.softwareBgmPath = '';
    saveSettings();
    return true;
  });

  // 草稿
  ipcMain.handle('draft:load', () => loadDraft());
  ipcMain.handle('draft:save', (_, d) => { writeDraft(d); return true; });
  ipcMain.handle('draft:clear', () => { writeDraft(null); return true; });

  // 更新
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  });
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  // 分类
  ipcMain.handle('categories:list', () => dbAll('SELECT * FROM categories ORDER BY created_at ASC'));
  ipcMain.handle('categories:add', (_, name) => {
    const id = dbInsert('INSERT INTO categories (name) VALUES (?)', [name]);
    return dbOne('SELECT * FROM categories WHERE id = ?', [id]);
  });
  ipcMain.handle('categories:rename', (_, { id, name }) => {
    dbRun('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
    return dbOne('SELECT * FROM categories WHERE id = ?', [id]);
  });
  ipcMain.handle('categories:delete', (_, id) => {
    dbRun('UPDATE places SET category_id = NULL WHERE category_id = ?', [id]);
    dbRun('DELETE FROM categories WHERE id = ?', [id]);
    return true;
  });

  // 地点
  ipcMain.handle('places:list', () => dbAll('SELECT * FROM places ORDER BY created_at ASC'));

  ipcMain.handle('places:add', (_, { name, lat, lon, category_id }) => {
    const id = dbInsert(
      'INSERT INTO places (name, lat, lon, category_id) VALUES (?, ?, ?, ?)',
      [name || '新地点', lat, lon, category_id ?? null]
    );
    const place = dbOne('SELECT * FROM places WHERE id = ?', [id]);

    const row = dbOne('SELECT COUNT(*) AS c FROM places WHERE is_default = 0');
    const count = row ? row.c : 0;
    if (MILESTONES[count] && win && !win.isDestroyed()) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('celebrate-milestone', { count, ...MILESTONES[count] });
        }
      }, 700);
    }
    return place;
  });

  ipcMain.handle('places:update', (_, { id, name, content, category_id, lat, lon, is_favorite, bgm_file }) => {
    const old = dbOne('SELECT * FROM places WHERE id = ?', [id]);
    if (!old) return null;

    const newName = name ?? old.name;
    const newContent = content !== undefined ? content : old.content;
    const newCat = category_id !== undefined ? category_id : old.category_id;
    const newLat = lat !== undefined ? lat : old.lat;
    const newLon = lon !== undefined ? lon : old.lon;
    const newFav = is_favorite !== undefined ? (is_favorite ? 1 : 0) : old.is_favorite;
    const newBgm = bgm_file !== undefined ? bgm_file : (old.bgm_file || '');

    if (newContent !== old.content || newName !== old.name) {
      dbInsert('INSERT INTO place_revisions (place_id, name, content) VALUES (?, ?, ?)', [id, old.name, old.content || '']);
      const revisions = dbAll('SELECT id FROM place_revisions WHERE place_id = ? ORDER BY created_at DESC', [id]);
      if (revisions.length > 20) {
        for (const r of revisions.slice(20)) dbRun('DELETE FROM place_revisions WHERE id = ?', [r.id]);
      }
    }

    dbRun(
      'UPDATE places SET name = ?, content = ?, category_id = ?, lat = ?, lon = ?, is_favorite = ?, bgm_file = ? WHERE id = ?',
      [newName, newContent, newCat, newLat, newLon, newFav, newBgm, id]
    );
    return dbOne('SELECT * FROM places WHERE id = ?', [id]);
  });

  ipcMain.handle('places:toggle-favorite', (_, id) => {
    const old = dbOne('SELECT * FROM places WHERE id = ?', [id]);
    if (!old) return null;
    dbRun('UPDATE places SET is_favorite = ? WHERE id = ?', [old.is_favorite ? 0 : 1, id]);
    return dbOne('SELECT * FROM places WHERE id = ?', [id]);
  });

  ipcMain.handle('places:set-bgm', async (_, placeId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择这个地点的背景音乐',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }]
    });
    if (canceled || !filePaths.length) return null;
    const src = filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const fileName = `place-${placeId}-${Date.now()}${ext}`;
    const target = path.join(getBgmDir(), fileName);
    fs.copyFileSync(src, target);
    dbRun('UPDATE places SET bgm_file = ? WHERE id = ?', [target, placeId]);
    return target;
  });

  ipcMain.handle('places:clear-bgm', (_, placeId) => {
    dbRun("UPDATE places SET bgm_file = '' WHERE id = ?", [placeId]);
    return true;
  });

  ipcMain.handle('places:delete', (_, id) => {
    const files = dbAll('SELECT file_path FROM photos WHERE place_id = ?', [id]);
    for (const f of files) {
      if (f.file_path) { try { fs.unlinkSync(f.file_path); } catch (_) {} }
    }
    const place = dbOne('SELECT bgm_file FROM places WHERE id = ?', [id]);
    if (place && place.bgm_file) { try { fs.unlinkSync(place.bgm_file); } catch (_) {} }
    dbRun('DELETE FROM photos WHERE place_id = ?', [id]);
    dbRun('DELETE FROM place_revisions WHERE place_id = ?', [id]);
    dbRun('DELETE FROM places WHERE id = ?', [id]);
    return true;
  });

  ipcMain.handle('places:delete-batch', (_, ids) => {
    if (!Array.isArray(ids) || !ids.length) return 0;
    let deleted = 0;
    for (const id of ids) {
      const files = dbAll('SELECT file_path FROM photos WHERE place_id = ?', [id]);
      for (const f of files) {
        if (f.file_path) { try { fs.unlinkSync(f.file_path); } catch (_) {} }
      }
      const place = dbOne('SELECT bgm_file FROM places WHERE id = ?', [id]);
      if (place && place.bgm_file) { try { fs.unlinkSync(place.bgm_file); } catch (_) {} }
      dbRun('DELETE FROM photos WHERE place_id = ?', [id]);
      dbRun('DELETE FROM place_revisions WHERE place_id = ?', [id]);
      dbRun('DELETE FROM places WHERE id = ?', [id]);
      deleted++;
    }
    return deleted;
  });

  // 版本
  ipcMain.handle('revisions:list', (_, placeId) => dbAll('SELECT * FROM place_revisions WHERE place_id = ? ORDER BY created_at DESC', [placeId]));
  ipcMain.handle('revisions:restore', (_, { placeId, revisionId }) => {
    const rev = dbOne('SELECT * FROM place_revisions WHERE id = ?', [revisionId]);
    if (!rev) return null;
    const current = dbOne('SELECT * FROM places WHERE id = ?', [placeId]);
    if (!current) return null;
    dbInsert('INSERT INTO place_revisions (place_id, name, content) VALUES (?, ?, ?)', [placeId, current.name, current.content || '']);
    dbRun('UPDATE places SET name = ?, content = ? WHERE id = ?', [rev.name, rev.content, placeId]);
    return dbOne('SELECT * FROM places WHERE id = ?', [placeId]);
  });
  ipcMain.handle('revisions:delete', (_, id) => { dbRun('DELETE FROM place_revisions WHERE id = ?', [id]); return true; });

  // 媒体
  ipcMain.handle('media:list', (_, placeId) => dbAll('SELECT * FROM photos WHERE place_id = ? ORDER BY created_at ASC', [placeId]));
  ipcMain.handle('media:add', async (_, { placeId, kind }) => {
    const filters = kind === 'video'
      ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] }]
      : [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }];
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: kind === 'video' ? '选择视频' : '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters
    });
    if (canceled || !filePaths.length) return [];
    const dir = getMediaDir();
    const inserted = [];
    for (const src of filePaths) {
      const ext = path.extname(src).toLowerCase();
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      const target = path.join(dir, fileName);
      fs.copyFileSync(src, target);
      const id = dbInsert('INSERT INTO photos (place_id, file_name, file_path, kind) VALUES (?, ?, ?, ?)', [placeId, fileName, target, kind]);
      inserted.push(dbOne('SELECT * FROM photos WHERE id = ?', [id]));
    }
    return inserted;
  });
  ipcMain.handle('media:save-buffer', async (_, { placeId, kind, fileName, buffer }) => {
    const safeName = String(fileName).replace(/[^\w.\-]/g, '_');
    const target = path.join(getMediaDir(), safeName);
    fs.writeFileSync(target, Buffer.from(buffer));
    const id = dbInsert('INSERT INTO photos (place_id, file_name, file_path, kind) VALUES (?, ?, ?, ?)', [placeId, safeName, target, kind]);
    return dbOne('SELECT * FROM photos WHERE id = ?', [id]);
  });
  ipcMain.handle('media:delete', (_, photoId) => { dbRun('DELETE FROM photos WHERE id = ?', [photoId]); return true; });

  // 搜索
  ipcMain.handle('geo:search', async (_, q) => {
    if (!q || !q.trim()) return [];
    const [amap, intl] = await Promise.all([searchAmap(q), searchOpenMeteo(q)]);
    return [...amap, ...intl].slice(0, 15);
  });
  ipcMain.handle('geo:reverse', async (_, { lat, lon }) => {
    try {
      return await Promise.race([
        (async () => {
          const amap = await reverseGeoAmap(lat, lon);
          if (amap) return { name: amap, source: 'amap' };
          const world = await reverseGeoWorld(lat, lon);
          if (world) return { name: world, source: 'world' };
          return { name: '', source: '' };
        })(),
        new Promise((r) => setTimeout(() => r({ name: '', source: 'timeout' }), 8000))
      ]);
    } catch (e) {
      console.error('[geo:reverse]', e);
      return { name: '', source: 'error' };
    }
  });
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  migrateLegacyDataIfNeeded();   // ← 加这一行，必须在 loadSettings 之前

  settings = loadSettings();
  if (!settings.mediaDir || !settings.mediaDir.trim()) {
    settings.mediaDir = path.join(app.getPath('userData'), 'photos');
    saveSettings();
  }
  fs.mkdirSync(settings.mediaDir, { recursive: true });

  try {
    await initDB();
  } catch (e) {
    dialog.showErrorBox('数据库初始化失败', String(e && e.message ? e.message : e));
    app.quit();
    return;
  }

  insertDefaultPlaceIfNeeded();
  rebuildMenu();

  protocol.handle('photo', async (req) => {
    try {
      const url = new URL(req.url);
      const b64 = url.pathname.replace(/^\//, '');
      if (!b64) return new Response('bad request', { status: 400 });
      const filePath = path.normalize(Buffer.from(decodeURIComponent(b64), 'base64').toString('utf-8'));
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('not file', { status: 400 });
      const data = await fs.promises.readFile(filePath);
      return new Response(data, { headers: { 'content-type': mimeOf(filePath) } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });

  registerIPC();
  createWindow();

  if (app.isPackaged) initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});