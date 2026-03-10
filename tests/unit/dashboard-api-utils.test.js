const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePaginationQuery,
  buildPaginatedResponse,
} = require("../../dashboard/lib/api-utils");

test("parsePaginationQuery uses defaults when query is empty", () => {
  const parsed = parsePaginationQuery({}, { defaultPageSize: 20, maxPageSize: 100 });
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 20);
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.maxPageSize, 100);
});

test("parsePaginationQuery clamps pageSize and uses offset override", () => {
  const parsed = parsePaginationQuery(
    { page: "2", pageSize: "999", offset: "5" },
    { defaultPageSize: 10, maxPageSize: 50 }
  );
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.offset, 5);
});

test("buildPaginatedResponse slices data by pagination", () => {
  const source = ["a", "b", "c", "d", "e"];
  const paged = buildPaginatedResponse(source, {
    enabled: true,
    page: 2,
    pageSize: 2,
    offset: 2,
  });
  assert.deepEqual(paged.items, ["c", "d"]);
  assert.equal(paged.pagination.total, 5);
  assert.equal(paged.pagination.totalPages, 3);
});

test("buildPaginatedResponse returns all data when pagination disabled", () => {
  const source = [1, 2, 3];
  const paged = buildPaginatedResponse(source, { enabled: false });
  assert.deepEqual(paged.items, source);
  assert.equal(paged.pagination.page, 1);
  assert.equal(paged.pagination.pageSize, 3);
  assert.equal(paged.pagination.total, 3);
});

test("parsePaginationQuery supports legacy limit parameter", () => {
  const parsed = parsePaginationQuery({ limit: "15" }, { defaultPageSize: 10, maxPageSize: 20 });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.pageSize, 15);
  assert.equal(parsed.offset, 0);
});

test("parsePaginationQuery normalizes invalid numbers", () => {
  const parsed = parsePaginationQuery(
    { page: "-2", pageSize: "abc", offset: "-10" },
    { defaultPageSize: 12, maxPageSize: 30 }
  );
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 12);
  assert.equal(parsed.offset, 0);
});

test("buildPaginatedResponse handles empty and non-array input", () => {
  const empty = buildPaginatedResponse(null, { enabled: true, page: 1, pageSize: 10, offset: 0 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.pagination.total, 0);
  assert.equal(empty.pagination.totalPages, 0);
});
