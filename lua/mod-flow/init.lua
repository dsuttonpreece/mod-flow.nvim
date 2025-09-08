local M = {}

local server_job_id = nil
local pending_requests = {}
local request_id = 0

-- Handler for responses from server
function M.handle_response(response_id, result)
  local callback = pending_requests[response_id]
  if callback then
    callback(result)
    pending_requests[response_id] = nil
  end
end

-- Non-blocking request function
local function async_request(method, args, callback)
  if not server_job_id then
    return
  end

  request_id = request_id + 1
  pending_requests[request_id] = callback

  vim.fn.rpcnotify(server_job_id, method, request_id, args)
end

function M.setup()
  -- Start node server
  local server_path = vim.fn.fnamemodify(debug.getinfo(1).source:sub(2), ":h:h:h") .. "/server"
  local cmd = { "node", "--experimental-strip-types", "index.ts" }

  -- Set environment variables for logging
  local env = vim.fn.environ()
  env.NVIM_NODE_LOG_FILE = "/tmp/mod-flow-server.log"
  env.NVIM_NODE_LOG_LEVEL = "info"

  server_job_id = vim.fn.jobstart(cmd, {
    cwd = server_path,
    rpc = true,
    env = env,
    on_stdout = function(_, data)
      if data then
        print("Server stdout: " .. table.concat(data, "\n"))
      end
    end,
    on_notification = function(method, args)
      print("Received notification: " .. method .. " with args: " .. vim.inspect(args))
      if method == "mod_flow_response" then
        local response_id, result = unpack(args)
        M.handle_response(response_id, result)
      end
    end,
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

  print("Started server with job_id: " .. tostring(server_job_id))

  -- Create keybind
  vim.keymap.set("n", "<leader>k", function()
    if server_job_id then
      print("Sending request to server job_id: " .. tostring(server_job_id))
      async_request("hello_world", {}, function(result)
        print("Server response: " .. tostring(result))
      end)
    else
      print("No server job_id available")
    end
  end, { desc = "ModFlow: Hello World" })
end

return M
