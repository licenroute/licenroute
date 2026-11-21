// Platform differences for the end-to-end tests (macOS and Linux).
//  · Pseudo-terminal for the approval challenge: BSD script (macOS) or util-linux script (Linux).
//  · sha256: shasum -a 256 (macOS) or sha256sum (Linux).
export const OS = process.platform;

/** sh -c that reads input from $IN and runs "$@" in a pseudo-terminal, writing the output to $OUT. */
export function ptyScript() {
  if (OS === "darwin") return ["sh", ['-c', 'cat "$IN" | script -q /dev/null "$@" >"$OUT" 2>&1', "sh"]];
  // util-linux: script -c takes ONE string; bash %q quotes it without any further shell in between.
  return ["bash", ['-c', 'cmd=$(printf "%q " "$@"); cat "$IN" | script -q -e -c "$cmd" /dev/null >"$OUT" 2>&1', "bash"]];
}

export const sha256Tool = () => (OS === "darwin" ? ["/usr/bin/shasum", ["-a", "256"]] : ["sha256sum", []]);
