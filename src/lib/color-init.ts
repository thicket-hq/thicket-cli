// Runs before picocolors is imported anywhere: --no-color must win over
// TTY detection, and NO_COLOR is the ecosystem convention picocolors reads.
if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
}
export {};
