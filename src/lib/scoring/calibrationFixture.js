/**
 * Schema and validator for hand-labelled calibration fixtures (R0.4.2, S11).
 *
 * These fixtures are the ground truth the R2.5 judge is calibrated against, so
 * their integrity matters more than the judge's. A silently-malformed label set
 * would make the judge look accurate against nothing — the same failure the
 * whole rebuild is about, one level up.
 *
 * The validator is strict on purpose. A label that is merely *absent* must not
 * read as "not mentioned": `mentioned` is a required boolean, never a default.
 *
 * Pure. Runs without a database or a model.
 */

export const LABEL_SCHEMA_VERSION = 1;

/** Position is only meaningful when the brand was mentioned at all. */
const POSITION_MIN = 1;
const POSITION_MAX = 50;

const SENTIMENTS = [-1, 0, 1];

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate one labelled answer.
 *
 * @param {object} row
 * @param {number} index position in the file, for the error message
 * @returns {string[]} problems; empty means valid
 */
export function validateLabel(row, index = 0) {
  const at = `label[${index}]`;
  const problems = [];
  if (!isPlainObject(row)) return [`${at} is not an object`];

  for (const field of ["result_id", "prompt_text", "answer_text", "brand", "labelled_by", "labelled_at"]) {
    if (typeof row[field] !== "string" || !row[field].trim()) {
      problems.push(`${at}.${field} is required and must be a non-empty string`);
    }
  }

  // The load-bearing field. Absent must never coerce to false.
  if (typeof row.mentioned !== "boolean") {
    problems.push(
      `${at}.mentioned must be an explicit true or false — a missing label is not "not mentioned"`
    );
  }

  if (row.mentioned === true) {
    if (!Number.isInteger(row.position) || row.position < POSITION_MIN || row.position > POSITION_MAX) {
      problems.push(
        `${at}.position must be an integer ${POSITION_MIN}-${POSITION_MAX} when mentioned is true`
      );
    }
  } else if (row.mentioned === false && row.position != null) {
    problems.push(`${at}.position must be null when mentioned is false, not ${row.position}`);
  }

  if (row.sentiment != null && !SENTIMENTS.includes(row.sentiment)) {
    problems.push(`${at}.sentiment must be one of ${SENTIMENTS.join(", ")} or null`);
  }

  if (row.uncertain != null && typeof row.uncertain !== "boolean") {
    problems.push(`${at}.uncertain must be a boolean when present`);
  }
  // An uncertain label needs a reason, or the next reader cannot tell a hard
  // case from a careless one.
  if (row.uncertain === true && (typeof row.note !== "string" || !row.note.trim())) {
    problems.push(`${at}.note is required when uncertain is true — say what made it hard`);
  }

  return problems;
}

/**
 * Validate a whole fixture file.
 *
 * @param {object} file parsed fixture JSON
 * @param {{min?: number, max?: number}} [bounds] the task's 60–100 range
 */
export function validateCalibrationFixture(file, { min = 60, max = 100 } = {}) {
  const problems = [];
  if (!isPlainObject(file)) return { ok: false, problems: ["fixture is not an object"], counts: null };

  if (file.schema_version !== LABEL_SCHEMA_VERSION) {
    problems.push(`schema_version must be ${LABEL_SCHEMA_VERSION}, got ${file.schema_version}`);
  }
  if (typeof file.protocol !== "string" || !file.protocol.trim()) {
    problems.push("protocol must name the document the labeller followed");
  }

  const labels = Array.isArray(file.labels) ? file.labels : null;
  if (!labels) {
    return { ok: false, problems: problems.concat("labels must be an array"), counts: null };
  }
  if (labels.length < min || labels.length > max) {
    problems.push(`expected ${min}-${max} labels, got ${labels.length}`);
  }

  const seen = new Set();
  labels.forEach((row, i) => {
    problems.push(...validateLabel(row, i));
    const key = `${row?.result_id}|${row?.brand}`;
    if (seen.has(key)) problems.push(`label[${i}] duplicates result_id+brand ${key}`);
    seen.add(key);
  });

  const mentioned = labels.filter((r) => r?.mentioned === true).length;
  const counts = {
    total: labels.length,
    mentioned,
    not_mentioned: labels.filter((r) => r?.mentioned === false).length,
    uncertain: labels.filter((r) => r?.uncertain === true).length,
  };

  // A set that is all-yes or all-no cannot calibrate anything: every judge that
  // always answers the majority class scores perfectly on it.
  if (labels.length > 0) {
    const ratio = mentioned / labels.length;
    if (ratio < 0.15 || ratio > 0.85) {
      problems.push(
        `label set is ${Math.round(ratio * 100)}% mentioned — too one-sided to calibrate a judge ` +
          `(a constant-answer judge would score near-perfectly). Sample for balance.`
      );
    }
  }

  return { ok: problems.length === 0, problems, counts };
}
