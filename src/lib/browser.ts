// Opens the system browser without a shell (no injection surface).
import { execFile } from "node:child_process";
import { platform } from "node:os";

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const os = platform();
    const [cmd, args] =
      os === "darwin"
        ? ["open", [url]]
        : os === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    execFile(cmd, args as string[], (err) => resolve(!err));
  });
}
