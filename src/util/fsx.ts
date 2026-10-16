import fs from "node:fs";

/**
 * Directory entries that are folders, following junctions and symbolic links. Modders link module
 * folders (or their SceneObj/Assets subfolders) into <game>/Modules with `mklink /J`; Dirent.isDirectory()
 * is false for such links, so every folder walk goes through these helpers. Walkers keep their depth
 * limits, which also stops link cycles.
 */
export function isDirEntry(e: fs.Dirent, full: string): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false; // broken link
  }
}

/** Files, including symbolic links to files. */
export function isFileEntry(e: fs.Dirent, full: string): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}
