// Small diagnostic log in the user-data folder (chew.log), mainly for casting problems that
// can only be reproduced with the user's own TV. Never contains keys or credentials.
import fs from 'node:fs';
import path from 'node:path';

let file = null;

export function initLog(dir) {
  file = path.join(dir, 'chew.log');
  try { if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
}

export function log(area, ...parts) {
  const line = `${new Date().toISOString()} [${area}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (process.env.CHEW_LOG_STDOUT) process.stdout.write(line);
  if (file) fs.appendFile(file, line, () => {});
}
