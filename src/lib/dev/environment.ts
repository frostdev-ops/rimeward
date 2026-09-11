export function terminalEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> & { PATH: string } {
  // Build the user's shell environment; never inherit the backend's credentials.
  const names = [
    "HOME",
    "USERPROFILE",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "COLORTERM",
    "SSH_AUTH_SOCK",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "PULSE_SERVER", // a browser ward with sound on Linux: PulseAudio/PipeWire off the default socket
  ];
  const env = Object.fromEntries([
    ...names.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
    ["TERM", "xterm-256color"],
    ["TERM_PROGRAM", "Rimeward"],
  ]);
  // GUI launchers often supply only /usr/bin:/bin; include standard user installs.
  const home = source.HOME ?? source.USERPROFILE ?? os.homedir();
  const PATH = [
    ...new Set(
      [
        ...(source.PATH ?? "").split(path.delimiter),
        path.join(home, ".local", "bin"),
        path.join(home, ".cargo", "bin"),
        ...(process.platform === "darwin"
          ? ["/opt/homebrew/bin", "/usr/local/bin"]
          : []),
        ...(process.platform === "win32" && source.APPDATA
          ? [path.join(source.APPDATA, "npm")]
          : []),
      ].filter(Boolean),
    ),
  ].join(path.delimiter);
  return { ...env, PATH };
}
import path from "node:path";
import os from "node:os";
