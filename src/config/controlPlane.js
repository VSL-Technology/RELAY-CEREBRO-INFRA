function toBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

const mode = String(process.env.CONTROL_PLANE_MODE || "B").trim().toUpperCase() || "B";
export const JOB_RUNNER_ENABLED = process.env.JOB_RUNNER_ENABLED !== "false";

const controlPlaneConfig = {
  mode,
  isModeB: mode === "B",
  fallbackJson: toBool(process.env.CONTROL_PLANE_FALLBACK_JSON, true),
  writeDb: toBool(process.env.CONTROL_PLANE_WRITE_DB, true),
  jobRunnerEnabled: JOB_RUNNER_ENABLED
};

export function getControlPlaneConfig() {
  return controlPlaneConfig;
}

export default controlPlaneConfig;
