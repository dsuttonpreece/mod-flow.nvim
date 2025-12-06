local M = {}

function M.get_node_info_under_cursor()
  local cursor_pos = vim.api.nvim_win_get_cursor(0)
  local node = vim.treesitter.get_node()

  if not node then
    return nil, cursor_pos
  end

  local start_row, start_col, end_row, end_col = node:range()
  local node_info = {
    range = {
      start = { line = start_row, column = start_col },
      ["end"] = { line = end_row, column = end_col }
    },
    text = vim.treesitter.get_node_text(node, 0),
    type = node:type(),
    cursor = { line = cursor_pos[1] - 1, column = cursor_pos[2] } -- Convert to 0-indexed
  }

  return node_info, cursor_pos
end

return M
