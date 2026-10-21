// ---------------------------------------------------------------------------
// The client (src/data/mockData.js, store.js) uses camelCase field names
// throughout (e.g. facilitatorId, mustChangePassword). Postgres columns are
// snake_case by convention (facilitator_id, must_change_password). These
// helpers convert generically between the two so the route handlers don't
// need a per-table field map.
// ---------------------------------------------------------------------------

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function snakeToCamel(str) {
  return str.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// record (camelCase, from client) -> row (snake_case, for Postgres)
//
// An empty string becomes NULL rather than being sent through as-is: forms
// like "Add resource" send `contractEnd: ''` for an open-ended contract, and
// a DATE column rejects '' with a generic (and unhelpful) 500 error since
// it isn't a valid date. NULL is what "no value yet" actually means here,
// for TEXT columns too (an empty string and "no value" are the same thing
// for every field this app has).
function recordToRow(record) {
  const row = {};
  for (const [k, v] of Object.entries(record)) {
    row[camelToSnake(k)] = v === '' ? null : v;
  }
  return row;
}

// row (snake_case, from Postgres) -> record (camelCase, to client)
function rowToRecord(row) {
  const record = {};
  for (const [k, v] of Object.entries(row)) {
    record[snakeToCamel(k)] = v;
  }
  return record;
}

module.exports = { camelToSnake, snakeToCamel, recordToRow, rowToRecord };
