import { auditBytes, DEFAULT_MAX_EXCEPTIONS, renderReport } from './audit.mjs';
import { DEFAULT_MAX_BYTES, HARD_MAX_BYTES, InputError, readInputFile, validateInputArgument } from './input.mjs';

export const EXIT = Object.freeze({
  INSPECTED_CLEAN: 0,
  USAGE_OR_INPUT_ERROR: 2,
  INSPECTED_WITH_EXCEPTIONS: 10,
  UNKNOWN_SCHEMA: 11,
  INTERNAL_ERROR: 70,
});

const USAGE = `Usage: node bin/legacy-preflight.mjs [options] <local-export.json>

Offline, read-only source inspection of a synthetic or authorised legacy
export. Writes a JSON report to stdout and a one-line summary to stderr.
The input file is opened read-only and never modified or copied.

Options:
  --max-bytes <n>       Refuse inputs larger than n bytes (default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_MAX_BYTES}).
  --max-exceptions <n>  List at most n exception records; counts stay complete (default ${DEFAULT_MAX_EXCEPTIONS}).
  --help                Show this text.
  --                    Treat the next argument as the input path.

Exit codes: 0 INSPECTED_CLEAN, 10 INSPECTED_WITH_EXCEPTIONS, 11 UNKNOWN_SCHEMA,
2 usage/input error, 70 internal error.

No state means migration-ready or signed off. Sign-off is a human step.
`;

class UsageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parsePositiveInt(raw, max) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

export function parseArgs(argv) {
  const options = { help: false, input: null, maxBytes: DEFAULT_MAX_BYTES, maxExceptions: DEFAULT_MAX_EXCEPTIONS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      if (i + 2 !== argv.length || options.input !== null) throw new UsageError('E_USAGE_INPUT_COUNT');
      options.input = argv[i + 1];
      break;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--max-bytes') {
      options.maxBytes = parsePositiveInt(argv[++i], HARD_MAX_BYTES);
      if (options.maxBytes === null) throw new UsageError('E_USAGE_MAX_BYTES_INVALID');
    } else if (arg === '--max-exceptions') {
      options.maxExceptions = parsePositiveInt(argv[++i], Number.MAX_SAFE_INTEGER);
      if (options.maxExceptions === null) throw new UsageError('E_USAGE_MAX_EXCEPTIONS_INVALID');
    } else if (arg.startsWith('-') && arg !== '-') {
      // The argument itself is not echoed: it may be a mistyped path or value.
      throw new UsageError('E_USAGE_UNKNOWN_OPTION');
    } else {
      if (options.input !== null) throw new UsageError('E_USAGE_INPUT_COUNT');
      options.input = arg;
    }
  }
  return options;
}

function fail(stderr, code, exitCode) {
  stderr.write(`legacy-preflight: error ${code}. Run with --help for usage.\n`);
  return exitCode;
}

// Returns the process exit code. stdout/stderr only ever receive the usage
// text, the report, fixed error codes, and the fixed summary line.
export function main(argv, { stdout, stderr }) {
  try {
    let options;
    try {
      options = parseArgs(argv);
    } catch (err) {
      if (err instanceof UsageError) return fail(stderr, err.code, EXIT.USAGE_OR_INPUT_ERROR);
      throw err;
    }
    if (options.help) {
      stdout.write(USAGE);
      return EXIT.INSPECTED_CLEAN;
    }
    if (options.input === null) return fail(stderr, 'E_INPUT_MISSING', EXIT.USAGE_OR_INPUT_ERROR);

    let bytes;
    try {
      validateInputArgument(options.input);
      bytes = readInputFile(options.input, options.maxBytes);
    } catch (err) {
      if (err instanceof InputError) return fail(stderr, err.code, EXIT.USAGE_OR_INPUT_ERROR);
      throw err;
    }

    const report = auditBytes(bytes, { maxExceptions: options.maxExceptions });
    stdout.write(renderReport(report));
    stderr.write(
      `legacy-preflight: state=${report.state} exceptions=${report.exceptionSummary.count}. ` +
      'Source inspection only; not migration-ready. Sign-off is a human step outside this tool.\n',
    );
    return EXIT[report.state] ?? EXIT.INTERNAL_ERROR;
  } catch {
    // Stack traces carry absolute paths and possibly input fragments.
    return fail(stderr, 'E_INTERNAL', EXIT.INTERNAL_ERROR);
  }
}
