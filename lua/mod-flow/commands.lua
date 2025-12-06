local M = {}
local server = require("mod-flow.server")
local utils = require("mod-flow.utils")

function M.select_method()
  if not server.is_running() then
    return
  end

  local node_info, cursor_pos = utils.get_node_info_under_cursor()

  server.async_request("list_mods", { node_info = node_info }, function(result)
    vim.schedule(function()
      M.handle_result(result, "list_mods", node_info, cursor_pos)
    end)
  end)
end

local function handle_result(result, method_name, cached_node_info, cursor_pos)
  if method_name == "list_mods" then
    vim.ui.select(result.mods, {
      prompt = "Select method:",
    }, function(selected)
      if selected then
        server.async_request(selected, { node_info = cached_node_info }, function(method_result)
          vim.schedule(function()
            handle_result(method_result, selected, cached_node_info, cursor_pos)
          end)
        end)
      else
        -- User cancelled, restore cursor position
        if cursor_pos then
          vim.api.nvim_win_set_cursor(0, cursor_pos)
        end
      end
    end)
  elseif result.code and result.message then
    -- Handle error responses (ModError structure)
    print(string.format("[%s] %s", result.code, result.message))
    if cursor_pos then
      vim.api.nvim_win_set_cursor(0, cursor_pos)
    end
  elseif method_name == "debug_node_under_cursor" and result.mod then
    -- Print debug info instead of applying buffer changes
    print(result.mod)
    if cursor_pos then
      vim.api.nvim_win_set_cursor(0, cursor_pos)
    end
  elseif result.mod and result.original_range then
    -- Apply buffer changes using native Neovim API (ModSuccessResult)
    local bufnr = vim.api.nvim_get_current_buf()
    local replacement_lines = vim.split(result.mod or "", "\n")

    -- Copy to clipboard if specified
    if result.clipboard then
      vim.fn.setreg('"', result.clipboard)
    end

    vim.api.nvim_buf_set_text(
      bufnr,
      result.original_range.start.line,
      result.original_range.start.column,
      result.original_range["end"].line,
      result.original_range["end"].column,
      replacement_lines
    )
  else
    print("Unknown error occurred")
    if cursor_pos then
      vim.api.nvim_win_set_cursor(0, cursor_pos)
    end
  end
end

return M
