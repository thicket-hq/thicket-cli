// The loopback half of `thicket auth login`: a one-shot 127.0.0.1 HTTP
// listener that receives the browser redirect from /cli/authorize, checks
// the state, and hands the single-use code back to the CLI.
import { createServer, type Server } from "node:http";
import { CliError } from "./output.js";

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Thicket CLI</title>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #faf9f5; color: #1a1a1a">
<div style="text-align: center"><h1 style="font-size: 1.4rem">You're signed in</h1>
<p>The Thicket CLI has what it needs. You can close this tab and return to your terminal.</p></div>`;

const DENIED_HTML = `<!doctype html><meta charset="utf-8"><title>Thicket CLI</title>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #faf9f5; color: #1a1a1a">
<div style="text-align: center"><h1 style="font-size: 1.4rem">Sign-in cancelled</h1>
<p>No access was granted. You can close this tab.</p></div>`;

export type LoopbackResult = { code: string };

export function startLoopback(
  state: string,
  timeoutMs = 5 * 60_000,
): Promise<{ port: number; result: Promise<LoopbackResult>; close: () => void }> {
  return new Promise((resolveStart, rejectStart) => {
    let server: Server;
    let settle: {
      resolve: (r: LoopbackResult) => void;
      reject: (e: Error) => void;
    };
    const result = new Promise<LoopbackResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timer = setTimeout(() => {
      server.close();
      settle.reject(
        new CliError("auth", "Timed out waiting for the browser approval", "Run: thicket auth login again"),
      );
    }, timeoutMs);
    timer.unref();

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const gotState = url.searchParams.get("state") ?? "";
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (gotState !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(DENIED_HTML);
        return; // Not ours; keep listening for the real redirect.
      }
      if (error || !code) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DENIED_HTML);
        clearTimeout(timer);
        server.close();
        settle.reject(
          new CliError("auth", "Sign-in was cancelled in the browser"),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      clearTimeout(timer);
      server.close();
      settle.resolve({ code });
    });
    server.on("error", (err) => rejectStart(err));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectStart(new Error("Could not bind a loopback port"));
        return;
      }
      resolveStart({
        port: address.port,
        result,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}
