const RECENT_DIRS_KEY = "cc-recent-dirs";

export function getRecentDirs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecentDir(dir: string) {
  const dirs = getRecentDirs().filter((d) => d !== dir);
  dirs.unshift(dir);
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, 5)));
}
