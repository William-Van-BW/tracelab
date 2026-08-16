import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// apps/workbench/scripts → apps/workbench → apps → <repository root>
const repositoryRoot = resolve(webRoot, "..", "..");

export const configPath = resolve(
  process.env.AETF_WORKBENCH_CONFIG || resolve(repositoryRoot, "case-library", "aetf-workbench.json"),
);

function expandEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

/**
 * The resolved config names the operator's own directories, so it is not in
 * version control — a fresh clone has only the template. Materialise it on
 * first read instead of failing: the defaults (`.` for the Case library,
 * `%USERPROFILE%\AgentRuns` for the working root) are what a new operator
 * would type anyway, and the workbench can rewrite them from its UI.
 */
function ensureConfigFile() {
  if (existsSync(configPath)) return;
  const template = resolve(dirname(configPath), "aetf-workbench.example.json");
  if (!existsSync(template)) throw new Error(`Workbench config not found: ${configPath}`);
  copyFileSync(template, configPath);
  console.log(`已从模板创建工作台配置：${configPath}`);
}

export function loadWorkbenchConfig() {
  ensureConfigFile();
  if (!existsSync(configPath)) throw new Error(`Workbench config not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof config.caseLibraryPath !== "string" || typeof config.workingRoot !== "string") {
    throw new Error("Workbench config requires caseLibraryPath and workingRoot");
  }
  const configRoot = dirname(configPath);
  const expandedLibrary = expandEnvironment(config.caseLibraryPath);
  const expandedWorkingRoot = expandEnvironment(config.workingRoot);
  const resolvedWorkingRoot = isAbsolute(expandedWorkingRoot) ? resolve(expandedWorkingRoot) : resolve(configRoot, expandedWorkingRoot);
  // Run records live on disk, one directory per Run. Default them next to the
  // deployments so a whole evaluation session sits under one folder the operator
  // can archive or restore wholesale.
  const expandedRunsRoot = typeof config.runsRoot === "string" && config.runsRoot.trim()
    ? expandEnvironment(config.runsRoot.trim())
    : join(resolvedWorkingRoot, "runs");
  return {
    config,
    configPath,
    resolvedCaseLibraryPath: resolve(configRoot, expandedLibrary),
    resolvedWorkingRoot,
    resolvedRunsRoot: isAbsolute(expandedRunsRoot) ? resolve(expandedRunsRoot) : resolve(configRoot, expandedRunsRoot),
  };
}

export function saveWorkbenchConfig(next) {
  const previous = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const runsRoot = String(next.runsRoot ?? previous.runsRoot ?? "").trim();
  const config = {
    schemaVersion: "0.5.0",
    caseLibraryPath: String(next.caseLibraryPath ?? "").trim(),
    workingRoot: String(next.workingRoot ?? "").trim(),
    ...(runsRoot ? { runsRoot } : {}),
  };
  if (!config.caseLibraryPath || !config.workingRoot) throw new Error("Case 库和工作目录不能为空");
  const resolvedWorkingRoot = isAbsolute(expandEnvironment(config.workingRoot))
    ? resolve(expandEnvironment(config.workingRoot))
    : resolve(dirname(configPath), expandEnvironment(config.workingRoot));
  if (resolvedWorkingRoot.split(/[\\/]+/).some((part) => /test|bench/i.test(part))) {
    throw new Error("工作目录不能包含 test 或 bench");
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return loadWorkbenchConfig();
}
