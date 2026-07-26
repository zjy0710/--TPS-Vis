"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
  source?: "demo" | "local";
  folderName?: string;
  thumbnailUrl?: string;
  slideUrl?: string;
  patches?: PatchItem[];
  slideWidth?: number;
  slideHeight?: number;
};

type PatchItem = {
  id: number;
  x: number;
  y: number;
  tps: number;
  cells: number;
  bin: ClinicalBin;
  imageUrl?: string;
  cellsUrl?: string;
  probabilityUrl?: string;
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

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

function normalizeFolderPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function withoutRootFolder(path: string) {
  const normalized = normalizeFolderPath(path);
  const parts = normalized.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

async function buildLocalCase(files: FileList): Promise<CaseItem> {
  const selectedFiles = Array.from(files);
  if (!selectedFiles.length) {
    throw new Error("没有读取到文件，请重新选择病例文件夹。");
  }

  const rootFolder =
    normalizeFolderPath(selectedFiles[0].webkitRelativePath || "").split(
      "/",
    )[0] || "Local case";
  const fileMap = new Map<string, File>();
  selectedFiles.forEach((file) => {
    const browserPath = file.webkitRelativePath || file.name;
    fileMap.set(withoutRootFolder(browserPath).toLowerCase(), file);
  });

  const manifestFile = fileMap.get("patches_manifest.csv");
  const summaryFile = fileMap.get("wsi_summary.json");
  const thumbnailFile =
    fileMap.get("thumbnail.png") ??
    fileMap.get("thumbnail.jpg") ??
    fileMap.get("stitched.jpg");
  const slideFile = fileMap.get("stitched.jpg") ?? thumbnailFile;

  if (!manifestFile || !summaryFile || !thumbnailFile || !slideFile) {
    throw new Error(
      "文件夹格式不完整：根目录必须包含 wsi_summary.json、patches_manifest.csv 和 thumbnail.png（或 stitched.jpg）。",
    );
  }

  const summary = JSON.parse(await summaryFile.text()) as {
    wsi_id?: string;
  };
  const manifestText = await manifestFile.text();
  const lines = manifestText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("patches_manifest.csv 中没有有效 Patch 数据。");
  }

  const headers = parseCsvLine(lines[0]);
  const headerIndex = new Map(
    headers.map((header, index) => [header.trim(), index]),
  );
  const readColumn = (values: string[], name: string) =>
    values[headerIndex.get(name) ?? -1] ?? "";

  const patches: PatchItem[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const patchId = readColumn(values, "patch_id");
    const imagePath = normalizeFolderPath(
      readColumn(values, "image_file"),
    ).toLowerCase();
    const cells = Number(readColumn(values, "num_cells")) || 0;
    const rawTps = Number(readColumn(values, "patch_pred_tps"));
    if (!patchId || !imagePath || !Number.isFinite(rawTps) || cells <= 0) {
      continue;
    }

    const coordinateMatch = patchId.match(/_x(\d+)_y(\d+)$/);
    if (!coordinateMatch) continue;
    const imageFile = fileMap.get(imagePath);
    if (!imageFile) continue;

    const patchFolder = imagePath.slice(0, imagePath.lastIndexOf("/") + 1);
    const cellsOverlay = fileMap.get(`${patchFolder}cells_overlay.png`);
    const probabilityOverlay = fileMap.get(
      `${patchFolder}heatmap_overlay.png`,
    );
    const tps = rawTps <= 1 ? rawTps * 100 : rawTps;
    patches.push({
      id: patches.length,
      x: Number(coordinateMatch[1]),
      y: Number(coordinateMatch[2]),
      tps,
      cells,
      bin: clinicalBin(tps),
      imageUrl: URL.createObjectURL(imageFile),
      cellsUrl: cellsOverlay
        ? URL.createObjectURL(cellsOverlay)
        : undefined,
      probabilityUrl: probabilityOverlay
        ? URL.createObjectURL(probabilityOverlay)
        : undefined,
    });
  }

  if (!patches.length) {
    throw new Error(
      "没有找到可显示的有效 Patch。请确认 manifest 中的 image_file 与文件夹路径一致。",
    );
  }

  patches.sort((a, b) => b.tps - a.tps);
  const totalCells = patches.reduce((sum, patch) => sum + patch.cells, 0);
  const weightedTps = patches.reduce(
    (sum, patch) => sum + patch.tps * patch.cells,
    0,
  );

  return {
    id: summary.wsi_id || rootFolder,
    folderName: rootFolder,
    type: "穿刺活检",
    tps: totalCells ? weightedTps / totalCells : 0,
    totalPatches: patches.length,
    totalCells,
    source: "local",
    thumbnailUrl: URL.createObjectURL(thumbnailFile),
    slideUrl: URL.createObjectURL(slideFile),
    patches,
    slideWidth: Math.max(...patches.map((patch) => patch.x + 512)),
    slideHeight: Math.max(...patches.map((patch) => patch.y + 512)),
  };
}

function patchImageUrl(patch: PatchItem) {
  return patch.imageUrl ?? `/assets/patches/p${patch.id}/image.jpg`;
}

function patchCellsUrl(patch: PatchItem) {
  return patch.cellsUrl ?? `/assets/patches/p${patch.id}/cells.png`;
}

function patchProbabilityUrl(patch: PatchItem) {
  return (
    patch.probabilityUrl ??
    `/assets/patches/p${patch.id}/probability.png`
  );
}

function patchesInsideRoi(
  patches: PatchItem[],
  roi: Roi | null,
  slideWidth: number,
  slideHeight: number,
) {
  if (!roi) return patches;
  return patches.filter((patch) => {
    const nx = patch.x / slideWidth;
    const ny = patch.y / slideHeight;
    return (
      nx >= roi.nx &&
      nx <= roi.nx + roi.nw &&
      ny >= roi.ny &&
      ny <= roi.ny + roi.nh
    );
  });
}

function SlideKdeHeatmap({
  patches,
  slideWidth,
  slideHeight,
}: {
  patches: PatchItem[];
  slideWidth: number;
  slideHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !patches.length) return;

    const width = 1200;
    const height = Math.max(
      260,
      Math.min(900, Math.round(width * (slideHeight / slideWidth))),
    );
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const colors: Record<ClinicalBin, [number, number, number]> = {
      Neg: [59, 130, 246],
      T1: [34, 197, 94],
      T10: [245, 158, 11],
      T50: [239, 68, 68],
    };
    const maxCells = Math.max(1, ...patches.map((patch) => patch.cells));
    const radius = Math.max(24, Math.min(76, width * 0.046));
    const ordered = [...patches].sort((a, b) => a.tps - b.tps);

    ctx.globalCompositeOperation = "source-over";
    ordered.forEach((patch) => {
      const x = (patch.x / slideWidth) * width;
      const y = (patch.y / slideHeight) * height;
      const [red, green, blue] = colors[patch.bin];
      const cellWeight = Math.sqrt(patch.cells / maxCells);
      const tpsWeight = 0.22 + (patch.tps / 100) * 0.78;
      const alpha = 0.12 + cellWeight * tpsWeight * 0.3;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${alpha})`);
      gradient.addColorStop(
        0.38,
        `rgba(${red}, ${green}, ${blue}, ${alpha * 0.58})`,
      );
      gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    });
  }, [patches, slideHeight, slideWidth]);

  return (
    <canvas
      ref={canvasRef}
      className="tps-kde-layer"
      aria-label="根据当前病例 Patch 坐标和 TPS 数值生成的 KDE 热力图"
    />
  );
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
  const [localCases, setLocalCases] = useState<CaseItem[]>([]);
  const [uploadState, setUploadState] = useState<{
    kind: "idle" | "reading" | "success" | "error";
    message: string;
  }>({ kind: "idle", message: "" });
  const [search, setSearch] = useState("");
  const [specimenFilter, setSpecimenFilter] = useState<
    "全部标本" | CaseItem["type"]
  >("全部标本");
  const [galleryBin, setGalleryBin] = useState<ClinicalBin | "All">("All");
  const [selectedPatchId, setSelectedPatchId] = useState(0);
  const [heatmapVisible, setHeatmapVisible] = useState(true);
  const [roiTool, setRoiTool] = useState(false);
  const [roi, setRoi] = useState<Roi | null>(null);
  const [roiHistory, setRoiHistory] = useState<Roi[]>([]);
  const [roiDraft, setRoiDraft] = useState<Roi | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cellLoading, setCellLoading] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "已连接当前阅片上下文。所有回答仅重述可验证的计算结果，不生成诊断结论。",
    },
  ]);
  const stageRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{
    mode: "pan" | "roi";
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const allCases = useMemo(() => [...localCases, ...CASES], [localCases]);
  const selectedCase =
    allCases.find((item) => item.id === selectedCaseId) ?? CASES[2];
  const casePatches = useMemo(
    () => {
      if (selectedCase.patches?.length) return selectedCase.patches;
      const caseScale = Math.max(0.25, selectedCase.tps / 35.7);
      return PATCHES.map((patch) => {
        const tps = Math.min(98.9, patch.tps * caseScale);
        return { ...patch, tps, bin: clinicalBin(tps) };
      }).sort((a, b) => b.tps - a.tps);
    },
    [selectedCase],
  );
  const slideWidth = selectedCase.slideWidth ?? 65000;
  const slideHeight = selectedCase.slideHeight ?? 18000;

  const roiPatches = useMemo(() => {
    return patchesInsideRoi(casePatches, roi, slideWidth, slideHeight);
  }, [casePatches, roi, slideHeight, slideWidth]);

  const roiComparisons = useMemo(
    () =>
      roiHistory.map((area, index) => {
        const patches = patchesInsideRoi(
          casePatches,
          area,
          slideWidth,
          slideHeight,
        );
        const cells = patches.reduce((sum, patch) => sum + patch.cells, 0);
        const weighted = patches.reduce(
          (sum, patch) => sum + patch.tps * patch.cells,
          0,
        );
        return {
          roi: area,
          label: `ROI ${String.fromCharCode(65 + index)}`,
          patches: patches.length,
          cells,
          tps: cells ? weighted / cells : 0,
        };
      }),
    [casePatches, roiHistory, slideHeight, slideWidth],
  );

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

  const visibleCases = allCases.filter(
    (item) =>
      item.id.toLowerCase().includes(search.toLowerCase()) &&
      (specimenFilter === "全部标本" || item.type === specimenFilter),
  );

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    setCellLoading(true);
    const timer = window.setTimeout(() => setCellLoading(false), 480);
    return () => window.clearTimeout(timer);
  }, [selectedPatchId, selectedCaseId]);

  const selectCase = (caseItem: CaseItem) => {
    setSelectedCaseId(caseItem.id);
    setSelectedPatchId(0);
    setRoi(null);
    setRoiHistory([]);
    setRoiDraft(null);
    setGalleryBin("All");
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleFolderSelection = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files?.length) return;
    setUploadState({
      kind: "reading",
      message: `正在本地解析 ${fmt(files.length)} 个文件…`,
    });
    try {
      const localCase = await buildLocalCase(files);
      setLocalCases((current) => [
        localCase,
        ...current.filter((item) => item.id !== localCase.id),
      ]);
      setSelectedCaseId(localCase.id);
      setSelectedPatchId(localCase.patches?.[0]?.id ?? 0);
      setRoi(null);
      setRoiHistory([]);
      setRoiDraft(null);
      setGalleryBin("All");
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setUploadState({
        kind: "success",
        message: `已载入 ${localCase.id} · ${fmt(
          localCase.totalPatches,
        )} patches · ${fmt(localCase.totalCells)} cells`,
      });
    } catch (error) {
      setUploadState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "文件夹解析失败，请重试。",
      });
    } finally {
      event.target.value = "";
    }
  };

  const flyToPatch = (patch: PatchItem) => {
    setSelectedPatchId(patch.id);
    setZoom(2.45);
    setPan({
      x: (0.5 - patch.x / slideWidth) * 170,
      y: (0.5 - patch.y / slideHeight) * 120,
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
      const nextRoi = {
        x,
        y,
        w: Math.min(w, rect.width - x),
        h: Math.min(h, rect.height - y),
        nx: x / rect.width,
        ny: y / rect.height,
        nw: Math.min(w, rect.width - x) / rect.width,
        nh: Math.min(h, rect.height - y) / rect.height,
      };
      setRoi(nextRoi);
      setRoiHistory((current) => [...current.slice(-1), nextRoi]);
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
            {selectedCase.source === "local" ? "Local data" : "Demo data"}
          </span>
          <input
            ref={folderInputRef}
            className="folder-input"
            type="file"
            multiple
            onChange={handleFolderSelection}
            tabIndex={-1}
          />
          <button
            type="button"
            className="import-button"
            onClick={() => folderInputRef.current?.click()}
            disabled={uploadState.kind === "reading"}
          >
            <span>＋</span>
            {uploadState.kind === "reading"
              ? "正在读取…"
              : "选择病例文件夹"}
          </button>
        </div>
      </header>
      {uploadState.kind !== "idle" ? (
        <div className={`import-toast ${uploadState.kind}`} role="status">
          <span>
            {uploadState.kind === "reading"
              ? "◌"
              : uploadState.kind === "success"
                ? "✓"
                : "!"}
          </span>
          <div>
            <strong>
              {uploadState.kind === "reading"
                ? "正在解析本地病例"
                : uploadState.kind === "success"
                  ? "病例文件夹已载入"
                  : "无法载入文件夹"}
            </strong>
            <p>{uploadState.message}</p>
          </div>
          {uploadState.kind !== "reading" ? (
            <button
              type="button"
              onClick={() => setUploadState({ kind: "idle", message: "" })}
              aria-label="关闭提示"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

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
            <div className="local-import-note">
              <span>⌁</span>
              <p>
                点击右上角“选择病例文件夹”。数据仅在本机浏览器解析，不上传。
              </p>
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
                        backgroundImage: `url("${
                          item.thumbnailUrl ?? "/assets/wsi-overview.png"
                        }")`,
                        backgroundPosition:
                          item.type === "穿刺活检" ? "12% 50%" : "88% 50%",
                      }}
                    />
                    <span className="case-copy">
                      <small>
                        {item.source === "local" ? "本地导入 · " : ""}
                        {item.type}
                      </small>
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
                      src={patchImageUrl(patch)}
                      alt=""
                      loading="lazy"
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
                  TPS KDE 热力图
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
                      setRoiHistory([]);
                      setGalleryBin("All");
                    }}
                  >
                    × 清除 ROI
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
                  src={
                    selectedCase.slideUrl ??
                    selectedCase.thumbnailUrl ??
                    "/assets/wsi-overview.png"
                  }
                  alt="IHC 全切片概览"
                  draggable={false}
                />
                {heatmapVisible ? (
                  <SlideKdeHeatmap
                    patches={casePatches}
                    slideWidth={slideWidth}
                    slideHeight={slideHeight}
                  />
                ) : null}
                <span
                  className="spatial-patch selected"
                  style={{
                    left: `${(selectedPatch.x / slideWidth) * 100}%`,
                    top: `${(selectedPatch.y / slideHeight) * 100}%`,
                    borderColor: BIN_META[selectedPatch.bin].color,
                    background: `${BIN_META[selectedPatch.bin].color}24`,
                  }}
                />
              </div>
              {roiHistory.map((savedRoi, index) => {
                const metrics = roiComparisons[index];
                return (
                  <div
                    key={`${savedRoi.nx}-${savedRoi.ny}-${index}`}
                    className={`roi-box saved ${roi === savedRoi ? "active" : ""}`}
                    style={{
                      left: `${savedRoi.nx * 100}%`,
                      top: `${savedRoi.ny * 100}%`,
                      width: `${savedRoi.nw * 100}%`,
                      height: `${savedRoi.nh * 100}%`,
                    }}
                  >
                    <span>
                      {metrics?.label ?? `ROI ${index + 1}`} ·{" "}
                      {metrics?.tps.toFixed(1) ?? "0.0"}% TPS
                    </span>
                  </div>
                );
              })}
              {roiDraft ? (
                <div
                  className="roi-box draft"
                  style={{
                    left: `${roiDraft.nx * 100}%`,
                    top: `${roiDraft.ny * 100}%`,
                    width: `${roiDraft.nw * 100}%`,
                    height: `${roiDraft.nh * 100}%`,
                  }}
                >
                  <span>ROI · drawing</span>
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
                <img
                  src={
                    selectedCase.thumbnailUrl ?? "/assets/wsi-overview.png"
                  }
                  alt=""
                />
                <span
                  style={{
                    width: `${Math.max(22, 64 / zoom)}%`,
                    height: `${Math.max(25, 70 / zoom)}%`,
                    left: `${Math.min(
                      74,
                      Math.max(
                        2,
                        (selectedPatch.x / slideWidth) * 100 - 20,
                      ),
                    )}%`,
                    top: `${Math.min(
                      70,
                      Math.max(
                        2,
                        (selectedPatch.y / slideHeight) * 100 - 18,
                      ),
                    )}%`,
                  }}
                />
              </button>
              {heatmapVisible ? (
                <div className="heatmap-data-legend">
                  <b>PATCH-DERIVED KDE</b>
                  <span />
                  <small>低 TPS</small>
                  <small>高 TPS</small>
                </div>
              ) : null}
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
                        setRoiHistory([]);
                        setGalleryBin("All");
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                {roiComparisons.length ? (
                  <div className="roi-comparison-tabs">
                    {roiComparisons.map((item) => (
                      <button
                        type="button"
                        key={`${item.roi.nx}-${item.roi.ny}`}
                        className={roi === item.roi ? "active" : ""}
                        onClick={() => {
                          setRoi(item.roi);
                          setGalleryBin("All");
                        }}
                      >
                        <span>{item.label}</span>
                        <b>{item.tps.toFixed(1)}%</b>
                      </button>
                    ))}
                  </div>
                ) : null}
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
                  src={patchCellsUrl(selectedPatch)}
                  alt="当前 Patch 高分辨率图像"
                />
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
                  src={patchProbabilityUrl(selectedPatch)}
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
