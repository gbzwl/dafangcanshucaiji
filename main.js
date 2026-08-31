/**
 * Electron 主进程 - MRI采集工具桌面应用入口
 */
import { app, BrowserWindow, shell, dialog, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 9091;

// 开发模式检测
const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'MRI设备日志参数采集工具',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    // 窗口样式
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    backgroundColor: '#F0F4F8',
    show: false
  });

  // 优雅显示窗口（避免白屏闪烁）
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 加载页面
  if (isDev) {
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
  }

  // 外部链接在浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 启动 Express 后端服务
 */
function startServer() {
  const serverPath = path.join(__dirname, 'server.js');

  serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      NODE_ENV: isDev ? 'development' : 'production'
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error('启动服务失败:', err);
    dialog.showErrorBox('启动失败', `后端服务启动失败: ${err.message}`);
  });

  serverProcess.on('exit', (code) => {
    console.log(`服务进程退出，代码: ${code}`);
    if (code !== 0 && code !== null) {
      dialog.showErrorBox('服务异常', '后端服务意外退出，应用将关闭。');
      app.quit();
    }
  });
}

/**
 * 等待服务就绪
 */
function waitForServer(maxRetries = 30) {
  return new Promise((resolve, reject) => {
    let retries = 0;

    const check = () => {
      const http = require('http');
      const req = http.get(`http://localhost:${SERVER_PORT}/api/v1/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });

      req.on('error', retry);
      req.setTimeout(1000, retry);
    };

    const retry = () => {
      retries++;
      if (retries >= maxRetries) {
        reject(new Error('服务启动超时'));
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

// ===== 应用生命周期 =====

// macOS 默认应用菜单
function setupMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' }
      ]
    },
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
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'MRI设备日志参数采集工具',
              detail: `版本: 1.0.0\n平台: ${process.platform}\n架构: ${process.arch}\nElectron: ${process.versions.electron}\nNode.js: ${process.versions.node}`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  setupMenu();

  // 启动后端服务
  startServer();

  try {
    // 等待服务就绪
    await waitForServer();
    console.log('后端服务已就绪');
  } catch (err) {
    console.error('等待服务就绪失败:', err);
    dialog.showErrorBox('启动失败', '后端服务未能在规定时间内就绪，请重试。');
    app.quit();
    return;
  }

  // 创建窗口
  createWindow();

  // macOS: 点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出应用（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出前清理
app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});
