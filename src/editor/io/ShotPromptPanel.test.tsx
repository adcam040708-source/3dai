import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../store/directorStore";
import { ShotPromptPanel } from "./ShotPromptPanel";
import { ShotExperimentPanel } from "./ShotExperimentPanel";
import { generateShotPrompt } from "./shotPromptExporter";

vi.mock("./referenceVideoExport", () => ({
  requestReferenceVideoExport: vi.fn(async () => ({ blob: new Blob(["fake test video"]), durationSeconds: 6, fileName: "test.mp4" })),
  downloadReferenceVideo: vi.fn(),
}));
import { requestReferenceVideoExport } from "./referenceVideoExport";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/?instanceId=prompt_test");
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows current camera output, supports all cameras and reacts to real project changes", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  state.project.cameras.push({ ...structuredClone(state.project.cameras[0]), id: "cam_2", name: "机位02" });
  render(<ShotPromptPanel onClose={vi.fn()} />);
  expect((screen.getByLabelText("机位01完整提示词") as HTMLTextAreaElement).value).toContain("【时间轴】");
  expect(screen.queryByLabelText("机位02完整提示词")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("导出范围"), "all");
  expect(screen.getByLabelText("机位02完整提示词")).toBeInTheDocument();
  act(() => useDirectorStore.setState((current) => ({ project: { ...current.project, cameras: current.project.cameras.map((camera) => ({ ...camera, name: camera.id === "cam_2" ? "第二镜头" : camera.name })) } })));
  expect(screen.getByLabelText("第二镜头完整提示词")).toBeInTheDocument();
});

it("persists creative settings per director desk without changing scene data", async () => {
  const user = userEvent.setup();
  const original = JSON.stringify(useDirectorStore.getState().project);
  const panel = render(<ShotPromptPanel onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("镜头内容"), { target: { value: "女主走进公寓" } });
  expect((screen.getByLabelText("机位01完整提示词") as HTMLTextAreaElement).value).toContain("女主走进公寓");
  expect(JSON.stringify(useDirectorStore.getState().project)).toBe(original);
  await user.selectOptions(screen.getByLabelText("生成方式"), "text-video");
  expect((screen.getByLabelText("机位01完整提示词") as HTMLTextAreaElement).value).not.toContain("@视频1");
  panel.unmount();
  const reopened = render(<ShotPromptPanel onClose={vi.fn()} />);
  expect(screen.getByLabelText("镜头内容")).toHaveValue("女主走进公寓");
  reopened.unmount();
  window.history.replaceState({}, "", "/?instanceId=another_desk");
  render(<ShotPromptPanel onClose={vi.fn()} />);
  expect(screen.getByLabelText("镜头内容")).toHaveValue("");
});

it("keeps the project safe from scene shortcuts and closes with Escape", () => {
  const close = vi.fn();
  const sceneShortcut = vi.fn();
  document.addEventListener("keydown", sceneShortcut);
  render(<ShotPromptPanel onClose={close} />);
  fireEvent.keyDown(screen.getByLabelText("镜头内容"), { key: "Delete", bubbles: true });
  expect(sceneShortcut).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("button", { name: "复制提示词" }), { key: "Escape", bubbles: true });
  expect(close).toHaveBeenCalledOnce();
  document.removeEventListener("keydown", sceneShortcut);
});

it("copies the full prompt and shows a useful fallback if clipboard fails", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<ShotPromptPanel onClose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "复制提示词" }));
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("【时间轴】"));
  expect(screen.getByRole("status")).toHaveTextContent("已复制");
  copy.mockRejectedValueOnce(new Error("denied"));
  await user.click(screen.getByRole("button", { name: "复制提示词" }));
  expect(screen.getByRole("status")).toHaveTextContent("下载 TXT");
});

it("downloads versioned JSON rather than accidentally copying only a summary", async () => {
  const user = userEvent.setup();
  const urls = vi.fn(() => "blob:test");
  vi.stubGlobal("URL", class extends URL { static createObjectURL = urls; static revokeObjectURL = vi.fn(); });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<ShotPromptPanel onClose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "下载 JSON" }));
  expect(urls).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it("exports the selected camera after the renderer switches camera", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  const second = structuredClone(state.project.cameras[0]);
  second.id = "second"; second.name = "第二机位";
  second.motionPath!.keyframes = [
    { id: "a", time: 0, position: [0, 1, 5], target: [0, 1, 0], fov: 50 },
    { id: "b", time: 1, position: [1, 1, 5], target: [0, 1, 0], fov: 50 },
  ];
  state.project.cameras.push(second);
  render(<ShotPromptPanel onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "导出此机位参考 MP4" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("提示词机位"), "second");
  await user.click(screen.getByRole("button", { name: "导出此机位参考 MP4" }));
  await waitFor(() => expect(requestReferenceVideoExport).toHaveBeenCalledWith(expect.objectContaining({ fileName: "第二机位-reference" })));
  expect(useDirectorStore.getState().project.activeCameraId).toBe("second");
  expect(screen.getByRole("status")).toHaveTextContent("已导出");
});

it("does not invent scores and persists only an actual submitted experiment", async () => {
  const user = userEvent.setup();
  const project = useDirectorStore.getState().project;
  const entry = generateShotPrompt(project.cameras[0], project);
  render(<ShotExperimentPanel entry={entry} />);
  await user.click(screen.getByText("生成验证与对比记录（已保存 0 条）"));
  await user.click(screen.getByRole("button", { name: "保存生成记录" }));
  expect(localStorage.getItem("director-shot-experiments-v1:prompt_test")).toBeNull();
  fireEvent.change(screen.getByLabelText("实际模型与版本"), { target: { value: "实际测试模型" } });
  fireEvent.change(screen.getByLabelText("结果文件名或编号"), { target: { value: "shot01-B-01.mp4" } });
  await user.click(screen.getByRole("button", { name: "填入当前镜头提示词" }));
  for (const label of ["运镜符合度", "人物空间符合度", "连续性"]) await user.selectOptions(screen.getByLabelText(label), "3");
  await user.click(screen.getByRole("button", { name: "保存生成记录" }));
  const saved = JSON.parse(localStorage.getItem("director-shot-experiments-v1:prompt_test")!);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ shotId: entry.shotId, model: "实际测试模型", outputReference: "shot01-B-01.mp4", scores: { camera: 3, staging: 3, continuity: 3 } });
  expect(saved[0].submittedPrompt).toBe(entry.promptText);
});
