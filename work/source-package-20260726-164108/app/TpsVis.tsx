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
  cellsFile?: File;
};

type CellDetection = {
  x: number;
  y: number;
  centerProbability: number;
  positiveProbability: number;
  prediction: "Positive" | "Negative";
};

type VisiblePyramidTile = {
  patch: PatchItem;
  row: number;
  column: number;
  pixelWidth: number;
  pixelHeight: number;
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

const EMPTY_CASE: CaseItem = {
  id: "",
  type: "穿刺活检",
  tps: 0,
  totalPatches: 0,
  totalCells: 0,
};

const EMPTY_PATCH: PatchItem = {
  id: 0,
  x: 0,
  y: 0,
  tps: 0,
  cells: 0,
  bin: "Neg",
};

const MIN_VIEW_ZOOM = 0.85;
const MAX_VIEW_ZOOM = 32;
const ZOOM_BUTTON_FACTOR = 1.5;
const PATCH_FOCUS_ZOOM = 4;

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

function fitSlideFrame(
  stageWidth: number,
  stageHeight: number,
  slideWidth: number,
  slideHeight: number,
) {
  const availableWidth = Math.max(0, stageWidth * 0.92);
  const availableHeight = Math.max(0, stageHeight * 0.85);
  const slideAspect = slideWidth / Math.max(1, slideHeight);
  let width = availableWidth;
  let height = width / slideAspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * slideAspect;
  }
  return {
    left: (stageWidth - width) / 2,
    top: (stageHeight - height) / 2,
    width,
    height,
    centerX: stageWidth / 2,
    centerY: stageHeight / 2,
  };
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

function parseCellDetections(csvText: string): CellDetection[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase(),
  );
  const headerIndex = new Map(
    headers.map((header, index) => [header, index]),
  );
  const readColumn = (values: string[], name: string) =>
    values[headerIndex.get(name) ?? -1] ?? "";

  return lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line);
    const x = Number(readColumn(values, "x"));
    const y = Number(readColumn(values, "y"));
    const centerProbability = Number(readColumn(values, "center_prob"));
    const positiveProbability = Number(readColumn(values, "cell_pos_prob"));
    const rawPrediction = readColumn(values, "cell_pred").toLowerCase();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];

    return [
      {
        x,
        y,
        centerProbability: Number.isFinite(centerProbability)
          ? Math.max(0, Math.min(1, centerProbability))
          : 1,
        positiveProbability: Number.isFinite(positiveProbability)
          ? Math.max(0, Math.min(1, positiveProbability))
          : rawPrediction === "positive"
            ? 1
            : 0,
        prediction:
          rawPrediction === "positive"
            ? ("Positive" as const)
            : ("Negative" as const),
      },
    ];
  });
}

function normalizeFolderPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function withoutRootFolder(path: string) {
  const normalized = normalizeFolderPath(path);
  const parts = normalized.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

function clampLevel(level: number, minLevel: number, maxLevel: number) {
  return Math.max(minLevel, Math.min(maxLevel, level));
}

function computeVisibleTiles({
  patches,
  slideWidth,
  slideHeight,
  stageWidth,
  stageHeight,
  frameWidth,
  frameHeight,
  zoom,
  pan,
  level,
}: {
  patches: PatchItem[];
  slideWidth: number;
  slideHeight: number;
  stageWidth: number;
  stageHeight: number;
  frameWidth: number;
  frameHeight: number;
  zoom: number;
  pan: { x: number; y: number };
  level: number;
}) {
  if (
    level < 1 ||
    !patches.length ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    zoom <= 0
  ) {
    return [] as VisiblePyramidTile[];
  }

  const centerX = 0.5 - pan.x / (frameWidth * zoom);
  const centerY = 0.5 - pan.y / (frameHeight * zoom);
  const halfWidth = stageWidth / (2 * frameWidth * zoom);
  const halfHeight = stageHeight / (2 * frameHeight * zoom);
  const leftPixel = Math.max(
    0,
    Math.floor((centerX - halfWidth) * slideWidth),
  );
  const rightPixel = Math.min(
    slideWidth,
    Math.ceil((centerX + halfWidth) * slideWidth),
  );
  const topPixel = Math.max(
    0,
    Math.floor((centerY - halfHeight) * slideHeight),
  );
  const bottomPixel = Math.min(
    slideHeight,
    Math.ceil((centerY + halfHeight) * slideHeight),
  );
  if (rightPixel <= leftPixel || bottomPixel <= topPixel) {
    return [] as VisiblePyramidTile[];
  }

  const minColumn = Math.floor(leftPixel / 512);
  const maxColumn = Math.floor(Math.max(leftPixel, rightPixel - 1) / 512);
  const minRow = Math.floor(topPixel / 512);
  const maxRow = Math.floor(Math.max(topPixel, bottomPixel - 1) / 512);
  const patchByCoordinate = new Map(
    patches.map((patch) => [`${patch.x}:${patch.y}`, patch]),
  );
  const visible: VisiblePyramidTile[] = [];

  for (let row = minRow; row <= maxRow; row += 1) {
    const y = row * 512;
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const x = column * 512;
      const patch = patchByCoordinate.get(`${x}:${y}`);
      if (!patch) continue;
      visible.push({
        patch,
        row,
        column,
        pixelWidth: Math.max(0, Math.min(512, slideWidth - x)),
        pixelHeight: Math.max(0, Math.min(512, slideHeight - y)),
      });
    }
  }
  return visible;
}

async function readImageDimensions(file: File) {
  const header = new Uint8Array(
    await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer(),
  );
  if (
    header.length >= 24 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47
  ) {
    const view = new DataView(header.buffer);
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }
  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) {
    return null;
  }
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < header.length) {
    if (header[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < header.length && header[offset] === 0xff) offset += 1;
    const marker = header[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= header.length) break;
    const segmentLength = (header[offset] << 8) | header[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > header.length) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: (header[offset + 3] << 8) | header[offset + 4],
        width: (header[offset + 5] << 8) | header[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
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
  const stitchedFile =
    fileMap.get("stitched.jpg") ?? fileMap.get("stitched.jpeg");
  const thumbnailFile =
    fileMap.get("thumbnail.png") ??
    fileMap.get("thumbnail.jpg") ??
    stitchedFile;

  if (!manifestFile || !summaryFile || !thumbnailFile) {
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
    const manifestCellsPath = normalizeFolderPath(
      readColumn(values, "cells_csv"),
    ).toLowerCase();
    const cellsFile =
      (manifestCellsPath ? fileMap.get(manifestCellsPath) : undefined) ??
      fileMap.get(`${patchFolder}cells.csv`);
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
      cellsFile,
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

  const overviewUrl = URL.createObjectURL(thumbnailFile);
  const manifestWidth = Math.max(...patches.map((patch) => patch.x + 512));
  const manifestHeight = Math.max(...patches.map((patch) => patch.y + 512));
  const stitchedDimensions = stitchedFile
    ? await readImageDimensions(stitchedFile)
    : null;
  const exactSlideWidth = Math.max(
    Math.max(...patches.map((patch) => patch.x + 1)),
    stitchedDimensions?.width ?? manifestWidth,
  );
  const exactSlideHeight = Math.max(
    Math.max(...patches.map((patch) => patch.y + 1)),
    stitchedDimensions?.height ?? manifestHeight,
  );
  const caseId =
    rootFolder !== "Local case"
      ? rootFolder
      : summary.wsi_id || rootFolder;

  return {
    id: caseId,
    folderName: rootFolder,
    type: "穿刺活检",
    tps: totalCells ? weightedTps / totalCells : 0,
    totalPatches: patches.length,
    totalCells,
    source: "local",
    thumbnailUrl: overviewUrl,
    slideUrl: overviewUrl,
    patches,
    slideWidth: exactSlideWidth,
    slideHeight: exactSlideHeight,
  };
}

function patchImageUrl(patch: PatchItem) {
  return patch.imageUrl ?? `/assets/patches/p${patch.id}/image.jpg`;
}

function probabilityColor(probability: number) {
  const hue = Math.round((1 - Math.max(0, Math.min(1, probability))) * 220);
  return `hsl(${hue} 88% 52%)`;
}

function CellPreviewImage({
  patch,
  detections,
  mode,
}: {
  patch: PatchItem;
  detections: CellDetection[];
  mode: "phenotype" | "probability";
}) {
  const suppliedOverlay =
    mode === "phenotype" ? patch.cellsUrl : patch.probabilityUrl;
  if (suppliedOverlay) {
    return (
      <img
        src={suppliedOverlay}
        alt={
          mode === "phenotype"
            ? "当前 Patch 细胞表型标注图"
            : "当前 Patch 细胞概率图"
        }
      />
    );
  }

  const filterId = `probability-blur-${patch.id}`;
  return (
    <>
      <img src={patchImageUrl(patch)} alt="当前 Patch 高分辨率图像" />
      {detections.length ? (
        <svg
          className={`cell-csv-overlay ${mode}`}
          viewBox="0 0 512 512"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {mode === "probability" ? (
            <defs>
              <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="5" />
              </filter>
            </defs>
          ) : null}
          {mode === "phenotype" ? (
            detections.map((cell, index) => (
              <circle
                key={`${cell.x}-${cell.y}-${index}`}
                cx={cell.x}
                cy={cell.y}
                r={5}
                className={
                  cell.prediction === "Positive" ? "positive" : "negative"
                }
              />
            ))
          ) : (
            <>
              <g filter={`url(#${filterId})`} className="probability-cloud">
                {detections.map((cell, index) => (
                  <circle
                    key={`cloud-${cell.x}-${cell.y}-${index}`}
                    cx={cell.x}
                    cy={cell.y}
                    r={10 + cell.centerProbability * 9}
                    fill={probabilityColor(cell.positiveProbability)}
                  />
                ))}
              </g>
              {detections.map((cell, index) => (
                <circle
                  key={`point-${cell.x}-${cell.y}-${index}`}
                  cx={cell.x}
                  cy={cell.y}
                  r={2.2}
                  fill={probabilityColor(cell.positiveProbability)}
                  className="probability-point"
                />
              ))}
            </>
          )}
        </svg>
      ) : null}
    </>
  );
}

type TileLoadJob = {
  cancelled: boolean;
  cancelActive?: () => void;
  run: (job: TileLoadJob) => Promise<void>;
};

const tileLoadQueue: TileLoadJob[] = [];
const decodedTileCache = new Set<string>();
let activeTileLoads = 0;
const MAX_CONCURRENT_TILE_LOADS = 6;

function pumpTileLoadQueue() {
  while (
    activeTileLoads < MAX_CONCURRENT_TILE_LOADS &&
    tileLoadQueue.length
  ) {
    const job = tileLoadQueue.shift();
    if (!job || job.cancelled) continue;
    activeTileLoads += 1;
    void job
      .run(job)
      .catch(() => undefined)
      .finally(() => {
        activeTileLoads -= 1;
        pumpTileLoadQueue();
      });
  }
}

function enqueueTileLoad(run: (job: TileLoadJob) => Promise<void>) {
  const job: TileLoadJob = { cancelled: false, run };
  tileLoadQueue.push(job);
  pumpTileLoadQueue();
  return () => {
    job.cancelled = true;
    job.cancelActive?.();
  };
}

function waitForImage(url: string, job: TileLoadJob) {
  return new Promise<void>((resolve, reject) => {
    const probe = new Image();
    probe.decoding = "async";
    const finish = (callback: () => void) => {
      probe.onload = null;
      probe.onerror = null;
      job.cancelActive = undefined;
      callback();
    };
    probe.onload = () => finish(resolve);
    probe.onerror = () =>
      finish(() => reject(new Error("Patch image decode failed")));
    job.cancelActive = () => {
      probe.src = "";
      finish(() => reject(new Error("Patch image load cancelled")));
    };
    probe.src = url;
  });
}

function HighResolutionPatchTile({
  patch,
  left,
  top,
  width,
  height,
  backgroundWidth,
  backgroundHeight,
}: {
  patch: PatchItem;
  left: number;
  top: number;
  width: number;
  height: number;
  backgroundWidth: number;
  backgroundHeight: number;
}) {
  const [ready, setReady] = useState(false);
  const source = patchImageUrl(patch);

  useEffect(() => {
    let disposed = false;
    if (decodedTileCache.has(source)) {
      setReady(true);
      return;
    }
    setReady(false);
    const cancel = enqueueTileLoad(async (job) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (job.cancelled) return;
        try {
          await waitForImage(source, job);
          if (!disposed && !job.cancelled) {
            decodedTileCache.add(source);
            setReady(true);
          }
          return;
        } catch {
          if (!job.cancelled && attempt < 2) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, 180 * 2 ** attempt),
            );
          }
        }
      }
    });
    return () => {
      disposed = true;
      cancel();
    };
  }, [source]);

  if (!ready) return null;
  return (
    <span
      className="wsi-pyramid-tile"
      aria-hidden="true"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        backgroundImage: `url("${source}")`,
        backgroundSize: `${backgroundWidth}px ${backgroundHeight}px`,
      }}
    />
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
    const patchFootprint = Math.max(
      (512 / slideWidth) * width,
      (512 / slideHeight) * height,
    );
    const radius = Math.max(8, Math.min(22, patchFootprint * 1.8));
    const ordered = [...patches].sort((a, b) => a.tps - b.tps);

    ctx.globalCompositeOperation = "source-over";
    ordered.forEach((patch) => {
      const x = (patch.x / slideWidth) * width;
      const y = (patch.y / slideHeight) * height;
      const [red, green, blue] = colors[patch.bin];
      const cellWeight = Math.sqrt(patch.cells / maxCells);
      const tpsWeight = 0.22 + (patch.tps / 100) * 0.78;
      const alpha = 0.05 + cellWeight * tpsWeight * 0.17;
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
  const [selectedCaseId, setSelectedCaseId] = useState("");
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
  const [heatmapVisible, setHeatmapVisible] = useState(false);
  const [roiTool, setRoiTool] = useState(false);
  const [roi, setRoi] = useState<Roi | null>(null);
  const [roiHistory, setRoiHistory] = useState<Roi[]>([]);
  const [roiDraft, setRoiDraft] = useState<Roi | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [cellLoading, setCellLoading] = useState(false);
  const [cellDetections, setCellDetections] = useState<CellDetection[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "当前尚未载入病例。请选择本地病例文件夹后再开始分析。",
    },
  ]);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageLayerRef = useRef<HTMLDivElement>(null);
  const heatmapLayerRef = useRef<HTMLDivElement>(null);
  const detailLayerRef = useRef<HTMLDivElement>(null);
  const selectionLayerRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const livePanRef = useRef({ x: 0, y: 0 });
  const liveZoomRef = useRef(1);
  const panFrameRef = useRef<number | null>(null);
  const wheelZoomTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    mode: "pan" | "roi";
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const allCases = localCases;
  const selectedCase =
    allCases.find((item) => item.id === selectedCaseId) ?? EMPTY_CASE;
  const casePatches = useMemo(
    () => selectedCase.patches ?? [],
    [selectedCase],
  );
  const hasData = Boolean(selectedCase.id && casePatches.length);
  const slideWidth = selectedCase.slideWidth ?? 65000;
  const slideHeight = selectedCase.slideHeight ?? 18000;
  const slideFrame = useMemo(
    () =>
      fitSlideFrame(
        stageSize.width,
        stageSize.height,
        slideWidth,
        slideHeight,
      ),
    [slideHeight, slideWidth, stageSize.height, stageSize.width],
  );

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
    casePatches.find((patch) => patch.id === selectedPatchId) ??
    casePatches[0] ??
    EMPTY_PATCH;
  const requestedPyramidLevel =
    zoom < 1.8 ? 0 : Math.max(1, Math.ceil(Math.log2(zoom)));
  const activePyramidLevel = clampLevel(requestedPyramidLevel, 0, 1);
  const visiblePyramidTiles = useMemo(
    () =>
      computeVisibleTiles({
        patches: hasData ? casePatches : [],
        slideWidth,
        slideHeight,
        stageWidth: stageSize.width,
        stageHeight: stageSize.height,
        frameWidth: slideFrame.width,
        frameHeight: slideFrame.height,
        zoom,
        pan,
        level: activePyramidLevel,
      }),
    [
      activePyramidLevel,
      casePatches,
      hasData,
      pan,
      slideFrame.height,
      slideFrame.width,
      slideHeight,
      slideWidth,
      stageSize.height,
      stageSize.width,
      zoom,
    ],
  );
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
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    livePanRef.current = pan;
    liveZoomRef.current = zoom;
  }, [pan, zoom]);

  useEffect(
    () => () => {
      if (panFrameRef.current !== null) {
        window.cancelAnimationFrame(panFrameRef.current);
      }
      if (wheelZoomTimerRef.current !== null) {
        window.clearTimeout(wheelZoomTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const cellsFile = selectedPatch.cellsFile;
    setCellLoading(true);

    if (!hasData || !cellsFile) {
      setCellDetections([]);
      const timer = window.setTimeout(() => {
        if (!cancelled) setCellLoading(false);
      }, 180);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    cellsFile
      .text()
      .then((text) => {
        if (!cancelled) setCellDetections(parseCellDetections(text));
      })
      .catch(() => {
        if (!cancelled) setCellDetections([]);
      })
      .finally(() => {
        if (!cancelled) setCellLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasData, selectedCaseId, selectedPatch.cellsFile, selectedPatchId]);

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
    const targetZoom = Math.max(zoom, PATCH_FOCUS_ZOOM);
    const stage = stageRef.current;
    const layer = imageLayerRef.current;
    const stageWidth = stage?.clientWidth ?? stageSize.width;
    const stageHeight = stage?.clientHeight ?? stageSize.height;
    const fallbackFrame = fitSlideFrame(
      stageWidth,
      stageHeight,
      slideWidth,
      slideHeight,
    );
    const layerWidth = layer?.offsetWidth ?? fallbackFrame.width;
    const layerHeight = layer?.offsetHeight ?? fallbackFrame.height;
    const layerCenterX =
      (layer?.offsetLeft ?? fallbackFrame.left) + layerWidth / 2;
    const layerCenterY =
      (layer?.offsetTop ?? fallbackFrame.top) + layerHeight / 2;
    const patchCenterX = (patch.x + 256) / slideWidth;
    const patchCenterY = (patch.y + 256) / slideHeight;
    const nextPan = {
      x:
        stageWidth / 2 -
        layerCenterX -
        (patchCenterX - 0.5) * layerWidth * targetZoom,
      y:
        stageHeight / 2 -
        layerCenterY -
        (patchCenterY - 0.5) * layerHeight * targetZoom,
    };

    setSelectedPatchId(patch.id);
    livePanRef.current = nextPan;
    liveZoomRef.current = targetZoom;
    setZoom(targetZoom);
    setPan(nextPan);
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

  const renderLivePan = (nextPan: { x: number; y: number }) => {
    livePanRef.current = nextPan;
    if (panFrameRef.current !== null) return;
    panFrameRef.current = window.requestAnimationFrame(() => {
      panFrameRef.current = null;
      const currentPan = livePanRef.current;
      const currentZoom = liveZoomRef.current;
      const cameraTransform = `translate3d(${currentPan.x}px, ${currentPan.y}px, 0) scale(${currentZoom})`;
      const screenTransform = `translate3d(${currentPan.x}px, ${currentPan.y}px, 0)`;
      if (imageLayerRef.current) {
        imageLayerRef.current.style.transform = cameraTransform;
      }
      if (heatmapLayerRef.current) {
        heatmapLayerRef.current.style.transform = cameraTransform;
      }
      if (detailLayerRef.current) {
        detailLayerRef.current.style.transform = screenTransform;
      }
      if (selectionLayerRef.current) {
        selectionLayerRef.current.style.transform = screenTransform;
      }
    });
  };

  const commitLivePan = () => {
    if (panFrameRef.current !== null) {
      window.cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    const nextPan = livePanRef.current;
    const currentZoom = liveZoomRef.current;
    const cameraTransform = `translate3d(${nextPan.x}px, ${nextPan.y}px, 0) scale(${currentZoom})`;
    const screenTransform = `translate3d(${nextPan.x}px, ${nextPan.y}px, 0)`;
    if (imageLayerRef.current) {
      imageLayerRef.current.style.transform = cameraTransform;
      imageLayerRef.current.classList.remove("dragging");
    }
    if (heatmapLayerRef.current) {
      heatmapLayerRef.current.style.transform = cameraTransform;
      heatmapLayerRef.current.classList.remove("dragging");
    }
    if (detailLayerRef.current) {
      detailLayerRef.current.style.transform = screenTransform;
    }
    if (selectionLayerRef.current) {
      selectionLayerRef.current.style.transform = screenTransform;
    }
    setPan({ ...nextPan });
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasData) return;
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
    livePanRef.current = pan;
    imageLayerRef.current?.classList.add("dragging");
    heatmapLayerRef.current?.classList.add("dragging");
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
      renderLivePan({
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
    if (dragRef.current?.mode === "pan") {
      commitLivePan();
    }
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

  const onStagePointerCancel = () => {
    if (dragRef.current?.mode === "pan") {
      commitLivePan();
    }
    imageLayerRef.current?.classList.remove("dragging");
    heatmapLayerRef.current?.classList.remove("dragging");
    dragRef.current = null;
    setRoiDraft(null);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!hasData) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    const currentZoom = liveZoomRef.current;
    const currentPan = livePanRef.current;
    const nextZoom = Math.max(
      MIN_VIEW_ZOOM,
      Math.min(MAX_VIEW_ZOOM, currentZoom * factor),
    );
    if (nextZoom === currentZoom) return;

    const stageRect = event.currentTarget.getBoundingClientRect();
    const layer = imageLayerRef.current;
    const fallbackFrame = fitSlideFrame(
      stageRect.width,
      stageRect.height,
      slideWidth,
      slideHeight,
    );
    const layerWidth = layer?.offsetWidth ?? fallbackFrame.width;
    const layerHeight = layer?.offsetHeight ?? fallbackFrame.height;
    const originX =
      (layer?.offsetLeft ?? fallbackFrame.left) + layerWidth / 2;
    const originY =
      (layer?.offsetTop ?? fallbackFrame.top) + layerHeight / 2;
    const pointerX = event.clientX - stageRect.left;
    const pointerY = event.clientY - stageRect.top;
    const ratio = nextZoom / currentZoom;
    const nextPan = {
      x: (1 - ratio) * (pointerX - originX) + ratio * currentPan.x,
      y: (1 - ratio) * (pointerY - originY) + ratio * currentPan.y,
    };

    livePanRef.current = nextPan;
    liveZoomRef.current = nextZoom;
    layer?.classList.add("wheel-zooming");
    heatmapLayerRef.current?.classList.add("wheel-zooming");
    if (wheelZoomTimerRef.current !== null) {
      window.clearTimeout(wheelZoomTimerRef.current);
    }
    wheelZoomTimerRef.current = window.setTimeout(() => {
      imageLayerRef.current?.classList.remove("wheel-zooming");
      heatmapLayerRef.current?.classList.remove("wheel-zooming");
      wheelZoomTimerRef.current = null;
    }, 140);
    setZoom(nextZoom);
    setPan(nextPan);
  };

  const askAgent = (question: string) => {
    if (!hasData) {
      setMessages((current) => [
        ...current,
        { role: "user", text: question },
        {
          role: "agent",
          text: "当前没有可分析的病例数据。请先点击“选择病例文件夹”并完成本地载入。",
        },
      ]);
      return;
    }
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
          <strong>{hasData ? selectedCase.id : "等待载入病例文件夹"}</strong>
          {hasData ? (
            <>
              <span className="context-dot" />
              <span>{selectedCase.type}</span>
            </>
          ) : null}
        </div>
        <div className="global-tps">
          <span>GLOBAL TPS</span>
          <strong>{hasData ? `${selectedCase.tps.toFixed(1)}%` : "—"}</strong>
          {hasData ? (
            <em
              style={{
                color: BIN_META[caseStatus(selectedCase.tps).bin].color,
                borderColor: `${BIN_META[caseStatus(selectedCase.tps).bin].color}66`,
              }}
            >
              {caseStatus(selectedCase.tps).label}
            </em>
          ) : null}
        </div>
        <div className="top-actions">
          <span className="model-status">
            <i />
            {hasData ? "Local data" : "No data"}
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
              {visibleCases.length ? (
                visibleCases.map((item) => {
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
                          backgroundImage: `url("${item.thumbnailUrl}")`,
                          backgroundPosition:
                            item.type === "穿刺活检" ? "12% 50%" : "88% 50%",
                        }}
                      />
                      <span className="case-copy">
                        <small>本地导入 · {item.type}</small>
                        <strong>
                          {item.id.split("_").slice(0, 2).join(" · ")}
                        </strong>
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
                })
              ) : (
                <div className="empty-state initial-empty">
                  <strong>尚未载入病例</strong>
                  <span>选择本地病例文件夹后，病例列表会显示在这里</span>
                </div>
              )}
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
                  <strong>
                    {hasData ? "ROI 内暂无有效 Patch" : "尚无 Patch 数据"}
                  </strong>
                  <span>
                    {hasData
                      ? "扩大选区或清除 ROI 后继续浏览"
                      : "成功载入病例文件夹后自动生成 Patch Gallery"}
                  </span>
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
                  disabled={!hasData}
                >
                  <span className="heat-icon" />
                  TPS KDE 热力图
                </button>
                <button
                  type="button"
                  className={roiTool ? "active" : ""}
                  onClick={() => setRoiTool((value) => !value)}
                  aria-pressed={roiTool}
                  disabled={!hasData}
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
              onPointerCancel={onStagePointerCancel}
              onWheel={onWheel}
            >
              {hasData ? (
                <>
              <div
                ref={imageLayerRef}
                className="wsi-image-layer"
                style={{
                  left: `${slideFrame.left}px`,
                  top: `${slideFrame.top}px`,
                  width: `${slideFrame.width}px`,
                  height: `${slideFrame.height}px`,
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
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
              </div>
              {visiblePyramidTiles.length ? (
                <div
                  className="wsi-pyramid-viewport"
                  aria-label="当前视野的原始分辨率 Patch 图像层"
                >
                  <div
                    ref={detailLayerRef}
                    className="wsi-pyramid-layer"
                    style={{
                      transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                    }}
                  >
                    {visiblePyramidTiles.map((tile) => (
                      <HighResolutionPatchTile
                        key={`${activePyramidLevel}:${tile.row}:${tile.column}`}
                        patch={tile.patch}
                        left={
                          slideFrame.centerX +
                          zoom *
                            (tile.patch.x / slideWidth - 0.5) *
                            slideFrame.width
                        }
                        top={
                          slideFrame.centerY +
                          zoom *
                            (tile.patch.y / slideHeight - 0.5) *
                            slideFrame.height
                        }
                        width={
                          zoom *
                          (tile.pixelWidth / slideWidth) *
                          slideFrame.width
                        }
                        height={
                          zoom *
                          (tile.pixelHeight / slideHeight) *
                          slideFrame.height
                        }
                        backgroundWidth={
                          zoom * (512 / slideWidth) * slideFrame.width
                        }
                        backgroundHeight={
                          zoom * (512 / slideHeight) * slideFrame.height
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {heatmapVisible ? (
                <div
                  ref={heatmapLayerRef}
                  className="wsi-heatmap-camera"
                  style={{
                    left: `${slideFrame.left}px`,
                    top: `${slideFrame.top}px`,
                    width: `${slideFrame.width}px`,
                    height: `${slideFrame.height}px`,
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                  }}
                >
                  <SlideKdeHeatmap
                    patches={casePatches}
                    slideWidth={slideWidth}
                    slideHeight={slideHeight}
                  />
                </div>
              ) : null}
              <div className="wsi-selection-viewport">
                <div
                  ref={selectionLayerRef}
                  className="wsi-selection-layer"
                  style={{
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                  }}
                >
                  <span
                    className="spatial-patch selected"
                    style={{
                      left: `${
                        slideFrame.centerX +
                        zoom *
                          (selectedPatch.x / slideWidth - 0.5) *
                          slideFrame.width
                      }px`,
                      top: `${
                        slideFrame.centerY +
                        zoom *
                          (selectedPatch.y / slideHeight - 0.5) *
                          slideFrame.height
                      }px`,
                      width: `${
                        zoom * (512 / slideWidth) * slideFrame.width
                      }px`,
                      height: `${
                        zoom * (512 / slideHeight) * slideFrame.height
                      }px`,
                    }}
                  />
                </div>
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
                  onClick={() =>
                    setZoom((value) =>
                      Math.min(MAX_VIEW_ZOOM, value * ZOOM_BUTTON_FACTOR),
                    )
                  }
                  aria-label="放大，最高 3200%"
                  title="放大（最高 3200%）"
                >
                  +
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    setZoom((value) =>
                      Math.max(MIN_VIEW_ZOOM, value / ZOOM_BUTTON_FACTOR),
                    )
                  }
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
                style={{
                  aspectRatio: `${slideWidth} / ${slideHeight}`,
                }}
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
                    width: `${Math.max(4, 64 / zoom)}%`,
                    height: `${Math.max(5, 70 / zoom)}%`,
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
                </>
              ) : (
                <div className="viewer-empty-state">
                  <span>＋</span>
                  <strong>尚未载入病例图像</strong>
                  <p>
                    请选择一个符合格式要求的未压缩病例文件夹。载入成功前，
                    全片图像、热力图和细胞图不会显示。
                  </p>
                  <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => folderInputRef.current?.click()}
                  >
                    选择病例文件夹
                  </button>
                </div>
              )}
              <div className="stage-status">
                {!hasData
                  ? "NO CASE LOADED"
                  : roiTool
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
                    {hasData
                      ? `1001 bins · 0.1% 粒度 · ${
                          roi ? "ROI Mode ρ=0.8" : "Whole Slide ρ=0.9"
                        }`
                      : "等待病例数据"}
                  </p>
                </div>
              </div>
              <span className={`mode-chip ${roi ? "roi" : ""}`}>
                {!hasData ? "NO DATA" : roi ? "LOCAL ROI" : "WHOLE SLIDE"}
              </span>
            </div>
            <div className="distribution-content">
              {hasData ? (
                <>
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
                </>
              ) : (
                <div className="panel-empty-state distribution-empty">
                  <strong>TPS 分布将在载入病例后生成</strong>
                  <span>当前没有直方图、ROI 统计或预设数值</span>
                </div>
              )}
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
                  {hasData
                    ? `Patch ${selectedPatch.id
                        .toString()
                        .padStart(2, "0")} · pixel-linked`
                    : "等待选择 Patch"}
                </p>
              </div>
            </div>
            <span className={`live-badge ${hasData ? "" : "idle"}`}>
              <i />
              {hasData ? "SYNC" : "WAIT"}
            </span>
          </div>

          {hasData ? (
            <>
          <div className="cell-preview-stack">
            <section className="cell-preview">
              <div className="preview-label">
                <span>E-1</span>
                <strong>Cell phenotype labels</strong>
                <small>● Positive&nbsp;&nbsp;● Negative</small>
              </div>
              <div className="microscopy-view">
                <CellPreviewImage
                  patch={selectedPatch}
                  detections={cellDetections}
                  mode="phenotype"
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
                <CellPreviewImage
                  patch={selectedPatch}
                  detections={cellDetections}
                  mode="probability"
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
            </>
          ) : (
            <div className="panel-empty-state cell-empty">
              <strong>尚无细胞级图像</strong>
              <span>
                载入病例并选择一个 Patch 后，这里才会显示细胞标记图和概率图
              </span>
            </div>
          )}
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
            <span>CASE <b>{hasData ? selectedCase.id.split("_")[0] : "NONE"}</b></span>
            <span>
              PATCH{" "}
              <b>
                {hasData
                  ? `#${selectedPatch.id.toString().padStart(2, "0")}`
                  : "—"}
              </b>
            </span>
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
