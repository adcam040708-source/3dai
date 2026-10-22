import { useState } from "react";
import type { ShotPromptEntry } from "./shotPromptExporter";

export interface ShotExperimentRecord {
  id: string;
  createdAt: string;
  shotId: string;
  shotName: string;
  durationSeconds: number;
  method: "plain-text" | "structured-text" | "reference-video";
  model: string;
  seed: string;
  submittedPrompt: string;
  outputReference: string;
  attempts: number;
  scores: { camera: number; staging: number; continuity: number };
  notes: string;
}

function storageKey() {
  return `director-shot-experiments-v1:${new URLSearchParams(window.location.search).get("instanceId") ?? "default"}`;
}

function readRecords(): ShotExperimentRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((record) => record && typeof record.id === "string" && typeof record.shotId === "string") : [];
  } catch { return []; }
}

export function ShotExperimentPanel({ entry }: { entry?: ShotPromptEntry }) {
  const [records, setRecords] = useState<ShotExperimentRecord[]>(readRecords);
  const [method, setMethod] = useState<ShotExperimentRecord["method"]>(entry?.structuredParams.mode === "reference-video" ? "reference-video" : "structured-text");
  const [model, setModel] = useState("");
  const [seed, setSeed] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [outputReference, setOutputReference] = useState("");
  const [attempts, setAttempts] = useState(1);
  const [cameraScore, setCameraScore] = useState("");
  const [stagingScore, setStagingScore] = useState("");
  const [continuityScore, setContinuityScore] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");

  function saveRecord() {
    if (!entry || !model.trim() || !submittedPrompt.trim() || !outputReference.trim() || !cameraScore || !stagingScore || !continuityScore) {
      setStatus("请填写实际模型、提交的提示词、结果文件名或编号，以及三项评分。");
      return;
    }
    const record: ShotExperimentRecord = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      shotId: entry.shotId, shotName: entry.shotName, durationSeconds: entry.structuredParams.durationSeconds,
      method, model: model.trim(), seed: seed.trim(), submittedPrompt: submittedPrompt.trim(),
      outputReference: outputReference.trim(), attempts: Math.max(1, Math.round(attempts || 1)),
      scores: { camera: Number(cameraScore), staging: Number(stagingScore), continuity: Number(continuityScore) }, notes: notes.trim(),
    };
    const next = [...records, record];
    try {
      localStorage.setItem(storageKey(), JSON.stringify(next));
      setRecords(next);
      setStatus("已保存真实生成记录，请下载 JSON 备份；视频文件仍需你单独保存。");
      setOutputReference(""); setNotes("");
    } catch { setStatus("浏览器存储不足，记录未保存。请先下载已有记录备份。"); }
  }

  function downloadRecords() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, records }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "director-generation-experiments.json";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function score(label: string, value: string, setter: (value: string) => void) {
    return <label>{label}<select aria-label={label} value={value} onChange={(event) => setter(event.target.value)}>
      <option value="">未评分</option>{[1, 2, 3, 4, 5].map((number) => <option key={number} value={String(number)}>{number} 分</option>)}
    </select></label>;
  }

  return <details className="shot-experiment-panel"><summary>生成验证与对比记录（已保存 {records.length} 条）</summary>
    <p className="shot-prompt-help">生成并检查视频后再记录。1 分表示明显偏离，3 分表示部分符合，5 分表示基本符合预演。尽量使用相同模型版本、画幅、时长和种子做对比。这里只保存文字记录，不上传或保存视频。</p>
    <div className="shot-experiment-grid">
      <label>验证镜头<input aria-label="验证镜头" value={entry?.shotName ?? "暂无镜头"} readOnly /></label>
      <label>实验方法<select aria-label="实验方法" value={method} onChange={(event) => setMethod(event.target.value as ShotExperimentRecord["method"])}>
        <option value="plain-text">普通文字提示词</option><option value="structured-text">导演台分段提示词</option><option value="reference-video">分段提示词 + 参考视频</option>
      </select></label>
      <label>实际模型与版本<input aria-label="实际模型与版本" value={model} onChange={(event) => setModel(event.target.value)} placeholder="填写生成时控制台显示的模型" /></label>
      <label>随机种子（可选）<input aria-label="随机种子" value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
      <label>结果文件名或编号<input aria-label="结果文件名或编号" value={outputReference} onChange={(event) => setOutputReference(event.target.value)} placeholder="例如：shot01-B-01.mp4" /></label>
      <label>生成尝试次数<input aria-label="生成尝试次数" type="number" min={1} step={1} value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} /></label>
      {score("运镜符合度", cameraScore, setCameraScore)}{score("人物空间符合度", stagingScore, setStagingScore)}{score("连续性", continuityScore, setContinuityScore)}
    </div>
    <label className="shot-experiment-prompt">实际提交的提示词<textarea aria-label="实际提交的提示词" value={submittedPrompt} onChange={(event) => setSubmittedPrompt(event.target.value)} rows={4} /></label>
    <div className="shot-prompt-actions"><button type="button" disabled={!entry} onClick={() => {
      setSubmittedPrompt(entry!.promptText);
      setMethod(entry!.structuredParams.mode === "reference-video" ? "reference-video" : "structured-text");
    }}>填入当前镜头提示词</button></div>
    <label className="shot-experiment-prompt">观察与失败原因<textarea aria-label="观察与失败原因" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="记录越轴、人物复制、动作遗漏、镜头偏移等实际现象" /></label>
    <div className="shot-prompt-actions"><button type="button" disabled={!entry} onClick={saveRecord}>保存生成记录</button><button type="button" disabled={!records.length} onClick={downloadRecords}>下载实验记录 JSON</button></div>
    {status ? <p role="status" className="shot-prompt-status">{status}</p> : null}
    {records.length ? <ul className="shot-experiment-records">{records.slice(-5).reverse().map((record) => <li key={record.id}>{record.shotName} · {record.model} · {record.outputReference} · 运镜 {record.scores.camera} / 空间 {record.scores.staging} / 连续性 {record.scores.continuity}</li>)}</ul> : null}
  </details>;
}
