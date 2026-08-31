# MRI设备日志参数自动采集工具

一款 Windows 桌面端的 MRI 设备日志参数自动采集工具，支持离线运行，无需服务器依赖。

## 功能特性

- **磁盘自动检测** - 自动识别系统所有磁盘分区（含系统盘和外部存储盘）
- **Excel 模板驱动** - 通过 Excel 模板定义采集规则（数据指标、文件路径、关键字）
- **智能文件扫描** - 按预设路径（MedCom\log、MriSiteData、SysUtil）和文件类型（*.log、*.mrs、*.txt、*.xml）自动搜索
- **模糊文件匹配** - 支持文件名、文件夹名、路径片段的模糊匹配，无需绝对路径
- **多格式参数提取** - 支持数值、字符串、时间、带单位参数的自动提取
- **多编码支持** - 自动检测 UTF-8、GBK、GB2312、UTF-16 等编码
- **Excel 结果输出** - 生成包含采集结果、未找到列表、扫描日志的完整报告

## 快速开始

### 环境要求

- Node.js >= 18
- Windows 10/11（目标运行环境）

### 安装依赖

```bash
cd mri-collector
pnpm install
```

### 开发模式运行

```bash
# 启动后端服务（浏览器访问 http://localhost:9091）
pnpm run dev
```

### 打包为 Windows 桌面应用

```bash
# 安装 Electron 开发依赖
pnpm add -D electron electron-builder

# 打包为 exe
pnpm run build
```

打包完成后，`dist/` 目录下会生成 `MRICollector Setup x.x.x.exe` 安装包。

## Excel 模板格式

模板必须包含以下三个字段：

| 数据指标 | 文件路径 | 关键字 |
|---------|---------|--------|
| 磁场强度 | MedCom/log | FieldStrength |
| 梯度线圈温度 | MriSiteData | GradientTemp |
| 系统运行时长 | SysUtil | UptimeHours |
| 射频功率 | MedCom/log | RF_Power |
| 冷头压力 | MriSiteData | ColdHeadPressure |

### 字段说明

- **数据指标**: 要采集的参数名称（用于结果展示）
- **文件路径**: 模糊匹配路径，支持：
  - 目录名：`MedCom/log`、`MriSiteData`、`SysUtil`
  - 文件名片段：`system`、`report`
  - 通配符：`*.mrs`、`gradient_*`
- **关键字**: 在日志文件中搜索的关键字，支持以下格式的参数提取：
  - `keyword = value` / `keyword: value`
  - `<keyword>value</keyword>`（XML 格式）
  - `keyword 数值+单位`（如 `25.5W`、`23.5°C`）
  - `keyword 时间格式`（如 `2024-01-15 10:30:00`）

## 项目结构

```
mri-collector/
├── main.js                 # Electron 主进程入口
├── preload.js              # Electron preload 脚本
├── server.js               # Express 后端服务
├── core/
│   ├── scanner.js          # 磁盘检测模块
│   ├── matcher.js          # 文件扫描与匹配引擎
│   ├── extractor.js        # 关键字搜索与参数提取
│   └── excel-handler.js    # Excel 模板解析与结果生成
├── public/
│   ├── index.html          # 前端页面
│   ├── style.css           # 样式
│   └── app.js              # 前端交互逻辑
├── assets/
│   └── icon.ico            # 应用图标
├── package.json
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| GET | `/api/v1/disks` | 获取可用磁盘列表 |
| POST | `/api/v1/template/upload` | 上传并解析 Excel 模板 |
| GET | `/api/v1/template/example` | 下载模板示例 |
| POST | `/api/v1/scan` | 扫描磁盘中的匹配文件 |
| POST | `/api/v1/extract` | 从单个文件中提取参数 |
| POST | `/api/v1/collect` | 执行完整采集任务 |
| GET | `/api/v1/result/download` | 下载采集结果 Excel |

## 输出文件

采集完成后生成 `MRI采集结果.xlsx`，包含三个工作表：

1. **采集结果** - 所有指标的采集结果（指标名、结果值、文件路径、关键字、匹配行）
2. **未找到列表** - 未成功采集的指标及原因
3. **扫描日志** - 扫描时间、文件数量、成功/失败数量、耗时等统计信息

## 技术栈

- **前端**: HTML5 + CSS3 + Vanilla JavaScript
- **后端**: Express.js + Node.js
- **Excel 处理**: SheetJS (xlsx)
- **编码处理**: iconv-lite
- **桌面打包**: Electron + electron-builder

## 离线运行说明

本工具设计为完全离线运行：
- 所有依赖打包进单个 exe 文件
- 不依赖网络连接
- 不依赖外部服务器
- 模板解析和参数提取均在本地完成
