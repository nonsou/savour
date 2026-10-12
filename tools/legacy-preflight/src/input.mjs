import fs from 'node:fs';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const HARD_MAX_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

// Error codes only. Messages never include the path, OS error text, or bytes.
export class InputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InputError';
    this.code = code;
  }
}

// Local file paths only. Anything that looks like a URL (scheme:...) or stdin
// is refused rather than guessed at. Windows drive letters are allowed.
export function validateInputArgument(arg) {
  if (typeof arg !== 'string' || arg.length === 0) throw new InputError('E_INPUT_MISSING');
  if (arg === '-') throw new InputError('E_INPUT_STDIN_UNSUPPORTED');
  if (arg.includes('\u0000')) throw new InputError('E_INPUT_PATH_INVALID');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(arg) && !/^[A-Za-z]:[\\/]/.test(arg)) {
    throw new InputError('E_INPUT_URL_UNSUPPORTED');
  }
  return arg;
}

function openErrorCode(err) {
  switch (err && err.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'E_INPUT_NOT_FOUND';
    case 'ELOOP':
      return 'E_INPUT_SYMLINK_REFUSED';
    case 'EACCES':
    case 'EPERM':
      return 'E_INPUT_NOT_READABLE';
    case 'EISDIR':
      return 'E_INPUT_NOT_REGULAR_FILE';
    default:
      return 'E_INPUT_OPEN_FAILED';
  }
}

// Opens read-only (never creates, truncates, or writes), refuses a symlink as
// the final path component, refuses non-regular files, and never reads more
// than maxBytes + 1 bytes even if the file grows while being read.
export function readInputFile(path, maxBytes = DEFAULT_MAX_BYTES) {
  validateInputArgument(path);
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    throw new InputError(openErrorCode(err));
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new InputError('E_INPUT_NOT_REGULAR_FILE');
    if (stat.size > maxBytes) throw new InputError('E_INPUT_TOO_LARGE');
    const chunks = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1 - length));
      let read;
      try {
        read = fs.readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        throw new InputError('E_INPUT_READ_FAILED');
      }
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      length += read;
      if (length > maxBytes) throw new InputError('E_INPUT_TOO_LARGE');
    }
    return Buffer.concat(chunks, length);
  } finally {
    fs.closeSync(fd);
  }
}
