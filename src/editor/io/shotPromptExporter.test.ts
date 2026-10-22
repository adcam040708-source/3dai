import { describe, expect, it } from "vitest";
import type { DirectorCameraMotionKeyframe, DirectorObject, DirectorProject } from "../schema/directorProject";
import { createDefaultDirectorProject } from "../store/directorStore";
import { getCameraMotionTimingPlan } from "../schema/cameraMotion";
import { getObjectMotionTimingPlan } from "../schema/objectMotion";
import { exportAllShotPrompts, formatShotPromptText, generateShotPrompt } from "./shotPromptExporter";

function fixture(): DirectorProject {
  const project = createDefaultDirectorProject();
  project.objects = project.objects.filter((object) => object.kind === "character");
  project.objects[0].name = "女主";
  project.objects[0].transform.position = [0, 0, 0];
  project.cameras[0].targetMode = "manual";
  project.cameras[0].target = [0, 1, 0];
  project.cameras[0].transform.position = [0, 1, 10];
  project.cameras[0].motionPath = {
    duration: 8, interpolation: "linear", easing: "linear", loop: false,
    speedMode: "uniform", keyframes: [],
  };
  return project;
}

function cameraPoint(id: string, time: number, x: number, extras: Partial<DirectorCameraMotionKeyframe> = {}): DirectorCameraMotionKeyframe {
  return { id, time, position: [x, 1, 10], target: [x, 1, 0], fov: 50, ...extras };
}

function character(project: DirectorProject, id: string, name: string, x: number, z = 0): DirectorObject {
  return { ...structuredClone(project.objects[0]), id, name, transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] } };
}

describe("video shot prompt export", () => {
  it("exports fixed camera video, without inventing daylight or uploaded references", () => {
    const project = fixture();
    const entry = generateShotPrompt(project.cameras[0], project);
    expect(entry.schemaVersion).toBe(2);
    expect(entry.structuredParams.timeline).toHaveLength(1);
    expect(entry.structuredParams.timeline[0]).toMatchObject({ startSeconds: 0, endSeconds: 8, cameraMotion: "固定机位" });
    expect(entry.promptText).toContain("0-8s");
    expect(entry.promptText).not.toMatch(/daylight|日光|@视频1/);
    expect(entry.structuredParams.references).toEqual([]);
    expect(entry.negativePrompt).toContain("轨迹线");
  });

  it("excludes hidden, behind-camera and far outside characters but preserves props", () => {
    const project = fixture();
    project.objects.push(character(project, "behind", "背后角色", 0, 20));
    project.objects.push(character(project, "outside", "远处角色", 100));
    project.objects.push({ ...character(project, "hidden", "隐藏角色", 0), visible: false });
    project.objects.push({ ...character(project, "table", "餐桌", 1), kind: "prop", geometryType: "box" });
    const entry = generateShotPrompt(project.cameras[0], project);
    expect(entry.structuredParams.subjects.map((object) => object.name)).toEqual(["女主", "餐桌"]);
    expect(entry.promptText).not.toMatch(/背后角色|远处角色|隐藏角色/);
    expect(entry.promptText).toContain("餐桌");
    expect(entry.structuredParams.quality.occlusionTested).toBe(false);
  });

  it("keeps a crossing actor whose endpoints are both outside the frame", () => {
    const project = fixture();
    const actor = project.objects[0];
    actor.motionPath = {
      interpolation: "linear", speedMode: "uniform",
      keyframes: [
        { id: "a", time: 0, transform: { ...actor.transform, position: [-20, 0, 0] }, actionPresetId: "run-cycle" },
        { id: "b", time: 1, transform: { ...actor.transform, position: [20, 0, 0] } },
      ],
    };
    const entry = generateShotPrompt(project.cameras[0], project);
    expect(entry.structuredParams.timeline[0].subjects[0].visibility).toBe("passing");
    expect(entry.structuredParams.subjects[0].name).toBe("女主");
    expect(entry.promptText).toContain("跑步");
  });

  it("uses actual camera arrival and departure times including a hold", () => {
    const project = fixture();
    project.cameras[0].motionPath!.keyframes = [
      cameraPoint("a", 0, 0), cameraPoint("b", 0.5, 1, { pointBehavior: "hold", holdSeconds: 2 }), cameraPoint("c", 1, 4),
    ];
    const plan = getCameraMotionTimingPlan(project.cameras[0])!;
    const entry = generateShotPrompt(project.cameras[0], project);
    const hold = entry.structuredParams.timeline.find((segment) => segment.cameraHolding)!;
    expect(hold.startSeconds).toBeCloseTo(plan.arrivals[1] * 8, 3);
    expect(hold.endSeconds).toBeCloseTo(plan.departures[1] * 8, 3);
    expect(hold.endSeconds - hold.startSeconds).toBeCloseTo(2, 3);
    expect(hold.cameraStart.position).toEqual(hold.cameraEnd.position);
    expect(hold.description).toContain("机位停留");
  });

  it("uses the custom hold action rather than the actor's global preset", () => {
    const project = fixture();
    const actor = project.objects[0];
    actor.characterRig!.actionPresetId = "run-cycle";
    actor.motionPath = {
      interpolation: "linear", speedMode: "uniform",
      keyframes: [
        { id: "a", time: 0, transform: { ...actor.transform, position: [-2, 0, 0] }, actionPresetId: "walk-cycle" },
        { id: "b", time: 0.5, transform: { ...actor.transform, position: [0, 0, 0] }, pointBehavior: "hold", holdSeconds: 2, holdAction: "custom", holdActionPresetId: "wave-cycle", actionPresetId: "run-cycle" },
        { id: "c", time: 1, transform: { ...actor.transform, position: [2, 0, 0] } },
      ],
    };
    const plan = getObjectMotionTimingPlan(actor, 8)!;
    const entry = generateShotPrompt(project.cameras[0], project);
    const hold = entry.structuredParams.timeline.find((segment) => Math.abs(segment.startSeconds - plan.arrivals[1] * 8) < 0.001)!;
    expect(hold.subjects[0].action).toBe("挥手打招呼");
    expect(hold.description).toContain("路线停留点");
    expect(entry.promptText).toContain("正常行走");
    expect(entry.promptText).toContain("跑步");
  });

  it("has no time gaps or overlaps even with fractional duration and dense route events", () => {
    const project = fixture();
    project.cameras[0].motionPath!.duration = 6.7;
    project.cameras[0].motionPath!.keyframes = [cameraPoint("a", 0, 0), cameraPoint("b", 0.37, 3), cameraPoint("c", 1, -2)];
    const timeline = generateShotPrompt(project.cameras[0], project).structuredParams.timeline;
    expect(timeline[0].startSeconds).toBe(0);
    expect(timeline[timeline.length - 1].endSeconds).toBe(6.7);
    timeline.forEach((segment, i) => {
      expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
      if (i > 0) expect(segment.startSeconds).toBe(timeline[i - 1].endSeconds);
    });
  });

  it("narrows visibility when cropping a wide viewport to portrait", () => {
    const project = fixture();
    project.objects.push(character(project, "edge", "侧边角色", 5));
    const landscape = generateShotPrompt(project.cameras[0], project, { aspectRatio: "16:9" });
    const portrait = generateShotPrompt(project.cameras[0], project, { aspectRatio: "9:16" });
    expect(landscape.structuredParams.subjects.some((object) => object.id === "edge")).toBe(true);
    expect(portrait.structuredParams.subjects.some((object) => object.id === "edge")).toBe(false);
    expect(portrait.promptText).toContain("9:16画幅");
  });

  it("records world positions with the scene transform and retains local rotations", () => {
    const project = fixture();
    project.scene.position = [2, 0, 0];
    project.scene.scale = 2;
    project.objects[0].transform.position = [1, 0, 0];
    const sample = generateShotPrompt(project.cameras[0], project).structuredParams.samples[0].objects[0];
    expect(sample.position).toEqual([4, 0, 0]);
    expect(sample.rotationLocalRadians).toEqual([0, 0, 0]);
  });

  it("preserves body tracking, stabilization and FOV but marks skeletal approximation", () => {
    const project = fixture();
    project.cameras[0].motionPath!.keyframes = [
      cameraPoint("a", 0, 0, { targetMode: "object", targetObjectId: project.objects[0].id, targetBodyPart: "rightHand", targetFollowMode: "smooth", targetStabilizationEnabled: true }),
      cameraPoint("b", 1, 1, { fov: 35 }),
    ];
    const entry = generateShotPrompt(project.cameras[0], project);
    expect(entry.structuredParams.samples[0].camera).toMatchObject({ targetBodyPart: "rightHand", stabilizationEnabled: true });
    const samples = entry.structuredParams.samples;
    expect(samples[samples.length - 1].camera.fov).toBe(35);
    expect(entry.structuredParams.sourceTracks.camera.keyframes[0].targetFollowMode).toBe("smooth");
    expect(entry.warnings.join(" ")).toContain("精确骨骼运动");
  });

  it("keeps reference role explicit and does not claim a video is already attached", () => {
    const project = fixture();
    const entry = generateShotPrompt(project.cameras[0], project, { target: "seedance", mode: "reference-video", creativeBrief: "女主走进公寓", visualStyle: "写实电影风格", soundBrief: "只保留脚步声" });
    expect(entry.promptText).toContain("@视频1 为待上传");
    expect(entry.promptText).toContain("女主走进公寓");
    expect(entry.promptText).toContain("【声音】\n只保留脚步声");
    expect(entry.structuredParams.references[0].status).toBe("required-not-attached");
    const generic = generateShotPrompt(project.cameras[0], project, { target: "generic", mode: "reference-video" });
    expect(generic.promptText).toContain("本镜头参考视频");
    expect(generic.promptText).not.toContain("@视频1");
  });

  it("does not mutate a saved project and exports each camera separately", () => {
    const project = fixture();
    project.cameras.push({ ...structuredClone(project.cameras[0]), id: "cam_2", name: "机位02" });
    const saved = JSON.stringify(project);
    const entries = exportAllShotPrompts(project, { additionalConstraints: "不要背景音乐" });
    expect(JSON.stringify(project)).toBe(saved);
    expect(entries.map((entry) => entry.shotId)).toEqual(["cam_1", "cam_2"]);
    expect(formatShotPromptText(entries)).toContain("镜头 机位02");
    expect(entries[0].negativePrompt).toContain("不要背景音乐");
    expect(exportAllShotPrompts({ ...project, cameras: [] })).toEqual([]);
  });

  it("uses the finished-shot FOV override, including visibility, while retaining original tracks", () => {
    const project = fixture();
    project.objects.push(character(project, "edge", "侧边角色", 5));
    project.cameras[0].motionPath!.keyframes = [cameraPoint("a", 0, 0), cameraPoint("b", 1, 0, { fov: 70 })];
    const entry = generateShotPrompt(project.cameras[0], project, { finishedShotFov: 20 });
    expect(entry.structuredParams.samples.every((sample) => sample.camera.fov === 20)).toBe(true);
    expect(entry.structuredParams.subjects.some((object) => object.id === "edge")).toBe(false);
    expect(entry.structuredParams.sourceTracks.camera.keyframes[1].fov).toBe(70);
    expect(entry.structuredParams.cinematography.appliedFovOverride).toBe(20);
    expect(entry.warnings.join(" ")).toContain("FOV 覆盖");
  });

  it("keeps camera collision based on static obstacles, not moving props", () => {
    const project = fixture();
    project.scene.pathCollisionEnabled = true;
    project.cameras[0].motionPath!.keyframes = [cameraPoint("a", 0, 0), cameraPoint("b", 1, 0)];
    const movingProp = { ...character(project, "moving", "移动道具", 0, 10), kind: "prop" as const };
    movingProp.motionPath = { interpolation: "linear", keyframes: [
      { id: "a", time: 0, transform: movingProp.transform },
      { id: "b", time: 1, transform: { ...movingProp.transform, position: [1, 0, 10] } },
    ] };
    project.objects.push(movingProp);
    const camera = generateShotPrompt(project.cameras[0], project).structuredParams.samples[0].camera;
    expect(camera.position).toEqual([0, 1, 10]);
  });
});
