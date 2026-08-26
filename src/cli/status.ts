import { findRunningDaemon } from "../daemon/lock.js";

type ProjectsResponse = {
  active: string | null;
  open: { root: string; name: string }[];
};

export async function runStatus(): Promise<void> {
  const lock = await findRunningDaemon();
  if (!lock) {
    console.log("not running");
    process.exitCode = 1;
    return;
  }

  console.log(`artisign running (pid ${lock.pid}, port ${lock.port})`);

  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/projects`);
    if (!res.ok) return;
    const { active, open } = (await res.json()) as ProjectsResponse;
    if (open.length === 0) {
      console.log("no projects open");
      return;
    }
    for (const project of open) {
      const marker = project.root === active ? "*" : " ";
      console.log(`${marker} ${project.name} (${project.root})`);
    }
  } catch {
    // daemon is up but the project list couldn't be fetched — pid/port already reported
  }
}
