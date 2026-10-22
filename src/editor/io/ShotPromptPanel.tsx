import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopy, Download, X } from "lucide-react";
import { useDirectorStore } from "../store/directorStore";
import { exportAllShotPrompts, formatShotPromptText, type ShotPromptOptions, type ShotPromptTarget, type ShotPromptMode } from "./shotPromptExporter";
import { getCameraMotionPath } from "../schema/cameraMotion";
import { requestReferenceVideoExport, downloadReferenceVideo } from "./referenceVideoExport";
import "./shotPromptPanel.css";
import { ShotExperimentPanel } from "./ShotExperimentPanel";

function storageKey() {
  const instance = new URLSearchParams(window.location.search).get("instanceId") ?? "default";
  return `director-shot-prompt-options-v2:${instance}`;
}

function readOptions(): ShotPromptOptions {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    return {
      target: parsed.target === "generic" ? "generic" : "seedance",
      mode: parsed.mode === "text-video" ? "text-video" : "reference-video",
      ...Object.fromEntries(["creativeBrief", "visualStyle", "soundBrief", "additionalConstraints"]
        .map((field) => [field, typeof parsed[field] === "string" ? parsed[field] : ""])),
    };
  } catch { return { target: "seedance", mode: "reference-video" }; }
}

function downloadText(fileName: string, text: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ShotPromptPanel({ onClose, renderAspectRatio }: { onClose: () => void; renderAspectRatio?: number }) {
  const project = useDirectorStore((state) => state.project);
  const aspectRatio = useDirectorStore((state) => state.viewportAspectRatio);
  const finishedShotFov = useDirectorStore((state) => state.finishedShotFov);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const setCameraMotionPlaying = useDirectorStore((state) => state.setCameraMotionPlaying);
  const [options, setOptions] = useState<ShotPromptOptions>(readOptions);
  const [scope, setScope] = useState("current");
  const [selectedId, setSelectedId] = useState(project.activeCameraId ?? project.cameras[0]?.id ?? "");
  const [status, setStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const selectedCamera = project.cameras.find((camera) => camera.id === selectedId) ?? project.cameras[0];
  const selectedCameraId = selectedCamera?.id;
  const entries = useMemo(() => exportAllShotPrompts(
    scope === "all" ? project : { ...project, cameras: selectedCamera ? [selectedCamera] : [] },
    { ...options, aspectRatio, renderAspectRatio, finishedShotFov },
  ), [project, scope, selectedCamera, options, aspectRatio, renderAspectRatio, finishedShotFov]);

  useEffect(() => {
    try { localStorage.setItem(storageKey(), JSON.stringify(options)); }
    catch { /* Export still works if browser storage is unavailable. */ }
  }, [options]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    setCameraMotionPlaying(false);
    copyButtonRef.current?.focus();
    return () => previousFocus?.focus();
  }, [setCameraMotionPlaying]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !exporting) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select, textarea, summary, input") ?? []);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      // Prevent scene shortcuts (WASD, Delete and Ctrl+Z) from editing the project behind the dialog.
      event.stopPropagation();
    }
    const dialog = dialogRef.current;
    dialog?.addEventListener("keydown", handleKey);
    return () => dialog?.removeEventListener("keydown", handleKey);
  }, [onClose, exporting]);

  function updateOption(field: keyof ShotPromptOptions, value: string) {
    setOptions((current) => ({ ...current, [field]: value }));
    setStatus("");
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus("已复制，可粘贴到视频生成平台。"); }
    catch { setStatus("浏览器没有允许复制，可选中提示词手动复制，或下载 TXT。"); }
  }

  async function exportVideo() {
    if (!selectedCamera || exporting) return;
    setActiveCamera(selectedCamera.id);
    setCameraMotionPlaying(false);
    setExporting(true);
    setStatus("正在导出当前镜头的参考视频，请保持页面开启……");
    try {
      // Let the renderer switch to the selected camera before requesting a clean capture.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const result = await requestReferenceVideoExport({ fileName: `${selectedCamera.name}-reference`, quality: "720p", fps: 30 });
      downloadReferenceVideo(result);
      setStatus(`已导出时间轴为 ${result.durationSeconds} 秒的参考视频，文件实际时长可能存在录制误差。上传到生成平台${options.target === "seedance" ? "，作为 @视频1 使用" : "作为运镜与动作参考"}。`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "参考视频导出失败，可从运镜工作台重试。"); }
    finally { setExporting(false); }
  }

  return createPortal(
    <div className="shot-prompt-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !exporting) onClose();
    }}>
      <div ref={dialogRef} className="shot-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="shot-prompt-title">
        <header className="shot-prompt-header">
          <div><h2 id="shot-prompt-title">AI 视频提示词</h2><p>将三维调度转成可复制的分段提示词和工程数据</p></div>
          <button type="button" aria-label="关闭 AI 提示词" disabled={exporting} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="shot-prompt-layout">
          <aside className="shot-prompt-settings" aria-label="提示词设置">
            <label>目标工作流<select aria-label="目标工作流" value={options.target ?? "seedance"} onChange={(event) => updateOption("target", event.target.value as ShotPromptTarget)}>
              <option value="seedance">Seedance 导演格式</option><option value="generic">通用视频提示词</option>
            </select></label>
            <label>生成方式<select aria-label="生成方式" value={options.mode ?? "reference-video"} onChange={(event) => updateOption("mode", event.target.value as ShotPromptMode)}>
              <option value="reference-video">三维参考视频 + 提示词</option><option value="text-video">仅文字提示词</option>
            </select></label>
            <label>导出范围<select aria-label="导出范围" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="current">选中的镜头</option><option value="all">全部机位（分别生成）</option>
            </select></label>
            <label>参考视频对应机位<select aria-label="提示词机位" value={selectedCameraId ?? ""} disabled={exporting || !project.cameras.length} onChange={(event) => setSelectedId(event.target.value)}>
              {!project.cameras.length ? <option value="">暂无机位</option> : null}
              {project.cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
            </select></label>
            <label>镜头内容<textarea aria-label="镜头内容" rows={3} value={options.creativeBrief ?? ""} onChange={(event) => updateOption("creativeBrief", event.target.value)} placeholder="例如：女主走进公寓，在餐桌旁停下向朋友挥手" /></label>
            <label>成片视觉设定<textarea aria-label="成片视觉设定" rows={3} value={options.visualStyle ?? ""} onChange={(event) => updateOption("visualStyle", event.target.value)} placeholder="填写场景、人物外观、服装、光线与风格；使用角色名对应三维主体" /></label>
            <label>声音与对白<textarea aria-label="声音与对白" rows={2} value={options.soundBrief ?? ""} onChange={(event) => updateOption("soundBrief", event.target.value)} placeholder="可选：环境音、说话人及台词、音乐安排" /></label>
            <label>补充约束<textarea aria-label="补充约束" rows={2} value={options.additionalConstraints ?? ""} onChange={(event) => updateOption("additionalConstraints", event.target.value)} placeholder="可选：必须保留或避免的具体内容" /></label>
            <p className="shot-prompt-help">画幅与看成片 FOV 沿用导演台设置，时长来自各机位时间轴。镜头内容需与预演动作一致。创作设定仅保存在当前导演台的浏览器中。</p>
          </aside>
          <main className="shot-prompt-results" aria-label="生成的提示词">
            <div className="shot-prompt-actions">
              <button ref={copyButtonRef} type="button" disabled={!entries.length} onClick={() => void copyText(formatShotPromptText(entries))}><ClipboardCopy size={15} />复制提示词</button>
              <button type="button" disabled={!entries.length} onClick={() => downloadText("shot-prompts.json", JSON.stringify(entries, null, 2), "application/json")}><Download size={15} />下载 JSON</button>
              <button type="button" disabled={!entries.length} onClick={() => downloadText("shot-prompts.txt", formatShotPromptText(entries), "text/plain;charset=utf-8")}><Download size={15} />下载 TXT</button>
              <button type="button" disabled={exporting || !selectedCamera || getCameraMotionPath(selectedCamera).keyframes.length < 2} onClick={() => void exportVideo()}><Download size={15} />{exporting ? "正在导出视频…" : "导出此机位参考 MP4"}</button>
            </div>
            <p className="shot-prompt-help">参考视频需你上传到生成平台；这里不会调用模型。全部机位分别对应独立参考视频，素材编号也在每条提示词中重新开始。</p>
            {status ? <p className="shot-prompt-status" role="status">{status}</p> : null}
            {!entries.length ? <p>暂无机位，请先添加机位或记录运镜点。</p> : null}
            {entries.map((entry) => <article className="shot-prompt-entry" key={entry.shotId}>
              <div className="shot-prompt-entry-title"><h3>{entry.shotName}</h3><span>{entry.structuredParams.durationSeconds} 秒 · {entry.structuredParams.timeline.length} 段 · {entry.structuredParams.subjects.length} 个入画主体</span></div>
              <textarea className="shot-prompt-preview" aria-label={`${entry.shotName}完整提示词`} value={entry.promptText} readOnly rows={12} />
              <details className="shot-prompt-checks"><summary>生成前检查（{entry.warnings.length} 项）</summary><ul>{entry.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>
              <details><summary>查看时间轴与结构化参数</summary><pre>{JSON.stringify(entry.structuredParams, null, 2)}</pre></details>
            </article>)}
            <ShotExperimentPanel key={selectedCameraId} entry={entries.find((entry) => entry.shotId === selectedCameraId)} />
          </main>
        </div>
      </div>
    </div>, document.body,
  );
}
