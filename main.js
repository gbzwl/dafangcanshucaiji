import { app, BrowserWindow, dialog, Menu, shell, utilityProcess } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PORT = Number(process.env.PORT || 9091);
const isDev = !app.isPackaged;

let mainWindow = null;
let serverProcess = null;
let shutdownStarted = false;
let shutdownComplete = false;
let serverExited = true;

function log(message) {
  try {
    const logDir = app.getPath('userData');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'app.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never prevent the application from starting.
  }
}

process.on('uncaughtException', error => log(`uncaughtException: ${error.stack || error.message}`));
process.on('unhandledRejection', error => log(`unhandledRejection: ${error?.stack || error}`));
log('main process loaded');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '大放设备参数采集工具',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  if (isDev && process.env.ELECTRON_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  const dataDir = isDev ? path.join(__dirname, 'temp') : app.getPath('userData');
  serverProcess = utilityProcess.fork(serverPath, [], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      APP_DATA_DIR: dataDir,
      NODE_ENV: isDev ? 'development' : 'production'
    },
    stdio: 'pipe',
    serviceName: 'Device Collector Server'
  });
  serverExited = false;
  serverProcess.on('spawn', () => log(`server process started: pid=${serverProcess.pid}, dataDir=${dataDir}`));

  serverProcess.stdout?.on('data', data => console.log(`[Server] ${data.toString().trim()}`));
  serverProcess.stderr?.on('data', data => console.error(`[Server] ${data.toString().trim()}`));
  serverProcess.on('exit', code => {
    serverExited = true;
    log(`server process exited: code=${code}`);
    serverProcess = null;
    if (shutdownStarted || code === 0) return;
    dialog.showErrorBox('服务异常', `后端服务已停止（退出码：${code ?? '未知'}）。`);
    app.quit();
  });
}

function probeServer() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(`http://127.0.0.1:${SERVER_PORT}/api/v1/health`, response => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.setTimeout(800, () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });
}

async function waitForServer(maxRetries = 60) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (await probeServer()) return;
    if (!serverProcess || serverExited) throw new Error('后端服务进程已经退出');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('后端服务启动超时');
}

function stopServer() {
  return new Promise(resolve => {
    const child = serverProcess;
    if (!child || serverExited) {
      resolve();
      return;
    }

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    child.once('exit', done);
    child.postMessage({ type: 'shutdown' });
    setTimeout(() => {
      if (!serverExited) child.kill();
      done();
    }, 5000).unref();
  });
}

function setupMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    }
  ]));
}

app.whenReady().then(async () => {
  log('electron ready');
  setupMenu();
  if (await probeServer()) {
    log(`port ${SERVER_PORT} is already in use`);
    dialog.showErrorBox('无法启动', `端口 ${SERVER_PORT} 已有采集服务运行，请先将它关闭。`);
    app.quit();
    return;
  }

  startServer();
  try {
    await waitForServer();
    log('server ready, creating window');
    createWindow();
  } catch (error) {
    log(`startup failed: ${error.stack || error.message}`);
    dialog.showErrorBox('启动失败', error.message);
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow && !shutdownStarted) createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  log('application shutdown started');
  stopServer().finally(() => {
    shutdownComplete = true;
    log('application shutdown complete');
    app.quit();
  });
});
