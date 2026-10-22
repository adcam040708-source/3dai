import { Euler, Frustum, Matrix4, PerspectiveCamera, Quaternion, Sphere, Vector3 } from "three";
import { getCharacterActionPreset } from "../presets/characterActionPresets";
import { getCameraMotionPath, getCameraMotionTimingPlan, getCameraMotionTimingSample } from "../schema/cameraMotion";
import { getCameraPlaybackSnapshot } from "../schema/cameraPlayback";
import { getDirectorObjectFocusTarget } from "../schema/cameraTarget";
import type { DirectorCameraShot, DirectorObject, DirectorProject, DirectorTransform } from "../schema/directorProject";
import { getObjectMotionActionSample, getObjectMotionSnapshot, getObjectMotionTimingPlan } from "../schema/objectMotion";
import { constrainObjectMotionTransform } from "../schema/pathCollision";
import { DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS } from "../schema/semanticBody";
import { getViewportAspectRatioValue, type ViewportAspectRatio } from "../schema/viewportAspectRatio";

export const SHOT_PROMPT_SCHEMA_VERSION = 2;
export type ShotPromptMode = "text-video" | "reference-video";
export type ShotPromptTarget = "generic" | "seedance";
type Tuple = [number, number, number];

export interface ShotPromptOptions {
  target?: ShotPromptTarget;
  mode?: ShotPromptMode;
  aspectRatio?: ViewportAspectRatio;
  /** Aspect of the viewport before cropping to the selected output ratio. */
  renderAspectRatio?: number;
  /** The same "finished shot FOV" override used by the reference MP4 renderer. */
  finishedShotFov?: number | null;
  creativeBrief?: string;
  visualStyle?: string;
  soundBrief?: string;
  additionalConstraints?: string;
}

export interface PromptObjectSnapshot {
  id: string;
  name: string;
  kind: DirectorObject["kind"];
  position: Tuple;
  rotationLocalRadians: Tuple;
  scaleLocal: Tuple;
  facing: string;
  screenPosition: "画面左侧" | "画面中间" | "画面右侧" | "画外";
  inFrame: boolean;
  distanceToCamera: number;
  action: string;
  actionId: string | null;
  holding: boolean;
}

export interface PromptCameraSnapshot {
  position: Tuple;
  target: Tuple;
  fov: number;
  targetObjectId: string | null;
  targetBodyPart: string;
  followMode: string;
  stabilizationEnabled: boolean;
}

export interface ShotTimelineSegment {
  startSeconds: number;
  endSeconds: number;
  cameraStart: PromptCameraSnapshot;
  cameraEnd: PromptCameraSnapshot;
  cameraMotion: string;
  cameraHolding: boolean;
  subjects: Array<{
    id: string;
    name: string;
    start: PromptObjectSnapshot;
    end: PromptObjectSnapshot;
    action: string;
    visibility: "in-frame" | "entering" | "leaving" | "passing";
  }>;
  description: string;
}

export interface ShotPromptEntry {
  schemaVersion: 2;
  shotId: string;
  shotName: string;
  promptText: string;
  negativePrompt: string;
  warnings: string[];
  structuredParams: {
    target: ShotPromptTarget;
    mode: ShotPromptMode;
    durationSeconds: number;
    aspectRatio: ViewportAspectRatio;
    resolvedAspectRatio: number;
    cinematography: {
      shotType: string;
      cameraAngle: string;
      focalLength: string;
      focalLengthMmEstimate: number;
      fov: number;
      fovAxis: "vertical";
      appliedFovOverride: number | null;
      focalLengthBasis: "24mm vertical sensor estimate, not physical lens calibration";
    };
    subjects: Array<{ id: string; name: string; kind: DirectorObject["kind"]; bodyType?: string; action: string; actionLabel: string }>;
    environment: {
      lighting: string;
      atmosphere: string;
      backgroundColor: string;
      previewBrightness: number;
      sceneTransform: DirectorTransform;
    };
    creativeBrief: string;
    visualStyle: string;
    soundBrief: string;
    references: Array<{ token: string; role: "reference_video"; status: "required-not-attached"; use: string }>;
    timeline: ShotTimelineSegment[];
    /** Dense samples retain curved routes even when interval endpoints coincide. */
    samples: Array<{ timeSeconds: number; camera: PromptCameraSnapshot; objects: PromptObjectSnapshot[] }>;
    sourceTracks: {
      camera: ReturnType<typeof getCameraMotionPath>;
      objects: Array<{ id: string; name: string; motionPath: DirectorObject["motionPath"]; characterRig: DirectorObject["characterRig"] }>;
    };
    continuity: string[];
    negativeConstraints: string[];
    quality: { visibilityMethod: "sampled-approximate-sphere-frustum"; occlusionTested: false; skeletalTargetsSampled: false };
  };
}

function round(value: number, digits = 4) { return Number(value.toFixed(digits)); }
function tuple(vector: Vector3): Tuple { return vector.toArray().map((n) => round(n)) as Tuple; }
function clean(value: string | undefined) { return value?.trim() ?? ""; }
function sentence(value: string) { return /[。！？.!?]$/.test(value) ? value : `${value}。`; }
function formatTime(value: number) { return String(round(value, 4)); }
function distance(a: Tuple, b: Tuple) { return Math.hypot(...a.map((value, axis) => value - b[axis])); }

function sceneMatrix(project: DirectorProject) {
  return new Matrix4().compose(
    new Vector3(...project.scene.position),
    new Quaternion().setFromEuler(new Euler(...project.scene.rotation)),
    new Vector3().setScalar(project.scene.scale),
  );
}

function actionLabel(object: DirectorObject, progress: number, duration: number) {
  if (object.kind !== "character") return { label: "保持原有状态", id: null, holding: false };
  const sample = getObjectMotionActionSample(object, progress, duration);
  const preset = getCharacterActionPreset(sample.actionPresetId);
  const label = preset?.label ?? (sample.actionPresetId ? `动作 ${sample.actionPresetId}` : "保持当前姿势");
  return { label, id: sample.actionPresetId, holding: sample.holdingPointIndex != null };
}

function trackedWaypoint(camera: DirectorCameraShot, progress: number) {
  const path = getCameraMotionPath(camera);
  if (!path.keyframes.length) return {
    targetObjectId: camera.targetMode === "object" ? camera.targetObjectId ?? null : null,
    targetBodyPart: "center", followMode: "immediate", stabilizationEnabled: false,
  };
  const timing = getCameraMotionTimingSample(camera, progress);
  let index = timing?.holdingPointIndex ?? timing?.segment ?? 0;
  if (!timing) while (index < path.keyframes.length - 1 && progress >= path.keyframes[index + 1].time) index += 1;
  else if (timing.holdingPointIndex == null && timing.local >= 1) index = Math.min(index + 1, path.keyframes.length - 1);
  const point = path.keyframes[index];
  return {
    targetObjectId: point.targetMode === "object" ? point.targetObjectId ?? null : null,
    targetBodyPart: point.targetBodyPart ?? "center",
    followMode: point.targetFollowMode ?? "immediate",
    stabilizationEnabled: Boolean(point.targetStabilizationEnabled),
  };
}

function inferShotType(distanceToTarget: number, fov: number) {
  const apparentDistance = distanceToTarget * Math.tan(fov * Math.PI / 360) / Math.tan(50 * Math.PI / 360);
  if (apparentDistance < 1.5) return "特写";
  if (apparentDistance < 3) return "近景";
  if (apparentDistance < 5) return "中近景";
  if (apparentDistance < 8) return "中景";
  if (apparentDistance < 20) return "全景";
  return "远景";
}

function inferAngle(camera: PromptCameraSnapshot) {
  const delta = new Vector3(...camera.position).sub(new Vector3(...camera.target));
  const pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) * 180 / Math.PI;
  if (pitch > 65) return "垂直俯拍";
  if (pitch > 20) return "高机位俯拍";
  if (pitch < -65) return "垂直仰拍";
  if (pitch < -20) return "低机位仰拍";
  return "平视或轻微俯仰";
}

function getFrameCamera(camera: PromptCameraSnapshot, aspect: number) {
  // Match the clean MP4 renderer: render at the selected ratio, not at a cropped viewport FOV.
  const lens = new PerspectiveCamera(camera.fov, aspect, 0.01, 100000);
  lens.position.set(...camera.position);
  lens.lookAt(...camera.target);
  lens.updateProjectionMatrix();
  lens.updateMatrixWorld();
  return lens;
}

function sampleScene(camera: DirectorCameraShot, project: DirectorProject, progress: number, aspect: number, finishedShotFov: number | null) {
  const duration = getCameraMotionPath(camera).duration;
  const matrix = sceneMatrix(project);
  const animatedObjects = project.objects.map((object) => ({
    ...object,
    transform: constrainObjectMotionTransform(object, getObjectMotionSnapshot(object, progress, duration), project.scene, project.objects),
    // Already sampled: prevent the focus resolver from applying the route a second time.
    motionPath: undefined,
  }));
  const view = getCameraPlaybackSnapshot(camera, project.objects, progress, project.scene,
    (object) => tuple(new Vector3(...getDirectorObjectFocusTarget({
      ...object,
      transform: constrainObjectMotionTransform(object, object.transform, project.scene, project.objects),
    })).applyMatrix4(matrix)));
  const snapshot: PromptCameraSnapshot = {
    position: [...view.position], target: [...view.target], fov: round(finishedShotFov ?? view.fov), ...trackedWaypoint(camera, progress),
  };
  const lens = getFrameCamera(snapshot, aspect);
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(lens.projectionMatrix, lens.matrixWorldInverse));
  const objects = animatedObjects.filter((object) => object.visible && object.kind !== "camera" && object.kind !== "panorama")
    .map((object): PromptObjectSnapshot => {
      const worldPosition = new Vector3(...object.transform.position).applyMatrix4(matrix);
      const center = new Vector3(...getDirectorObjectFocusTarget(object)).applyMatrix4(matrix);
      const radius = Math.max(0.05, Math.abs(project.scene.scale) * Math.max(...object.transform.scale.map(Math.abs))
        * (object.kind === "character" ? 1 : 0.8));
      const inFrame = frustum.intersectsSphere(new Sphere(center, radius));
      const projected = center.clone().project(lens);
      const heading = new Vector3(0, 0, 1).applyEuler(new Euler(...object.transform.rotation)).transformDirection(matrix);
      const cameraForward = new Vector3(...snapshot.target).sub(lens.position).normalize();
      const cameraRight = new Vector3().crossVectors(cameraForward, new Vector3(0, 1, 0)).normalize();
      const facingCamera = heading.dot(cameraForward);
      const facing = Math.abs(facingCamera) > 0.65 ? facingCamera < 0 ? "朝向镜头" : "背向镜头"
        : heading.dot(cameraRight) < 0 ? "朝向画面左侧" : "朝向画面右侧";
      const original = project.objects.find((candidate) => candidate.id === object.id)!;
      const action = actionLabel(original, progress, duration);
      return {
        id: object.id, name: object.name, kind: object.kind, position: tuple(worldPosition),
        rotationLocalRadians: object.transform.rotation.map((n) => round(n)) as Tuple,
        scaleLocal: object.transform.scale.map((n) => round(n)) as Tuple,
        facing,
        screenPosition: !inFrame ? "画外" : projected.x < -0.25 ? "画面左侧" : projected.x > 0.25 ? "画面右侧" : "画面中间",
        inFrame, distanceToCamera: round(center.distanceTo(lens.position)),
        action: action.label, actionId: action.id, holding: action.holding,
      };
    });
  return { camera: snapshot, objects };
}

function getBoundaries(camera: DirectorCameraShot, objects: DirectorObject[], duration: number) {
  const times = new Set([0, duration]);
  const add = (progress: number) => times.add(round(Math.min(duration, Math.max(0, progress * duration))));
  const cameraPlan = getCameraMotionTimingPlan(camera);
  if (cameraPlan) [...cameraPlan.arrivals, ...cameraPlan.departures].forEach(add);
  else getCameraMotionPath(camera).keyframes.forEach((point) => add(point.time));
  for (const object of objects.filter((item) => item.visible && item.kind !== "camera" && item.kind !== "panorama")) {
    const plan = getObjectMotionTimingPlan(object, duration);
    if (plan) [...plan.arrivals, ...plan.departures].forEach(add);
    else object.motionPath?.keyframes.forEach((point) => add(point.time));
  }
  return [...times].sort((a, b) => a - b);
}

function describeCamera(start: PromptCameraSnapshot, end: PromptCameraSnapshot, samples: PromptCameraSnapshot[], project: DirectorProject) {
  const movement = samples.slice(1).reduce((sum, point, i) => sum + distance(samples[i].position, point.position), 0);
  const targetMovement = samples.slice(1).reduce((sum, point, i) => sum + distance(samples[i].target, point.target), 0);
  const delta = new Vector3(...end.position).sub(new Vector3(...start.position));
  const forward = new Vector3(...start.target).sub(new Vector3(...start.position)).normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  const motions: string[] = [];
  if (movement < 0.03) motions.push(targetMovement < 0.03 ? "固定机位" : "机位位置固定，转动镜头调整注视方向");
  else if (movement > 0.3 && distance(start.position, end.position) < movement * 0.45) motions.push("沿曲线路线连续移动，保留中途经过位置");
  else {
    const sideways = delta.dot(right);
    const along = delta.dot(forward);
    if (Math.abs(sideways) > 0.15) motions.push(sideways > 0 ? "镜头向右横移" : "镜头向左横移");
    if (Math.abs(along) > 0.15) motions.push(along > 0 ? "镜头向前推进" : "镜头向后拉开");
    if (Math.abs(delta.y) > 0.15) motions.push(delta.y > 0 ? "机位升高" : "机位降低");
    if (!motions.length) motions.push("镜头沿既定路线连续移动");
  }
  if (Math.abs(end.fov - start.fov) > 0.5) motions.push(end.fov < start.fov ? "视野逐渐收窄" : "视野逐渐扩大");
  const trackedIds = [...new Set(samples.map((point) => point.targetObjectId).filter((id): id is string => Boolean(id)))];
  for (const id of trackedIds) {
    const name = project.objects.find((object) => object.id === id)?.name;
    if (!name) continue;
    const targetSample = samples.find((point) => point.targetObjectId === id)!;
    const bodyPart = DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.find((part) => part.value === targetSample.targetBodyPart)?.label ?? "整体中心";
    motions.push(`跟踪「${name}」的${bodyPart}`);
  }
  return motions.join("，");
}

function describeSubject(start: PromptObjectSnapshot, end: PromptObjectSnapshot, middle: PromptObjectSnapshot, visibility: ShotTimelineSegment["subjects"][number]["visibility"]) {
  const location = visibility === "entering" ? `从画外进入${end.screenPosition}`
    : visibility === "leaving" ? `从${start.screenPosition}离开画面`
    : visibility === "passing" ? "在本时间段经过画面"
    : start.screenPosition !== end.screenPosition ? `从${start.screenPosition}移动到${end.screenPosition}` : `位于${start.screenPosition}`;
  const moved = distance(start.position, end.position) > 0.05;
  let behavior = middle.action;
  if (middle.kind !== "character") behavior = moved ? "沿预演路线移动" : "保持陈设位置";
  else if (middle.holding) behavior += "，在路线停留点保持位置";
  else if (moved) behavior += "，沿预演路线连续移动";
  return `「${start.name}」${location}，${behavior}${middle.kind === "character" ? `，${middle.facing}` : ""}`;
}

function createPromptText(entry: Omit<ShotPromptEntry, "promptText">) {
  const p = entry.structuredParams;
  const sections: string[] = [];
  if (p.mode === "reference-video") sections.push(`【素材绑定】\n${p.target === "seedance" ? "@视频1" : "本镜头参考视频"} 为待上传的三维预演视频：仅参考机位、构图、运镜、人物与道具的运动轨迹及节奏；不参考人偶默认外观、颜色、材质、网格或辅助线。`);
  sections.push(`【概述】\n${p.creativeBrief || `生成「${entry.shotName}」的连续单镜头视频。按以下空间调度和动作顺序完成镜头。`}`);
  const ratio = p.aspectRatio === "auto" ? `沿用预演画幅（约 ${p.resolvedAspectRatio}:1）` : `${p.aspectRatio}画幅`;
  sections.push(`【全局设定】\n${formatTime(p.durationSeconds)}秒，${ratio}。${p.visualStyle ? sentence(p.visualStyle) : ""}镜头连续，不额外插入切镜，场景布局连续。`);
  sections.push(`【时间轴】\n${p.timeline.map((segment) => `${formatTime(segment.startSeconds)}-${formatTime(segment.endSeconds)}s：${segment.description}。`).join("\n")}`);
  if (p.soundBrief) sections.push(`【声音】\n${p.soundBrief}`);
  sections.push(`【连续性与排除】\n${p.continuity.join("；")}。\n${entry.negativePrompt}`);
  return sections.join("\n\n");
}

export function generateShotPrompt(camera: DirectorCameraShot, project: DirectorProject, options: ShotPromptOptions = {}): ShotPromptEntry {
  const path = getCameraMotionPath(camera);
  const duration = path.duration;
  const aspectRatio = options.aspectRatio ?? "16:9";
  const renderAspect = Number.isFinite(options.renderAspectRatio) && options.renderAspectRatio! > 0 ? options.renderAspectRatio! : 16 / 9;
  const aspect = getViewportAspectRatioValue(aspectRatio) ?? renderAspect;
  const target = options.target ?? "generic";
  const mode = options.mode ?? "text-video";
  const finishedShotFov = typeof options.finishedShotFov === "number" && Number.isFinite(options.finishedShotFov)
    ? Math.max(10, Math.min(120, options.finishedShotFov)) : null;
  const boundaries = getBoundaries(camera, project.objects, duration);
  // Sample interval interiors and regular times to catch entries, exits and curved loops.
  const sampleTimes = new Set(boundaries);
  for (let seconds = 0; seconds < duration; seconds += 0.25) sampleTimes.add(round(seconds));
  boundaries.slice(1).forEach((end, i) => [0.25, 0.5, 0.75].forEach((t) => sampleTimes.add(round(boundaries[i] + (end - boundaries[i]) * t))));
  const samples = [...sampleTimes].sort((a, b) => a - b).map((timeSeconds) => ({
    timeSeconds, ...sampleScene(camera, project, timeSeconds / duration, aspect, finishedShotFov),
  }));
  const sampleAt = (time: number) => samples.find((sample) => sample.timeSeconds === round(time))!;
  const timeline: ShotTimelineSegment[] = boundaries.slice(1).map((end, i) => {
    const start = boundaries[i];
    const first = sampleAt(start);
    const last = sampleAt(end);
    const middle = sampleAt(start + (end - start) / 2);
    const inside = samples.filter((sample) => sample.timeSeconds >= start && sample.timeSeconds <= end);
    const inFrameIds = new Set(inside.flatMap((sample) => sample.objects.filter((object) => object.inFrame).map((object) => object.id)));
    const subjects = first.objects.filter((object) => inFrameIds.has(object.id)).map((object) => {
      const final = last.objects.find((item) => item.id === object.id)!;
      const mid = middle.objects.find((item) => item.id === object.id)!;
      const visibility = !object.inFrame && !final.inFrame ? "passing" : !object.inFrame ? "entering" : !final.inFrame ? "leaving" : "in-frame";
      return { id: object.id, name: object.name, start: object, end: final, action: mid.action, visibility } as ShotTimelineSegment["subjects"][number];
    });
    const cameraMotion = describeCamera(first.camera, last.camera, inside.map((sample) => sample.camera), project);
    const cameraHolding = getCameraMotionTimingSample(camera, middle.timeSeconds / duration)?.holdingPointIndex != null;
    const staging = subjects.map((subject) => describeSubject(subject.start, subject.end, middle.objects.find((object) => object.id === subject.id)!, subject.visibility)).join("；")
      || "保持当前环境构图，不添加新主体";
    return {
      startSeconds: start, endSeconds: end, cameraStart: first.camera, cameraEnd: last.camera,
      cameraMotion, cameraHolding, subjects,
      description: `${cameraMotion}${cameraHolding ? "，机位停留" : ""}；${staging}`,
    };
  });
  const inFrameIds = new Set(samples.flatMap((sample) => sample.objects.filter((object) => object.inFrame).map((object) => object.id)));
  const subjects = project.objects.filter((object) => inFrameIds.has(object.id)).map((object) => {
    const label = actionLabel(object, 0, duration).label;
    return { id: object.id, name: object.name, kind: object.kind, bodyType: object.bodyType, action: label, actionLabel: label };
  });
  const focalMm = round(12 / Math.tan(samples[0].camera.fov * Math.PI / 360), 1);
  const warnings = ["入画判断采用主体近似包围球，未计算遮挡；请以导出的参考视频核对构图。"];
  if (mode === "reference-video") warnings.push(`${target === "seedance" ? "@视频1" : "参考视频"} 尚未上传：先导出当前机位的参考 MP4，再在视频生成平台上传，并将其作为运镜与动作参考。`);
  if (path.keyframes.length === 1) warnings.push("当前只有一个运镜点，播放规则按固定机位处理；增加第二个点后才能导出运镜参考视频。");
  if (mode === "reference-video" && !path.keyframes.length) warnings.push("当前没有运镜点，参考 MP4 导出要求至少两个点；固定镜头可记录两个相同机位的点。");
  if (!clean(options.visualStyle)) warnings.push("尚未填写成片视觉设定，可补充场景、人物外观与风格；预演人偶不会自动转换为你想要的角色。");
  if (path.keyframes.some((point) => point.targetMode === "object" && point.targetBodyPart && point.targetBodyPart !== "center")) warnings.push("身体部位跟踪已保留在数据中，文字采样以主体中心近似；精确骨骼运动请使用参考视频。");
  if (path.keyframes.some((point) => point.targetFollowMode === "smooth" || point.targetStabilizationEnabled)) warnings.push("跟随与防抖设置已保留，导出采样不复刻逐帧阻尼；参考视频包含实际跟随效果。");
  if (finishedShotFov != null && path.keyframes.some((point) => Math.abs(point.fov - finishedShotFov) > 0.5)) warnings.push("当前看成片 FOV 覆盖了轨迹点的视野变化；提示词按实际参考视频使用固定 FOV。");
  const trackedIds = [camera.targetMode === "object" ? camera.targetObjectId : null, ...path.keyframes.map((point) => point.targetMode === "object" ? point.targetObjectId : null)].filter(Boolean);
  if (trackedIds.some((id) => !project.objects.some((object) => object.id === id && object.visible))) warnings.push("存在缺失或隐藏的跟踪主体，请先检查镜头跟踪设置。");
  if (subjects.filter((object) => object.kind === "character").length > 5) warnings.push("镜头包含较多人物，可考虑分段生成，并逐人提供外观参考。");
  if (timeline.length > 12) warnings.push("镜头调度较密集，可减少路线点或使用参考视频，避免文字提示过长。");
  const counts = new Map<string, number>();
  subjects.forEach((object) => counts.set(object.name, (counts.get(object.name) ?? 0) + 1));
  if ([...counts.values()].some((count) => count > 1)) warnings.push("入画主体存在重名，建议重命名后导出，避免模型混淆角色。");
  const negativeConstraints = ["不要新增、复制或融合主体", "避免人物身份、服装与道具漂移", "不要闪烁、跳帧或无指令跳切", "不要字幕、水印、坐标线、轨迹线或相机锥体"];
  if (clean(options.additionalConstraints)) negativeConstraints.push(clean(options.additionalConstraints));
  const materials: Record<string, string> = { studio: "摄影棚地面", concrete: "混凝土地面", asphalt: "柏油地面", wood: "木地板", grass: "草地" };
  const continuity = ["保持人物身份、外观与服装一致", "人物和道具按预演路线连续运动，停留点不瞬移", "前后段承接上一段的站位、朝向和构图", "保持场景布局与光线连续"];
  const entry: Omit<ShotPromptEntry, "promptText"> = {
    schemaVersion: SHOT_PROMPT_SCHEMA_VERSION, shotId: camera.id, shotName: camera.name,
    negativePrompt: negativeConstraints.join("；") + "。", warnings,
    structuredParams: {
      target, mode, durationSeconds: duration, aspectRatio, resolvedAspectRatio: round(aspect),
      cinematography: {
        shotType: inferShotType(distance(samples[0].camera.position, samples[0].camera.target), samples[0].camera.fov),
        cameraAngle: inferAngle(samples[0].camera), focalLength: `约 ${focalMm}mm（估算）`, focalLengthMmEstimate: focalMm,
        fov: samples[0].camera.fov, fovAxis: "vertical", appliedFovOverride: finishedShotFov,
        focalLengthBasis: "24mm vertical sensor estimate, not physical lens calibration",
      },
      subjects, environment: {
        lighting: "最终光线由成片视觉设定或参考素材决定",
        atmosphere: project.scene.showGround ? `预演地面为${materials[project.scene.groundMaterialPreset] ?? project.scene.groundMaterialPreset}` : "预演中未显示地面",
        backgroundColor: project.scene.backgroundColor, previewBrightness: project.scene.backgroundBrightness,
        sceneTransform: { position: [...project.scene.position], rotation: [...project.scene.rotation], scale: [project.scene.scale, project.scene.scale, project.scene.scale] },
      },
      creativeBrief: clean(options.creativeBrief), visualStyle: clean(options.visualStyle), soundBrief: clean(options.soundBrief),
      references: mode === "reference-video" ? [{ token: target === "seedance" ? "@视频1" : "本镜头参考视频", role: "reference_video", status: "required-not-attached", use: "运镜、构图、人物与道具轨迹、节奏；不参考默认人偶外观" }] : [],
      timeline, samples,
      sourceTracks: {
        camera: structuredClone(path),
        objects: project.objects.filter((object) => object.visible && object.kind !== "camera" && object.kind !== "panorama")
          .map((object) => ({ id: object.id, name: object.name, motionPath: object.motionPath ? structuredClone(object.motionPath) : undefined, characterRig: object.characterRig ? structuredClone(object.characterRig) : undefined })),
      },
      continuity, negativeConstraints,
      quality: { visibilityMethod: "sampled-approximate-sphere-frustum", occlusionTested: false, skeletalTargetsSampled: false },
    },
  };
  return { ...entry, promptText: createPromptText(entry) };
}

export function exportAllShotPrompts(project: DirectorProject, options: ShotPromptOptions = {}): ShotPromptEntry[] {
  return project.cameras.map((camera) => generateShotPrompt(camera, project, options));
}

export function formatShotPromptText(entries: ShotPromptEntry[]) {
  return entries.map((entry) => `镜头 ${entry.shotName}\n\n${entry.promptText}`).join("\n\n--------------------\n\n");
}
