// @ts-nocheck — vendored from pi-vcc (see README.md in this directory).
// Upstream is plain JS-targeted TypeScript without this repo's strict flags
// (`strict`, `noUncheckedIndexedAccess`) and uses extensionless relative
// imports; this line is the only local modification to the copied files, so
// they stay diffable against upstream.
export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  briefTranscript: string;
}
