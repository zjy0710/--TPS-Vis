# TPS-Vis

基于论文 *TPS-Vis: Interactive Visual Exploration of PD-L1 Expression in
Lung Cancer Pathology Images* Fig.1 架构实现的交互式前端原型。

## 功能

- 病例浏览、搜索与标本类型筛选
- Patch 临床分级过滤、排序与 fly-to 空间定位
- IHC 全切片缩放、平移、TPS 热力图与网格吸附 ROI
- 1001 个细粒度 TPS bin、临床分级带与 ROI 统计
- 细胞表型、P(cell) 概率图和多尺度证据链
- 基于受控模板的上下文感知病理洞察问答

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

界面中展示的数值和细胞标记用于研究性可视分析演示，不构成临床诊断。
