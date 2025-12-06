local M = {}
local server = require("mod-flow.server")
local commands = require("mod-flow.commands")

-- Re-export handle_response for RPC calls from server
M.handle_response = server.handle_response

function M.setup()
  server.start()

  vim.keymap.set("n", "<leader>m", commands.select_method, { desc = "ModFlow: Select Method" })

  vim.api.nvim_create_user_command("ModRestart", function()
    server.start()
  end, { desc = "Restart ModFlow server" })
end

return M
