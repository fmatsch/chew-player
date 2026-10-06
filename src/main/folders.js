import path from 'node:path';

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Add a library folder without scanning anything twice:
//   'exists'  – already in the list
//   'covered' – it lies inside a folder that is already in the list
//   'added'   – added; folders inside it are absorbed, since the new one covers them
export function mergeFolder(list, dir) {
  if (list.some((f) => norm(f) === norm(dir))) return { result: 'exists', list };
  const parent = list.find((f) => inside(dir, f));
  if (parent) return { result: 'covered', parent, list };
  return { result: 'added', list: [...list.filter((f) => !inside(f, dir)), dir] };
}
