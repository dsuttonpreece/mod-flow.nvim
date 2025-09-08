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

function M.setup()
  local server_path = vim.fn.fnamemodify(debug.getinfo(1).source:sub(2), ":h:h:h") .. "/server"
  local env = vim.fn.environ()
  env.NVIM_NODE_LOG_FILE = "/tmp/mod-flow-server.log"
  env.NVIM_NODE_LOG_LEVEL = "info"

  -- Clear the log file on startup
  vim.fn.writefile({}, env.NVIM_NODE_LOG_FILE)

  server_job_id = vim.fn.jobstart({ "node", "--experimental-strip-types", "index.ts" }, {
    cwd = server_path,
    rpc = true,
    env = env,
    on_stderr = function(_, data)
      if data then
        print("Server stderr: " .. table.concat(data, "\n"))
      end
    end,
    on_exit = function(_, code)
      print("Server exited with code: " .. code)
      server_job_id = nil
    end,
  })

  local function handle_method_result(result, method_name)
    if method_name == "list_mods" then
      vim.ui.select(result.mods, {
        prompt = "Select method:",
      }, function(selected)
        if selected then
          async_request(selected, {}, function(method_result)
            handle_method_result(method_result, selected)
          end)
        end
      end)
    elseif result.found and result.original_range then
      -- Apply buffer changes using native Neovim API
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
    elseif not result.found then
      print("No " .. method_name:gsub("find_closest_", ""):gsub("_", " ") .. " found at cursor")
    end
  end

  vim.keymap.set("n", "<leader>k", function()
    if server_job_id then
      async_request("list_mods", {}, function(result)
        handle_method_result(result, "list_mods")
      end)
    end
  end, { desc = "ModFlow: Select Method" })
end

return M
