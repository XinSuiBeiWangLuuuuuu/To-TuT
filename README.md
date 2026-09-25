# MemoryEarth 回忆地球

一个 Windows 桌面程序：3D 地球 + 地点标注 + 照片 + 感受。

## 技术栈

- Electron：桌面外壳
- CesiumJS：3D 地球
- sql.js：纯 JS 的 SQLite（**无需任何原生编译**）
- Vite + electron-builder + electron-updater

## 安装

```bash
npm install
```

## 开发运行

```bash
npm run dev
```

## 打包

```bash
npm run dist
```

安装包在 `release/` 下。安装时可自由选择目录，支持装到 D 盘。

## 数据位置

生产环境数据存放在「安装目录 / data」：

- `data/memory.db`：数据库
- `data/photos/`：照片

## 自动更新

1. 修改 `package.json` 中 `build.publish.owner` 和 `repo` 为你的 GitHub 信息。
2. 设置 Token：`$env:GH_TOKEN="你的token"`。
3. 每次发版：

```bash
# 改 package.json 的 version
git add .
git commit -m "release: v1.0.1"
git tag v1.0.1
git push origin main --tags
npm run dist:publish
```