"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

type ClinicalBin = "Neg" | "T1" | "T10" | "T50";

type CaseItem = {
  id: string;
  type: "穿刺活检" | "手术切除";
  tps: number;
  totalPatches: number;
  totalCells: number;
};

type PatchItem = {
  id: number;
  x: number;
  y: number;
  tps: number;
  cells: number;
  bin: ClinicalBin;
};

type Roi = {
  x: number;
  y: number;
  w: number;
  h: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
};

type Message = { role: "user" | "agent"; text: string };

const BIN_META: Record<
  ClinicalBin,
  { label: string; range: string; color: string }
> = {
  Neg: { label: "Neg", range: "< 1%", color: "#3b82f6" },
  T1: { label: "T1", range: "1–10%", color: "#22c55e" },
  T10: { label: "T10", range: "10–50%", color: "#f59e0b" },
  T50: { label: "T50", range: "≥ 50%", color: "#ef4444" },
};

const CASES: CaseItem[] = [
  {
    id: "DI2025-020430_2025-03-19_14_16_26",
    type: "手术切除",
    tps: 55.6,
    totalPatches: 63194,
    totalCells: 1976717,
  },
  {
    id: "DI2025-021489_2025-03-18_17_47_56",
    type: "穿刺活检",
    tps: 42.1,
    totalPatches: 46812,
    totalCells: 1543980,
  },
  {
    id: "DI2025-016679_2025-03-10_13_47_56",
    type: "穿刺活检",
    tps: 35.7,
    totalPatches: 58000,
    totalCells: 1976717,
  },
  {
    id: "DI2025-033489_2025-04-29_15_09_15",
    type: "手术切除",
    tps: 22.6,
    totalPatches: 52190,
    totalCells: 1632048,
  },
  {
    id: "DI2025-006301_2025-04-08_15_27_12",
    type: "穿刺活检",
    tps: 14.5,
    totalPatches: 38960,
    totalCells: 1067771,
  },
  {
    id: "DI2025-008179_2025-06-15_15_55_09",
    type: "手术切除",
    tps: 0.4,
    totalPatches: 43782,
    totalCells: 1289550,
  },
];

const PATCHES: PatchItem[] = [
  { id: 0, x: 53248, y: 11264, tps: 88.5, cells: 314, bin: "T50" },
  { id: 1, x: 54784, y: 12288, tps: 87.5, cells: 348, bin: "T50" },
  { id: 2, x: 54784, y: 11776, tps: 87.4, cells: 349, bin: "T50" },
  { id: 3, x: 56832, y: 11776, tps: 87.1, cells: 353, bin: "T50" },
  { id: 4, x: 51200, y: 14848, tps: 46.8, cells: 212, bin: "T10" },
  { id: 5, x: 56320, y: 8192, tps: 46.2, cells: 249, bin: "T10" },
  { id: 6, x: 53248, y: 15872, tps: 45.9, cells: 326, bin: "T10" },
  { id: 7, x: 56320, y: 8704, tps: 44.8, cells: 284, bin: "T10" },
  { id: 8, x: 58368, y: 15360, tps: 9.7, cells: 331, bin: "T1" },
  { id: 9, x: 58368, y: 12288, tps: 9.2, cells: 329, bin: "T1" },
  { id: 10, x: 7680, y: 7680, tps: 0.9, cells: 25, bin: "Neg" },
  { id: 11, x: 2560, y: 8704, tps: 0.7, cells: 51, bin: "Neg" },
];

function clinicalBin(tps: number): ClinicalBin {
  if (tps >= 50) return "T50";
  if (tps >= 10) return "T10";
  if (tps >= 1) return "T1";
  return "Neg";
}

function caseStatus(tps: number) {
  if (tps >= 50) return { label: "HIGH PD-L1", bin: "T50" as ClinicalBin };
  if (tps >= 10) return { label: "ELEVATED", bin: "T10" as ClinicalBin };
  if (tps >= 1) return { label: "LOW EXPRESSORS", bin: "T1" as ClinicalBin };
  return { label: "NEGATIVE", bin: "Neg" as ClinicalBin };
}

function fmt(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function Histogram({
  patches,
  roiMode,
  selectedBin,
  onSelectBin,
}: {
  patches: PatchItem[];
  roiMode: boolean;
  selectedBin: ClinicalBin | "All";
  onSelectBin: (bin: ClinicalBin) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    label: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const width = rect.width;
      const height = rect.height;
      const top = 20;
      const bottom = 24;
      const plotHeight = height - top - bottom;
      const bins: ClinicalBin[] = ["Neg", "T1", "T10", "T50"];

      bins.forEach((bin, index) => {
        const x = (index * width) / 4;
        ctx.fillStyle = `${BIN_META[bin].color}1f`;
        ctx.fillRect(x, top, width / 4, plotHeight);
        if (selectedBin === bin) {
          ctx.strokeStyle = BIN_META[bin].color;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, top + 1, width / 4 - 2, plotHeight - 2);
        }
      });

      const fine = new Array<number>(1001).fill(0);
      patches.forEach((patch, patchIndex) => {
        const center = Math.max(0, Math.min(1000, Math.round(patch.tps * 10)));
        const spread = patch.bin === "T50" ? 96 : patch.bin === "T10" ? 72 : 34;
        for (
          let k = Math.max(0, center - spread);
          k <= Math.min(1000, center + spread);
          k += 1
        ) {
          const d = (k - center) / spread;
          fine[k] += Math.exp(-d * d * 4) * (0.7 + patch.cells / 260);
          fine[k] += ((k + patchIndex * 17) % 13) * 0.002;
        }
      });

      const mapX = (percent: number) => {
        if (percent < 1) return (percent / 1) * (width / 4);
        if (percent < 10)
          return width / 4 + ((percent - 1) / 9) * (width / 4);
        if (percent < 50)
          return width / 2 + ((percent - 10) / 40) * (width / 4);
        return (width * 3) / 4 + ((percent - 50) / 50) * (width / 4);
      };

      const max = Math.max(1, ...fine);
      const fillRatio = roiMode ? 0.8 : 0.9;
      ctx.fillStyle = roiMode ? "#67e8f9" : "#38bdf8";
      for (let k = 0; k <= 1000; k += 1) {
        const x0 = mapX(k / 10);
        const x1 = mapX(Math.min(100, (k + 1) / 10));
        const barH = (fine[k] / (max / fillRatio)) * plotHeight;
        ctx.globalAlpha = roiMode ? 0.86 : 0.72;
        ctx.fillRect(
          x0,
          top + plotHeight - barH,
          Math.max(0.45, x1 - x0),
          barH,
        );
      }
      ctx.globalAlpha = 1;

      ctx.strokeStyle = "#51647d";
      ctx.lineWidth = 1;
      [0, 1, 2, 3, 4].forEach((i) => {
        const x = (i * width) / 4;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + plotHeight);
        ctx.stroke();
      });

      ctx.fillStyle = "#8291a7";
      ctx.font =
        "10px 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "center";
      ["0", "1%", "10%", "50%", "100%"].forEach((label, index) => {
        ctx.fillText(label, (index * width) / 4, height - 7);
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [patches, roiMode, selectedBin]);

  const handleMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left));
    const index = Math.min(3, Math.floor((x / rect.width) * 4));
    const bin = (["Neg", "T1", "T10", "T50"] as ClinicalBin[])[index];
    const count = patches.filter((patch) => patch.bin === bin).length;
    setHover({
      x,
      label: `${BIN_META[bin].label} · ${BIN_META[bin].range}`,
      count,
    });
  };

  return (
    <div className="histogram-wrap">
      <canvas
        ref={canvasRef}
        className="histogram"
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const index = Math.min(
            3,
            Math.floor(((event.clientX - rect.left) / rect.width) * 4),
          );
          onSelectBin(
            (["Neg", "T1", "T10", "T50"] as ClinicalBin[])[index],
          );
        }}
        aria-label="TPS 直方图，点击临床分级区间可筛选 Patch"
      />
      {hover ? (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(hover.x, 530) }}
        >
          <strong>{hover.label}</strong>
          <span>{hover.count} representative patches</span>
        </div>
      ) : null}
    </div>
  );
}

export function TpsVis() {
  const [selectedCaseId, setSelectedCaseId] = useState(CASES[2].id);
  const [search, setSearch] = useState("");
  const [specimenFilter, setSpecimenFilter] = useState<
    "全部标本" | CaseItem["type"]
  >("全部标本");
  const [galleryBin, setGalleryBin] = useState<ClinicalBin | "All">("All");
  const [selectedPatchId, setSelectedPatchId] = useState(0);
  const [heatmapVisible, setHeatmapVisible] = useState(true);
  const [roiTool, setRoiTool] = useState(false);
  const [roi, setRoi] = useState<Roi | null>(null);
  const [roiDraft, setRoiDraft] = useState<Roi | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cellLoading, setCellLoading] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentInput, setAgentInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "已连接当前阅片上下文。所有回答仅重述可验证的计算结果，不生成诊断结论。",
    },
  ]);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "pan" | "roi";
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const selectedCase =
    CASES.find((item) => item.id === selectedCaseId) ?? CASES[2];
  const caseScale = Math.max(0.25, selectedCase.tps / 35.7);
  const casePatches = useMemo(
    () =>
      PATCHES.map((patch) => {
        const tps = Math.min(98.9, patch.tps * caseScale);
        return { ...patch, tps, bin: clinicalBin(tps) };
      }).sort((a, b) => b.tps - a.tps),
    [caseScale],
  );

  const roiPatches = useMemo(() => {
    if (!roi) return casePatches;
    const hit = casePatches.filter((patch) => {
      const nx = patch.x / 65000;
      const ny = patch.y / 18000;
      return (
        nx >= roi.nx &&
        nx <= roi.nx + roi.nw &&
        ny >= roi.ny &&
        ny <= roi.ny + roi.nh
      );
    });
    return hit.length ? hit : [];
  }, [casePatches, roi]);

  const galleryPatches = useMemo(
    () =>
      roiPatches.filter(
        (patch) => galleryBin === "All" || patch.bin === galleryBin,
      ),
    [roiPatches, galleryBin],
  );

  const selectedPatch =
    casePatches.find((patch) => patch.id === selectedPatchId) ?? casePatches[0];
  const positiveCells = Math.round(
    selectedPatch.cells * (selectedPatch.tps / 100),
  );
  const negativeCells = selectedPatch.cells - positiveCells;

  const activeStats = useMemo(() => {
    if (!roi) {
      return {
        tps: selectedCase.tps,
        patches: selectedCase.totalPatches,
        cells: selectedCase.totalCells,
        positive: Math.round(
          selectedCase.totalCells * (selectedCase.tps / 100),
        ),
      };
    }
    const cells = roiPatches.reduce((sum, patch) => sum + patch.cells, 0);
    const weighted = roiPatches.reduce(
      (sum, patch) => sum + patch.tps * patch.cells,
      0,
    );
    return {
      tps: cells ? weighted / cells : 0,
      patches: roiPatches.length,
      cells,
      positive: roiPatches.reduce(
        (sum, patch) => sum + Math.round(patch.cells * (patch.tps / 100)),
        0,
      ),
    };
  }, [roi, roiPatches, selectedCase]);

  const binCounts = useMemo(() => {
    const source = roi ? roiPatches : casePatches;
    return (["Neg", "T1", "T10", "T50"] as ClinicalBin[]).reduce(
      (acc, bin) => {
        acc[bin] = source.filter((patch) => patch.bin === bin).length;
        return acc;
      },
      {} as Record<ClinicalBin, number>,
    );
  }, [casePatches, roi, roiPatches]);

  const visibleCases = CASES.filter(
    (item) =>
      item.id.toLowerCase().includes(search.toLowerCase()) &&
      (specimenFilter === "全部标本" || item.type === specimenFilter),
  );

  useEffect(() => {
    setCellLoading(true);
    const timer = window.setTimeout(() => setCellLoading(false), 480);
    return () => window.clearTimeout(timer);
  }, [selectedPatchId, selectedCaseId]);

  const selectCase = (caseItem: CaseItem) => {
    setSelectedCaseId(caseItem.id);
    setSelectedPatchId(0);
    setRoi(null);
    setRoiDraft(null);
    setGalleryBin("All");
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const flyToPatch = (patch: PatchItem) => {
    setSelectedPatchId(patch.id);
    setZoom(2.45);
    setPan({
      x: (0.5 - patch.x / 65000) * 170,
      y: (0.5 - patch.y / 18000) * 120,
    });
  };

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
      width: rect.width,
      height: rect.height,
    };
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = localPoint(event);
    if (roiTool) {
      dragRef.current = {
        mode: "roi",
        startX: point.x,
        startY: point.y,
        panX: 0,
        panY: 0,
      };
      setRoiDraft({
        x: point.x,
        y: point.y,
        w: 0,
        h: 0,
        nx: point.x / point.width,
        ny: point.y / point.height,
        nw: 0,
        nh: 0,
      });
      return;
    }
    dragRef.current = {
      mode: "pan",
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      setPan({
        x: drag.panX + event.clientX - drag.startX,
        y: drag.panY + event.clientY - drag.startY,
      });
      return;
    }
    const point = localPoint(event);
    const x = Math.min(drag.startX, point.x);
    const y = Math.min(drag.startY, point.y);
    const w = Math.abs(point.x - drag.startX);
    const h = Math.abs(point.y - drag.startY);
    setRoiDraft({
      x,
      y,
      w,
      h,
      nx: x / point.width,
      ny: y / point.height,
      nw: w / point.width,
      nh: h / point.height,
    });
  };

  const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.mode === "roi" && roiDraft) {
      const rect = event.currentTarget.getBoundingClientRect();
      const gridX = Math.max(20, rect.width / 18);
      const gridY = Math.max(20, rect.height / 10);
      const x = Math.round(roiDraft.x / gridX) * gridX;
      const y = Math.round(roiDraft.y / gridY) * gridY;
      const w = Math.max(gridX, Math.round(roiDraft.w / gridX) * gridX);
      const h = Math.max(gridY, Math.round(roiDraft.h / gridY) * gridY);
      setRoi({
        x,
        y,
        w: Math.min(w, rect.width - x),
        h: Math.min(h, rect.height - y),
        nx: x / rect.width,
        ny: y / rect.height,
        nw: Math.min(w, rect.width - x) / rect.width,
        nh: Math.min(h, rect.height - y) / rect.height,
      });
      setRoiDraft(null);
      setRoiTool(false);
      setGalleryBin("All");
    }
    dragRef.current = null;
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((value) =>
      Math.max(0.85, Math.min(4.5, value * (event.deltaY > 0 ? 0.9 : 1.1))),
    );
  };

  const askAgent = (question: string) => {
    const normalized = question.toLowerCase();
    let answer: string;
    if (normalized.includes("最高") || normalized.includes("highest")) {
      const highest = [...casePatches].sort((a, b) => b.tps - a.tps)[0];
      answer = `当前病例中 TPS 最高的代表性 Patch 为 x=${highest.x}, y=${highest.y}，预测 TPS ${highest.tps.toFixed(1)}%，包含 ${highest.cells} 个检测细胞。`;
      flyToPatch(highest);
    } else if (
      normalized.includes("roi") ||
      normalized.includes("选区") ||
      normalized.includes("这里")
    ) {
      answer = roi
        ? `当前 ROI 对齐到 512×512 网格后包含 ${activeStats.patches} 个代表性 Patch、${fmt(activeStats.cells)} 个细胞；细胞加权平均 TPS 为 ${activeStats.tps.toFixed(1)}%。`
        : `当前未建立 ROI，以下文默认指向全片：平均 TPS ${selectedCase.tps.toFixed(1)}%，有效 Patch ${fmt(selectedCase.totalPatches)} 个。`;
    } else if (
      normalized.includes("阳性") ||
      normalized.includes("positive")
    ) {
      answer = `当前 Patch 检测到 ${selectedPatch.cells} 个肿瘤细胞，其中按预测 TPS 折算阳性 ${positiveCells} 个、阴性 ${negativeCells} 个。`;
    } else if (
      normalized.includes("分布") ||
      normalized.includes("distribution")
    ) {
      answer = `当前${roi ? " ROI" : "全片代表集"}的临床分级分布为：Neg ${binCounts.Neg}、T1 ${binCounts.T1}、T10 ${binCounts.T10}、T50 ${binCounts.T50}。`;
    } else {
      answer = `当前病例全片 TPS 为 ${selectedCase.tps.toFixed(1)}%，属于 ${caseStatus(selectedCase.tps).label}。该结果是模型推理的客观数值重述，需由执业病理医师结合切片形态确认。`;
    }
    setMessages((current) => [
      ...current,
      { role: "user", text: question },
      { role: "agent", text: answer },
    ]);
  };

  const submitAgent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = agentInput.trim();
    if (!question) return;
    askAgent(question);
    setAgentInput("");
  };

  const activeRoi = roiDraft ?? roi;
  const displayPatches = roi ? roiPatches : casePatches;
  const totalBinCount = Math.max(
    1,
    Object.values(binCounts).reduce((sum, count) => sum + count, 0),
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <strong>TPS-Vis</strong>
            <span>PD-L1 多尺度表达分析</span>
          </div>
        </div>
        <div className="case-context">
          <span className="eyebrow">CURRENT SPECIMEN</span>
          <strong>{selectedCase.id}</strong>
          <span className="context-dot" />
          <span>{selectedCase.type}</span>
        </div>
        <div className="global-tps">
          <span>GLOBAL TPS</span>
          <strong>{selectedCase.tps.toFixed(1)}%</strong>
          <em
            style={{
              color: BIN_META[caseStatus(selectedCase.tps).bin].color,
              borderColor: `${BIN_META[caseStatus(selectedCase.tps).bin].color}66`,
            }}
          >
            {caseStatus(selectedCase.tps).label}
          </em>
        </div>
        <div className="top-actions">
          <span className="model-status">
            <i />
            Model ready
          </span>
          <button type="button" className="ghost-button">
            导出快照
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-column">
          <section className="panel specimen-panel">
            <div className="panel-heading">
              <div>
                <span className="module-tag">A</span>
                <div>
                  <h2>Specimen Explorer</h2>
                  <p>按全片 TPS 降序</p>
                </div>
              </div>
              <span className="count-badge">{visibleCases.length}</span>
            </div>
            <div className="specimen-controls">
              <label className="search-control">
                <span>⌕</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索病例 ID"
                  aria-label="搜索病例 ID"
                />
              </label>
              <select
                value={specimenFilter}
                onChange={(event) =>
                  setSpecimenFilter(
                    event.target.value as "全部标本" | CaseItem["type"],
                  )
                }
                aria-label="筛选标本类型"
              >
                <option>全部标本</option>
                <option>穿刺活检</option>
                <option>手术切除</option>
              </select>
            </div>
            <div className="case-list">
              {visibleCases.map((item) => {
                const status = caseStatus(item.tps);
                const selected = item.id === selectedCaseId;
                return (
                  <button
                    type="button"
                    className={`case-card ${selected ? "selected" : ""}`}
                    style={{
                      borderLeftColor: BIN_META[status.bin].color,
                    }}
                    key={item.id}
                    onClick={() => selectCase(item)}
                  >
                    <span
                      className="case-thumb"
                      style={{
                        backgroundPosition:
                          item.type === "穿刺活检" ? "12% 50%" : "88% 50%",
                      }}
                    />
                    <span className="case-copy">
                      <small>{item.type}</small>
                      <strong>{item.id.split("_").slice(0, 2).join(" · ")}</strong>
                      <span>
                        <b>{item.tps.toFixed(1)}%</b>
                        <em
                          style={{
                            backgroundColor: `${BIN_META[status.bin].color}20`,
                            color: BIN_META[status.bin].color,
                          }}
                        >
                          {status.label}
                        </em>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel gallery-panel">
            <div className="panel-heading">
              <div>
                <span className="module-tag">B</span>
                <div>
                  <h2>Patch Gallery</h2>
                  <p>
                    {roi ? "ROI ∩ 有效 Patch" : "已过滤空白背景"} · TPS 降序
                  </p>
                </div>
              </div>
              <span className="count-badge">{galleryPatches.length}</span>
            </div>
            <div className="allocation-strip compact">
              {(["Neg", "T1", "T10", "T50"] as ClinicalBin[]).map((bin) => (
                <span
                  key={bin}
                  style={{
                    background: BIN_META[bin].color,
                    width: `${(binCounts[bin] / totalBinCount) * 100}%`,
                  }}
                  title={`${bin}: ${binCounts[bin]}`}
                />
              ))}
            </div>
            <div className="bin-filters" role="group" aria-label="Patch 分级筛选">
              {(["All", "Neg", "T1", "T10", "T50"] as const).map((bin) => (
                <button
                  type="button"
                  key={bin}
                  className={galleryBin === bin ? "active" : ""}
                  onClick={() => setGalleryBin(bin)}
                >
                  {bin === "All" ? "全部" : bin}
                  <span>
                    {bin === "All"
                      ? roiPatches.length
                      : binCounts[bin as ClinicalBin]}
                  </span>
                </button>
              ))}
            </div>
            <div className="patch-grid">
              {galleryPatches.length ? (
                galleryPatches.map((patch) => (
                  <button
                    type="button"
                    key={patch.id}
                    className={`patch-card ${
                      selectedPatchId === patch.id ? "selected" : ""
                    }`}
                    onClick={() => flyToPatch(patch)}
                    title={`坐标 (${patch.x}, ${patch.y}) · TPS ${patch.tps.toFixed(
                      1,
                    )}% · ${patch.cells} cells`}
                  >
                    <img
                      src={`/assets/patches/p${patch.id}/image.jpg`}
                      alt=""
                    />
                    <span className="patch-overlay">
                      <b style={{ color: BIN_META[patch.bin].color }}>
                        {patch.tps.toFixed(1)}%
                      </b>
                      <small>
                        x{patch.x} · y{patch.y}
                      </small>
                      <small>{patch.cells} cells</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>ROI 内暂无有效 Patch</strong>
                  <span>扩大选区或清除 ROI 后继续浏览</span>
                </div>
              )}
            </div>
          </section>
        </aside>

        <section className="center-column">
          <section className="panel wsi-panel">
            <div className="panel-heading viewer-heading">
              <div>
                <span className="module-tag">C</span>
                <div>
                  <h2>IHC Image View</h2>
                  <p>Whole-slide image · 512×512 patch grid</p>
                </div>
              </div>
              <div className="viewer-tools">
                <button
                  type="button"
                  className={heatmapVisible ? "active" : ""}
                  onClick={() => setHeatmapVisible((value) => !value)}
                  aria-pressed={heatmapVisible}
                >
                  <span className="heat-icon" />
                  TPS 热力图
                </button>
                <button
                  type="button"
                  className={roiTool ? "active" : ""}
                  onClick={() => setRoiTool((value) => !value)}
                  aria-pressed={roiTool}
                >
                  ◰ ROI
                </button>
                {roi ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRoi(null);
                      setGalleryBin("All");
                    }}
                  >
                    × 清除选区
                  </button>
                ) : null}
              </div>
            </div>
            <div
              ref={stageRef}
              className={`wsi-stage ${roiTool ? "roi-cursor" : ""}`}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerUp}
              onPointerCancel={() => {
                dragRef.current = null;
                setRoiDraft(null);
              }}
              onWheel={onWheel}
            >
              <div
                className="wsi-image-layer"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
              >
                <img
                  src="/assets/wsi-overview.png"
                  alt="IHC 全切片概览"
                  draggable={false}
                />
                <div className="patch-grid-overlay" />
                {heatmapVisible ? <div className="tps-heatmap" /> : null}
                {casePatches.map((patch) => (
                  <span
                    key={patch.id}
                    className={`spatial-patch ${
                      patch.id === selectedPatchId ? "selected" : ""
                    } ${
                      galleryBin !== "All" && patch.bin !== galleryBin
                        ? "muted"
                        : ""
                    }`}
                    style={{
                      left: `${(patch.x / 65000) * 100}%`,
                      top: `${(patch.y / 18000) * 100}%`,
                      borderColor: BIN_META[patch.bin].color,
                      background: `${BIN_META[patch.bin].color}24`,
                    }}
                  />
                ))}
              </div>
              {activeRoi ? (
                <div
                  className="roi-box"
                  style={{
                    left: activeRoi.x,
                    top: activeRoi.y,
                    width: activeRoi.w,
                    height: activeRoi.h,
                  }}
                >
                  <span>
                    ROI · {roi ? roiPatches.length : "drawing"} patches
                  </span>
                </div>
              ) : null}
              <div className="viewer-zoom">
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setZoom((value) => Math.min(4.5, value + 0.35))}
                  aria-label="放大"
                >
                  +
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setZoom((value) => Math.max(0.85, value - 0.35))}
                  aria-label="缩小"
                >
                  −
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  aria-label="重置视图"
                >
                  ↺
                </button>
              </div>
              <button
                type="button"
                className="minimap"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                aria-label="导航概览，点击回到全片"
              >
                <img src="/assets/wsi-overview.png" alt="" />
                <span
                  style={{
                    width: `${Math.max(22, 64 / zoom)}%`,
                    height: `${Math.max(25, 70 / zoom)}%`,
                    left: `${Math.min(
                      74,
                      Math.max(2, (selectedPatch.x / 65000) * 100 - 20),
                    )}%`,
                    top: `${Math.min(
                      70,
                      Math.max(2, (selectedPatch.y / 18000) * 100 - 18),
                    )}%`,
                  }}
                />
              </button>
              <div className="stage-status">
                {roiTool
                  ? "拖拽框选 ROI，释放后自动吸附到 Patch 网格"
                  : `Patch ${selectedPatch.id
                      .toString()
                      .padStart(2, "0")} · (${selectedPatch.x}, ${
                      selectedPatch.y
                    })`}
              </div>
            </div>
          </section>

          <section className="panel distribution-panel">
            <div className="panel-heading distribution-heading">
              <div>
                <span className="module-tag">D</span>
                <div>
                  <h2>TPS Distribution View</h2>
                  <p>
                    1001 bins · 0.1% 粒度 · {roi ? "ROI Mode ρ=0.8" : "Whole Slide ρ=0.9"}
                  </p>
                </div>
              </div>
              <span className={`mode-chip ${roi ? "roi" : ""}`}>
                {roi ? "LOCAL ROI" : "WHOLE SLIDE"}
              </span>
            </div>
            <div className="distribution-content">
              <div className="histogram-card">
                <div className="subpanel-title">
                  <span>D-1</span>
                  <strong>Fine-grained TPS histogram</strong>
                  <small>点击背景分级带联动筛选</small>
                </div>
                <Histogram
                  patches={displayPatches}
                  roiMode={Boolean(roi)}
                  selectedBin={galleryBin}
                  onSelectBin={(bin) => setGalleryBin(bin)}
                />
                <div className="allocation-strip labeled">
                  {(["Neg", "T1", "T10", "T50"] as ClinicalBin[]).map((bin) => (
                    <button
                      type="button"
                      key={bin}
                      style={{
                        background: BIN_META[bin].color,
                        width: `${(binCounts[bin] / totalBinCount) * 100}%`,
                      }}
                      onClick={() => setGalleryBin(bin)}
                      title={`${binCounts[bin]} patches`}
                    >
                      {binCounts[bin] ? (
                        <>
                          <b>{bin}</b>
                          <span>
                            {binCounts[bin]} ·{" "}
                            {Math.round(
                              (binCounts[bin] / totalBinCount) * 100,
                            )}
                            %
                          </span>
                        </>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="summary-card">
                <div className="subpanel-title">
                  <span>D-2</span>
                  <strong>Selection ROI Summary</strong>
                  {roi ? (
                    <button
                      type="button"
                      onClick={() => {
                        setRoi(null);
                        setGalleryBin("All");
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <div className="metric-primary">
                  <span>MEAN TPS (SCALAR)</span>
                  <strong>{activeStats.tps.toFixed(1)}%</strong>
                </div>
                <div className="scalar-track">
                  <span style={{ width: `${activeStats.tps}%` }} />
                  <i style={{ left: "1%" }} />
                  <i style={{ left: "10%" }} />
                  <i style={{ left: "50%" }} />
                </div>
                <div className="metrics-grid">
                  <div>
                    <span>PATCHES</span>
                    <strong>{fmt(activeStats.patches)}</strong>
                  </div>
                  <div>
                    <span>CELLS</span>
                    <strong>{fmt(activeStats.cells)}</strong>
                  </div>
                  <div className="positive">
                    <span>POSITIVE</span>
                    <strong>+{fmt(activeStats.positive)}</strong>
                  </div>
                  <div className="negative">
                    <span>NEGATIVE</span>
                    <strong>
                      −{fmt(Math.max(0, activeStats.cells - activeStats.positive))}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </section>

        <aside className="right-column panel">
          <div className="panel-heading">
            <div>
              <span className="module-tag">E</span>
              <div>
                <h2>Cell-Level View</h2>
                <p>
                  Patch {selectedPatch.id.toString().padStart(2, "0")} · pixel-linked
                </p>
              </div>
            </div>
            <span className="live-badge">
              <i />
              SYNC
            </span>
          </div>

          <div className="cell-preview-stack">
            <section className="cell-preview">
              <div className="preview-label">
                <span>E-1</span>
                <strong>Cell phenotype labels</strong>
                <small>● Positive&nbsp;&nbsp;● Negative</small>
              </div>
              <div className="microscopy-view">
                <img
                  src={`/assets/patches/p${selectedPatch.id}/image.jpg`}
                  alt="当前 Patch 高分辨率图像"
                />
                <div className="cell-dots">
                  {Array.from({ length: 46 }, (_, index) => {
                    const positive =
                      index < Math.round(46 * (selectedPatch.tps / 100));
                    return (
                      <i
                        key={index}
                        className={positive ? "positive" : "negative"}
                        style={{
                          left: `${8 + ((index * 37) % 86)}%`,
                          top: `${9 + ((index * 53) % 82)}%`,
                        }}
                      />
                    );
                  })}
                </div>
                {cellLoading ? <div className="loading-shimmer" /> : null}
              </div>
            </section>

            <section className="cell-preview probability">
              <div className="preview-label">
                <span>E-2</span>
                <strong>P(cell) probability map</strong>
                <small>low ← confidence → high</small>
              </div>
              <div className="microscopy-view">
                <img
                  src={`/assets/patches/p${selectedPatch.id}/probability.png`}
                  alt="细胞检测概率图"
                />
                <div className="probability-scale" />
                {cellLoading ? <div className="loading-shimmer" /> : null}
              </div>
            </section>
          </div>

          <section className="cell-detail-card">
            <div className="subpanel-title">
              <span>E-3</span>
              <strong>Selected Patch Evidence</strong>
              <em
                style={{
                  color: BIN_META[selectedPatch.bin].color,
                  borderColor: `${BIN_META[selectedPatch.bin].color}66`,
                }}
              >
                {selectedPatch.bin}
              </em>
            </div>
            <div className="patch-detail-lead">
              <div>
                <span>LOCAL CELL-WEIGHTED TPS</span>
                <strong>{selectedPatch.tps.toFixed(1)}%</strong>
              </div>
              <div>
                <span>WEIGHT CONTRIBUTION</span>
                <strong>
                  {(
                    (selectedPatch.cells / selectedCase.totalCells) *
                    100
                  ).toFixed(3)}
                  %
                </strong>
              </div>
            </div>
            <div className="cell-count-bar">
              <span
                className="positive"
                style={{ width: `${selectedPatch.tps}%` }}
              >
                +{positiveCells}
              </span>
              <span
                className="negative"
                style={{ width: `${100 - selectedPatch.tps}%` }}
              >
                −{negativeCells}
              </span>
            </div>
            <div className="evidence-chain">
              <span>
                <i />
                GLOBAL
                <b>{selectedCase.tps.toFixed(1)}%</b>
              </span>
              <em>→</em>
              <span>
                <i />
                REGION
                <b>{roi ? activeStats.tps.toFixed(1) : "—"}%</b>
              </span>
              <em>→</em>
              <span>
                <i />
                CELL
                <b>{positiveCells}/{selectedPatch.cells}</b>
              </span>
            </div>
            <div className="detail-location">
              <span>Origin</span>
              <code>
                x={selectedPatch.x}, y={selectedPatch.y}
              </code>
              <span>512 × 512 px</span>
            </div>
          </section>
        </aside>
      </section>

      <section className={`agent-panel ${agentOpen ? "" : "collapsed"}`}>
        <div className="agent-heading">
          <div>
            <span className="module-tag">F</span>
            <span className="agent-orb">✦</span>
            <div>
              <h2>Pathology Insight Agent</h2>
              <p>语义解析 → 受控数据检索 → 标准化重述</p>
            </div>
          </div>
          <div className="agent-context">
            <span>CASE <b>{selectedCase.id.split("_")[0]}</b></span>
            <span>PATCH <b>#{selectedPatch.id.toString().padStart(2, "0")}</b></span>
            <span>ROI <b>{roi ? "ACTIVE" : "NONE"}</b></span>
          </div>
          <button
            type="button"
            className="collapse-agent"
            onClick={() => setAgentOpen((value) => !value)}
            aria-label={agentOpen ? "折叠智能体" : "展开智能体"}
          >
            {agentOpen ? "⌄" : "⌃"}
          </button>
        </div>
        {agentOpen ? (
          <div className="agent-body">
            <div className="quick-prompts">
              <span>GUIDED QUESTIONS</span>
              {[
                "当前全片 TPS 是多少？",
                "当前 ROI 显示了什么？",
                "哪个 Patch 的 TPS 最高？",
                "当前 Patch 有多少阳性细胞？",
              ].map((question) => (
                <button
                  type="button"
                  key={question}
                  onClick={() => askAgent(question)}
                >
                  {question}
                </button>
              ))}
            </div>
            <div className="conversation" aria-live="polite">
              {messages.slice(-4).map((message, index) => (
                <div
                  key={`${message.role}-${index}-${message.text.slice(0, 8)}`}
                  className={`message ${message.role}`}
                >
                  <span>{message.role === "agent" ? "✦" : "YOU"}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
            <form className="agent-form" onSubmit={submitAgent}>
              <input
                value={agentInput}
                onChange={(event) => setAgentInput(event.target.value)}
                placeholder="询问当前病例、ROI、分布或细胞级证据…"
                aria-label="向病理洞察智能体提问"
              />
              <button type="submit">发送 ↗</button>
              <small>仅用于研究性可视分析，不构成临床诊断。</small>
            </form>
          </div>
        ) : null}
      </section>
    </main>
  );
}
