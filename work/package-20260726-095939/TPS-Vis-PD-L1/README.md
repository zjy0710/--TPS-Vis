# TPS-Vis

基于论文 *TPS-Vis: Interactive Visual Exploration of PD-L1 Expression in
Lung Cancer Pathology Images* Fig.1 架构实现的交互式前端原型。

## 功能

- 病例浏览、搜索与标本类型筛选
- Patch 临床分级过滤、排序与 fly-to 空间定位
- IHC 全切片缩放、平移、基于 Patch 数据的 TPS KDE 热力图
- 最近两个 ROI 的 TPS 对照、网格吸附与 Patch Gallery 联动
- 1001 个细粒度 TPS bin、临床分级带与 ROI 统计
- 细胞表型、P(cell) 概率图和多尺度证据链
- 悬浮式、上下文感知的病理洞察问答

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

## 导入本地病例文件夹

打开网页后，点击右上角的“选择病例文件夹”，在系统对话框中选择一个未压缩的病例文件夹，再点击“选择文件夹”或“打开”。网页会在浏览器本地解析文件，不会把病例数据上传到服务器。

文件夹至少应包含：

```text
病例文件夹/
├─ wsi_summary.json
├─ patches_manifest.csv
├─ thumbnail.png              # 也可使用 stitched.jpg
└─ patches/
   └─ <patch_id>/
      ├─ image.jpg
      ├─ cells_overlay.png
      └─ heatmap_overlay.png
```

ZIP 压缩包仅用于传递示例数据，网页实际选择的是解压后的文件夹。

当病例文件夹同时包含 `thumbnail.png` 与 `stitched.jpg` 时，缩略导航使用
`thumbnail.png`，主阅片视图优先使用高清 `stitched.jpg`。

界面中展示的数值和细胞标记用于研究性可视分析演示，不构成临床诊断。
