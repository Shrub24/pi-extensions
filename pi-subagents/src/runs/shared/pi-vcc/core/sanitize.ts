// @ts-nocheck — vendored from pi-vcc (see README.md in this directory).
// Upstream is plain JS-targeted TypeScript without this repo's strict flags
// (`strict`, `noUncheckedIndexedAccess`) and uses extensionless relative
// imports; this line is the only local modification to the copied files, so
// they stay diffable against upstream.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export const sanitize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");
