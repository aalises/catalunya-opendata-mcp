import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const options = parseArgs(process.argv.slice(2));
const results = [];
const warnings = [];

const version = packageJson.version;
const tagName = `v${version}`;
const headSha = git(["rev-parse", "HEAD"]);
const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"]);

runCheck("git worktree is clean", () => {
  const status = git(["status", "--porcelain"]);
  if (status !== "" && !options.allowDirty) {
    throw new Error(`worktree has uncommitted changes:\n${status}`);
  }

  return status === "" ? "clean" : "dirty allowed for this run";
});

runCheck("branch is synced with upstream", () => {
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const [ahead, behind] = git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])
    .split(/\s+/u)
    .map(Number);

  if (ahead !== 0 || behind !== 0) {
    throw new Error(`${branchName} is ${ahead} ahead and ${behind} behind ${upstream}.`);
  }

  return `${branchName} matches ${upstream}`;
});

runCheck("package lock matches package version", () => {
  if (packageLock.name !== packageJson.name) {
    throw new Error(`package-lock name ${packageLock.name} != ${packageJson.name}.`);
  }
  if (packageLock.version !== version) {
    throw new Error(`package-lock version ${packageLock.version} != ${version}.`);
  }
  if (packageLock.packages?.[""]?.version !== version) {
    throw new Error(
      `package-lock root package version ${packageLock.packages?.[""]?.version} != ${version}.`,
    );
  }

  return `${packageJson.name}@${version}`;
});

runCheck("release notes include this version", () => {
  const releaseNotes = readFileSync(path.join(rootDir, "docs/release-notes.md"), "utf8");
  const sectionPattern = new RegExp(`^##\\s+${escapeRegex(version)}(?:\\s|$)`, "mu");

  if (!sectionPattern.test(releaseNotes)) {
    throw new Error(`docs/release-notes.md is missing a ## ${version} section.`);
  }

  return `docs/release-notes.md has ## ${version}`;
});

runCheck("built package entrypoint is executable", () => {
  const entrypoint = path.join(rootDir, "dist/index.js");
  accessSync(entrypoint, constants.X_OK);

  return "dist/index.js is executable";
});

runCheck("npm package dry run is bounded", () => {
  const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [packSummary] = JSON.parse(packOutput);
  const files = packSummary?.files ?? [];
  const paths = files.map((file) => file.path);
  const unexpected = paths.filter(
    (filePath) =>
      filePath !== "package.json" &&
      filePath !== "README.md" &&
      filePath !== "LICENSE" &&
      !filePath.startsWith("dist/"),
  );
  const entrypoint = files.find((file) => file.path === "dist/index.js");

  if (unexpected.length > 0) {
    throw new Error(`npm pack includes unexpected files: ${unexpected.join(", ")}`);
  }
  if (entrypoint === undefined) {
    throw new Error("npm pack does not include dist/index.js.");
  }
  if ((entrypoint.mode & 0o111) === 0) {
    throw new Error("npm pack includes dist/index.js, but it is not executable.");
  }

  return `${files.length} files, ${formatBytes(packSummary.size)} packed`;
});

runCheck("version tag points at HEAD locally and remotely", () => {
  const peeledTagName = `${tagName}^${"{}"}`;
  const localTarget = git(["rev-parse", peeledTagName]);
  if (localTarget !== headSha) {
    throw new Error(`local ${tagName} points at ${localTarget}, expected HEAD ${headSha}.`);
  }

  const remoteTags = git(["ls-remote", "--tags", "origin", `${tagName}*`]);
  const remoteTarget = parseRemoteTagTarget(remoteTags, tagName);
  if (remoteTarget === undefined) {
    throw new Error(`origin/${tagName} does not exist.`);
  }
  if (remoteTarget !== headSha) {
    throw new Error(`origin/${tagName} points at ${remoteTarget}, expected HEAD ${headSha}.`);
  }

  return `${tagName} -> ${headSha.slice(0, 7)}`;
});

runCheck("GitHub Actions CI is green for HEAD", () => {
  if (options.skipCi) {
    warnings.push("skipped GitHub Actions CI check");
    return "skipped";
  }

  const runOutput = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--branch",
      branchName,
      "--limit",
      "25",
      "--json",
      "databaseId,headSha,status,conclusion,workflowName,url",
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const runs = JSON.parse(runOutput);
  const matchingRun = runs.find((run) => run.workflowName === "CI" && run.headSha === headSha);

  if (matchingRun === undefined) {
    throw new Error(`no CI run found for ${headSha} on ${branchName}.`);
  }
  if (matchingRun.status !== "completed" || matchingRun.conclusion !== "success") {
    throw new Error(
      `CI run ${matchingRun.databaseId} is ${matchingRun.status}/${matchingRun.conclusion}: ${matchingRun.url}`,
    );
  }

  return `${matchingRun.databaseId} succeeded`;
});

runCheck("GitHub release state is compatible", () => {
  const release = getGitHubRelease(tagName);

  if (release === undefined) {
    if (options.requireRelease) {
      throw new Error(`GitHub release ${tagName} does not exist.`);
    }

    warnings.push(`GitHub release ${tagName} has not been created yet`);
    return "not created yet";
  }

  if (release.isDraft || release.isPrerelease) {
    throw new Error(
      `GitHub release ${tagName} is draft=${release.isDraft}, prerelease=${release.isPrerelease}.`,
    );
  }

  return release.url;
});

runCheck("npm publish posture is explicit", () => {
  if (packageJson.private === true) {
    warnings.push("package is private; npm publish must stay skipped");
    return "private package";
  }

  return "public package";
});

const failed = results.filter((result) => !result.ok);
const summary = {
  ok: failed.length === 0,
  package: {
    name: packageJson.name,
    version,
    private: packageJson.private === true,
  },
  git: {
    branch: branchName,
    head: headSha,
    tag: tagName,
  },
  warnings,
  results,
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("");
  console.log(summary.ok ? "release verification passed" : "release verification failed");
  for (const warning of warnings) {
    console.log(`WARN ${warning}`);
  }
}

if (!summary.ok) {
  process.exitCode = 1;
}

function runCheck(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    if (!options.json) {
      console.log(`PASS ${name}: ${detail}`);
    }
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!options.json) {
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getGitHubRelease(name) {
  try {
    const output = execFileSync(
      "gh",
      [
        "release",
        "view",
        name,
        "--json",
        "tagName,name,url,isDraft,isPrerelease,targetCommitish,publishedAt",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function parseRemoteTagTarget(remoteTags, name) {
  const lines = remoteTags
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dereferenced = lines.find((line) => line.endsWith(`refs/tags/${name}^${"{}"}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${name}`));
  const selected = dereferenced ?? direct;

  return selected?.split(/\s+/u)[0];
}

function readJson(filePath) {
  return JSON.parse(readFileSync(path.join(rootDir, filePath), "utf8"));
}

function parseArgs(args) {
  const parsed = {
    allowDirty: false,
    json: false,
    requireRelease: false,
    skipCi: false,
  };

  for (const arg of args) {
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--require-release") {
      parsed.requireRelease = true;
      continue;
    }
    if (arg === "--skip-ci") {
      parsed.skipCi = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/release-verify.mjs [--allow-dirty] [--skip-ci] [--require-release] [--json]

Checks the production release boundary:
- clean, synced git worktree
- package/package-lock/release-note version alignment
- executable packed entrypoint and bounded package file list
- local and remote v<package.version> tag target HEAD
- green GitHub Actions CI for HEAD
- GitHub release state, when present
- explicit npm publish posture
`);
  process.exit(0);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
