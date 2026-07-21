import type { DirectorProject, DirectorCameraShot, DirectorObject } from "../schema/directorProject";
import { getCharacterActionPreset } from "../presets/characterActionPresets";

export interface ShotPromptEntry {
  shotId: string;
  shotName: string;
  /** Natural language prompt optimized for image generation models (Midjourney/SD) */
  promptText: string;
  /** Structured parameters for programmatic use or API calls */
  structuredParams: {
    cinematography: {
      shotType: string;
      cameraAngle: string;
      focalLength: string;
      fov: number;
    };
    subjects: Array<{
      name: string;
      bodyType?: string;
      action?: string;
      actionLabel?: string;
    }>;
    environment: {
      lighting: string;
      atmosphere: string;
    };
  };
}

/**
 * Infer cinematic shot type from camera-to-target distance and FOV.
 * Returns standard film terminology (close-up, medium, wide, etc.)
 */
function inferShotType(distanceToTarget: number, fov: number): string {
  // Adjust distance threshold by FOV - wider FOV makes closer distances feel wider
  const fovFactor = fov / 50; // normalize around default FOV 50
  const adjustedDistance = distanceToTarget * fovFactor;

  if (adjustedDistance < 1.5) {
    return "extreme close-up shot";
  } else if (adjustedDistance < 3) {
    return "close-up shot";
  } else if (adjustedDistance < 5) {
    return "medium close-up shot";
  } else if (adjustedDistance < 8) {
    return "medium shot";
  } else if (adjustedDistance < 12) {
    return "medium full shot";
  } else if (adjustedDistance < 20) {
    return "full shot";
  } else if (adjustedDistance < 35) {
    return "wide shot";
  } else {
    return "extreme wide establishing shot";
  }
}

/**
 * Infer camera angle from vertical pitch.
 * Positive Y is up in the scene.
 */
function inferCameraAngle(cameraPos: [number, number, number], targetPos: [number, number, number]): string {
  const deltaY = cameraPos[1] - targetPos[1];
  const horizontalDist = Math.sqrt(
    Math.pow(cameraPos[0] - targetPos[0], 2) + Math.pow(cameraPos[2] - targetPos[2], 2)
  );
  
  if (horizontalDist < 0.01) {
    return "top-down overhead view";
  }

  const pitchDegrees = (Math.atan2(deltaY, horizontalDist) * 180) / Math.PI;

  if (pitchDegrees > 45) {
    return "high-angle bird's eye view";
  } else if (pitchDegrees > 20) {
    return "high-angle perspective";
  } else if (pitchDegrees > 5) {
    return "slightly elevated angle";
  } else if (pitchDegrees > -5) {
    return "eye-level perspective";
  } else if (pitchDegrees > -20) {
    return "slightly low angle";
  } else if (pitchDegrees > -45) {
    return "low-angle heroic perspective";
  } else {
    return "extreme low-angle worm's eye view";
  }
}

/**
 * Map FOV to approximate focal length (35mm equivalent)
 */
function fovToFocalLength(fov: number): string {
  // Assuming 36mm sensor width (full frame)
  const focalLengthMm = (36 / 2) / Math.tan((fov * Math.PI) / 180 / 2);
  
  if (focalLengthMm < 20) return "ultra-wide fisheye lens";
  if (focalLengthMm < 35) return "wide-angle lens";
  if (focalLengthMm < 70) return "standard lens";
  if (focalLengthMm < 135) return "portrait lens";
  return "telephoto lens";
}

/**
 * Translate character body type to natural language descriptor
 */
function translateBodyType(bodyType?: string): string {
  switch (bodyType) {
    case "female": return "female figure";
    case "broad": return "broad-shouldered build";
    case "muscular": return "muscular athletic build";
    case "slim": return "slim graceful figure";
    case "teen": return "teenage proportions";
    case "child": return "child-like stature";
    case "chibi": return "stylized chibi character";
    case "mannequin":
    default:
      return "neutral human figure";
  }
}

/**
 * Translate character action preset to natural language
 */
function translateAction(actionPresetId: string | null | undefined): { verb: string; label: string } {
  const preset = getCharacterActionPreset(actionPresetId);
  if (!preset) {
    return { verb: "standing idle", label: "idle" };
  }

  // Map preset IDs to natural language
  const actionMap: Record<string, string> = {
    "walk-cycle": "walking forward",
    "run-cycle": "running dynamically",
    "crouch-cycle": "crouching down",
    "side-step-left": "side-stepping left",
    "jump-cycle": "jumping in place",
    "wave-cycle": "waving greeting",
  };

  return {
    verb: actionMap[preset.id] || preset.label,
    label: preset.label,
  };
}

/**
 * Calculate distance between two 3D points
 */
function distance3D(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt(
    Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2)
  );
}

/**
 * Determine which characters are visible in this camera's frame.
 * For now, we use a simple heuristic: characters within a certain distance/angle cone.
 */
function getVisibleCharacters(
  camera: DirectorCameraShot,
  allObjects: DirectorObject[]
): DirectorObject[] {
  const characters = allObjects.filter((obj) => obj.kind === "character" && obj.visible);
  
  // Simple heuristic: include all visible characters
  // TODO: implement proper frustum culling if needed
  return characters;
}

/**
 * Generate AI prompt for a single camera shot
 */
export function generateShotPrompt(
  camera: DirectorCameraShot,
  project: DirectorProject
): ShotPromptEntry {
  const cameraPos = camera.transform.position;
  const targetPos = camera.target;
  const fov = camera.fov;

  const distanceToTarget = distance3D(cameraPos, targetPos);
  const shotType = inferShotType(distanceToTarget, fov);
  const cameraAngle = inferCameraAngle(cameraPos, targetPos);
  const focalLength = fovToFocalLength(fov);

  const visibleCharacters = getVisibleCharacters(camera, project.objects);

  const subjects = visibleCharacters.map((char) => {
    const actionPresetId = char.characterRig?.actionPresetId;
    const action = translateAction(actionPresetId);
    
    return {
      name: char.name,
      bodyType: char.bodyType,
      action: action.verb,
      actionLabel: action.label,
    };
  });

  // Build natural language prompt
  const cinematographyDesc = `${shotType}, ${cameraAngle}, ${focalLength}`;
  
  let subjectsDesc = "";
  if (subjects.length === 0) {
    subjectsDesc = "empty scene";
  } else if (subjects.length === 1) {
    const s = subjects[0];
    subjectsDesc = `${translateBodyType(s.bodyType)} ${s.action}`;
  } else {
    subjectsDesc = subjects
      .map((s) => `${translateBodyType(s.bodyType)} ${s.action}`)
      .join(", ");
  }

  // Scene atmosphere from project settings
  const sceneSettings = project.scene;
  const lightingDesc = sceneSettings.backgroundBrightness > 0.7
    ? "bright daylight"
    : sceneSettings.backgroundBrightness > 0.4
    ? "soft ambient lighting"
    : "dim moody lighting";
  
  const atmosphereDesc = sceneSettings.showGround
    ? `grounded scene with ${sceneSettings.groundMaterialPreset} floor`
    : "minimal background";

  const promptText = `Cinematic ${cinematographyDesc}. ${subjectsDesc}. ${lightingDesc}, ${atmosphereDesc}. Professional film composition.`;

  return {
    shotId: camera.id,
    shotName: camera.name,
    promptText,
    structuredParams: {
      cinematography: {
        shotType,
        cameraAngle,
        focalLength,
        fov,
      },
      subjects: subjects.map((s) => ({
        name: s.name,
        bodyType: s.bodyType,
        action: s.action,
        actionLabel: s.actionLabel,
      })),
      environment: {
        lighting: lightingDesc,
        atmosphere: atmosphereDesc,
      },
    },
  };
}

/**
 * Export all camera shots as individual prompt entries
 */
export function exportAllShotPrompts(project: DirectorProject): ShotPromptEntry[] {
  return project.cameras.map((camera) => generateShotPrompt(camera, project));
}
