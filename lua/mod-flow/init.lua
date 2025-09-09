local M = {}

local server_job_id = nil
local pending_requests = {}
local request_id = 0

function M.handle_response(response_id, result)
  local callback = pending_requests[response_id]
  if callback then
    callback(result)
    pending_requests[response_id] = nil
  end
end

local function async_request(method, args, callback)
  if not server_job_id then
    return
  end

  request_id = request_id + 1
  pending_requests[request_id] = callback
  vim.fn.rpcnotify(server_job_id, method, request_id, args)
end

local restart_pending = false

function M.cleanup_old_servers()
  -- Kill any existing node processes running mod-flow server
  local handle = io.popen("pgrep -f 'node.*index.ts' 2>/dev/null")
  if handle then
    local pids = handle:read("*a")
    handle:close()
    if pids and pids ~= "" then
      for pid in pids:gmatch("%d+") do
        os.execute("kill " .. pid .. " 2>/dev/null")
        print("Cleaned up old server process: " .. pid)
      end
    end
  end
end

function M.start_server()
  local function do_start()
    -- Clean up any old servers first
    M.cleanup_old_servers()

    local server_path = vim.fn.fnamemodify(debug.getinfo(1).source:sub(2), ":h:h:h") .. "/server"
    local env = vim.fn.environ()

    -- Make log file unique per nvim instance using PID
    local nvim_pid = vim.fn.getpid()
    env.NVIM_NODE_LOG_FILE = "/tmp/mod-flow-server-" .. nvim_pid .. ".log"
    env.NVIM_NODE_LOG_LEVEL = "info"

    -- Clear the log file on startup
    vim.fn.writefile({}, env.NVIM_NODE_LOG_FILE)

    server_job_id = vim.fn.jobstart({ "bun", "index.ts" }, {
      cwd = server_path,
      rpc = true,
      env = env,
      on_stdout = function(_, data)
        if data and #data > 0 then
          local stdout_text = table.concat(data, "\n"):gsub("^%s+", ""):gsub("%s+$", "")
          if stdout_text ~= "" then
            print("Server stdout: " .. stdout_text)
          end
        end
      end,
      on_stderr = function(_, data)
        if data and #data > 0 then
          local stderr_text = table.concat(data, "\n"):gsub("^%s+", ""):gsub("%s+$", "")
          if stderr_text ~= "" then
            print("Server stderr: " .. stderr_text)
          end
        end
      end,
      on_exit = function(_, code)
        print("Server exited with code: " .. code .. " (PID: " .. nvim_pid .. ")")
        server_job_id = nil

        -- If we're in the middle of a restart, start the new server
        if restart_pending then
          restart_pending = false
          do_start()
          print("ModFlow server restarted")
        end
      end,
    })

    if server_job_id <= 0 then
      print("Failed to start server, jobstart returned: " .. server_job_id)
    else
      print("Server started with job ID: " .. server_job_id .. " (PID: " .. nvim_pid .. ")")
    end
  end

  if server_job_id then
    -- Mark that we want to restart after the current server exits
    restart_pending = true
    print("ModFlow server restarting...")
    vim.fn.jobstop(server_job_id)
  else
    do_start()
    print("ModFlow server started")
  end
end

function M.setup()
  M.start_server()

  local function handle_method_result(result, method_name, cached_node_info, cursor_pos)
    if method_name == "list_mods" then
      vim.ui.select(result.mods, {
        prompt = "Select method:",
      }, function(selected)
        if selected then
          -- Use the cached node info from when <leader>k was pressed
          async_request(selected, { node_info = cached_node_info }, function(method_result)
            vim.schedule(function()
              handle_method_result(method_result, selected, cached_node_info, cursor_pos)
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
      -- Restore cursor position after error
      if cursor_pos then
        vim.api.nvim_win_set_cursor(0, cursor_pos)
      end
    elseif method_name == "debug_node_under_cursor" and result.mod then
      -- Print debug info instead of applying buffer changes
      print(result.mod)
      -- Restore cursor position after debug
      if cursor_pos then
        vim.api.nvim_win_set_cursor(0, cursor_pos)
      end
    elseif result.mod and result.original_range then
      -- Apply buffer changes using native Neovim API (ModSuccessResult)
      local bufnr = vim.api.nvim_get_current_buf()
      local replacement_lines = vim.split(result.mod or "", "\n")

      vim.api.nvim_buf_set_text(
        bufnr,
        result.original_range.start.line,
        result.original_range.start.column,
        result.original_range["end"].line,
        result.original_range["end"].column,
        replacement_lines
      )
      -- Don't restore cursor position here - let the buffer modification determine the new position
    else
      print("Unknown error occurred")
      -- Restore cursor position after unknown error
      if cursor_pos then
        vim.api.nvim_win_set_cursor(0, cursor_pos)
      end
    end
  end

  vim.keymap.set("n", "<leader>k", function()
    if server_job_id then
      -- Save current cursor position
      local cursor_pos = vim.api.nvim_win_get_cursor(0)

      -- Get tree-sitter node under cursor
      local node = vim.treesitter.get_node()
      local node_info = nil

      if node then
        local start_row, start_col, end_row, end_col = node:range()
        local node_text = vim.treesitter.get_node_text(node, 0)
        node_info = {
          range = {
            start = { line = start_row, column = start_col },
            ["end"] = { line = end_row, column = end_col }
          },
          text = node_text,
          type = node:type()
        }
      end

      async_request("list_mods", { node_info = node_info }, function(result)
        -- Restore cursor position after the async operation
        vim.schedule(function()
          handle_method_result(result, "list_mods", node_info, cursor_pos)
        end)
      end)
    end
  end, { desc = "ModFlow: Select Method" })

  vim.keymap.set("n", "<leader>K", function()
    M.start_server()
  end, { desc = "ModFlow: Restart Server" })
end

return M
