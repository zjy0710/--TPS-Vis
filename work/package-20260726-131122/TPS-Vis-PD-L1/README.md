# TPS-Vis

基于论文 *TPS-Vis: Interactive Visual Exploration of PD-L1 Expression in
Lung Cancer Pathology Images* Fig.1 架构实现的交互式前端原型。

## 功能

- 病例浏览、搜索与标本类型筛选
- Patch 临床分级过滤、排序与精确居中的 fly-to 空间定位
- IHC 全切片最高 3200% 鼠标锚点缩放、平移、缩略图与原始 Patch 组成的两级图像金字塔
- 基于 Patch 数据的 TPS KDE 热力图
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

网页初始为空工作台，不预载示例病例、切片、Patch 或细胞图像。点击右上角的“选择病例文件夹”，在系统对话框中选择一个未压缩的病例文件夹，再点击“选择文件夹”或“打开”。只有解析成功后才会显示病例图像与统计结果；数据仅在浏览器本地处理，不会上传到服务器。

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

全片主视图在低倍下使用浏览器可直接解码的 `thumbnail.png`；放大到 180%
以上时，网页会按当前视野加载 `patches/` 中的 512×512 原始图像瓦片，形成
“缩略图层 + 原始 Patch 层”的两级图像金字塔。超大尺寸的 `stitched.jpg`
不在浏览器中整张解码，从而避免浏览器尺寸限制和过高内存占用。原始 Patch
瓦片在独立的屏幕坐标图层中按最终显示尺寸绘制，避免高倍缩放时被浏览器作为
低分辨率整层纹理再次放大。瓦片最多同时解码 6 张，解码成功后才显示；失败
会自动重试，加载期间继续显示缩略图底层，不出现浏览器破图图标。

界面中展示的数值和细胞标记用于研究性可视分析演示，不构成临床诊断。
