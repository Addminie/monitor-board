function parsePaginationQuery(query, options = {}) {
  const defaultPageSize = Math.max(
    1,
    Math.floor(Number(options.defaultPageSize || 50) || 50)
  );
  const maxPageSize = Math.max(
    defaultPageSize,
    Math.floor(Number(options.maxPageSize || 500) || 500)
  );
  const hasPage = query?.page != null && String(query.page).trim() !== "";
  const hasPageSize = query?.pageSize != null && String(query.pageSize).trim() !== "";
  const hasOffset = query?.offset != null && String(query.offset).trim() !== "";
  const hasLimit = query?.limit != null && String(query.limit).trim() !== "";
  const enabled = hasPage || hasPageSize || hasOffset || hasLimit;
  const page = Math.max(1, Math.floor(Number(query?.page || 1) || 1));
  const pageSizeSource = hasPageSize ? query.pageSize : hasLimit ? query.limit : defaultPageSize;
  const pageSize = Math.max(
    1,
    Math.min(maxPageSize, Math.floor(Number(pageSizeSource) || defaultPageSize))
  );
  const offsetFromPage = (page - 1) * pageSize;
  const offset = Math.max(
    0,
    Math.floor(Number(hasOffset ? query.offset : offsetFromPage) || 0)
  );
  return {
    enabled,
    page,
    pageSize,
    offset,
    maxPageSize,
  };
}

function buildPaginatedResponse(items, pagination) {
  const list = Array.isArray(items) ? items : [];
  if (!pagination || !pagination.enabled) {
    return {
      items: list,
      pagination: {
        page: 1,
        pageSize: list.length,
        offset: 0,
        total: list.length,
        totalPages: list.length ? 1 : 0,
      },
    };
  }
  const total = list.length;
  const begin = Math.max(0, pagination.offset);
  const end = Math.min(total, begin + pagination.pageSize);
  const pageItems = list.slice(begin, end);
  return {
    items: pageItems,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      offset: begin,
      total,
      totalPages: total ? Math.ceil(total / pagination.pageSize) : 0,
    },
  };
}

module.exports = {
  parsePaginationQuery,
  buildPaginatedResponse,
};
