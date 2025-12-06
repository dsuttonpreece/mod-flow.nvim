local M = {}

local server_job_id = nil
local pending_requests = {}
local request_id = 0
local restart_pending = false

function M.handle_response(response_id, result)
  local callback = pending_requests[response_id]
  if callback then
    callback(result)
    pending_requests[response_id] = nil
  end
end

function M.async_request(method, args, callback)
  if not server_job_id then
    return
  end

  request_id = request_id + 1
  pending_requests[request_id] = callback
  vim.fn.rpcnotify(server_job_id, method, request_id, args)
end

function M.is_running()
  return server_job_id ~= nil
end

local function cleanup_old_servers()
  -- Kill any existing deno processes running mod-flow server
  local handle = io.popen("pgrep -f 'deno.*index.ts' 2>/dev/null")
  if handle then
    local pids = handle:read("*a")
    handle:close()
    if pids and pids ~= "" then
      for pid in pids:gmatch("%d+") do
        os.execute("kill " .. pid .. " 2>/dev/null")
      end
    end
  end
end

function M.start()
  local function do_start()
    -- Clean up any old servers first
    cleanup_old_servers()

    local server_path = vim.fn.fnamemodify(debug.getinfo(1).source:sub(2), ":h:h:h") .. "/server"
    local env = vim.fn.environ()

    -- Make log file unique per nvim instance using PID
    env.NVIM_NODE_LOG_FILE = "/tmp/mod-flow-server-" .. vim.fn.getpid() .. ".log"
    env.NVIM_NODE_LOG_LEVEL = "info"

    -- Clear the log file on startup
    vim.fn.writefile({}, env.NVIM_NODE_LOG_FILE)

    server_job_id = vim.fn.jobstart({ "deno", "run", "--allow-all", "index.ts" }, {
      cwd = server_path,
      rpc = true,
      env = env,
      on_exit = function()
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
      print("Failed to start server")
    end
  end

  if server_job_id then
    restart_pending = true
    vim.fn.jobstop(server_job_id)
  else
    do_start()
  end
end

return M
